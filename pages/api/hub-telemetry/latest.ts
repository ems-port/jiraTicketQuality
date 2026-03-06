import type { NextApiRequest, NextApiResponse } from "next";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VIEW_NAME = "hub_telemetry_latest";

type HubTelemetryLatestRow = {
  hub_name: string | null;
  pass_sold_count: number | null;
  subscriptions_sold_count: number | null;
};

let cachedClient: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (cachedClient) {
    return cachedClient;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  cachedClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, detectSessionInUrl: false }
  });
  return cachedClient;
}

function toNumber(value: number | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return value;
}

function isMissingRelationError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const client = getClient();
  if (!client) {
    res.status(200).json({
      rows: [],
      warning: "Missing Supabase credentials; telemetry normalization unavailable."
    });
    return;
  }

  try {
    const { data, error } = await client
      .from(VIEW_NAME)
      .select("hub_name,pass_sold_count,subscriptions_sold_count")
      .order("hub_name", { ascending: true });

    if (error) {
      throw error;
    }

    const rows = ((data ?? []) as HubTelemetryLatestRow[])
      .map((row) => {
        const hubName = row.hub_name?.trim() ?? "";
        if (!hubName) {
          return null;
        }
        const passSoldCount = toNumber(row.pass_sold_count);
        const subscriptionsSoldCount = toNumber(row.subscriptions_sold_count);
        return {
          hubName,
          passSoldCount,
          subscriptionsSoldCount,
          totalSales: passSoldCount + subscriptionsSoldCount
        };
      })
      .filter((row): row is { hubName: string; passSoldCount: number; subscriptionsSoldCount: number; totalSales: number } =>
        Boolean(row)
      );

    res.status(200).json({ rows });
  } catch (error) {
    if (isMissingRelationError(error)) {
      res.status(200).json({
        rows: [],
        warning: "hub_telemetry_latest not found. Apply supabase/hub_telemetry_history.sql."
      });
      return;
    }
    res.status(500).json({ error: (error as Error).message ?? "Unable to load hub telemetry latest." });
  }
}
