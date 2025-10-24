#!/usr/bin/env python3
"""
Build a lookup table that maps Jira account identifiers to display names.

The script scans CSV exports matching ``jira*.csv`` inside ``local_data`` by
default, extracts both agent (Assignee) and customer (Reporter) identifiers,
and writes a denormalised lookup CSV with the columns ``user_id`` and
``display_name``.

Example:
    python analysis/deanonymize_users.py \\
        --input-dir local_data \\
        --pattern 'jira*.csv' \\
        --output local_data/user_lookup.csv
"""
from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
from fnmatch import fnmatch
from pathlib import Path
from typing import Dict


ASSIGNEE_ID_COL = "Assignee Id"
ASSIGNEE_NAME_COL = "Assignee"
REPORTER_ID_COL = "Reporter Id"
REPORTER_NAME_COL = "Reporter"


@dataclass
class NameRecord:
    """Keep track of the various display names seen for a user id."""

    primary: str
    alternates: set[str]

    def add(self, display_name: str) -> None:
        """Record an additional display name if it differs from the primary."""
        if display_name and display_name != self.primary:
            self.alternates.add(display_name)


def iter_csv_files(root: Path, pattern: str) -> list[Path]:
    """Return CSV files under ``root`` matching ``pattern`` sorted by name."""
    matches = sorted(root.glob(pattern))
    if matches:
        return matches
    lowered_pattern = pattern.lower()
    fallback = [
        path
        for path in root.glob("*.csv")
        if fnmatch(path.name.lower(), lowered_pattern)
    ]
    return sorted(fallback)


def normalise(value: str | None) -> str:
    """Strip whitespace and coerce sentinel text like 'nan' to empty strings."""
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in {"", "nan", "null", "none"} else text


def read_lookup_data(csv_path: Path, records: Dict[str, NameRecord]) -> None:
    """Accumulate user id to display name pairs from the provided CSV."""
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        missing_columns = {
            column
            for column in (ASSIGNEE_ID_COL, ASSIGNEE_NAME_COL, REPORTER_ID_COL, REPORTER_NAME_COL)
            if column not in reader.fieldnames
        }
        if missing_columns:
            raise ValueError(
                f"{csv_path} missing columns: {', '.join(sorted(missing_columns))}"
            )
        for row in reader:
            add_user(records, normalise(row.get(ASSIGNEE_ID_COL)), normalise(row.get(ASSIGNEE_NAME_COL)))
            add_user(records, normalise(row.get(REPORTER_ID_COL)), normalise(row.get(REPORTER_NAME_COL)))


def add_user(records: Dict[str, NameRecord], user_id: str, display_name: str) -> None:
    """Update the aggregated lookup table."""
    if not user_id:
        return
    if not display_name:
        display_name = "<missing name>"
    record = records.get(user_id)
    if record is None:
        records[user_id] = NameRecord(primary=display_name, alternates=set())
        return
    record.add(display_name)


def write_lookup_csv(output_path: Path, records: Dict[str, NameRecord]) -> None:
    """Write the aggregated lookup table to ``output_path`` sorted by user id."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["user_id", "display_name"])
        for user_id in sorted(records):
            record = records[user_id]
            writer.writerow([user_id, record.primary])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=Path("local_data"),
        help="Directory that contains Jira CSV exports (default: local_data).",
    )
    parser.add_argument(
        "--pattern",
        default="jira*.csv",
        help="Glob pattern used to select Jira CSV exports (default: jira*.csv).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("local_data/user_lookup.csv"),
        help="Destination CSV path for the denormalised lookup (default: local_data/user_lookup.csv).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    csv_dir = args.input_dir
    if not csv_dir.exists():
        raise FileNotFoundError(f"Input directory not found: {csv_dir}")

    csv_files = iter_csv_files(csv_dir, args.pattern)
    if not csv_files:
        raise FileNotFoundError(
            f"No files matching pattern '{args.pattern}' found in {csv_dir}"
        )

    records: Dict[str, NameRecord] = {}

    for csv_path in csv_files:
        read_lookup_data(csv_path, records)

    # Track user ids that appeared with multiple display names.
    conflicts = {uid: rec.alternates for uid, rec in records.items() if rec.alternates}

    write_lookup_csv(args.output, records)

    total_users = len(records)

    print(f"Wrote {total_users} unique users to {args.output}")
    if conflicts:
        print("The following user_ids had multiple display names:")
        for user_id, names in sorted(conflicts.items()):
            name_list = ", ".join(sorted(names))
            print(f"  {user_id}: primary='{records[user_id].primary}' alternates=[{name_list}]")


if __name__ == "__main__":
    main()
