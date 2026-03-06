import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

const TELEMETRY_KEYS = ["pass_sold_count", "subscriptions_sold_count"] as const;
type TelemetryKey = (typeof TELEMETRY_KEYS)[number];

export type HubTelemetryDryRunStage = "hubs" | "telemetry";

export type HubAssetSummary = {
  hubId: string;
  hubName: string;
  hubType: string | null;
  hubLabel: string | null;
};

export type HubTelemetryHistoryRow = {
  ingest_run_id: string;
  snapshot_at: string;
  source: string;
  hub_id: string;
  hub_name: string;
  hub_type: string | null;
  hub_label: string | null;
  pass_sold_count: number | null;
  subscriptions_sold_count: number | null;
  pass_sold_ts_ms: number | null;
  subscriptions_sold_ts_ms: number | null;
  latest_ts_ms: number | null;
  pass_sold_at: string | null;
  subscriptions_sold_at: string | null;
  latest_at: string | null;
};

export type HubTelemetrySyncOptions = {
  thingsboardUrl: string;
  thingsboardUsername: string;
  thingsboardPassword: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  table: string;
  assetType: string;
  assetLabel?: string;
  apiTextSearch?: string;
  pageSize: number;
  dryRun: boolean;
  dryRunStage: HubTelemetryDryRunStage;
  source?: string;
};

export type HubTelemetrySyncResult = {
  ingestRunId: string;
  snapshotAt: string;
  table: string;
  fetchedAssetsCount: number;
  filteredAssetsCount: number;
  insertedRows: number;
  dryRun: boolean;
  dryRunStage: HubTelemetryDryRunStage;
  hubs?: HubAssetSummary[];
  sampleRows?: HubTelemetryHistoryRow[];
};

type ThingsBoardAsset = {
  id?: { id?: string };
  name?: string;
  type?: string | null;
  label?: string | null;
};

type ThingsBoardAssetsPage = {
  data?: ThingsBoardAsset[];
  totalPages?: number;
};

type ThingsBoardTelemetryPoint = {
  ts?: number;
  value?: unknown;
};

type ThingsBoardTelemetryPayload = Partial<Record<TelemetryKey, ThingsBoardTelemetryPoint[]>>;

function parseNumeric(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function tsMsToIso(tsMs: number | null): string | null {
  if (tsMs === null) {
    return null;
  }
  return new Date(tsMs).toISOString();
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

async function thingsBoardLogin(baseUrl: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`ThingsBoard login failed (${response.status}): ${details}`);
  }
  const payload = (await response.json()) as { token?: string };
  if (!payload.token) {
    throw new Error("ThingsBoard login response missing token.");
  }
  return payload.token;
}

async function fetchAssetsPage(
  baseUrl: string,
  token: string,
  page: number,
  pageSize: number,
  assetType?: string,
  textSearch?: string
): Promise<ThingsBoardAssetsPage> {
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    page: String(page),
    sortProperty: "name",
    sortOrder: "ASC"
  });
  if (assetType) {
    params.set("type", assetType);
  }
  if (textSearch) {
    params.set("textSearch", textSearch);
  }
  const response = await fetch(`${baseUrl}/api/tenant/assets?${params.toString()}`, {
    headers: {
      accept: "application/json",
      "X-Authorization": `Bearer ${token}`
    }
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Failed to fetch assets page ${page} (${response.status}): ${details}`);
  }
  return (await response.json()) as ThingsBoardAssetsPage;
}

async function fetchAllAssets(
  baseUrl: string,
  token: string,
  pageSize: number,
  assetType?: string,
  textSearch?: string
): Promise<ThingsBoardAsset[]> {
  const out: ThingsBoardAsset[] = [];
  let page = 0;
  while (true) {
    const payload = await fetchAssetsPage(baseUrl, token, page, pageSize, assetType, textSearch);
    const pageAssets = Array.isArray(payload.data) ? payload.data : [];
    out.push(...pageAssets);

    const totalPages = typeof payload.totalPages === "number" ? payload.totalPages : null;
    if (totalPages !== null) {
      if (page + 1 >= totalPages) {
        break;
      }
      page += 1;
      continue;
    }
    if (pageAssets.length < pageSize) {
      break;
    }
    page += 1;
  }
  return out;
}

function filterAssetsByLabel(assets: ThingsBoardAsset[], label?: string): ThingsBoardAsset[] {
  if (!label) {
    return assets;
  }
  const target = label.trim().toLowerCase();
  return assets.filter((asset) => String(asset.label || "").trim().toLowerCase() === target);
}

function mapAssetSummary(asset: ThingsBoardAsset): HubAssetSummary | null {
  const hubId = asset.id?.id;
  const hubName = asset.name;
  if (!hubId || !hubName) {
    return null;
  }
  return {
    hubId,
    hubName,
    hubType: asset.type || null,
    hubLabel: asset.label || null
  };
}

async function fetchLatestTelemetry(
  baseUrl: string,
  token: string,
  hubId: string
): Promise<Record<TelemetryKey, { value: number | null; tsMs: number | null }>> {
  const params = new URLSearchParams({ keys: TELEMETRY_KEYS.join(",") });
  const response = await fetch(
    `${baseUrl}/api/plugins/telemetry/ASSET/${encodeURIComponent(hubId)}/values/timeseries?${params.toString()}`,
    {
      headers: {
        accept: "application/json",
        "X-Authorization": `Bearer ${token}`
      }
    }
  );
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Failed to fetch telemetry for hub ${hubId} (${response.status}): ${details}`);
  }
  const payload = (await response.json()) as ThingsBoardTelemetryPayload;

  const out = {} as Record<TelemetryKey, { value: number | null; tsMs: number | null }>;
  for (const key of TELEMETRY_KEYS) {
    const entries = payload[key] ?? [];
    let best: ThingsBoardTelemetryPoint | null = null;
    for (const point of entries) {
      const pointTs = typeof point.ts === "number" ? point.ts : Number.NEGATIVE_INFINITY;
      const bestTs = best && typeof best.ts === "number" ? best.ts : Number.NEGATIVE_INFINITY;
      if (!best || pointTs > bestTs) {
        best = point;
      }
    }
    const tsMs = best && typeof best.ts === "number" ? best.ts : null;
    out[key] = { value: parseNumeric(best?.value), tsMs };
  }
  return out;
}

