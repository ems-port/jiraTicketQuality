#!/usr/bin/env python3
"""
Summarize recurring improvement tips from a conversation quality CSV.

The script filters rows to a recent time window, aggregates the
``improvement_tip`` column, and asks an LLM to distill the three
themes that surface most often. It expects an ``OPENAI_API_KEY`` in
the environment.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from dateutil import parser as dt_parser

try:  # Optional dependency; load environment variables if present.
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional dependency
    load_dotenv = None  # type: ignore


def _load_dotenv_if_available() -> None:
    if load_dotenv is None:
        return
    env_path = Path(".env")
    if env_path.exists():
        load_dotenv(dotenv_path=env_path, override=False)


_load_dotenv_if_available()


def ensure_openai_client() -> Optional[Tuple[str, Any]]:
    """Return a tuple of (client_type, client_instance) if possible."""

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("[warn] OPENAI_API_KEY not set; cannot call the LLM.", file=sys.stderr)
        return None

    try:  # Prefer the newer client interface.
        from openai import OpenAI  # type: ignore

        return ("client", OpenAI(api_key=api_key))
    except ImportError:
        try:
            import openai  # type: ignore
        except ImportError:
            print("[warn] openai package is not installed.", file=sys.stderr)
            return None
        openai.api_key = api_key  # type: ignore[attr-defined]
        return ("legacy", openai)


def _parse_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    normalized = value.strip().replace("Z", "+00:00")
    if not normalized:
        return None
    try:
        parsed = dt_parser.isoparse(normalized)
    except (ValueError, TypeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@dataclass(frozen=True)
class ImprovementTip:
    text: str
    conversation_start: datetime


def load_recent_tips(csv_path: Path, window_start: datetime) -> List[ImprovementTip]:
    tips: List[ImprovementTip] = []
    with csv_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            raw_tip = (row.get("improvement_tip") or "").strip()
            if not raw_tip:
                continue
            started = _parse_datetime(row.get("conversation_start"))
            if started is None or started < window_start:
                continue
            tips.append(ImprovementTip(text=raw_tip, conversation_start=started))
    return tips


def format_feedback_counts(counts: Sequence[Tuple[str, int]], limit: int) -> str:
    lines: List[str] = []
    for text, occurrences in counts[:limit]:
        lines.append(f"- {occurrences}× {text}")
    remaining = len(counts) - limit
    if remaining > 0:
        lines.append(f"- … ({remaining} additional unique tips omitted for brevity)")
    return "\n".join(lines)


def build_user_prompt(
    tips: List[ImprovementTip],
    counts: Sequence[Tuple[str, int]],
    window_start: datetime,
    window_end: datetime,
    top_n: int,
) -> str:
    window_text = (
        f"{window_start.isoformat(timespec='seconds')} to "
        f"{window_end.isoformat(timespec='seconds')} (UTC)"
    )
    aggregated = format_feedback_counts(counts, limit=top_n)
    total = len(tips)
    unique = len(counts)
    prompt = f"""You receive anonymised agent coaching notes from customer service chats.
The notes are already written as suggested improvement tips.

Time window analysed: {window_text}
Conversations included: {total}
Unique improvement tips: {unique}

Each bullet below shows how often a specific improvement tip appeared in the last 24 hours:
{aggregated}

Task:
1. Identify the three strongest recurring themes or actions that would most improve agent performance.
2. Combine closely-related notes so each final tip covers a theme.
3. Order the tips by relevance (most frequent problems first).
4. Keep each tip concise (one sentence, <=150 characters when possible).
5. If fewer than three themes exist, return as many as you can.

