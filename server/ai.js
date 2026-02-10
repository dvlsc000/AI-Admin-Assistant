import { z } from "zod";

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

export async function triageEmail({
  email,
  ollamaBaseUrl,
  model,
  timeoutMs = 60000,
  maxChars = 1500
}) {
  const body = (email.bodyText || email.snippet || "").slice(0, maxChars);

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
- Use SPAM_OTHER for marketing/spam.
- confidence must be between 0 and 1.
- reply_draft must be short, polite, and professional.
- If key details are missing, ask ONE clarifying question in the reply.
- Output JSON ONLY. No markdown. No extra text.

EMAIL:
From: ${email.fromEmail}
Subject: ${email.subject}
Body (truncated):
${body}
`.trim();

  const base = ollamaBaseUrl.replace(/\/$/, "");
  const url = `${base}/api/generate`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Ollama timeout after ${timeoutMs}ms`);
    throw new Error(`Ollama request failed: ${err.message}`);
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Ollama error ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = await res.json().catch(() => ({}));
  const text = (data.response || "").trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Ollama did not return JSON (no braces found).");

  let json;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Ollama returned malformed JSON.");
  }

  const parsed = TriageSchema.safeParse(json);
  if (!parsed.success) throw new Error("Ollama JSON failed schema validation: " + parsed.error.message);

  return parsed.data;
}
