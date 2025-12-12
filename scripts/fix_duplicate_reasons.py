"""
Set contact_reason_change = false and restore contact_reason to the original when the
original contact reason was "Duplicate". Safe to run multiple times.

Usage:
  export SUPABASE_URL=...
  export SUPABASE_SERVICE_ROLE_KEY=...
  python scripts/fix_duplicate_reasons.py
"""

from __future__ import annotations

import os
from typing import Iterable, List

try:
    from supabase import Client, create_client
except ImportError:
    raise SystemExit("supabase-py is required. Run 'pip install supabase>=2.4.0'.")

SUPABASE_URL = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
TABLE = "jira_processed_conversations"


def get_client() -> Client:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise SystemExit("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def fetch_duplicate_rows(client: Client, chunk: int = 1000) -> List[dict]:
    rows: List[dict] = []
    offset = 0
    while True:
        resp = (
            client.table(TABLE)
            .select("issue_key, contact_reason_original, contact_reason, contact_reason_change, reason_override_why")
            .ilike("contact_reason_original", "duplicate")
            .range(offset, offset + chunk - 1)
            .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < chunk:
            break
        offset += len(batch)
    return rows


def update_duplicates(client: Client, issue_keys: Iterable[str]) -> int:
    keys = list(issue_keys)
    if not keys:
        return 0
    updated = 0
    chunk_size = 500
    for start in range(0, len(keys), chunk_size):
        chunk = keys[start : start + chunk_size]
        resp = (
            client.table(TABLE)
            .update(
                {
                    "contact_reason_change": False,
                    "contact_reason": "Duplicate",
                    "reason_override_why": None,
                }
            )
            .in_("issue_key", chunk)
            .execute()
        )
        updated += len(resp.data or [])
    return updated


def main():
    client = get_client()
    rows = fetch_duplicate_rows(client)
    keys_to_fix = [row["issue_key"] for row in rows if row.get("contact_reason_change")]

    print(f"Found {len(rows)} tickets with original reason 'Duplicate'.")
    print(f"{len(keys_to_fix)} of them have contact_reason_change = true and will be corrected.")

    updated = update_duplicates(client, keys_to_fix)
    print(f"Updated {updated} rows.")

    # Show a quick sample after update
    sample_keys = keys_to_fix[:10] if keys_to_fix else []
    if sample_keys:
        sample = (
            client.table(TABLE)
            .select("issue_key, contact_reason_original, contact_reason, contact_reason_change, reason_override_why")
            .in_("issue_key", sample_keys)
            .execute()
        )
        print("Sample after update:")
        for row in sample.data or []:
            print(
                f"{row['issue_key']}: orig={row['contact_reason_original']}, "
                f"corr={row['contact_reason']}, flag={row['contact_reason_change']}, "
                f"reason_override_why={row['reason_override_why']}"
            )


if __name__ == "__main__":
    main()
