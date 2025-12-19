import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_FETCH = 20000;

type BikeIssueRow = {
  issue_key: string | null;
  bike_qr_code: string | null;
  bike_qr_mismatch?: string | null;
  contact_reason_v2_topic: string | null;
  contact_reason_v2_sub: string | null;
  processed_at: string | null;
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
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const windowDaysRaw = Array.isArray(req.query.window) ? req.query.window[0] : req.query.window;
  const includeUnknownRaw = Array.isArray(req.query.include_unknown)
    ? req.query.include_unknown[0]
    : req.query.include_unknown;
  const includeUnknown = typeof includeUnknownRaw === "string" && includeUnknownRaw.toLowerCase() === "true";
  const topicRaw = Array.isArray(req.query.topic) ? req.query.topic[0] : req.query.topic;
  const topicFilter = typeof topicRaw === "string" && topicRaw.trim().length > 0 ? topicRaw.trim() : "Ebike hardware issue";
  const windowDays = typeof windowDaysRaw === "string" ? Number.parseInt(windowDaysRaw, 10) : 30;
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("jira_processed_conversations")
    .select("issue_key,bike_qr_code,bike_qr_mismatch,contact_reason_v2_topic,contact_reason_v2_sub,processed_at")
    .gte("processed_at", cutoff);

  if (topicFilter) {
    query = query.ilike("contact_reason_v2_topic", `${topicFilter}%`);
  }

  const { data, error } = await query.limit(MAX_FETCH);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const rows = Array.isArray(data) ? (data as BikeIssueRow[]) : [];
  const agg: Record<
    string,
    {
      count: number;
      issues: string[];
      reasons: Record<string, number>;
      subs: Record<string, number>;
    }
  > = {};

  rows.forEach((row) => {
    const rawBike = (row.bike_qr_code || row.bike_qr_mismatch || "").trim();
    if (!rawBike && !includeUnknown) return; // skip unknown/empty unless requested
    if (rawBike === "--") return; // skip placeholder
    const bike = rawBike || "Unknown";
    const reason = row.contact_reason_v2_topic
      ? row.contact_reason_v2_sub
        ? `${row.contact_reason_v2_topic} — ${row.contact_reason_v2_sub}`
        : row.contact_reason_v2_topic
      : "Unspecified";
    const sub = row.contact_reason_v2_sub ? row.contact_reason_v2_sub.trim() : "Unspecified";
    if (!agg[bike]) {
      agg[bike] = { count: 0, issues: [], reasons: {}, subs: {} };
    }
    agg[bike].count += 1;
    if (row.issue_key) {
      agg[bike].issues.push(row.issue_key);
    }
    agg[bike].reasons[reason] = (agg[bike].reasons[reason] || 0) + 1;
    agg[bike].subs[sub] = (agg[bike].subs[sub] || 0) + 1;
  });

  const result = Object.entries(agg)
    .map(([bike, value]) => ({
      bike,
      count: value.count,
      issues: value.issues.slice(0, 20),
      reasons: Object.entries(value.reasons)
        .map(([label, c]) => ({ label, count: c }))
        .sort((a, b) => b.count - a.count),
      subs: Object.entries(value.subs)
        .map(([label, c]) => ({ label, count: c }))
        .sort((a, b) => b.count - a.count)
    }))
    .sort((a, b) => b.count - a.count);

  res.status(200).json({ rows: result, total: result.length, windowDays: days });
}
