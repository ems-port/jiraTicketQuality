import {
  buildMetricSeries,
  buildResolvedSeries,
  computeAgentMatrix,
  computeAverageConversationRating,
  computeContactReasonSummary,
  computeEscalatedCount,
  computeFlaggedAgents,
  computeImprovementTips,
  computeResolvedCount,
  computeResolvedStats,
  computeTopAgents,
  computeToxicCustomers,
  filterByWindow,
  normaliseRow
} from "@/lib/metrics";
import type { ConversationRow, SettingsState } from "@/types";

const NOW = new Date("2024-04-10T12:00:00.000Z");

const settings: SettingsState = {
  toxicity_threshold: 0.8,
  abusive_caps_trigger: 5,
  min_msgs_for_toxicity: 3
};

function makeRow(overrides: Partial<ConversationRow>): ConversationRow {
  return {
    issueKey: overrides.issueKey ?? "TEST-1",
    agent: overrides.agent ?? "Agent Alpha",
    agentList: overrides.agentList ?? [overrides.agent ?? "Agent Alpha"],
    customerList: overrides.customerList ?? ["Customer Z"],
    resolved: overrides.resolved ?? false,
    startedAt: overrides.startedAt ?? NOW,
    endedAt: overrides.endedAt ?? NOW,
    durationMinutes: overrides.durationMinutes ?? 30,
    firstAgentResponseMinutes: overrides.firstAgentResponseMinutes ?? 5,
    avgAgentResponseMinutes: overrides.avgAgentResponseMinutes ?? 15,
    messagesTotal: overrides.messagesTotal ?? 6,
    messagesAgent: overrides.messagesAgent ?? 3,
    messagesCustomer: overrides.messagesCustomer ?? 3,
    customerAbuseCount: overrides.customerAbuseCount ?? 0,
    customerAbuseDetected: overrides.customerAbuseDetected ?? false,
    agentProfanityDetected: overrides.agentProfanityDetected ?? false,
    agentProfanityCount: overrides.agentProfanityCount ?? 0,
    agentScore: overrides.agentScore ?? 4,
    customerScore: overrides.customerScore ?? 4,
    conversationRating: overrides.conversationRating ?? 4,
    totalScore: overrides.totalScore ?? 4,
    improvementTip: overrides.improvementTip ?? "Offer proactive updates",
    ticketSummary: overrides.ticketSummary ?? "Ticket summary placeholder",
    contactReason: overrides.contactReason ?? "Billing",
    contactReasonOriginal: overrides.contactReasonOriginal ?? "Billing",
    hub: overrides.hub ?? "Hub A",
    model: overrides.model ?? "gpt-4o",
    agentToxicityScore: overrides.agentToxicityScore ?? null,
    agentAbusiveFlag: overrides.agentAbusiveFlag ?? false,
    customerToxicityScore: overrides.customerToxicityScore ?? null,
    customerAbusiveFlag: overrides.customerAbusiveFlag ?? false,
    escalated: overrides.escalated ?? false,
    raw: overrides.raw ?? {}
  };
}

describe("normaliseRow", () => {
  it("splits authors, resolves booleans, and detects escalations", () => {
    const row = normaliseRow({
      issue_key: "ABC-1",
      agent_authors: "Agent One;Agent Two",
      customer_authors: "User A",
      resolved: "true",
      conversation_start: "2024-04-09T10:00:00Z",
      conversation_end: "2024-04-09T11:00:00Z",
      agent_score: "4.5",
      customer_score: "3.5",
      customer_abuse_detected: "yes",
      agent_profanity_detected: "no",
      messages_agent: "5",
      messages_customer: "7"
    });

    expect(row.agentList).toEqual(["Agent One", "Agent Two"]);
    expect(row.customerList).toEqual(["User A"]);
    expect(row.resolved).toBe(true);
    expect(row.escalated).toBe(true);
    expect(row.totalScore).toBeCloseTo(4);
    expect(row.messagesAgent).toBe(5);
    expect(row.messagesCustomer).toBe(7);
    expect(row.startedAt?.toISOString()).toBe("2024-04-09T10:00:00.000Z");
  });
});

