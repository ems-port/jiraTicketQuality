#!/usr/bin/env python3
"""Process prepared Jira conversations and store quality metrics in Supabase."""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set

from dateutil import parser as dt_parser
from dotenv import load_dotenv
from postgrest import APIError
from supabase import Client, create_client

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analysis import convo_quality as cq  # type: ignore  # noqa: E402

try:
    import psycopg  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    psycopg = None  # type: ignore

load_dotenv(override=False)


def extract_error_code(error: Any) -> Optional[str]:
    if not error:
        return None
    if isinstance(error, dict):
        return error.get("code")
    return getattr(error, "code", None)


def resolve_default_model() -> str:
    explicit = os.getenv("PORT_CONVO_MODEL")
    if explicit:
        return explicit
    if os.getenv("VERCEL") == "1":
        return "gpt-4o-mini"
    return "gpt-5-nano"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pull prepared Jira conversations from Supabase, run convo quality, and persist the results."
    )
    parser.add_argument("--limit", type=int, default=200, help="Max number of conversations to process.")
    parser.add_argument(
        "--model",
        default=resolve_default_model(),
        help="LLM model identifier (local builds default to gpt-5-nano).",
    )
    parser.add_argument("--temperature", type=float, default=0.2, help="LLM temperature (if supported by model).")
    parser.add_argument("--max-output-tokens", type=int, default=8000, help="LLM max completion tokens.")
    parser.add_argument("--taxonomy-file", help="Optional JSON file with contact taxonomy labels.")
    parser.add_argument("--no-llm", action="store_true", help="Skip LLM calls; heuristic fields only.")
    parser.add_argument(
        "--prepared-table",
        default=os.getenv("SUPABASE_JIRA_PREPARED_TABLE", "jira_prepared_conversations"),
        help="Supabase table containing prepared payloads.",
    )
    parser.add_argument(
        "--processed-table",
        default=os.getenv("SUPABASE_JIRA_PROCESSED_TABLE", "jira_processed_conversations"),
        help="Supabase table to store processed results.",
    )
    parser.add_argument("--log-level", default="INFO", help="Logging level (DEBUG, INFO, ...).")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=12,
        help="Number of parallel threads for LLM processing (default: 12).",
    )
    parser.add_argument("--dry-run", action="store_true", help="Compute results but do not write to Supabase.")
    return parser.parse_args()


@dataclass
class ProcessorConfig:
    supabase_url: str
    supabase_key: str
    prepared_table: str
    processed_table: str
    limit: int
    model: str
    temperature: float
    max_output_tokens: int
    taxonomy_file: Optional[str]
    use_llm: bool
    dry_run: bool
    concurrency: int


class ConversationProcessingError(Exception):
    """Raised when the LLM conversation processing fails."""


MAX_CONSECUTIVE_FAILURES = 3
MAX_ATTEMPTS_PER_ISSUE = 2

class SupabaseConversationStore:
    def __init__(self, *, url: str, key: str, prepared_table: str, processed_table: str) -> None:
        self.client: Client = create_client(url, key)
        self.prepared_table = prepared_table
        self.processed_table = processed_table
        self.log = logging.getLogger(self.__class__.__name__)

    def fetch_processed_keys(self) -> Set[str]:
        keys: Set[str] = set()
        start = 0
        page = 500
        while True:
            try:
                resp = (
                    self.client.table(self.processed_table)
                    .select("issue_key")
                    .range(start, start + page - 1)
                    .execute()
                )
            except APIError as exc:
                if extract_error_code(exc) in {"42P01", "PGRST205"}:
                    return set()
                raise
            data = resp.data or []
            for row in data:
                key = (row.get("issue_key") or "").strip()
                if key:
                    keys.add(key)
            if len(data) < page:
                break
            start += page
        return keys

    def fetch_prepared(self, limit: int, skip_keys: Set[str]) -> List[Dict[str, Any]]:
        collected: List[Dict[str, Any]] = []
        start = 0
        page = 200
        while len(collected) < limit:
            try:
                resp = (
                    self.client.table(self.prepared_table)
                    .select("issue_key,payload,merge_context_size_tokens,prepared_at,processed")
                    .eq("processed", False)
                    .order("issue_key", desc=False)
                    .range(start, start + page - 1)
                    .execute()
                )
            except APIError as exc:
                if extract_error_code(exc) in {"42P01", "PGRST205"}:
                    self.log.info("Prepared table not found; nothing to process.")
                    return []
                raise
            data = resp.data or []
            if not data:
                break
            for row in data:
                issue_key = (row.get("issue_key") or "").strip()
                if not issue_key or issue_key in skip_keys:
                    continue
                payload = row.get("payload") or {}
                if not isinstance(payload, dict):
                    continue
                collected.append({
                    "issue_key": issue_key,
                    "payload": payload,
                    "merge_context_size_tokens": row.get("merge_context_size_tokens"),
                })
                if len(collected) >= limit:
                    break
            start += page
        return collected

    def upsert_processed(self, rows: List[Dict[str, Any]]) -> None:
        if not rows:
            return
        resp = self.client.table(self.processed_table).upsert(rows, on_conflict="issue_key").execute()
        if getattr(resp, "error", None):
            raise RuntimeError(f"Supabase processed upsert failed: {resp.error}")

    def mark_prepared_processed(self, issue_keys: List[str]) -> None:
        if not issue_keys:
            return
        chunk = 100
        for i in range(0, len(issue_keys), chunk):
            batch = issue_keys[i : i + chunk]
            resp = (
                self.client.table(self.prepared_table)
                .update({"processed": True})
                .in_("issue_key", batch)
                .execute()
            )
            if getattr(resp, "error", None):
                raise RuntimeError(f"Supabase prepared update failed: {resp.error}")


