"""Helpers for labelling Port agents from a shared CSV lookup."""
from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Dict, Mapping
import unicodedata

PORT_EMPLOYEE_PREFIX = "712020:"
PORT_ROLE_UNKNOWN = "NONE"
PORT_ROLE_TIER1_LABEL = "TIER1"
PORT_ROLE_TIER2_LABEL = "TIER2"
PORT_ROLE_NON_AGENT_LABEL = "NON_AGENT"


def normalise_name_key(value: str | None) -> str:
    """Return a canonical form for comparing display names."""
    if value is None:
        return ""
    return unicodedata.normalize("NFKC", value).casefold().strip()


@dataclass(frozen=True)
class PortRoleLookup:
    """In-memory representation of manual Port role overrides."""

    by_user_id: Mapping[str, str]
    by_name_key: Mapping[str, str]

    @staticmethod
    def empty() -> "PortRoleLookup":
        return PortRoleLookup(MappingProxyType({}), MappingProxyType({}))


def _role_from_cell(value: str | None) -> str | None:
    role = (value or "").strip().upper()
    if role in {PORT_ROLE_TIER1_LABEL, PORT_ROLE_TIER2_LABEL, PORT_ROLE_NON_AGENT_LABEL}:
        return role
    return None


def load_port_role_lookup(csv_path: Path) -> PortRoleLookup:
    """Load tier overrides from ``csv_path`` if it exists."""
    if not csv_path.exists():
        return PortRoleLookup.empty()

    by_user_id: Dict[str, str] = {}
    by_name_key: Dict[str, str] = {}

    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        expected = {"user_id", "display_name", "port_role"}
        if not expected.issubset(reader.fieldnames or {}):
            raise ValueError("port role CSV must contain 'user_id', 'display_name', and 'port_role' headers")

        for row in reader:
            role = _role_from_cell(row.get("port_role"))
            if not role:
                continue

            user_id = (row.get("user_id") or "").strip()
            if user_id:
                by_user_id[user_id] = role

            display_name = (row.get("display_name") or "").strip()
            if display_name:
                key = normalise_name_key(display_name)
                if key:
                    by_name_key[key] = role

    return PortRoleLookup(MappingProxyType(by_user_id), MappingProxyType(by_name_key))


def determine_port_role(user_id: str, display_name: str, lookup: PortRoleLookup) -> str:
    """Return the configured port agent tier for the user if applicable."""
    role = lookup.by_user_id.get(user_id)
    if role:
        return role

    name_key = normalise_name_key(display_name)
    name_role = lookup.by_name_key.get(name_key)
    if name_role:
        return name_role

    if user_id.startswith(PORT_EMPLOYEE_PREFIX):
        return PORT_ROLE_TIER1_LABEL
    return PORT_ROLE_UNKNOWN
