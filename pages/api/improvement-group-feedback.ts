import type { NextApiRequest, NextApiResponse } from "next";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type {
  ImprovementFeedbackVerdict,
  ImprovementGroupFeedbackEntry,
  ImprovementGroupFeedbackSummary
} from "@/types";

type FeedbackRow = {
  grouping_id: string;
  group_id: string;
  verdict: ImprovementFeedbackVerdict;
  notes: string | null;
  user_id: string;
  user_display: string | null;
  updated_at: string | null;
  created_at: string | null;
};

type FeedbackResponseBody = {
  summaries: Record<string, ImprovementGroupFeedbackSummary>;
  entries: Record<string, ImprovementGroupFeedbackEntry[]>;
  warning?: string;
};

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE_NAME = "improvement_tip_group_feedback";
const TABLE_WARNING =
  "Improvement feedback tables not found. Apply supabase/schema.sql to enable Metrics Validation (LLM feedback usefulness).";

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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const client = getClient();
  if (!client) {
    res
      .status(500)
      .json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables." });
    return;
  }

  if (req.method === "GET") {
    await handleGet(req, res, client);
    return;
  }
  if (req.method === "POST") {
    await handlePost(req, res, client);
    return;
  }
  res.setHeader("Allow", "GET,POST");
  res.status(405).json({ error: "Method not allowed" });
}

async function handleGet(req: NextApiRequest, res: NextApiResponse, client: SupabaseClient) {
  const groupingId = parseString(req.query.groupingId, 120);
  const groupIds = [
    ...parseGroupIds(req.query.groupId),
    ...parseGroupIds(req.query.groupIds)
  ];
  const userId = parseString(req.query.userId, 120);

  if (!groupingId) {
    res.status(400).json({ error: "Missing groupingId parameter." });
    return;
  }
  if (!groupIds.length) {
    res.status(400).json({ error: "Missing groupId/groupIds parameter." });
    return;
  }

  try {
    const summaries = await fetchSummaries(client, groupingId, groupIds, userId);
    const entries = await fetchEntries(client, groupingId, groupIds);
    res.status(200).json({ summaries, entries } satisfies FeedbackResponseBody);
  } catch (error) {
    if (isMissingTableError(error)) {
      res.status(200).json({ summaries: {}, entries: {}, warning: TABLE_WARNING } satisfies FeedbackResponseBody);
      return;
    }
    res.status(500).json({ error: (error as Error).message ?? "Unable to fetch improvement feedback." });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, client: SupabaseClient) {
  const groupingId = parseString(req.body?.groupingId, 120);
  const groupId = parseString(req.body?.groupId, 120);
  const verdict = normalizeVerdict(req.body?.verdict);
  const notes = parseNotes(req.body?.notes);
  const userId = parseString(req.body?.userId, 120);
  const userDisplay = parseString(req.body?.userDisplay, 120);
  const userFingerprint = parseString(req.body?.userFingerprint, 160);

  if (!groupingId) {
    res.status(400).json({ error: "groupingId is required." });
    return;
  }
  if (!groupId) {
    res.status(400).json({ error: "groupId is required." });
    return;
  }
  if (!verdict) {
    res.status(400).json({ error: "verdict must be either 'up' or 'down'." });
    return;
  }
  if (!userId) {
    res.status(400).json({ error: "userId is required." });
    return;
  }

  try {
    const payload = {
      grouping_id: groupingId,
      group_id: groupId,
      verdict,
      notes,
      user_id: userId,
      user_display: userDisplay,
      user_fingerprint: userFingerprint ?? userId,
      updated_at: new Date().toISOString()
    };
    const { error } = await client.from(TABLE_NAME).upsert(payload, {
      onConflict: "grouping_id,group_id,user_id"
    });
    if (error) {
      throw error;
    }
    const summaries = await fetchSummaries(client, groupingId, [groupId], userId);
    const entries = await fetchEntries(client, groupingId, [groupId]);
    res.status(200).json({ summaries, entries } satisfies FeedbackResponseBody);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "23503") {
      res.status(400).json({
        error:
          "Cannot save feedback for this group yet. Regenerate the latest improvement grouping so normalized group rows exist."
      });
      return;
    }
    if (isMissingTableError(error)) {
      res.status(500).json({ error: TABLE_WARNING });
      return;
    }
    res.status(500).json({ error: (error as Error).message ?? "Unable to save improvement feedback." });
  }
}