def to_bool(value: str) -> Optional[bool]:
    text = (value or "").strip().lower()
    if not text:
        return None
    if text in {"true", "t", "1", "yes", "y"}:
        return True
    if text in {"false", "f", "0", "no", "n"}:
        return False
    return None


def to_int(value: str) -> Optional[int]:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def to_float(value: str) -> Optional[float]:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def to_timestamp(value: str) -> Optional[str]:
    if not value:
        return None
    dt = cq.parse_datetime(value)
    if not dt:
        try:
            dt = dt_parser.isoparse(value)
        except Exception:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.now().astimezone().tzinfo)
    return dt.astimezone().isoformat()


def parse_json_field(value: str) -> Optional[Any]:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


PROCESSED_TABLE_DDL = """
create table if not exists public.jira_processed_conversations (
    issue_key text primary key,
    status text,
    resolution text,
    custom_field_hub text,
    conversation_start timestamptz,
    conversation_end timestamptz,
    duration_minutes double precision,
    duration_to_resolution double precision,
    first_agent_response_minutes double precision,
    avg_agent_response_minutes double precision,
    avg_customer_response_minutes double precision,
    messages_total integer,
    messages_agent integer,
    messages_customer integer,
    turns integer,
    agent_authors text,
    customer_authors text,
    initial_response_sla_5m boolean,
    initial_response_sla_15m boolean,
    agent_profanity_detected boolean,
    agent_profanity_count integer,
    customer_abuse_detected boolean,
    customer_abuse_count integer,
    llm_summary_250 text,
    conversation_rating text,
    problem_extract text,
    resolution_extract text,
    steps_extract jsonb,
    resolution_timestamp_iso timestamptz,
    resolution_message_index integer,
    contact_reason text,
    contact_reason_original text,
    contact_reason_change boolean,
    reason_override_why text,
    resolution_why text,
    customer_sentiment_primary text,
    customer_sentiment_scores jsonb,
    agent_score double precision,
    customer_score double precision,
    resolved boolean,
    is_resolved boolean,
    improvement_tip text,
    llm_model text,
    llm_input_tokens integer,
    llm_output_tokens integer,
    llm_cost_usd double precision,
    processed_at timestamptz not null default timezone('utc', now())
);
"""


