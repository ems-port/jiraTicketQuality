import type { NextApiRequest, NextApiResponse } from "next";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { FeedbackVerdict, MisclassifiedFeedbackSummary } from "@/types";

type FeedbackRow = {
  issue_key: string;
  verdict: FeedbackVerdict;
  notes: string | null;
  user_id: string;
  user_display: string | null;
  updated_at: string | null;
  created_at: string | null;
};

type FeedbackResponseBody = {
  summaries: Record<string, MisclassifiedFeedbackSummary>;
};

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  const issueKeys = [
    ...parseIssueKeys(req.query.issueKey),
    ...parseIssueKeys(req.query.issueKeys)
  ];
  if (!issueKeys.length) {
    res.status(400).json({ error: "Missing issueKey parameter." });
    return;
  }
  const userId = parseString(req.query.userId, 120);
  try {
    const summaries = await fetchSummaries(client, issueKeys, userId);
    res.status(200).json({ summaries } satisfies FeedbackResponseBody);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message ?? "Unable to fetch feedback." });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, client: SupabaseClient) {
  const issueKey = parseString(req.body?.issueKey, 80);
  const verdict = normalizeVerdict(req.body?.verdict);
  const userId = parseString(req.body?.userId, 120);
  const userDisplay = parseString(req.body?.userDisplay, 120);
  const userFingerprint = parseString(req.body?.userFingerprint, 160);
  const notes = parseNotes(req.body?.notes);

  if (!issueKey) {
    res.status(400).json({ error: "issueKey is required." });
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
      issue_key: issueKey,
      verdict,
      notes,
      user_id: userId,
      user_display: userDisplay,
      user_fingerprint: userFingerprint ?? userId,
      updated_at: new Date().toISOString()
    };

    const { error } = await client
      .from("misclassified_feedback")
      .upsert(payload, { onConflict: "issue_key,user_id" });

    if (error) {
      throw error;
    }

    const summaries = await fetchSummaries(client, [issueKey], userId);
    res.status(200).json({ summaries } satisfies FeedbackResponseBody);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message ?? "Unable to save feedback." });
  }
}

async function fetchSummaries(
  client: SupabaseClient,
  issueKeys: string[],
  userId?: string | null
): Promise<Record<string, MisclassifiedFeedbackSummary>> {
  const deduped = Array.from(
    new Set(issueKeys.map((key) => key.trim()).filter((key) => key.length > 0))
  );
  if (!deduped.length) {
    return {};
  }

  const { data, error } = await client
    .from("misclassified_feedback")
    .select("issue_key, verdict, notes, user_id, user_display, updated_at, created_at")
    .in("issue_key", deduped)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as FeedbackRow[];
  return buildSummaryMap(rows, deduped, userId);
}

function buildSummaryMap(
  rows: FeedbackRow[],
  issueKeys: string[],
  userId?: string | null
): Record<string, MisclassifiedFeedbackSummary> {
  const baseTemplate = (): MisclassifiedFeedbackSummary => ({
    issueKey: "",
    upCount: 0,
    downCount: 0,
    entries: 0,
    lastUpdatedAt: null,
    lastUpdatedBy: null,
    userVerdict: null,
    userNotes: null,
    userDisplayName: null
  });

  const summary: Record<string, MisclassifiedFeedbackSummary> = {};
  issueKeys.forEach((key) => {
    summary[key] = { ...baseTemplate(), issueKey: key };
  });

  for (const row of rows) {
    const key = row.issue_key;
    if (!summary[key]) {
      summary[key] = { ...baseTemplate(), issueKey: key };
    }
    const target = summary[key];
    target.entries += 1;
    if (row.verdict === "up") {
      target.upCount += 1;
    } else if (row.verdict === "down") {
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

function parseIssueKeys(value: unknown): string[] {
  const rawList: string[] = [];
  const append = (input: unknown) => {
    if (typeof input === "string" && input.trim().length) {
      rawList.push(input.trim());
    }
  };
  if (Array.isArray(value)) {
    value.forEach(append);
  } else if (typeof value === "string") {
    append(value);
  }
  return rawList;
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

function normalizeVerdict(value: unknown): FeedbackVerdict | null {
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
  return trimmed.slice(0, 1000);
}
