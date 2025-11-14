#!/usr/bin/env python3
"""Robust Jira → Supabase ingestion script.

This utility fetches Jira Service Management tickets that match a configurable
JQL window, deduplicates them against Supabase, and stores both the core issue
fields and their threaded comments so the rest of the pipeline (notably
``analysis/prepare_dataset.py``) can work directly from the database.

Highlights:
* Configurable start/end dates with a default 1-Nov-2025 cut-off for initial
  backfills so the job never replays unbounded history.
* Idempotent upserts keyed by ``issue_key`` so it is safe under schedulers,
  webhook retries, or manual reruns.
* Optional automatic table creation when ``SUPABASE_DB_URL`` (a Postgres
  connection string) is provided; otherwise the script reports the DDL that
  needs to be applied once.
* Structured logging of retries/failures for visibility when running under
  cron or async workers.

Run ``python jiraPull/injestionTest.py --help`` for CLI options.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import requests
from dotenv import load_dotenv

try:
    from supabase import Client, create_client
except ImportError as exc:  # pragma: no cover - dependency guard
    raise SystemExit(
        "supabase client is missing. Run 'pip install -r requirements.txt' first"
    ) from exc

try:  # Optional dependency used for automatic DDL execution.
    import psycopg
except Exception:  # pragma: no cover - optional dependency may be absent
    psycopg = None  # type: ignore


load_dotenv(override=False)


DEFAULT_PROJECT = os.getenv("JIRA_PROJECT", "CC")
DEFAULT_STATUS_CATEGORY = os.getenv("JIRA_STATUS_CATEGORY", "Done")
DEFAULT_START_DATE = date(2025, 11, 1)
DEFAULT_BATCH_SIZE = 100
REQUEST_TIMEOUT = 30
MAX_API_RETRIES = 4
RETRY_BACKOFF_SECONDS = 3
SUPABASE_PAGE_SIZE = 1000
JIRA_CORE_FIELDS = [
    "summary",
    "project",
    "issuetype",
    "reporter",
    "status",
    "resolution",
    "created",
    "updated",
    "duedate",
]
JIRA_SYSTEM_FIELDS = JIRA_CORE_FIELDS + ["comment"]


FIELD_COLUMN_MAP: Dict[str, str] = {
    "Custom field (Rental ID)": "rental_id",
    "Custom field (Bike QR Code)": "bike_qr_code",
    "Custom field (Hub)": "hub",
    "Custom field (Refund Reason)": "refund_reason",
    "Custom field (Dock)": "dock",
    "Satisfaction rating": "satisfaction_rating",
    "Custom field (Contact Reason)": "contact_reason",
}

FIELD_NAME_ALIASES: Dict[str, Sequence[str]] = {
    "Custom field (Rental ID)": ["Custom field (Rental ID)", "Rental ID"],
    "Custom field (Bike QR Code)": [
        "Custom field (Bike QR Code)",
        "Bike QR Code",
    ],
    "Custom field (Hub)": ["Custom field (Hub)", "Hub"],
    "Custom field (Refund Reason)": [
        "Custom field (Refund Reason)",
        "Refund Reason",
    ],
    "Custom field (Dock)": ["Custom field (Dock)", "Dock"],
    "Satisfaction rating": ["Satisfaction rating"],
    "Custom field (Contact Reason)": [
        "Custom field (Contact Reason)",
        "Contact Reason",
    ],
}

TOP_LEVEL_EXPORT_FIELDS = {
    "rental_id": "Rental ID",
    "bike_qr_code": "Bike QR Code",
}

CUSTOM_FIELD_EXPORT_KEYS = {
    "hub": "hub",
    "refund_reason": "refund_reason",
    "dock": "dock",
    "satisfaction_rating": "satisfaction_rating",
    "contact_reason": "contact_reason",
}


TABLE_PREPARED = os.getenv("SUPABASE_JIRA_PREPARED_TABLE", "jira_prepared_conversations")
TABLE_PROCESSED = os.getenv("SUPABASE_JIRA_PROCESSED_TABLE", "jira_processed_conversations")

PREPARED_TABLE_DDL = f"""
create table if not exists public.{TABLE_PREPARED} (
    issue_key text primary key,
    payload jsonb not null,
    merge_context_size_tokens integer,
    dataset_version text not null default 'v1',
    prepared_at timestamptz not null default timezone('utc', now())
);
"""


IMG_PATTERN = re.compile(r"!([^!|\n]+)(?:\|[^!]*)?!")
IMAGE_FILE_PATTERN = re.compile(r"\b[\w\-.]+\.(?:png|jpe?g|gif|bmp|tiff|svg)\b", re.IGNORECASE)
VIDEO_FILE_PATTERN = re.compile(r"\b[\w\-.]+\.(?:mp4|mov|avi|wmv|mkv|webm)\b", re.IGNORECASE)
LINK_PATTERN = re.compile(r"https?://\S+")
TOKEN_PATTERN = re.compile(r"\w+|[^\w\s]")


def get_account_identifier(user_info: Optional[Dict[str, Any]]) -> Optional[str]:
    if not user_info:
        return None
    account_id = (user_info.get("accountId") or "").strip()
    if account_id:
        return account_id
    email = (user_info.get("emailAddress") or "").strip()
    if email:
        return email
    display = (user_info.get("displayName") or "").strip()
    return display or None


@dataclass
class Config:
    jira_base_url: str
    jira_email: str
    jira_api_token: str
    supabase_url: Optional[str]
    supabase_key: Optional[str]
    supabase_db_url: Optional[str]
    start_date: date
    end_date: Optional[date]
    project: str
    status_category: str
    batch_size: int
    max_issues: Optional[int]
    dry_run: bool
    force_full_refresh: bool
    log_level: str
    jql_override: Optional[str]
    fetch_only: bool
    dump_path: Optional[str]
    count_only: bool


@dataclass
class IngestionStats:
    fetched: int = 0
    inserted_prepared: int = 0
    skipped_existing: int = 0
    failures: List[str] = field(default_factory=list)

    def log_failure(self, message: str) -> None:
        self.failures.append(message)


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest Jira tickets into Supabase")
    parser.add_argument(
        "--start-date",
        help="Lower bound for created date (YYYY-MM-DD). Defaults to 2025-11-01",
    )
    parser.add_argument(
        "--end-date",
        help="Upper bound (exclusive) for created date (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--project",
        default=DEFAULT_PROJECT,
        help=f"Jira project key (default: {DEFAULT_PROJECT})",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help="Max issues to request per Jira API call",
    )
    parser.add_argument(
        "--max-issues",
        type=int,
        help="Optional cap on number of new issues to upsert per run",
    )
    parser.add_argument(
        "--status-category",
        default=DEFAULT_STATUS_CATEGORY,
        help=f"Jira statusCategory filter (default: {DEFAULT_STATUS_CATEGORY})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and log issues without writing to Supabase",
    )
    parser.add_argument(
        "--force-full-refresh",
        action="store_true",
        help="Ignore Supabase checkpoint when building the JQL",
    )
    parser.add_argument(
        "--jql-override",
        help="Use a custom JQL string instead of the generated one",
    )
    parser.add_argument(
        "--fetch-only",
        action="store_true",
        help="Skip Supabase entirely and just pull Jira data",
    )
    parser.add_argument(
        "--dump-path",
        help="Optional path to save fetched payloads as JSON (implies fetch preview).",
    )
    parser.add_argument(
        "--count-only",
        action="store_true",
        help="Do not fetch comments or write data; just report how many new issues would be ingested.",
    )
    parser.add_argument(
        "--log-level",
        default=os.getenv("INGEST_LOG_LEVEL", "INFO"),
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Logging verbosity",
    )
    return parser.parse_args(argv)


def ensure_required_env(var_name: str) -> str:
    value = os.getenv(var_name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {var_name}")
    return value


def extract_error_code(error: Any) -> Optional[str]:
    if not error:
        return None
    if isinstance(error, dict):
        return error.get("code")
    return getattr(error, "code", None)


def parse_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as exc:  # pragma: no cover - user input validation
        raise SystemExit(f"Invalid date format '{value}'. Use YYYY-MM-DD.") from exc


def build_config(args: argparse.Namespace) -> Config:
    start_date = parse_date(args.start_date) or DEFAULT_START_DATE
    # Never ingest data before the hard cut-off even if args specify older date.
    if start_date < DEFAULT_START_DATE:
        start_date = DEFAULT_START_DATE

    end_date = parse_date(args.end_date)

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not args.fetch_only:
        if not supabase_url:
            raise SystemExit("Missing SUPABASE_URL (required unless --fetch-only).")
        if not supabase_key:
            raise SystemExit("Missing SUPABASE_SERVICE_ROLE_KEY (required unless --fetch-only).")
    elif args.dump_path is None:
        # In fetch-only mode encourage dumping to inspect output
        logging.getLogger("jira_ingest").warning(
            "Running fetch-only without --dump-path; data will only be logged."
        )
    if args.count_only:
        args.fetch_only = True

    config = Config(
        jira_base_url=os.getenv("JIRA_BASE_URL", "https://portapp.atlassian.net"),
        jira_email=ensure_required_env("JIRA_EMAIL"),
        jira_api_token=ensure_required_env("JIRA_API_KEY"),
        supabase_url=supabase_url,
        supabase_key=supabase_key,
        supabase_db_url=os.getenv("SUPABASE_DB_URL"),
        start_date=start_date,
        end_date=end_date,
        project=args.project,
        status_category=args.status_category,
        batch_size=max(1, args.batch_size),
        max_issues=args.max_issues,
        dry_run=bool(args.dry_run),
        force_full_refresh=bool(args.force_full_refresh),
        log_level=args.log_level,
        jql_override=args.jql_override,
        fetch_only=bool(args.fetch_only),
        dump_path=args.dump_path,
        count_only=bool(args.count_only),
    )
    return config


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


class JiraClient:
    """Thin wrapper around the Jira REST API with retry/backoff."""

    def __init__(self, base_url: str, email: str, api_token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.auth = (email, api_token)
        self.session.headers.update({"Accept": "application/json"})
        self.log = logging.getLogger(self.__class__.__name__)

    def search(
        self,
        *,
        jql: str,
        max_results: int = DEFAULT_BATCH_SIZE,
        fields: Optional[Sequence[str]] = None,
        next_page_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "jql": jql,
            "maxResults": max_results,
        }
        if next_page_token:
            payload["nextPageToken"] = next_page_token
        if fields:
            payload["fields"] = list(fields)
        url = f"{self.base_url}/rest/api/3/search/jql"
        return self._request("POST", url, json_payload=payload)

    def fetch_field_name_map(self) -> Dict[str, str]:
        url = f"{self.base_url}/rest/api/3/field"
        response = self._request("GET", url)
        if not isinstance(response, list):
            raise RuntimeError("Unexpected field listing response")
        return {str(item.get("id")): item.get("name", "") for item in response if item.get("id")}

    def fetch_comments(self, issue_key: str) -> List[Dict[str, Any]]:
        comments: List[Dict[str, Any]] = []
        start_at = 0
        while True:
            url = f"{self.base_url}/rest/api/3/issue/{issue_key}/comment"
            params = {"startAt": start_at, "maxResults": 100, "expand": "renderedBody"}
            payload = self._request("GET", url, params=params)
            batch = payload.get("comments", [])
            comments.extend(batch)
            if len(batch) < 100:
                break
            start_at += len(batch)
        return comments

    def _request(
        self,
        method: str,
        url: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json_payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        for attempt in range(1, MAX_API_RETRIES + 1):
            try:
                response = self.session.request(
                    method,
                    url,
                    params=params,
                    json=json_payload,
                    timeout=REQUEST_TIMEOUT,
                )
            except requests.RequestException as exc:
                self.log.warning("Jira request failed (%s/%s): %s", attempt, MAX_API_RETRIES, exc)
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)
                continue

            if response.status_code >= 500:
                self.log.warning(
                    "Jira server error %s (%s/%s): %s",
                    response.status_code,
                    attempt,
                    MAX_API_RETRIES,
                    response.text,
                )
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)
                continue

            if response.status_code >= 400:
                raise RuntimeError(
                    f"Jira API returned {response.status_code}: {response.text}"
                )

            try:
                return response.json()
            except ValueError as exc:  # pragma: no cover - unexpected payloads
                raise RuntimeError("Failed to parse Jira response as JSON") from exc

        raise RuntimeError(f"Failed Jira request after {MAX_API_RETRIES} attempts: {url}")


class SupabaseStore:
    def __init__(self, url: str, key: str, db_url: Optional[str]) -> None:
        self.client: Client = create_client(url, key)
        self.db_url = db_url
        self.log = logging.getLogger(self.__class__.__name__)

    def ensure_tables(self) -> None:
        if not self.db_url:
            self.log.info(
                "SUPABASE_DB_URL not provided – skipping automatic table creation."
            )
            self.log.info(
                "Apply the following SQL manually if the table does not yet exist:\n%s",
                PREPARED_TABLE_DDL,
            )
            return
        if psycopg is None:
            self.log.warning(
                "psycopg not installed; cannot run automatic DDL even though SUPABASE_DB_URL is set."
            )
            return

        with psycopg.connect(self.db_url, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(PREPARED_TABLE_DDL)
        self.log.info("Ensured Supabase tables exist (if missing they have been created).")

    def fetch_existing_issue_keys(self) -> Set[str]:
        keys: Set[str] = set()
        start = 0
        while True:
            response = (
                self.client.table(TABLE_PREPARED)
                .select("issue_key")
                .range(start, start + SUPABASE_PAGE_SIZE - 1)
                .execute()
            )
            error = getattr(response, "error", None)
            if error:
                error_code = extract_error_code(error)
                if error_code == "42P01":  # undefined_table
                    self.log.info("Issues table not found yet; treating as empty dataset.")
                    return set()
                raise RuntimeError(f"Supabase select failed: {error}")
            rows = response.data or []
            for row in rows:
                key = row.get("issue_key")
                if key:
                    keys.add(key)
            if len(rows) < SUPABASE_PAGE_SIZE:
                break
            start += SUPABASE_PAGE_SIZE
        return keys

    def fetch_latest_created(self) -> Optional[datetime]:
        order_field = "payload->>created"
        response = (
            self.client.table(TABLE_PREPARED)
            .select(order_field)
            .order(order_field, desc=True)
            .limit(1)
            .execute()
        )
        error = getattr(response, "error", None)
        if error:
            error_code = extract_error_code(error)
            if error_code == "42P01":
                return None
            raise RuntimeError(f"Supabase select failed: {error}")
        rows = response.data or []
        if not rows:
            return None
        created_value = rows[0].get(order_field)
        if not created_value:
            return None
        try:
            return datetime.fromisoformat(created_value.replace("Z", "+00:00"))
        except ValueError:
            return None

    def fetch_latest_processed(self) -> Optional[str]:
        try:
            response = (
                self.client.table(TABLE_PROCESSED)
                .select("issue_key, conversation_start, processed_at")
                .order("issue_key", desc=True)
                .limit(1)
                .execute()
            )
        except Exception:
            return None
        error = getattr(response, "error", None)
        if error:
            error_code = extract_error_code(error)
            if error_code == "42P01":
                return None
            raise RuntimeError(f"Supabase processed select failed: {error}")
        rows = response.data or []
        if not rows:
            return None
        row = rows[0]
        return (row.get("issue_key") or "").strip() or None

    def upsert_prepared_rows(self, rows: List[Dict[str, Any]]) -> None:
        if not rows:
            return
        response = (
            self.client.table(TABLE_PREPARED)
            .upsert(rows, on_conflict="issue_key")
            .execute()
        )
        if getattr(response, "error", None):
            raise RuntimeError(f"Supabase prepared upsert failed: {response.error}")


def build_jql(project: str, status_category: str, start_date: date, end_date: Optional[date]) -> str:
    clauses = [f"project = {project}", f'statusCategory = "{status_category}"']
    clauses.append(f'created >= "{start_date.isoformat()}"')
    if end_date:
        clauses.append(f'created < "{end_date.isoformat()}"')
    clauses.append("ORDER BY created DESC")
    return " AND ".join(clauses[:-1]) + " " + clauses[-1]


def sanitize_text(text: str) -> str:
    text = IMG_PATTERN.sub("[image file]", text)
    text = IMAGE_FILE_PATTERN.sub("[image file]", text)
    text = VIDEO_FILE_PATTERN.sub("[video file]", text)
    text = LINK_PATTERN.sub("[link]", text)
    return text.strip()


def classify_role(author: Optional[Dict[str, Any]]) -> str:
    if not author:
        return "unknown"
    account_id = (author.get("accountId") or "").lower()
    display = (author.get("displayName") or "").lower()
    if account_id.startswith("712020") or display.startswith("port "):
        return "agent"
    if account_id.startswith("qm:"):
        return "customer"
    return "unknown"


def short_role(role: str) -> str:
    if role == "agent":
        return "~A"
    if role == "customer":
        return "~C"
    return "~U"


def render_adf(node: Any) -> str:
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(render_adf(child) for child in node)
    if isinstance(node, dict):
        node_type = node.get("type")
        if node_type == "text":
            return node.get("text", "")
        if node_type == "hardBreak":
            return "\n"
        content = node.get("content", [])
        rendered = "".join(render_adf(child) for child in content)
        if node_type in {"paragraph", "heading", "blockquote", "panel"}:
            return rendered + "\n"
        if node_type in {"bulletList", "orderedList"}:
            return rendered + "\n"
        return rendered
    return ""


def normalise_field_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        normalised = [v for v in (normalise_field_value(item) for item in value) if v]
        return ", ".join(normalised) if normalised else None
    if isinstance(value, dict):
        for key in ("value", "name", "displayName", "text"):
            if key in value and value[key]:
                return str(value[key]).strip()
        return json.dumps(value)
    return str(value)


def resolve_custom_field_ids(names: Dict[str, str]) -> Dict[str, str]:
    reverse_lookup = {label.strip(): field_id for field_id, label in names.items()}
    resolved: Dict[str, str] = {}
    for export_label, column_name in FIELD_COLUMN_MAP.items():
        candidates = FIELD_NAME_ALIASES.get(export_label, [export_label])
        for candidate in candidates:
            field_id = reverse_lookup.get(candidate)
            if field_id:
                resolved[column_name] = field_id
                break
    return resolved


def build_field_request_list(resolved_fields: Dict[str, str]) -> List[str]:
    field_ids = list(JIRA_SYSTEM_FIELDS)
    field_ids.extend(resolved_fields.values())
    # Deduplicate while preserving order
    seen: Set[str] = set()
    ordered: List[str] = []
    for fid in field_ids:
        if fid and fid not in seen:
            seen.add(fid)
            ordered.append(fid)
    return ordered


def build_prepared_payload(
    issue: Dict[str, Any],
    comments: List[Dict[str, Any]],
    field_lookup: Dict[str, str],
) -> Tuple[Dict[str, Any], int]:
    fields = issue.get("fields", {})
    rec: Dict[str, Any] = {
        "issue_key": issue.get("key"),
        "user_summary": normalise_field_value(fields.get("summary")) or "",
        "reporter": get_account_identifier(fields.get("reporter")) or "",
        "status": normalise_field_value((fields.get("status") or {}).get("name")) or "",
        "resolution": normalise_field_value((fields.get("resolution") or {}).get("name")) or "",
        "created": fields.get("created"),
        "updated": fields.get("updated"),
        "due_date": fields.get("duedate"),
    }

    for column_name, prepared_label in TOP_LEVEL_EXPORT_FIELDS.items():
        field_id = field_lookup.get(column_name)
        if field_id:
            rec[prepared_label] = normalise_field_value(fields.get(field_id)) or ""

    custom_fields: Dict[str, Any] = {}
    for column_name, custom_key in CUSTOM_FIELD_EXPORT_KEYS.items():
        field_id = field_lookup.get(column_name)
        if field_id:
            custom_fields[custom_key] = normalise_field_value(fields.get(field_id)) or ""
    rec["custom_fields"] = custom_fields

    prepared_comments: List[Dict[str, Any]] = []
    merged_chunks: List[str] = []
    for index, comment in enumerate(
        sorted(comments, key=lambda c: c.get("created") or ""), start=1
    ):
        author = comment.get("author")
        role = classify_role(author)
        role_short = short_role(role)
        body = comment.get("body")
        if isinstance(body, dict):
            text = render_adf(body)
        else:
            text = str(body or "")
        text = sanitize_text(text)
        entry = {
            "date": comment.get("created"),
            "author": get_account_identifier(author),
            "role": role_short,
            "text": text,
            "internal_note": not comment.get("jsdPublic", True),
            "index": index,
        }
        prepared_comments.append(entry)
        if text:
            merged_chunks.append(f"{role_short}:{text}")

    merged_text = " ".join(merged_chunks).strip()
    token_count = len(TOKEN_PATTERN.findall(merged_text))

    rec["comments"] = prepared_comments
    rec["merged_text"] = merged_text
    rec["merge_context_size_tokens"] = token_count

    return rec, token_count


def ingest(config: Config) -> IngestionStats:
    setup_logging(config.log_level)
    logger = logging.getLogger("jira_ingest")
    stats = IngestionStats()

    jira = JiraClient(config.jira_base_url, config.jira_email, config.jira_api_token)

    store: Optional[SupabaseStore] = None
    existing_keys: Set[str] = set()
    latest_created: Optional[datetime] = None
    latest_processed_key: Optional[str] = None

    need_store = not config.fetch_only or config.count_only

    if need_store:
        store = SupabaseStore(config.supabase_url or "", config.supabase_key or "", config.supabase_db_url)
        store.ensure_tables()

        try:
            existing_keys = store.fetch_existing_issue_keys()
        except RuntimeError as exc:
            logger.warning("Unable to read Supabase issue keys: %s", exc)
            existing_keys = set()

        if not config.force_full_refresh:
            try:
                latest_created = store.fetch_latest_created()
            except RuntimeError as exc:
                logger.warning("Unable to read Supabase checkpoint: %s", exc)
            try:
                latest_processed_key = store.fetch_latest_processed()
            except RuntimeError as exc:
                logger.warning("Unable to read processed checkpoint: %s", exc)
    else:
        logger.info("Fetch-only mode enabled: Supabase writes are disabled.")
    start_date = config.start_date
    if latest_created and not config.force_full_refresh:
        checkpoint_date = latest_created.date()
        if checkpoint_date > start_date:
            start_date = checkpoint_date
    if config.jql_override:
        jql = config.jql_override.strip()
    else:
        jql = build_jql(config.project, config.status_category, start_date, config.end_date)
    logger.info("Running Jira ingest with JQL: %s", jql)

    next_page_token: Optional[str] = None
    total_fetched = 0
    try:
        field_names = jira.fetch_field_name_map()
    except RuntimeError as exc:
        logger.warning("Failed to fetch Jira field metadata: %s", exc)
        field_names = {}
    resolved_fields = resolve_custom_field_ids(field_names)
    fields_to_request = build_field_request_list(resolved_fields)
    remaining_quota = config.max_issues
    dump_prepared: List[Dict[str, Any]] = []
    dedupe_enabled = not config.fetch_only or config.count_only
    count_only = config.count_only

    stop_issue_key = latest_processed_key

    while True:
        if remaining_quota is not None:
            remaining = remaining_quota - total_fetched
            if remaining <= 0:
                break
            batch_size = max(1, min(config.batch_size, remaining))
        else:
            batch_size = config.batch_size

        page = jira.search(
            jql=jql,
            max_results=batch_size,
            fields=fields_to_request,
            next_page_token=next_page_token,
        )
        issues = page.get("issues", [])
        if not issues:
            break
        logger.debug(
            "Fetched %s issues (page token=%s)",
            len(issues),
            next_page_token or "initial",
        )
        next_page_token = page.get("nextPageToken")
        stats.fetched += len(issues)

        prepared_rows: List[Dict[str, Any]] = []
        ingested_at = datetime.now(timezone.utc).isoformat()

        stop_after_batch = False
        new_records_in_batch = 0
        for issue in issues:
            issue_key = issue.get("key")
            if not issue_key:
                continue
            if stop_issue_key and issue_key == stop_issue_key:
                logger.info("Encountered processed checkpoint %s; stopping ingest.", issue_key)
                stop_after_batch = True
                break
            if dedupe_enabled and issue_key in existing_keys:
                stats.skipped_existing += 1
                continue

            new_records_in_batch += 1

            if count_only:
                if dedupe_enabled:
                    existing_keys.add(issue_key)
            else:
                try:
                    comments = jira.fetch_comments(issue_key)
                except RuntimeError as exc:
                    stats.log_failure(f"Failed to fetch comments for {issue_key}: {exc}")
                    comments = []

                prepared_payload, token_count = build_prepared_payload(issue, comments, resolved_fields or {})
                prepared_record = {
                    "issue_key": issue_key,
                    "payload": prepared_payload,
                    "merge_context_size_tokens": token_count,
                    "dataset_version": "v1",
                    "prepared_at": ingested_at,
                    "processed": False,
                }
                prepared_rows.append(prepared_record)
                if dedupe_enabled:
                    existing_keys.add(issue_key)

            stats.inserted_prepared += 1
            if remaining_quota is not None and stats.inserted_prepared >= remaining_quota:
                logger.info("Reached --max-issues=%s cap", remaining_quota)
                stop_after_batch = True
                break
            total_fetched += 1

        if not count_only and config.dump_path:
            dump_prepared.extend(prepared_rows)

        if not count_only and not prepared_rows:
            if stop_after_batch or (remaining_quota is not None and total_fetched >= remaining_quota):
                break
            continue

        if count_only:
            logger.debug("Count-only batch added %s new issues.", new_records_in_batch)
        elif config.dry_run or config.fetch_only:
            logger.info(
                "[dry-run] Would upsert %s prepared rows",
                len(prepared_rows),
            )
        elif store:
            store.upsert_prepared_rows(prepared_rows)

        if stop_after_batch:
            break

        is_last = page.get("isLast")
        if not next_page_token or is_last:
            break

    if count_only:
        logger.info("Count-only mode: %s new Jira issues would be ingested.", stats.inserted_prepared)
    else:
        logger.info(
            "Ingestion finished: %s prepared payloads, %s skipped duplicates",
            stats.inserted_prepared,
            stats.skipped_existing,
        )
    if config.dump_path:
        dump_path = Path(config.dump_path)
        dump_path.parent.mkdir(parents=True, exist_ok=True)
        snapshot = {
            "jql": jql,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
        snapshot["prepared_rows"] = dump_prepared
        dump_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2))
        logger.info("Wrote fetch snapshot to %s", dump_path)

    if stats.failures:
        logger.warning("Encountered %s errors during ingest:", len(stats.failures))
        for failure in stats.failures:
            logger.warning(" - %s", failure)
    return stats


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    config = build_config(args)
    try:
        ingest(config)
    except Exception as exc:  # pragma: no cover - top-level safety net
        logging.basicConfig(level=logging.ERROR)
        logging.exception("Ingestion failed: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
