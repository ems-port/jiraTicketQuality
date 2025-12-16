import type { NextApiRequest, NextApiResponse } from "next";

const DEFAULT_MODEL =
  process.env.PORT_CONVO_MODEL ||
  process.env.PORT_CONVO_DEFAULT_MODEL ||
  process.env.PORT_LLM_MODEL ||
  "gpt-5-nano";

const DEFAULT_SYSTEM_PROMPT =
  "You are a meticulous quality assurance analyst who responds in JSON. Conversation transcript lines use 'A:' for agent and 'C:' for customer to optimise tokens.";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(400).json({ error: "OPENAI_API_KEY missing on server" });
    return;
  }
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const prompt = (body?.prompt ?? "").toString();
  const systemPrompt = (body?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT).toString();
  const model = (body?.model ?? DEFAULT_MODEL).toString();
  if (!prompt.trim()) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  try {
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt }
    ];
    const supportsTemperature = !model.toLowerCase().startsWith("gpt-5");
    const requestBody = {
      model,
      messages,
      ...(supportsTemperature ? { temperature: 0.1 } : {})
    };
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });
    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json({ error: data?.error?.message || "OpenAI request failed" });
      return;
    }
    res.status(200).json({ completion: data, request: requestBody });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || "Unexpected error" });
  }
}
