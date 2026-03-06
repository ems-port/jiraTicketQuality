import type { NextApiRequest, NextApiResponse } from "next";

import { runHubTelemetrySync, type HubTelemetryDryRunStage } from "@/lib/hubTelemetrySync";

const DEFAULT_ASSET_TYPE = process.env.THINGSBOARD_ASSET_TYPE || "Hub";
const DEFAULT_ASSET_LABEL = process.env.THINGSBOARD_ASSET_LABEL || "production";
const DEFAULT_TABLE = process.env.SUPABASE_HUB_TELEMETRY_TABLE || "hub_telemetry_history";
const DEFAULT_PAGE_SIZE = Math.max(1, Number.parseInt(process.env.THINGSBOARD_PAGE_SIZE || "100", 10) || 100);
const SYNC_SECRET = process.env.HUB_TELEMETRY_SYNC_SECRET;
const ALLOW_STATUS_GET = process.env.HUB_TELEMETRY_ALLOW_STATUS_GET === "true";
const MIN_INTERVAL_SECONDS = Math.max(
  0,
  Number.parseInt(process.env.HUB_TELEMETRY_MIN_INTERVAL_SECONDS || "60", 10) || 60
);
const MAX_PAGE_SIZE = Math.max(
  1,
  Number.parseInt(process.env.HUB_TELEMETRY_MAX_PAGE_SIZE || "250", 10) || 250
);

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const THINGSBOARD_URL = process.env.THINGSBOARD_URL;
const THINGSBOARD_USERNAME = process.env.THINGSBOARD_USERNAME;
const THINGSBOARD_PASSWORD = process.env.THINGSBOARD_PASSWORD;
let syncInProgress = false;
let lastInvocationAtMs = 0;

type SyncApiSuccess = {
  ok: true;
  result: Awaited<ReturnType<typeof runHubTelemetrySync>>;
};

type SyncApiError = {
  ok: false;
  error: string;
};

type SyncApiResponse = SyncApiSuccess | SyncApiError;

type SyncRequestBody = {
  dryRun?: boolean;
  dryRunStage?: HubTelemetryDryRunStage;
  assetType?: string;
  assetLabel?: string;
  apiTextSearch?: string;
  pageSize?: number;
  table?: string;
};

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "n"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function parseRequestBody(req: NextApiRequest): SyncRequestBody {
  if (!req.body) {
    return {};
  }
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body) as SyncRequestBody;
    } catch {
      return {};
    }
  }
  if (typeof req.body === "object") {
    return req.body as SyncRequestBody;
  }
  return {};
}

function parseDryRunStage(value: unknown): HubTelemetryDryRunStage {
  if (value === "hubs" || value === "telemetry") {
    return value;
  }
  return "telemetry";
}

function isAuthorized(req: NextApiRequest): boolean {
  if (!SYNC_SECRET) {
    return false;
  }
  const authHeader = normalizeHeader(req.headers.authorization);
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : authHeader?.trim();
  const headerSecret = normalizeHeader(req.headers["x-sync-secret"]);
  const internalSecret = normalizeHeader(req.headers["x-internal-token"]);
  const querySecret = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
  return [bearer, headerSecret, internalSecret, querySecret].some((candidate) => candidate === SYNC_SECRET);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<SyncApiResponse | Record<string, unknown>>) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  if (!SYNC_SECRET) {
    res.status(500).json({
      ok: false,
      error: "Missing HUB_TELEMETRY_SYNC_SECRET. Refusing to expose sync endpoint without auth."
    });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  if (req.method === "GET") {
    if (!ALLOW_STATUS_GET) {
      res.status(405).json({ ok: false, error: "GET status endpoint disabled." });
      return;
    }
    res.status(200).json({
      ok: true,
      endpoint: "hub telemetry sync",
      method: "POST",
      defaults: {
        assetType: DEFAULT_ASSET_TYPE,
        assetLabel: DEFAULT_ASSET_LABEL,
        pageSize: DEFAULT_PAGE_SIZE,
        table: DEFAULT_TABLE
      },
      safeguards: {
        minIntervalSeconds: MIN_INTERVAL_SECONDS,
        maxPageSize: MAX_PAGE_SIZE,
        syncInProgress
      }
    });
    return;
  }

  if (syncInProgress) {
    res.status(409).json({ ok: false, error: "Sync already in progress. Try again after it completes." });
    return;
  }

  const nowMs = Date.now();
  const elapsedSeconds = (nowMs - lastInvocationAtMs) / 1000;
  if (MIN_INTERVAL_SECONDS > 0 && lastInvocationAtMs > 0 && elapsedSeconds < MIN_INTERVAL_SECONDS) {
    const retryAfterSeconds = Math.ceil(MIN_INTERVAL_SECONDS - elapsedSeconds);
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      ok: false,
      error: `Rate limited. Try again in ${retryAfterSeconds} seconds.`
    });
    return;
  }

  if (!THINGSBOARD_URL || !THINGSBOARD_USERNAME || !THINGSBOARD_PASSWORD) {
    res.status(500).json({ ok: false, error: "Missing ThingsBoard credentials in environment." });
    return;
  }

  const body = parseRequestBody(req);
  const dryRun = toBoolean(body.dryRun, false);
  const dryRunStage = parseDryRunStage(body.dryRunStage);
  const assetType = (body.assetType || DEFAULT_ASSET_TYPE).trim();
  const assetLabel = (body.assetLabel ?? DEFAULT_ASSET_LABEL).trim();
  const apiTextSearchRaw = body.apiTextSearch;
  const apiTextSearch = typeof apiTextSearchRaw === "string" ? apiTextSearchRaw.trim() : undefined;
  const table = (body.table || DEFAULT_TABLE).trim();
  const requestedPageSize =
    typeof body.pageSize === "number" && Number.isFinite(body.pageSize) ? Math.floor(body.pageSize) : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPageSize));

  if (!dryRun && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
    res.status(500).json({ ok: false, error: "Missing Supabase credentials in environment." });
    return;
  }

  syncInProgress = true;
  lastInvocationAtMs = nowMs;
  try {
    const result = await runHubTelemetrySync({
      thingsboardUrl: THINGSBOARD_URL,
      thingsboardUsername: THINGSBOARD_USERNAME,
      thingsboardPassword: THINGSBOARD_PASSWORD,
      supabaseUrl: SUPABASE_URL || undefined,
      supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY || undefined,
      table,
      assetType,
      assetLabel,
      apiTextSearch: apiTextSearch || assetLabel || undefined,
      pageSize,
      dryRun,
      dryRunStage
    });
    res.status(200).json({ ok: true, result });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ ok: false, error: details });
  } finally {
    syncInProgress = false;
  }
}
