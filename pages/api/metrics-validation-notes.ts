import type { NextApiRequest, NextApiResponse } from "next";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { MetricsValidationIssueNote } from "@/types";

type GroupItemRow = {
  grouping_id: string;
  group_id: string;
  topic_key: string | null;
  title: string | null;
  key_ids: string[] | null;
};

type FeedbackRow = {
  grouping_id: string;
  group_id: string;
  verdict: "up" | "down";
  notes: string | null;
  user_id: string;
  user_display: string | null;
  updated_at: string | null;
  created_at: string | null;
};

type IssueNotesResponse = {
  notesByIssue: Record<string, MetricsValidationIssueNote[]>;
  warning?: string;
};

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ITEMS_TABLE = "improvement_tip_group_items";
const FEEDBACK_TABLE = "improvement_tip_group_feedback";
const TABLE_WARNING =
  "Metrics Validation tables not found. Apply supabase/schema.sql to enable notes lookup.";

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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const client = getClient();
  if (!client) {
    res
      .status(500)
      .json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables." });
    return;
  }

  const issueKeys = parseIssueKeys(req.body?.issueKeys);
  if (!issueKeys.length) {
    res.status(400).json({ error: "issueKeys is required." });
    return;
  }

  try {
    const notesByIssue = await fetchNotesByIssue(client, issueKeys);
    res.status(200).json({ notesByIssue } satisfies IssueNotesResponse);
  } catch (error) {
    if (isMissingTableError(error)) {
      res.status(200).json({ notesByIssue: {}, warning: TABLE_WARNING } satisfies IssueNotesResponse);
      return;
    }
    res.status(500).json({ error: (error as Error).message ?? "Unable to load Metrics Validation notes." });
  }
}

async function fetchNotesByIssue(
  client: SupabaseClient,
  issueKeys: string[]
): Promise<Record<string, MetricsValidationIssueNote[]>> {
  const uniqueIssueKeys = Array.from(new Set(issueKeys));
  const issueSet = new Set(uniqueIssueKeys);
  const notesByIssue: Record<string, MetricsValidationIssueNote[]> = {};
  uniqueIssueKeys.forEach((key) => {
    notesByIssue[key] = [];
  });

  const { data: itemData, error: itemError } = await client
    .from(ITEMS_TABLE)
    .select("grouping_id,group_id,topic_key,title,key_ids")
    .overlaps("key_ids", uniqueIssueKeys);
  if (itemError) {
    throw itemError;
  }
  const items = (itemData ?? []) as GroupItemRow[];
  if (!items.length) {
    return notesByIssue;
  }

  const groupingIds = Array.from(new Set(items.map((row) => row.grouping_id).filter(Boolean)));
  const groupIds = Array.from(new Set(items.map((row) => row.group_id).filter(Boolean)));
  if (!groupingIds.length || !groupIds.length) {
    return notesByIssue;
  }

  const pairToItem = new Map<string, GroupItemRow>();
  items.forEach((item) => {
    pairToItem.set(`${item.grouping_id}::${item.group_id}`, item);
  });

  const { data: feedbackData, error: feedbackError } = await client
    .from(FEEDBACK_TABLE)
    .select("grouping_id,group_id,verdict,notes,user_id,user_display,updated_at,created_at")
    .in("grouping_id", groupingIds)
    .in("group_id", groupIds)
    .order("updated_at", { ascending: false });
  if (feedbackError) {
    throw feedbackError;
  }
  const feedbackRows = (feedbackData ?? []) as FeedbackRow[];
  if (!feedbackRows.length) {
    return notesByIssue;
  }

  for (const feedback of feedbackRows) {
    const noteText = feedback.notes?.trim();
    if (!noteText) {
      continue;
    }
    const item = pairToItem.get(`${feedback.grouping_id}::${feedback.group_id}`);
    if (!item) {
      continue;
    }
    const issueKeysForItem = Array.isArray(item.key_ids)
      ? item.key_ids.map((value) => value.trim()).filter((value) => value.length > 0)
      : [];
    issueKeysForItem.forEach((issueKey) => {
      if (!issueSet.has(issueKey)) {
        return;
      }
      notesByIssue[issueKey].push({
        issueKey,
        groupingId: feedback.grouping_id,
        groupId: feedback.group_id,
        topicKey: item.topic_key?.trim() || "uncategorized",
        groupTitle: item.title?.trim() || item.topic_key?.trim() || "Untitled group",
        verdict: feedback.verdict === "down" ? "down" : "up",
        notes: noteText,
        userId: feedback.user_id,
        userDisplayName: feedback.user_display?.trim() || null,
        updatedAt: feedback.updated_at,
        createdAt: feedback.created_at
      });
    });
  }

  return notesByIssue;
}

function parseIssueKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().slice(0, 80))
    .filter((entry) => entry.length > 0)
    .slice(0, 500);
}

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: string }).code;
  if (code === "42P01") {
    return true;
  }
  const message = (error as Error).message || "";
  return message.includes(ITEMS_TABLE) || message.includes(FEEDBACK_TABLE);
}
