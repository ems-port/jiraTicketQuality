import type { NextApiRequest, NextApiResponse } from "next";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROLE_FILENAME = "port_roles.csv";

type RoleEntry = {
  user_id: string;
  display_name: string;
  port_role: string;
};

function escapeCsv(value: string): string {
  const needsQuotes = /[",\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

function toCsv(entries: RoleEntry[]): string {
  const header = "user_id,display_name,port_role";
  const lines = entries.map(
    (entry) =>
      `${escapeCsv(entry.user_id)},${escapeCsv(entry.display_name)},${escapeCsv(entry.port_role)}`
  );
  return [header, ...lines].join("\n");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const filePath = path.join(process.cwd(), "data", ROLE_FILENAME);
  if (req.method === "PUT") {
    try {
      const payload = req.body?.entries ?? req.body;
      if (!Array.isArray(payload)) {
        res.status(400).json({ error: "Payload must include an entries array." });
        return;
      }
      const entries: RoleEntry[] = payload
        .map((raw) => {
          const userId = (raw?.user_id ?? raw?.userId ?? raw?.id ?? "").toString().trim();
          if (!userId) {
            return null;
          }
          const displayName = (raw?.display_name ?? raw?.displayName ?? raw?.name ?? "")
            .toString()
            .trim();
          const roleValue = (raw?.port_role ?? raw?.portRole ?? raw?.role ?? "NON_AGENT")
            .toString()
            .trim()
            .toUpperCase();
          const normalisedRole =
            roleValue === "TIER1" || roleValue === "TIER2" ? roleValue : "NON_AGENT";
          return {
            user_id: userId,
            display_name: displayName,
            port_role: normalisedRole
          };
        })
        .filter((entry): entry is RoleEntry => Boolean(entry));
      if (!entries.length) {
        res.status(400).json({ error: "No valid agent entries provided." });
        return;
      }
      await fs.writeFile(filePath, toCsv(entries), "utf-8");
      res.status(200).json({ success: true, count: entries.length });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message ?? "Unable to save roles CSV." });
    }
    return;
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, PUT");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const fileContents = await fs.readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.status(200).send(fileContents);
  } catch (error) {
    res.status(500).json({ error: "Unable to load roles CSV." });
  }
}
