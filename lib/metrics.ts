import {
  AgentRole,
  AgentMatrixRow,
  AgentPerformance,
  AgentPerformancePoint,
  ContactReasonSummary,
  ConversationRow,
  EscalationMetricKind,
  EscalationSeriesEntry,
  ImprovementTipSummary,
  MetricSeries,
  SentimentLabel,
  SentimentScores,
  SettingsState,
  TimeWindow,
  ToxicityEntry
} from "@/types";
import { getEscalationDetails, isEscalated } from "@/lib/escalations";
import { resolveAgentRole } from "@/lib/roles";

const TIME_WINDOW_DURATIONS: Record<TimeWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_DAYS_MS = 5 * DAY_MS;
const SWEAR_NORMALIZER = 5; // roughly five explicit hits per abusive ticket maxes the swear factor

type PrimitiveRecord = Record<string, string | number | boolean | null | undefined>;

const CLEAN_SPLIT_REGEX = /[;,|]/;
const STEP_SPLIT_REGEX = /\|\|/;
const MAX_STEP_ITEMS = 8;
const SENTIMENT_LABELS: SentimentLabel[] = [
  "Delight",
  "Convenience",
  "Trust",
  "Frustration",
  "Disappointment",
  "Concern",
  "Hostility",
  "Neutral"
];

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
  const contactReasonChangeFlag = asBoolean(raw.contact_reason_change);
  const normalizedOriginal = normalizeReasonLabel(contactReasonOriginal);
  const normalizedCorrected = normalizeReasonLabel(contactReason);
  const hasReasonDiff =
    Boolean(normalizedOriginal) &&
    Boolean(normalizedCorrected) &&
    normalizedOriginal !== normalizedCorrected;
  let contactReasonChange = contactReasonChangeFlag;
  if (hasReasonDiff) {
    contactReasonChange = true;
  } else if (normalizedOriginal && normalizedCorrected && normalizedOriginal === normalizedCorrected) {
    contactReasonChange = false;
  }
  const reasonOverrideRaw =
    asString(raw.reason_override_why) ||
    asString(raw.contact_reason_change_justification) ||
    asString(raw.llm_conatct_reason_change);
  const reasonOverrideWhy = reasonOverrideRaw ? reasonOverrideRaw : null;

  const problemExtractRaw = asString(raw.problem_extract ?? raw.extract_customer_problem);
  const problemExtract = problemExtractRaw ? problemExtractRaw : null;
  const resolutionExtractRaw = asString(raw.resolution_extract);
  const resolutionExtract = resolutionExtractRaw ? resolutionExtractRaw : null;
  const resolutionWhyRaw = asString(raw.resolution_why);
  const resolutionWhy = resolutionWhyRaw ? resolutionWhyRaw : null;
  const stepsExtract = parseSteps(raw.steps_extract);

  const resolutionTimestampIsoRaw = asString(raw.resolution_timestamp_iso);
  const resolutionTimestampIso = resolutionTimestampIsoRaw || null;
  const resolutionTimestamp = resolutionTimestampIso ? asDate(resolutionTimestampIso) : null;
  const resolutionMessageIndexNumber = asNumber(raw.resolution_message_index);
  const resolutionMessageIndex =
    resolutionMessageIndexNumber === null ? null : Math.max(1, Math.round(resolutionMessageIndexNumber));

  const sentimentScores = parseSentimentScores(raw.customer_sentiment_scores);
  const sentimentPrimary = resolveSentimentPrimary(asString(raw.customer_sentiment_primary), sentimentScores);
  const contactReasonV2 = asString(raw.contact_reason_v2);
  const contactReasonV2Topic = asString(raw.contact_reason_v2_topic);
  const contactReasonV2Sub = asString(raw.contact_reason_v2_sub);
  const contactReasonV2ReasonId = asString(raw.contact_reason_v2_reason_id);

  const statusString = asString(raw.status);
  const resolved = asBoolean(
    raw.is_resolved ??
      raw.resolved ??
      (statusString
        ? ["done", "resolved", "closed"].includes(statusString.toLowerCase())
        : false)
  );
  const agent = agentList[0] ?? asString(raw.agent) ?? "Unassigned";
  const durationMinutes = asNumber(raw.duration_minutes);
  const durationToResolutionMinutes = asNumber(raw.duration_to_resolution);

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
    durationToResolutionMinutes,
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
    contactReasonV2,
    contactReasonV2Topic,
    contactReasonV2Sub,
    contactReasonV2ReasonId,
    contactReasonOriginal,
    contactReasonChange,
    reasonOverrideWhy,
    resolutionWhy,
    problemExtract,
    resolutionExtract,
    stepsExtract,
    resolutionTimestampIso,
    resolutionTimestamp,
    resolutionMessageIndex,
    customerSentimentPrimary: sentimentPrimary,
    customerSentimentScores: sentimentScores,
    hub: (raw.custom_field_hub as string) ?? (raw.hub as string) ?? null,
    model: (raw.llm_model as string) ?? (raw.model as string) ?? null,
    agentToxicityScore: asNumber(raw.agent_toxicity_score),
    agentAbusiveFlag: asBoolean(raw.agent_abusive_flag),
    customerToxicityScore: asNumber(raw.customer_toxicity_score),
    customerAbusiveFlag: asBoolean(raw.customer_abusive_flag),
    escalated,
    raw: {
      extract_customer_problem: problemExtractRaw,
      contact_reason: contactReason,
      contact_reason_original: contactReasonOriginal
    }
  };
}