Respond using exactly three bullet lines in the format: "Tip X — text".
If fewer themes are available, replace missing lines with "Tip X — (not enough data)".
"""
    return prompt


def call_llm(
    openai_client: Optional[Tuple[str, Any]],
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
    temperature: float,
    debug: bool = False,
) -> Tuple[Optional[str], Optional[int], Optional[int]]:
    if openai_client is None:
        return None, None, None

    if debug:
        print("=== SYSTEM PROMPT ===")
        print(system_prompt)
        print("=== USER PROMPT ===")
        print(user_prompt)

    client_type, client = openai_client
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None

    try:
        if client_type == "client":
            response = client.chat.completions.create(  # type: ignore[attr-defined]
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=temperature,
                max_tokens=max_tokens,
            )
            usage = getattr(response, "usage", None)
            if usage is not None:
                prompt_tokens = getattr(usage, "prompt_tokens", None)
                completion_tokens = getattr(usage, "completion_tokens", None)
            content = response.choices[0].message.content  # type: ignore[index]
        else:
            response = client.ChatCompletion.create(  # type: ignore[attr-defined]
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=temperature,
                max_tokens=max_tokens,
            )
            usage = response.get("usage") if isinstance(response, dict) else None
            if usage:
                prompt_tokens = usage.get("prompt_tokens")
                completion_tokens = usage.get("completion_tokens")
            content = response["choices"][0]["message"]["content"]  # type: ignore[index]
        return content, prompt_tokens, completion_tokens
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[error] LLM call failed: {exc}", file=sys.stderr)
        return None, prompt_tokens, completion_tokens


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Aggregate improvement tips for the past 24 hours and summarise recurring themes."
    )
    parser.add_argument(
        "--csv-path",
        type=Path,
        default=Path("data/convo_quality_550.csv"),
        help="Path to the CSV generated by convo_quality.py.",
    )
    parser.add_argument(
        "--hours",
        type=float,
        default=24.0,
        help="Size of the rolling time window in hours (default: 24).",
    )
    parser.add_argument(
        "--reference-time",
        type=str,
        default=None,
        help="ISO timestamp used as the end of the window (defaults to now, UTC).",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="gpt-4o-mini",
        help="OpenAI model identifier to use for summarisation.",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=300,
        help="Maximum tokens to allow in the LLM response.",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.2,
        help="Sampling temperature for the LLM call.",
    )
    parser.add_argument(
        "--top-counts",
        type=int,
        default=40,
        help="Number of most common unique tips to include in the prompt.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Print the prompts before calling the LLM.",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    if args.hours <= 0:
        print("[error] --hours must be positive.", file=sys.stderr)
        return 2
    try:
        window_end = (
            _parse_datetime(args.reference_time)
            if args.reference_time
            else datetime.now(timezone.utc)
        )
        if window_end is None:
            raise ValueError
    except ValueError:
        print(f"[error] Could not parse --reference-time={args.reference_time!r}", file=sys.stderr)
        return 2

    window_start = window_end - timedelta(hours=args.hours)
    if not args.csv_path.exists():
        print(f"[error] CSV not found at {args.csv_path}", file=sys.stderr)
        return 1

    tips = load_recent_tips(args.csv_path, window_start)
    if not tips:
        print(
            f"No improvement tips after {window_start.isoformat(timespec='seconds')} UTC were found.",
            file=sys.stderr,
        )
        return 0

    counts = Counter(tip.text for tip in tips).most_common()
    system_prompt = (
        "You are an expert QA program manager producing concise coaching insights from repeated "
        "agent improvement tips. Focus on trends, not one-off notes."
    )
    user_prompt = build_user_prompt(
        tips=tips,
        counts=counts,
        window_start=window_start,
        window_end=window_end,
        top_n=max(1, args.top_counts),
    )

    openai_client = ensure_openai_client()
    summary, prompt_tokens, completion_tokens = call_llm(
        openai_client=openai_client,
        model=args.model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        max_tokens=args.max_tokens,
        temperature=args.temperature,
        debug=args.debug,
    )

    print(
        f"Time window: {window_start.isoformat(timespec='seconds')} — "
        f"{window_end.isoformat(timespec='seconds')} UTC"
    )
    print(f"Total tips considered: {len(tips)}")
    print(f"Unique tips observed: {len(counts)}")
    print("")
    print("Top recurring tips passed to the model:")
    print(format_feedback_counts(counts, limit=min(args.top_counts, len(counts))))
    print("")

    if summary:
        print("LLM summary:")
        print(summary.strip())
    else:
        print("LLM summary unavailable.")

    if prompt_tokens is not None or completion_tokens is not None:
        print("")
        print("Token usage:")
        print(f"- prompt tokens: {prompt_tokens}")
        print(f"- completion tokens: {completion_tokens}")

    return 0


if __name__ == "__main__":  # pragma: no cover - script entry point
    raise SystemExit(main())

