import type { NextApiRequest, NextApiResponse } from "next";
import { promises as fs } from "node:fs";
import path from "node:path";

const SAMPLE_FILENAME = "convo_quality_Nov_5-mini.csv";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const filePath = path.join(process.cwd(), "data", SAMPLE_FILENAME);
    const fileContents = await fs.readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.status(200).send(fileContents);
  } catch (error) {
    res.status(500).json({ error: "Unable to load sample data." });
  }
}