export function normaliseRows(rows: PrimitiveRecord[]): ConversationRow[] {
  return rows.map(normaliseRow);
}

function aggregateContactReasonV2(rows: ConversationRow[]): ContactReasonV2Summary {
  const total = rows.length;
  const topicMap: Map<string, { count: number; subs: Map<string, number> }> = new Map();
  rows.forEach((row) => {
    const topic = row.contactReasonV2Topic || row.contactReasonV2 || null;
    if (!topic) return;
    const sub = row.contactReasonV2Sub || null;
    if (!topicMap.has(topic)) {
      topicMap.set(topic, { count: 0, subs: new Map() });
    }
    const entry = topicMap.get(topic)!;
    entry.count += 1;
    const subKey = sub || "None";
    entry.subs.set(subKey, (entry.subs.get(subKey) || 0) + 1);
  });

  const entries: ContactReasonV2Entry[] = Array.from(topicMap.entries())
    .map(([topic, value]) => {
      const subs = Array.from(value.subs.entries())
        .map(([sub, count]) => ({
          sub: sub === "None" ? null : sub,
          count,
          percentage: total ? (count / total) * 100 : 0
        }))
        .sort((a, b) => b.count - a.count);
      return {
        topic,
        count: value.count,
        percentage: total ? (value.count / total) * 100 : 0,
        subs
      };
    })
    .sort((a, b) => b.count - a.count);

  return {
    total,
    entries
  };
}

