
export type PromptConfigType = (typeof PROJECT_PROMPT_TYPES)[number];

export const DEFAULT_PROJECT_CONFIG: Record<PromptConfigType, string> = {
  system_prompt: `You are a meticulous quality assurance analyst who responds in JSON. Conversation transcript lines use 'A:' for agent and 'C:' for customer to optimise tokens.`,
  prompt_header: `Review the conversation above and respond with a SINGLE JSON object that satisfies the schema below.`,
  prompt_json_schema: `Strict JSON schema (all fields required, nulls allowed only when noted):
{
  "llm_summary_250": string (<=150 chars),
  "conversation_rating": integer (1-5),
  "extract_customer_probelm": string (mirror of problem_extract),
  "problem_extract": string (<=150 chars),
  "resolution_extract": string (<=150 chars),
  "contact_reason": string from taxonomy (or "Other"),
  "contact_reason_change": boolean,
  "reason_override_why": string (<=300 chars, cite transcript cues when contact_reason_change=true; use empty string when no change),
  "agent_score": integer (1-5),
  "customer_score": integer (1-5),
  "resolved": boolean,
  "is_resolved": boolean,
  "resolution_why": string (<=300 chars, factual rationale for resolved/unresolved),
  "steps_extract": array of strings,
  "resolution_timestamp_iso": string | null (ISO 8601 for the resolution moment, null if unresolved),
  "resolution_message_index": integer | null (1-based transcript index, null if unresolved),
  "customer_sentiment_primary": one of the eight labels listed above,
  "customer_sentiment_scores": {
    "Delight": number,
    "Convenience": number,
    "Trust": number,
    "Frustration": number,
    "Disappointment": number,
    "Concern": number,
    "Hostility": number,
    "Neutral": number
  },
  "agent_profanity_detected": boolean,
  "agent_profanity_count": integer (>=0),
  "customer_abuse_detected": boolean,
  "customer_abuse_count": integer (>=0),
  "improvement_tip": string (<=200 chars)
}`,
  task_sequence: `Task sequence (complete all steps):
1. Compare the customer's stated problem to the agent's classification. If the original contact reason is "Duplicate", keep contact_reason="Duplicate" and contact_reason_change=false. Otherwise, set contact_reason_change=true when your chosen contact_reason differs from the original, and explain the override using literal phrases or timestamps from the transcript.
2. Decide whether the conversation is resolved. Set both resolved and is_resolved accordingly, and write resolution_why that cites the agent or customer action that proves the outcome (or why it failed).
3. Provide one-sentence summaries:
   a. problem_extract - concise but specific customer problem (<=250 chars). Mention concrete damage, location, or outage cause.
   b. resolution_extract - outcome in <15 words explaining how it was solved or why open.
4. List chronological agent actions that moved the ticket forward in steps_extract (array of short strings, earliest first, max 8 entries).
5. Identify the message where the issue was resolved (customer confirmation or decisive agent fix). Populate resolution_timestamp_iso (ISO 8601) and resolution_message_index (1-based transcript index). Use null for both when unresolved.
6. Produce customer sentiment:
   - customer_sentiment_primary must be one of: Delight, Convenience, Trust, Frustration, Disappointment, Concern, Hostility, Neutral.
   - customer_sentiment_scores is an object with those eight keys. Values are floats between 0 and 1 that sum to ~1.00 (+/-0.02 tolerance).
7. Generate llm_summary_250 (<=250 chars), conversation_rating/agent_score/customer_score (integers 1-5), improvement_tip (<=200 chars, actionable).
8. Detect abuse and profanity: set agent_profanity_detected / agent_profanity_count (agent side) and customer_abuse_detected / customer_abuse_count (customer side). Only count explicit insults, slurs, or profanity pointed at the counterpart/company.`,
  additional_instructions: `Additional instructions:
- Quote short phrases (e.g., "customer: bike stuck at finish screen") inside reason_override_why and resolution_why to justify decisions.
- steps_extract should only describe agent actions or system fixes that move toward resolution; omit chit-chat.
- When unresolved, explain the blocker inside resolution_why and set both resolution_timestamp_iso and resolution_message_index to null.
- Make resolution_extract under 15 words; problem_extract must stay concise yet include the concrete issue details (what broke, which dock, which outage cause, etc.).
- If profanity/abuse counts differ from transcript reality, explain briefly in resolution_why.
- Keep tone factual and manager-ready. Return STRICT JSON only-no Markdown or extra commentary.
- Scoring scale for conversation_rating, agent_score, and customer_score: 1=Very poor, 2=Poor, 3=Adequate, 4=Good, 5=Excellent.`,
  conversation_rating: `Detailed scoring guidance:
CONVERSATION_RATING
- Primary signals: resolved flag, sentiment at end, proof of closure, avoidable effort.
- 5 -> resolved=true AND resolution_timestamp_iso provided AND customer_sentiment_primary in {Delight, Convenience, Trust}.
- 4 -> resolved=true AND customer_sentiment_primary in {Neutral} OR clear shift from Frustration to Neutral; only minor avoidable effort.
- 3 -> unresolved BUT a clear next step is agreed and no harm done; neutral tone.
- 2 -> unresolved AND misclassification left uncorrected OR long back-and-forth with little progress.
- 1 -> incorrect/unsafe guidance, policy breach, or hostility escalation.`,
  agent_score: `AGENT_SCORE
- Primary signals: correct diagnosis/classification, useful actions, ownership, clarity.
- 5 -> correct contact_reason or justified override; at least two concrete steps_extract; delivers fix or definitive path; clear instructions.
- 4 -> small miss but corrected; steps_extract present; only minor clarity gaps.
- 3 -> some helpful action but partial or vague; missed one key step.
- 2 -> wrong or uncorrected classification OR speculative help with low action density.
- 1 -> harmful, rude, vulgar, or no actionable help.`,
  customer_score: `CUSTOMER_SCORE
- Primary signals: final customer message, sentiment curve, explicit thanks/relief.
- 5 -> explicit positive closure ("works now," "thanks!") or Delight/Trust sentiment at the end.
- 4 -> polite thanks without enthusiasm; Neutral at the end.
- 3 -> neutral acceptance ("ok," "I'll try") without closure proof.
- 2 -> lingering doubt, mild Frustration/Concern, or abandonment.
- 1 -> Hostility/Disappointment or vulgar/profane language directed at the agent/company (swearing acceptable only when describing the issue itself).`
};

export const PROJECT_PROMPT_TYPES = [
  "system_prompt",
  "prompt_header",
  "prompt_json_schema",
  "task_sequence",
  "additional_instructions",
  "conversation_rating",
  "agent_score",
  "customer_score"
] as const;