def row_to_record(row: Dict[str, str]) -> Dict[str, Any]:
    return {
        "issue_key": row.get("issue_key") or None,
        "status": row.get("status") or None,
        "resolution": row.get("resolution") or None,
        "custom_field_hub": row.get("custom_field_hub") or None,
        "conversation_start": to_timestamp(row.get("conversation_start", "")),
        "conversation_end": to_timestamp(row.get("conversation_end", "")),
        "duration_minutes": to_float(row.get("duration_minutes", "")),
        "duration_to_resolution": to_float(row.get("duration_to_resolution", "")),
        "first_agent_response_minutes": to_float(row.get("first_agent_response_minutes", "")),
        "avg_agent_response_minutes": to_float(row.get("avg_agent_response_minutes", "")),
        "avg_customer_response_minutes": to_float(row.get("avg_customer_response_minutes", "")),
        "messages_total": to_int(row.get("messages_total", "")),
        "messages_agent": to_int(row.get("messages_agent", "")),
        "messages_customer": to_int(row.get("messages_customer", "")),
        "turns": to_int(row.get("turns", "")),
        "agent_authors": row.get("agent_authors") or None,
        "customer_authors": row.get("customer_authors") or None,
        "initial_response_sla_5m": to_bool(row.get("initial_response_sla_5m", "")),
        "initial_response_sla_15m": to_bool(row.get("initial_response_sla_15m", "")),
        "agent_profanity_detected": to_bool(row.get("agent_profanity_detected", "")),
        "agent_profanity_count": to_int(row.get("agent_profanity_count", "")),
        "customer_abuse_detected": to_bool(row.get("customer_abuse_detected", "")),
        "customer_abuse_count": to_int(row.get("customer_abuse_count", "")),
        "llm_summary_250": row.get("llm_summary_250") or None,
        "conversation_rating": row.get("conversation_rating") or None,
        "problem_extract": row.get("problem_extract") or None,
        "resolution_extract": row.get("resolution_extract") or None,
        "steps_extract": parse_json_field(row.get("steps_extract", "")),
        "resolution_timestamp_iso": to_timestamp(row.get("resolution_timestamp_iso", "")),
        "resolution_message_index": to_int(row.get("resolution_message_index", "")),
        "contact_reason": row.get("contact_reason") or None,
        "contact_reason_original": row.get("contact_reason_original") or None,
        "contact_reason_change": to_bool(row.get("contact_reason_change", "")),
        "reason_override_why": row.get("reason_override_why") or None,
        "resolution_why": row.get("resolution_why") or None,
        "customer_sentiment_primary": row.get("customer_sentiment_primary") or None,
        "customer_sentiment_scores": parse_json_field(row.get("customer_sentiment_scores", "")),
        "agent_score": to_float(row.get("agent_score", "")),
        "customer_score": to_float(row.get("customer_score", "")),
        "resolved": to_bool(row.get("resolved", "")),
        "is_resolved": to_bool(row.get("is_resolved", "")),
        "improvement_tip": row.get("improvement_tip") or None,
        "llm_model": row.get("llm_model") or None,
        "llm_input_tokens": to_int(row.get("llm_input_tokens", "")),
        "llm_output_tokens": to_int(row.get("llm_output_tokens", "")),
        "llm_cost_usd": to_float(row.get("llm_cost_usd", "")),
    }


def _process_payload_worker(
    payload: Dict[str, Any],
    config: ProcessorConfig,
    openai_client: Optional[tuple[str, Any]],
    taxonomy: Sequence[str],
    max_attempts: int,
) -> tuple[str, Dict[str, Any]]:
    # Introduce a small randomized delay to reduce simultaneous API calls.
    time.sleep(random.uniform(0, 0.5))
    issue_key = (payload.get("issue_key") or "").strip()
    if not issue_key:
        raise ConversationProcessingError("Payload missing issue_key.")
    temperature = config.temperature if cq.model_supports_temperature(config.model) else None
    last_error: Optional[Exception] = None
    for _ in range(max_attempts):
        try:
            row = process_record(
                payload,
                model=config.model,
                temperature=temperature,
                max_output_tokens=config.max_output_tokens,
                openai_client=openai_client,
                taxonomy=taxonomy,
                use_llm=config.use_llm,
            )
            record = row_to_record(row)
            record["issue_key"] = issue_key
            return issue_key, record
        except ConversationProcessingError as exc:
            last_error = exc
        except Exception as exc:
            last_error = exc
    if isinstance(last_error, ConversationProcessingError):
        raise last_error
    raise ConversationProcessingError(str(last_error) if last_error else "LLM processing failed")


