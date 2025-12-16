"""
Config loader for project-level prompts and lookups stored in Supabase with a local cache fallback.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import textwrap
import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Mapping, MutableMapping, Optional, Sequence, Tuple

try:  # pragma: no cover - optional dependency
    from supabase import Client, create_client
except ImportError:  # pragma: no cover - optional dependency
    Client = None  # type: ignore
    create_client = None  # type: ignore


ProjectConfigType = str

CONFIG_TYPES: Tuple[ProjectConfigType, ...] = (
    "system_prompt",
    "internal_users",
    "customer_score",
    "agent_score",
    "conversation_rating",
    "task_sequence",
    "additional_instructions",
    "contact_taxonomy",
    "prompt_header",
    "prompt_json_schema",
)


def _dedent(text: str) -> str:
    return textwrap.dedent(text).strip()


DEFAULT_TASK_SEQUENCE = _dedent(
    """
    Task sequence (complete all steps):
    1. Compare the customer's stated problem to the agent's classification. If the original contact reason is "Duplicate", keep contact_reason="Duplicate" and contact_reason_change=false. Otherwise, set contact_reason_change=true when your chosen contact_reason differs from the original, and explain the override using literal phrases or timestamps from the transcript.
    2. Decide whether the conversation is resolved. Set both resolved and is_resolved accordingly, and write resolution_why that cites the agent or customer action that proves the outcome (or why it failed).
    3. Provide one-sentence summaries:
       a. problem_extract - concise but specific customer problem (<=250 chars). Mention concrete damage, location, or outage cause.
       b. resolution_extract - outcome in <15 words explaining how it was solved or why open.
    4. List chronological agent actions that moved the ticket forward in steps_extract (array of short strings, earliest first, max 8 entries).
    5. Identify the message where the issue was resolved (customer confirmation or decisive agent fix). Populate resolution_timestamp_iso (ISO 8601) and resolution_message_index (1-based transcript index). Use null for both when unresolved.
    6. Produce customer sentiment:
       - customer_sentiment_primary must be one of: Delight, Convenience, Trust, Frustration, Disappointment, Concern, Hostility, Neutral.
       - customer_sentiment_scores is an object with those eight keys. Values are floats between 0 and 1 that sum to ~1.00 (+/-0.02 tolerance).
    7. Generate llm_summary_250 (<=250 chars), conversation_rating/agent_score/customer_score (integers 1-5), improvement_tip (<=200 chars, actionable).
    8. Detect abuse and profanity: set agent_profanity_detected / agent_profanity_count (agent side) and customer_abuse_detected / customer_abuse_count (customer side). Only count explicit insults, slurs, or profanity pointed at the counterpart/company.
    """
)

DEFAULT_ADDITIONAL_INSTRUCTIONS = _dedent(
    """
    Additional instructions:
    - Quote short phrases (e.g., "customer: bike stuck at finish screen") inside reason_override_why and resolution_why to justify decisions.
    - steps_extract should only describe agent actions or system fixes that move toward resolution; omit chit-chat.
    - When unresolved, explain the blocker inside resolution_why and set both resolution_timestamp_iso and resolution_message_index to null.
    - Make resolution_extract under 15 words; problem_extract must stay concise yet include the concrete issue details (what broke, which dock, which outage cause, etc.).
    - If profanity/abuse counts differ from transcript reality, explain briefly in resolution_why.
    - Keep tone factual and manager-ready. Return STRICT JSON only-no Markdown or extra commentary.
    - Scoring scale for conversation_rating, agent_score, and customer_score: 1=Very poor, 2=Poor, 3=Adequate, 4=Good, 5=Excellent.
    """
)

DEFAULT_CONVERSATION_RATING = _dedent(
    """
    Detailed scoring guidance:
    CONVERSATION_RATING
    - Primary signals: resolved flag, sentiment at end, proof of closure, avoidable effort.
    - 5 -> resolved=true AND resolution_timestamp_iso provided AND customer_sentiment_primary in {Delight, Convenience, Trust}.
    - 4 -> resolved=true AND customer_sentiment_primary in {Neutral} OR clear shift from Frustration to Neutral; only minor avoidable effort.
    - 3 -> unresolved BUT a clear next step is agreed and no harm done; neutral tone.
    - 2 -> unresolved AND misclassification left uncorrected OR long back-and-forth with little progress.
    - 1 -> incorrect/unsafe guidance, policy breach, or hostility escalation.
    """
)

DEFAULT_AGENT_SCORE = _dedent(
    """
    AGENT_SCORE
    - Primary signals: correct diagnosis/classification, useful actions, ownership, clarity.
    - 5 -> correct contact_reason or justified override; at least two concrete steps_extract; delivers fix or definitive path; clear instructions.
    - 4 -> small miss but corrected; steps_extract present; only minor clarity gaps.
    - 3 -> some helpful action but partial or vague; missed one key step.
    - 2 -> wrong or uncorrected classification OR speculative help with low action density.
    - 1 -> harmful, rude, vulgar, or no actionable help.
    """
)

DEFAULT_CUSTOMER_SCORE = _dedent(
    """
    CUSTOMER_SCORE
    - Primary signals: final customer message, sentiment curve, explicit thanks/relief.
    - 5 -> explicit positive closure ("works now," "thanks!") or Delight/Trust sentiment at the end.
    - 4 -> polite thanks without enthusiasm; Neutral at the end.
    - 3 -> neutral acceptance ("ok," "I'll try") without closure proof.
    - 2 -> lingering doubt, mild Frustration/Concern, or abandonment.
    - 1 -> Hostility/Disappointment or vulgar/profane language directed at the agent/company (swearing acceptable only when describing the issue itself).
    """
)

DEFAULT_PROMPT_SECTIONS: Dict[ProjectConfigType, Any] = {
    "task_sequence": DEFAULT_TASK_SEQUENCE,
    "additional_instructions": DEFAULT_ADDITIONAL_INSTRUCTIONS,
    "conversation_rating": DEFAULT_CONVERSATION_RATING,
    "agent_score": DEFAULT_AGENT_SCORE,
    "customer_score": DEFAULT_CUSTOMER_SCORE,
}

SYSTEM_PROMPT_DEFAULT = _dedent(
    """
    You are a meticulous quality assurance analyst who responds in JSON. Conversation transcript lines use 'A:' for agent and 'C:' for customer to optimise tokens.
    """
)

PROMPT_HEADER_DEFAULT = _dedent(
    """
    Review the conversation above and respond with a SINGLE JSON object that satisfies the schema below.
    """
)

PROMPT_JSON_SCHEMA_DEFAULT = _dedent(
    """
    Strict JSON schema (all fields required, nulls allowed only when noted):
    {
      "llm_summary_250": string (<=150 chars),
      "conversation_rating": integer (1-5),
      "extract_customer_probelm": string (mirror of problem_extract),
      "problem_extract": string (<=150 chars),
      "resolution_extract": string (<=150 chars),
      "contact_reason": string from taxonomy (or "Other"),
      "contact_reason_change": boolean,
      "reason_override_why": string (<=300 chars, cite transcript cues when contact_reason_change=true; use empty string when no change),
      "agent_score": integer (1-5),
      "customer_score": integer (1-5),
      "resolved": boolean,
      "is_resolved": boolean,
      "resolution_why": string (<=300 chars, factual rationale for resolved/unresolved),
      "steps_extract": array of strings,
      "resolution_timestamp_iso": string | null (ISO 8601 for the resolution moment, null if unresolved),
      "resolution_message_index": integer | null (1-based index of the decisive message, null if unresolved),
      "customer_sentiment_primary": one of the eight labels listed above,
      "customer_sentiment_scores": {
        "Delight": number,
        "Convenience": number,
        "Trust": number,
        "Frustration": number,
        "Disappointment": number,
        "Concern": number,
        "Hostility": number,
        "Neutral": number
      },
      "agent_profanity_detected": boolean,
      "agent_profanity_count": integer (>=0),
      "customer_abuse_detected": boolean,
      "customer_abuse_count": integer (>=0),
      "improvement_tip": string (<=200 chars)
    }
    """
)


def default_contact_taxonomy() -> Dict[str, Any]:
    try:
        from analysis.default_taxonomy import AGENT_CONTACT_HEADINGS  # type: ignore
    except Exception:
        try:
            from default_taxonomy import AGENT_CONTACT_HEADINGS  # type: ignore
        except Exception:
            AGENT_CONTACT_HEADINGS = ()
    return {"reasons": [{"topic": str(label).strip(), "status": "IN_USE"} for label in AGENT_CONTACT_HEADINGS if str(label).strip()]}


def default_internal_users(csv_path: Path = Path("data/port_roles.csv")) -> Dict[str, Any]:
    """Load internal users from the legacy CSV to use as a default payload."""
    if not csv_path.exists():
        return {"users": []}
    users = []
    try:
        with csv_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                user_id = (row.get("user_id") or "").strip()
                if not user_id:
                    continue
                users.append(
                    {
                        "user_id": user_id,
                        "display_name": (row.get("display_name") or "").strip(),
                        "port_role": (row.get("port_role") or "").strip().upper() or "NON_AGENT",
                    }
                )
    except Exception:
        return {"users": []}
    return {"users": users}


DEFAULT_INTERNAL_USERS = default_internal_users()
DEFAULT_CONTACT_TAXONOMY = default_contact_taxonomy()


def compute_checksum(payload: Any) -> str:
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_payload(config_type: ProjectConfigType, payload: Any) -> bool:
    if config_type == "internal_users":
        if not isinstance(payload, dict):
            return False
        users = payload.get("users")
        if not isinstance(users, list):
            return False
        for entry in users:
            if not isinstance(entry, Mapping):
                return False
            user_id = (entry.get("user_id") or "").strip()
            if not user_id:
                return False
            port_role = (entry.get("port_role") or "").strip().upper()
            if port_role not in {"TIER1", "TIER2", "NON_AGENT", "AGENT", ""}:
                return False
        return True
    if config_type == "contact_taxonomy":
        if not isinstance(payload, Mapping):
            return False
        reasons = payload.get("reasons")
        labels = payload.get("labels")
        if isinstance(reasons, list):
            for entry in reasons:
                if not isinstance(entry, Mapping):
                    return False
                topic = (entry.get("topic") or "").strip()
                if not topic:
                    return False
            return True
        if isinstance(labels, list):
            return all(isinstance(label, str) and label.strip() for label in labels)
        return False
    return _is_non_empty_string(payload)


@dataclass(frozen=True)
class ProjectConfigEntry:
    type: ProjectConfigType
    payload: Any
    version: int
    checksum: str
    updated_at: Optional[str]
    updated_by: Optional[str]


class ProjectConfigStore:
    """Pull project configuration from Supabase with cached fallbacks."""

    def __init__(
        self,
        *,
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None,
        cache_dir: Path | str = Path("local_data/config_cache"),
        refresh_interval_seconds: int = 300,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self.supabase_url = supabase_url or os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        self.supabase_key = supabase_key or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.refresh_interval_seconds = max(30, refresh_interval_seconds)
        self.log = logger or logging.getLogger(self.__class__.__name__)
        self._entries: Dict[ProjectConfigType, ProjectConfigEntry] = {}
        self._lock = threading.Lock()
        self._last_refresh = 0.0
        self._client: Optional[Client] = None

    def _client_if_available(self) -> Optional[Client]:
        if self._client is not None:
            return self._client
        if not self.supabase_url or not self.supabase_key:
            return None
        if create_client is None:  # pragma: no cover - optional dependency
            return None
        try:
            self._client = create_client(self.supabase_url, self.supabase_key)
        except Exception as exc:  # pragma: no cover - network failure
            self.log.warning("Unable to initialise Supabase client: %s", exc)
            self._client = None
        return self._client

    def _cache_path(self, config_type: ProjectConfigType) -> Path:
        return self.cache_dir / f"{config_type}.json"

    def _read_cache(self) -> Dict[ProjectConfigType, ProjectConfigEntry]:
        entries: Dict[ProjectConfigType, ProjectConfigEntry] = {}
        for config_type in CONFIG_TYPES:
            path = self._cache_path(config_type)
            if not path.exists():
                continue
            try:
                with path.open("r", encoding="utf-8") as handle:
                    data = json.load(handle)
                payload = data.get("payload")
                if not validate_payload(config_type, payload):
                    continue
                entry = ProjectConfigEntry(
                    type=config_type,
                    payload=payload,
                    version=int(data.get("version") or 1),
                    checksum=str(data.get("checksum") or compute_checksum(payload)),
                    updated_at=data.get("updated_at"),
                    updated_by=data.get("updated_by"),
                )
                entries[config_type] = entry
            except Exception:
                continue
        return entries

    def _write_cache(self, entries: Mapping[ProjectConfigType, ProjectConfigEntry]) -> None:
        for entry in entries.values():
            try:
                path = self._cache_path(entry.type)
                with path.open("w", encoding="utf-8") as handle:
                    json.dump(
                        {
                            "type": entry.type,
                            "payload": entry.payload,
                            "version": entry.version,
                            "checksum": entry.checksum,
                            "updated_at": entry.updated_at,
                            "updated_by": entry.updated_by,
                        },
                        handle,
                        ensure_ascii=False,
                        indent=2,
                    )
            except Exception:
                self.log.debug("Failed to write cache for %s", entry.type)

    def _load_defaults(self) -> Dict[ProjectConfigType, ProjectConfigEntry]:
        defaults: Dict[ProjectConfigType, ProjectConfigEntry] = {}
        for config_type in CONFIG_TYPES:
            payload = DEFAULT_PROMPT_SECTIONS.get(config_type)
            if payload is None and config_type == "system_prompt":
                payload = SYSTEM_PROMPT_DEFAULT
            if payload is None and config_type == "prompt_header":
                payload = PROMPT_HEADER_DEFAULT
            if payload is None and config_type == "prompt_json_schema":
                payload = PROMPT_JSON_SCHEMA_DEFAULT
            if payload is None and config_type == "internal_users":
                payload = DEFAULT_INTERNAL_USERS
            if payload is None and config_type == "contact_taxonomy":
                payload = DEFAULT_CONTACT_TAXONOMY
            if payload is None:
                payload = ""
            defaults[config_type] = ProjectConfigEntry(
                type=config_type,
                payload=payload,
                version=1,
                checksum=compute_checksum(payload),
                updated_at=None,
                updated_by=None,
            )
        return defaults

    def _fetch_remote(self) -> Dict[ProjectConfigType, ProjectConfigEntry]:
        client = self._client_if_available()
        if client is None:
            return {}
        try:
            resp = (
                client.table("project_config")
                .select("type,payload,version,checksum,updated_at,updated_by,is_active")
                .eq("is_active", True)
                .execute()
            )
        except Exception as exc:  # pragma: no cover - runtime safety
            self.log.warning("Unable to fetch project_config from Supabase: %s", exc)
            return {}
        data = getattr(resp, "data", None) or []
        entries: Dict[ProjectConfigType, ProjectConfigEntry] = {}
        for row in data:
            config_type = (row.get("type") or "").strip()
            if config_type not in CONFIG_TYPES:
                continue
            payload = row.get("payload")
            if not validate_payload(config_type, payload):
                continue
            version = int(row.get("version") or 1)
            checksum = row.get("checksum") or compute_checksum(payload)
            updated_at = row.get("updated_at")
            updated_by = row.get("updated_by")
            entries[config_type] = ProjectConfigEntry(
                type=config_type,
                payload=payload,
                version=version,
                checksum=str(checksum),
                updated_at=updated_at,
                updated_by=updated_by,
            )
        return entries

    def _fetch_contact_taxonomy_remote(self) -> Optional[Sequence[str]]:
        client = self._client_if_available()
        if client is None:
            return None
        try:
            resp_active = (
                client.table("contact_taxonomy_versions")
                .select("id,version,status")
                .eq("status", "IN_USE")
                .order("version", desc=True)
                .limit(1)
                .execute()
            )
            data = getattr(resp_active, "data", None) or []
            if not data:
                resp_any = (
                    client.table("contact_taxonomy_versions")
                    .select("id,version,status")
                    .order("version", desc=True)
                    .limit(1)
                    .execute()
                )
                data = getattr(resp_any, "data", None) or []
            if not data:
                return None
            version_id = data[0].get("id")
            if not version_id:
                return None
            resp_reasons = (
                client.table("contact_taxonomy_reasons")
                .select("topic,sub_reason,sort_order,status")
                .eq("version_id", version_id)
                .order("sort_order")
                .order("topic")
                .execute()
            )
            reasons = getattr(resp_reasons, "data", None) or []
            labels: list[str] = []
            for entry in reasons:
                status = str(entry.get("status") or "").upper() if isinstance(entry, Mapping) else ""
                if status == "CANCELLED":
                    continue
                topic = str(entry.get("topic") or "").strip()
                sub_reason = str(entry.get("sub_reason") or "").strip()
                if not topic:
                    continue
                labels.append(f"{topic} - {sub_reason}" if sub_reason else topic)
            if labels:
                return tuple(labels)
        except Exception as exc:  # pragma: no cover
            self.log.warning("Unable to fetch contact_taxonomy_versions from Supabase: %s", exc)
            return None
        return None

    def load(self, force_refresh: bool = False) -> Mapping[ProjectConfigType, ProjectConfigEntry]:
        with self._lock:
            now = time.monotonic()
            if not force_refresh and self._entries and (now - self._last_refresh) < self.refresh_interval_seconds:
                return self._entries

            entries: MutableMapping[ProjectConfigType, ProjectConfigEntry] = {}
            cached = self._read_cache()
            if cached:
                entries.update(cached)
            remote_entries = self._fetch_remote()
            if remote_entries:
                entries.update(remote_entries)
                self._write_cache(remote_entries)

            defaults = self._load_defaults()
            for key, default_entry in defaults.items():
                if key not in entries:
                    entries[key] = default_entry

            self._entries = dict(entries)
            self._last_refresh = now
            return self._entries

    def get(self, config_type: ProjectConfigType) -> ProjectConfigEntry:
        entries = self.load()
        return entries[config_type]

    def get_prompt_sections(self) -> Dict[str, str]:
        """Return prompt text sections merged with defaults."""
        entries = self.load()
        sections: Dict[str, str] = {}
        for key in (
            "system_prompt",
            "prompt_header",
            "prompt_json_schema",
            "task_sequence",
            "additional_instructions",
            "conversation_rating",
            "agent_score",
            "customer_score",
        ):
            entry = entries.get(key) or self._load_defaults()[key]
            payload = entry.payload
            if isinstance(payload, str):
                sections[key] = payload
            elif key == "system_prompt":
                sections[key] = SYSTEM_PROMPT_DEFAULT
            elif key == "prompt_header":
                sections[key] = PROMPT_HEADER_DEFAULT
            elif key == "prompt_json_schema":
                sections[key] = PROMPT_JSON_SCHEMA_DEFAULT
            else:
                sections[key] = DEFAULT_PROMPT_SECTIONS[key]  # type: ignore[index]
        return sections

    def load_prompt_sections_strict(self, *, allow_cache: bool = False) -> Dict[str, str]:
        """
        Load prompt sections strictly from Supabase (optionally falling back to cache) and
        fail if any required section is missing or empty. No baked-in defaults are used here.
        """
        required_keys = (
            "system_prompt",
            "prompt_header",
            "prompt_json_schema",
            "task_sequence",
            "additional_instructions",
            "conversation_rating",
            "agent_score",
            "customer_score",
        )
        with self._lock:
            remote_entries = self._fetch_remote()
            entries: Dict[ProjectConfigType, ProjectConfigEntry] = {}
            if remote_entries:
                entries.update(remote_entries)
                self._write_cache(remote_entries)
            elif allow_cache:
                entries.update(self._read_cache())

            if not entries:
                raise RuntimeError("Failed to load prompt sections from Supabase (no data returned).")

            sections: Dict[str, str] = {}
            missing: list[str] = []
            for key in required_keys:
                entry = entries.get(key)
                payload = entry.payload if entry else None
                if isinstance(payload, str) and payload.strip():
                    sections[key] = payload
                else:
                    missing.append(key)
            if missing:
                raise RuntimeError(f"Missing prompt sections in project_config: {', '.join(sorted(missing))}")
            return sections

    def get_internal_users(self) -> Dict[str, Any]:
        entries = self.load()
        entry = entries.get("internal_users")
        if entry and isinstance(entry.payload, Mapping) and validate_payload("internal_users", entry.payload):
            return dict(entry.payload)
        return DEFAULT_INTERNAL_USERS

    def get_contact_taxonomy(self) -> Sequence[str]:
        remote = self._fetch_contact_taxonomy_remote()
        if remote:
            return remote
        entries = self.load()
        entry = entries.get("contact_taxonomy")
        if entry and isinstance(entry.payload, Mapping) and validate_payload("contact_taxonomy", entry.payload):
            payload = entry.payload
            if isinstance(payload.get("reasons"), list):
                labels: list[str] = []
                for reason in payload.get("reasons", []):
                    topic = str(reason.get("topic") if isinstance(reason, Mapping) else "").strip()
                    sub = str(reason.get("sub_reason") if isinstance(reason, Mapping) else "").strip()
                    status = str(reason.get("status") if isinstance(reason, Mapping) else "").upper()
                    if status == "CANCELLED":
                        continue
                    if topic:
                        labels.append(f"{topic} - {sub}" if sub else topic)
                if labels:
                    return tuple(labels)
            labels = payload.get("labels")
            if isinstance(labels, list):
                cleaned = [str(label).strip() for label in labels if str(label).strip()]
                if cleaned:
                    return tuple(cleaned)
        if isinstance(DEFAULT_CONTACT_TAXONOMY, Mapping):
            reasons = DEFAULT_CONTACT_TAXONOMY.get("reasons")
            if isinstance(reasons, list):
                labels: list[str] = []
                for reason in reasons:
                    if not isinstance(reason, Mapping):
                        continue
                    topic = str(reason.get("topic") or "").strip()
                    sub = str(reason.get("sub_reason") or "").strip()
                    if topic:
                        labels.append(f"{topic} - {sub}" if sub else topic)
                if labels:
                    return tuple(labels)
            labels = DEFAULT_CONTACT_TAXONOMY.get("labels")
            if isinstance(labels, list):
                cleaned = [str(label).strip() for label in labels if str(label).strip()]
                if cleaned:
                    return tuple(cleaned)
        elif isinstance(DEFAULT_CONTACT_TAXONOMY, Sequence):
            cleaned = [str(label).strip() for label in DEFAULT_CONTACT_TAXONOMY if str(label).strip()]
            if cleaned:
                return tuple(cleaned)
        return ()
