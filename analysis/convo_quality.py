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
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
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

MAX_SUMMARY_CHARS = 250
MAX_IMPROVEMENT_TIP_CHARS = 200
MAX_REASON_CHARS = 600
MAX_STEPS = 8
SENTIMENT_BUCKETS: Tuple[str, ...] = (
    "Delight",
    "Convenience",
    "Trust",
    "Frustration",
    "Disappointment",
    "Concern",
    "Hostility",
    "Neutral",
)


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


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _truncate(value: str, limit: int) -> str:
    text = value.strip()
    if not text or len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3].rstrip() + "..."


def _limit_words(value: str, limit: int) -> str:
    words = value.strip().split()
    if len(words) <= limit:
        return value.strip()
    return " ".join(words[:limit])


def _coerce_bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "t", "yes", "y", "1", "resolved", "done"}:
            return True
        if normalized in {"false", "f", "no", "n", "0", "unresolved", "open"}:
            return False
    return None


def _coerce_int(value: Any) -> Optional[int]:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(float(value.strip()))
        except ValueError:
            return None
    return None


def _normalise_steps_field(value: Any) -> List[str]:
    items: List[str] = []
    raw: Any = value
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            raw = []
        else:
            try:
                loaded = json.loads(text)
                raw = loaded
            except json.JSONDecodeError:
                raw = [segment.strip() for segment in text.split("||")]
    if isinstance(raw, list):
        for entry in raw:
            text = _truncate(_stringify(entry), MAX_REASON_CHARS)
            if text:
                items.append(text)
    elif isinstance(raw, str):
        text = _truncate(raw, MAX_REASON_CHARS)
        if text:
            items.append(text)
    return items[:MAX_STEPS]


def _normalise_sentiment_scores(value: Any) -> Dict[str, float]:
    parsed: Dict[str, Any] = {}
    if isinstance(value, dict):
        parsed = value
    elif isinstance(value, str) and value.strip():
        try:
            loaded = json.loads(value)
            if isinstance(loaded, dict):
                parsed = loaded
        except json.JSONDecodeError:
            parsed = {}
    scores: Dict[str, float] = {}
    total = 0.0
    for label in SENTIMENT_BUCKETS:
        raw = parsed.get(label)
        if raw is None and isinstance(parsed, dict):
            raw = parsed.get(label.lower()) or parsed.get(label.replace(" ", "_").lower())
        try:
            val = float(raw)
        except (TypeError, ValueError):
            val = 0.0
        safe = max(0.0, min(1.0, val))
        scores[label] = safe
        total += safe
    if total <= 0:
        scores = {label: (1.0 if label == "Neutral" else 0.0) for label in SENTIMENT_BUCKETS}
        total = 1.0
    normalized: Dict[str, float] = {}
    running_total = 0.0
    previous_label = SENTIMENT_BUCKETS[-1]
    for label in SENTIMENT_BUCKETS:
        fraction = scores[label] / total
        rounded = round(fraction, 4)
        normalized[label] = rounded
        running_total += rounded
        previous_label = label
    delta = round(1.0 - running_total, 4)
    normalized[previous_label] = round(normalized[previous_label] + delta, 4)
    return normalized


