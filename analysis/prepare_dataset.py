#!/usr/bin/env python3
"""Convert a Jira CSV export into a JSONL file suitable for LLM processing."""

from __future__ import annotations

import json
import random
import re
from pathlib import Path
from typing import Dict, Iterable, List, Optional

import pandas as pd
from dateutil import parser as dtp

INPUT_CSV = "jira_export_sample.csv"
OUTPUT_JSONL_SAMPLE = "jira_clean_sample.jsonl"
SAMPLE_ISSUES = 10
RANDOM_SEED = 42

KEEP_MAP: Dict[str, str] = {
    "Issue key": "issue_key",
    "Summary": "summary",
    "Reporter": "reporter",
    "Status": "status",
    "Resolution": "resolution",
    "Created": "created",
    "Updated": "updated",
}

CUSTOM_FIELDS_MAP: Dict[str, str] = {
    "Custom field: Hub": "hub",
    "Custom field: Contact reason": "contact_reason",
    "Custom field: Refund reason": "refund_reason",
    "Custom field: Dock": "dock",
    "Custom field: Satisfaction rating": "satisfaction_rating",
}

IMG_PATTERN = re.compile(r"!([^!\|\n]+)(?:\|[^!]*)?!")


def _normalise_comments(columns: Iterable[str]) -> List[str]:
    """Return the ordered list of comment columns present in the export."""

    ordered = []
    for column in columns:
        if column == "Comments" or column.startswith("Comments."):
            ordered.append(column)
    return ordered


def parse_comment(raw: str) -> Dict[str, Optional[str]]:
    """Parse a Jira comment cell into a structured dictionary."""

    raw = (raw or "").strip()
    parts = raw.split(";", 2)
    date_iso: Optional[str] = None
    author: Optional[str] = None
    text: str = raw

    if len(parts) == 3:
        date_str, author_part, text_part = parts
        author = author_part.strip() or None
        text = text_part.strip()
        try:
            date_iso = dtp.parse(date_str, dayfirst=False, yearfirst=False, fuzzy=True).isoformat()
        except Exception:  # pragma: no cover - best effort parsing
            date_iso = None
    else:
        text = raw

    internal_note = ("----" in text and "*Note:" in text) or text.lstrip().startswith("[~accountid:")
    text = IMG_PATTERN.sub(r"[image:\1]", text)

    return {
        "date": date_iso,
        "author": author,
        "text": text,
        "internal_note": bool(internal_note),
    }


def main() -> None:
    df = pd.read_csv(INPUT_CSV, dtype=str, keep_default_na=False, na_values=[])
    comment_cols = _normalise_comments(df.columns)
    present_custom = {src: CUSTOM_FIELDS_MAP[src] for src in CUSTOM_FIELDS_MAP if src in df.columns}

    indices = list(df.index)
    random.Random(RANDOM_SEED).shuffle(indices)
    if SAMPLE_ISSUES is not None:
        indices = indices[: min(SAMPLE_ISSUES, len(indices))]

    output_path = Path(OUTPUT_JSONL_SAMPLE)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", encoding="utf-8") as handle:
        for idx in indices:
            row = df.loc[idx]
            record = {dst: (row[src] or "").strip() for src, dst in KEEP_MAP.items() if src in df.columns}
            record["custom_fields"] = {
                dst: (row[src] or "").strip() for src, dst in present_custom.items()
            }

            comments: List[Dict[str, Optional[str]]] = []
            for comment_index, column in enumerate(comment_cols, start=1):
                value = (row[column] or "").strip()
                if not value:
                    continue
                parsed = parse_comment(value)
                parsed["index"] = comment_index
                comments.append(parsed)

            record["comments"] = comments
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(f"Wrote sample: {OUTPUT_JSONL_SAMPLE} with {len(indices)} issues")
    print(f"Parsed comment columns: {len(comment_cols)}")


if __name__ == "__main__":
    main()
