"""Conversation quality scoring for Jira ITSM proof-of-concept."""

from __future__ import annotations

import argparse
import csv
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Sequence

try:  # pragma: no cover - optional dependency
    from openai import OpenAI
except ImportError:  # pragma: no cover - optional dependency
    OpenAI = None  # type: ignore

# Keyword heuristics
POSITIVE_AGENT_KEYWORDS = {
    "thanks",
    "thank you",
    "apologies",
    "sorry",
    "glad",
    "happy",
    "resolved",
    "escalated",
    "monitor",
    "follow up",
    "great news",
}
NEGATIVE_AGENT_KEYWORDS = {
    "can't",
    "cannot",
    "unable",
    "delay",
    "waiting",
    "later",
    "tomorrow",
}
POSITIVE_CUSTOMER_KEYWORDS = {
    "thanks",
    "thank you",
    "appreciate",
    "great",
    "perfect",
    "good",
    "awesome",
    "works",
}
NEGATIVE_CUSTOMER_KEYWORDS = {
    "broken",
    "angry",
    "frustrated",
    "ridiculous",
    "awful",
    "terrible",
    "slow",
    "waiting",
    "took long",
}
ABUSIVE_CUSTOMER_KEYWORDS = {
    "idiot",
    "stupid",
    "hate",
    "useless",
    "damn",
    "hell",
    "ridiculous",
}
AGENT_AUTHOR_HINTS = {
    "support",
    "agent",
    "service",
    "helpdesk",
    "admin",
    "it",
}


@dataclass
class Message:
    timestamp: datetime
    author: str
    role: str
    text: str


@dataclass
class ConversationScore:
    issue_key: str
    created_at: datetime
    resolved_at: datetime
    quality_score: float
    agent_score: float
    customer_sentiment: str
    abusive_language: bool
    needs_improvement: bool
    improvement_notes: str
    agent_highlights: str

    def to_row(self) -> Dict[str, str]:
        return {
            "issue_key": self.issue_key,
            "created_at": self.created_at.isoformat(),
            "resolved_at": self.resolved_at.isoformat(),
            "quality_score": f"{self.quality_score:.2f}",
            "agent_score": f"{self.agent_score:.2f}",
            "customer_sentiment": self.customer_sentiment,
            "abusive_language": str(self.abusive_language),
            "needs_improvement": str(self.needs_improvement),
            "improvement_notes": self.improvement_notes,
            "agent_highlights": self.agent_highlights,
        }


@dataclass
class LLMResult:
    quality_score: float
    agent_score: float
    customer_sentiment: str
    abusive_language: bool
    needs_improvement: bool
    improvement_notes: str
    agent_highlights: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score Jira ITSM conversations from JSONL input.")
    parser.add_argument(
        "--input-jsonl",
        default="data/jira_clean_sample.jsonl",
        help="Path to the JSONL file produced by prepare_dataset.py",
    )
    parser.add_argument(
        "--output",
        default="data/analysis_output.csv",
        help="Destination CSV path for scored conversations.",
    )
    parser.add_argument(
        "--llm-model",
        default=os.getenv("QUALITY_LLM_MODEL"),
        help="Optional OpenAI chat model to refine heuristic scores.",
    )
    parser.add_argument(
        "--max-conversations",
        type=int,
        default=0,
        help="Limit the number of conversations processed (0 = no limit).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print progress details while scoring.",
    )
    return parser.parse_args()


def load_jsonl(path: Path, limit: int = 0) -> Iterator[Dict[str, object]]:
    processed = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            yield record
            processed += 1
            if limit and processed >= limit:
                break


