import type { NextApiRequest, NextApiResponse } from "next";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentRole, ProjectConfigType } from "@/types";
import { DEFAULT_PROJECT_CONFIG } from "@/lib/defaultProjectConfig";
import { DEFAULT_CONTACT_TAXONOMY, DEFAULT_CONTACT_TAXONOMY_ENTRIES } from "@/lib/defaultContactTaxonomy";

const CONFIG_TYPES: ProjectConfigType[] = [
  "system_prompt",
  "internal_users",
  "customer_score",
  "agent_score",
  "conversation_rating",
  "task_sequence",
  "additional_instructions",
  "contact_taxonomy",
  "prompt_header",
  "prompt_json_schema"
];

type ProjectConfigRow = {
  id?: string;
  type: ProjectConfigType;
  payload: unknown;
  version: number;
  checksum?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
  is_active?: boolean | null;
};

type InternalUserEntry = { user_id: string; display_name: string; port_role: AgentRole };

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validatePayload(type: ProjectConfigType, payload: unknown): boolean {
  if (type === "internal_users") {
    if (typeof payload !== "object" || payload === null) {
      return false;
    }
    const users = (payload as Record<string, unknown>).users;
    if (!Array.isArray(users)) {
      return false;
    }
    return users.every((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }
      const userId = String((entry as Record<string, unknown>).user_id ?? "").trim();
      const role = String((entry as Record<string, unknown>).port_role ?? "").trim().toUpperCase();
      return Boolean(userId) && ["TIER1", "TIER2", "NON_AGENT", "AGENT", ""].includes(role);
    });
  }
  if (type === "contact_taxonomy") {
    if (typeof payload !== "object" || payload === null) return false;
    const reasons = (payload as Record<string, unknown>).reasons;
    const labels = (payload as Record<string, unknown>).labels;
    if (Array.isArray(reasons)) {
      return reasons.every((reason) => {
        if (typeof reason !== "object" || reason === null) return false;
        const topic = String((reason as Record<string, unknown>).topic ?? "").trim();
        return topic.length > 0;
      });
    }
    return Array.isArray(labels) && labels.every((label) => typeof label === "string" && label.trim().length > 0);
  }
  return isNonEmptyString(payload);
}

async function loadLegacyRoles(): Promise<InternalUserEntry[]> {
  const filePath = path.join(process.cwd(), "data", "port_roles.csv");
  try {
    const contents = await fs.readFile(filePath, "utf-8");
    const [, ...lines] = contents.split("\n");
    const entries: InternalUserEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const [user_id, display_name, port_role] = line.split(",");
      if (!user_id) continue;
      const role = (port_role || "").trim().toUpperCase();
      entries.push({
        user_id: user_id.trim(),
        display_name: (display_name || "").trim(),
        port_role: (role === "TIER1" || role === "TIER2") ? (role as AgentRole) : "NON_AGENT"
      });
    }
    return entries;
  } catch {
    return [];
  }
}

async function getExistingRow(
  client: SupabaseClient,
  configType: ProjectConfigType
): Promise<ProjectConfigRow | null> {
  const { data } = await client
    .from("project_config")
    .select("id,type,version,checksum,updated_at,updated_by,payload,is_active")
    .eq("type", configType)
    .limit(1)
    .maybeSingle();
  if (!data) {
    return null;
  }
  const row: ProjectConfigRow = {
    id: (data as any).id,
    type: ((data as any).type || configType) as ProjectConfigType,
    payload: (data as any).payload,
    version: (data as any).version ?? 1,
    checksum: (data as any).checksum ?? null,
    updated_at: (data as any).updated_at ?? null,
    updated_by: (data as any).updated_by ?? null,
    is_active: (data as any).is_active ?? null
  };
  return row;
}