function aggregateContactReasonV2FromRows(rows: ConversationRow[]): ContactReasonV2Summary {
  return aggregateContactReasonV2(rows);
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

export function buildEscalationSeries(
  rows: ConversationRow[],
  roleMapping: Record<string, AgentRole>,
  now: Date = new Date()
): EscalationSeriesEntry[] {
  return (Object.keys(TIME_WINDOW_DURATIONS) as TimeWindow[]).map((window) => {
    const windowed = filterByWindow(rows, window, now);
    const tierCount = windowed.filter((row) => isEscalated(row, roleMapping, "tier")).length;
    const handoffCount = windowed.filter((row) => isEscalated(row, roleMapping, "handoff")).length;
    return {
      window,
      tierCount,
      handoffCount,
      total: windowed.length
    };
  });
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

export function computeAverageDurationToResolution(rows: ConversationRow[]): number | null {
  const values = rows
    .map((row) => row.durationToResolutionMinutes)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (!values.length) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
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

export function computeEscalatedCount(
  rows: ConversationRow[],
  roleMapping: Record<string, AgentRole>,
  metric: EscalationMetricKind = "tier"
): number {
  return rows.filter((row) => isEscalated(row, roleMapping, metric)).length;
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

export function computeContactReasonV2Summary(
  rows: ConversationRow[],
  window: TimeWindow,
  now: Date = new Date(),
  topLimit = 10
): ContactReasonV2Summary {
  const windowed = filterByWindow(rows, window, now);
  const aggregated = aggregateContactReasonV2FromRows(windowed);

  // Previous window of the same length (shifted back one window).
  const duration = TIME_WINDOW_DURATIONS[window];
  const prevNow = new Date(now.getTime() - duration);
  const prevWindowed = filterByWindow(rows, window, prevNow);
  const prevAggregated = aggregateContactReasonV2FromRows(prevWindowed);
  const prevMap = new Map<string, { count: number; percentage: number; subs: ContactReasonV2SubSummary[] }>(
    prevAggregated.entries.map((entry) => [entry.topic, { count: entry.count, percentage: entry.percentage, subs: entry.subs }])
  );

  const entriesWithTrend = aggregated.entries.slice(0, topLimit).map((entry) => {
    const prev = prevMap.get(entry.topic);
    const prevCount = prev?.count ?? 0;
    const deltaCount = entry.count - prevCount;
    const deltaPercentage = entry.percentage - (prev?.percentage ?? 0);
    const prevSubs = new Map<string, { count: number; percentage: number }>();
    if (prev?.subs) {
      prev.subs.forEach((sub) => {
        prevSubs.set(sub.sub ?? "None", { count: sub.count, percentage: sub.percentage });
      });
    }
    const subsWithTrend = entry.subs.map((sub) => {
      const prevSub = prevSubs.get(sub.sub ?? "None");
      const prevSubCount = prevSub?.count ?? 0;
      const deltaSubCount = sub.count - prevSubCount;
      const deltaSubPercentage = sub.percentage - (prevSub?.percentage ?? 0);
      return { ...sub, prevCount: prevSubCount, deltaCount: deltaSubCount, deltaPercentage: deltaSubPercentage };
    });
    return { ...entry, prevCount, deltaCount, deltaPercentage, subs: subsWithTrend };
  });

  return {
    total: aggregated.total,
    entries: entriesWithTrend
  };
}

export function computeTopAgents(
  rows: ConversationRow[],
  roleMapping: Record<string, AgentRole>,
  now: Date = new Date(),
  options?: { limit?: number; roleFilter?: AgentRole | "All" }
): AgentPerformance[] {
  const windowed = filterByWindow(rows, "7d", now);
  const limit = options?.limit ?? 5;
  const roleFilter = options?.roleFilter ?? "All";
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
      const agentRole = resolveAgentRole(agentName, roleMapping);
      if (roleFilter !== "All" && agentRole !== roleFilter) {
        return;
      }
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
  options?: {
    limit?: number;
    window?: TimeWindow;
  }
): ToxicityEntry[] {
  const limit = options?.limit ?? 5;
  const windowed = options?.window
    ? filterByWindow(rows, options.window, now)
    : rows.filter((row) => {
        const reference = row.endedAt ?? row.startedAt;
        return reference ? reference.getTime() >= now.getTime() - FIVE_DAYS_MS : false;
      });

  const hasExplicitScore = windowed.some(
    (row) => typeof row.customerToxicityScore === "number" && !Number.isNaN(row.customerToxicityScore)
  );
  const aggregations = new Map<
    string,
    {
      tickets: Set<string>;
      messageCount: number;
      totalTickets: number;
      abusiveTickets: number;
      swearCount: number;
      customerScoreTotal: number;
      customerScoreCount: number;
      abusiveTicketKeys: Set<string>;
    }
  >();

  windowed.forEach((row) => {
    const toxicityValue = deriveCustomerToxicity(row, settings, hasExplicitScore);
    const messageCount = row.messagesCustomer ?? 0;
    const isAbusive =
      row.customerAbusiveFlag ||
      row.customerAbuseDetected ||
      (typeof row.customerAbuseCount === "number" && row.customerAbuseCount > 0);
    const abuseHits =
      typeof row.customerAbuseCount === "number" && row.customerAbuseCount > 0
        ? row.customerAbuseCount
        : isAbusive
        ? 1
        : 0;

    row.customerList.forEach((customer) => {
      const key = customer || "Customer";
      const bucket =
        aggregations.get(key) ??
        {
          tickets: new Set<string>(),
          messageCount: 0,
          totalTickets: 0,
          abusiveTickets: 0,
          swearCount: 0,
          customerScoreTotal: 0,
          customerScoreCount: 0,
          abusiveTicketKeys: new Set<string>()
        };
      bucket.tickets.add(row.issueKey);
      bucket.messageCount += messageCount;
      bucket.totalTickets += 1;
      if (isAbusive) {
        bucket.abusiveTickets += 1;
        bucket.swearCount += abuseHits;
        bucket.abusiveTicketKeys.add(row.issueKey);
      }
      if (typeof row.customerScore === "number" && !Number.isNaN(row.customerScore)) {
        bucket.customerScoreTotal += row.customerScore;
        bucket.customerScoreCount += 1;
      }
      aggregations.set(key, bucket);
    });
  });

  const entries: ToxicityEntry[] = Array.from(aggregations.entries()).map(([entity, data]) => {
    const meanToxicity = data.swearCount * data.abusiveTickets;
    const averageCustomerScore =
      data.customerScoreCount > 0 ? data.customerScoreTotal / data.customerScoreCount : null;
    return {
      entity,
      meanToxicity,
      ticketKeys: Array.from(data.tickets),
      messageCount: data.messageCount,
      abusiveTicketCount: data.abusiveTickets,
      totalTicketCount: data.totalTickets,
      swearCount: data.swearCount,
      averageCustomerScore,
      abusiveTicketKeys: Array.from(data.abusiveTicketKeys)
    };
  });

  return entries
    .filter((entry) => entry.abusiveTicketCount > 0)
    .sort((a, b) => b.meanToxicity - a.meanToxicity)
    .slice(0, limit);
}

export function computeFlaggedAgents(
  rows: ConversationRow[],
  settings: SettingsState,
  now: Date = new Date(),
  options?: { window?: TimeWindow }
): ToxicityEntry[] {
  const windowed = options?.window ? filterByWindow(rows, options.window, now) : filterByWindow(rows, "7d", now);
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
      messageCount: data.tickets.size,
      abusiveTicketCount: data.tickets.size,
      totalTicketCount: data.tickets.size,
      swearCount: 0,
      averageCustomerScore: null,
      abusiveTicketKeys: Array.from(data.tickets)
    }))
    .sort((a, b) => b.meanToxicity - a.meanToxicity);
}

export function computeAgentMatrix(
  rows: ConversationRow[],
  window: TimeWindow,
  now: Date = new Date(),
  options?: {
    roleMapping?: Record<string, AgentRole>;
    escalationMetric?: EscalationMetricKind;
    roleFilter?: AgentRole | "All";
  }
): AgentMatrixRow[] {
  const roleMapping = options?.roleMapping ?? {};
  const escalationMetric = options?.escalationMetric ?? "handoff";
  const roleFilter = options?.roleFilter ?? "All";
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
      resolutionDurationTotal: number;
      resolutionDurationCount: number;
      misclassifiedCount: number;
      agentScoreTotal: number;
      agentScoreCount: number;
    }
  >();

  windowed.forEach((row) => {
    const escalationDetails = getEscalationDetails(row, roleMapping);
    const qualifies =
      escalationMetric === "tier" ? escalationDetails.tierHandoff : escalationDetails.handoffAny;
    const owner = escalationDetails.owner;

    row.agentList.forEach((agentName) => {
      const agentRole = resolveAgentRole(agentName, roleMapping);
      if (roleFilter !== "All" && agentRole !== roleFilter) {
        return;
      }
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
          escalatedCount: 0,
          resolutionDurationTotal: 0,
          resolutionDurationCount: 0,
          misclassifiedCount: 0,
          agentScoreTotal: 0,
          agentScoreCount: 0
        };

      if (typeof row.firstAgentResponseMinutes === "number") {
        bucket.firstResponseTotal += row.firstAgentResponseMinutes;
        bucket.firstResponseCount += 1;
      }

      if (typeof row.avgAgentResponseMinutes === "number") {
        bucket.avgResponseTotal += row.avgAgentResponseMinutes;
        bucket.avgResponseCount += 1;
      }

      if (typeof row.durationToResolutionMinutes === "number") {
        bucket.resolutionDurationTotal += row.durationToResolutionMinutes;
        bucket.resolutionDurationCount += 1;
      }

      bucket.resolvedCount += row.resolved ? 1 : 0;
      bucket.totalCount += 1;
      if (typeof row.agentScore === "number" && !Number.isNaN(row.agentScore)) {
        bucket.agentScoreTotal += row.agentScore;
        bucket.agentScoreCount += 1;
      }
      if (qualifies && owner && agentName === owner) {
        bucket.escalatedCount += 1;
      }
      if (row.contactReasonChange && owner && agentName === owner) {
        bucket.misclassifiedCount += 1;
      }

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
      avgResolutionDurationMinutes:
        data.resolutionDurationCount > 0
          ? data.resolutionDurationTotal / data.resolutionDurationCount
          : null,
      resolvedRate: data.totalCount > 0 ? data.resolvedCount / data.totalCount : null,
      avgAgentScore:
        data.agentScoreCount > 0 ? data.agentScoreTotal / data.agentScoreCount : null,
      escalatedCount: data.escalatedCount,
      misclassifiedCount: data.misclassifiedCount,
      misclassifiedPercent:
        data.totalCount > 0 ? data.misclassifiedCount / data.totalCount : null,
      ticketCount: data.totalCount
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

function parseSteps(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => asString(entry)).filter(Boolean).slice(0, MAX_STEP_ITEMS);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return [];
    }
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => asString(entry)).filter(Boolean).slice(0, MAX_STEP_ITEMS);
      }
    } catch {
      // ignore JSON parse errors and fall back to delimiter split
    }
    return text.split(STEP_SPLIT_REGEX).map((entry) => entry.trim()).filter(Boolean).slice(0, MAX_STEP_ITEMS);
  }
  return [];
}

