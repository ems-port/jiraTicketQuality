import {
  AgentMatrixRow,
  AgentPerformance,
  AgentPerformancePoint,
  ContactReasonSummary,
  ConversationRow,
  ImprovementTipSummary,
  MetricSeries,
  SettingsState,
  TimeWindow,
  ToxicityEntry
} from "@/types";

const TIME_WINDOW_DURATIONS: Record<TimeWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_DAYS_MS = 5 * DAY_MS;

type PrimitiveRecord = Record<string, string | number | boolean | null | undefined>;

const CLEAN_SPLIT_REGEX = /[;,|]/;

export function normaliseRow(raw: PrimitiveRecord): ConversationRow {
  const agentList = normaliseList(asString(raw.agent_authors));
  const customerList = normaliseList(asString(raw.customer_authors));
  const startedAt = asDate(raw.conversation_start ?? raw.started_at);
  const endedAt = asDate(raw.conversation_end ?? raw.ended_at);
  const agentScore = asNumber(raw.agent_score);
  const customerScore = asNumber(raw.customer_score);
  const conversationRating = asNumber(raw.conversation_rating);
  const totalScore = computeBlendedScore(agentScore, customerScore, conversationRating);
  const improvementTipRaw = asString(raw.improvement_tip);
  const improvementTip = improvementTipRaw ? improvementTipRaw : null;
  const ticketSummaryRaw = asString(raw.llm_summary_250 ?? raw.ticket_summary);
  const ticketSummary = ticketSummaryRaw ? ticketSummaryRaw : null;
  const contactReasonRaw = asString(raw.contact_reason ?? raw.custom_field_contact_reason);
  const contactReasonOriginalRaw = asString(raw.contact_reason_original ?? raw.custom_field_contact_reason);
  const contactReason = contactReasonRaw ? contactReasonRaw : null;
  const contactReasonOriginal = contactReasonOriginalRaw ? contactReasonOriginalRaw : null;

  const statusString = asString(raw.status);
  const resolved = asBoolean(
    raw.resolved ??
      (statusString
        ? ["done", "resolved", "closed"].includes(statusString.toLowerCase())
        : false)
  );
  const agent = agentList[0] ?? asString(raw.agent) ?? "Unassigned";
  const durationMinutes = asNumber(raw.duration_minutes);

  const escalated = agentList.filter(Boolean).length > 1;

  return {
    issueKey: asString(raw.issue_key) || "UNKNOWN",
    agent,
    agentList: agentList.length ? agentList : [agent],
    customerList: customerList.length ? customerList : ["Customer"],
    resolved,
    startedAt,
    endedAt,
    durationMinutes,
    firstAgentResponseMinutes: asNumber(raw.first_agent_response_minutes),
    avgAgentResponseMinutes: asNumber(raw.avg_agent_response_minutes),
    messagesTotal: asNumber(raw.messages_total),
    messagesAgent: asNumber(raw.messages_agent),
    messagesCustomer: asNumber(raw.messages_customer),
    customerAbuseCount: asNumber(raw.customer_abuse_count),
    customerAbuseDetected: asBoolean(raw.customer_abuse_detected),
    agentProfanityDetected: asBoolean(raw.agent_profanity_detected),
    agentProfanityCount: asNumber(raw.agent_profanity_count),
    agentScore,
    customerScore,
    conversationRating,
    totalScore,
    improvementTip,
    ticketSummary,
    contactReason,
    contactReasonOriginal,
    hub: (raw.custom_field_hub as string) ?? (raw.hub as string) ?? null,
    model: (raw.llm_model as string) ?? (raw.model as string) ?? null,
    agentToxicityScore: asNumber(raw.agent_toxicity_score),
    agentAbusiveFlag: asBoolean(raw.agent_abusive_flag),
    customerToxicityScore: asNumber(raw.customer_toxicity_score),
    customerAbusiveFlag: asBoolean(raw.customer_abusive_flag),
    escalated,
    raw: { ...raw }
  };
}

export function normaliseRows(rows: PrimitiveRecord[]): ConversationRow[] {
  return rows.map(normaliseRow);
}

