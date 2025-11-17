import type { NextApiRequest, NextApiResponse } from "next";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_FETCH_LIMIT = Math.max(1, Number(process.env.CONVERSATION_FETCH_LIMIT ?? 5000));
const PAGE_SIZE = Math.max(1, Number(process.env.CONVERSATION_FETCH_PAGE_SIZE ?? 500));

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
    const rows = await fetchProcessedConversations(supabase, limit);
    res.status(200).json({ rows });
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

async function fetchProcessedConversations(client: SupabaseClient, limit: number) {
  const rows: Record<string, unknown>[] = [];
  let start = 0;
  const pageSize = Math.min(PAGE_SIZE, limit);

  while (rows.length < limit) {
    const end = Math.min(start + pageSize - 1, start + (limit - rows.length) - 1);
    const { data, error } = await client
      .from("jira_processed_conversations")
      .select("*")
      .order("conversation_end", { ascending: false })
      .range(start, end);

    if (error) {
      throw error;
    }

    const batch = data ?? [];
    rows.push(...batch);

    if (batch.length < (end - start + 1)) {
      break;
    }

    start += batch.length;
    if (start >= limit) {
      break;
    }
  }

  return rows;
}