def _normalise_llm_payload(
    payload: Optional[Dict[str, Any]],
    *,
    contact_reason_original: str,
) -> Dict[str, Any]:
    data: Dict[str, Any] = dict(payload or {})
    summary = _truncate(_stringify(data.get("llm_summary_250")), MAX_SUMMARY_CHARS)
    data["llm_summary_250"] = summary

    problem_extract = data.get("problem_extract")
    if not problem_extract:
        problem_extract = data.get("extract_customer_probelm")
    problem_text = _truncate(_stringify(problem_extract), MAX_SUMMARY_CHARS)
    data["problem_extract"] = problem_text
    data["extract_customer_probelm"] = problem_text

    resolution_extract = _truncate(_stringify(data.get("resolution_extract")), MAX_SUMMARY_CHARS)
    resolution_extract = _limit_words(resolution_extract, 15)
    data["resolution_extract"] = resolution_extract.strip()

    improvement_tip = _truncate(_stringify(data.get("improvement_tip")), MAX_IMPROVEMENT_TIP_CHARS)
    data["improvement_tip"] = improvement_tip

    reason_override = _truncate(_stringify(data.get("reason_override_why")), MAX_REASON_CHARS)
    resolution_why = _truncate(_stringify(data.get("resolution_why")), MAX_REASON_CHARS)
    data["reason_override_why"] = reason_override
    data["resolution_why"] = resolution_why

    contact_reason = _stringify(data.get("contact_reason"))
    original_reason = contact_reason_original.strip()
    normalized_contact = contact_reason.lower().strip() if contact_reason else ""
    normalized_original = original_reason.lower().strip() if original_reason else ""

    # If the original was marked Duplicate, do not reclassify.
    if normalized_original == "duplicate":
        contact_reason = original_reason
        normalized_contact = normalized_original
        data["reason_override_why"] = ""

    contact_reason_change = _coerce_bool(data.get("contact_reason_change"))
    # Force to False when normalized reasons match
    if normalized_contact and normalized_original and normalized_contact == normalized_original:
        contact_reason_change = False
    elif contact_reason_change is None:
        if normalized_contact and normalized_original:
            contact_reason_change = normalized_contact != normalized_original
        else:
            contact_reason_change = bool(normalized_contact and not normalized_original)
    data["contact_reason"] = contact_reason
    data["contact_reason_change"] = bool(contact_reason_change)

    is_resolved_flag = _coerce_bool(data.get("is_resolved"))
    resolved_flag = is_resolved_flag
    if resolved_flag is None:
        resolved_flag = _coerce_bool(data.get("resolved"))
    if resolved_flag is None:
        resolved_flag = False
    data["is_resolved"] = resolved_flag
    data["resolved"] = resolved_flag

    steps_extract = _normalise_steps_field(data.get("steps_extract"))
    data["steps_extract"] = steps_extract

    timestamp_value = data.get("resolution_timestamp_iso") or data.get("resolution_timestamp")
    timestamp_iso = ""
    if timestamp_value:
        parsed_ts = parse_datetime(timestamp_value)
        if parsed_ts:
            timestamp_iso = parsed_ts.isoformat()
    data["resolution_timestamp_iso"] = timestamp_iso

    index_value = _coerce_int(data.get("resolution_message_index"))
    data["resolution_message_index"] = index_value if index_value and index_value > 0 else None

    sentiment_scores = _normalise_sentiment_scores(data.get("customer_sentiment_scores"))
    data["customer_sentiment_scores"] = sentiment_scores

    sentiment_primary = _stringify(data.get("customer_sentiment_primary"))
    if sentiment_primary not in SENTIMENT_BUCKETS:
        sentiment_primary = max(sentiment_scores.items(), key=lambda entry: entry[1])[0]
    data["customer_sentiment_primary"] = sentiment_primary

    agent_prof_flag = _coerce_bool(data.get("agent_profanity_detected"))
    data["agent_profanity_detected"] = (
        bool(agent_prof_flag) if agent_prof_flag is not None else None
    )
    agent_prof_count = _coerce_int(data.get("agent_profanity_count"))
    data["agent_profanity_count"] = max(0, agent_prof_count) if agent_prof_count is not None else None

    customer_abuse_flag = _coerce_bool(data.get("customer_abuse_detected"))
    data["customer_abuse_detected"] = (
        bool(customer_abuse_flag) if customer_abuse_flag is not None else None
    )
    customer_abuse_count = _coerce_int(data.get("customer_abuse_count"))
    data["customer_abuse_count"] = (
        max(0, customer_abuse_count) if customer_abuse_count is not None else None
    )

    agent_score = data.get("agent_score")
    if isinstance(agent_score, (int, float)) or (
        isinstance(agent_score, str) and agent_score.strip().isdigit()
    ):
        data["agent_score"] = agent_score
    customer_score = data.get("customer_score")
    if isinstance(customer_score, (int, float)) or (
        isinstance(customer_score, str) and customer_score.strip().isdigit()
    ):
        data["customer_score"] = customer_score

    conversation_rating = data.get("conversation_rating")
    if isinstance(conversation_rating, (int, float)) or (
        isinstance(conversation_rating, str) and conversation_rating.strip().isdigit()
    ):
        data["conversation_rating"] = conversation_rating

    return data


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
    "duration_to_resolution",
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
    "problem_extract",
    "resolution_extract",
    "steps_extract",
    "resolution_timestamp_iso",
    "resolution_message_index",
    "contact_reason",
    "contact_reason_original",
    "contact_reason_change",
    "reason_override_why",
    "resolution_why",
    "customer_sentiment_primary",
    "customer_sentiment_scores",
    "agent_profanity_detected",
    "agent_profanity_count",
    "customer_abuse_detected",
    "customer_abuse_count",
    "agent_score",
    "customer_score",
    "resolved",
    "is_resolved",
    "improvement_tip",
    "llm_model",
    "llm_input_tokens",
    "llm_output_tokens",
    "llm_cost_usd",
)


