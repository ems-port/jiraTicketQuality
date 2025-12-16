#!/usr/bin/env python3
"""Seed the project_config table with defaults from the existing prompts and port_roles.csv."""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any, Dict, Tuple, Mapping

from dotenv import load_dotenv
from supabase import Client, create_client  # type: ignore

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from analysis.project_config import (  # noqa: E402
    CONFIG_TYPES,
    DEFAULT_INTERNAL_USERS,
    DEFAULT_PROMPT_SECTIONS,
    DEFAULT_CONTACT_TAXONOMY,
    SYSTEM_PROMPT_DEFAULT,
    PROMPT_HEADER_DEFAULT,
    PROMPT_JSON_SCHEMA_DEFAULT,
    ProjectConfigType,
    compute_checksum,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed Supabase project_config entries.")
    parser.add_argument("--supabase-url", default=os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL"))
    parser.add_argument("--supabase-key", default=os.getenv("SUPABASE_SERVICE_ROLE_KEY"))
    parser.add_argument("--updated-by", default="seed_script", help="Value for updated_by column.")
    parser.add_argument(
        "--supabase-db-url",
        default=os.getenv("SUPABASE_DB_URL"),
        help="Optional Postgres connection string for running DDL before seeding."
    )
    return parser.parse_args()


PROJECT_CONFIG_DDL = """
create table if not exists public.project_config (
    id uuid primary key default gen_random_uuid(),
    type text not null,
    payload jsonb not null,
    version integer not null default 1,
    checksum text,
    is_active boolean not null default true,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    updated_by text,
    constraint project_config_type_unique unique (type)
);
create unique index if not exists idx_project_config_type_active on public.project_config (type) where is_active;
create index if not exists idx_project_config_updated_at on public.project_config (updated_at desc);
create table if not exists public.project_config_history (
    id uuid primary key default gen_random_uuid(),
    project_config_id uuid,
    type text not null,
    payload jsonb not null,
    version integer not null,
    checksum text,
    created_at timestamptz not null default timezone('utc', now()),
    updated_by text
);
create index if not exists idx_project_config_history_type on public.project_config_history (type);
create index if not exists idx_project_config_history_created_at on public.project_config_history (created_at desc);
create table if not exists public.contact_taxonomy_versions (
    id uuid primary key default gen_random_uuid(),
    version integer not null default 1,
    notes text,
    status text not null default 'NEW' check (status in ('NEW', 'IN_USE', 'OBSOLETED', 'CANCELLED')),
    created_at timestamptz not null default timezone('utc', now()),
    created_by text
);
create unique index if not exists idx_contact_taxonomy_in_use on public.contact_taxonomy_versions (status) where status = 'IN_USE';
create index if not exists idx_contact_taxonomy_version on public.contact_taxonomy_versions (version desc);
create index if not exists idx_contact_taxonomy_created_at on public.contact_taxonomy_versions (created_at desc);
create table if not exists public.contact_taxonomy_reasons (
    id uuid primary key default gen_random_uuid(),
    version_id uuid not null references public.contact_taxonomy_versions(id) on delete cascade,
    topic text not null,
    sub_reason text,
    description text,
    keywords text[],
    sort_order integer not null default 0,
    status text not null default 'IN_USE' check (status in ('NEW', 'IN_USE', 'OBSOLETED', 'CANCELLED')),
    created_at timestamptz not null default timezone('utc', now())
);
create index if not exists idx_contact_taxonomy_reasons_version on public.contact_taxonomy_reasons (version_id);
create index if not exists idx_contact_taxonomy_reasons_order on public.contact_taxonomy_reasons (version_id, sort_order);
create index if not exists idx_contact_taxonomy_reasons_status on public.contact_taxonomy_reasons (status);
create unique index if not exists idx_contact_taxonomy_reason_unique on public.contact_taxonomy_reasons (version_id, topic, coalesce(sub_reason, ''));
alter table if exists public.contact_taxonomy_versions drop column if exists labels;
"""


def ensure_table(db_url: str | None) -> None:
    if not db_url:
        return
    try:
        import psycopg  # type: ignore
    except ImportError:
        print("psycopg not installed; skipping automatic DDL.", file=sys.stderr)
        return
    try:
        with psycopg.connect(db_url, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(PROJECT_CONFIG_DDL)
        print("Ensured project_config table exists.")
    except Exception as exc:
        print(f"Warning: unable to run project_config DDL: {exc}", file=sys.stderr)


def upsert_entry(
    client: Client, *, config_type: ProjectConfigType, payload: Any, updated_by: str
) -> Tuple[int, str]:
    checksum = compute_checksum(payload)
    existing_version = 0
    existing_id = None
    resp = client.table("project_config").select("id,version").eq("type", config_type).limit(1).execute()
    data = getattr(resp, "data", None) or []
    if data:
        existing_id = data[0].get("id")
        existing_version = int(data[0].get("version") or 0)
    version = existing_version + 1 if existing_version else 1
    payload_obj: Dict[str, Any] = {
        "type": config_type,
        "payload": payload,
        "version": version,
        "checksum": checksum,
        "is_active": True,
        "updated_by": updated_by,
    }
    if existing_id:
        payload_obj["id"] = existing_id
        client.table("project_config").update(payload_obj).eq("id", existing_id).execute()
    else:
        client.table("project_config").insert(payload_obj).execute()
    return version, checksum


def seed_contact_taxonomy_versions(client: Client, updated_by: str) -> None:
    reasons = []
    if isinstance(DEFAULT_CONTACT_TAXONOMY, Mapping):
        raw_reasons = DEFAULT_CONTACT_TAXONOMY.get("reasons")
        if isinstance(raw_reasons, list):
            for entry in raw_reasons:
                if not isinstance(entry, Mapping):
                    continue
                topic = str(entry.get("topic") or "").strip()
                if not topic:
                    continue
                reasons.append(
                    {
                        "topic": topic,
                        "sub_reason": str(entry.get("sub_reason") or "").strip() or None,
                        "description": str(entry.get("description") or "").strip() or None,
                        "keywords": entry.get("keywords") if isinstance(entry.get("keywords"), list) else None,
                        "status": (entry.get("status") or "IN_USE") if isinstance(entry, Mapping) else "IN_USE",
                    }
                )
        if not reasons:
            labels = DEFAULT_CONTACT_TAXONOMY.get("labels")
            if isinstance(labels, list):
                reasons = [{"topic": str(label).strip()} for label in labels if str(label).strip()]
    elif isinstance(DEFAULT_CONTACT_TAXONOMY, list):
        reasons = [{"topic": str(label).strip(), "status": "IN_USE"} for label in DEFAULT_CONTACT_TAXONOMY if str(label).strip()]
    if not reasons:
        return
    try:
        resp = client.table("contact_taxonomy_versions").select("id").limit(1).execute()
    except Exception as exc:  # pragma: no cover - missing table or schema cache
        print(f"Skipping contact_taxonomy_versions seed (table missing?): {exc}", file=sys.stderr)
        return
    if getattr(resp, "data", None):
        return
    try:
        version_resp = (
            client.table("contact_taxonomy_versions")
            .insert(
                {
                    "version": 1,
                    "notes": "seed",
                    "status": "IN_USE",
                    "created_by": updated_by,
                }
            )
            .select("id")
            .limit(1)
            .execute()
        )
    except Exception as exc:  # pragma: no cover - runtime
        print(f"Unable to seed contact_taxonomy_versions: {exc}", file=sys.stderr)
        return
    version_id = None
    data = getattr(version_resp, "data", None) or []
    if data and isinstance(data, list):
        version_id = data[0].get("id")
    if not version_id:
        return
    rows = []
    for idx, reason in enumerate(reasons):
        rows.append(
            {
                "version_id": version_id,
                "topic": reason.get("topic"),
                "sub_reason": reason.get("sub_reason"),
                "description": reason.get("description"),
                "keywords": reason.get("keywords"),
                "sort_order": idx,
                "status": reason.get("status") or "IN_USE",
            }
        )
    try:
        client.table("contact_taxonomy_reasons").insert(rows).execute()
    except Exception as exc:  # pragma: no cover - runtime
        print(f"Unable to seed contact_taxonomy_reasons: {exc}", file=sys.stderr)


def main() -> int:
    load_dotenv(override=False)
    args = parse_args()
    if not args.supabase_url or not args.supabase_key:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Aborting.", file=sys.stderr)
        return 1
    ensure_table(args.supabase_db_url)
    client = create_client(args.supabase_url, args.supabase_key)

    defaults: Dict[ProjectConfigType, Any] = {"internal_users": DEFAULT_INTERNAL_USERS}
    for key in CONFIG_TYPES:
        if key in DEFAULT_PROMPT_SECTIONS:
            defaults[key] = DEFAULT_PROMPT_SECTIONS[key]
        if key == "system_prompt":
            defaults[key] = SYSTEM_PROMPT_DEFAULT
        if key == "contact_taxonomy":
            defaults[key] = DEFAULT_CONTACT_TAXONOMY
        if key == "prompt_header":
            defaults[key] = PROMPT_HEADER_DEFAULT
        if key == "prompt_json_schema":
            defaults[key] = PROMPT_JSON_SCHEMA_DEFAULT

    for config_type, payload in defaults.items():
        version, checksum = upsert_entry(client, config_type=config_type, payload=payload, updated_by=args.updated_by)
        print(f"Upserted {config_type}: version={version} checksum={checksum[:8]}...")
    seed_contact_taxonomy_versions(client, args.updated_by)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