export function filterByWindow(
  rows: ConversationRow[],
  window: TimeWindow,
  now: Date = new Date()
): ConversationRow[] {
  const horizon = now.getTime() - TIME_WINDOW_DURATIONS[window];
  return rows.filter((row) => {
    const reference = row.endedAt ?? row.startedAt;
    if (!reference) {
      return false;
    }
    return reference.getTime() >= horizon;
  });
}

export function buildMetricSeries(
  rows: ConversationRow[],
  metric: (rows: ConversationRow[]) => number | null,
  now: Date = new Date()
): MetricSeries[] {
  return (Object.keys(TIME_WINDOW_DURATIONS) as TimeWindow[]).map((window) => ({
    window,
    value: metric(filterByWindow(rows, window, now))
  }));
}

export function computeAverageConversationRating(rows: ConversationRow[]): number | null {
  const scoreValues = rows
    .map((row) => row.totalScore)
    .filter((value): value is number => value !== null && !Number.isNaN(value));
  if (!scoreValues.length) {
    return null;
  }
  const sum = scoreValues.reduce((acc, value) => acc + value, 0);
  return sum / scoreValues.length;
}

export function computeResolvedCount(rows: ConversationRow[]): number {
  return rows.filter((row) => row.resolved).length;
}

export function computeResolvedStats(rows: ConversationRow[]): {
  count: number;
  total: number;
  percentage: number | null;
} {
  const count = computeResolvedCount(rows);
  const total = rows.length;
  const percentage = total > 0 ? (count / total) * 100 : null;
  return { count, total, percentage };
}

export function buildResolvedSeries(
  rows: ConversationRow[],
  now: Date = new Date()
): MetricSeries[] {
  return (Object.keys(TIME_WINDOW_DURATIONS) as TimeWindow[]).map((window) => {
    const windowRows = filterByWindow(rows, window, now);
    const stats = computeResolvedStats(windowRows);
    return {
      window,
      value: stats.percentage,
      count: stats.count,
      total: stats.total
    };
  });
}

export function computeEscalatedCount(rows: ConversationRow[]): number {
  return rows.filter((row) => row.escalated).length;
}

export function computeImprovementTips(
  rows: ConversationRow[],
  now: Date = new Date(),
  topLimit = 3
): ImprovementTipSummary {
  const windowed = filterByWindow(rows, "24h", now);
  const aggregations = new Map<
    string,
    {
      count: number;
      issueKeys: Set<string>;
      agents: Set<string>;
      lastSeen: Date | null;
    }
  >();

  windowed.forEach((row) => {
    const tip = row.improvementTip?.trim();
    if (!tip) {
      return;
    }
    const bucket =
      aggregations.get(tip) ??
      {
        count: 0,
        issueKeys: new Set<string>(),
        agents: new Set<string>(),
        lastSeen: null
      };
    bucket.count += 1;
    bucket.issueKeys.add(row.issueKey);
    row.agentList.forEach((agent) => bucket.agents.add(agent));
    const reference = row.endedAt ?? row.startedAt;
    if (reference) {
      if (!bucket.lastSeen || reference.getTime() > bucket.lastSeen.getTime()) {
        bucket.lastSeen = reference;
      }
    }
    aggregations.set(tip, bucket);
  });

  const entries = Array.from(aggregations.entries()).map(([tip, data]) => ({
    tip,
    count: data.count,
    issueKeys: Array.from(data.issueKeys),
    agents: Array.from(data.agents),
    lastSeen: data.lastSeen
  }));

  entries.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    const aTime = a.lastSeen ? a.lastSeen.getTime() : 0;
    const bTime = b.lastSeen ? b.lastSeen.getTime() : 0;
    return bTime - aTime;
  });

  const total = entries.reduce((acc, entry) => acc + entry.count, 0);
  const unique = entries.length;
  const windowStart = new Date(now.getTime() - TIME_WINDOW_DURATIONS["24h"]);

  return {
    entries,
    topEntries: entries.slice(0, topLimit),
    total,
    unique,
    windowStart,
    windowEnd: now
  };
}

