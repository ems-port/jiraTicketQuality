import type { NextApiRequest, NextApiResponse } from "next";
import { spawn } from "node:child_process";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const INGEST_SCRIPT = "jiraPull/injestionJiraTickes.py";
const PROCESS_SCRIPT = "jiraPull/process_conversations.py";
const PREPARED_TABLE = process.env.SUPABASE_JIRA_PREPARED_TABLE || "jira_prepared_conversations";
const PROCESS_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.JIRA_PROCESS_CONCURRENCY || "12", 10) || 12
);

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REMOTE_PROCESS_MAX_BATCH = Math.max(1, Number(process.env.REMOTE_PROCESS_MAX_BATCH ?? 20));

export type RefreshJobStage = "idle" | "ingesting" | "processing" | "completed" | "error";

export type RefreshJobState = {
  running: boolean;
  stage: RefreshJobStage;
  startedAt: number | null;
  updatedAt: number | null;
  message?: string;
  fetchedTickets?: number;
  skippedTickets?: number;
  processedTickets?: number;
  totalToProcess?: number;
  etaSeconds?: number;
  lastCompletedAt?: number | null;
  error?: string;
  pendingConversations?: number | null;
};

const INITIAL_STATE: RefreshJobState = {
  running: false,
  stage: "idle",
  startedAt: null,
  updatedAt: null,
  lastCompletedAt: null,
  pendingConversations: null
};

export let jobState: RefreshJobState = { ...INITIAL_STATE };
let currentJob: Promise<void> | null = null;
let supabaseClient: SupabaseClient | null = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, detectSessionInUrl: false }
  });
}

function updateJobState(patch: Partial<RefreshJobState>) {
  jobState = {
    ...jobState,
    ...patch,
    updatedAt: Date.now()
  };
  console.info("[refresh] state update:", {
    stage: jobState.stage,
    message: jobState.message,
    fetched: jobState.fetchedTickets,
    processed: jobState.processedTickets,
    total: jobState.totalToProcess,
    running: jobState.running
  });
}

function parseLines(buffer: string, handler: (line: string) => void) {
  buffer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach(handler);
}

function runPythonScript(args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1"
      }
    });

    let stderrBuffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      parseLines(text, (line) => {
        console.log(`[${args[0]}] ${line}`);
        if (onLine) {
          onLine(line);
        }
      });
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer += text;
      parseLines(text, (line) => {
        console.error(`[${args[0]}][stderr] ${line}`);
        if (onLine) {
          onLine(line);
        }
      });
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderrBuffer || `Python script exited with code ${code}`));
      }
    });
  });
}

async function countPendingConversations(): Promise<number | null> {
  if (!supabaseClient) {
    return null;
  }
  try {
    const { count, error } = await supabaseClient
      .from(PREPARED_TABLE)
      .select("issue_key", { count: "exact", head: true })
      .eq("processed", false);
    if (error) {
      throw error;
    }
    return count ?? 0;
  } catch (error) {
    console.error("Failed to count pending conversations", error);
    return null;
  }
}

async function runIngestion(): Promise<{ fetched: number; skipped: number }> {
  let fetched = 0;
  let skipped = 0;
  await runPythonScript([INGEST_SCRIPT], (line) => {
    if (line.includes("Ingestion finished:")) {
      const match = line.match(/Ingestion finished:\s+(\d+)\s+prepared payloads,\s+(\d+)\s+skipped duplicates/i);
      if (match) {
        fetched = parseInt(match[1], 10);
        skipped = parseInt(match[2], 10);
        updateJobState({
          fetchedTickets: fetched,
          skippedTickets: skipped,
          message: `Fetched ${fetched} new tickets${skipped ? `, ${skipped} skipped` : ""}.`
        });
      }
    }
  });
  return { fetched, skipped };
}

