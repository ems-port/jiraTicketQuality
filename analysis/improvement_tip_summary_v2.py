#!/usr/bin/env python3
"""
Group improvement tips from Supabase into themed, ranked JSON output.

This v2 script fetches recent improvement tips (issue_key + text) from
Supabase, asks an LLM to cluster them into themes, and returns STRICT
JSON matching a manager-friendly schema (groups + ungrouped + next steps).

Environment:
- SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)
- OPENAI_API_KEY
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

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


def persist_grouping_payload(
    client: Any,
    payload: Dict[str, Any],
    model: str,
    window_start: datetime,
    window_end: datetime,
    total_notes: int,
    unique_notes: int,
    table: str = "improvement_tip_groupings",
) -> bool:
    record = {
        "time_window_start": window_start.isoformat(),
        "time_window_end": window_end.isoformat(),
        "total_notes": total_notes,
        "unique_notes": unique_notes,
        "model": model,
        "payload": payload,
    }
    try:
        response = client.table(table).insert(record).execute()
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[error] Failed to persist grouping payload: {exc}", file=sys.stderr)
        return False
    rows = getattr(response, "data", None)
    if isinstance(rows, list) and rows:
        inserted = rows[0]
        inserted_id = inserted.get("id") if isinstance(inserted, dict) else None
        print(f"Saved grouping to Supabase table '{table}' (id={inserted_id}).")
    else:
        print(f"Saved grouping to Supabase table '{table}'.")
    return True


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


def build_user_prompt(
    notes: List[Dict[str, str]],
    window_start: datetime,
    window_end: datetime,
    total_notes: int,
    unique_notes: int,
) -> str:
    notes_json = json.dumps(notes, indent=2)
    window_text = (
        f"{window_start.isoformat(timespec='seconds')} to "
        f"{window_end.isoformat(timespec='seconds')} (UTC)"
    )
    return f"""You are given anonymised agent coaching notes from customer support chats. Each note has a stable key_id and a text improvement tip. Group related notes into themes and return STRICT JSON only (no markdown, no extra text) matching the output schema. Do NOT invent ids; only use provided key_ids.

Input notes: array notes[] where each item is {{ "key_id": "...", "text": "..." }}.

Context:
- Time window: {window_text}
- Total notes: {total_notes}
- Unique improvement tips: {unique_notes}

Grouping rules:
- Create as many groups as needed; minimum count of 5.
- Combine closely related notes; minimize overlap. Each note must be assigned to exactly one group OR to ungrouped_key_ids.
- If a note fits multiple groups, assign it to the single best-fitting group.

Scoring and ranking:
- For each group compute:
  - group_size = number of notes in group (occurrence proxy)
  - actionability_score (1–5; 5 = easiest to fix via training/process/product)
  - severity_score (1–5; 5 = highest customer/ops/compliance impact)
  - overall_score = round(50*(group_size/max_group_size) + 30*(actionability_score/5) + 20*(severity_score/5))
  - max_group_size = size of the largest group you produce (use 1 if only one item).
- Rank groups descending by overall_score (tie-breaker: larger group_size).
- coverage_pct = round(100 * group_size / {total_notes}, 2).

Tip and description:
- tip must be 1 sentence and <=150 chars when possible.
- description must summarize the common pattern across grouped notes in 1–3 sentences.

Ungrouped:
- Put one-off notes that do not reasonably cluster into ungrouped_key_ids (manager review queue). Do not drop anything.

Next steps for manager training (per group):
- training_cue: single directive for Tier-1 agents (imperative: “Always…”, “Never…”, “If X then Y…”).
- success_signals: one or two simple observable indicators the cue is being followed (e.g., confirmation language present, duplicate tickets drop).

Keep the JSON concise: aim for ≤8 groups, exactly one next_steps entry per group, and ≤2 success_signals per group. Keep total output under ~1200 tokens.