async function fetchEntries(
  client: SupabaseClient,
  groupingId: string,
  groupIds: string[]
): Promise<Record<string, ImprovementGroupFeedbackEntry[]>> {
  const deduped = Array.from(
    new Set(groupIds.map((value) => value.trim()).filter((value) => value.length > 0))
  );
  const out: Record<string, ImprovementGroupFeedbackEntry[]> = {};
  deduped.forEach((groupId) => {
    out[groupId] = [];
  });
  if (!deduped.length) {
    return out;
  }

  const { data, error } = await client
    .from(TABLE_NAME)
    .select("grouping_id, group_id, verdict, notes, user_id, user_display, updated_at, created_at")
    .eq("grouping_id", groupingId)
    .in("group_id", deduped)
    .order("updated_at", { ascending: false });
  if (error) {
    throw error;
  }

  for (const row of (data ?? []) as FeedbackRow[]) {
    const note = typeof row.notes === "string" ? row.notes.trim() : "";
    if (!note.length) {
      continue;
    }
    if (!out[row.group_id]) {
      out[row.group_id] = [];
    }
    out[row.group_id].push({
      groupId: row.group_id,
      verdict: row.verdict,
      notes: note,
      userId: row.user_id,
      userDisplayName: row.user_display ?? null,
      updatedAt: row.updated_at ?? null,
      createdAt: row.created_at ?? null
    });
  }
  return out;
}

async function fetchSummaries(
  client: SupabaseClient,
  groupingId: string,
  groupIds: string[],
  userId?: string | null
): Promise<Record<string, ImprovementGroupFeedbackSummary>> {
  const deduped = Array.from(
    new Set(groupIds.map((value) => value.trim()).filter((value) => value.length > 0))
  );
  if (!deduped.length) {
    return {};
  }

  const { data, error } = await client
    .from(TABLE_NAME)
    .select("grouping_id, group_id, verdict, notes, user_id, user_display, updated_at, created_at")
    .eq("grouping_id", groupingId)
    .in("group_id", deduped)
    .order("updated_at", { ascending: false });
  if (error) {
    throw error;
  }

  const rows = (data ?? []) as FeedbackRow[];
  const summary: Record<string, ImprovementGroupFeedbackSummary> = {};
  deduped.forEach((groupId) => {
    summary[groupId] = {
      groupId,
      upCount: 0,
      downCount: 0,
      entries: 0,
      userVerdict: null,
      userNotes: null,
      userDisplayName: null,
      lastUpdatedAt: null,
      lastUpdatedBy: null
    };
  });

  for (const row of rows) {
    const target = summary[row.group_id];
    if (!target) {
      continue;
    }
    target.entries += 1;
    if (row.verdict === "up") {
      target.upCount += 1;
    } else {
      target.downCount += 1;
    }

    const updatedAt = row.updated_at ?? row.created_at ?? null;
    if (!target.lastUpdatedAt || (updatedAt && updatedAt > target.lastUpdatedAt)) {
      target.lastUpdatedAt = updatedAt;
      target.lastUpdatedBy = row.user_display ?? row.user_id ?? null;
    }

    if (userId && row.user_id === userId) {
      target.userVerdict = row.verdict;
      target.userNotes = row.notes ?? null;
      target.userDisplayName = row.user_display ?? null;
    }
  }

  return summary;
}

function parseGroupIds(value: unknown): string[] {
  const entries: string[] = [];
  const add = (raw: unknown) => {
    if (typeof raw !== "string") {
      return;
    }
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .forEach((part) => entries.push(part.slice(0, 120)));
  };
  if (Array.isArray(value)) {
    value.forEach(add);
  } else {
    add(value);
  }
  return entries;
}

function parseString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.length) {
    return null;
  }
  return trimmed.slice(0, maxLength);
}

function normalizeVerdict(value: unknown): ImprovementFeedbackVerdict | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "up" || normalized === "down") {
    return normalized;
  }
  return null;
}

function parseNotes(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.length) {
    return null;
  }
  return trimmed.slice(0, 2000);
}

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === "42P01" || (error as Error).message?.includes(TABLE_NAME) || (error as Error).message?.includes("improvement_tip_group_items");
}