export function computeContactReasonSummary(
  rows: ConversationRow[],
  window: TimeWindow,
  now: Date = new Date(),
  topLimit = 10
): ContactReasonSummary {
  const windowed = filterByWindow(rows, window, now);
  const total = windowed.length;
  const timeline = buildBucketTimeline(window, now);

  const aggregations = new Map<
    string,
    {
      count: number;
      buckets: Map<string, number>;
      recent: Array<{ issueKey: string; date: Date }>;
    }
  >();

  windowed.forEach((row) => {
    const reasonValue = row.contactReason || row.contactReasonOriginal;
    const reason = reasonValue && reasonValue.trim().length ? reasonValue.trim() : "Unspecified";
    const referenceDate = row.endedAt ?? row.startedAt;
    if (!referenceDate) {
      return;
    }
    const bucketDate = alignToBucketStart(referenceDate, window);
    const bucketLabel = formatBucketKey(bucketDate, window);
    if (!timeline.labels.includes(bucketLabel)) {
      return;
    }

    const bucketMap =
      aggregations.get(reason) ?? {
        count: 0,
        buckets: new Map<string, number>(),
        recent: []
      };

    bucketMap.count += 1;
    bucketMap.buckets.set(bucketLabel, (bucketMap.buckets.get(bucketLabel) ?? 0) + 1);
    bucketMap.recent.push({ issueKey: row.issueKey, date: referenceDate });
    aggregations.set(reason, bucketMap);
  });

  const entries = Array.from(aggregations.entries()).map(([reason, data]) => {
    const sparkline = timeline.labels.map((label) => ({
      label,
      count: data.buckets.get(label) ?? 0
    }));
    const recentIssues = data.recent
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 5)
      .map((item) => item.issueKey);
    const percentage = total > 0 ? (data.count / total) * 100 : 0;
    return {
      reason,
      count: data.count,
      percentage,
      sparkline,
      recentIssues
    };
  });

  entries.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.reason.localeCompare(b.reason);
  });

  return {
    entries: entries.slice(0, topLimit),
    total
  };
}

export function computeTopAgents(
  rows: ConversationRow[],
  now: Date = new Date(),
  limit = 5
): AgentPerformance[] {
  const windowed = filterByWindow(rows, "7d", now);
  const aggregations = new Map<
    string,
    {
      scores: number[];
      issues: Set<string>;
      daily: Map<string, number[]>;
    }
  >();

  windowed.forEach((row) => {
    if (row.totalScore === null || Number.isNaN(row.totalScore)) {
      return;
    }
    const dateKey = formatDateKey(row.endedAt ?? row.startedAt ?? now);
    row.agentList.forEach((agentName) => {
      const key = agentName || "Unassigned";
      const bucket =
        aggregations.get(key) ??
        {
          scores: [],
          issues: new Set<string>(),
          daily: new Map<string, number[]>()
        };
      bucket.scores.push(row.totalScore as number);
      bucket.issues.add(row.issueKey);
      const dayScores = bucket.daily.get(dateKey) ?? [];
      dayScores.push(row.totalScore as number);
      bucket.daily.set(dateKey, dayScores);
      aggregations.set(key, bucket);
    });
  });

  const performances: AgentPerformance[] = Array.from(aggregations.entries()).map(
    ([agent, data]) => ({
      agent,
      meanScore: calculateMean(data.scores),
      sparkline: buildSparkline(data.daily),
      issues: Array.from(data.issues)
    })
  );

  return performances
    .filter((entry) => entry.meanScore !== null)
    .sort((a, b) => (b.meanScore ?? 0) - (a.meanScore ?? 0))
    .slice(0, limit);
}

