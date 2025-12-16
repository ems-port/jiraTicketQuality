#!/usr/bin/env python3
"""Backfill contact_taxonomy_reasons rows from legacy labels/default taxonomy."""
from __future__ import annotations

import os
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path
from typing import Iterable, List, Tuple

from dotenv import load_dotenv
from supabase import Client, create_client  # type: ignore

try:
    from analysis.default_taxonomy import AGENT_CONTACT_HEADINGS
except Exception:
    try:
        from default_taxonomy import AGENT_CONTACT_HEADINGS  # type: ignore
    except Exception:
        AGENT_CONTACT_HEADINGS: Tuple[str, ...] = ()


def parse_labels_to_reasons(labels: Iterable[str]) -> List[dict]:
    reasons: List[dict] = []
    for idx, raw in enumerate(labels):
        label = str(raw or "").strip()
        if not label:
            continue
        topic, sub = (label.split(" - ", 1) + [""])[:2]
        reasons.append(
            {
                "topic": topic.strip(),
                "sub_reason": sub.strip() or None,
                "description": None,
                "keywords": None,
                "sort_order": idx,
                "status": "IN_USE",
            }
        )
    return reasons


def ensure_client() -> Client:
    supabase_url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        raise SystemExit("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    return create_client(supabase_url, supabase_key)


def fetch_versions(client: Client):
    try:
        resp = client.table("contact_taxonomy_versions").select("id,version,status,labels").execute()
        return getattr(resp, "data", None) or []
    except Exception:
        # labels column may be dropped; fetch minimal columns instead
        resp = client.table("contact_taxonomy_versions").select("id,version,status").execute()
        return getattr(resp, "data", None) or []


def main() -> int:
    load_dotenv(override=False)
    client = ensure_client()

    if not AGENT_CONTACT_HEADINGS:
        module_path = Path(__file__).resolve().parent.parent / "analysis" / "default_taxonomy.py"
        if module_path.exists():
            try:
                module = SourceFileLoader("contact_taxonomy_loader", str(module_path)).load_module()
                headings = getattr(module, "AGENT_CONTACT_HEADINGS", ())
                if headings:
                    globals()["AGENT_CONTACT_HEADINGS"] = tuple(headings)  # type: ignore
            except Exception as exc:  # pragma: no cover - defensive
                print(f"[warn] Unable to load defaults from {module_path}: {exc}", file=sys.stderr)

    versions = fetch_versions(client)
    if not versions:
        print("No contact_taxonomy_versions found.", file=sys.stderr)
        return 0

    defaults = AGENT_CONTACT_HEADINGS or ()
    backfilled = 0
    skipped = 0

    for version_row in versions:
        version_id = version_row.get("id")
        version_number = version_row.get("version")
        if not version_id:
            continue
        try:
            existing = (
                client.table("contact_taxonomy_reasons")
                .select("id")
                .eq("version_id", version_id)
                .limit(1)
                .execute()
            )
            if getattr(existing, "data", None):
                skipped += 1
                continue
        except Exception as exc:  # pragma: no cover - runtime safety
            print(f"[warn] Unable to check existing reasons for version {version_number}: {exc}", file=sys.stderr)
            continue

        labels = version_row.get("labels")
        label_list: List[str] = []
        if isinstance(labels, list):
            label_list = [str(label).strip() for label in labels if str(label).strip()]
        if not label_list and defaults:
            label_list = list(defaults)
        if not label_list:
            print(f"[warn] No labels found for version {version_number}; skipping.", file=sys.stderr)
            continue

        reasons = parse_labels_to_reasons(label_list)
        if not reasons:
            print(f"[warn] No valid reasons derived for version {version_number}; skipping.", file=sys.stderr)
            continue

        try:
            client.table("contact_taxonomy_reasons").insert(
                [
                    {
                        "version_id": version_id,
                        "topic": reason["topic"],
                        "sub_reason": reason["sub_reason"],
                        "description": reason["description"],
                        "keywords": reason["keywords"],
                        "sort_order": reason["sort_order"],
                    }
                    for reason in reasons
                ]
            ).execute()
            backfilled += 1
            print(f"Backfilled version {version_number} with {len(reasons)} reasons.")
        except Exception as exc:  # pragma: no cover - runtime safety
            print(f"[warn] Failed to insert reasons for version {version_number}: {exc}", file=sys.stderr)
            continue

    print(f"Done. Backfilled {backfilled} version(s); {skipped} skipped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
