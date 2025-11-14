import type { NextApiRequest, NextApiResponse } from "next";

import { jobState, startJob } from "../refresh-data";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.REFRESH_CRON_SECRET;

const normalizeHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

function isAuthorized(req: NextApiRequest): boolean {
  if (CRON_SECRET) {
    const authHeader = normalizeHeader(req.headers.authorization);
    const bearer = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : authHeader?.trim();
    const headerSecret = normalizeHeader(req.headers["x-cron-secret"]);
    const querySecret = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
    return [bearer, headerSecret, querySecret].some(
      (candidate) => candidate && candidate === CRON_SECRET
    );
  }
  return Boolean(normalizeHeader(req.headers["x-vercel-cron"]));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) {
    res.status(500).json({ error: "Supabase credentials missing" });
    return;
  }

  if (jobState.running) {
    res.status(409).json(jobState);
    return;
  }

  startJob();
  res.status(202).json(jobState);
}