export function computeToxicCustomers(
  rows: ConversationRow[],
  settings: SettingsState,
  now: Date = new Date(),
  limit = 5
): ToxicityEntry[] {
  const horizon = now.getTime() - FIVE_DAYS_MS;
  const windowed = rows.filter((row) => {
    const reference = row.endedAt ?? row.startedAt;
    return reference ? reference.getTime() >= horizon : false;
  });

  const hasExplicitScore = windowed.some(
    (row) => typeof row.customerToxicityScore === "number" && !Number.isNaN(row.customerToxicityScore)
  );
  const aggregations = new Map<
    string,
    { toxicity: number[]; tickets: Set<string>; messageCount: number }
  >();

  windowed.forEach((row) => {
    const toxicityValue = deriveCustomerToxicity(row, settings, hasExplicitScore);
    if (toxicityValue <= 0) {
      return;
    }
    const messageCount = row.messagesCustomer ?? 0;
    row.customerList.forEach((customer) => {
      const key = customer || "Customer";
      const bucket =
        aggregations.get(key) ??
        {
          toxicity: [],
          tickets: new Set<string>(),
          messageCount: 0
        };
      bucket.toxicity.push(toxicityValue);
      bucket.tickets.add(row.issueKey);
      bucket.messageCount += messageCount;
      aggregations.set(key, bucket);
    });
  });

  const entries: ToxicityEntry[] = Array.from(aggregations.entries()).map(([entity, data]) => ({
    entity,
    meanToxicity: calculateMean(data.toxicity) ?? 0,
    ticketKeys: Array.from(data.tickets),
    messageCount: data.messageCount
  }));

  return entries
    .filter((entry) => entry.meanToxicity > 0)
    .sort((a, b) => b.meanToxicity - a.meanToxicity)
    .slice(0, limit);
}

export function computeFlaggedAgents(
  rows: ConversationRow[],
  settings: SettingsState,
  now: Date = new Date()
): ToxicityEntry[] {
  const windowed = filterByWindow(rows, "7d", now);
  const hasExplicitScore = windowed.some(
    (row) => typeof row.agentToxicityScore === "number" && !Number.isNaN(row.agentToxicityScore)
  );
  const aggregations = new Map<string, { toxicity: number[]; tickets: Set<string> }>();

  windowed.forEach((row) => {
    const toxicityValue = deriveAgentToxicity(row, settings, hasExplicitScore);
    if (toxicityValue <= settings.toxicity_threshold) {
      return;
    }
    row.agentList.forEach((agentName) => {
      const key = agentName || "Unassigned";
      const bucket =
        aggregations.get(key) ??
        {
          toxicity: [],
          tickets: new Set<string>()
        };
      bucket.toxicity.push(toxicityValue);
      bucket.tickets.add(row.issueKey);
      aggregations.set(key, bucket);
    });
  });

  return Array.from(aggregations.entries())
    .map(([entity, data]) => ({
      entity,
      meanToxicity: calculateMean(data.toxicity) ?? 0,
      ticketKeys: Array.from(data.tickets),
      messageCount: data.tickets.size
    }))
    .sort((a, b) => b.meanToxicity - a.meanToxicity);
}

