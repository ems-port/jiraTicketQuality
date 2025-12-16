#!/usr/bin/env python3
"""
Interactive debugger for Jira conversation prompts.

This script walks through conversations in the JSONL file, shows the prompt that
would be sent to an LLM, and lets you manually choose per conversation whether
to send it, skip it, or quit. Useful for checking prompt contents before wiring
them into the automated pipeline.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import textwrap
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple

try:
    import tiktoken  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    tiktoken = None


BASE_SYSTEM_PROMPT = "You are a concise support analyst responding in JSON."

MODEL_PRICING: Dict[str, Dict[str, float]] = {
    "gpt-4o": {"input": 0.005, "output": 0.015},
    "gpt-4o-mini": {"input": 0.0012, "output": 0.0048},
    "gpt-4.1": {"input": 0.005, "output": 0.015},
}

OpenAIClient = tuple[str, Any]
try:
    from analysis.default_taxonomy import (  # type: ignore
        AGENT_CONTACT_HEADINGS,
        KEYWORD_CONTACT_MAP,
    )
    DEFAULT_TAXONOMY: Sequence[str] = AGENT_CONTACT_HEADINGS
except ImportError:
    try:
        from default_taxonomy import AGENT_CONTACT_HEADINGS, KEYWORD_CONTACT_MAP  # type: ignore
        DEFAULT_TAXONOMY = AGENT_CONTACT_HEADINGS
    except ImportError:
        DEFAULT_TAXONOMY = ()
        KEYWORD_CONTACT_MAP = {}


def build_system_prompt(
    taxonomy: Sequence[str],
    include_taxonomy: bool,
    include_hints: bool = True,
    hints_per_label: int = 3,
) -> str:
    prompt = BASE_SYSTEM_PROMPT
    if include_taxonomy and taxonomy:
        formatted = "\n".join(f"- {item}" for item in taxonomy)
        prompt = f"{prompt}\n\nContact reason taxonomy:\n{formatted}"
        if include_hints and hints_per_label > 0 and KEYWORD_CONTACT_MAP:
            hint_lines = []
            for item in taxonomy:
                keywords = KEYWORD_CONTACT_MAP.get(item)
                if not keywords:
                    continue
                selected = list(dict.fromkeys(keywords))[:hints_per_label]
                if not selected:
                    continue
                hint_lines.append(f"- {item}: {', '.join(selected)}")
            if hint_lines:
                prompt = (
                    f"{prompt}\n\nKeyword hints (per contact reason):\n"
                    + "\n".join(hint_lines)
                )
    return prompt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Interactively inspect and optionally send LLM prompts."
    )
    parser.add_argument(
        "--input",
        default="jira_clean_sample.jsonl",
        help="Path to the conversations JSONL file.",
    )
    parser.add_argument(
        "--start",
        type=int,
        default=0,
        help="Zero-based index of the first conversation to inspect.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Maximum conversations to walk through (0 means no limit).",
    )
    parser.add_argument(
        "--model",
        default="gpt-4o-mini",
        help="Chat model identifier, e.g. gpt-4o.",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.2,
        help="Sampling temperature for the LLM (default: 0.2).",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=600,
        help="Max tokens to request from the LLM (default: 600).",
    )
    parser.add_argument(
        "--taxonomy-file",
        default=os.getenv("PORT_TAXONOMY_FILE"),
        help="Optional JSON file containing an array of contact reasons. "
        "Defaults to the shared taxonomy.",
    )
    parser.add_argument(
        "--include-taxonomy-in-prompt",
        action="store_true",
        help="Also include the taxonomy in each conversation prompt (default: only system).",
    )
    parser.add_argument(
        "--print-taxonomy",
        action="store_true",
        help="Print the taxonomy once at startup for reference.",
    )
    parser.add_argument(
        "--hide-agent-contact-reason",
        action="store_true",
        help="Do not include the agent-selected contact reason in the prompt.",
    )
    parser.add_argument(
        "--no-taxonomy-in-system",
        action="store_true",
        help="Do not include the taxonomy list in the system prompt.",
    )
    parser.add_argument(
        "--taxonomy-hints",
        type=int,
        default=int(os.getenv("PORT_TAXONOMY_HINTS", "3")),
        help="Number of keyword hints per taxonomy entry (0 disables hints).",
    )
    parser.add_argument(
        "--auto-continue",
        action="store_true",
        help="Skip confirmation prompt for the system message preview.",
    )
    parser.add_argument(
        "--show-prompts",
        action="store_true",
        help="Display the full prompt text for each conversation.",
    )
    parser.add_argument(
        "--auto-send",
        action="store_true",
        help="Automatically send each conversation without confirmation.",
    )
    parser.add_argument(
        "--output-csv",
        default=os.getenv("PORT_HITL_CSV", "jira_hitl_sample.csv"),
        help="Path to append HITL rows (default: jira_hitl_sample.csv).",
    )
    return parser.parse_args()


def _count_tokens(text: str, model: str) -> tuple[int, bool]:
    if tiktoken is not None:
        try:
            encoding = tiktoken.encoding_for_model(model)
        except KeyError:
            encoding = tiktoken.get_encoding("cl100k_base")
        return len(encoding.encode(text)), False

    approx = max(1, int(len(text.split()) * 1.33))
    return approx, True


def preview_prompt_cost(
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
) -> Optional[Dict[str, float | bool | int]]:
    pricing = MODEL_PRICING.get(model)
    if not pricing:
        return None

    system_tokens, system_approx = _count_tokens(system_prompt, model)
    user_tokens, user_approx = _count_tokens(user_prompt, model)
    prompt_tokens = system_tokens + user_tokens
    approx = system_approx or user_approx
    input_cost = (prompt_tokens / 1000) * pricing["input"]
    max_completion_cost = (max_tokens / 1000) * pricing["output"]

    return {
        "system_tokens": system_tokens,
        "system_approximate": 1 if system_approx else 0,
        "user_tokens": user_tokens,
        "user_approximate": 1 if user_approx else 0,
        "tokens": prompt_tokens,
        "input_cost": input_cost,
        "max_completion_cost": max_completion_cost,
        "approximate": 1.0 if approx else 0.0,
    }


def compute_costs(
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
) -> Optional[Tuple[float, float]]:
    pricing = MODEL_PRICING.get(model)
    if not pricing:
        return None
    prompt_cost = (prompt_tokens / 1000) * pricing["input"]
    completion_cost = (completion_tokens / 1000) * pricing["output"]
    return prompt_cost, completion_cost


def load_records(path: Path, start: int, limit: int) -> Iterable[Dict]:
    with path.open("r", encoding="utf-8") as handle:
        for idx, line in enumerate(handle):
            if idx < start:
                continue
            if line.strip():
                try:
                    yield json.loads(line)
                except json.JSONDecodeError as exc:
                    print(f"[warn] Skipping invalid JSON on line {idx + 1}: {exc}")
                    continue
            if limit and (idx - start + 1) >= limit:
                break


def count_records(path: Path, start: int, limit: int) -> int:
    count = 0
    with path.open("r", encoding="utf-8") as handle:
        for idx, line in enumerate(handle):
            if idx < start:
                continue
            if not line.strip():
                continue
            count += 1
            if limit and count >= limit:
                break
    return count


def load_taxonomy(path: Optional[str]) -> Sequence[str]:
    if path is None:
        return DEFAULT_TAXONOMY
    file_path = Path(path)
    if not file_path.exists():
        raise SystemExit(f"Taxonomy file not found: {path}")
    with file_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, list) or not all(isinstance(item, str) for item in data):
        raise SystemExit("Taxonomy file must be a JSON array of strings.")
    return tuple(item.strip() for item in data if item.strip())


def build_prompt(
    record: Dict,
    taxonomy: Sequence[str],
    include_taxonomy: bool,
    include_agent_reason: bool,
    hints_per_label: int,
) -> str:
    issue_key = record.get("issue_key", "UNKNOWN")
    contact_reason_cf = (
        (record.get("custom_fields") or {}).get("contact_reason")
        or (record.get("fields") or {}).get("contact_reason")
        or "N/A"
    )
    merged_text = (record.get("merged_text") or "").strip()
    if not merged_text:
        merged_text = _build_from_comments(record)

    sections = [
        "You are reviewing a Jira customer-support conversation.",
        "",
        f"Issue key: {issue_key}",
        "",
        "Conversation transcript:",
        "---",
        merged_text,
        "---",
        "",
    ]
    if include_taxonomy and taxonomy:
        sections.append("Available contact reasons:")
        sections.extend(f"- {item}" for item in taxonomy)
        if KEYWORD_CONTACT_MAP and hints_per_label > 0:
            hint_lines = []
            for item in taxonomy:
                keywords = KEYWORD_CONTACT_MAP.get(item)
                if not keywords:
                    continue
                selected = list(dict.fromkeys(keywords))[:hints_per_label]
                if not selected:
                    continue
                hint_lines.append(f"- {item}: {', '.join(selected)}")
            if hint_lines:
                sections.append("")
                sections.append("Keyword hints (per contact reason):")
                sections.extend(hint_lines)
        sections.append("")

    if include_agent_reason:
        sections.insert(4, f"Agent contact reason (if any): {contact_reason_cf}")
        sections.insert(5, "")

    sections.extend(
        [
            "Tasks:",
            "1. Pick the best contact reason from the company taxonomy.",
            "2. Do you agree with the contact reason from the custom field? If not, suggest a better one.",
            "3. Summarise the user's problem (one sentence).",
            "4. Describe the agent's resolution or next step (one sentence).",
            "5. List the distinct agent actions in chronological order.",
            "6. Rate the overall conversation quality from 1 (poor) to 5 (excellent).",
            "",
            "Respond with strictly valid JSON:",
            "{",
            '  "contact_reason_llm": string,',
            '  "contact_reason_justification": string,',
            '  "llm_summary_250": string (<=250 chars),',
            '  "problem_extract": string,',
            '  "resolution_extract": string,',
            '  "steps_extract": [string, ...],',
            '  "conversation_rating": string (1-5)',
            "}",
        ]
    )
    return "\n".join(sections).strip()


def _build_from_comments(record: Dict) -> str:
    comments = record.get("comments") or []
    lines = []
    for comment in comments:
        role = (comment.get("role") or "").strip()
        text = (comment.get("text") or "").strip()
        if not text:
            continue
        prefix = f"{role}: " if role else ""
        lines.append(f"{prefix}{text}")
    return "\n".join(lines)


def ensure_openai_client() -> OpenAIClient:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("OPENAI_API_KEY environment variable missing.")
        raise SystemExit(1)

    try:
        from openai import OpenAI  # type: ignore
    except ImportError:
        try:
            import openai  # type: ignore
        except ImportError as exc:  # pragma: no cover - dependency guard
            print("OpenAI package not installed. Run `pip install openai` and retry.")
            raise SystemExit(1) from exc
        openai.api_key = api_key  # type: ignore[attr-defined]
        return ("legacy", openai)

    client = OpenAI(api_key=api_key)
    return ("v1", client)


def send_prompt(
    openai_client: OpenAIClient,
    model: str,
    system_prompt: str,
    prompt: str,
    temperature: float,
    max_tokens: int,
) -> Tuple[str, int, int]:
    client_type, client = openai_client
    messages = [
        {
            "role": "system",
            "content": system_prompt,
        },
        {"role": "user", "content": prompt},
    ]
    if client_type == "v1":
        response = client.chat.completions.create(  # type: ignore[attr-defined]
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        content = response.choices[0].message.content  # type: ignore[index]
        usage = getattr(response, "usage", None)
        prompt_tokens = getattr(usage, "prompt_tokens", 0) if usage else 0
        completion_tokens = getattr(usage, "completion_tokens", 0) if usage else 0
    else:
        response = client.ChatCompletion.create(  # type: ignore[attr-defined]
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        content = response["choices"][0]["message"]["content"]  # type: ignore[index]
        usage = response.get("usage", {}) if isinstance(response, dict) else {}
        prompt_tokens = int(usage.get("prompt_tokens") or 0)
        completion_tokens = int(usage.get("completion_tokens") or 0)

    return content.strip(), prompt_tokens, completion_tokens


def extract_contact_reason_cf(record: Dict) -> str:
    custom_fields = record.get("custom_fields") or {}
    fields = record.get("fields") or {}
    value = custom_fields.get("contact_reason") or fields.get("contact_reason") or ""
    return str(value).strip()


def parse_json_response(text: str) -> Dict[str, Any]:
    stripped = text.strip()
    fenced = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)
    match = fenced.search(stripped)
    if match:
        candidate = match.group(1).strip()
    else:
        candidate = stripped

    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        # Attempt to extract first JSON object from the response.
        obj_match = re.search(r"\{.*\}", stripped, re.DOTALL)
        if obj_match:
            candidate = obj_match.group(0)
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass
        raise


def ensure_csv_header(path: Path, fieldnames: Sequence[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
        return

    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        existing_fields = list(reader.fieldnames or [])
        if existing_fields == list(fieldnames):
            return
        existing_rows = list(reader)

    normalized_rows: list[Dict[str, str]] = []
    for row in existing_rows:
        normalized: Dict[str, str] = {}
        for key, value in row.items():
            if key in fieldnames:
                normalized[key] = value
        for key in fieldnames:
            normalized.setdefault(key, "")
        normalized_rows.append(normalized)

    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(normalized_rows)


def append_row(path: Path, fieldnames: Sequence[str], row: Dict[str, str]) -> None:
    with path.open("a", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writerow(row)


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)

    if not input_path.exists():
        print(f"Input file not found: {input_path}")
        sys.exit(1)

    taxonomy = load_taxonomy(args.taxonomy_file)
    if args.print_taxonomy and taxonomy:
        print("Contact reason taxonomy:")
        for idx, entry in enumerate(taxonomy, start=1):
            print(f"{idx:2d}. {entry}")
        print("\n")

    taxonomy_in_system = not args.no_taxonomy_in_system
    system_prompt = build_system_prompt(
        taxonomy,
        include_taxonomy=taxonomy_in_system,
        hints_per_label=args.taxonomy_hints,
    )

    csv_path = Path(args.output_csv)
    fieldnames = [
        "issue_key",
        "contact_reason_cf",
        "contact_reason_llm",
        "contact_reason_change_justification",
        "agree_flag",
        "llm_summary_250",
        "problem_extract",
        "resolution_extract",
        "steps_extract",
        "conversation_rating",
        "llm_cost",
    ]
    ensure_csv_header(csv_path, fieldnames)

    if not args.auto_continue:
        print("System prompt preview:\n")
        print(system_prompt)
        proceed = input("\nProceed with this system prompt? [Y/n] ").strip().lower()
        if proceed not in {"", "y", "yes"}:
            print("Aborting.")
            return
        print()

    openai_client: Optional[OpenAIClient] = None
    total_prompt_tokens = 0
    total_completion_tokens = 0
    total_prompt_cost = 0.0
    total_completion_cost = 0.0

    display_prompts = args.show_prompts
    auto_send = args.auto_send

    if auto_send and args.limit == 0:
        print(
            "[warn] --auto-send used without --limit; the entire dataset will be processed."
        )
    if not display_prompts:
        print("[info] Prompt previews suppressed; pass --show-prompts to view them.")
    if auto_send:
        print("[info] Auto-send enabled; conversations will be submitted without prompts.")

    progress_enabled = not display_prompts
    progress_total = None
    if progress_enabled and args.limit:
        progress_total = count_records(input_path, args.start, args.limit)
    processed_count = 0
    progress_line_width = 0

    def update_progress_line(
        processed: int,
        last_prompt: int,
        last_completion: int,
        last_cost: Optional[float],
    ) -> None:
        nonlocal progress_line_width
        if not progress_enabled:
            return
        segments = []
        if progress_total:
            segments.append(f"{processed}/{progress_total}")
        else:
            segments.append(str(processed))
        segments.append(f"last {last_prompt}p/{last_completion}c tok")
        if last_cost is not None:
            segments.append(f"last ${last_cost:.4f}")
        segments.append(f"tot {total_prompt_tokens}p/{total_completion_tokens}c tok")
        total_cost_value = total_prompt_cost + total_completion_cost
        if total_cost_value > 0:
            segments.append(f"tot ${total_cost_value:.4f}")
        line = " | ".join(segments)
        progress_line_width = max(progress_line_width, len(line))
        sys.stdout.write("\r" + line.ljust(progress_line_width))
        sys.stdout.flush()

    for idx, record in enumerate(load_records(input_path, args.start, args.limit)):
        absolute_index = args.start + idx
        issue_key = record.get("issue_key", "UNKNOWN")
        contact_reason_cf = extract_contact_reason_cf(record)

        prompt = build_prompt(
            record,
            taxonomy=taxonomy,
            include_taxonomy=args.include_taxonomy_in_prompt,
            include_agent_reason=not args.hide_agent_contact_reason,
            hints_per_label=args.taxonomy_hints,
        )

        if display_prompts:
            print("=" * 80)
            print(f"[{absolute_index}] Issue: {issue_key}")
            print("- Prompt preview:\n")
            print(prompt)
            cost_info = preview_prompt_cost(
                args.model, system_prompt, prompt, args.max_tokens
            )
            if cost_info:
                label = (
                    "Token estimate (approx)"
                    if cost_info.get("approximate")
                    else "Token estimate"
                )
                tokens = cost_info["tokens"]
                input_cost = cost_info["input_cost"]
                max_completion = cost_info["max_completion_cost"]
                print(
                    f"\n{label}: {tokens:.0f} prompt tokens (≈${input_cost:.4f}) "
                    f"+ up to {args.max_tokens} completion tokens (≈${max_completion:.4f})."
                )
                system_tokens = cost_info.get("system_tokens")
                user_tokens = cost_info.get("user_tokens")
                system_flag = "~" if cost_info.get("system_approximate") else ""
                user_flag = "~" if cost_info.get("user_approximate") else ""
                if isinstance(system_tokens, (int, float)) and isinstance(
                    user_tokens, (int, float)
                ):
                    print(
                        "  System prompt tokens{}: {:.0f}".format(
                            system_flag, system_tokens
                        )
                    )
                    print(
                        "  Conversation prompt tokens{}: {:.0f}".format(
                            user_flag, user_tokens
                        )
                    )
            else:
                print(
                    "\nToken estimate unavailable for this model; update MODEL_PRICING if needed."
                )
            print("\n" + "-" * 80)

        send_current = auto_send
        skip_current = False

        while not send_current and not skip_current:
            choice = input("[s]end | s[k]ip | [q]uit > ").strip().lower()
            if choice in {"s", "send"}:
                send_current = True
            elif choice in {"k", "skip"}:
                skip_current = True
            elif choice in {"q", "quit"}:
                if progress_enabled:
                    sys.stdout.write("\n")
                print("Stopping.")
                return
            else:
                print("Unrecognised option. Please choose s/k/q.")

        if skip_current:
            if display_prompts:
                print("Skipped.")
            continue

        if openai_client is None:
            openai_client = ensure_openai_client()

        try:
            response_text, prompt_tokens, completion_tokens = send_prompt(
                openai_client,
                args.model,
                system_prompt,
                prompt,
                args.temperature,
                args.max_tokens,
            )
        except Exception as exc:  # pragma: no cover - network path
            print(f"[error] LLM request failed: {exc}")
            continue

        if display_prompts:
            print("\nLLM response:\n")
            print(response_text)

        prompt_cost_value: Optional[float] = None
        completion_cost_value: Optional[float] = None
        last_cost_value: Optional[float] = None

        try:
            parsed = parse_json_response(response_text)
        except json.JSONDecodeError as exc:
            print(f"[warn] Failed to parse LLM response JSON: {exc}")
            parsed = {}

        steps_field = parsed.get("steps_extract", [])
        if isinstance(steps_field, list):
            steps_joined = " | ".join(
                step.strip() for step in steps_field if step.strip()
            )
        else:
            steps_joined = str(steps_field or "")

        contact_reason_llm = str(parsed.get("contact_reason_llm") or "").strip()
        justification = str(
            parsed.get("contact_reason_change_justification")
            or parsed.get("contact_reason_justification")
            or ""
        ).strip()
        llm_summary_250 = str(parsed.get("llm_summary_250") or "").strip()
        problem_extract = str(parsed.get("problem_extract") or "").strip()
        resolution_extract = str(parsed.get("resolution_extract") or "").strip()
        conversation_rating = str(parsed.get("conversation_rating") or "").strip()

        agree_flag = (
            contact_reason_cf.lower() == contact_reason_llm.lower()
            if contact_reason_cf and contact_reason_llm
            else False
        )
        llm_cost_value = ""
        row_data = {
            "issue_key": issue_key,
            "contact_reason_cf": contact_reason_cf,
            "contact_reason_llm": contact_reason_llm,
            "contact_reason_change_justification": justification,
            "agree_flag": str(agree_flag),
            "llm_summary_250": llm_summary_250,
            "problem_extract": problem_extract,
            "resolution_extract": resolution_extract,
            "steps_extract": steps_joined,
            "conversation_rating": conversation_rating,
            "llm_cost": llm_cost_value,
        }

        if not contact_reason_llm:
            print(
                "[warn] Missing contact_reason_llm in response; writing row with empty value."
            )

        response_length = len(response_text)
        total_prompt_tokens += prompt_tokens
        total_completion_tokens += completion_tokens

        cost_breakdown = compute_costs(args.model, prompt_tokens, completion_tokens)
        if cost_breakdown:
            prompt_cost_value, completion_cost_value = cost_breakdown
            total_prompt_cost += prompt_cost_value
            total_completion_cost += completion_cost_value
            last_cost_value = prompt_cost_value + completion_cost_value
            llm_cost_value = f"{last_cost_value:.6f}"
            if display_prompts:
                print(
                    "\nUsage: "
                    f"{prompt_tokens} prompt tok (${prompt_cost_value:.4f}) + "
                    f"{completion_tokens} completion tok (${completion_cost_value:.4f}); "
                    f"response length {response_length} chars."
                )
                print(
                    "Session totals: "
                    f"{total_prompt_tokens} prompt tok (${total_prompt_cost:.4f}) + "
                    f"{total_completion_tokens} completion tok (${total_completion_cost:.4f})."
                )
        else:
            if display_prompts:
                print(
                    "\nUsage: "
                    f"{prompt_tokens} prompt tok + {completion_tokens} completion tok; "
                    f"response length {response_length} chars."
                )
                print(
                    f"Session totals: {total_prompt_tokens} prompt tok + "
                    f"{total_completion_tokens} completion tok."
                )

        row_data["llm_cost"] = llm_cost_value
        append_row(csv_path, fieldnames, row_data)

        if display_prompts:
            print(
                f"\nAppended HITL row to {csv_path} "
                f"(issue {issue_key}, agree_flag={agree_flag})."
            )

        processed_count += 1
        update_progress_line(processed_count, prompt_tokens, completion_tokens, last_cost_value)

    if progress_enabled and processed_count:
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
