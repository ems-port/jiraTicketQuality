#!/usr/bin/env python3
"""
Sanitise Jira CSV -> JSONL (sampled). Handles repeated "Comments" columns and
duplicate "Custom field (Contact Reason)" headings. Parses comment lines of the
form: "<date>;<author>;<text>" and flags internal notes.

Run:
  python3 -m pip install pandas python-dateutil
  python3 jiraDataClenser.py
"""
import argparse
import pandas as pd
import json
import re
from pathlib import Path
from typing import List, Sequence
from dateutil import parser as dtp
from tqdm import tqdm

# --- config ---
#INPUT_CSV = "local_data/JiraOct.csv"  # exact file name you provided
#INPUT_CSV = "local_data/JiraAug.csv"  # exact file name you provided
INPUT_CSV = "local_data/JiraNov.csv"  # exact file name you provided
#INPUT_CSV = "data/JiraSample.csv"  # exact file name you provided
OUTPUT_JSONL_SAMPLE = "data/jira_clean_sample.jsonl"
SAMPLE_ISSUES = None       # set to None to process all issues
DEFAULT_MAX_MERGED_TOKENS = 5000  # approximate context size for gpt-4o mini

# Columns to keep/rename (exact headings)
KEEP_MAP = {
    "Issue key": "issue_key",
    "Summary": "user_summary",
    "Reporter": "reporter",
    "Status": "status",
    "Resolution": "resolution",
    "Created": "created",
    "Updated": "updated",
    "Due date": "due_date",
}

# Custom fields (exact headings)
# Note: "Custom field (Contact Reason)" may appear duplicated; handled below.
CUSTOM_FIELDS_BASE = {
    "Custom field (Hub)": "hub",
    "Custom field (Refund Reason)": "refund_reason",
    "Custom field (Dock)": "dock",
    "Satisfaction rating": "satisfaction_rating",
}
CONTACT_REASON_HEADER = "Custom field (Contact Reason)"

IMG_PATTERN = re.compile(r"!([^!\|\n]+)(?:\|[^!]*)?!")  # Jira image markup
IMAGE_FILE_PATTERN = re.compile(r"\b[\w\-.]+\.(?:png|jpe?g|gif|bmp|tiff|svg)\b", re.IGNORECASE)
VIDEO_FILE_PATTERN = re.compile(r"\b[\w\-.]+\.(?:mp4|mov|avi|wmv|mkv|webm)\b", re.IGNORECASE)
LINK_PATTERN = re.compile(r"https?://\S+")

def classify_role(author: str | None) -> str:
    """Return 'agent' if author starts with '712020', 'customer' if starts with 'qm:', else 'unknown'."""
    if not author:
        return "unknown"
    a = author.strip().lower()
    if a.startswith("712020"):
        return "agent"
    if a.startswith("qm:"):
        return "customer"
    return "unknown"


def parse_comment(raw: str) -> dict:
    """Split 'date;author;text'. Tolerate missing parts. Flag internal notes."""
    raw = (raw or "").strip()
    parts = raw.split(";", 2)
    date_iso, author, text = None, None, raw
    if len(parts) == 3:
        ds, author, text = parts[0].strip(), parts[1].strip(), parts[2].strip()
        try:
            date_iso = dtp.parse(ds, dayfirst=False, yearfirst=False, fuzzy=True).isoformat()
        except Exception:
            date_iso = None
    # internal note flags
    internal_note = ("----" in text and "*Note:" in text) or text.lstrip().startswith("[~accountid:")
    # normalise media/hyperlinks to short tokens
    text = IMG_PATTERN.sub("[image file]", text)
    text = IMAGE_FILE_PATTERN.sub("[image file]", text)
    text = VIDEO_FILE_PATTERN.sub("[video file]", text)
    text = LINK_PATTERN.sub("[link]", text)
    role = classify_role(author)
    # Map role to ~A (agent), ~C (customer), ~U (unknown) to save on tokens for LLM
    if role == "agent":
        role_short = "~A"
    elif role == "customer":
        role_short = "~C"
    else:
        role_short = "~U"
    return {
        "date": date_iso,
        "author": author or None,
        "role": role_short,
        "text": text,
        "internal_note": bool(internal_note),
    }


