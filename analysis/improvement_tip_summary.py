#!/usr/bin/env python3
"""
Summarize recurring improvement tips pulled directly from Supabase.

The script filters rows to a recent time window, aggregates the
``improvement_tip`` column, and asks an LLM to distill the three
themes that surface most often. It expects an ``OPENAI_API_KEY`` in
the environment and Supabase credentials (URL + service key).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

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
    issue_key: str
    conversation_start: datetime


def ensure_supabase_client(
    supabase_url: Optional[str] = None, supabase_key: Optional[str] = None
) -> Optional[Any]:
    resolved_url = supabase_url or os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    resolved_key = supabase_key or os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")
    if not resolved_url or not resolved_key:
        print(
            "[error] Missing Supabase credentials; set SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL "
            "and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY).",
            file=sys.stderr,
        )
        return None
    try:
        from supabase import create_client  # type: ignore
    except ImportError:
        print("[error] supabase-py is not installed. Run 'pip install supabase>=2.4.0'.", file=sys.stderr)
        return None
    return create_client(resolved_url, resolved_key)


def fetch_supabase_tips(
    client: Any,
    table: str,
    window_start: datetime,
    window_end: datetime,
    page_size: int = 1000,
) -> List[ImprovementTip]:
    tips: List[ImprovementTip] = []
    start = 0
    while True:
        try:
            response = (
                client.table(table)
                .select("issue_key, improvement_tip, conversation_start")
                .gte("conversation_start", window_start.isoformat())
                .lte("conversation_start", window_end.isoformat())
                .order("conversation_start", desc=False)
                .range(start, start + page_size - 1)
                .execute()
            )
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[error] Supabase query failed: {exc}", file=sys.stderr)
            break

        rows = getattr(response, "data", None) or []
        for row in rows:
            tip_text = (row.get("improvement_tip") or "").strip()
            issue_key = (row.get("issue_key") or "").strip()
            started = _parse_datetime(row.get("conversation_start"))
            if not tip_text or not issue_key or started is None:
                continue
            tips.append(ImprovementTip(text=tip_text, issue_key=issue_key, conversation_start=started))

        if len(rows) < page_size:
            break
        start += page_size

    return tips


def format_feedback_counts(
    counts: Sequence[Tuple[str, int]],
    limit: int,
    issue_key_map: Optional[Dict[str, Set[str]]] = None,
    issue_key_limit: int = 5,
) -> str:
    lines: List[str] = []
    for text, occurrences in counts[:limit]:
        suffix = ""
        if issue_key_map is not None and text in issue_key_map:
            keys = sorted(issue_key_map[text])
            head = keys[:issue_key_limit]
            remaining = len(keys) - len(head)
            suffix = f" (issues: {', '.join(head)}"
            if remaining > 0:
                suffix += f", +{remaining}"
            suffix += ")"
        lines.append(f"- {occurrences}× {text}{suffix}")
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
        description="Aggregate improvement tips from Supabase and summarise recurring themes."
    )
    parser.add_argument(
        "--table",
        type=str,
        default="jira_processed_conversations",
        help="Supabase table containing processed Jira conversations.",
    )
    parser.add_argument(
        "--supabase-url",
        type=str,
        default=None,
        help="Supabase project URL (defaults to SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL).",
    )
    parser.add_argument(
        "--supabase-key",
        type=str,
        default=None,
        help="Supabase service role key (defaults to SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY).",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=1000,
        help="Page size for Supabase range queries.",
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
        default="gpt-5-mini",
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
        "--issue-keys-per-tip",
        type=int,
        default=5,
        help="Number of issue keys to show per tip when printing aggregated data.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Print the full API payload and exit before calling the LLM.",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    if args.hours <= 0:
        print("[error] --hours must be positive.", file=sys.stderr)
        return 2

    if args.reference_time:
        window_end = _parse_datetime(args.reference_time)
        if window_end is None:
            print(f"[error] Could not parse --reference-time={args.reference_time!r}", file=sys.stderr)
            return 2
    else:
        window_end = datetime.now(timezone.utc)

    window_start = window_end - timedelta(hours=args.hours)

    supabase_client = ensure_supabase_client(args.supabase_url, args.supabase_key)
    if supabase_client is None:
        return 1

    tips = fetch_supabase_tips(
        client=supabase_client,
        table=args.table,
        window_start=window_start,
        window_end=window_end,
        page_size=max(1, args.page_size),
    )
    if not tips:
        print(
            f"No improvement tips between {window_start.isoformat(timespec='seconds')} and "
            f"{window_end.isoformat(timespec='seconds')} UTC were found.",
            file=sys.stderr,
        )
        return 0

    counts_counter = Counter()
    issue_key_map: Dict[str, Set[str]] = defaultdict(set)
    for tip in tips:
        counts_counter[tip.text] += 1
        issue_key_map[tip.text].add(tip.issue_key)

    counts = counts_counter.most_common()
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

    print(
        f"Time window: {window_start.isoformat(timespec='seconds')} — "
        f"{window_end.isoformat(timespec='seconds')} UTC"
    )
    print(f"Total tips considered: {len(tips)}")
    print(f"Unique tips observed: {len(counts)}")
    print("")
    print("Top recurring tips passed to the model:")
    print(
        format_feedback_counts(
            counts,
            limit=min(args.top_counts, len(counts)),
            issue_key_map=issue_key_map,
            issue_key_limit=max(1, args.issue_keys_per_tip),
        )
    )
    print("")

    if args.debug:
        payload = {
            "model": args.model,
            "temperature": args.temperature,
            "max_tokens": args.max_tokens,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        print("Debug mode: skipping LLM call. Request payload would be:")
        print(json.dumps(payload, indent=2))
        return 0

    openai_client = ensure_openai_client()
    summary, prompt_tokens, completion_tokens = call_llm(
        openai_client=openai_client,
        model=args.model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        max_tokens=args.max_tokens,
        temperature=args.temperature,
        debug=False,
    )

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