describe("time window helpers", () => {
  const recentRow = makeRow({
    issueKey: "RECENT",
    endedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000)
  });
  const weekRow = makeRow({
    issueKey: "WEEK",
    endedAt: new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000)
  });
  const monthRow = makeRow({
    issueKey: "MONTH",
    endedAt: new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000)
  });

  const rows = [recentRow, weekRow, monthRow];

  it("filters rows by the requested window", () => {
    expect(filterByWindow(rows, "24h", NOW)).toEqual([recentRow]);
    expect(filterByWindow(rows, "7d", NOW)).toEqual([recentRow, weekRow]);
    expect(filterByWindow(rows, "30d", NOW)).toHaveLength(3);
  });

  it("builds metric series for each window", () => {
    const series = buildMetricSeries(rows, computeAverageConversationRating, NOW);
    expect(series).toHaveLength(3);
    expect(series[0]?.window).toBe("24h");
  });
});

describe("headline metrics", () => {
  const rows = [
    makeRow({ totalScore: 4, resolved: true }),
    makeRow({ totalScore: 2, resolved: false, escalated: true })
  ];

  it("calculates conversation score", () => {
    const value = computeAverageConversationRating(rows);
    expect(value).toBeCloseTo(3);
  });

  it("counts resolved and escalated conversations", () => {
    expect(computeResolvedCount(rows)).toBe(1);
    expect(computeEscalatedCount(rows)).toBe(1);
  });

  it("computes resolved stats and series with percentages", () => {
    const stats = computeResolvedStats(rows);
    expect(stats.count).toBe(1);
    expect(stats.total).toBe(2);
    expect(stats.percentage).toBeCloseTo(50);

    const series = buildResolvedSeries(rows, NOW);
    expect(series).toHaveLength(3);
    expect(series[0]?.value).toBeCloseTo(50);
    expect(series[0]?.count).toBe(1);
    expect(series[0]?.total).toBe(2);
  });
});

describe("computeTopAgents", () => {
  const rows = [
    makeRow({
      issueKey: "T-1",
      agentList: ["Agent A"],
      totalScore: 4.8,
      endedAt: new Date(NOW.getTime() - DAY_MS / 2)
    }),
    makeRow({
      issueKey: "T-2",
      agentList: ["Agent B"],
      totalScore: 3.2,
      endedAt: new Date(NOW.getTime() - DAY_MS)
    }),
    makeRow({
      issueKey: "T-3",
      agentList: ["Agent A"],
      totalScore: 4.4,
      endedAt: new Date(NOW.getTime() - 2 * DAY_MS)
    })
  ];

  it("ranks agents by mean score over the last 7 days", () => {
    const performances = computeTopAgents(rows, NOW, 5);
    expect(performances[0]?.agent).toBe("Agent A");
    expect(performances[0]?.meanScore).toBeCloseTo(4.6);
    expect(performances[0]?.sparkline.length).toBeGreaterThan(0);
  });
});

describe("toxicity detection", () => {
  const rows = [
    makeRow({
      issueKey: "A-1",
      customerList: ["Customer A"],
      customerAbuseCount: 4,
      customerAbuseDetected: true,
      messagesCustomer: 6,
      endedAt: new Date(NOW.getTime() - DAY_MS)
    }),
    makeRow({
      issueKey: "A-2",
      customerList: ["Customer B"],
      customerToxicityScore: 0.9,
      messagesCustomer: 3,
      endedAt: new Date(NOW.getTime() - 2 * DAY_MS)
    })
  ];

  it("returns most abusive customers using available signals", () => {
    const results = computeToxicCustomers(rows, settings, NOW, 5);
    expect(results).toHaveLength(2);
    expect(results[0]?.entity).toBe("Customer B");
    expect(results[0]?.meanToxicity).toBeGreaterThan(0.8);
  });

  it("flags abusive agents above the toxicity threshold", () => {
    const agentRows = [
      makeRow({
        issueKey: "AG-1",
        agentList: ["Agent Z"],
        agentToxicityScore: 0.9,
        endedAt: new Date(NOW.getTime() - DAY_MS)
      }),
      makeRow({
        issueKey: "AG-2",
        agentList: ["Agent Clean"],
        agentProfanityDetected: true,
        agentProfanityCount: 1,
        messagesAgent: 10,
        endedAt: new Date(NOW.getTime() - DAY_MS)
      })
    ];

    const flagged = computeFlaggedAgents(agentRows, settings, NOW);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.entity).toBe("Agent Z");
  });
});