Output JSON (strict, no markdown):
{{
  "time_window": {{ "start_utc": "{window_start.isoformat()}", "end_utc": "{window_end.isoformat()}" }},
  "totals": {{ "notes": {total_notes}, "unique_notes": {unique_notes} }},
  "groups": [
    {{
      "group_id": "snake_case_id",
      "title": "Short title",
      "description": "1–3 sentence aggregate summary of the grouped inputs",
      "tip": "One-sentence improvement tip",
      "key_ids": ["k1","k2"],
      "metrics": {{
        "group_size": 0,
        "coverage_pct": 0.0,
        "actionability_score": 1,
        "severity_score": 1,
        "overall_score": 0
      }},
      "next_steps": [
        {{
          "training_cue": "directive",
          "success_signals": ["signal 1", "signal 2"]
        }}
      ]
    }}
  ],
  "ungrouped_key_ids": []
}}

NOTES JSON:
{notes_json}

Ensure your reply is exactly the JSON object above (no markdown, no extra text)."""


def call_llm(
    openai_client: Optional[Tuple[str, Any]],
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
    temperature: float,
    reasoning_effort: Optional[str],
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
    finish_reason: Optional[str] = None
    content: Optional[str] = None

    try:
        if client_type == "client":
            use_responses_api = model.startswith("gpt-5") or model.startswith("gpt-4.1")
            if use_responses_api and hasattr(client, "responses"):
                response_kwargs: Dict[str, Any] = {
                    "model": model,
                    "input": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "max_output_tokens": max_tokens,
                }
                if temperature is not None:
                    response_kwargs["temperature"] = temperature
                if reasoning_effort:
                    response_kwargs["reasoning"] = {"effort": reasoning_effort}
                response = client.responses.create(**response_kwargs)  # type: ignore[arg-type]
                usage = getattr(response, "usage", None)
                if usage is not None:
                    prompt_tokens = getattr(usage, "input_tokens", None) or getattr(usage, "prompt_tokens", None)
                    completion_tokens = getattr(usage, "output_tokens", None) or getattr(usage, "completion_tokens", None)

                content = getattr(response, "output_text", None)
                if not content:
                    output = getattr(response, "output", None)
                    if output:
                        try:
                            for part in output:
                                part_content = getattr(part, "content", None) or []
                                for item in part_content:
                                    text_val = getattr(item, "text", None)
                                    if text_val:
                                        content = text_val
                                        break
                                if content:
                                    break
                        except Exception:
                            pass
                finish_reason = getattr(response, "finish_reason", None) or getattr(
                    getattr(response, "incomplete_details", None), "reason", None
                )
                if getattr(response, "incomplete_details", None):
                    try:
                        reason = getattr(response.incomplete_details, "reason", None)
                        if reason:
                            print(f"[warn] LLM response incomplete: {reason}", file=sys.stderr)
                    except Exception:
                        print("[warn] LLM response incomplete.", file=sys.stderr)
                if debug:
                    print("=== RAW RESPONSE (OpenAI responses API) ===")
                    try:
                        print(response.model_dump_json(indent=2))  # type: ignore[attr-defined]
                    except Exception:
                        print(response)
            else:
                response = client.chat.completions.create(  # type: ignore[attr-defined]
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    temperature=temperature,
                    max_completion_tokens=max_tokens,
                )
                usage = getattr(response, "usage", None)
                if usage is not None:
                    prompt_tokens = getattr(usage, "prompt_tokens", None)
                    completion_tokens = getattr(usage, "completion_tokens", None)
                choice = response.choices[0]  # type: ignore[index]
                content = choice.message.content
                finish_reason = getattr(choice, "finish_reason", None)
                if debug:
                    print("=== RAW RESPONSE (OpenAI client) ===")
                    try:
                        print(response.model_dump_json(indent=2))  # type: ignore[attr-defined]
                    except Exception:
                        print(response)
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
            first_choice = response["choices"][0]  # type: ignore[index]
            content = first_choice["message"]["content"]
            finish_reason = first_choice.get("finish_reason")
            if debug:
                print("=== RAW RESPONSE (legacy client) ===")
                try:
                    print(json.dumps(response, indent=2, default=str))
                except Exception:
                    print(response)
        if finish_reason in {"length", "max_output_tokens"}:
            print(
                "[warn] LLM response truncated by max tokens; consider increasing --max-tokens.",
                file=sys.stderr,
            )
        return content, prompt_tokens, completion_tokens
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[error] LLM call failed: {exc}", file=sys.stderr)
        return None, prompt_tokens, completion_tokens


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Group improvement tips from Supabase and produce ranked JSON themes."
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
        help="OpenAI model identifier to use for grouping.",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=6000,
        help="Maximum completion tokens to allow in the LLM response.",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=1.0,
        help="Sampling temperature for the LLM call (gpt-5 models require 1.0).",
    )
    parser.add_argument(
        "--reasoning-effort",
        type=str,
        choices=["low", "medium", "high"],
        default="low",
        help="Reasoning effort for responses API models (e.g., gpt-5).",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Print the full API payload and exit before calling the LLM.",
    )
    parser.add_argument(
        "--trace-llm",
        action="store_true",
        help="Print prompts and raw LLM response while still executing the call.",
    )
    parser.add_argument(
        "--persist",
        action="store_true",
        default=True,
        help="Persist the grouping payload to Supabase (default: on). Use --no-persist to skip.",
    )
    parser.add_argument(
        "--no-persist",
        dest="persist",
        action="store_false",
        help="Disable persistence to Supabase.",
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

    notes = [{"key_id": tip.issue_key, "text": tip.text} for tip in tips]
    unique_notes = len({tip.text for tip in tips})

    user_prompt = build_user_prompt(
        notes=notes,
        window_start=window_start,
        window_end=window_end,
        total_notes=len(notes),
        unique_notes=unique_notes,
    )
    system_prompt = (
        "You are an e-bike rental customer support team leader. "
        "Produce themes from coaching notes to your agents. "
        "Rules: follow the provided JSON schema exactly; preserve all key_ids and never invent ids; "
        "output only the JSON object (no markdown, no commentary)."
    )

    effective_temperature = args.temperature
    if "gpt-5" in args.model and args.temperature != 1.0:
        print("[warn] gpt-5 models only support temperature=1; overriding provided value.", file=sys.stderr)
        effective_temperature = 1.0

    effective_reasoning = args.reasoning_effort if args.model.startswith("gpt-5") or args.model.startswith("gpt-4.1") else None

    if args.debug:
        payload = {
            "model": args.model,
            "temperature": effective_temperature,
            "max_tokens": args.max_tokens,
            "reasoning": effective_reasoning,
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
        temperature=effective_temperature,
        reasoning_effort=effective_reasoning,
        debug=args.trace_llm,
    )

    print(
        f"Time window: {window_start.isoformat(timespec='seconds')} — "
        f"{window_end.isoformat(timespec='seconds')} UTC"
    )
    print(f"Total tips considered: {len(tips)}")
    print(f"Unique tips observed: {unique_notes}")
    print("")

    if summary:
        cleaned = summary.strip()
        print("LLM JSON response:")
        print(cleaned)
        try:
            parsed = json.loads(cleaned)
            print("")
            print("Parsed response keys:", list(parsed.keys()))

            if args.persist:
                persisted = persist_grouping_payload(
                    client=supabase_client,
                    payload=parsed,
                    model=args.model,
                    window_start=window_start,
                    window_end=window_end,
                    total_notes=len(tips),
                    unique_notes=unique_notes,
                )
                if not persisted:
                    print("[warn] Failed to persist grouping payload to Supabase.", file=sys.stderr)
        except json.JSONDecodeError as exc:
            print(f"[warn] Failed to parse JSON: {exc}", file=sys.stderr)
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
