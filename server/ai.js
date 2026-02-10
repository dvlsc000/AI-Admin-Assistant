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

const SummarySchema = z.object({
  summary: z.string().min(1),
  key_points: z.array(z.string().min(1)).max(5).optional()
});

function pickMessage(email) {
  return (email.cleanBodyText || email.bodyText || email.snippet || "").trim();
}

export async function triageEmail({
  email,
  ollamaBaseUrl,
  model,
  timeoutMs = 60000,
  maxChars = 1500
}) {
  const body = pickMessage(email).slice(0, maxChars);

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
Message (cleaned & truncated):
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

  const json = extractJson(text);
  const parsed = TriageSchema.safeParse(json);
  if (!parsed.success) throw new Error("Ollama JSON failed schema validation: " + parsed.error.message);

  return parsed.data;
}

export async function summarizeEmail({
  email,
  ollamaBaseUrl,
  model,
  timeoutMs = 45000,
  maxChars = 4000
}) {
  const body = pickMessage(email).slice(0, maxChars);

  const prompt = `
Summarize the following email for a gym admin.

Return ONLY valid JSON in EXACTLY this shape:
{
  "summary": "1-3 sentences, plain English",
  "key_points": ["up to 5 bullet points, short"]
}

Rules:
- Remove signatures, legal footers, and quoted replies (assume the text is already cleaned).
- If the message is already short, keep summary very short.
- No markdown, no extra text. Output JSON ONLY.

EMAIL MESSAGE:
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

  const json = extractJson(text);
  const parsed = SummarySchema.safeParse(json);
  if (!parsed.success) throw new Error("Summary JSON failed schema validation: " + parsed.error.message);

  return parsed.data;
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model did not return JSON (no braces found).");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Model returned malformed JSON.");
  }
}