describe("computeAgentMatrix", () => {
  const rows = [
    makeRow({
      issueKey: "M-1",
      agentList: ["Agent Matrix"],
      firstAgentResponseMinutes: 10,
      avgAgentResponseMinutes: 20,
      resolved: true,
      escalated: false
    }),
    makeRow({
      issueKey: "M-2",
      agentList: ["Agent Matrix", "Agent Assist"],
      firstAgentResponseMinutes: 5,
      avgAgentResponseMinutes: 15,
      resolved: false,
      escalated: true
    })
  ];

  it("aggregates agent performance metrics per time window", () => {
    const matrix = computeAgentMatrix(rows, "30d", NOW);
    const agentRow = matrix.find((entry) => entry.agent === "Agent Matrix");
    expect(agentRow?.avgFirstResponseMinutes).toBeCloseTo(7.5);
    expect(agentRow?.resolvedRate).toBeCloseTo(0.5);
    expect(agentRow?.escalatedCount).toBe(1);
  });
});

describe("computeImprovementTips", () => {
  const now = NOW;
  const rows = [
    makeRow({
      issueKey: "TIP-1",
      improvementTip: "Share troubleshooting checklist sooner",
      startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      endedAt: new Date(now.getTime() - 90 * 60 * 1000),
      agent: "Agent Alpha"
    }),
    makeRow({
      issueKey: "TIP-2",
      improvementTip: "Share troubleshooting checklist sooner",
      startedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
      endedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      agent: "Agent Beta"
    }),
    makeRow({
      issueKey: "TIP-3",
      improvementTip: "Confirm resolution path with customer",
      startedAt: new Date(now.getTime() - 20 * 60 * 60 * 1000),
      endedAt: new Date(now.getTime() - 19 * 60 * 60 * 1000),
      agent: "Agent Alpha"
    }),
    makeRow({
      issueKey: "TIP-OLD",
      improvementTip: "This should be ignored outside window",
      startedAt: new Date(now.getTime() - 2 * DAY_MS),
      endedAt: new Date(now.getTime() - 2 * DAY_MS)
    })
  ];

  it("aggregates tips from the last 24 hours", () => {
    const summary = computeImprovementTips(rows, now, 2);
    expect(summary.total).toBe(3);
    expect(summary.unique).toBe(2);
    expect(summary.entries[0]?.tip).toBe("Share troubleshooting checklist sooner");
    expect(summary.entries[0]?.count).toBe(2);
    expect(summary.entries[0]?.issueKeys).toEqual(expect.arrayContaining(["TIP-1", "TIP-2"]));
    expect(summary.topEntries).toHaveLength(2);
  });
});

describe("computeContactReasonSummary", () => {
  const now = NOW;
  const rows = [
    makeRow({
      issueKey: "CR-1",
      contactReason: "Billing",
      endedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000)
    }),
    makeRow({
      issueKey: "CR-2",
      contactReason: "Billing",
      endedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000)
    }),
    makeRow({
      issueKey: "CR-3",
      contactReason: "Technical",
      endedAt: new Date(now.getTime() - 5 * 60 * 60 * 1000)
    }),
    makeRow({
      issueKey: "CR-OLD",
      contactReason: "Billing",
      endedAt: new Date(now.getTime() - 3 * DAY_MS)
    })
  ];

  it("aggregates contact reasons within the selected window", () => {
    const summary = computeContactReasonSummary(rows, "24h", now, 10);
    expect(summary.total).toBe(3);
    expect(summary.entries[0]?.reason).toBe("Billing");
    expect(summary.entries[0]?.count).toBe(2);
    expect(summary.entries[0]?.sparkline.length).toBe(24);
    expect(summary.entries[0]?.recentIssues).toEqual(expect.arrayContaining(["CR-1", "CR-2"]));
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
