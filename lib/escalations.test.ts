import { describe, expect, it } from "vitest";

import { getEscalationDetails, isEscalated } from "@/lib/escalations";
import { normaliseRow } from "@/lib/metrics";
import type { AgentRole } from "@/types";

const ROLE_MAPPING: Record<string, AgentRole> = {
  "agent:t1:primary": "TIER1",
  "agent:t1:secondary": "TIER1",
  "agent:t2:primary": "TIER2",
  "agent:non:user": "NON_AGENT"
};

function makeRow(agentAuthors: string) {
  return normaliseRow({
    issue_key: "TEST-1",
    agent_authors: agentAuthors,
    customer_authors: "customer"
  });
}

describe("escalation logic", () => {
  it("treats Tier 1 only handoffs as non escalated in new logic", () => {
    const row = makeRow("agent:t1:primary;agent:t1:secondary");
    const details = getEscalationDetails(row, ROLE_MAPPING);
    expect(details.legacy).toBe(true);
    expect(details.handoffAny).toBe(true);
    expect(details.tierHandoff).toBe(false);
    expect(details.path).toBe("T1→T1");
    expect(details.owner).toBe("agent:t1:primary");
    expect(isEscalated(row, ROLE_MAPPING, "handoff")).toBe(true);
    expect(isEscalated(row, ROLE_MAPPING, "tier")).toBe(false);
  });

  it("detects Tier 1 to Tier 2 escalation", () => {
    const row = makeRow("agent:t1:primary;agent:t2:primary");
    const details = getEscalationDetails(row, ROLE_MAPPING);
    expect(details.legacy).toBe(true);
    expect(details.handoffAny).toBe(true);
    expect(details.tierHandoff).toBe(true);
    expect(details.path).toBe("T1→T2");
    expect(details.owner).toBe("agent:t1:primary");
    expect(isEscalated(row, ROLE_MAPPING, "tier")).toBe(true);
    expect(isEscalated(row, ROLE_MAPPING, "handoff")).toBe(true);
  });

  it("ignores Tier 2 only conversations", () => {
    const row = makeRow("agent:t2:primary");
    const details = getEscalationDetails(row, ROLE_MAPPING);
    expect(details.legacy).toBe(false);
    expect(details.handoffAny).toBe(false);
    expect(details.tierHandoff).toBe(false);
    expect(details.path).toBe("");
    expect(details.owner).toBeNull();
  });

  it("records Tier 1 to non user transitions without counting them", () => {
    const row = makeRow("agent:t1:primary;agent:non:user");
    const details = getEscalationDetails(row, ROLE_MAPPING);
    expect(details.legacy).toBe(true);
    expect(details.handoffAny).toBe(true);
    expect(details.tierHandoff).toBe(false);
    expect(details.path).toBe("T1→NON_USER");
    expect(details.owner).toBe("agent:t1:primary");
    expect(isEscalated(row, ROLE_MAPPING, "handoff")).toBe(true);
  });

  it("handles customer-only conversations", () => {
    const row = makeRow("");
    const details = getEscalationDetails(row, ROLE_MAPPING);
    expect(details.legacy).toBe(false);
    expect(details.handoffAny).toBe(false);
    expect(details.tierHandoff).toBe(false);
    expect(details.path).toBe("");
    expect(details.owner).toBeNull();
  });
});
