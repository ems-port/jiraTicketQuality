#!/usr/bin/env python3
"""
Parse the New_Taxonomy.csv into ContactTaxonomyReason payloads, emit prompt text,
and optionally upload as a new version to Supabase.

Examples:
  # Generate JSON + prompt only
  python scripts/taxonomy_v2_import.py --csv New_Taxonomy.csv

  # Upload as version 2 with status NEW (no prompt keywords)
  python scripts/taxonomy_v2_import.py --csv New_Taxonomy.csv --upload --version 2 --status NEW --notes "V2 draft"

Environment for upload:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""

import argparse
import csv
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from dotenv import load_dotenv

try:
  from supabase import create_client, Client  # type: ignore
except ImportError:
  create_client = None  # type: ignore
  Client = Any  # type: ignore

STATUS_VALUES = {"NEW", "IN_USE", "OBSOLETED", "CANCELLED"}


def clean_string(value: Any) -> str:
  return value.strip() if isinstance(value, str) else ""


def parse_keywords(raw: Any) -> List[str]:
  if not raw:
    return []
  return [kw.strip() for kw in str(raw).split(",") if kw and kw.strip()]


def parse_csv(path: Path, include_keywords: bool) -> List[Dict[str, Any]]:
  with path.open(newline="", encoding="utf-8") as handle:
    reader = csv.DictReader(handle)
    reasons: List[Dict[str, Any]] = []
    for idx, row in enumerate(reader):
      topic = clean_string(row.get("Main Contact reason"))
      if not topic:
        continue
      sub_reason = clean_string(row.get("Sub Reason")) or None
      description = clean_string(row.get("When to use this")) or None
      keywords = parse_keywords(row.get("Key words")) if include_keywords else []
      action = clean_string(row.get("Action")).lower()
      status = "CANCELLED" if "remove" in action else "IN_USE"
      reasons.append(
        {
          "topic": topic,
          "sub_reason": sub_reason,
          "description": description,
          "keywords": keywords or None,
          "sort_order": idx,
          "status": status,
        }
      )
  return reasons


def flatten_reasons(reasons: Sequence[Dict[str, Any]]) -> List[str]:
  labels: List[str] = []
  for reason in reasons:
    if (reason.get("status") or "IN_USE") == "CANCELLED":
      continue
    topic = clean_string(reason.get("topic"))
    sub = clean_string(reason.get("sub_reason"))
    if not topic:
      continue
    labels.append(f"{topic} - {sub}" if sub else topic)
  return labels


def build_prompt_block(reasons: Sequence[Dict[str, Any]], include_keywords: bool) -> str:
  lines: List[str] = []
  active = [r for r in reasons if (r.get("status") or "IN_USE") != "CANCELLED"]
  for idx, reason in enumerate(active, start=1):
    topic = clean_string(reason.get("topic"))
    sub = clean_string(reason.get("sub_reason"))
    description = clean_string(reason.get("description"))
    keywords = reason.get("keywords") if include_keywords else []
    parts = [f"{idx}. {topic}{' — ' + sub if sub else ''}"]
    if description:
      parts.append(f"When: {description}")
    if include_keywords and keywords:
      parts.append(f"Keywords: {', '.join(keywords)}")
    lines.append(" | ".join(parts))
  return "\n".join(lines)


def save_outputs(reasons: List[Dict[str, Any]], labels: List[str], prompt_block: str, out_json: Path, out_prompt: Path) -> None:
  out_json.parent.mkdir(parents=True, exist_ok=True)
  out_prompt.parent.mkdir(parents=True, exist_ok=True)
  payload = {
    "version": None,  # filled during upload or explicitly provided
    "reasons": reasons,
    "labels": labels,
    "prompt_block": prompt_block,
  }
  out_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
  out_prompt.write_text(f"{prompt_block}\n", encoding="utf-8")


def get_supabase_client() -> Optional[Client]:
  if create_client is None:
    return None
  url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
  key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
  if not url or not key:
    return None
  return create_client(url, key)


def next_version(client: Client) -> int:
  resp = client.table("contact_taxonomy_versions").select("version").order("version", desc=True).limit(1).execute()
  data = getattr(resp, "data", None) or []
  return int(data[0]["version"]) + 1 if data else 1


def upload_version(
  client: Client,
  reasons: List[Dict[str, Any]],
  version: int,
  status: str,
  notes: Optional[str],
  created_by: str,
) -> Dict[str, Any]:
  # If promoting to IN_USE, clear any existing IN_USE first to satisfy the partial unique index.
  if status == "IN_USE":
    client.table("contact_taxonomy_versions").update({"status": "OBSOLETED"}).eq("status", "IN_USE").execute()

  version_row = {
    "version": version,
    "notes": notes,
    "status": status,
    "created_by": created_by,
  }
  version_resp = client.table("contact_taxonomy_versions").insert(version_row).execute()
  if getattr(version_resp, "error", None):
    raise RuntimeError(version_resp.error)
  data = version_resp.data or []
  if not data or not data[0].get("id"):
    raise RuntimeError("Insert did not return id for contact_taxonomy_versions.")
  version_id = data[0]["id"]

  reason_rows = []
  for reason in reasons:
    reason_rows.append(
      {
        "version_id": version_id,
        "topic": reason["topic"],
        "sub_reason": reason.get("sub_reason"),
        "description": reason.get("description"),
        "keywords": reason.get("keywords"),
        "sort_order": reason.get("sort_order", 0),
        "status": reason.get("status") or "IN_USE",
      }
    )
  reason_resp = client.table("contact_taxonomy_reasons").insert(reason_rows).execute()
  if getattr(reason_resp, "error", None):
    raise RuntimeError(reason_resp.error)

  return {"version_id": version_id, "created_at": data[0].get("created_at")}


def main() -> None:
  load_dotenv(override=False)
  parser = argparse.ArgumentParser(description="Import taxonomy V2, generate prompt, optionally upload to Supabase.")
  parser.add_argument("--csv", default="New_Taxonomy.csv", help="Path to the taxonomy CSV.")
  parser.add_argument("--out-json", default="local_data/taxonomy_v2.json", help="Where to write JSON payload.")
  parser.add_argument("--out-prompt", default="local_data/taxonomy_v2_prompt.txt", help="Where to write prompt block.")
  parser.add_argument("--version", type=int, help="Version number to store; defaults to next available when uploading.")
  parser.add_argument("--status", default="NEW", choices=sorted(STATUS_VALUES), help="Version status when uploading.")
  parser.add_argument("--notes", default=None, help="Optional notes for the version record.")
  parser.add_argument("--created-by", default="taxonomy_v2_import.py", help="created_by value when uploading.")
  parser.add_argument("--upload", action="store_true", help="If set, upload to Supabase after parsing.")
  parser.add_argument("--include-keywords-in-payload", action="store_true", help="Store keywords column in Supabase payload.")
  parser.add_argument("--include-keywords-in-prompt", action="store_true", help="Include keywords in the generated prompt block.")
  args = parser.parse_args()

  csv_path = Path(args.csv)
  out_json = Path(args.out_json)
  out_prompt = Path(args.out_prompt)

  reasons = parse_csv(csv_path, include_keywords=args.include_keywords_in_payload)
  labels = flatten_reasons(reasons)
  prompt_block = build_prompt_block(reasons, include_keywords=args.include_keywords_in_prompt)
  save_outputs(reasons, labels, prompt_block, out_json, out_prompt)

  print(f"Parsed {len(reasons)} rows from {csv_path.name}.")
  print(f"- JSON: {out_json}")
  print(f"- Prompt: {out_prompt} (keywords in prompt: {'yes' if args.include_keywords_in_prompt else 'no'})")

  if not args.upload:
    return

  client = get_supabase_client()
  if client is None:
    raise SystemExit("Supabase client unavailable; set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")

  version_number = args.version if args.version is not None else next_version(client)
  status = args.status.upper()
  if status not in STATUS_VALUES:
    raise SystemExit(f"Invalid status: {status}")

  uploaded = upload_version(
    client=client,
    reasons=reasons,
    version=version_number,
    status=status,
    notes=args.notes,
    created_by=args.created_by,
  )
  print(f"Uploaded version {version_number} with status {status}.")
  print(f"version_id={uploaded['version_id']}, created_at={uploaded.get('created_at')}")


if __name__ == "__main__":
  main()
