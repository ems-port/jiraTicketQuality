import type { NextApiRequest, NextApiResponse } from "next";

import { runHubTelemetrySync } from "@/lib/hubTelemetrySync";

const DEFAULT_ASSET_TYPE = process.env.THINGSBOARD_ASSET_TYPE || "Hub";
const DEFAULT_ASSET_LABEL = process.env.THINGSBOARD_ASSET_LABEL || "production";
const DEFAULT_TABLE = process.env.SUPABASE_HUB_TELEMETRY_TABLE || "hub_telemetry_history";
const DEFAULT_PAGE_SIZE = Math.max(1, Number.parseInt(process.env.THINGSBOARD_PAGE_SIZE || "100", 10) || 100);
const MAX_PAGE_SIZE = Math.max(
  1,
  Number.parseInt(process.env.HUB_TELEMETRY_MAX_PAGE_SIZE || "250", 10) || 250
);
const REFRESH_MIN_INTERVAL_SECONDS = Math.max(
  0,
  Number.parseInt(process.env.HUB_TELEMETRY_DRILLDOWN_REFRESH_MIN_INTERVAL_SECONDS || "300", 10) || 300
);

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const THINGSBOARD_URL = process.env.THINGSBOARD_URL;
const THINGSBOARD_USERNAME = process.env.THINGSBOARD_USERNAME;
const THINGSBOARD_PASSWORD = process.env.THINGSBOARD_PASSWORD;

let refreshInProgress = false;
let lastRefreshAtMs = 0;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  if (refreshInProgress) {
    res.status(200).json({
      ok: true,
      status: "in_progress",
      message: "Sales refresh already running."
    });
    return;
  }

  const now = Date.now();
  const elapsedSeconds = (now - lastRefreshAtMs) / 1000;
  if (REFRESH_MIN_INTERVAL_SECONDS > 0 && lastRefreshAtMs > 0 && elapsedSeconds < REFRESH_MIN_INTERVAL_SECONDS) {
    const remainingSeconds = Math.ceil(REFRESH_MIN_INTERVAL_SECONDS - elapsedSeconds);
    res.status(200).json({
      ok: true,
      status: "skipped",
      message: `Cooldown active. Try again in ${remainingSeconds}s.`,
      cooldownSecondsRemaining: remainingSeconds,
      lastRefreshAt: new Date(lastRefreshAtMs).toISOString()
    });
    return;
  }

  if (!THINGSBOARD_URL || !THINGSBOARD_USERNAME || !THINGSBOARD_PASSWORD) {
    res.status(500).json({
      ok: false,
      error: "Missing ThingsBoard credentials in environment."
    });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({
      ok: false,
      error: "Missing Supabase credentials in environment."
    });
    return;
  }

  const pageSize = Math.min(MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  refreshInProgress = true;
  console.info("[hub-sales-refresh] Drilldown-triggered refresh started.");
  try {
    const result = await runHubTelemetrySync({
      thingsboardUrl: THINGSBOARD_URL,
      thingsboardUsername: THINGSBOARD_USERNAME,
      thingsboardPassword: THINGSBOARD_PASSWORD,
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
      table: DEFAULT_TABLE,
      assetType: DEFAULT_ASSET_TYPE,
      assetLabel: DEFAULT_ASSET_LABEL,
      apiTextSearch: DEFAULT_ASSET_LABEL || undefined,
      pageSize,
      dryRun: false,
      dryRunStage: "telemetry",
      source: "thingsboard-drilldown"
    });
    lastRefreshAtMs = Date.now();
    console.info(
      `[hub-sales-refresh] Completed. insertedRows=${result.insertedRows} filteredAssets=${result.filteredAssetsCount}`
    );
    res.status(200).json({
      ok: true,
      status: "refreshed",
      message: "Sales telemetry refreshed.",
      insertedRows: result.insertedRows,
      filteredAssetsCount: result.filteredAssetsCount,
      snapshotAt: result.snapshotAt,
      table: result.table
    });
  } catch (error) {
    const message = (error as Error).message ?? "Unknown refresh failure.";
    console.error("[hub-sales-refresh] Failed:", message);
    res.status(500).json({
      ok: false,
      error: message
    });
  } finally {
    refreshInProgress = false;
  }
}
