import type { NextApiRequest, NextApiResponse } from "next";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_CONTACT_TAXONOMY,
  DEFAULT_CONTACT_TAXONOMY_ENTRIES,
  flattenTaxonomyEntries
} from "@/lib/defaultContactTaxonomy";
import type { ContactTaxonomyReason, ContactTaxonomyStatus } from "@/types";

const STATUS_VALUES = ["NEW", "IN_USE", "OBSOLETED", "CANCELLED"] as const;
type TaxonomyStatus = ContactTaxonomyStatus;

type ContactTaxonomyRow = {
  id?: string;
  version: number;
  reasons: ContactTaxonomyReason[];
  labels: string[];
  notes?: string | null;
  status: TaxonomyStatus;
  created_at?: string | null;
  created_by?: string | null;
};

function getSupabaseClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return null;
  }
  return createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

function sanitizeReasons(reasons: unknown): ContactTaxonomyReason[] | null {
  if (!Array.isArray(reasons)) return null;
  const cleaned: ContactTaxonomyReason[] = [];
  reasons.forEach((reason, index) => {
    if (typeof reason !== "object" || reason === null) return;
    const topic = typeof (reason as any).topic === "string" ? (reason as any).topic.trim() : "";
    if (!topic) return;
    const subReason = typeof (reason as any).sub_reason === "string" ? (reason as any).sub_reason.trim() : "";
    const description = typeof (reason as any).description === "string" ? (reason as any).description.trim() : "";
    const keywords =
      Array.isArray((reason as any).keywords) &&
      (reason as any).keywords.every((kw: unknown) => typeof kw === "string")
        ? ((reason as any).keywords as string[]).map((kw) => kw.trim()).filter(Boolean)
        : [];
    const statusRaw = typeof (reason as any).status === "string" ? (reason as any).status.trim().toUpperCase() : "IN_USE";
    const status: TaxonomyStatus = STATUS_VALUES.includes(statusRaw as TaxonomyStatus)
      ? (statusRaw as TaxonomyStatus)
      : "IN_USE";
    cleaned.push({
      topic,
      sub_reason: subReason || null,
      description: description || null,
      keywords: keywords.length ? keywords : undefined,
      sort_order: typeof (reason as any).sort_order === "number" ? (reason as any).sort_order : index,
      status
    });
  });
  return cleaned.length ? cleaned : null;
}

function labelsToReasons(labels: unknown): ContactTaxonomyReason[] | null {
  if (!Array.isArray(labels)) return null;
  const cleaned: ContactTaxonomyReason[] = [];
  labels.forEach((label, index) => {
    if (typeof label !== "string") return;
    const value = label.trim();
    if (!value) return;
    const [topic, ...rest] = value.split(" - ");
    const sub = rest.join(" - ").trim();
    cleaned.push({
      topic: topic.trim(),
      sub_reason: sub || null,
      sort_order: index,
      status: "IN_USE"
    });
  });
  return cleaned.length ? cleaned : null;
}

async function fetchLatest(client: SupabaseClient): Promise<ContactTaxonomyRow | null> {
  const { data: activeVersion, error: activeError } = await client
    .from("contact_taxonomy_versions")
    .select("id,version,notes,status,created_at,created_by")
    .eq("status", "IN_USE")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) {
    console.error("Failed to fetch contact taxonomy", activeError);
    return null;
  }
  let versionRow = activeVersion;
  if (!versionRow) {
    const { data, error } = await client
      .from("contact_taxonomy_versions")
      .select("id,version,notes,status,created_at,created_by")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("Failed to fetch contact taxonomy", error);
      return null;
    }
    versionRow = data;
  }
  if (!versionRow) return null;
  const { data: reasonsData, error: reasonsError } = await client
    .from("contact_taxonomy_reasons")
    .select("id,topic,sub_reason,description,keywords,sort_order,status")
    .eq("version_id", versionRow.id)
    .order("sort_order", { ascending: true })
    .order("topic", { ascending: true });
  if (reasonsError) {
    console.error("Failed to fetch contact taxonomy reasons", reasonsError);
    return null;
  }
  const reasons: ContactTaxonomyReason[] = Array.isArray(reasonsData)
    ? reasonsData.map((entry, index) => ({
        topic: typeof entry.topic === "string" ? entry.topic : "",
        sub_reason: typeof entry.sub_reason === "string" ? entry.sub_reason : null,
        description: typeof entry.description === "string" ? entry.description : null,
        keywords: Array.isArray(entry.keywords)
          ? entry.keywords.filter((kw): kw is string => typeof kw === "string").map((kw) => kw.trim()).filter(Boolean)
          : undefined,
        sort_order: typeof entry.sort_order === "number" ? entry.sort_order : index,
        status: typeof entry.status === "string" && STATUS_VALUES.includes(entry.status as TaxonomyStatus)
          ? (entry.status as TaxonomyStatus)
          : "IN_USE"
      }))
    : [];
  return {
    ...versionRow,
    reasons,
    labels: flattenTaxonomyEntries(reasons.filter((reason) => reason.status !== "CANCELLED"))
  };
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const client = getSupabaseClient();
  if (!client) {
    res.status(200).json({
      taxonomy: {
        version: 1,
        reasons: DEFAULT_CONTACT_TAXONOMY_ENTRIES,
        labels: DEFAULT_CONTACT_TAXONOMY,
        status: "IN_USE",
        created_at: null,
        created_by: "fallback"
      }
    });
    return;
  }
  const latest = await fetchLatest(client);
  if (!latest) {
    res.status(200).json({
      taxonomy: {
        version: 1,
        reasons: DEFAULT_CONTACT_TAXONOMY_ENTRIES,
        labels: DEFAULT_CONTACT_TAXONOMY,
        status: "IN_USE",
        created_at: null,
        created_by: "fallback"
      }
    });
    return;
  }
  res.status(200).json({ taxonomy: latest });
}