async function buildRows(
  baseUrl: string,
  token: string,
  assets: ThingsBoardAsset[],
  ingestRunId: string,
  snapshotAt: string,
  source: string
): Promise<HubTelemetryHistoryRow[]> {
  const rows: HubTelemetryHistoryRow[] = [];
  for (const asset of assets) {
    const summary = mapAssetSummary(asset);
    if (!summary) {
      continue;
    }
    const telemetry = await fetchLatestTelemetry(baseUrl, token, summary.hubId);
    const pass = telemetry.pass_sold_count;
    const subscriptions = telemetry.subscriptions_sold_count;
    const latestTsMs =
      pass.tsMs === null
        ? subscriptions.tsMs
        : subscriptions.tsMs === null
          ? pass.tsMs
          : Math.max(pass.tsMs, subscriptions.tsMs);

    rows.push({
      ingest_run_id: ingestRunId,
      snapshot_at: snapshotAt,
      source,
      hub_id: summary.hubId,
      hub_name: summary.hubName,
      hub_type: summary.hubType,
      hub_label: summary.hubLabel,
      pass_sold_count: pass.value,
      subscriptions_sold_count: subscriptions.value,
      pass_sold_ts_ms: pass.tsMs,
      subscriptions_sold_ts_ms: subscriptions.tsMs,
      latest_ts_ms: latestTsMs,
      pass_sold_at: tsMsToIso(pass.tsMs),
      subscriptions_sold_at: tsMsToIso(subscriptions.tsMs),
      latest_at: tsMsToIso(latestTsMs)
    });
  }
  return rows;
}

async function insertRows(
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
  table: string,
  rows: HubTelemetryHistoryRow[],
  chunkSize = 500
): Promise<void> {
  if (!rows.length) {
    return;
  }
  const client = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, detectSessionInUrl: false }
  });
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const { error } = await client.from(table).insert(chunk);
    if (error) {
      throw new Error(`Supabase insert failed at offset ${offset}: ${error.message}`);
    }
  }
}

export async function runHubTelemetrySync(options: HubTelemetrySyncOptions): Promise<HubTelemetrySyncResult> {
  const baseUrl = normalizeBaseUrl(options.thingsboardUrl);
  const pageSize = Math.max(1, options.pageSize || 100);
  const ingestRunId = randomUUID();
  const snapshotAt = new Date().toISOString();
  const source = options.source || "thingsboard";

  const token = await thingsBoardLogin(baseUrl, options.thingsboardUsername, options.thingsboardPassword);
  const fetchedAssets = await fetchAllAssets(
    baseUrl,
    token,
    pageSize,
    options.assetType,
    options.apiTextSearch || options.assetLabel
  );
  const filteredAssets = filterAssetsByLabel(fetchedAssets, options.assetLabel);
  const hubSummaries = filteredAssets.map(mapAssetSummary).filter((item): item is HubAssetSummary => item !== null);

  if (options.dryRun && options.dryRunStage === "hubs") {
    return {
      ingestRunId,
      snapshotAt,
      table: options.table,
      fetchedAssetsCount: fetchedAssets.length,
      filteredAssetsCount: filteredAssets.length,
      insertedRows: 0,
      dryRun: true,
      dryRunStage: "hubs",
      hubs: hubSummaries
    };
  }

  const rows = await buildRows(baseUrl, token, filteredAssets, ingestRunId, snapshotAt, source);

  if (options.dryRun) {
    return {
      ingestRunId,
      snapshotAt,
      table: options.table,
      fetchedAssetsCount: fetchedAssets.length,
      filteredAssetsCount: filteredAssets.length,
      insertedRows: 0,
      dryRun: true,
      dryRunStage: options.dryRunStage,
      sampleRows: rows.slice(0, 50),
      hubs: hubSummaries
    };
  }

  if (!options.supabaseUrl || !options.supabaseServiceRoleKey) {
    throw new Error("Supabase credentials missing for non-dry-run execution.");
  }

  await insertRows(options.supabaseUrl, options.supabaseServiceRoleKey, options.table, rows);
  return {
    ingestRunId,
    snapshotAt,
    table: options.table,
    fetchedAssetsCount: fetchedAssets.length,
    filteredAssetsCount: filteredAssets.length,
    insertedRows: rows.length,
    dryRun: false,
    dryRunStage: options.dryRunStage,
    sampleRows: rows.slice(0, 10),
    hubs: hubSummaries
  };
}
