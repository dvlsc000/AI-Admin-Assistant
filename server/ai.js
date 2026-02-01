import { z } from "zod";

/**
 * Strict schema so your app stays stable.
 * If Ollama returns garbage, we fail safely.
 */
const TriageSchema = z.object({
  category: z.enum([
    "CANCELLATION",
    "FREEZE_REQUEST",
    "BOOKING_CHANGE",
    "BILLING_INVOICE",
    "COMPLAINT",
    "GENERAL_QUESTION",
    "SPAM_OTHER"
  ]),
  urgency: z.enum(["LOW", "MEDIUM", "HIGH"]),
  confidence: z.number().min(0).max(1),
  reply_draft: z.string().min(1)
});

/**
 * Calls local Ollama at http://localhost:11434.
 * Make sure you ran: `ollama pull llama3`
 */
export async function triageEmail({ email, ollamaBaseUrl, model }) {
  const prompt = `
You are an assistant for a small gym.

Return ONLY valid JSON in EXACTLY this shape:
{
  "category": "CANCELLATION | FREEZE_REQUEST | BOOKING_CHANGE | BILLING_INVOICE | COMPLAINT | GENERAL_QUESTION | SPAM_OTHER",
  "urgency": "LOW | MEDIUM | HIGH",
  "confidence": 0.0,
  "reply_draft": "text"
}

Rules:
- Choose ONE category only.
- SPAM_OTHER for marketing/spam.
- confidence must be a number between 0 and 1.
- reply_draft must be short, polite, professional.
- If details are missing, ask ONE clarifying question in the reply.
- Output JSON ONLY. No markdown. No extra text.

EMAIL:
From: ${email.fromEmail}
Subject: ${email.subject}
Body:
${email.bodyText || email.snippet || ""}
`.trim();

  const url = `${ollamaBaseUrl.replace(/\/$/, "")}/api/generate`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Ollama error: ${res.status} ${t}`);
  }

  const data = await res.json();
  const text = (data.response || "").trim();

  // Extract JSON even if model accidentally adds extra whitespace/text
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Ollama did not return JSON. Try re-running `ollama pull llama3` and ensure Ollama is running.");
  }

  let json;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Failed to parse Ollama JSON. Model returned malformed JSON.");
  }

  const parsed = TriageSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("Ollama JSON failed schema validation: " + parsed.error.message);
  }

  return parsed.data;
}
