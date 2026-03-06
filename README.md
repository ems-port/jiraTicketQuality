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
| `REFRESH_CRON_SECRET` | Optional shared secret checked by the `/api/cron/refresh` endpoint. |
| `THINGSBOARD_URL` | ThingsBoard base URL (for example `https://iot.port.app`). |
| `THINGSBOARD_USERNAME` | ThingsBoard login username. |
| `THINGSBOARD_PASSWORD` | ThingsBoard login password. |
| `THINGSBOARD_ASSET_TYPE` | Optional default ThingsBoard asset type filter (defaults to `Hub`). |
| `THINGSBOARD_ASSET_LABEL` | Optional default exact label filter (defaults to `production`). |
| `THINGSBOARD_API_TEXT_SEARCH` | Optional ThingsBoard `textSearch` hint to reduce API pages. |
| `SUPABASE_HUB_TELEMETRY_TABLE` | Optional target history table for hub telemetry (defaults to `hub_telemetry_history`). |
| `HUB_TELEMETRY_SYNC_SECRET` | Required in production to authorize `/api/hub-telemetry/sync`. |
| `HUB_TELEMETRY_MIN_INTERVAL_SECONDS` | Optional cooldown between endpoint invocations (default `60`). |
| `HUB_TELEMETRY_MAX_PAGE_SIZE` | Optional hard cap for requested page size (default `250`). |
| `HUB_TELEMETRY_ALLOW_STATUS_GET` | Optional (`true`/`false`) to enable authenticated `GET /api/hub-telemetry/sync` status output (default `false`). |

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

## Scheduled refresh on Vercel

The dashboard exposes `POST /api/refresh-data` for manual ingests and a cron-friendly
`GET /api/cron/refresh` endpoint that starts the same job. Deployments can now ship
with the following scheduling workflow:

1. Set `REFRESH_CRON_SECRET` in the Vercel project (a random string). Requests to
   `/api/cron/refresh` must include `Authorization: Bearer <secret>` or
   `x-cron-secret: <secret>`; local testing can also pass `?token=<secret>`.
2. Keep `vercel.json` committed so every deployment automatically registers cron entries.
   Use `/api/cron/refresh` for the ingest/process pipeline, and `/api/cron/improvement-groups`
   for the LLM "tips/problems" summary job. Do not target `GET /api/improvement-groups` in cron,
   because that endpoint only reads the latest stored grouping and does not execute the job.
3. Adjust each cron `schedule` field to any
   valid Cron expression such as `"*/15 * * * *"` for a 15-minute cadence.
4. In the Vercel dashboard, confirm that each cron job exists for the branch you need.
   If you want to run against production, ensure the cron job is linked to the `production`
   deployment. Cron jobs are available on all plans, but double-check on Hobby projects
   whether the job targets preview or production—historically only preview deploys were
   supported, so you may need to upgrade for production automation.

When the cron invocation starts the job it returns immediately with the current job state.
The serverless function streams Python logs to Vercel’s function logs, so failed runs can
be debugged without re-deploying.

## Improvement point feedback and trends

Improvement grouping is now stored in two layers:

1. `improvement_tip_groupings`: raw snapshot metadata + original JSON payload.
2. `improvement_tip_group_items`: one row per grouped improvement point (topic key, title, metrics, key IDs, next steps).

Metrics Validation (LLM feedback usefulness) is stored in:

- `improvement_tip_group_feedback`: one row per `(grouping_id, group_id, user_id)` with `verdict` (`up`/`down`) and optional notes.

API routes:

- `GET /api/improvement-group-feedback?groupingId=<id>&groupIds=a,b,c&userId=<id>`
- `POST /api/improvement-group-feedback`
- `GET /api/improvement-group-trends?days=30&limit=9`

To enable these tables/endpoints, apply the latest `supabase/schema.sql`.

## Hub telemetry sync endpoint

Use `POST /api/hub-telemetry/sync` to pull latest ThingsBoard hub telemetry and insert a
snapshot into Supabase history table `hub_telemetry_history`.

- `GET /api/hub-telemetry/sync`: readiness check (env/defaults/auth configuration).
- `POST /api/hub-telemetry/sync`: run sync now.
- Auth required in all environments: set `HUB_TELEMETRY_SYNC_SECRET`, then pass one of:
  - `Authorization: Bearer <secret>`
  - `x-sync-secret: <secret>`
  - `x-internal-token: <secret>`
  - query string `?token=<secret>`
- `GET /api/hub-telemetry/sync` is disabled by default; set `HUB_TELEMETRY_ALLOW_STATUS_GET=true` to enable it.

Example dry run (hubs only):

```bash
curl -X POST http://localhost:3000/api/hub-telemetry/sync \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true,"dryRunStage":"hubs"}'
```

Example write run:

```bash
curl -X POST http://localhost:3000/api/hub-telemetry/sync \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false}'
```

## Next steps

* Replace the CSV ingest with Jira webhooks (issue created / updated events).
* Persist conversations and scores in a database for historical reporting.
* Extend the LLM prompt for richer coaching feedback and escalation triggers.
* Package the Flask app as a Jira Forge or Connect extension.
