"""Flask application that renders the Jira ITSM quality dashboard.

The dashboard reads the conversation analysis CSV produced by
``analysis.conversation_analysis`` and aggregates metrics for the most recent
24 hours, 7 days, and 30 days.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List

import pandas as pd
from flask import Flask, render_template

ANALYSIS_OUTPUT_PATH = Path("data/analysis_output.csv")


def create_app() -> Flask:
    app = Flask(__name__)

    @app.route("/")
    def index() -> str:
        df = load_analysis_dataframe()
        periods = build_period_definitions()
        metrics = {label: compute_metrics(df, delta) for label, delta in periods.items()}
        trends = build_trends(df)
        return render_template(
            "dashboard.html",
            metrics=metrics,
            trends_json=json.dumps(trends),
            last_updated=last_updated_at(df),
        )

    return app


def load_analysis_dataframe() -> pd.DataFrame:
    if not ANALYSIS_OUTPUT_PATH.exists():
        raise RuntimeError(
            "Analysis output not found. Run `python -m analysis.conversation_analysis` first."
        )
    df = pd.read_csv(ANALYSIS_OUTPUT_PATH)
    df["created_at"] = pd.to_datetime(df["created_at"], utc=True)
    df["resolved_at"] = pd.to_datetime(df["resolved_at"], utc=True)
    df["quality_score"] = pd.to_numeric(df["quality_score"], errors="coerce").fillna(0)
    df["agent_score"] = pd.to_numeric(df["agent_score"], errors="coerce").fillna(0)
    df["needs_improvement"] = df["needs_improvement"].astype(str).str.lower() == "true"
    df["abusive_language"] = df["abusive_language"].astype(str).str.lower() == "true"
    return df


def build_period_definitions() -> Dict[str, timedelta]:
    return {
        "24h": timedelta(hours=24),
        "7d": timedelta(days=7),
        "30d": timedelta(days=30),
    }


def compute_metrics(df: pd.DataFrame, period: timedelta) -> Dict[str, float | int | List[str]]:
    cutoff = datetime.now(timezone.utc) - period
    recent = df[df["resolved_at"] >= cutoff]
    if recent.empty:
        return {
            "total_conversations": 0,
            "avg_quality": 0.0,
            "avg_agent_score": 0.0,
            "needs_improvement": 0,
            "abusive_count": 0,
            "improvement_examples": [],
        }

    avg_quality = round(float(recent["quality_score"].mean()), 2)
    avg_agent = round(float(recent["agent_score"].mean()), 2)
    needs_improvement = int(recent["needs_improvement"].sum())
    abusive_count = int(recent["abusive_language"].sum())
    examples = (
        recent.loc[recent["needs_improvement"], "improvement_notes"].dropna().head(3).tolist()
    )
    return {
        "total_conversations": int(len(recent)),
        "avg_quality": avg_quality,
        "avg_agent_score": avg_agent,
        "needs_improvement": needs_improvement,
        "abusive_count": abusive_count,
        "improvement_examples": examples,
    }


def build_trends(df: pd.DataFrame) -> Dict[str, List[Dict[str, float | str]]]:
    df = df.copy()
    df["resolved_date"] = df["resolved_at"].dt.date
    grouped = df.groupby("resolved_date").agg(
        avg_quality=("quality_score", "mean"),
        avg_agent_score=("agent_score", "mean"),
        conversations=("issue_key", "count"),
    )
    grouped = grouped.sort_index()
    return {
        "quality": [
            {"date": date.isoformat(), "value": round(float(row.avg_quality), 2)}
            for date, row in grouped.iterrows()
        ],
        "agent": [
            {"date": date.isoformat(), "value": round(float(row.avg_agent_score), 2)}
            for date, row in grouped.iterrows()
        ],
        "volume": [
            {"date": date.isoformat(), "value": int(row.conversations)}
            for date, row in grouped.iterrows()
        ],
    }


def last_updated_at(df: pd.DataFrame) -> str:
    if df.empty:
        return "N/A"
    latest = df["resolved_at"].max()
    return latest.tz_convert(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


app = create_app()

if __name__ == "__main__":  # pragma: no cover - manual launch helper
    app.run(debug=True, port=5000)
