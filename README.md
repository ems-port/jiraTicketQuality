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

## Automated Jira ingestion

`jiraPull/injestionTest.py` replaces the manual CSV download loop with a
scheduler/webhook-friendly ingestion job. It pulls Jira tickets that match the
production JQL (`project = CC AND statusCategory = Done` with a default
`created >= 2025-11-01` cut-off), stores the required fields for
`analysis/prepare_dataset.py`, and normalises every comment thread.

### Required environment

Add the following variables to `.env` (or your deployment secret store):

| Variable | Purpose |
| --- | --- |
| `JIRA_BASE_URL` | Optional override (defaults to `https://portapp.atlassian.net`). |
| `JIRA_EMAIL` | Jira account email used alongside the API token. |
| `JIRA_API_KEY` | Jira API token (already present). |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key so we can upsert rows. |
| `SUPABASE_DB_URL` | Optional Postgres connection string for automatic table creation. |
| `SUPABASE_JIRA_PREPARED_TABLE` | Optional override for the prepared dataset table (default `jira_prepared_conversations`). |

Install the Python dependencies and run:

```bash
python jiraPull/injestionTest.py \
  --project CC \
  --status-category Done \
  --start-date 2025-11-01
```

Use `--dry-run` to verify connectivity, `--max-issues` to rate-limit a first
sync, and `--force-full-refresh` if you ever need to ignore the checkpoint.

### Supabase schema

Ingestion now persists the JSONL-ready payload directly in
`jira_prepared_conversations` (one row per Jira ticket, including the comment
thread and token counts). If `SUPABASE_DB_URL` is provided the script will
auto-create this table on startup; otherwise apply `supabase/schema.sql`
through the Supabase SQL editor or `psql` once. The schema file now also drops
the legacy tables and creates the downstream `jira_processed_conversations`
table, so re-run it after pulling these changes.

### Conversation processing

Once raw tickets are ingested, run the simplified processor to call the LLM and
persist the CSV-style metrics directly into Supabase:

```bash
python jiraPull/process_conversations.py \
  --limit 50 \
  --model gpt-5-nano \
  --log-level INFO
```

Pass `--no-llm` to skip OpenAI calls, `--taxonomy-file` for custom contact
labels, or `--prepared-table`/`--processed-table` to point at alternative
tables. The command skips conversations already present in
`jira_processed_conversations` and marks each prepared row with a `processed`
flag once it’s stored, so the job can resume safely after a restart. If the LLM
fails, the script retries the conversation once and aborts after three
consecutive failures to avoid silently skipping data. The processor runs with
8 parallel threads by default and logs progress (`Processing progress:
X/Y (Z%) [ISSUE]`) so you can surface it in the dashboard or a job monitor.

## Next steps

* Replace the CSV ingest with Jira webhooks (issue created / updated events).
* Persist conversations and scores in a database for historical reporting.
* Extend the LLM prompt for richer coaching feedback and escalation triggers.
* Package the Flask app as a Jira Forge or Connect extension.
