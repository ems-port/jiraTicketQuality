import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_LIMIT = 500;

type TicketRow = {
  issue_key: string | null;
  contact_reason_v2: string | null;
  contact_reason_v2_topic: string | null;
  contact_reason_v2_sub: string | null;
  llm_summary_250: string | null;
  problem_extract: string | null;
  resolution_extract: string | null;
  steps_extract: unknown;
  processed_at: string | null;
  conversation_rating: number | null;
  customer_sentiment_primary: string | null;
  duration_minutes: number | null;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Missing Supabase credentials." });
    return;
  }

  const topicRaw = Array.isArray(req.query.topic) ? req.query.topic[0] : req.query.topic;
  const subRaw = Array.isArray(req.query.sub) ? req.query.sub[0] : req.query.sub;
  if (!topicRaw || typeof topicRaw !== "string" || !topicRaw.trim()) {
    res.status(400).json({ error: "topic is required" });
    return;
  }
  const topic = topicRaw.trim();
  const sub = typeof subRaw === "string" && subRaw.trim().length ? subRaw.trim() : null;

  const windowRaw = Array.isArray(req.query.window) ? req.query.window[0] : req.query.window;
  const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const windowDays = typeof windowRaw === "string" ? Number.parseInt(windowRaw, 10) : 30;
  const limitParsed = typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : 200;
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
  const limit = Math.min(Math.max(1, limitParsed), MAX_LIMIT);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  let query = client
    .from("jira_processed_conversations")
    .select(
      "issue_key,contact_reason_v2,contact_reason_v2_topic,contact_reason_v2_sub,llm_summary_250,problem_extract,resolution_extract,steps_extract,processed_at,conversation_rating,customer_sentiment_primary,duration_minutes"
    )
    .gte("processed_at", cutoff)
    .order("processed_at", { ascending: false })
    .limit(limit);

  query = query.eq("contact_reason_v2_topic", topic);
  if (sub) {
    query = query.eq("contact_reason_v2_sub", sub);
  }

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const rows = (data || []) as TicketRow[];
  const normalized = rows.map((row) => ({
    issueKey: row.issue_key,
    contactReasonV2: row.contact_reason_v2,
    contactReasonV2Topic: row.contact_reason_v2_topic,
    contactReasonV2Sub: row.contact_reason_v2_sub,
    summary: row.llm_summary_250,
    problem: row.problem_extract,
    resolution: row.resolution_extract,
    steps: Array.isArray(row.steps_extract)
      ? (row.steps_extract as unknown[]).filter((s) => typeof s === "string") as string[]
      : [],
    processedAt: row.processed_at,
    conversationRating: row.conversation_rating,
    customerSentimentPrimary: row.customer_sentiment_primary,
    durationMinutes: row.duration_minutes
  }));

  res.status(200).json({
    rows: normalized,
    total: normalized.length,
    windowDays: days,
    topic,
    sub
  });
}
