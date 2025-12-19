import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import path from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = "improvement_tip_groupings";
const PYTHON_BIN = process.env.PYTHON_PATH || "python3";
const VERCEL_BYPASS_TOKEN = process.env.VERCEL_PROTECTION_BYPASS;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables." });
    return;
  }

  if (req.method === "GET") {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, detectSessionInUrl: false }
    });

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
        res.status(200).json({ record: null });
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
      res.status(500).json({ error: (error as Error).message ?? "Unable to fetch improvement groups." });
    }
    return;
  }

  if (req.method === "POST") {
    try {
      const host = req.headers.host ?? "";
      const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");

      if (isLocal) {
        // Local fallback: run the Python script directly.
        const scriptPath = path.join(process.cwd(), "analysis", "improvement_tip_summary_v2.py");
        const args = ["--max-tokens", String((req.body as any)?.maxTokens ?? 6000)];
        execFile(PYTHON_BIN, [scriptPath, ...args], { timeout: 1000 * 60 * 3 }, (error, stdout, stderr) => {
          if (error) {
            res.status(500).json({
              error: error.message,
              code: (error as any)?.code,
              stderr,
              stdout
            });
            return;
          }
          res.status(200).json({ ok: true, stdout, stderr });
        });
        return;
      }

      // Production: proxy to the Python serverless function.
      const protocol = "https";
      const upstreamUrl = `${protocol}://${host}/api/improvement_groups`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (VERCEL_BYPASS_TOKEN) {
        headers["x-vercel-protection-bypass"] = VERCEL_BYPASS_TOKEN;
      }
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(req.body ?? {})
      });
      const body = await upstream.text();
      let parsed: any = body;
      try {
        parsed = JSON.parse(body);
      } catch {
        // leave as text
      }
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: "Upstream refresh failed", status: upstream.status, body: parsed });
        return;
      }
      res.status(200).json(parsed);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message ?? "Unable to trigger improvement groups job." });
    }
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed" });
}
