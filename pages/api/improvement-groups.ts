import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import path from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = "improvement_tip_groupings";
const PYTHON_BIN = process.env.PYTHON_PATH || "python3";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables." });
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, detectSessionInUrl: false }
  });

  if (req.method === "POST") {
    // Trigger a fresh run of the Python grouper (wrapper).
    const scriptPath = path.join(process.cwd(), "api", "improvement_groups.py");
    const args = ["--max-tokens", String(req.body?.maxTokens ?? 6000)];
    execFile(PYTHON_BIN, [scriptPath, ...args], { timeout: 1000 * 60 * 3 }, (error, stdout, stderr) => {
      if (error) {
        console.error("improvement-groups exec error", {
          message: error.message,
          code: (error as any)?.code,
          stdout,
          stderr
        });
        res
          .status(500)
          .json({
            error: error.message,
            code: (error as any)?.code,
            hint:
              (error as any)?.code === "ENOENT"
                ? `Python binary not found (${PYTHON_BIN}). Set PYTHON_PATH to a valid interpreter on this platform.`
                : undefined,
            stderr,
            stdout
          });
        return;
      }
      res.status(200).json({ ok: true, stdout, stderr });
    });
    return;
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("time_window_start,time_window_end,total_notes,unique_notes,model,payload,created_at")
      .order("time_window_end", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      res.status(200).json({ payload: null });
      return;
    }

    res.status(200).json({
      record: {
        timeWindowStart: data.time_window_start,
        timeWindowEnd: data.time_window_end,
        totalNotes: data.total_notes,
        uniqueNotes: data.unique_notes,
        model: data.model,
        payload: data.payload,
        createdAt: data.created_at
      }
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message ?? "Unable to fetch improvement tip groupings." });
  }
}
