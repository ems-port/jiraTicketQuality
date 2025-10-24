#!/usr/bin/env python3
"""
Usage analytics helper for OpenAI API consumption.

Fetches usage data via the `/v1/usage` endpoint, aggregates it by date and model,
prints a tabular summary, and renders a stacked bar chart saved to disk (and
optionally displayed).
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import os
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

import matplotlib.pyplot as plt  # type: ignore
import requests

try:  # pragma: no cover - optional dependency
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None  # type: ignore


USAGE_ENDPOINT = "https://api.openai.com/v1/usage"


def _load_dotenv_if_available() -> None:
    if load_dotenv is None:
        return
    env_path = Path(".env")
    if env_path.exists():
        load_dotenv(dotenv_path=env_path, override=False)


_load_dotenv_if_available()


@dataclass
class UsageRecord:
    usage_date: date
    model: str
    cost: float
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


def parse_args() -> argparse.Namespace:
    today = date.today()
    default_start = (today - timedelta(days=7)).isoformat()
    default_end = today.isoformat()
    parser = argparse.ArgumentParser(
        description="Fetch and visualise OpenAI API usage grouped by date and model."
    )
    parser.add_argument(
        "--start-date",
        default=default_start,
        help=f"Start date (inclusive) in YYYY-MM-DD format (default: {default_start}).",
    )
    parser.add_argument(
        "--end-date",
        default=default_end,
        help=f"End date (inclusive) in YYYY-MM-DD format (default: {default_end}).",
    )
    parser.add_argument(
        "--models",
        nargs="+",
        help="Optional list of model names to include (defaults to all models returned).",
    )
    parser.add_argument(
        "--output-csv",
        help="Optional path to write the detailed usage rows as CSV.",
    )
    parser.add_argument(
        "--output-plot",
        default="usage_plot.png",
        help="Path for the generated stacked bar chart (default: usage_plot.png).",
    )
    parser.add_argument(
        "--show",
        action="store_true",
        help="Display the matplotlib window after generating the chart.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print raw API responses for debugging purposes.",
    )
    return parser.parse_args()


def parse_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:  # pragma: no cover - argument handling
        raise SystemExit(f"Invalid date format '{value}'. Expected YYYY-MM-DD.") from exc


def fetch_usage_records(
    *,
    api_key: str,
    start_date: date,
    end_date: date,
    models_filter: Optional[Sequence[str]],
    verbose: bool = False,
) -> List[UsageRecord]:
    headers = {
        "Authorization": f"Bearer {api_key}",
    }

    records: List[UsageRecord] = []

    current = start_date
    while current <= end_date:
        params = {"date": current.isoformat()}
        response = requests.get(USAGE_ENDPOINT, headers=headers, params=params, timeout=30)
        if response.status_code != 200:
            raise SystemExit(
                f"Usage API request failed ({response.status_code}) for {current}: {response.text}"
            )
        payload = response.json()
        if verbose:
            print(f"[debug] usage payload for {current.isoformat()}:")
            print(json.dumps(payload, indent=2))

        data: Iterable[dict] = payload.get("data", [])
        for entry in data:
            line_items = entry.get("line_items") or []
            for line in line_items:
                model = line.get("name") or "unknown"
                if models_filter and model not in models_filter:
                    continue
                cost = float(line.get("cost", 0.0) or 0.0)
                record = UsageRecord(
                    usage_date=current,
                    model=model,
                    cost=cost,
                    input_tokens=line.get("input_tokens"),
                    output_tokens=line.get("output_tokens"),
                    total_tokens=line.get("total_tokens"),
                )
                records.append(record)

        current += timedelta(days=1)

    return records


def aggregate_by_date_model(records: Iterable[UsageRecord]) -> Dict[date, Dict[str, UsageRecord]]:
    result: Dict[date, Dict[str, UsageRecord]] = collections.defaultdict(dict)
    for record in records:
        day_bucket = result.setdefault(record.usage_date, {})
        entry = day_bucket.get(record.model)
        if entry is None:
            day_bucket[record.model] = UsageRecord(
                usage_date=record.usage_date,
                model=record.model,
                cost=record.cost,
                input_tokens=record.input_tokens,
                output_tokens=record.output_tokens,
                total_tokens=record.total_tokens,
            )
        else:
            entry.cost += record.cost
            entry.input_tokens = _add_maybe(entry.input_tokens, record.input_tokens)
            entry.output_tokens = _add_maybe(entry.output_tokens, record.output_tokens)
            entry.total_tokens = _add_maybe(entry.total_tokens, record.total_tokens)
    return result


def _add_maybe(lhs: Optional[int], rhs: Optional[int]) -> Optional[int]:
    if lhs is None and rhs is None:
        return None
    return (lhs or 0) + (rhs or 0)


def write_csv(path: Path, records: Iterable[UsageRecord]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["date", "model", "cost_usd", "input_tokens", "output_tokens", "total_tokens"]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for record in sorted(records, key=lambda r: (r.usage_date, r.model)):
            writer.writerow(
                {
                    "date": record.usage_date.isoformat(),
                    "model": record.model,
                    "cost_usd": f"{record.cost:.6f}",
                    "input_tokens": record.input_tokens or "",
                    "output_tokens": record.output_tokens or "",
                    "total_tokens": record.total_tokens or "",
                }
            )


def print_summary(aggregated: Dict[date, Dict[str, UsageRecord]]) -> None:
    print("\nSummary by date and model (cost in USD):")
    for usage_day in sorted(aggregated):
        models = aggregated[usage_day]
        total_cost = sum(item.cost for item in models.values())
        print(f"- {usage_day.isoformat()} | total cost ${total_cost:.4f}")
        for model, record in sorted(models.items(), key=lambda kv: kv[0]):
            tokens_info = ""
            if record.total_tokens:
                tokens_info = f" | tokens={record.total_tokens}"
            print(f"    {model}: ${record.cost:.4f}{tokens_info}")

    overall_cost = sum(item.cost for per_day in aggregated.values() for item in per_day.values())
    overall_tokens = sum(
        item.total_tokens or 0 for per_day in aggregated.values() for item in per_day.values()
    )
    print(f"\nOverall cost: ${overall_cost:.4f}")
    if overall_tokens:
        print(f"Overall total tokens (if provided): {overall_tokens}")


def plot_stacked_bar(
    aggregated: Dict[date, Dict[str, UsageRecord]],
    output_path: Path,
    show_plot: bool = False,
) -> None:
    if not aggregated:
        print("[warn] No usage data available to plot.")
        return

    dates_sorted = sorted(aggregated.keys())
    models = sorted({model for per_day in aggregated.values() for model in per_day})
    data_matrix = []
    for model in models:
        series = []
        for usage_day in dates_sorted:
            daily = aggregated[usage_day]
            series.append(daily.get(model, UsageRecord(usage_day, model, 0.0)).cost)
        data_matrix.append(series)

    fig, ax = plt.subplots(figsize=(max(8, len(dates_sorted) * 0.6), 6))
    bottom = [0.0] * len(dates_sorted)
    for model, costs in zip(models, data_matrix):
        ax.bar(dates_sorted, costs, bottom=bottom, label=model)
        bottom = [b + c for b, c in zip(bottom, costs)]

    ax.set_ylabel("Cost (USD)")
    ax.set_xlabel("Date")
    ax.set_title("OpenAI Usage Cost by Model")
    ax.legend(loc="upper left", bbox_to_anchor=(1, 1))
    ax.set_xticklabels([d.isoformat() for d in dates_sorted], rotation=45, ha="right")
    fig.tight_layout()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=150)
    print(f"[info] Plot written to {output_path}")

    if show_plot:
        plt.show()
    else:
        plt.close(fig)


def main() -> int:
    args = parse_args()
    start_date = parse_date(args.start_date)
    end_date = parse_date(args.end_date)
    if start_date > end_date:
        raise SystemExit("start-date must be before or equal to end-date.")

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is not set. Please export your API key.")

    records = fetch_usage_records(
        api_key=api_key,
        start_date=start_date,
        end_date=end_date,
        models_filter=args.models,
        verbose=args.verbose,
    )
    if not records:
        print("No usage records returned for the specified range.")
        return 0

    aggregated = aggregate_by_date_model(records)

    print_summary(aggregated)

    if args.output_csv:
        write_csv(Path(args.output_csv), records)
        print(f"[info] Detailed usage written to {args.output_csv}")

    plot_stacked_bar(aggregated, Path(args.output_plot), show_plot=args.show)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