def parse_datetime(value: str) -> datetime:
    value = (value or "").strip()
    if not value:
        return datetime.fromtimestamp(0, tz=timezone.utc)
    normalized = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
            try:
                parsed = datetime.strptime(value, fmt)
                parsed = parsed.replace(tzinfo=timezone.utc)
                break
            except ValueError:
                continue
        else:  # pragma: no cover - rare formats
            parsed = datetime.fromtimestamp(0, tz=timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def classify_role(comment: Dict[str, object], reporter: str, index: int) -> str:
    if comment.get("internal_note"):
        return "internal"
    author = str(comment.get("author") or "").strip()
    reporter_norm = (reporter or "").strip().lower()
    author_norm = author.lower()
    if reporter_norm and author_norm == reporter_norm:
        return "customer"
    if any(hint in author_norm for hint in AGENT_AUTHOR_HINTS):
        return "agent"
    if reporter_norm and author and author_norm != reporter_norm:
        return "agent"
    if index == 1:
        return "customer"
    return "agent"


def build_messages(record: Dict[str, object]) -> List[Message]:
    reporter = str(record.get("reporter") or "")
    comments = record.get("comments") or []
    messages: List[Message] = []
    for idx, comment in enumerate(comments, start=1):
        if not isinstance(comment, dict):
            continue
        role = classify_role(comment, reporter, idx)
        if role == "internal":
            continue
        text = str(comment.get("text") or "").strip()
        if not text:
            continue
        timestamp_raw = str(comment.get("date") or "")
        if timestamp_raw:
            timestamp = parse_datetime(timestamp_raw)
        else:
            timestamp = parse_datetime(str(record.get("updated") or record.get("created") or ""))
        messages.append(
            Message(
                timestamp=timestamp,
                author=str(comment.get("author") or "unknown"),
                role=role,
                text=text,
            )
        )
    messages.sort(key=lambda msg: msg.timestamp)
    if not messages:
        fallback_timestamp = parse_datetime(str(record.get("updated") or record.get("created") or ""))
        messages.append(
            Message(
                timestamp=fallback_timestamp,
                author=str(reporter or "unknown"),
                role="customer",
                text=str(record.get("summary") or ""),
            )
        )
    return messages


def detect_abuse(messages: Sequence[Message]) -> bool:
    for message in messages:
        if message.role != "customer":
            continue
        lowered = message.text.lower()
        if any(keyword in lowered for keyword in ABUSIVE_CUSTOMER_KEYWORDS):
            return True
    return False


def sentiment_from_messages(messages: Sequence[Message]) -> str:
    score = 0
    for message in messages:
        lowered = message.text.lower()
        if message.role == "customer":
            if any(keyword in lowered for keyword in POSITIVE_CUSTOMER_KEYWORDS):
                score += 1
            if any(keyword in lowered for keyword in NEGATIVE_CUSTOMER_KEYWORDS):
                score -= 1
    if score > 1:
        return "positive"
    if score < 0:
        return "negative"
    return "neutral"


def heuristic_score(
    issue_key: str,
    created_at: datetime,
    resolved_at: datetime,
    messages: Sequence[Message],
) -> ConversationScore:
    if not messages:
        raise ValueError("Conversation must contain at least one message")

    quality = 3.0
    agent_score = 3.0
    improvement_notes: List[str] = []
    agent_highlights: List[str] = []

    for message in messages:
        lowered = message.text.lower()
        if message.role == "customer":
            if any(keyword in lowered for keyword in NEGATIVE_CUSTOMER_KEYWORDS):
                quality -= 0.4
            if any(keyword in lowered for keyword in POSITIVE_CUSTOMER_KEYWORDS):
                quality += 0.3
        elif message.role == "agent":
            if any(keyword in lowered for keyword in NEGATIVE_AGENT_KEYWORDS):
                agent_score -= 0.5
                improvement_notes.append(f"Agent message indicates delay: '{message.text[:80]}'")
            if any(keyword in lowered for keyword in POSITIVE_AGENT_KEYWORDS):
                agent_score += 0.4
                agent_highlights.append(message.text)

    abusive = detect_abuse(messages)
    if abusive:
        quality -= 0.5
        improvement_notes.append("Customer used abusive language.")

    sentiment = sentiment_from_messages(messages)
    if sentiment == "negative":
        quality -= 0.3
    elif sentiment == "positive":
        quality += 0.2

    quality = max(1.0, min(5.0, quality))
    agent_score = max(1.0, min(5.0, agent_score))

    needs_improvement = quality < 3.5 or agent_score < 3.5 or abusive
    if needs_improvement and not improvement_notes:
        improvement_notes.append("Review conversation for coaching opportunities.")

    return ConversationScore(
        issue_key=issue_key,
        created_at=created_at,
        resolved_at=resolved_at,
        quality_score=quality,
        agent_score=agent_score,
        customer_sentiment=sentiment,
        abusive_language=abusive,
        needs_improvement=needs_improvement,
        improvement_notes=" ".join(improvement_notes).strip(),
        agent_highlights=" | ".join(agent_highlights)[:250],
    )


def apply_llm(messages: Sequence[Message], args: argparse.Namespace) -> Optional[LLMResult]:
    model = args.llm_model
    if not model:
        return None
    if OpenAI is None:
        if args.verbose:
            print("[warn] openai package unavailable; skipping LLM scoring")
        return None
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        if args.verbose:
            print("[warn] OPENAI_API_KEY not set; skipping LLM scoring")
        return None

    client = OpenAI(api_key=api_key)
    transcript_lines = []
    for message in messages:
        transcript_lines.append(f"{message.timestamp.isoformat()} {message.role.upper()}: {message.text}")
    transcript = "\n".join(transcript_lines)
    system_prompt = (
        "You are a support quality reviewer. Return JSON with keys quality_score (1-5), "
        "agent_score (1-5), customer_sentiment (positive/neutral/negative), abusive_language (true/false), "
        "needs_improvement (true/false), improvement_notes, agent_highlights."
    )
    user_prompt = (
        "Evaluate the following Jira support conversation and provide calibrated feedback."
        "\n\nConversation transcript:\n" + transcript
    )
    try:  # pragma: no cover - network call
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
            max_tokens=400,
        )
        content = response.choices[0].message.content or ""
        data = json.loads(content.split("```json")[-1].split("```", 1)[0].strip() or content)
    except Exception as exc:  # pragma: no cover - network path
        if args.verbose:
            print(f"[warn] LLM scoring failed: {exc}")
        return None

    try:
        return LLMResult(
            quality_score=float(data.get("quality_score", 0) or 0),
            agent_score=float(data.get("agent_score", 0) or 0),
            customer_sentiment=str(data.get("customer_sentiment", "")).strip() or "neutral",
            abusive_language=bool(data.get("abusive_language", False)),
            needs_improvement=bool(data.get("needs_improvement", False)),
            improvement_notes=str(data.get("improvement_notes", "")).strip(),
            agent_highlights=str(data.get("agent_highlights", "")).strip(),
        )
    except Exception:
        return None