def ensure_processed_table(db_url: Optional[str]) -> None:
    if not db_url:
        return
    if psycopg is None:
        logging.warning("psycopg not installed; cannot run processed table DDL even though SUPABASE_DB_URL is set.")
        return
    try:
        with psycopg.connect(db_url, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(PROCESSED_TABLE_DDL)
        logging.info("Ensured jira_processed_conversations exists (if missing it has been created).")
    except Exception as exc:  # pragma: no cover - optional path
        logging.warning("Unable to run processed table DDL: %s", exc)


def process_record(
    payload: Dict[str, Any],
    *,
    model: str,
    temperature: Optional[float],
    max_output_tokens: int,
    openai_client: Optional[tuple[str, Any]],
    taxonomy: Sequence[str],
    use_llm: bool,
) -> Dict[str, str]:
    comments_raw = payload.get("comments") or []
    comments = cq.parse_comments(comments_raw if isinstance(comments_raw, list) else [])
    metrics = cq.compute_metrics(comments)
    transcript = cq.build_transcript(comments)
    system_prompt, user_prompt = cq.build_llm_prompts(payload, metrics, transcript, taxonomy)

    llm_payload: Optional[Dict[str, Any]] = None
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    cost_usd: Optional[float] = None

    if use_llm:
        if not comments:
            raise ConversationProcessingError("Conversation has no comments; cannot run LLM.")
        issue_key = (
            payload.get("issue_key")
            or payload.get("issueKey")
            or payload.get("key")
            or payload.get("name")
        )
        llm_payload, prompt_tokens, completion_tokens, error_msg = cq.call_llm(
            openai_client=openai_client,
            model=model,
            temperature=temperature,
            max_completion_tokens=max_output_tokens,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            debug=False,
            debug_input=False,
            debug_output=False,
        )
        if error_msg or not llm_payload:
            logging.warning(
                "LLM returned empty response",
                extra={
                    "issue_key": issue_key,
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "system_prompt_preview": system_prompt[:200],
                    "user_prompt_preview": user_prompt[:200],
                    "error": error_msg,
                    "response_preview": (json.dumps(llm_payload)[:500] if llm_payload else None),
                },
            )
            raise ConversationProcessingError(error_msg or "LLM returned empty response.")
        cost_usd = cq.estimate_cost(model, prompt_tokens, completion_tokens)

    return cq.process_conversation(
        payload,
        metrics,
        llm_payload,
        model if use_llm else "",
        prompt_tokens,
        completion_tokens,
        cost_usd,
    )


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), format="%(asctime)s %(levelname)s %(message)s")

    supabase_url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        raise SystemExit("Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY in environment.")

    config = ProcessorConfig(
        supabase_url=supabase_url,
        supabase_key=supabase_key,
        prepared_table=args.prepared_table,
        processed_table=args.processed_table,
        limit=max(1, args.limit),
        model=args.model,
        temperature=args.temperature,
        max_output_tokens=args.max_output_tokens,
        taxonomy_file=args.taxonomy_file,
        use_llm=not args.no_llm,
        dry_run=bool(args.dry_run),
        concurrency=max(1, args.concurrency),
    )

    ensure_processed_table(os.getenv("SUPABASE_DB_URL"))

    store = SupabaseConversationStore(
        url=config.supabase_url,
        key=config.supabase_key,
        prepared_table=config.prepared_table,
        processed_table=config.processed_table,
    )

    taxonomy = cq.load_taxonomy(config.taxonomy_file)
    openai_client = cq.ensure_openai_client() if config.use_llm else None
    if config.use_llm and openai_client is None:
        logging.warning("OPENAI client unavailable; continuing without LLM results.")
        config.use_llm = False

    processed_keys = store.fetch_processed_keys()
    prepared_records = store.fetch_prepared(config.limit, processed_keys)
    if not prepared_records:
        logging.info("No new conversations to process.")
        return 0

    results: List[Dict[str, Any]] = []
    processed_issues: List[str] = []
    consecutive_failures = 0
    max_attempts_per_issue = 2
    max_consecutive_failures = 3
    total_records = len(prepared_records)
    processed_count = 0

    executor = ThreadPoolExecutor(max_workers=config.concurrency)
    futures = {}
    for item in prepared_records:
        payload = item["payload"]
        if isinstance(payload, dict):
            futures[executor.submit(
                _process_payload_worker,
                payload,
                config,
                openai_client,
                taxonomy,
                max_attempts_per_issue,
            )] = (payload.get("issue_key") or "").strip()

    aborted = False
    try:
        for future in as_completed(futures):
            issue_hint = futures[future] or "unknown"
            try:
                issue_key, record = future.result()
            except ConversationProcessingError as exc:
                consecutive_failures += 1
                logging.error(
                    "Processing failed for %s: %s (consecutive failures: %s)",
                    issue_hint,
                    exc,
                    consecutive_failures,
                )
                if consecutive_failures >= max_consecutive_failures:
                    logging.error("Aborting after %s consecutive failures.", consecutive_failures)
                    aborted = True
                    break
                continue
            except Exception as exc:  # pragma: no cover
                consecutive_failures += 1
                logging.exception(
                    "Unexpected error while processing %s (consecutive failures: %s)",
                    issue_hint,
                    consecutive_failures,
                )
                if consecutive_failures >= max_consecutive_failures:
                    logging.error("Aborting after %s consecutive failures.", consecutive_failures)
                    aborted = True
                    break
                continue

            consecutive_failures = 0
            processed_count += 1
            percent_complete = (processed_count / total_records) * 100
            logging.info(
                "Processing progress: %s/%s (%.1f%%) [%s]",
                processed_count,
                total_records,
                percent_complete,
                issue_key,
            )

            if config.dry_run:
                results.append(record)
            else:
                store.upsert_processed([record])
                store.mark_prepared_processed([issue_key])
                processed_issues.append(issue_key)
        if aborted:
            return 1
    finally:
        for future in futures:
            if not future.done():
                future.cancel()
        executor.shutdown(wait=False)
    if config.dry_run:
        logging.info("[dry-run] computed %s conversations; not writing to Supabase.", len(results))
    else:
        logging.info("Stored %s processed conversations in %s.", len(processed_issues), config.processed_table)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
