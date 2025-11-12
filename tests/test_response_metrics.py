import unittest
from datetime import datetime, timedelta, timezone

from analysis.convo_quality import Comment, compute_metrics


def _ts(start: datetime, minutes: int) -> datetime:
  return start + timedelta(minutes=minutes)


class ResponseMetricsTestCase(unittest.TestCase):
  def test_agent_response_average_skips_extra_follow_ups(self) -> None:
    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    comments = [
      Comment(timestamp=_ts(start, 0), author="customer", role="customer", role_short="C", text="Need help"),
      Comment(timestamp=_ts(start, 2), author="agent", role="agent", role_short="A", text="Sure"),
      Comment(timestamp=_ts(start, 7), author="agent", role="agent", role_short="A", text="Following up"),
      Comment(timestamp=_ts(start, 10), author="customer", role="customer", role_short="C", text="Still waiting"),
      Comment(timestamp=_ts(start, 11), author="customer", role="customer", role_short="C", text="Any update?"),
      Comment(timestamp=_ts(start, 15), author="agent", role="agent", role_short="A", text="Resolved"),
    ]

    metrics = compute_metrics(comments)

    self.assertEqual(metrics.first_agent_response_minutes, 2)
    self.assertIsNotNone(metrics.avg_agent_response_minutes)
    self.assertAlmostEqual(metrics.avg_agent_response_minutes or 0.0, 3.5, places=6)
