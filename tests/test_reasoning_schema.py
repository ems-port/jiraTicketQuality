import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import List

from analysis.convo_quality import (
  compute_metrics,
  load_jsonl,
  parse_comments,
  process_conversation
)

ARTIFACT_PATH = Path("tests/artifacts/reasoning_schema_snapshot.jsonl")

class ReasoningSchemaTestCase(unittest.TestCase):
  def test_first_twenty_tickets_emit_reasoning_fields(self) -> None:
    dataset_path = Path("data/jira_clean_nov.jsonl")
    records = list(load_jsonl(dataset_path, limit=20))
    self.assertEqual(len(records), 20, "Fixture must provide 20 conversations for the regression test.")

    artifact_rows = []
    for record in records:
      comments = list(parse_comments(record.get("comments", [])))
      metrics = compute_metrics(comments)
      payload = build_stub_payload(record, comments, metrics)
      row = process_conversation(record, metrics, payload, "stub-model", None, None, None)

      self.assertTrue(row["reason_override_why"], "reason_override_why must not be empty")
      self.assertTrue(row["resolution_why"], "resolution_why must not be empty")
      self.assertEqual(row["contact_reason_change"], "true")
      self.assertEqual(row["is_resolved"], "true")
      self.assertEqual(row["resolved"], "true")
      self.assertTrue(row["problem_extract"])
      self.assertTrue(row["resolution_extract"])
      self.assertLessEqual(len(row["resolution_extract"].split()), 15)
      self.assertTrue(row["resolution_timestamp_iso"])
      self.assertTrue(row["resolution_message_index"])
      if row["resolution_timestamp_iso"]:
        self.assertTrue(row["duration_to_resolution"])

      steps = json.loads(row["steps_extract"])
      self.assertIsInstance(steps, list)
      self.assertGreater(len(steps), 0)

      sentiment_scores = json.loads(row["customer_sentiment_scores"])
      self.assertEqual(len(sentiment_scores.keys()), 8)
      total = sum(sentiment_scores.values())
      self.assertTrue(abs(total - 1.0) <= 0.02)
      self.assertEqual(row["customer_sentiment_primary"], "Frustration")
      self.assertIn(row["agent_profanity_detected"], {"true", "false"})
      self.assertIn(row["customer_abuse_detected"], {"true", "false"})
      artifact_rows.append(_denormalise_row(row))

    _write_artifact(artifact_rows)


def build_stub_payload(record, comments, metrics):
  custom_fields = record.get("custom_fields") or {}
  original_reason = ""
  if isinstance(custom_fields, dict):
    original_reason = str(custom_fields.get("contact_reason") or "").strip()
  issue_key = record.get("issue_key", "UNKNOWN")
  first_customer_quote = _first_text(comments, target_role="customer") or record.get("user_summary", "")
  agent_close = _first_text(reversed(comments), target_role="agent")
  resolution_ts = metrics.conversation_end or metrics.conversation_start
  if not resolution_ts:
    resolution_ts = datetime.now(timezone.utc)
  steps = _agent_steps(comments)
  steps_extract: List[str] = steps if steps else ["Agent acknowledged and queued manual follow-up."]
  contact_reason = f"{original_reason or 'Other'} - clarified"
  sentiment_scores = {
    "Delight": 0.0,
    "Convenience": 0.1,
    "Trust": 0.05,
    "Frustration": 0.35,
    "Disappointment": 0.25,
    "Concern": 0.15,
    "Hostility": 0.05,
    "Neutral": 0.05,
  }

  return {
    "llm_summary_250": f"{issue_key}: Stubbed summary for regression test.",
    "conversation_rating": 4,
    "extract_customer_probelm": first_customer_quote[:250],
    "problem_extract": first_customer_quote[:250],
    "resolution_extract": "Agent closed ticket after confirming manual fix.",
    "contact_reason": contact_reason,
    "contact_reason_change": True,
    "reason_override_why": f'Customer mention "{first_customer_quote[:60]}" required retagging.',
    "agent_score": 4,
    "customer_score": 3,
    "resolved": True,
    "is_resolved": True,
    "resolution_why": f'Resolution confirmed when agent said "{(agent_close or "issue cleared")[:80]}".',
    "steps_extract": steps_extract,
    "resolution_timestamp_iso": resolution_ts.isoformat(),
    "resolution_message_index": len(comments) if comments else 1,
    "customer_sentiment_primary": "Frustration",
    "customer_sentiment_scores": sentiment_scores,
    "improvement_tip": "Confirm resolution timestamp inside the ticket summary.",
    "agent_profanity_detected": False,
    "agent_profanity_count": 0,
    "customer_abuse_detected": False,
    "customer_abuse_count": 0,
  }


def _first_text(comment_iterable, target_role: str) -> str:
  for comment in comment_iterable:
    if getattr(comment, "role", "").lower() == target_role and getattr(comment, "text", ""):
      return str(comment.text).strip()
  return ""


def _agent_steps(comments) -> List[str]:
  steps: List[str] = []
  for idx, comment in enumerate([c for c in comments if c.role == "agent"][:3], start=1):
    timestamp = comment.timestamp.isoformat() if comment.timestamp else "unknown time"
    snippet = (comment.text or "").strip()
    steps.append(f"Step {idx}: ({timestamp}) {snippet[:160]}")
  return steps


def _denormalise_row(row: dict) -> dict:
  serialised = dict(row)
  try:
    serialised["steps_extract"] = json.loads(row.get("steps_extract") or "[]")
  except json.JSONDecodeError:
    serialised["steps_extract"] = []
  try:
    serialised["customer_sentiment_scores"] = json.loads(row.get("customer_sentiment_scores") or "{}")
  except json.JSONDecodeError:
    serialised["customer_sentiment_scores"] = {}
  return serialised


def _write_artifact(rows: List[dict]) -> None:
  ARTIFACT_PATH.parent.mkdir(parents=True, exist_ok=True)
  with ARTIFACT_PATH.open("w", encoding="utf-8") as handle:
    for row in rows:
      handle.write(json.dumps(row, ensure_ascii=False))
      handle.write("\n")


if __name__ == "__main__":
  unittest.main()