async function runProcessor(totalHint: number | null, debugMode = false): Promise<number> {
  let processed = 0;
  let total = typeof totalHint === "number" && totalHint > 0 ? totalHint : null;
  const processingStartedAt = Date.now();
  const limit = Math.max(1, total ?? 50);
  const args = [PROCESS_SCRIPT, "--limit", String(limit), "--concurrency", String(PROCESS_CONCURRENCY)];
  if (debugMode) {
    args.push("--debug", "--debug-prompts", "both");
  }
  await runPythonScript(
    args,
    (line) => {
      const progressMatch = line.match(/Processing progress:\s*(\d+)\/(\d+)/i);
      if (progressMatch) {
        processed = parseInt(progressMatch[1], 10);
        total = parseInt(progressMatch[2], 10) || total;
      } else if (line.startsWith("Processing ")) {
        processed += 1;
      }

      if (progressMatch || line.startsWith("Processing ")) {
        const etaSeconds = total && processed > 0
          ? Math.max(0, Math.round(((Date.now() - processingStartedAt) / processed / 1000) * (total - processed)))
          : undefined;
        updateJobState({
          processedTickets: processed,
          totalToProcess: total ?? undefined,
          etaSeconds,
          message: total
            ? `Processing ${processed}/${total} conversations...`
            : `Processing ${processed} conversations...`
        });
        return;
      }

      if (line.includes("Stored ") && line.includes("processed conversations")) {
        const match = line.match(/Stored\s+(\d+)\s+processed conversations/i);
        if (match) {
          processed = parseInt(match[1], 10);
          updateJobState({
            processedTickets: processed,
            etaSeconds: undefined,
            message: `Stored ${processed} processed conversations.`
          });
        }
      } else if (line.includes("No new conversations to process")) {
        processed = 0;
        updateJobState({
          processedTickets: 0,
          etaSeconds: undefined,
          message: "No new conversations to process.",
          totalToProcess: 0
        });
      }
    }
  );
  return processed;
}

function isProductionHosted(): boolean {
  return process.env.VERCEL === "1";
}

type InvocationTarget = {
  urlBase: string;
  headers: Record<string, string>;
  mode: "internal" | "public" | "local";
};

function getInvocationTarget(): InvocationTarget {
  const internalUrl = process.env.INTERNAL_FUNCTIONS_URL?.replace(/\/$/, "");
  const bypassSecret = process.env.INTERNAL_FUNCTIONS_TOKEN || process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (internalUrl && bypassSecret) {
    return {
      urlBase: internalUrl,
      headers: {
        "x-vercel-protection-bypass": bypassSecret
      },
      mode: "internal"
    };
  }
  const fallbackHost = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `http://localhost:${process.env.PORT || 3000}`;
  const headers: Record<string, string> = {};
  if (process.env.REFRESH_CRON_SECRET) {
    headers.Authorization = `Bearer ${process.env.REFRESH_CRON_SECRET}`;
  }
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }
  return {
    urlBase: fallbackHost.replace(/\/$/, ""),
    headers,
    mode: process.env.VERCEL_URL ? "public" : "local"
  };
}

async function callPythonFunction(path: string, payload?: Record<string, unknown>) {
  const target = getInvocationTarget();
  const url = `${target.urlBase}${path}`;
  console.info("[refresh] calling", url, { mode: target.mode, hasPayload: Boolean(payload) });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...target.headers
      },
      body: payload ? JSON.stringify(payload) : undefined
    });
  } catch (error) {
    console.error(`[refresh] ${path} network error`, error);
    throw error;
  }

  const rawBody = await response.text();
  let data: Record<string, unknown> | null = null;
  if (rawBody) {
    try {
      data = JSON.parse(rawBody) as Record<string, unknown>;
    } catch (parseError) {
      console.error(`[refresh] ${path} failed to parse JSON`, rawBody);
      throw new Error(`Unable to parse ${path} response (status ${response.status}).`);
    }
  }

  if (!response.ok) {
    console.error(`[refresh] ${path} responded with ${response.status}`, data || rawBody);
    const errorMessage = typeof data?.error === "string" ? data.error : `Failed to call ${path} (status ${response.status})`;
    throw new Error(errorMessage);
  }

  console.info(`[refresh] ${path} success`, {
    status: response.status,
    hasStdout: Boolean((data as { stdout?: string })?.stdout),
    hasStderr: Boolean((data as { stderr?: string })?.stderr)
  });

  return data;
}

function parseIngestionSummary(stdout?: string | null) {
  if (!stdout) {
    return null;
  }
  const regex = /Ingestion finished:\s+(\d+)\s+prepared payloads,\s+(\d+)\s+skipped duplicates/i;
  const match = stdout.match(regex);
  if (!match) {
    return null;
  }
  return {
    fetched: parseInt(match[1], 10),
    skipped: parseInt(match[2], 10)
  };
}