def first_non_empty(row, headers):
    """Return first non-empty string among row[header] for any pandas-mangled duplicates."""
    for h in headers:
        val = row.get(h, "")
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def to_clean_str(value) -> str:
    """Convert arbitrary cell values to stripped strings without crashing."""
    if value is None:
        return ""
    if isinstance(value, str):
        text = value.strip()
        return "" if text.lower() in {"nan", "none", "null"} else text
    # Handle pandas NA types or numerics gracefully
    try:
        import math
        if isinstance(value, float) and math.isnan(value):
            return ""
    except Exception:
        pass
    try:
        text = str(value).strip()
        return "" if text.lower() in {"nan", "none", "null"} else text
    except Exception:
        return ""


def coerce_optional_int(value, default: int | None) -> int | None:
    """Return int(value) when numeric, otherwise None (unlimited)."""
    if value is None:
        return default
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def main(
    *,
    input_csvs: Sequence[str] | None = None,
    output_jsonl: str = OUTPUT_JSONL_SAMPLE,
    append: bool = False,
    sample_issues: int | None = SAMPLE_ISSUES,
    max_merged_tokens: int | None = DEFAULT_MAX_MERGED_TOKENS,
):
    candidate_paths = list(input_csvs or [INPUT_CSV])
    resolved_paths: List[Path] = []
    for raw in candidate_paths:
        path = Path(raw)
        if not path.exists():
            print(f"[warn] input CSV not found, skipping: {path}")
            continue
        if path not in resolved_paths:
            resolved_paths.append(path)

    if not resolved_paths:
        print("[error] no input CSV files found. Nothing to process.")
        return

    data_frames = []
    per_file_counts: Dict[str, int] = {}
    for csv_path in resolved_paths:
        try:
            df_part = pd.read_csv(csv_path, dtype=str, keep_default_na=False, na_values=[])
        except Exception as exc:  # pragma: no cover - pandas I/O errors
            print(f"[warn] failed to read {csv_path}: {exc}")
            continue
        df_part["__source_file"] = csv_path.name
        df_part["__source_path"] = str(csv_path)
        count = len(df_part)
        per_file_counts[csv_path.name] = per_file_counts.get(csv_path.name, 0) + count
        data_frames.append(df_part)

    if not data_frames:
        print("[error] unable to load any input CSV files.")
        return

    df = pd.concat(data_frames, ignore_index=True, sort=False)

    # Comment columns: "Comments", "Comments.1", ...
    comment_cols = [c for c in df.columns if c == "Comments" or c.startswith("Comments.")]

    # Contact reason possible duplicates: base and .N variants
    contact_reason_cols = [c for c in df.columns if c == CONTACT_REASON_HEADER or c.startswith(CONTACT_REASON_HEADER + ".")]

    # Other custom fields present
    present_custom_cols = {c: dst for c, dst in CUSTOM_FIELDS_BASE.items() if c in df.columns}


    # Sort by Issue key (if present)
    if "Issue key" in df.columns:
        df = df.sort_values(by="Issue key", kind="stable", ascending=False)

    # Build sample indices (now sorted)
    indices = list(df.index)
    if sample_issues is not None:
        indices = indices[:min(sample_issues, len(indices))]

    output_path = Path(output_jsonl)
    mode = "a" if append else "w"
    mode_label = "append" if append else "overwrite"

    written = 0
    skipped_token_limit = 0

    with output_path.open(mode, encoding="utf-8") as out:
        for i in tqdm(indices, desc="Processing issues", unit="issue"):
            row = df.loc[i]

            # Base fields
            rec = {dst: to_clean_str(row[src]) for src, dst in KEEP_MAP.items() if src in df.columns}
            source_file = row.get("__source_file")
            if source_file:
                rec["source_csv"] = str(source_file)

            # Custom fields
            custom = {dst: to_clean_str(row[src]) for src, dst in present_custom_cols.items()}
            # Merge duplicated contact reason by first non-empty
            if contact_reason_cols:
                custom["contact_reason"] = first_non_empty(row, contact_reason_cols)
            rec["custom_fields"] = custom


            # Consolidate comments -> structured list
            comments = []
            merged_chunks = []
            seq = 1
            for col in comment_cols:
                val = to_clean_str(row.get(col))
                if not val:
                    continue
                parsed = parse_comment(val)
                parsed["index"] = seq
                comments.append(parsed)
                # Add to merged text as "role:text"
                merged_chunks.append(f"{parsed['role']}:{parsed['text']}")
                seq += 1
            rec["comments"] = comments

            # Add merged_text and merge_context_size_tokens
            merged_text = " ".join(merged_chunks)
            rec["merged_text"] = merged_text
            # Estimate token count using regex (words and punctuation)
            import re
            tokens = re.findall(r"\w+|[^\w\s]", merged_text)
            token_count = len(tokens)

            if max_merged_tokens is not None and token_count > max_merged_tokens:
                skipped_token_limit += 1
                continue

            rec["merge_context_size_tokens"] = token_count

            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            written += 1

    summary = (
        f"Wrote sample: {output_jsonl} with {written} issues (mode: {mode_label}) "
        f"| source rows: {df.shape[0]}"
    )
    if skipped_token_limit:
        summary += f" | skipped {skipped_token_limit} over token cap"
    print(summary)
    if per_file_counts:
        print("Per-source row counts:")
        for name, count in per_file_counts.items():
            print(f"  - {name}: {count}")
    print(f"Detected comment columns: {len(comment_cols)}  |  contact_reason cols: {len(contact_reason_cols)}")


