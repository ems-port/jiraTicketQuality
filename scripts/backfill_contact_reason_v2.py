#!/usr/bin/env python3
"""
Re-run contact reason classification with the V2 taxonomy and backfill the contact_reason_v2 columns
for recent conversations (including topic/sub/ID when resolvable).

Default scope: last 7 days of jira_prepared_conversations, updating matching rows in
jira_processed_conversations.

Usage examples:
  python scripts/backfill_contact_reason_v2.py --taxonomy-file local_data/taxonomy_v2.json
  python scripts/backfill_contact_reason_v2.py --days 14 --limit 200 --model gpt-4o-mini
  python scripts/backfill_contact_reason_v2.py --dry-run

Environment:
  SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  OPENAI_API_KEY (unless --no-llm)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple
import sys
from pathlib import Path

from dotenv import load_dotenv
from supabase import Client, create_client  # type: ignore

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
  sys.path.insert(0, str(REPO_ROOT))

import analysis.convo_quality as cq  # type: ignore


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Backfill contact_reason_v2 for recent conversations.")
  parser.add_argument("--taxonomy-file", default="local_data/taxonomy_v2.json", help="Path to taxonomy file (expects JSON with labels[] or array of strings). Ignored if --use-supabase-taxonomy is set.")
  parser.add_argument("--use-supabase-taxonomy", action="store_true", help="Load active taxonomy from Supabase instead of a local file.")
  parser.add_argument("--enrich-taxonomy", action="store_true", help="Include descriptions/keywords in the taxonomy entries passed to the LLM.")
  parser.add_argument("--print-prompt", action="store_true", help="Print the taxonomy prompt block before running classification.")
  parser.add_argument("--print-llm-prompts", action="store_true", help="Print system and user prompts for each classification.")
  parser.add_argument("--print-llm-output", action="store_true", help="Print raw LLM response payload for each classification.")
  parser.add_argument("--prepared-table", default="jira_prepared_conversations", help="Supabase table for prepared conversations.")
  parser.add_argument("--processed-table", default="jira_processed_conversations", help="Supabase table for processed conversations.")
  parser.add_argument("--days", type=int, default=7, help="Lookback window in days.")
  parser.add_argument("--limit", type=int, default=500, help="Max conversations to process.")
  parser.add_argument("--model", default="gpt-4o-mini", help="LLM model to use.")
  parser.add_argument("--temperature", type=float, default=0.0, help="LLM temperature.")
  parser.add_argument("--max-output-tokens", type=int, default=700, help="Max completion tokens.")
  parser.add_argument("--no-llm", action="store_true", help="Skip LLM calls (classification will be blank).")
  parser.add_argument("--log-level", default="INFO", help="Logging level.")
  parser.add_argument("--dry-run", action="store_true", help="Compute results but do not write to Supabase.")
  return parser.parse_args()


def ensure_client() -> Client:
  supabase_url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
  supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
  if not supabase_url or not supabase_key:
    raise SystemExit("Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY.")
  return create_client(supabase_url, supabase_key)


def load_taxonomy_labels(path: str) -> List[str]:
  with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)
  if isinstance(data, list):
    return [str(item).strip() for item in data if str(item).strip()]
  if isinstance(data, dict):
    labels = data.get("labels") or []
    return [str(item).strip() for item in labels if str(item).strip()]
  raise ValueError("taxonomy file must be a JSON array or an object with a labels[] field.")


def fetch_prepared_since(client: Client, table: str, cutoff: datetime, limit: int) -> List[Dict[str, Any]]:
  collected: List[Dict[str, Any]] = []
  start = 0
  page = 200
  cutoff_iso = cutoff.isoformat()
  while len(collected) < limit:
    resp = (
      client.table(table)
      .select("issue_key,payload,prepared_at")
      .gte("prepared_at", cutoff_iso)
      .order("prepared_at", desc=True)
      .range(start, start + page - 1)
      .execute()
    )
    rows = resp.data or []
    if not rows:
      break
    for row in rows:
      issue_key = (row.get("issue_key") or "").strip()
      if not issue_key:
        continue
      payload = row.get("payload") or {}
      if not isinstance(payload, dict):
        continue
      collected.append({"issue_key": issue_key, "payload": payload})
      if len(collected) >= limit:
        break
    if len(rows) < page:
      break
    start += page
  return collected


def fetch_existing_processed_keys(client: Client, table: str) -> set[str]:
  keys: set[str] = set()
  start = 0
  page = 500
  while True:
    resp = client.table(table).select("issue_key").range(start, start + page - 1).execute()
    rows = resp.data or []
    for row in rows:
      key = (row.get("issue_key") or "").strip()
      if key:
        keys.add(key)
    if len(rows) < page:
      break
    start += page
  return keys


def fetch_reason_map(client: Client) -> Dict[str, str]:
  """
  Returns a mapping of flattened label -> reason_id for the active (IN_USE) taxonomy,
  or the latest version if none are active.
  """
  version_id: Optional[str] = None
  resp = (
    client.table("contact_taxonomy_versions")
    .select("id,version,status")
    .eq("status", "IN_USE")
    .order("version", desc=True)
    .limit(1)
    .execute()
  )
  rows = resp.data or []
  if rows:
    version_id = rows[0].get("id")
  if not version_id:
    resp = (
      client.table("contact_taxonomy_versions")
      .select("id,version,status")
      .order("version", desc=True)
      .limit(1)
      .execute()
    )
    rows = resp.data or []
    if rows:
      version_id = rows[0].get("id")
  if not version_id:
    return {}

  reasons_resp = (
    client.table("contact_taxonomy_reasons")
    .select("id,topic,sub_reason,status")
    .eq("version_id", version_id)
    .execute()
  )
  reasons = reasons_resp.data or []
  mapping: Dict[str, str] = {}
  for reason in reasons:
    status = (reason.get("status") or "").upper()
    if status == "CANCELLED":
      continue
    topic = (reason.get("topic") or "").strip()
    sub = (reason.get("sub_reason") or "").strip()
    if not topic:
      continue
    label = f"{topic} - {sub}" if sub else topic
    reason_id = reason.get("id")
    if label and reason_id and label not in mapping:
      mapping[label] = reason_id
  return mapping


def build_prompt_block(reasons: Sequence[Dict[str, Any]], include_keywords: bool = False) -> str:
  lines: List[str] = []
  active = [r for r in reasons if (r.get("status") or "").upper() != "CANCELLED"]
  for idx, reason in enumerate(active, start=1):
    topic = (reason.get("topic") or "").strip()
    sub = (reason.get("sub_reason") or "").strip()
    description = (reason.get("description") or "").strip()
    keywords = reason.get("keywords") if include_keywords else []
    parts = [f"{idx}. {topic}{' — ' + sub if sub else ''}"]
    if description:
      parts.append(f"When: {description}")
    if include_keywords and keywords:
      parts.append(f"Keywords: {', '.join(keywords)}")
    lines.append(" | ".join(parts))
  return "\n".join(lines)


def build_rich_taxonomy_lines(reasons: Sequence[Dict[str, Any]], include_keywords: bool = False) -> List[str]:
  lines: List[str] = []
  active = [r for r in reasons if (r.get("status") or "").upper() != "CANCELLED"]
  for reason in active:
    topic = (reason.get("topic") or "").strip()
    sub = (reason.get("sub_reason") or "").strip()
    description = (reason.get("description") or "").strip()
    keywords = reason.get("keywords") if include_keywords else []
    parts = [f"{topic}{' — ' + sub if sub else ''}"]
    if description:
      parts.append(f"When: {description}")
    if include_keywords and keywords:
      parts.append(f"Keywords: {', '.join(keywords)}")
    lines.append(" | ".join(parts))
  return lines


def fetch_active_taxonomy(client: Client, include_keywords: bool = False) -> tuple[List[str], str, List[str]]:
  """
  Loads the active IN_USE taxonomy (or latest) from Supabase and returns (labels, prompt_block, rich_lines).
  """
  version_id: Optional[str] = None
  resp = (
    client.table("contact_taxonomy_versions")
    .select("id,version,status")
    .eq("status", "IN_USE")
    .order("version", desc=True)
    .limit(1)
    .execute()
  )
  rows = resp.data or []
  if rows:
    version_id = rows[0].get("id")
  if not version_id:
    resp = (
      client.table("contact_taxonomy_versions")
      .select("id,version,status")
      .order("version", desc=True)
      .limit(1)
      .execute()
    )
    rows = resp.data or []
    if rows:
      version_id = rows[0].get("id")
  if not version_id:
    raise RuntimeError("No taxonomy versions found in Supabase.")

  reasons_resp = (
    client.table("contact_taxonomy_reasons")
    .select("id,topic,sub_reason,description,keywords,status,sort_order")
    .eq("version_id", version_id)
    .order("sort_order", desc=False)
    .execute()
  )
  reasons = reasons_resp.data or []
  labels: List[str] = []
  for reason in reasons:
    status = (reason.get("status") or "").upper()
    if status == "CANCELLED":
      continue
    topic = (reason.get("topic") or "").strip()
    sub = (reason.get("sub_reason") or "").strip()
    if not topic:
      continue
    labels.append(f"{topic} - {sub}" if sub else topic)
  prompt_block = build_prompt_block(reasons, include_keywords=include_keywords)
  rich_lines = build_rich_taxonomy_lines(reasons, include_keywords=include_keywords)
  return labels, prompt_block, rich_lines


def classify_contact_reason(
  payload: Dict[str, Any],
  taxonomy: Sequence[str],
  prompt_sections: Dict[str, str],
  model: str,
  temperature: float,
  max_output_tokens: int,
  openai_client: Optional[Tuple[str, Any]],
  debug_prompts: bool = False,
  debug_output: bool = False,
) -> Optional[str]:
  comments_raw = payload.get("comments") or []
  comments = cq.parse_comments(comments_raw if isinstance(comments_raw, list) else [])
  metrics = cq.compute_metrics(comments)
  transcript = cq.build_transcript(comments)
  system_prompt, user_prompt = cq.build_llm_prompts(payload, metrics, transcript, taxonomy, prompt_sections)

  if openai_client is None:
    return None
  if debug_prompts:
    print("=== SYSTEM PROMPT ===")
    print(system_prompt)
    print("=== USER PROMPT ===")
    print(user_prompt)

  llm_payload, prompt_tokens, completion_tokens, error_msg = cq.call_llm(
    openai_client=openai_client,
    model=model,
    temperature=temperature if cq.model_supports_temperature(model) else None,
    max_completion_tokens=max_output_tokens,
    system_prompt=system_prompt,
    user_prompt=user_prompt,
    debug=False,
    debug_input=False,
    debug_output=False,
  )
  if error_msg or not llm_payload:
    raise RuntimeError(error_msg or "LLM returned empty response.")

  if debug_output:
    print("=== LLM RESPONSE ===")
    print(json.dumps(llm_payload, indent=2))

  result = cq.process_conversation(
    payload,
    metrics,
    llm_payload,
    model,
    prompt_tokens,
    completion_tokens,
    cq.estimate_cost(model, prompt_tokens, completion_tokens),
  )
  reason = result.get("contact_reason")
  if reason:
    return str(reason).strip()
  original = result.get("contact_reason_original")
  return str(original).strip() if original else None


def split_reason(label: Optional[str]) -> tuple[Optional[str], Optional[str]]:
  text = (label or "").strip()
  if not text:
    return None, None
  if " - " in text:
    topic, sub = text.split(" - ", 1)
    return topic.strip() or None, sub.strip() or None
  return text, None


def flatten_label(topic: Optional[str], sub: Optional[str]) -> Optional[str]:
  topic_clean = (topic or "").strip()
  sub_clean = (sub or "").strip()
  if not topic_clean:
    return None
  return f"{topic_clean} - {sub_clean}" if sub_clean else topic_clean


def update_contact_reason_v2(client: Client, table: str, updates: List[Dict[str, Any]]) -> None:
  # Batched updater retained for compatibility, but unused in the per-row path below.
  if not updates:
    return
  chunk = 100
  for i in range(0, len(updates), chunk):
    batch = updates[i : i + chunk]
    rows = []
    for item in batch:
      rows.append(
        {
          "issue_key": item["issue_key"],
          "contact_reason_v2": item.get("label"),
          "contact_reason_v2_topic": item.get("topic"),
          "contact_reason_v2_sub": item.get("sub"),
          "contact_reason_v2_reason_id": item.get("reason_id"),
        }
      )
    resp = (
      client.table(table)
      .upsert(rows, on_conflict="issue_key")
      .execute()
    )
    if getattr(resp, "error", None):
      raise RuntimeError(resp.error)


def update_contact_reason_v2_row(client: Client, table: str, item: Dict[str, Any]) -> None:
  row = {
    "issue_key": item["issue_key"],
    "contact_reason_v2": item.get("label"),
    "contact_reason_v2_topic": item.get("topic"),
    "contact_reason_v2_sub": item.get("sub"),
    "contact_reason_v2_reason_id": item.get("reason_id"),
  }
  resp = client.table(table).upsert([row], on_conflict="issue_key").execute()
  if getattr(resp, "error", None):
    raise RuntimeError(resp.error)


def main() -> int:
  load_dotenv(override=False)
  args = parse_args()
  logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), format="%(asctime)s %(levelname)s %(message)s")

  client = ensure_client()
  if args.use_supabase_taxonomy:
    labels, prompt_block, rich_lines = fetch_active_taxonomy(client, include_keywords=args.enrich_taxonomy)
    taxonomy = rich_lines if args.enrich_taxonomy else labels
  else:
    taxonomy = load_taxonomy_labels(args.taxonomy_file)
    prompt_block = "\n".join(taxonomy)

  if not taxonomy:
    raise SystemExit("Taxonomy labels cannot be empty.")

  if args.print_prompt:
    print("=== TAXONOMY PROMPT ===")
    print(prompt_block)

  reason_map = fetch_reason_map(client)
  if not reason_map:
    logging.warning("Unable to build reason_id map; contact_reason_v2_reason_id will remain null.")

  prompt_sections = cq.load_prompt_sections_or_raise()
  openai_client = None if args.no_llm else cq.ensure_openai_client()
  if openai_client is None and not args.no_llm:
    logging.warning("OPENAI client unavailable; continuing with no LLM (will write null contact_reason_v2).")

  cutoff = datetime.now(timezone.utc) - timedelta(days=max(args.days, 1))
  prepared_records = fetch_prepared_since(client, args.prepared_table, cutoff, max(args.limit, 1))
  if not prepared_records:
    logging.info("No prepared conversations found in the given window.")
    return 0

  processed_keys = fetch_existing_processed_keys(client, args.processed_table)
  targets = [item for item in prepared_records if item["issue_key"] in processed_keys]
  if not targets:
    logging.info("No matching processed conversations to update.")
    return 0

  logging.info("Classifying %s conversations (of %s prepared in window).", len(targets), len(prepared_records))

  updates: List[Dict[str, Any]] = []
  failures = 0

  for item in targets:
    issue_key = item["issue_key"]
    try:
      reason = classify_contact_reason(
        item["payload"],
        taxonomy,
        prompt_sections,
        args.model,
        args.temperature,
        args.max_output_tokens,
        openai_client,
        debug_prompts=args.print_llm_prompts,
        debug_output=args.print_llm_output,
      )
      topic, sub = split_reason(reason)
      reason_id = reason_map.get(flatten_label(topic, sub), None)
      updates.append(
        {
          "issue_key": issue_key,
          "label": reason,
          "topic": topic,
          "sub": sub,
          "reason_id": reason_id,
        }
      )
      logging.info("%s -> %s (id=%s)", issue_key, reason or "None", reason_id or "None")
      if not args.dry_run:
        update_contact_reason_v2_row(client, args.processed_table, updates[-1])
    except Exception as exc:
      failures += 1
      logging.warning("Failed to classify %s: %s", issue_key, exc)

  if args.dry_run:
    logging.info("[dry-run] Would update %s rows (failures: %s).", len(updates), failures)
    return 0
  logging.info("Upserted %s rows in %s (failures: %s).", len(updates), args.processed_table, failures)
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
