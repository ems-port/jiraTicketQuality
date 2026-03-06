import type { NextApiRequest, NextApiResponse } from "next";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { ImprovementTopicTrendEntry, ImprovementTopicTrendPoint } from "@/types";

type GroupingRow = {
  id: string;
  time_window_start: string | null;
  time_window_end: string | null;
  created_at: string | null;
};

type ItemRow = {
  grouping_id: string;
  group_id: string;
  topic_key: string;
  title: string;
  group_size: number | null;
};

type FeedbackRow = {
  grouping_id: string;
  group_id: string;
  verdict: "up" | "down";
};

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROUPINGS_TABLE = "improvement_tip_groupings";
const ITEMS_TABLE = "improvement_tip_group_items";
const FEEDBACK_TABLE = "improvement_tip_group_feedback";
const TABLE_WARNING =
  "Improvement trend tables not found. Apply supabase/schema.sql to enable trend analytics.";

let cachedClient: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (cachedClient) {
    return cachedClient;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  cachedClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, detectSessionInUrl: false }
  });
  return cachedClient;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const client = getClient();
  if (!client) {
    res
      .status(500)
      .json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables." });
    return;
  }

  const days = clampInt(req.query.days, 30, 7, 180);
  const limit = clampInt(req.query.limit, 8, 1, 20);
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    const groupings = await fetchGroupings(client, since);
    const groupingIds = groupings.map((row) => row.id);
    if (!groupingIds.length) {
      res.status(200).json({
        windowDays: days,
        generatedAt: now.toISOString(),
        buckets: buildDailyBuckets(since, now),
        entries: []
      });
      return;
    }

    const [items, feedbackRows] = await Promise.all([
      fetchItems(client, groupingIds),
      fetchFeedback(client, groupingIds)
    ]);

    const buckets = buildDailyBuckets(since, now);
    const entries = buildTrendEntries(groupings, items, feedbackRows, buckets, limit);
    res.status(200).json({
      windowDays: days,
      generatedAt: now.toISOString(),
      buckets,
      entries
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      res.status(200).json({
        windowDays: days,
        generatedAt: now.toISOString(),
        buckets: buildDailyBuckets(since, now),
        entries: [],
        warning: TABLE_WARNING
      });
      return;
    }
    res.status(500).json({ error: (error as Error).message ?? "Unable to load improvement trends." });
  }
}

async function fetchGroupings(client: SupabaseClient, since: Date): Promise<GroupingRow[]> {
  const { data, error } = await client
    .from(GROUPINGS_TABLE)
    .select("id,time_window_start,time_window_end,created_at")
    .gte("time_window_end", since.toISOString())
    .order("time_window_end", { ascending: true });
  if (error) {
    throw error;
  }
  return (data ?? []) as GroupingRow[];
}

async function fetchItems(client: SupabaseClient, groupingIds: string[]): Promise<ItemRow[]> {
  const { data, error } = await client
    .from(ITEMS_TABLE)
    .select("grouping_id,group_id,topic_key,title,group_size")
    .in("grouping_id", groupingIds);
  if (error) {
    throw error;
  }
  return (data ?? []) as ItemRow[];
}

async function fetchFeedback(client: SupabaseClient, groupingIds: string[]): Promise<FeedbackRow[]> {
  const { data, error } = await client
    .from(FEEDBACK_TABLE)
    .select("grouping_id,group_id,verdict")
    .in("grouping_id", groupingIds);
  if (error) {
    throw error;
  }
  return (data ?? []) as FeedbackRow[];
}

function buildTrendEntries(
  groupings: GroupingRow[],
  items: ItemRow[],
  feedbackRows: FeedbackRow[],
  buckets: string[],
  limit: number
): ImprovementTopicTrendEntry[] {
  const groupingDate = new Map<string, string>();
  const groupingTs = new Map<string, number>();
  groupings.forEach((row) => {
    const iso = row.time_window_end || row.time_window_start || row.created_at;
    if (!iso) {
      return;
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return;
    }
    groupingDate.set(row.id, date.toISOString().slice(0, 10));
    groupingTs.set(row.id, date.getTime());
  });

  const bucketSet = new Set(buckets);
  const topicMap = new Map<
    string,
    {
      topicKey: string;
      title: string;
      totalCount: number;
      upCount: number;
      downCount: number;
      countsByDate: Map<string, number>;
      latestTs: number;
    }
  >();
  const groupToTopic = new Map<string, string>();

  items.forEach((item) => {
    const dateKey = groupingDate.get(item.grouping_id);
    if (!dateKey || !bucketSet.has(dateKey)) {
      return;
    }
    const topicKey = item.topic_key || "uncategorized";
    const itemCount = Math.max(0, Number(item.group_size ?? 0) || 0);
    const ts = groupingTs.get(item.grouping_id) ?? 0;
    const existing = topicMap.get(topicKey);
    if (!existing) {
      topicMap.set(topicKey, {
        topicKey,
        title: item.title || topicKey,
        totalCount: itemCount,
        upCount: 0,
        downCount: 0,
        countsByDate: new Map([[dateKey, itemCount]]),
        latestTs: ts
      });
    } else {
      existing.totalCount += itemCount;
      existing.countsByDate.set(dateKey, (existing.countsByDate.get(dateKey) ?? 0) + itemCount);
      if (ts >= existing.latestTs && item.title?.trim()) {
        existing.title = item.title.trim();
        existing.latestTs = ts;
      }
    }
    groupToTopic.set(`${item.grouping_id}::${item.group_id}`, topicKey);
  });

  feedbackRows.forEach((row) => {
    const topicKey = groupToTopic.get(`${row.grouping_id}::${row.group_id}`);
    if (!topicKey) {
      return;
    }
    const target = topicMap.get(topicKey);
    if (!target) {
      return;
    }
    if (row.verdict === "up") {
      target.upCount += 1;
    } else {
      target.downCount += 1;
    }
  });

  const sorted = Array.from(topicMap.values())
    .sort((a, b) => b.totalCount - a.totalCount)
    .slice(0, limit);

  return sorted.map((topic) => {
    const series: ImprovementTopicTrendPoint[] = buckets.map((bucket) => ({
      date: bucket,
      count: topic.countsByDate.get(bucket) ?? 0
    }));
    const delta7d = computeDelta7d(series);
    const feedbackTotal = topic.upCount + topic.downCount;
    return {
      topicKey: topic.topicKey,
      title: topic.title,
      totalCount: topic.totalCount,
      delta7d,
      upCount: topic.upCount,
      downCount: topic.downCount,
      positiveRate: feedbackTotal ? topic.upCount / feedbackTotal : null,
      series
    };
  });
}

function computeDelta7d(series: ImprovementTopicTrendPoint[]): number {
  if (!series.length) {
    return 0;
  }
  const last7 = series.slice(-7).reduce((sum, point) => sum + point.count, 0);
  const prev7 = series.slice(-14, -7).reduce((sum, point) => sum + point.count, 0);
  return last7 - prev7;
}

function buildDailyBuckets(start: Date, end: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const until = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor.getTime() <= until.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: string }).code;
  if (code === "42P01") {
    return true;
  }
  const message = (error as Error).message || "";
  return (
    message.includes(GROUPINGS_TABLE) ||
    message.includes(ITEMS_TABLE) ||
    message.includes(FEEDBACK_TABLE)
  );
}
