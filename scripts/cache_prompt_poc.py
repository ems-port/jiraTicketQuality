#!/usr/bin/env python3
"""
Minimal prompt-caching proof-of-concept:
 - Load the active (IN_USE) contact taxonomy from Supabase.
 - Build a cached system message with the taxonomy (descriptions/keywords).
 - Classify a few recent prepared conversations by sending only dynamic content in the user message.

Usage:
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... \
  python3 scripts/cache_prompt_poc.py --limit 3 --days 7 --model gpt-4.1-mini --print-prompt

Notes:
  - Uses OpenAI prompt caching via cache_control on the system message.
  - Prints classifications to stdout; no Supabase writes.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from openai import OpenAI
from supabase import Client, create_client  # type: ignore

REPO_ROOT = Path(__file__).resolve().parent.parent
import sys

if str(REPO_ROOT) not in sys.path:
  sys.path.insert(0, str(REPO_ROOT))

import analysis.convo_quality as cq  # type: ignore


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Prompt caching PoC for contact taxonomy classification.")
  parser.add_argument("--days", type=int, default=7, help="Lookback window for prepared conversations.")
  parser.add_argument("--limit", type=int, default=5, help="Number of conversations to classify.")
  parser.add_argument("--model", default="gpt-5-nano", help="Model to use for cached prompting.")
  parser.add_argument("--temperature", type=float, default=1.0, help="LLM temperature.")
  parser.add_argument("--max-output-tokens", type=int, default=80, help="Max output tokens.")
  parser.add_argument("--prepared-table", default="jira_prepared_conversations", help="Prepared table name.")
  parser.add_argument("--print-prompt", action="store_true", help="Print the taxonomy system prompt block.")
  parser.add_argument("--debug-prompts", action="store_true", help="Print system/user messages for each call.")
  parser.add_argument("--debug-response", action="store_true", help="Print raw OpenAI response JSON.")
  parser.add_argument("--no-cache", action="store_true", help="Disable prompt caching (omit cache_control).")
  parser.add_argument("--cache-key", default="contact_taxonomy_v2", help="Cache key metadata to force reuse across calls.")
  parser.add_argument("--summary-file", default="local_data/cache_prompt_summary.jsonl", help="Path to write JSONL with token stats/results.")
  return parser.parse_args()


def ensure_supabase() -> Client:
  url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
  key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
  if not url or not key:
    raise SystemExit("Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY.")
  return create_client(url, key)


def ensure_openai_client() -> OpenAI:
  api_key = os.getenv("OPENAI_API_KEY")
  if not api_key:
    raise SystemExit("Missing OPENAI_API_KEY.")
  return OpenAI(api_key=api_key, default_headers={"OpenAI-Beta": "assistants=v2"})


def fetch_active_taxonomy(client: Client) -> List[Dict[str, Any]]:
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
  return reasons_resp.data or []


def build_taxonomy_block(reasons: List[Dict[str, Any]]) -> str:
  lines: List[str] = []
  active = [r for r in reasons if (r.get("status") or "").upper() != "CANCELLED"]
  for idx, reason in enumerate(active, start=1):
    topic = (reason.get("topic") or "").strip()
    sub = (reason.get("sub_reason") or "").strip()
    description = (reason.get("description") or "").strip()
    keywords = reason.get("keywords") or []
    parts = [f"{idx}. {topic}{' — ' + sub if sub else ''}"]
    if description:
      parts.append(f"When: {description}")
    if keywords:
      parts.append(f"Keywords: {', '.join(keywords)}")
    lines.append(" | ".join(parts))
  return "\n".join(lines)


def fetch_sample_prepared(client: Client, table: str, days: int, limit: int) -> List[Dict[str, Any]]:
  cutoff = datetime.now(timezone.utc) - timedelta(days=max(days, 1))
  cutoff_iso = cutoff.isoformat()
  resp = (
    client.table(table)
    .select("issue_key,payload,prepared_at")
    .gte("prepared_at", cutoff_iso)
    .order("prepared_at", desc=True)
    .limit(limit)
    .execute()
  )
  rows = resp.data or []
  samples: List[Dict[str, Any]] = []
  for row in rows:
    issue_key = (row.get("issue_key") or "").strip()
    payload = row.get("payload") or {}
    if not issue_key or not isinstance(payload, dict):
      continue
    samples.append({"issue_key": issue_key, "payload": payload})
  return samples


def build_transcript(payload: Dict[str, Any]) -> str:
  comments_raw = payload.get("comments") or []
  comments = cq.parse_comments(comments_raw if isinstance(comments_raw, list) else [])
  return cq.build_transcript(comments)


def classify_one(
  client: OpenAI,
  model: str,
  temperature: float,
  max_output_tokens: int,
  taxonomy_block: str,
  transcript: str,
  issue_key: str,
  debug_prompts: bool = False,
  debug_response: bool = False,
  use_cache: bool = True,
  cache_key: Optional[str] = None,
) -> str:
  system_msg: Dict[str, Any] = {
    "role": "system",
    "content": taxonomy_block,
  }
  if use_cache:
    system_msg["cache_control"] = {"type": "ephemeral", "max_age_seconds": 3600}
  if cache_key:
    system_msg["metadata"] = {"cache_key": cache_key}
  user_msg = {
    "role": "user",
    "content": (
      "You are a classifier. Pick the single best contact taxonomy label from the system list.\n"
      f"Issue key: {issue_key}\n"
      f"Transcript:\n{transcript}\n\n"
      "Return only the label text; if unsure, return 'Other'."
    ),
  }
  if debug_prompts:
    print("=== SYSTEM MESSAGE (cached) ===")
    print(json.dumps(system_msg, indent=2))
    print("=== USER MESSAGE (dynamic) ===")
    print(json.dumps(user_msg, indent=2))
  extra_body = {"max_completion_tokens": max_output_tokens}
  resp = client.chat.completions.create(
    model=model,
    temperature=temperature,
    messages=[system_msg, user_msg],
    extra_body=extra_body,
  )
  if debug_response:
    print("=== RAW RESPONSE ===")
    print(json.dumps(resp.to_dict(), indent=2))
  return resp


def main() -> int:
  load_dotenv(override=False)
  args = parse_args()

  sb = ensure_supabase()
  oa = ensure_openai_client()

  reasons = fetch_active_taxonomy(sb)
  taxonomy_block = build_taxonomy_block(reasons)

  if args.print_prompt:
    print("=== Cached system prompt (taxonomy) ===")
    print(taxonomy_block)

  samples = fetch_sample_prepared(sb, args.prepared_table, args.days, args.limit)
  if not samples:
    print("No prepared conversations found.")
    return 0

  summary_path = Path(args.summary_file)
  summary_path.parent.mkdir(parents=True, exist_ok=True)
  summary_file = summary_path.open("a", encoding="utf-8")

  total_prompt = 0
  total_effective_prompt = 0
  total_completion = 0
  total_calls = 0

  for sample in samples:
    issue_key = sample["issue_key"]
    transcript = build_transcript(sample["payload"])
    resp = classify_one(
      client=oa,
      model=args.model,
      temperature=args.temperature,
      max_output_tokens=args.max_output_tokens,
      taxonomy_block=taxonomy_block,
      transcript=transcript,
      issue_key=issue_key,
      debug_prompts=args.debug_prompts,
      debug_response=args.debug_response,
      use_cache=not args.no_cache,
      cache_key=None if args.no_cache else args.cache_key,
    )
    label = (resp.choices[0].message.content or "").strip()
    usage = getattr(resp, "usage", None)
    prompt_tokens = getattr(usage, "prompt_tokens", None) if usage else None
    completion_tokens = getattr(usage, "completion_tokens", None) if usage else None
    prompt_details = getattr(usage, "prompt_tokens_details", None) if usage else None
    detail_dict = prompt_details if isinstance(prompt_details, dict) else None
    cached_tokens = None
    if isinstance(detail_dict, dict):
      cached_tokens = detail_dict.get("cached_tokens") or detail_dict.get("cache_read")
    effective_prompt = prompt_tokens
    if prompt_tokens is not None and cached_tokens:
      effective_prompt = max(0, prompt_tokens - cached_tokens)
    print(
      f"{issue_key} -> {label} | prompt_tokens={prompt_tokens}, cached_tokens={cached_tokens}, "
      f"effective_prompt={effective_prompt}, completion_tokens={completion_tokens}"
    )
    summary_file.write(
      json.dumps(
        {
          "issue_key": issue_key,
          "label": label,
          "model": args.model,
          "prompt_tokens": prompt_tokens,
          "completion_tokens": completion_tokens,
          "effective_prompt_tokens": effective_prompt,
          "prompt_tokens_details": detail_dict,
          "no_cache": args.no_cache,
        }
      )
      + "\n"
    )
    if prompt_tokens:
      total_prompt += prompt_tokens
    if effective_prompt:
      total_effective_prompt += effective_prompt
    if completion_tokens:
      total_completion += completion_tokens
    total_calls += 1

  summary_file.close()
  print(
    f"Summary written to {summary_path} "
    f"(calls={total_calls}, prompt_tokens={total_prompt}, effective_prompt_tokens={total_effective_prompt}, "
    f"completion_tokens={total_completion})"
  )

  return 0


if __name__ == "__main__":
  raise SystemExit(main())
