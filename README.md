# Jira ITSM Conversation Quality (PoC)

This repository contains a proof-of-concept Jira ITSM quality monitor. It
simulates a Jira webhook pipeline by taking a Jira CSV export, normalising it
into an LLM-friendly JSONL feed, scoring the conversations (optionally with an
LLM), and rendering a dashboard with 24 h, 7 d, and 30 d quality metrics.

## Project layout

```
analysis/
  prepare_dataset.py        # Converts Jira CSV exports into jira_clean_sample.jsonl.
  conversation_analysis.py  # CLI script that scores the JSONL conversations.
app/
  dashboard.py              # Flask app that displays summary metrics and trends.
  templates/                # HTML templates for the dashboard UI.
  static/                   # Dashboard theme overrides.
data/
  jira_export_sample.csv    # Synthetic Jira export (CSV) for the PoC.
  jira_clean_sample.jsonl   # Normalised conversations created by prepare_dataset.py.
```

## Getting started

1. **Install dependencies**

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Normalise the Jira export**

   ```bash
   python analysis/prepare_dataset.py
   ```

   The script mirrors the reference ingestion utility shared in the brief,
   producing `data/jira_clean_sample.jsonl`.

3. **Generate analysis output**

   ```bash
   python -m analysis.conversation_analysis \
       --input-jsonl data/jira_clean_sample.jsonl \
       --output data/analysis_output.csv
   ```

   Set `OPENAI_API_KEY` and `--llm-model` (for example `gpt-4o-mini`) to enable
   LLM-backed scoring. The default heuristic scorer is deterministic and
   requires no external services.

4. **Run the dashboard**

   ```bash
   flask --app app.dashboard run --debug
   ```

   Visit <http://127.0.0.1:5000> to view the conversation quality dashboard.

## Next steps

* Replace the CSV ingest with Jira webhooks (issue created / updated events).
* Persist conversations and scores in a database for historical reporting.
* Extend the LLM prompt for richer coaching feedback and escalation triggers.
* Package the Flask app as a Jira Forge or Connect extension.