export function computeAgentMatrix(
  rows: ConversationRow[],
  window: TimeWindow,
  now: Date = new Date()
): AgentMatrixRow[] {
  const windowed = filterByWindow(rows, window, now);
  const aggregations = new Map<
    string,
    {
      firstResponseTotal: number;
      firstResponseCount: number;
      avgResponseTotal: number;
      avgResponseCount: number;
      resolvedCount: number;
      totalCount: number;
      escalatedCount: number;
    }
  >();

  windowed.forEach((row) => {
    row.agentList.forEach((agentName) => {
      const key = agentName || "Unassigned";
      const bucket =
        aggregations.get(key) ??
        {
          firstResponseTotal: 0,
          firstResponseCount: 0,
          avgResponseTotal: 0,
          avgResponseCount: 0,
          resolvedCount: 0,
          totalCount: 0,
          escalatedCount: 0
        };

      if (typeof row.firstAgentResponseMinutes === "number") {
        bucket.firstResponseTotal += row.firstAgentResponseMinutes;
        bucket.firstResponseCount += 1;
      }

      if (typeof row.avgAgentResponseMinutes === "number") {
        bucket.avgResponseTotal += row.avgAgentResponseMinutes;
        bucket.avgResponseCount += 1;
      }

      bucket.resolvedCount += row.resolved ? 1 : 0;
      bucket.totalCount += 1;
      bucket.escalatedCount += row.escalated ? 1 : 0;

      aggregations.set(key, bucket);
    });
  });

  return Array.from(aggregations.entries())
    .map(([agent, data]) => ({
      agent,
      avgFirstResponseMinutes:
        data.firstResponseCount > 0 ? data.firstResponseTotal / data.firstResponseCount : null,
      avgAgentResponseMinutes:
        data.avgResponseCount > 0 ? data.avgResponseTotal / data.avgResponseCount : null,
      resolvedRate: data.totalCount > 0 ? data.resolvedCount / data.totalCount : null,
      escalatedCount: data.escalatedCount
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

function deriveCustomerToxicity(
  row: ConversationRow,
  settings: SettingsState,
  hasExplicitScore: boolean
): number {
  if (hasExplicitScore && typeof row.customerToxicityScore === "number") {
    return clamp(row.customerToxicityScore, 0, 1);
  }

  if (row.customerAbusiveFlag) {
    return 1;
  }

  const abusiveCount = row.customerAbuseCount ?? 0;
  if (abusiveCount > 0) {
    return clamp(abusiveCount / Math.max(1, settings.abusive_caps_trigger), 0, 1);
  }

  if (row.customerAbuseDetected) {
    return 0.6;
  }

  return 0;
}

function deriveAgentToxicity(
  row: ConversationRow,
  settings: SettingsState,
  hasExplicitScore: boolean
): number {
  if (hasExplicitScore && typeof row.agentToxicityScore === "number") {
    return clamp(row.agentToxicityScore, 0, 1);
  }

  if (row.agentAbusiveFlag) {
    return 1;
  }

  const profanityCount = row.agentProfanityCount ?? 0;
  const totalMessages = row.messagesAgent ?? 0;
  if (row.agentProfanityDetected && totalMessages > 0) {
    const ratio = profanityCount / Math.max(totalMessages, settings.min_msgs_for_toxicity);
    return clamp(ratio, 0, 1);
  }

  if (row.agentProfanityDetected) {
    return 0.5;
  }

  return 0;
}

function computeBlendedScore(
  agentScore: number | null,
  customerScore: number | null,
  conversationRating: number | null
): number | null {
  const agentIsNumber = typeof agentScore === "number" && !Number.isNaN(agentScore);
  const customerIsNumber = typeof customerScore === "number" && !Number.isNaN(customerScore);

  if (agentIsNumber && customerIsNumber) {
    return ((agentScore as number) + (customerScore as number)) / 2;
  }

  if (xor(agentIsNumber, customerIsNumber)) {
    return agentIsNumber ? (agentScore as number) : (customerScore as number);
  }

  if (conversationRating !== null && !Number.isNaN(conversationRating)) {
    return conversationRating;
  }

  return null;
}

function xor(a: boolean, b: boolean): boolean {
  return (a || b) && !(a && b);
}

type Timeline = {
  labels: string[];
  dates: Date[];
};

function buildBucketTimeline(window: TimeWindow, now: Date): Timeline {
  const bucketDuration = window === "24h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const bucketCount = window === "24h" ? 24 : window === "7d" ? 7 : 30;
  const endAligned = alignToBucketStart(now, window);
  const labels: string[] = [];
  const dates: Date[] = [];

  for (let i = bucketCount - 1; i >= 0; i -= 1) {
    const bucketDate = new Date(endAligned.getTime() - bucketDuration * i);
    const aligned = alignToBucketStart(bucketDate, window);
    labels.push(formatBucketKey(aligned, window));
    dates.push(aligned);
  }

  return { labels, dates };
}

function alignToBucketStart(date: Date, window: TimeWindow): Date {
  const copy = new Date(date);
  if (window === "24h") {
    copy.setMinutes(0, 0, 0);
  } else {
    copy.setHours(0, 0, 0, 0);
  }
  return copy;
}

function formatBucketKey(date: Date, window: TimeWindow): string {
  if (window === "24h") {
    return `${date.toISOString().slice(0, 13)}:00`;
  }
  return date.toISOString().slice(0, 10);
}

function calculateMean(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  const total = values.reduce((acc, value) => acc + value, 0);
  return total / values.length;
}

function buildSparkline(daily: Map<string, number[]>): AgentPerformancePoint[] {
  return Array.from(daily.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, scores]) => ({
      date,
      meanScore: calculateMean(scores)
    }));
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["true", "yes", "y", "1"].includes(normalized);
  }
  return false;
}

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function asDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function normaliseList(value: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(CLEAN_SPLIT_REGEX)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatDateKey(date: Date): string {
  return date.toISOString().split("T")[0]!;
}
