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
You are an expert customer support agent for a small gym in 2026.
Your job: understand the email, choose the right category/urgency, and write a modern, helpful reply.

Return ONLY valid JSON in EXACTLY this shape:
{
  "category": "CANCELLATION | FREEZE_REQUEST | BOOKING_CHANGE | BILLING_INVOICE | COMPLAINT | GENERAL_QUESTION | SPAM_OTHER",
  "urgency": "LOW | MEDIUM | HIGH",
  "confidence": 0.0,
  "reply_draft": "text"
}

Hard rules:
- Output JSON ONLY. No markdown, no backticks, no commentary.
- Choose ONE category.
- Use SPAM_OTHER for marketing/newsletters or anything not from a member needing help.
- confidence must be between 0 and 1.
- Never claim you completed an action (cancelled, refunded, changed booking) unless the email explicitly says it already happened.
- If critical info is missing, ask at most ONE question, and still provide what you CAN do now.
- Keep reply_draft 90–160 words max, friendly, modern, clear.

Gym policy assumptions (use ONLY if relevant; if unknown, don’t invent details):
- Membership cancellations usually require verifying the member and the effective date.
- Freezes require a start date and duration.
- Booking changes require class/session name + desired new date/time.
- Billing issues: request invoice period / last 4 digits / transaction date; reassure and investigate.
- Complaints: apologize, acknowledge, propose a next step, and offer a manager follow-up if needed.

Writing style:
- Start with a warm 1-sentence acknowledgement.
- Then 2–4 short sentences with solution + next steps.
- End with a simple close + signature: "— Gym Team"
- If offering options, present them as 2 short bullet points inside the reply text.

Now do this step-by-step internally (do NOT output these steps):
1) Detect if spam. If yes: category=SPAM_OTHER, urgency=LOW, confidence high, reply politely declining.
2) Otherwise: identify intent, key details (names/dates/amounts), and what’s missing.
3) Set category + urgency:
   - HIGH if: cancellation dispute, payment taken incorrectly, access blocked, safety issue, angry complaint, time-sensitive booking today/tomorrow.
   - MEDIUM if: normal billing question, booking change soon, freeze/cancel request without urgency signals.
   - LOW if: general info, pricing, opening hours, future booking.
4) Draft the reply in the specified style.

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