async function insertHistory(client: SupabaseClient, existing: ProjectConfigRow, updatedBy: string, configType: ProjectConfigType) {
  if (!existing?.id) return;
  const historyRow = {
    project_config_id: existing.id,
    type: existing.type || configType,
    payload: existing.payload,
    version: existing.version,
    checksum: existing.checksum,
    updated_by: existing.updated_by || updatedBy
  };
  const { error } = await client.from("project_config_history").insert(historyRow);
  if (error) {
    throw new Error(error.message || "Failed to write project_config_history");
  }
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const client = getSupabaseClient();
  const requested = req.query.type || req.query.types;
  const filterTypes = Array.isArray(requested)
    ? requested.flatMap((value) => value.split(","))
    : (requested ? requested.split(",") : CONFIG_TYPES);
  const types = filterTypes
    .map((value) => value.trim())
    .filter((value): value is ProjectConfigType => CONFIG_TYPES.includes(value as ProjectConfigType));

  if (!types.length) {
    res.status(400).json({ error: "No valid config types requested." });
    return;
  }

  if (!client) {
    const fallbackEntries = await buildFallbackEntries(types);
    res.status(200).json({ entries: fallbackEntries });
    return;
  }

  const { data, error } = await client
    .from("project_config")
    .select("id,type,payload,version,checksum,updated_at,updated_by,is_active")
    .in("type", types)
    .eq("is_active", true);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  const entries = data ?? [];
  const missing = types.filter((type) => !entries.some((entry) => entry.type === type));
  if (missing.length) {
    const fallback = await buildFallbackEntries(missing);
    entries.push(...fallback);
  }
  res.status(200).json({ entries });
}

async function handlePut(req: NextApiRequest, res: NextApiResponse) {
  const client = getSupabaseClient();
  if (!client) {
    res.status(500).json({ error: "Supabase credentials missing." });
    return;
  }
  const payload = req.body ?? {};
  const configType = String(payload.type ?? "").trim() as ProjectConfigType;
  const content = payload.payload;
  const updatedBy = String(payload.updated_by ?? payload.updatedBy ?? "").trim() || "ui";

  if (!CONFIG_TYPES.includes(configType)) {
    res.status(400).json({ error: "Invalid or missing config type." });
    return;
  }
  if (!validatePayload(configType, content)) {
    res.status(400).json({ error: "Payload failed validation for this config type." });
    return;
  }

  const existing = await getExistingRow(client, configType);
  const version = existing ? (existing.version ?? 1) + 1 : 1;
  const checksum = typeof content === "string" ? hashPayload(content) : hashPayload(JSON.stringify(content));

  const row: ProjectConfigRow = {
    id: existing?.id,
    type: configType,
    payload: content,
    version,
    checksum,
    is_active: true,
    updated_by: updatedBy
  };

  if (existing?.id) {
    // snapshot previous version
    await insertHistory(client, existing, updatedBy, configType);
    const now = new Date().toISOString();
    const { error } = await client.from("project_config").update({ ...row, updated_at: now }).eq("id", existing.id);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    row.updated_at = now;
  } else {
    const { error } = await client.from("project_config").insert(row);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    row.updated_at = new Date().toISOString();
  }

  res.status(200).json({ entry: row });
}

function hashPayload(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

async function buildFallbackEntries(types: ProjectConfigType[]) {
  const entries: any[] = [];
  for (const type of types) {
    if (type === "internal_users") {
      const users = await loadLegacyRoles();
      entries.push({
        type,
        payload: { users },
        version: 1,
        checksum: null,
        updated_at: null,
        updated_by: "fallback",
        is_active: true
      });
      continue;
    }
    entries.push({
      type,
      payload:
        type === "contact_taxonomy"
          ? { reasons: DEFAULT_CONTACT_TAXONOMY_ENTRIES, labels: DEFAULT_CONTACT_TAXONOMY }
          : DEFAULT_PROJECT_CONFIG[type as keyof typeof DEFAULT_PROJECT_CONFIG] ?? "",
      version: 1,
      checksum: hashPayload(
        String(
          type === "contact_taxonomy"
            ? JSON.stringify({ reasons: DEFAULT_CONTACT_TAXONOMY_ENTRIES, labels: DEFAULT_CONTACT_TAXONOMY })
            : DEFAULT_PROJECT_CONFIG[type as keyof typeof DEFAULT_PROJECT_CONFIG] ?? ""
        )
      ),
      updated_at: null,
      updated_by: "fallback",
      is_active: true
    });
  }
  return entries;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    await handleGet(req, res);
    return;
  }
  if (req.method === "PUT") {
    await handlePut(req, res);
    return;
  }
  res.setHeader("Allow", "GET, PUT");
  res.status(405).json({ error: "Method not allowed" });
}
