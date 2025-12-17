import type { NextApiRequest, NextApiResponse } from "next";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_FETCH_LIMIT = Math.max(1, Number(process.env.CONVERSATION_FETCH_LIMIT ?? 5000));
const MAX_PAGE_SIZE = Math.max(1, Number(process.env.CONVERSATION_FETCH_PAGE_SIZE ?? 200));
const SELECT_COLUMNS =
  process.env.CONVERSATION_SELECT_COLUMNS ||
  [
    "issue_key",
    "status",
    "resolution",
    "rental_id",
    "bike_qr_code",
    "bike_qr_mismatch",
    "custom_field_hub",
    "conversation_start",
    "conversation_end",
    "duration_minutes",
    "duration_to_resolution",
    "first_agent_response_minutes",
    "avg_agent_response_minutes",
    "avg_customer_response_minutes",
    "messages_total",
    "messages_agent",
    "messages_customer",
    "turns",
    "agent_authors",
    "customer_authors",
    "initial_response_sla_5m",
    "initial_response_sla_15m",
    "agent_profanity_detected",
    "agent_profanity_count",
    "customer_abuse_detected",
    "customer_abuse_count",
    "llm_summary_250",
    "conversation_rating",
    "problem_extract",
    "resolution_extract",
    "steps_extract",
    "resolution_timestamp_iso",
    "resolution_message_index",
    "contact_reason",
    "contact_reason_original",
    "contact_reason_change",
    "reason_override_why",
    "resolution_why",
    "customer_sentiment_primary",
    "customer_sentiment_scores",
    "agent_score",
    "customer_score",
    "resolved",
    "is_resolved",
    "improvement_tip",
    "llm_model",
    "llm_input_tokens",
    "llm_output_tokens",
    "llm_cost_usd",
    "processed_at"
  ].join(",");

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res
      .status(500)
      .json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables." });
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      detectSessionInUrl: false
    }
  });

  try {
    const limit = resolveLimit(req.query.limit);
    const pageSize = resolvePageSize(req.query.pageSize);
    const offset = resolveOffset(req.query.offset);
    const { rows, nextOffset } = await fetchProcessedConversations(supabase, { limit, pageSize, offset });
    res.status(200).json({ rows, nextOffset });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message ?? "Unable to fetch conversations." });
  }
}

function resolveLimit(rawLimit: unknown): number {
  const value = Array.isArray(rawLimit) ? rawLimit[0] : rawLimit;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_FETCH_LIMIT);
    }
  }
  return MAX_FETCH_LIMIT;
}

function resolvePageSize(rawPageSize: unknown): number {
  const value = Array.isArray(rawPageSize) ? rawPageSize[0] : rawPageSize;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_PAGE_SIZE);
    }
  }
  return MAX_PAGE_SIZE;
}

function resolveOffset(rawOffset: unknown): number {
  const value = Array.isArray(rawOffset) ? rawOffset[0] : rawOffset;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

async function fetchProcessedConversations(
  client: SupabaseClient,
  { limit, pageSize, offset }: { limit: number; pageSize: number; offset: number }
) {
  const totalLimit = Math.max(0, limit);
  const pageSizeResolved = Math.max(1, Math.min(pageSize, totalLimit));
  const start = offset;
  const remaining = Math.min(pageSizeResolved, Math.max(0, totalLimit - start));
  const end = start + remaining - 1;

  const { data, error } = await client
    .from("jira_processed_conversations")
    .select(SELECT_COLUMNS)
    .order("conversation_end", { ascending: false })
    .range(start, end);

  if (error) {
    throw error;
  }

  const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];
  const nextOffset =
    rows.length === remaining && start + rows.length < totalLimit ? start + rows.length : null;

  return { rows, nextOffset };
}
