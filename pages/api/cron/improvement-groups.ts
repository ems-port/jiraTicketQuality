import type { NextApiRequest, NextApiResponse } from "next";
import { execFile } from "node:child_process";
import path from "node:path";

const PYTHON_BIN = process.env.PYTHON_PATH || "python3";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Use the wrapper entrypoint so the cron path mirrors manual refresh.
  const scriptPath = path.join(process.cwd(), "api", "improvement_groups.py");
  const args = ["--max-tokens", "6000"];
  execFile(PYTHON_BIN, [scriptPath, ...args], { timeout: 1000 * 60 * 3 }, (error, stdout, stderr) => {
    if (error) {
      res.status(500).json({ error: error.message, stderr, stdout });
      return;
    }
    res.status(200).json({ ok: true, stdout, stderr });
  });
}
