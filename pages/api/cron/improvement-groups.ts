import type { NextApiRequest, NextApiResponse } from "next";
import { execFile } from "node:child_process";
import path from "node:path";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const scriptPath = path.join(process.cwd(), "analysis", "improvement_tip_summary_v2.py");
  const args = ["--max-tokens", "6000"];
  execFile("python3", [scriptPath, ...args], { timeout: 1000 * 60 * 3 }, (error, stdout, stderr) => {
    if (error) {
      res.status(500).json({ error: error.message, stderr });
      return;
    }
    res.status(200).json({ ok: true, stdout, stderr });
  });
}