function parseProcessingSummary(stdout?: string | null) {
  if (!stdout) {
    return null;
  }
  const match = stdout.match(/Stored\s+(\d+)\s+processed conversations/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

async function triggerRemoteIngest() {
  const result = (await callPythonFunction("/api/ingest")) as { stdout?: string | null } | null;
  const summary = parseIngestionSummary(result?.stdout ?? null);
  if (summary) {
    updateJobState({
      fetchedTickets: summary.fetched,
      skippedTickets: summary.skipped,
      message: `Fetched ${summary.fetched} new tickets${summary.skipped ? `, ${summary.skipped} skipped` : ""}.`
    });
    return summary;
  }
  updateJobState({
    fetchedTickets: undefined,
    skippedTickets: undefined,
    message: "Triggered remote ingestion (check logs for details)."
  });
  return { fetched: 0, skipped: 0 };
}

async function triggerRemoteProcess(limit: number) {
  const safeLimit = Math.max(1, Math.min(limit, REMOTE_PROCESS_MAX_BATCH));
  const result = (await callPythonFunction("/api/process", { limit: safeLimit })) as {
    stdout?: string | null;
    pending?: number | null;
  } | null;
  if (typeof result?.pending === "number") {
    updateJobState({ pendingConversations: result.pending });
  }
  const processed = parseProcessingSummary(result?.stdout ?? null);
  if (typeof processed === "number") {
    updateJobState({
      processedTickets: processed,
      message: `Remote processing stored ${processed} conversations (batch size ${safeLimit}).`
    });
    return processed;
  }
  updateJobState({
    processedTickets: undefined,
    message: `Triggered remote processing (batch size ${safeLimit}).`
  });
  return 0;
}

async function runRemoteProcessing(totalPending: number | null) {
  if (totalPending === null || totalPending <= 0) {
    return triggerRemoteProcess(REMOTE_PROCESS_MAX_BATCH);
  }
  let remaining = totalPending;
  let totalProcessed = 0;
  while (remaining > 0) {
    const batchSize = Math.min(remaining, REMOTE_PROCESS_MAX_BATCH);
    const processed = await triggerRemoteProcess(batchSize);
    totalProcessed += processed;
    remaining = Math.max(0, remaining - processed);
    updateJobState({
      processedTickets: totalProcessed,
      totalToProcess: remaining,
      pendingConversations: remaining,
      message: `Remote processing stored ${totalProcessed} conversations, ${remaining} remaining...`
    });
    if (processed < batchSize) {
      break;
    }
  }
  updateJobState({ pendingConversations: Math.max(0, remaining) });
  return totalProcessed;
}

async function executeJob() {
  const debugMode = typeof (global as any).__REFRESH_DEBUG_LLM === "boolean" ? (global as any).__REFRESH_DEBUG_LLM : false;
  try {
    updateJobState({
      running: true,
      stage: "ingesting",
      startedAt: Date.now(),
      message: "Fetching the latest Jira tickets...",
      fetchedTickets: undefined,
      skippedTickets: undefined,
      processedTickets: undefined,
      totalToProcess: undefined,
      etaSeconds: undefined,
      error: undefined,
      pendingConversations: undefined
    });

    const ingestResult = isProductionHosted() ? await triggerRemoteIngest() : await runIngestion();

    updateJobState({
      stage: "processing",
      message: "Processing conversations..."
    });

    const pending = await countPendingConversations();
    if (pending !== null) {
      updateJobState({
        totalToProcess: pending,
        pendingConversations: pending,
        message: pending > 0 ? `Processing ${pending} conversations...` : "Processing queue is empty."
      });
    }

    const processed = isProductionHosted()
      ? await runRemoteProcessing(pending)
      : await runProcessor(pending, debugMode);

    const remainingPending = await countPendingConversations();
    const hasRemaining = typeof remainingPending === "number" && remainingPending > 0;

    updateJobState({
      running: false,
      stage: "completed",
      processedTickets: processed,
      pendingConversations: remainingPending ?? undefined,
      message:
        hasRemaining
          ? `Processed ${processed} conversations · ${remainingPending} still queued. Press Fetch data again.`
          : ingestResult.fetched || processed
          ? `Fetched ${ingestResult.fetched} new tickets · Processed ${processed} conversations.`
          : "Refresh completed (no new data)",
      etaSeconds: undefined,
      lastCompletedAt: Date.now()
    });
  } catch (error) {
    console.error("Refresh job failed", error);
    updateJobState({
      running: false,
      stage: "error",
      error: (error as Error).message ?? "Refresh failed",
      message: "Refresh failed"
    });
  } finally {
    currentJob = null;
  }
}

export function startJob() {
  if (!currentJob) {
    currentJob = executeJob();
  }
  return currentJob;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    res.status(200).json(jobState);
    return;
  }

  if (req.method === "POST") {
    if (process.env.NEXT_PUBLIC_REFRESH_DISABLED === "1") {
      res.status(501).json({ error: "Refresh job disabled in this deployment." });
      return;
    }
    if (jobState.running) {
      res.status(409).json(jobState);
      return;
    }
    if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) {
      res.status(500).json({ error: "Supabase credentials missing" });
      return;
    }
    (global as any).__REFRESH_DEBUG_LLM = req.query.debug === "1" || req.body?.debug === true;
    startJob();
    res.status(202).json(jobState);
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed" });
}