async function handlePut(req: NextApiRequest, res: NextApiResponse) {
  const client = getSupabaseClient();
  if (!client) {
    res.status(500).json({ error: "Supabase credentials missing." });
    return;
  }
  const payload =
    (req.body as { reasons?: unknown; labels?: unknown; notes?: unknown; created_by?: unknown; status?: unknown }) ?? {};
  const reasons = sanitizeReasons(payload.reasons) ?? labelsToReasons(payload.labels);
  if (!reasons) {
    res.status(400).json({ error: "reasons must be a non-empty array of objects with topic/sub_reason/description." });
    return;
  }
  const createdBy = typeof payload.created_by === "string" && payload.created_by.trim().length > 0 ? payload.created_by : "dashboard_ui";
  const notes = typeof payload.notes === "string" ? payload.notes : null;
  const statusInput = typeof payload.status === "string" ? payload.status.trim().toUpperCase() : "NEW";
  const status: TaxonomyStatus = STATUS_VALUES.includes(statusInput as TaxonomyStatus)
    ? (statusInput as TaxonomyStatus)
    : "NEW";

  const latest = await fetchLatest(client);
  const nextVersion = latest ? (latest.version ?? 0) + 1 : 1;

  const { data: versionData, error: insertError } = await client
    .from("contact_taxonomy_versions")
    .insert({
      version: nextVersion,
      notes,
      status,
      created_by: createdBy
    })
    .select("id,version,notes,status,created_at,created_by")
    .single();
  if (insertError || !versionData?.id) {
    res.status(500).json({ error: insertError?.message || "Unable to create taxonomy version." });
    return;
  }
  const versionId = versionData.id;
  const reasonRows = reasons.map((reason, index) => ({
    version_id: versionId,
    topic: reason.topic,
    sub_reason: reason.sub_reason ?? null,
    description: reason.description ?? null,
    keywords: reason.keywords && reason.keywords.length ? reason.keywords : null,
    sort_order: typeof reason.sort_order === "number" ? reason.sort_order : index,
    status: reason.status ?? "IN_USE"
  }));
  const { error: reasonError } = await client.from("contact_taxonomy_reasons").insert(reasonRows);
  if (reasonError) {
    res.status(500).json({ error: reasonError.message });
    return;
  }
  // If promoting to IN_USE, demote any prior IN_USE rows to OBSOLETED for single-active semantics.
  if (status === "IN_USE") {
    await client
      .from("contact_taxonomy_versions")
      .update({ status: "OBSOLETED" })
      .eq("status", "IN_USE")
      .neq("version", nextVersion);
  }

  const created: ContactTaxonomyRow = {
    ...versionData,
    reasons,
    labels: flattenTaxonomyEntries(reasons.filter((reason) => reason.status !== "CANCELLED"))
  };
  res.status(200).json({ taxonomy: created });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    await handleGet(req, res);
    return;
  }
  if (req.method === "PUT" || req.method === "POST") {
    await handlePut(req, res);
    return;
  }
  res.setHeader("Allow", "GET, PUT, POST");
  res.status(405).json({ error: "Method not allowed" });
}