if __name__ == "__main__":
    try:
        from tqdm import tqdm  # noqa: F401
    except ImportError:
        print("tqdm not found. Please install it with: pip install tqdm")
        exit(1)
    parser = argparse.ArgumentParser(description="Sanitize Jira CSV exports into JSONL samples.")
    parser.add_argument(
        "-i",
        "--input",
        dest="input_csv",
        default=INPUT_CSV,
        help=f"Path to the Jira CSV export (default: {INPUT_CSV})",
    )
    parser.add_argument(
        "--inputs",
        nargs="+",
        dest="input_csvs",
        help="Optional list of CSV files to process. Overrides --input when provided.",
    )
    parser.add_argument(
        "--include-local-data",
        action="store_true",
        help="Also process every CSV found in the local_data/ directory (deduplicated).",
    )
    parser.add_argument(
        "-o",
        "--output",
        dest="output_jsonl",
        default=OUTPUT_JSONL_SAMPLE,
        help=f"Path to the JSONL output (default: {OUTPUT_JSONL_SAMPLE})",
    )
    parser.add_argument(
        "--append",
        action="store_true",
        help="Append to the output file if it exists instead of overwriting.",
    )
    parser.add_argument(
        "--sample-issues",
        dest="sample_issues",
        default=SAMPLE_ISSUES,
        help="Limit the number of issues processed; set a non-numeric value to process all.",
    )
    parser.add_argument(
        "--max-merged-tokens",
        dest="max_merged_tokens",
        default=DEFAULT_MAX_MERGED_TOKENS,
        help=(
            f"Drop records whose merged comment text exceeds this estimated token count "
            f"(default: {DEFAULT_MAX_MERGED_TOKENS}); set a non-numeric value for no limit."
        ),
    )
    args = parser.parse_args()
    sample_issues = coerce_optional_int(args.sample_issues, SAMPLE_ISSUES)
    max_merged_tokens = coerce_optional_int(args.max_merged_tokens, DEFAULT_MAX_MERGED_TOKENS)
    input_files: List[str] = []
    if args.input_csvs:
        input_files.extend(args.input_csvs)
    elif args.input_csv:
        input_files.append(args.input_csv)

    if args.include_local_data:
        local_dir = Path("local_data")
        if local_dir.exists():
            for csv_file in sorted(local_dir.glob("*.csv")):
                csv_str = str(csv_file)
                if csv_str not in input_files:
                    input_files.append(csv_str)
        else:
            print("[warn] --include-local-data specified but local_data/ directory not found.")

    main(
        input_csvs=input_files or [INPUT_CSV],
        output_jsonl=args.output_jsonl,
        append=args.append,
        sample_issues=sample_issues,
        max_merged_tokens=max_merged_tokens,
    )