function parseSentimentScores(value: unknown): SentimentScores | null {
  if (!value) {
    return null;
  }
  let parsed: Record<string, unknown> | null = null;
  if (typeof value === "string" && value.trim()) {
    try {
      const loaded = JSON.parse(value);
      if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
        parsed = loaded as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    parsed = value as Record<string, unknown>;
  }
  if (!parsed) {
    return null;
  }
  const bucketValues: Record<SentimentLabel, number> = {
    Delight: 0,
    Convenience: 0,
    Trust: 0,
    Frustration: 0,
    Disappointment: 0,
    Concern: 0,
    Hostility: 0,
    Neutral: 0
  };
  let total = 0;
  SENTIMENT_LABELS.forEach((label) => {
    const normalizedKey = label.toLowerCase();
    const snakeKey = label.replace(" ", "_").toLowerCase();
    const candidate = parsed[label] ?? parsed[normalizedKey] ?? parsed[snakeKey];
    const numeric = typeof candidate === "number" ? candidate : Number(candidate ?? 0);
    const safe = Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
    bucketValues[label] = safe;
    total += safe;
  });
  if (total <= 0) {
    return null;
  }
  const normalized: SentimentScores = {
    Delight: 0,
    Convenience: 0,
    Trust: 0,
    Frustration: 0,
    Disappointment: 0,
    Concern: 0,
    Hostility: 0,
    Neutral: 0
  };
  SENTIMENT_LABELS.forEach((label) => {
    normalized[label] = bucketValues[label] / total;
  });
  return normalized;
}

function resolveSentimentPrimary(
  value: string,
  scores: SentimentScores | null
): SentimentLabel | null {
  if (value && isSentimentLabel(value)) {
    return value;
  }
  if (!scores) {
    return null;
  }
  return SENTIMENT_LABELS.reduce<SentimentLabel>((best, label) => {
    if (scores[label] > scores[best]) {
      return label;
    }
    return best;
  }, SENTIMENT_LABELS[0]);
}

function isSentimentLabel(value: string): value is SentimentLabel {
  if (!value) {
    return false;
  }
  return SENTIMENT_LABELS.includes(value as SentimentLabel);
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

function normalizeReasonLabel(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.trim().toLowerCase();
}

function formatDateKey(date: Date): string {
  return date.toISOString().split("T")[0]!;
}
