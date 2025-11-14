import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    const { data, error } = await supabase
      .from("jira_processed_conversations")
      .select("*")
      .order("conversation_end", { ascending: false })
      .limit(5000);

    if (error) {
      throw error;
    }

    res.status(200).json({ rows: data ?? [] });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message ?? "Unable to fetch conversations." });
  }
}