MODEL_PRICING: Dict[str, Dict[str, float]] = {
    # Pricing in USD per 1M tokens (rounded). Update when vendors publish new rates.
    "gpt-4o": {"input": 10.0, "output": 30.0},
    "gpt-4o-mini": {"input": 2.5, "output": 10.0},
    "gpt-4.1-nano": {"input": 0.20, "cached_input": 0.05, "output": 0.80},
    "gpt-4.1-nano-ft": {"input": 0.80, "cached_input": 0.20, "output": 3.20},
    "gpt-5-nano": {"input": 0.05, "cached_input": 0.005, "output": 0.40},
    "gpt-5-nano-ft": {"input": 0.25, "cached_input": 0.025, "output": 2.00},
    # GPT-5 placeholder tiers (update when official numbers are published)
    "gpt-5.0": {"input": 5.0, "output": 15.0},
    "gpt-5.0-mini": {"input": 2.0, "output": 6.0},
    "gpt-5.0-pro": {"input": 10.0, "output": 30.0},
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
        default="gpt-5-nano",
        help="Chat model identifier for LLM augmentation (default: gpt-5-nano).",
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
        "--concurrency",
        type=int,
        default=1,
        help="Maximum number of parallel LLM calls (default: 1).",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Print LLM prompts and responses for inspection.",
    )
    parser.add_argument(
        "--debug-prompts",
        choices=("none", "input", "output", "both"),
        default="none",
        help="Select which prompts to print for debugging (default: none).",
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


def estimate_cost(
    model: str,
    prompt_tokens: Optional[int],
    completion_tokens: Optional[int],
    cached_prompt_tokens: Optional[int] = None,
) -> Optional[float]:
    pricing = MODEL_PRICING.get(model)
    if not pricing or prompt_tokens is None or completion_tokens is None:
        return None
    input_rate = pricing.get("input")
    output_rate = pricing.get("output")
    cached_rate = pricing.get("cached_input", input_rate)
    if input_rate is None or output_rate is None:
        return None
    cached_tokens = min(max(cached_prompt_tokens or 0, 0), prompt_tokens)
    normal_prompt_tokens = prompt_tokens - cached_tokens
    cost = (normal_prompt_tokens / 1_000_000.0) * input_rate
    if cached_rate:
        cost += (cached_tokens / 1_000_000.0) * cached_rate
    else:
        cost += (cached_tokens / 1_000_000.0) * input_rate
    cost += (completion_tokens / 1_000_000.0) * output_rate
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

    pending_customer_ts: Optional[datetime] = None

    for comment in comments:
        if comment.role == "agent":
            if comment.timestamp and pending_customer_ts:
                delta = minutes_between(pending_customer_ts, comment.timestamp)
                if delta >= 0:
                    agent_deltas.append(delta)
                    if first_agent_response_minutes is None:
                        first_agent_response_minutes = delta
                pending_customer_ts = None
                last_agent_time = comment.timestamp
            elif comment.timestamp:
                last_agent_time = comment.timestamp
            agent_profanity_count += count_term_hits(comment.text, PROFANITY_TERMS)
            if comment.author:
                agent_authors_set.add(comment.author)
        elif comment.role == "customer":
            if comment.timestamp and last_agent_time:
                delta = minutes_between(last_agent_time, comment.timestamp)
                customer_deltas.append(delta)
            if comment.timestamp:
                if pending_customer_ts is None:
                    pending_customer_ts = comment.timestamp
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
        Review the conversation above and respond with a SINGLE JSON object that satisfies the schema below.

        Task sequence (complete all steps):
        1. Compare the customer's stated problem to the agent's classification. If the original contact reason is "Duplicate", keep contact_reason="Duplicate" and contact_reason_change=false. Otherwise, set contact_reason_change=true when your chosen contact_reason differs from the original, and explain the override using literal phrases or timestamps from the transcript.
        2. Decide whether the conversation is resolved. Set both resolved and is_resolved accordingly, and write resolution_why that cites the agent or customer action that proves the outcome (or why it failed).
        3. Provide one-sentence summaries:
           a. problem_extract – concise but specific customer problem (<=250 chars). Mention concrete damage, location, or outage cause.
           b. resolution_extract – outcome in <15 words explaining how it was solved or why open.
        4. List chronological agent actions that moved the ticket forward in steps_extract (array of short strings, earliest first, max 8 entries).
        5. Identify the message where the issue was resolved (customer confirmation or decisive agent fix). Populate resolution_timestamp_iso (ISO 8601) and resolution_message_index (1-based transcript index). Use null for both when unresolved.
        6. Produce customer sentiment:
           - customer_sentiment_primary must be one of: Delight, Convenience, Trust, Frustration, Disappointment, Concern, Hostility, Neutral.
           - customer_sentiment_scores is an object with those eight keys. Values are floats between 0 and 1 that sum to ~1.00 (±0.02 tolerance).
        7. Generate llm_summary_250 (<=250 chars), conversation_rating/agent_score/customer_score (integers 1-5), improvement_tip (<=200 chars, actionable).
        8. Detect abuse and profanity: set agent_profanity_detected / agent_profanity_count (agent side) and customer_abuse_detected / customer_abuse_count (customer side). Only count explicit insults, slurs, or profanity pointed at the counterpart/company.

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

        Additional instructions:
        - Quote short phrases (e.g., "customer: bike stuck at finish screen") inside reason_override_why and resolution_why to justify decisions.
        - steps_extract should only describe agent actions or system fixes that move toward resolution; omit chit-chat.
        - When unresolved, explain the blocker inside resolution_why and set both resolution_timestamp_iso and resolution_message_index to null.
        - Make resolution_extract under 15 words; problem_extract must stay concise yet include the concrete issue details (what broke, which dock, which outage cause, etc.).
        - If profanity/abuse counts differ from transcript reality, explain briefly in resolution_why.
        - Keep tone factual and manager-ready. Return STRICT JSON only—no Markdown or extra commentary.
        - Scoring scale for conversation_rating, agent_score, and customer_score: 1=Very poor, 2=Poor, 3=Adequate, 4=Good, 5=Excellent.

        Detailed scoring guidance:
        CONVERSATION_RATING
        • Primary signals: resolved flag, sentiment at end, proof of closure, avoidable effort.
        • 5 → resolved=true AND resolution_timestamp_iso provided AND customer_sentiment_primary in {Delight, Convenience, Trust}.
        • 4 → resolved=true AND customer_sentiment_primary in {Neutral} OR clear shift from Frustration to Neutral; only minor avoidable effort.
        • 3 → unresolved BUT a clear next step is agreed and no harm done; neutral tone.
        • 2 → unresolved AND misclassification left uncorrected OR long back-and-forth with little progress.
        • 1 → incorrect/unsafe guidance, policy breach, or hostility escalation.

        AGENT_SCORE
        • Primary signals: correct diagnosis/classification, useful actions, ownership, clarity.
        • 5 → correct contact_reason or justified override; at least two concrete steps_extract; delivers fix or definitive path; clear instructions.
        • 4 → small miss but corrected; steps_extract present; only minor clarity gaps.
        • 3 → some helpful action but partial or vague; missed one key step.
        • 2 → wrong or uncorrected classification OR speculative help with low action density.
        • 1 → harmful, rude, vulgar, or no actionable help.

        CUSTOMER_SCORE
        • Primary signals: final customer message, sentiment curve, explicit thanks/relief.
        • 5 → explicit positive closure (“works now,” “thanks!”) or Delight/Trust sentiment at the end.
        • 4 → polite thanks without enthusiasm; Neutral at the end.
        • 3 → neutral acceptance (“ok,” “I’ll try”) without closure proof.
        • 2 → lingering doubt, mild Frustration/Concern, or abandonment.
        • 1 → Hostility/Disappointment or vulgar/profane language directed at the agent/company (swearing acceptable only when describing the issue itself).
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


def _coerce_output_blocks(response: Any) -> List[Any]:
    candidate = None
    if hasattr(response, "output"):
        candidate = getattr(response, "output", None)
    if candidate is None and isinstance(response, dict):
        candidate = response.get("output")
    if candidate is None and hasattr(response, "model_dump"):
        try:
            dumped = response.model_dump()
            if isinstance(dumped, dict):
                candidate = dumped.get("output")
        except Exception:
            candidate = None
    if not isinstance(candidate, list):
        return []
    return candidate


def _extract_text_from_content_item(content: Any) -> Optional[str]:
    if content is None:
        return None
    if isinstance(content, str):
        text = content.strip()
        return text or None
    if isinstance(content, dict):
        text = content.get("text")
        if isinstance(text, str) and text.strip():
            return text.strip()
        if isinstance(text, dict):
            value = text.get("value")
            if isinstance(value, str) and value.strip():
                return value.strip()
        value = content.get("value")
        if isinstance(value, str) and value.strip():
            return value.strip()
        if content.get("type") == "output_text":
            val = content.get("text")
            if isinstance(val, dict):
                inner = val.get("value")
                if isinstance(inner, str) and inner.strip():
                    return inner.strip()
            elif isinstance(val, str) and val.strip():
                return val.strip()
    text_attr = getattr(content, "text", None)
    if isinstance(text_attr, str) and text_attr.strip():
        return text_attr.strip()
    value_attr = getattr(content, "value", None)
    if isinstance(value_attr, str) and value_attr.strip():
        return value_attr.strip()
    return None


def extract_text_from_responses(response: Any) -> str:
    segments: List[str] = []
    try:
        for block in _coerce_output_blocks(response):
            contents = getattr(block, "content", None)
            if contents is None and isinstance(block, dict):
                contents = block.get("content")
            if isinstance(contents, list):
                for entry in contents:
                    text = _extract_text_from_content_item(entry)
                    if text:
                        segments.append(text)
            else:
                text = _extract_text_from_content_item(contents)
                if text:
                    segments.append(text)
            if not contents and isinstance(block, dict):
                summary_entries = block.get("summary")
                if isinstance(summary_entries, list):
                    for entry in summary_entries:
                        text = _extract_text_from_content_item(entry)
                        if text:
                            segments.append(text)
        if segments:
            return "\n".join(segments)
        if hasattr(response, "output_text"):
            text_value = getattr(response, "output_text")
            if isinstance(text_value, str):
                return text_value
        if isinstance(response, dict):
            for key in ("output_text", "text"):
                candidate = response.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    return candidate.strip()
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
                        "llm_summary_250": {"type": "string", "maxLength": MAX_SUMMARY_CHARS},
                        "conversation_rating": {"type": "integer", "minimum": 1, "maximum": 5},
                        "extract_customer_probelm": {"type": "string", "maxLength": MAX_SUMMARY_CHARS},
                        "problem_extract": {"type": "string", "maxLength": MAX_SUMMARY_CHARS},
                        "resolution_extract": {"type": "string", "maxLength": MAX_SUMMARY_CHARS},
                        "contact_reason": {"type": "string"},
                        "contact_reason_change": {"type": "boolean"},
                        "reason_override_why": {"type": "string", "maxLength": MAX_REASON_CHARS},
                        "agent_score": {"type": "integer", "minimum": 1, "maximum": 5},
                        "customer_score": {"type": "integer", "minimum": 1, "maximum": 5},
                        "resolved": {"type": "boolean"},
                        "is_resolved": {"type": "boolean"},
                        "resolution_why": {"type": "string", "maxLength": MAX_REASON_CHARS},
                        "steps_extract": {
                            "type": "array",
                            "items": {"type": "string", "maxLength": MAX_REASON_CHARS},
                            "maxItems": MAX_STEPS,
                        },
                        "resolution_timestamp_iso": {
                            "anyOf": [
                                {"type": "string", "format": "date-time"},
                                {"type": "null"},
                            ]
                        },
                        "resolution_message_index": {
                            "anyOf": [
                                {"type": "integer", "minimum": 1},
                                {"type": "null"},
                            ]
                        },
                        "customer_sentiment_primary": {"type": "string", "enum": list(SENTIMENT_BUCKETS)},
                        "customer_sentiment_scores": {
                            "type": "object",
                            "properties": {
                                label: {"type": "number", "minimum": 0, "maximum": 1}
                                for label in SENTIMENT_BUCKETS
                            },
                            "required": list(SENTIMENT_BUCKETS),
                            "additionalProperties": False,
                        },
                        "agent_profanity_detected": {"type": "boolean"},
                        "agent_profanity_count": {"type": "integer", "minimum": 0},
                        "customer_abuse_detected": {"type": "boolean"},
                        "customer_abuse_count": {"type": "integer", "minimum": 0},
                        "improvement_tip": {"type": "string", "maxLength": MAX_IMPROVEMENT_TIP_CHARS},
                    },
                    "required": [
                        "llm_summary_250",
                        "conversation_rating",
                        "extract_customer_probelm",
                        "problem_extract",
                        "resolution_extract",
                        "contact_reason",
                        "contact_reason_change",
                        "reason_override_why",
                        "agent_score",
                        "customer_score",
                        "resolved",
                        "is_resolved",
                        "resolution_why",
                        "steps_extract",
                        "resolution_timestamp_iso",
                        "resolution_message_index",
                        "customer_sentiment_primary",
                        "customer_sentiment_scores",
                        "agent_profanity_detected",
                        "agent_profanity_count",
                        "customer_abuse_detected",
                        "customer_abuse_count",
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
    debug_input: bool = False,
    debug_output: bool = False,
) -> Tuple[Optional[Dict[str, Any]], Optional[int], Optional[int], Optional[str]]:
    if openai_client is None:
        return None, None, None, None

    if debug_input:
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

    if debug_output:
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
        "duration_to_resolution": "",
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
        "problem_extract": "",
        "resolution_extract": "",
        "steps_extract": "[]",
        "resolution_timestamp_iso": "",
        "resolution_message_index": "",
        "contact_reason": "",
        "contact_reason_original": contact_reason_original,
        "contact_reason_change": "",
        "reason_override_why": "",
        "resolution_why": "",
        "customer_sentiment_primary": "",
        "customer_sentiment_scores": "",
        "agent_profanity_detected": "",
        "agent_profanity_count": "",
        "customer_abuse_detected": "",
        "customer_abuse_count": "",
        "agent_score": "",
        "customer_score": "",
        "resolved": "",
        "is_resolved": "",
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

    normalized_llm = _normalise_llm_payload(llm_payload, contact_reason_original=contact_reason_original)

    row["llm_summary_250"] = normalized_llm.get("llm_summary_250", "")
    rating = normalized_llm.get("conversation_rating")
    row["conversation_rating"] = str(rating).strip() if rating is not None else ""

    problem_extract = normalized_llm.get("problem_extract", "")
    row["problem_extract"] = problem_extract
    row["resolution_extract"] = normalized_llm.get("resolution_extract", "")

    row["contact_reason"] = str(normalized_llm.get("contact_reason", "")).strip()
    row["contact_reason_change"] = "true" if normalized_llm.get("contact_reason_change") else "false"
    reason_override = normalized_llm.get("reason_override_why", "")
    row["reason_override_why"] = reason_override
    row["resolution_why"] = normalized_llm.get("resolution_why", "")

    steps_value = normalized_llm.get("steps_extract", [])
    if not isinstance(steps_value, list):
        steps_value = _normalise_steps_field(steps_value)
    row["steps_extract"] = json.dumps(steps_value)

    resolution_timestamp_iso = normalized_llm.get("resolution_timestamp_iso") or ""
    row["resolution_timestamp_iso"] = resolution_timestamp_iso

    duration_to_resolution = ""
    if resolution_timestamp_iso and metrics.conversation_start:
        resolved_dt = parse_datetime(resolution_timestamp_iso)
        if resolved_dt and metrics.conversation_start:
            minutes = minutes_between(metrics.conversation_start, resolved_dt)
            if minutes >= 0:
                duration_to_resolution = format_minutes(minutes)
    row["duration_to_resolution"] = duration_to_resolution

    resolution_index = normalized_llm.get("resolution_message_index")
    row["resolution_message_index"] = str(resolution_index) if resolution_index is not None else ""

    row["agent_score"] = str(normalized_llm.get("agent_score", "")).strip()
    row["customer_score"] = str(normalized_llm.get("customer_score", "")).strip()

    resolved_flag = normalized_llm.get("resolved")
    row["resolved"] = "true" if resolved_flag else "false"
    row["is_resolved"] = row["resolved"]

    row["improvement_tip"] = normalized_llm.get("improvement_tip", "")

    sentiment_primary = normalized_llm.get("customer_sentiment_primary", "")
    row["customer_sentiment_primary"] = sentiment_primary
    sentiment_scores = normalized_llm.get("customer_sentiment_scores", {})
    row["customer_sentiment_scores"] = json.dumps(sentiment_scores)

    agent_prof_flag = normalized_llm.get("agent_profanity_detected")
    if isinstance(agent_prof_flag, bool):
        row["agent_profanity_detected"] = "true" if agent_prof_flag else "false"
    else:
        row["agent_profanity_detected"] = "true" if metrics.agent_profanity_count > 0 else "false"

    agent_prof_count = normalized_llm.get("agent_profanity_count")
    if isinstance(agent_prof_count, int) and agent_prof_count >= 0:
        row["agent_profanity_count"] = str(agent_prof_count)
    else:
        row["agent_profanity_count"] = str(metrics.agent_profanity_count)

    customer_abuse_flag = normalized_llm.get("customer_abuse_detected")
    if isinstance(customer_abuse_flag, bool):
        row["customer_abuse_detected"] = "true" if customer_abuse_flag else "false"
    else:
        row["customer_abuse_detected"] = "true" if metrics.customer_abuse_count > 0 else "false"

    customer_abuse_count = normalized_llm.get("customer_abuse_count")
    if isinstance(customer_abuse_count, int) and customer_abuse_count >= 0:
        row["customer_abuse_count"] = str(customer_abuse_count)
    else:
        row["customer_abuse_count"] = str(metrics.customer_abuse_count)
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
    concurrency: int,
    debug_prompts: str,
    verbose: bool,
    resume: bool,
    payload_dir: Optional[Path],
) -> Tuple[int, int, float]:
    adjusted_temperature: Optional[float] = temperature
    if use_llm and not model_supports_temperature(model):
        adjusted_temperature = None
    concurrency = max(1, concurrency)

    fieldnames = list(CSV_FIELDS)
    ensure_header(output_path, fieldnames)
    skip_issue_keys = load_existing_issue_keys(output_path) if resume else set()

    total_prompt_tokens = 0
    total_completion_tokens = 0
    total_cost_usd = 0.0

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
    show_prompt_input = debug_prompts in {"input", "both"}
    show_prompt_output = debug_prompts in {"output", "both"}

    iterator = load_jsonl(input_path, max_conversations)
    progress = tqdm(
        total=total_records if total_records else None,
        desc="Processing conversations",
        unit="conversation",
    )
    if payload_dir:
        payload_dir.mkdir(parents=True, exist_ok=True)

    use_parallel = should_call_llm and concurrency > 1
    executor = ThreadPoolExecutor(max_workers=concurrency) if use_parallel else None
    futures_map: Dict[Any, int] = {}
    pending_results: Dict[int, Dict[str, Any]] = {}
    next_result_index = 1
    job_sequence = 0

    def execute_job(job: Dict[str, Any]) -> Dict[str, Any]:
        record = job["record"]
        metrics = job["metrics"]
        comments = job["comments"]
        issue_key = job["issue_key"]
        llm_payload: Optional[Dict[str, Any]] = None
        prompt_tokens: Optional[int] = None
        completion_tokens: Optional[int] = None
        cost_usd: Optional[float] = None
        error_msg: Optional[str] = None
        reasoning_tokens = 0

        if job["should_call_llm"] and comments:
            llm_payload, prompt_tokens, completion_tokens, error_msg = call_llm(
                openai_client=job["openai_client"],
                model=job["model"],
                temperature=job["temperature"],
                max_completion_tokens=job["max_output_tokens"],
                system_prompt=job["system_prompt"],
                user_prompt=job["user_prompt"],
                debug=job["debug"],
                debug_input=job["show_prompt_input"],
                debug_output=job["show_prompt_output"],
            )
            cost_usd = estimate_cost(job["model"], prompt_tokens, completion_tokens)
            if isinstance(llm_payload, dict) and "_reasoning_tokens" in llm_payload:
                try:
                    reasoning_tokens = int(llm_payload["_reasoning_tokens"] or 0)
                except Exception:
                    reasoning_tokens = 0
            if job["debug"] and job["should_call_llm"]:
                print(
                    f"[debug] tokens prompt={prompt_tokens or 0} completion={completion_tokens or 0} "
                    f"cost=${cost_usd or 0.0:.6f}"
                )
            if error_msg and job["debug"] and not llm_payload:
                print(f"[debug] LLM note: {error_msg}")
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
            job["model"] if job["should_call_llm"] else "",
            prompt_tokens,
            completion_tokens,
            cost_usd,
        )

        return {
            "job_index": job["job_index"],
            "issue_key": issue_key,
            "row": row,
            "llm_payload": llm_payload,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "reasoning_tokens": reasoning_tokens,
            "cost_usd": cost_usd,
            "metrics": metrics,
            "should_call_llm": job["should_call_llm"],
            "no_llm_response": job["should_call_llm"] and llm_payload is None,
        }

    def handle_result(result: Dict[str, Any]) -> None:
        nonlocal processed, total_prompt_tokens, total_completion_tokens, total_cost_usd
        append_row(output_path, fieldnames, result["row"])
        processed += 1
        progress.update(1)
        issue_key_local = result["issue_key"]
        skip_issue_keys.add(issue_key_local)

        if result["should_call_llm"]:
            if result["prompt_tokens"] is not None:
                total_prompt_tokens += result["prompt_tokens"] or 0
            if result["completion_tokens"] is not None:
                total_completion_tokens += result["completion_tokens"] or 0
            if result["cost_usd"] is not None:
                total_cost_usd += result["cost_usd"] or 0.0
        if debug and result["no_llm_response"]:
            progress.write(f"[debug] No parsed LLM response for {issue_key_local}; check raw output above.")

        if verbose:
            rating_info = ""
            tokens_info = ""
            cost_info = ""
            llm_payload = result["llm_payload"]
            if isinstance(llm_payload, dict):
                rating = llm_payload.get("conversation_rating")
                if rating not in (None, ""):
                    rating_info = f" rating={rating}"
            if result["should_call_llm"]:
                ct = result["completion_tokens"] or 0
                tokens_info = f" tokens={ct} (reasoning {result['reasoning_tokens']})"
                if result["cost_usd"] is not None:
                    cost_info = f" cost=${total_cost_usd:.6f}"
            metrics = result["metrics"]
            metrics_summary = (
                f"messages={metrics.messages_total} turns={metrics.turns} "
                f"duration={format_minutes(metrics.duration_minutes) or 'n/a'}"
            )
            progress.write(
                f"Processed {processed}/{total_records or processed}: {issue_key_local} | {metrics_summary}"
                f"{rating_info}{tokens_info}{cost_info}"
            )

    def drain_futures(force: bool = False) -> None:
        nonlocal next_result_index
        if not futures_map:
            return
        wait_kwargs: Dict[str, Any] = {}
        if not force:
            wait_kwargs["return_when"] = FIRST_COMPLETED
        done, _ = wait(list(futures_map.keys()), **wait_kwargs)
        for fut in done:
            job_idx = futures_map.pop(fut)
            pending_results[job_idx] = fut.result()
        while next_result_index in pending_results:
            handle_result(pending_results.pop(next_result_index))
            next_result_index += 1

    for record in iterator:
        issue_key = str(record.get("issue_key", ""))
        if issue_key in skip_issue_keys:
            skipped += 1
            if verbose:
                progress.write(f"[skip] {issue_key} already present in {output_path.name}")
            progress.update(1)
            continue

        raw_comments = record.get("comments") or []
        if not isinstance(raw_comments, list):
            raw_comments = []
        comments = parse_comments(raw_comments)
        metrics = compute_metrics(comments)
        transcript = build_transcript(comments)
        system_prompt, user_prompt = build_llm_prompts(record, metrics, transcript, taxonomy)

        if payload_dir:
            safe_issue = re.sub(r"[^A-Za-z0-9_-]", "_", issue_key or "job")
            payload_path = payload_dir / f"payload_{processed + skipped + 1:04d}_{model.replace('.', '_')}_{safe_issue}.json"
            payload = {
                "model": model,
                "temperature": adjusted_temperature,
                "max_completion_tokens": max_output_tokens,
                "system_prompt": system_prompt,
                "user_prompt": user_prompt,
            }
            payload_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            if verbose:
                progress.write(f"[payload] wrote {payload_path}")

        job_sequence += 1
        job_data = {
            "job_index": job_sequence,
            "record": record,
            "issue_key": issue_key,
            "comments": comments,
            "metrics": metrics,
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "model": model,
            "temperature": adjusted_temperature,
            "max_output_tokens": max_output_tokens,
            "should_call_llm": should_call_llm,
            "openai_client": openai_client,
            "debug": debug,
            "show_prompt_input": show_prompt_input,
            "show_prompt_output": show_prompt_output,
        }

        if executor:
            future = executor.submit(execute_job, job_data)
            futures_map[future] = job_sequence
            if len(futures_map) >= concurrency:
                drain_futures()
        else:
            result = execute_job(job_data)
            handle_result(result)
            next_result_index += 1

    if executor:
        drain_futures(force=True)
        executor.shutdown(wait=True)

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

    debug_prompts_choice = args.debug_prompts or "none"
    if args.debug and debug_prompts_choice == "none":
        debug_prompts_choice = "both"

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
            concurrency=args.concurrency,
            debug_prompts=debug_prompts_choice,
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
