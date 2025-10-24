#!/usr/bin/env python3
"""
Analyze customer-agent conversations from JSONL and emit CSV quality metrics.

The script computes timing statistics, basic abuse/profanity heuristics, and
optionally augments each conversation with LLM-derived quality assessments.
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import os
import re
import sys
import textwrap
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from dateutil import parser as dt_parser
from tqdm import tqdm

try:
    import tiktoken  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    tiktoken = None

KEYWORD_CONTACT_MAP: Dict[str, Sequence[str]] = {}
AGENT_CONTACT_HEADINGS: Sequence[str] = ()

try:
    from contact_taxonomy import (  # type: ignore
        AGENT_CONTACT_HEADINGS as _AGENT_CONTACT_HEADINGS,
        KEYWORD_CONTACT_MAP as _KEYWORD_CONTACT_MAP,
    )

    AGENT_CONTACT_HEADINGS = _AGENT_CONTACT_HEADINGS
    KEYWORD_CONTACT_MAP = dict(_KEYWORD_CONTACT_MAP)
except ImportError:
    try:
        from analysis.contact_taxonomy import (  # type: ignore
            AGENT_CONTACT_HEADINGS as _AGENT_CONTACT_HEADINGS,
            KEYWORD_CONTACT_MAP as _KEYWORD_CONTACT_MAP,
        )

        AGENT_CONTACT_HEADINGS = _AGENT_CONTACT_HEADINGS
        KEYWORD_CONTACT_MAP = dict(_KEYWORD_CONTACT_MAP)
    except ImportError:
        fallback_path = Path(__file__).resolve().parent / "analysis" / "contact_taxonomy.py"
        if fallback_path.exists():
            spec = importlib.util.spec_from_file_location("contact_taxonomy_fallback", fallback_path)
            if spec and spec.loader:
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                AGENT_CONTACT_HEADINGS = getattr(module, "AGENT_CONTACT_HEADINGS", ())
                KEYWORD_CONTACT_MAP = dict(getattr(module, "KEYWORD_CONTACT_MAP", {}))

try:  # pragma: no cover - optional dependency
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional dependency
    load_dotenv = None  # type: ignore


def _load_dotenv_if_available() -> None:
    if load_dotenv is None:
        return
    env_path = Path(".env")
    if env_path.exists():
        load_dotenv(dotenv_path=env_path, override=False)


_load_dotenv_if_available()


def _safe_int(value: Optional[str], default: int) -> int:
    try:
        return int(value) if value is not None else default
    except ValueError:
        return default


DEFAULT_TAXONOMY_HINTS = _safe_int(os.getenv("PORT_TAXONOMY_HINTS"), 3)

CODE_BLOCK_PATTERN = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def format_taxonomy_block(taxonomy: Sequence[str], hints_per_label: int) -> str:
    if not taxonomy:
        return "None provided."
    lines: List[str] = []
    for item in taxonomy:
        entry = f"- {item}"
        if hints_per_label > 0:
            keywords = KEYWORD_CONTACT_MAP.get(item)
            if keywords:
                unique = list(dict.fromkeys(keywords))[:hints_per_label]
                if unique:
                    entry = f"{entry}: {', '.join(unique)}"
        lines.append(entry)
    return "\n".join(lines)


def _extract_json_payload(content: str) -> Dict[str, Any]:
    candidates: List[str] = []
    stripped = content.strip()
    if stripped:
        candidates.append(stripped)
    for match in CODE_BLOCK_PATTERN.finditer(content):
        block = match.group(1).strip()
        if block:
            candidates.append(block)
    for candidate in candidates:
        text = candidate.strip()
        if not text:
            continue
        if text.startswith("```"):
            text = text.strip("`").strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            start = text.find("{")
            end = text.rfind("}")
            if start != -1 and end != -1 and end > start:
                snippet = text[start : end + 1]
                try:
                    return json.loads(snippet)
                except json.JSONDecodeError:
                    continue
    raise ValueError("No valid JSON object found in LLM response")


PROFANITY_TERMS: Tuple[str, ...] = (
    "fuck",
    "shit",
    "damn",
    "hell",
    "bitch",
    "bastard",
    "asshole",
    "crap",
)
ABUSE_EXTRA_TERMS: Tuple[str, ...] = (
    "idiot",
    "stupid",
    "useless",
    "moron",
    "dumb",
    "terrible",
    "awful",
    "worthless",
    "incompetent",
    "hate",
)
CUSTOMER_ABUSE_TERMS: Tuple[str, ...] = PROFANITY_TERMS + ABUSE_EXTRA_TERMS

ROLE_SHORT_MAP = {
    "agent": "A",
    "customer": "C",
    "unknown": "U",
}

CSV_FIELDS: Sequence[str] = (
    "issue_key",
    "status",
    "resolution",
    "custom_field_hub",
    "conversation_start",
    "conversation_end",
    "duration_minutes",
    "first_agent_response_minutes",
    "avg_agent_response_minutes",
    "avg_customer_response_minutes",
    "messages_total",
    "messages_agent",
    "messages_customer",
    "turns",
    "agent_authors",
    "customer_authors",
    "initial_response_sla_5m",
    "initial_response_sla_15m",
    "agent_profanity_detected",
    "agent_profanity_count",
    "customer_abuse_detected",
    "customer_abuse_count",
    "llm_summary_250",
    "conversation_rating",
    "extract_customer_problem",
    "contact_reason",
    "contact_reason_original",
    "agent_score",
    "customer_score",
    "resolved",
    "improvement_tip",
    "llm_model",
    "llm_input_tokens",
    "llm_output_tokens",
    "llm_cost_usd",
)


MODEL_PRICING: Dict[str, Dict[str, float]] = {
    # Pricing is kept in dollars per 1K tokens.
    # References: https://platform.openai.com/pricing
    "gpt-4o": {"input": 0.01, "output": 0.03},
    "gpt-4o-mini": {"input": 0.0025, "output": 0.01},
    # GPT-5 placeholder tiers (update when official numbers are published)
    "gpt-5.0": {"input": 0.005, "output": 0.015},
    "gpt-5.0-mini": {"input": 0.002, "output": 0.006},
    "gpt-5.0-pro": {"input": 0.01, "output": 0.03},
    # gpt-5-nano published pricing: $0.050 / 1M input, $0.400 / 1M output
    "gpt-5-nano": {"input": 0.00005, "output": 0.0004},
}


def _load_dotenv_if_available() -> None:
    if load_dotenv is None:
        return
    env_path = Path(".env")
    if env_path.exists():
        load_dotenv(dotenv_path=env_path, override=False)


_load_dotenv_if_available()


@dataclass
class Comment:
    timestamp: Optional[datetime]
    author: str
    role: str
    role_short: str
    text: str


@dataclass
class ConversationMetrics:
    conversation_start: Optional[datetime]
    conversation_end: Optional[datetime]
    duration_minutes: Optional[float]
    first_agent_response_minutes: Optional[float]
    avg_agent_response_minutes: Optional[float]
    avg_customer_response_minutes: Optional[float]
    messages_total: int
    messages_agent: int
    messages_customer: int
    turns: int
    agent_authors: Tuple[str, ...]
    customer_authors: Tuple[str, ...]
    initial_response_sla_5m: Optional[bool]
    initial_response_sla_15m: Optional[bool]
    agent_profanity_count: int
    customer_abuse_count: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compute quality metrics for Jira-style conversations."
    )
    parser.add_argument(
        "--input",
        default="jira_clean_sample.jsonl",
        help="Path to the JSONL conversations file.",
    )
    parser.add_argument(
        "--output",
        help="Destination CSV filepath. Defaults to data/conversation_quality_<timestamp>.csv.",
    )
    parser.add_argument(
        "--model",
        default="gpt-4o-mini",
        help="Chat model identifier for LLM augmentation (default: gpt-4o-mini).",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.2,
        help="Sampling temperature for the LLM (default: 0.2).",
    )
    parser.add_argument(
        "--max-output-tokens",
        type=int,
        default=4000,
        help="Maximum completion tokens to request from the LLM (default: 4000).",
    )
    parser.add_argument(
        "--max-conversations",
        type=int,
        default=0,
        help="Optional limit for number of conversations processed (0 = all).",
    )
    parser.add_argument(
        "--taxonomy-file",
        help="Optional JSON file containing an array of contact reasons to override the default taxonomy.",
    )
    parser.add_argument(
        "--no-llm",
        action="store_true",
        help="Skip LLM augmentation. Outputs baseline metrics only.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Print LLM prompts and responses for inspection.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print per-conversation progress details while processing.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Skip conversations whose issue_key already exists in the output CSV.",
    )
    parser.add_argument(
        "--benchmark-models",
        nargs="+",
        help="Optional list of model identifiers to benchmark sequentially using the same input (default: use --model only).",
    )
    parser.add_argument(
        "--generate-payloads",
        metavar="DIR",
        help="Write per-conversation request payloads to DIR instead of calling the LLM.",
    )
    return parser.parse_args()


def load_taxonomy(path: Optional[str]) -> Sequence[str]:
    if path:
        file_path = Path(path)
        if not file_path.exists():
            print(f"[warn] taxonomy file not found: {path}", file=sys.stderr)
        else:
            try:
                data = json.loads(file_path.read_text(encoding="utf-8"))
                if isinstance(data, list) and all(isinstance(item, str) for item in data):
                    return tuple(data)
                print(
                    "[warn] taxonomy file must contain a JSON array of strings; using default taxonomy.",
                    file=sys.stderr,
                )
            except json.JSONDecodeError as exc:  # pragma: no cover - invalid file
                print(f"[warn] failed to parse taxonomy file: {exc}", file=sys.stderr)
    return AGENT_CONTACT_HEADINGS


def estimate_tokens(text: str, model: str) -> int:
    if not text:
        return 0
    if tiktoken is not None:
        try:
            encoding = tiktoken.encoding_for_model(model)
        except KeyError:
            encoding = tiktoken.get_encoding("cl100k_base")
        return len(encoding.encode(text))
    # Simple heuristic fallback
    return max(1, int(len(text.split()) * 1.33))


def estimate_cost(model: str, prompt_tokens: Optional[int], completion_tokens: Optional[int]) -> Optional[float]:
    pricing = MODEL_PRICING.get(model)
    if not pricing or prompt_tokens is None or completion_tokens is None:
        return None
    cost = (prompt_tokens / 1000.0) * pricing["input"]
    cost += (completion_tokens / 1000.0) * pricing["output"]
    return cost


def ensure_header(path: Path, fieldnames: Sequence[str]) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()


def append_row(path: Path, fieldnames: Sequence[str], row: Dict[str, str]) -> None:
    with path.open("a", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writerow(row)


def load_existing_issue_keys(path: Path) -> set[str]:
    if not path.exists():
        return set()
    existing: set[str] = set()
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                issue_key = (row.get("issue_key") or "").strip()
                if issue_key:
                    existing.add(issue_key)
    except Exception as exc:
        print(f"[warn] failed to read existing output for resume support: {exc}")
    return existing


def ensure_openai_client() -> Optional[Tuple[str, Any]]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("[warn] OPENAI_API_KEY not set; LLM features disabled.", file=sys.stderr)
        return None
    try:  # prefer new-style client
        from openai import OpenAI  # type: ignore

        return ("client", OpenAI(api_key=api_key))
    except ImportError:
        try:
            import openai  # type: ignore
        except ImportError:
            print("[warn] openai package is not installed.", file=sys.stderr)
            return None
        openai.api_key = api_key  # type: ignore[attr-defined]
        return ("legacy", openai)


def parse_datetime(value: Any) -> Optional[datetime]:
    text = (value or "").strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = dt_parser.isoparse(normalized)
    except (ValueError, TypeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def determine_role(author: str, explicit: Optional[str]) -> Tuple[str, str]:
    if explicit:
        normalized = explicit.strip().upper()
        if normalized in {"~A", "A"}:
            return "agent", ROLE_SHORT_MAP["agent"]
        if normalized in {"~C", "C"}:
            return "customer", ROLE_SHORT_MAP["customer"]
        if normalized in {"~U", "U"}:
            return "unknown", ROLE_SHORT_MAP["unknown"]

    norm = (author or "").strip().lower()
    if norm.startswith("712020"):
        return "agent", ROLE_SHORT_MAP["agent"]
    if norm.startswith("qm:"):
        return "customer", ROLE_SHORT_MAP["customer"]
    return "unknown", ROLE_SHORT_MAP["unknown"]


def parse_comments(raw_comments: Iterable[Dict[str, Any]]) -> List[Comment]:
    parsed: List[Comment] = []
    for item in raw_comments:
        author = str(item.get("author") or "")
        explicit_role = item.get("role")
        role, role_short = determine_role(author, explicit_role if isinstance(explicit_role, str) else None)
        timestamp = parse_datetime(item.get("date"))
        text = str(item.get("text") or "").strip()
        parsed.append(
            Comment(
                timestamp=timestamp,
                author=author,
                role=role,
                role_short=role_short,
                text=text,
            )
        )

    parsed.sort(
        key=lambda c: (
            c.timestamp or datetime.min.replace(tzinfo=timezone.utc),
            c.role,
        )
    )
    return parsed


def minutes_between(a: datetime, b: datetime) -> float:
    return (b - a).total_seconds() / 60.0


def count_term_hits(text: str, terms: Sequence[str]) -> int:
    import re

    lowered = text.lower()
    total = 0
    for term in terms:
        pattern = rf"\b{re.escape(term)}\b"
        total += len(re.findall(pattern, lowered))
    return total


def compute_metrics(comments: List[Comment]) -> ConversationMetrics:
    if not comments:
        return ConversationMetrics(
            conversation_start=None,
            conversation_end=None,
            duration_minutes=None,
            first_agent_response_minutes=None,
            avg_agent_response_minutes=None,
            avg_customer_response_minutes=None,
            messages_total=0,
            messages_agent=0,
            messages_customer=0,
            turns=0,
            agent_authors=(),
            customer_authors=(),
            initial_response_sla_5m=None,
            initial_response_sla_15m=None,
            agent_profanity_count=0,
            customer_abuse_count=0,
        )

    timestamps = [c.timestamp for c in comments if c.timestamp is not None]
    conversation_start = min(timestamps) if timestamps else None
    conversation_end = max(timestamps) if timestamps else None
    duration_minutes = (
        minutes_between(conversation_start, conversation_end)
        if conversation_start and conversation_end
        else None
    )

    messages_total = len(comments)
    messages_agent = sum(1 for c in comments if c.role == "agent")
    messages_customer = sum(1 for c in comments if c.role == "customer")

    last_customer_time: Optional[datetime] = None
    last_agent_time: Optional[datetime] = None
    agent_deltas: List[float] = []
    customer_deltas: List[float] = []
    first_agent_response_minutes: Optional[float] = None

    last_turn_role: Optional[str] = None
    turns = 0

    agent_profanity_count = 0
    customer_abuse_count = 0

    agent_authors_set: set[str] = set()
    customer_authors_set: set[str] = set()

    for comment in comments:
        if comment.role == "agent":
            if comment.timestamp and last_customer_time:
                delta = minutes_between(last_customer_time, comment.timestamp)
                agent_deltas.append(delta)
                if first_agent_response_minutes is None:
                    first_agent_response_minutes = delta
            if comment.timestamp:
                last_agent_time = comment.timestamp
            agent_profanity_count += count_term_hits(comment.text, PROFANITY_TERMS)
            if comment.author:
                agent_authors_set.add(comment.author)
        elif comment.role == "customer":
            if comment.timestamp and last_agent_time:
                delta = minutes_between(last_agent_time, comment.timestamp)
                customer_deltas.append(delta)
            if comment.timestamp:
                last_customer_time = comment.timestamp
            customer_abuse_count += count_term_hits(comment.text, CUSTOMER_ABUSE_TERMS)
            if comment.author:
                customer_authors_set.add(comment.author)
        else:
            # unknown role does not contribute to response deltas
            pass

        if comment.role in {"agent", "customer"}:
            if last_turn_role and comment.role != last_turn_role:
                turns += 1
            last_turn_role = comment.role

    avg_agent_response_minutes = (
        sum(agent_deltas) / len(agent_deltas) if agent_deltas else None
    )
    avg_customer_response_minutes = (
        sum(customer_deltas) / len(customer_deltas) if customer_deltas else None
    )

    initial_response_sla_5m = (
        first_agent_response_minutes is not None and first_agent_response_minutes <= 5
    )
    initial_response_sla_15m = (
        first_agent_response_minutes is not None and first_agent_response_minutes <= 15
    )
    if first_agent_response_minutes is None:
        initial_response_sla_5m = None
        initial_response_sla_15m = None

    return ConversationMetrics(
        conversation_start=conversation_start,
        conversation_end=conversation_end,
        duration_minutes=duration_minutes,
        first_agent_response_minutes=first_agent_response_minutes,
        avg_agent_response_minutes=avg_agent_response_minutes,
        avg_customer_response_minutes=avg_customer_response_minutes,
        messages_total=messages_total,
        messages_agent=messages_agent,
        messages_customer=messages_customer,
        turns=turns,
        agent_authors=tuple(sorted(agent_authors_set)),
        customer_authors=tuple(sorted(customer_authors_set)),
        initial_response_sla_5m=initial_response_sla_5m,
        initial_response_sla_15m=initial_response_sla_15m,
        agent_profanity_count=agent_profanity_count,
        customer_abuse_count=customer_abuse_count,
    )


def format_minutes(value: Optional[float]) -> str:
    return f"{value:.2f}" if value is not None else ""


def format_bool(value: Optional[bool]) -> str:
    if value is None:
        return ""
    return "true" if value else "false"


def build_transcript(comments: List[Comment]) -> str:
    lines: List[str] = []
    for idx, comment in enumerate(comments, start=1):
        timestamp = comment.timestamp.isoformat() if comment.timestamp else "unknown"
        role_label = comment.role_short
        lines.append(f"{idx:02d}. {role_label}: [{timestamp}] {comment.text}")
    return "\n".join(lines)


def build_llm_prompts(
    record: Dict[str, Any],
    metrics: ConversationMetrics,
    transcript: str,
    taxonomy: Sequence[str],
) -> Tuple[str, str]:
    system_prompt = (
        "You are a meticulous quality assurance analyst who responds in JSON. "
        "Conversation transcript lines use 'A:' for agent and 'C:' for customer to optimise tokens."
    )

    taxonomy_block = format_taxonomy_block(taxonomy, DEFAULT_TAXONOMY_HINTS)
    custom_fields = record.get("custom_fields") if isinstance(record.get("custom_fields"), dict) else {}
    original_contact_reason = ""
    if isinstance(custom_fields, dict):
        original_contact_reason = str(custom_fields.get("contact_reason", "")).strip()
    if not original_contact_reason:
        original_contact_reason = "Not specified"
    conversation_meta = textwrap.dedent(
        f"""
        Issue key: {record.get('issue_key', '')}
        Status: {record.get('status', '')}
        Resolution: {record.get('resolution', '')}
        Conversation start (UTC): {metrics.conversation_start.isoformat() if metrics.conversation_start else 'unknown'}
        Conversation end (UTC): {metrics.conversation_end.isoformat() if metrics.conversation_end else 'unknown'}
        Total messages: {metrics.messages_total}
        Agent messages: {metrics.messages_agent}
        Customer messages: {metrics.messages_customer}
        Estimated duration (minutes): {format_minutes(metrics.duration_minutes)}
        Original contact reason: {original_contact_reason}
        Contact taxonomy:
        {taxonomy_block}

        Transcript (A = agent, C = customer, U = unknown):
        {transcript}
        """
    ).strip()

    user_prompt = textwrap.dedent(
        """
        Review the conversation above and output a JSON object with these keys:
        - llm_summary_250: concise summary (<=250 characters).
        - conversation_rating: integer 1-5 (overall quality).
        - extract_customer_probelm: short explanation of the customer's main problem.
        - contact_reason: choose the closest entry from the provided contact taxonomy. If unsure, return "Other".
        - agent_score: integer 1-5 reflecting agent performance.
        - customer_score: integer 1-5 reflecting customer behavior and clarity.
        - resolved: boolean true/false indicating whether the issue seems resolved.
        - improvement_tip: actionable advice for the agent (<=200 characters).

        Scoring guidance (apply separately to conversation_rating, agent_score, customer_score):
        1 = Very poor (major issues, inaccurate or harmful behaviour).
        2 = Poor (significant problems or missing key actions).
        3 = Adequate (meets minimum expectations with notable gaps).
        4 = Good (solid performance with only minor improvements needed).
        5 = Excellent (exemplary work, no meaningful improvements needed).

        Return ONLY strict JSON, no explanations.
        """
    ).strip()

    prompt = f"{conversation_meta}\n\n{user_prompt}"
    return system_prompt, prompt


def model_supports_temperature(model: str) -> bool:
    return not model.lower().startswith("gpt-5")


def model_uses_responses_api(model: str) -> bool:
    name = model.lower()
    return name.startswith("gpt-5") or name.startswith("gpt-4.1")


def build_responses_input(system_prompt: str, user_prompt: str) -> List[Dict[str, Any]]:
    return [
        {
            "role": "system",
            "content": [
                {
                    "type": "input_text",
                    "text": system_prompt,
                }
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": user_prompt,
                }
            ],
        },
    ]


def extract_text_from_responses(response: Any) -> str:
    try:
        if hasattr(response, "output"):
            segments: List[str] = []
            for item in getattr(response, "output", []):
                contents = getattr(item, "content", [])
                for content in contents:
                    text = getattr(content, "text", None)
                    if isinstance(text, str):
                        segments.append(text)
                    elif isinstance(text, dict) and "value" in text:
                        segments.append(str(text["value"]))
                    elif isinstance(content, dict):
                        if content.get("type") == "output_text":
                            val = content.get("text")
                            if isinstance(val, dict):
                                segments.append(str(val.get("value", "")))
                            elif isinstance(val, str):
                                segments.append(val)
            if segments:
                return "\n".join(segments)
        if isinstance(response, dict):
            output = response.get("output") or []
            segments: List[str] = []
            for item in output:
                for content in item.get("content", []):
                    text = content.get("text")
                    if isinstance(text, str):
                        segments.append(text)
                    elif isinstance(text, dict):
                        segments.append(str(text.get("value", "")))
                    elif content.get("type") == "output_text":
                        val = content.get("text")
                        if isinstance(val, dict):
                            segments.append(str(val.get("value", "")))
                        elif isinstance(val, str):
                            segments.append(val)
            if segments:
                return "\n".join(segments)
        if hasattr(response, "output_text"):
            return str(response.output_text)
    except Exception:
        pass
    return ""


def build_request_payload(
    *,
    model: str,
    temperature: Optional[float],
    max_completion_tokens: int,
    system_prompt: str,
    user_prompt: str,
) -> Dict[str, Any]:
    if model_uses_responses_api(model):
        payload: Dict[str, Any] = {
            "model": model,
            "input": build_responses_input(system_prompt, user_prompt),
            "max_output_tokens": max_completion_tokens,
        }
        payload["text"] = {
            "format": {
                "type": "json_schema",
                "name": "conversation_quality_response",
                "schema": {
                    "type": "object",
                    "properties": {
                        "llm_summary_250": {"type": "string"},
                        "conversation_rating": {"type": "integer"},
                        "extract_customer_probelm": {"type": "string"},
                        "contact_reason": {"type": "string"},
                        "agent_score": {"type": "integer"},
                        "customer_score": {"type": "integer"},
                        "resolved": {"type": "boolean"},
                        "improvement_tip": {"type": "string"},
                    },
                    "required": [
                        "llm_summary_250",
                        "conversation_rating",
                        "extract_customer_probelm",
                        "contact_reason",
                        "agent_score",
                        "customer_score",
                        "resolved",
                        "improvement_tip",
                    ],
                    "additionalProperties": False,
                },
                "strict": True,
            }
        }
        payload["reasoning"] = {"effort": "low"}
        if temperature is not None and model_supports_temperature(model):
            payload["temperature"] = temperature
        return payload

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    payload = {
        "model": model,
        "messages": messages,
    }
    if model.lower().startswith("gpt-5"):
        payload["max_completion_tokens"] = max_completion_tokens
    else:
        payload["max_tokens"] = max_completion_tokens
    if temperature is not None:
        payload["temperature"] = temperature
    return payload


def call_llm(
    openai_client: Optional[Tuple[str, Any]],
    model: str,
    temperature: Optional[float],
    max_completion_tokens: int,
    system_prompt: str,
    user_prompt: str,
    debug: bool = False,
) -> Tuple[Optional[Dict[str, Any]], Optional[int], Optional[int], Optional[str]]:
    if openai_client is None:
        return None, None, None, None

    if debug:
        print("=== LLM SYSTEM PROMPT ===", flush=True)
        print(system_prompt, flush=True)
        print("=== LLM USER PROMPT ===", flush=True)
        print(user_prompt, flush=True)

    client_type, client = openai_client
    use_responses_api = model_uses_responses_api(model)
    if use_responses_api:
        has_attr_new = hasattr(client, "responses")
        has_attr_legacy = hasattr(client, "Responses")
        if client_type == "client" and not has_attr_new:
            use_responses_api = False
        if client_type != "client" and not has_attr_new and not has_attr_legacy:
            use_responses_api = False
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    response_json: Optional[Dict[str, Any]] = None
    error_message: Optional[str] = None
    raw_content: Optional[str] = None

    response_status: Optional[str] = None
    try:
        if client_type == "client":
            if use_responses_api:
                request_kwargs = build_request_payload(
                    model=model,
                    temperature=temperature if model_supports_temperature(model) else None,
                    max_completion_tokens=max_completion_tokens,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                )
                request_kwargs.pop("messages", None)
                response = client.responses.create(**request_kwargs)  # type: ignore[attr-defined]
                response_status = getattr(response, "status", None)
                usage = getattr(response, "usage", None)
                if usage is not None:
                    prompt_tokens = getattr(usage, "input_tokens", None)
                    completion_tokens = getattr(usage, "output_tokens", None)
                raw_content = extract_text_from_responses(response)
            else:
                request_kwargs = {
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                }
                if model.lower().startswith("gpt-5"):
                    request_kwargs["max_completion_tokens"] = max_completion_tokens
                else:
                    request_kwargs["max_tokens"] = max_completion_tokens
                if temperature is not None:
                    request_kwargs["temperature"] = temperature
                response = client.chat.completions.create(**request_kwargs)  # type: ignore[attr-defined]
                usage = getattr(response, "usage", None)
                if usage is not None:
                    prompt_tokens = getattr(usage, "prompt_tokens", None)
                    completion_tokens = getattr(usage, "completion_tokens", None)
                raw_content = response.choices[0].message.content  # type: ignore[index]
        else:
            if use_responses_api:
                request_kwargs = build_request_payload(
                    model=model,
                    temperature=temperature if model_supports_temperature(model) else None,
                    max_completion_tokens=max_completion_tokens,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                )
                request_kwargs.pop("messages", None)
                response = client.Responses.create(**request_kwargs)  # type: ignore[attr-defined]
                if isinstance(response, dict):
                    response_status = response.get("status")
                if isinstance(response, dict):
                    usage = response.get("usage")
                    if usage:
                        prompt_tokens = usage.get("input_tokens")
                        completion_tokens = usage.get("output_tokens")
                raw_content = extract_text_from_responses(response)
            else:
                request_kwargs = {
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                }
                if model.lower().startswith("gpt-5"):
                    request_kwargs["max_completion_tokens"] = max_completion_tokens
                else:
                    request_kwargs["max_tokens"] = max_completion_tokens
                if temperature is not None:
                    request_kwargs["temperature"] = temperature
                response = client.ChatCompletion.create(**request_kwargs)  # type: ignore[attr-defined]
                usage = response.get("usage") if isinstance(response, dict) else None
                if usage:
                    prompt_tokens = usage.get("prompt_tokens")
                    completion_tokens = usage.get("completion_tokens")
                raw_content = response["choices"][0]["message"]["content"]
    except Exception as exc:  # pragma: no cover - network errors
        error_message = str(exc)
        print(f"[warn] LLM call failed: {exc}", file=sys.stderr)
        return None, prompt_tokens, completion_tokens, error_message

    if not response_status and use_responses_api:
        try:
            if isinstance(response, dict):
                response_status = response.get("status")
            elif hasattr(response, "model_dump"):
                response_status = response.model_dump().get("status")
        except Exception:
            response_status = None

    if use_responses_api and response_status and response_status != "completed" and not raw_content:
        reason = ""
        try:
            payload_dict = response if isinstance(response, dict) else response.model_dump()
            details = payload_dict.get("incomplete_details") if payload_dict else None
            if isinstance(details, dict):
                reason = details.get("reason") or ""
        except Exception:
            reason = ""
        error_message = f"response_incomplete:{reason or response_status}"
        return None, prompt_tokens, completion_tokens, error_message

    if not raw_content:
        return None, prompt_tokens, completion_tokens, error_message

    if debug:
        print("=== LLM RESPONSE ===", flush=True)
        print(raw_content, flush=True)
        print("====================", flush=True)

    if prompt_tokens is None:
        prompt_tokens = estimate_tokens(system_prompt, model) + estimate_tokens(user_prompt, model)
    if completion_tokens is None and raw_content:
        completion_tokens = estimate_tokens(raw_content, model)

    try:
        response_json = _extract_json_payload(raw_content)
    except ValueError as exc:
        snippet = (raw_content or "")[:500]
        error_message = f"parse_error: {exc}; raw={snippet}"
        print(f"[warn] failed to parse LLM JSON: {exc}", file=sys.stderr)
        if debug:
            print("[debug] raw LLM content (unparsed):", flush=True)
            print(raw_content, flush=True)
        return None, prompt_tokens, completion_tokens, error_message

    return response_json, prompt_tokens, completion_tokens, error_message

def format_timestamp(value: Optional[datetime]) -> str:
    return value.isoformat() if value else ""


def load_jsonl(path: Path, limit: int) -> Iterable[Dict[str, Any]]:
    processed = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)
            processed += 1
            if limit and processed >= limit:
                break


def process_conversation(
    record: Dict[str, Any],
    metrics: ConversationMetrics,
    llm_payload: Optional[Dict[str, Any]],
    model: str,
    input_tokens: Optional[int],
    output_tokens: Optional[int],
    cost_usd: Optional[float],
) -> Dict[str, str]:
    custom_fields = record.get("custom_fields") or {}
    if not isinstance(custom_fields, dict):
        custom_fields = {}
    hub_value = custom_fields.get("hub")
    hub_str = "" if hub_value is None else str(hub_value)
    original_contact_reason = custom_fields.get("contact_reason")
    contact_reason_original = "" if original_contact_reason is None else str(original_contact_reason)

    row: Dict[str, str] = {
        "issue_key": str(record.get("issue_key", "")),
        "status": str(record.get("status", "")),
        "resolution": str(record.get("resolution", "")),
        "custom_field_hub": hub_str,
        "conversation_start": format_timestamp(metrics.conversation_start),
        "conversation_end": format_timestamp(metrics.conversation_end),
        "duration_minutes": format_minutes(metrics.duration_minutes),
        "first_agent_response_minutes": format_minutes(metrics.first_agent_response_minutes),
        "avg_agent_response_minutes": format_minutes(metrics.avg_agent_response_minutes),
        "avg_customer_response_minutes": format_minutes(metrics.avg_customer_response_minutes),
        "messages_total": str(metrics.messages_total),
        "messages_agent": str(metrics.messages_agent),
        "messages_customer": str(metrics.messages_customer),
        "turns": str(metrics.turns),
        "agent_authors": ";".join(metrics.agent_authors),
        "customer_authors": ";".join(metrics.customer_authors),
        "initial_response_sla_5m": format_bool(metrics.initial_response_sla_5m),
        "initial_response_sla_15m": format_bool(metrics.initial_response_sla_15m),
        "agent_profanity_detected": "true" if metrics.agent_profanity_count > 0 else "false",
        "agent_profanity_count": str(metrics.agent_profanity_count),
        "customer_abuse_detected": "true" if metrics.customer_abuse_count > 0 else "false",
        "customer_abuse_count": str(metrics.customer_abuse_count),
        "llm_summary_250": "",
        "conversation_rating": "",
        "extract_customer_problem": "",
        "contact_reason": "",
        "contact_reason_original": contact_reason_original,
        "agent_score": "",
        "customer_score": "",
        "resolved": "",
        "improvement_tip": "",
        "llm_model": model,
        "llm_input_tokens": str(input_tokens) if input_tokens is not None else "",
        "llm_output_tokens": str(output_tokens) if output_tokens is not None else "",
        "llm_cost_usd": f"{cost_usd:.6f}" if cost_usd is not None else "",
    }

    if metrics.agent_profanity_count == 0:
        row["agent_profanity_detected"] = "false"
    if metrics.customer_abuse_count == 0:
        row["customer_abuse_detected"] = "false"

    if llm_payload:
        row["llm_summary_250"] = str(llm_payload.get("llm_summary_250", "")).strip()
        rating = llm_payload.get("conversation_rating")
        row["conversation_rating"] = str(rating).strip() if rating is not None else ""
        row["extract_customer_problem"] = str(llm_payload.get("extract_customer_probelm", "")).strip()
        row["contact_reason"] = str(llm_payload.get("contact_reason", "")).strip()
        row["agent_score"] = str(llm_payload.get("agent_score", "")).strip()
        row["customer_score"] = str(llm_payload.get("customer_score", "")).strip()
        resolved_val = llm_payload.get("resolved")
        if isinstance(resolved_val, bool):
            row["resolved"] = "true" if resolved_val else "false"
        else:
            row["resolved"] = str(resolved_val).strip()
        row["improvement_tip"] = str(llm_payload.get("improvement_tip", "")).strip()
    return row


def run_convo_quality(
    *,
    input_path: Path,
    output_path: Path,
    model: str,
    temperature: float,
    max_output_tokens: int,
    taxonomy: Sequence[str],
    use_llm: bool,
    openai_client: Optional[Tuple[str, Any]],
    max_conversations: int,
    debug: bool,
    verbose: bool,
    resume: bool,
    payload_dir: Optional[Path],
) -> Tuple[int, int, float]:
    adjusted_temperature: Optional[float] = temperature
    if use_llm and not model_supports_temperature(model):
        adjusted_temperature = None

    fieldnames = list(CSV_FIELDS)
    ensure_header(output_path, fieldnames)
    skip_issue_keys = load_existing_issue_keys(output_path) if resume else set()

    total_prompt_tokens = 0
    total_completion_tokens = 0
    total_cost_usd = 0.0

    # Determine total records for progress/verbose reporting
    total_records = 0
    with input_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                total_records += 1
                if max_conversations and total_records >= max_conversations:
                    break

    processed = 0
    skipped = 0

    should_call_llm = use_llm and payload_dir is None
    iterator = load_jsonl(input_path, max_conversations)
    progress = tqdm(
        iterator,
        desc="Processing conversations",
        unit="conversation",
        total=total_records if total_records else None,
    )
    if payload_dir:
        payload_dir.mkdir(parents=True, exist_ok=True)

    for idx, record in enumerate(progress, start=1):
        raw_comments = record.get("comments") or []
        if not isinstance(raw_comments, list):
            raw_comments = []
        comments = parse_comments(raw_comments)
        metrics = compute_metrics(comments)
        transcript = build_transcript(comments)

        issue_key = str(record.get("issue_key", ""))
        if issue_key in skip_issue_keys:
            skipped += 1
            if verbose:
                progress.write(f"[skip] {issue_key} already present in {output_path.name}")
            continue

        llm_payload: Optional[Dict[str, Any]] = None
        prompt_tokens: Optional[int] = None
        completion_tokens: Optional[int] = None
        cost_usd: Optional[float] = None
        system_prompt, user_prompt = build_llm_prompts(record, metrics, transcript, taxonomy)

        if payload_dir:
            payload = build_request_payload(
                model=model,
                temperature=adjusted_temperature,
                max_completion_tokens=max_output_tokens,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
            )
            safe_issue = re.sub(r"[^A-Za-z0-9_-]", "_", issue_key or f"idx{idx}") or f"idx{idx}"
            model_tag = re.sub(r"[^A-Za-z0-9_-]", "_", model)
            payload_path = payload_dir / f"payload_{idx:04d}_{model_tag}_{safe_issue}.json"
            payload_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            if verbose:
                progress.write(f"[payload] wrote {payload_path}")

        if should_call_llm and comments:
            llm_payload, prompt_tokens, completion_tokens, error_msg = call_llm(
                openai_client=openai_client,
                model=model,
                temperature=adjusted_temperature,
                max_completion_tokens=max_output_tokens,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                debug=debug,
            )
            cost_usd = estimate_cost(model, prompt_tokens, completion_tokens)
            if prompt_tokens is not None:
                total_prompt_tokens += prompt_tokens
            if completion_tokens is not None:
                total_completion_tokens += completion_tokens
            if isinstance(llm_payload, dict) and "_reasoning_tokens" in llm_payload:
                try:
                    total_reasoning_tokens += int(llm_payload["_reasoning_tokens"])
                except Exception:
                    pass
            if cost_usd is not None:
                total_cost_usd += cost_usd
            if debug and should_call_llm:
                print(
                    f"[debug] tokens prompt={prompt_tokens or 0} completion={completion_tokens or 0} "
                    f"cost=${cost_usd or 0.0:.6f}"
                )
            if error_msg and debug:
                print(f"[debug] LLM note: {error_msg}")
                if not llm_payload:
                    llm_payload = {
                        "llm_summary_250": error_msg,
                        "conversation_rating": "",
                        "extract_customer_probelm": "",
                        "contact_reason": "",
                        "agent_score": "",
                        "customer_score": "",
                        "resolved": "",
                        "improvement_tip": "",
                    }

        row = process_conversation(
            record,
            metrics,
            llm_payload,
            model if should_call_llm else "",
            prompt_tokens,
            completion_tokens,
            cost_usd,
        )
        if debug and should_call_llm and llm_payload is None:
            progress.write(f"[debug] No parsed LLM response for {issue_key}; check raw output above.")
        append_row(output_path, fieldnames, row)
        processed += 1
        skip_issue_keys.add(issue_key)
        if verbose:
            rating_info = ''
            tokens_info = ''
            cost_info = ''
            if llm_payload and isinstance(llm_payload, dict):
                rating = llm_payload.get("conversation_rating")
                if rating not in (None, ""):
                    rating_info = f" rating={rating}"
            if should_call_llm:
                pt = prompt_tokens or 0
                ct = completion_tokens or 0
                rt = 0
                if isinstance(llm_payload, dict):
                    rt = int(llm_payload.get("_reasoning_tokens", 0) or 0)
                tokens_info = f" tokens={ct} (reasoning {rt})"
                if cost_usd is not None:
                    cost_info = f" cost=${total_cost_usd:.6f}"
            metrics_summary = (
                f"messages={metrics.messages_total} turns={metrics.turns} "
                f"duration={format_minutes(metrics.duration_minutes) or 'n/a'}"
            )
            progress.write(
                f"Processed {processed}/{total_records or processed}: {issue_key} | {metrics_summary}"
                f"{rating_info}{tokens_info}{cost_info}"
            )

    progress.close()

    print(f"[info] wrote {processed} conversations to {output_path}")
    if skipped:
        print(f"[info] skipped {skipped} conversations already present in output")
    if should_call_llm:
        print(
            f"[info] LLM usage for model {model}: "
            f"prompt tokens={total_prompt_tokens}, completion tokens={total_completion_tokens}, "
            f"cost=${total_cost_usd:.6f}"
        )
    return processed, total_prompt_tokens + total_completion_tokens, total_cost_usd


def main() -> int:
    args = parse_args()
    benchmark_models = args.benchmark_models or [args.model]
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"[error] input file not found: {input_path}", file=sys.stderr)
        return 1

    taxonomy = load_taxonomy(args.taxonomy_file)
    payload_dir = Path(args.generate_payloads).resolve() if args.generate_payloads else None

    for idx, model in enumerate(benchmark_models, start=1):
        if args.output:
            base_output = Path(args.output)
            if len(benchmark_models) > 1:
                output_path = base_output.with_name(
                    f"{base_output.stem}_{model.replace('.', '_')}{base_output.suffix}"
                )
            else:
                output_path = base_output
        else:
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            suffix = model.replace(".", "_")
            output_path = Path("data") / f"conversation_quality_{suffix}_{timestamp}.csv"

        print(f"[info] ({idx}/{len(benchmark_models)}) Processing model: {model}")

        use_llm = not args.no_llm
        if payload_dir is not None:
            use_llm = False
        openai_client = ensure_openai_client() if use_llm else None
        if use_llm and openai_client is None:
            print("[warn] proceeding without LLM augmentation.", file=sys.stderr)
            use_llm = False

        processed, total_tokens, total_cost = run_convo_quality(
            input_path=input_path,
            output_path=output_path,
            model=model,
            temperature=args.temperature,
            max_output_tokens=args.max_output_tokens,
            taxonomy=taxonomy,
            use_llm=use_llm,
            openai_client=openai_client,
            max_conversations=args.max_conversations,
            debug=args.debug,
            verbose=args.verbose,
            resume=args.resume,
            payload_dir=payload_dir,
        )

        print(
            f"[summary] model {model}: processed={processed}, total_tokens={total_tokens}, "
            f"cost=${total_cost:.6f} → {output_path}"
        )
        if payload_dir is not None:
            print(f"[info] Request payloads written to {payload_dir}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
