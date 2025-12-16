import type { NextApiRequest, NextApiResponse } from "next";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ProjectConfigEntry } from "@/types";

const ROLE_FILENAME = "port_roles.csv";
const CONFIG_TYPE = "internal_users";

type RoleEntry = {
  user_id: string;
  display_name: string;
  port_role: string;
};

function escapeCsv(value: string): string {
  const needsQuotes = /[",\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

function toCsv(entries: RoleEntry[]): string {
  const header = "user_id,display_name,port_role";
  const lines = entries.map(
    (entry) =>
      `${escapeCsv(entry.user_id)},${escapeCsv(entry.display_name)},${escapeCsv(entry.port_role)}`
  );
  return [header, ...lines].join("\n");
}

function getSupabaseClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return null;
  }
  return createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

async function fetchConfig(client: SupabaseClient): Promise<ProjectConfigEntry | null> {
  const { data, error } = await client
    .from("project_config")
    .select("id,type,payload,version,checksum,updated_at,updated_by,is_active")
    .eq("type", CONFIG_TYPE)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("Failed to load project_config (internal_users)", error);
    return null;
  }
  return data as ProjectConfigEntry | null;
}

async function upsertConfig(
  client: SupabaseClient,
  entries: RoleEntry[],
  existing: ProjectConfigEntry | null
): Promise<void> {
  const payload = { users: entries };
  const checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const version = (existing?.version ?? 0) + 1;
  const row: Partial<ProjectConfigEntry> & { type: string; payload: unknown; version: number; checksum: string } = {
    id: existing?.id as string | undefined,
    type: CONFIG_TYPE,
    payload,
    version,
    checksum,
    updated_by: "roles_api",
    is_active: true
  };
  const { error } = await client.from("project_config").upsert(row, { onConflict: "type" });
  if (error) {
    throw new Error(error.message);
  }
}

function normaliseEntries(rawEntries: unknown): RoleEntry[] {
  const payload = rawEntries ?? [];
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .map((raw) => {
      const userId = (raw?.user_id ?? raw?.userId ?? raw?.id ?? "").toString().trim();
      if (!userId) {
        return null;
      }
      const displayName = (raw?.display_name ?? raw?.displayName ?? raw?.name ?? "").toString().trim();
      const roleValue = (raw?.port_role ?? raw?.portRole ?? raw?.role ?? "NON_AGENT")
        .toString()
        .trim()
        .toUpperCase();
      const normalisedRole = roleValue === "TIER1" || roleValue === "TIER2" ? roleValue : "NON_AGENT";
      return {
        user_id: userId,
        display_name: displayName,
        port_role: normalisedRole
      };
    })
    .filter((entry): entry is RoleEntry => Boolean(entry));
}

async function readLegacyCsv(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const filePath = path.join(process.cwd(), "data", ROLE_FILENAME);
  const client = getSupabaseClient();

  if (req.method === "PUT") {
    try {
      const entries = normaliseEntries(req.body?.entries ?? req.body);
      if (!entries.length) {
        res.status(400).json({ error: "No valid agent entries provided." });
        return;
      }
      if (client) {
        const existing = await fetchConfig(client);
        await upsertConfig(client, entries, existing);
      }
      await fs.writeFile(filePath, toCsv(entries), "utf-8");
      res.status(200).json({ success: true, count: entries.length });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message ?? "Unable to save roles." });
    }
    return;
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, PUT");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (client) {
    const config = await fetchConfig(client);
    if (config?.payload && typeof config.payload === "object" && config.payload !== null) {
      const users = (config.payload as { users?: RoleEntry[] }).users ?? [];
      const csv = toCsv(users);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.status(200).send(csv);
      return;
    }
  }

  const legacy = await readLegacyCsv(filePath);
  if (legacy !== null) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.status(200).send(legacy);
    return;
  }

  res.status(500).json({ error: "Unable to load roles." });
}
