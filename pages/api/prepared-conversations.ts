import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const PREPARED_TABLE = process.env.SUPABASE_JIRA_PREPARED_TABLE || "jira_prepared_conversations";
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Supabase credentials missing" });
    return;
  }

  const limit = Math.max(
    1,
    Math.min(
      50,
      Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 10
    )
  );

  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data, error } = await client
    .from(PREPARED_TABLE)
    .select("issue_key,payload,prepared_at")
    .order("prepared_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(200).json({ entries: data ?? [] });
}