def merge_scores(heuristic: ConversationScore, llm: Optional[LLMResult]) -> ConversationScore:
    if llm is None:
        return heuristic

    quality = _average_nonzero([heuristic.quality_score, llm.quality_score])
    agent_score = _average_nonzero([heuristic.agent_score, llm.agent_score])
    abusive = heuristic.abusive_language or llm.abusive_language
    sentiment = llm.customer_sentiment or heuristic.customer_sentiment
    needs_improvement = llm.needs_improvement or heuristic.needs_improvement
    improvement_notes = llm.improvement_notes or heuristic.improvement_notes
    agent_highlights = llm.agent_highlights or heuristic.agent_highlights

    return ConversationScore(
        issue_key=heuristic.issue_key,
        created_at=heuristic.created_at,
        resolved_at=heuristic.resolved_at,
        quality_score=quality,
        agent_score=agent_score,
        customer_sentiment=sentiment,
        abusive_language=abusive,
        needs_improvement=needs_improvement,
        improvement_notes=improvement_notes,
        agent_highlights=agent_highlights,
    )


def _average_nonzero(values: Sequence[float]) -> float:
    valid = [value for value in values if value]
    if not valid:
        return 0.0
    return sum(valid) / len(valid)


def ensure_header(path: Path, fieldnames: Sequence[str]) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()


def append_row(path: Path, fieldnames: Sequence[str], row: Dict[str, str]) -> None:
    with path.open("a", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writerow(row)


def main() -> None:
    args = parse_args()
    input_path = Path(args.input_jsonl)
    if not input_path.exists():
        raise SystemExit(f"Input JSONL not found: {input_path}")

    fieldnames = [
        "issue_key",
        "created_at",
        "resolved_at",
        "quality_score",
        "agent_score",
        "customer_sentiment",
        "abusive_language",
        "needs_improvement",
        "improvement_notes",
        "agent_highlights",
    ]
    output_path = Path(args.output)
    ensure_header(output_path, fieldnames)

    processed = 0
    for record in load_jsonl(input_path, limit=args.max_conversations):
        issue_key = str(record.get("issue_key") or "UNKNOWN")
        messages = build_messages(record)
        created_raw = str(record.get("created") or "")
        updated_raw = str(record.get("updated") or "")
        created_at = parse_datetime(created_raw) if created_raw else messages[0].timestamp
        resolved_at = parse_datetime(updated_raw) if updated_raw else messages[-1].timestamp
        heuristic = heuristic_score(issue_key, created_at, resolved_at, messages)
        llm_result = apply_llm(messages, args)
        combined = merge_scores(heuristic, llm_result)
        append_row(output_path, fieldnames, combined.to_row())
        processed += 1
        if args.verbose:
            print(f"Processed {issue_key}: quality={combined.quality_score:.2f}, agent={combined.agent_score:.2f}")

    if args.verbose:
        print(f"Completed {processed} conversations → {output_path}")


if __name__ == "__main__":
    main()
