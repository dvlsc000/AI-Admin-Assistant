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

async function ollamaGenerate({ ollamaBaseUrl, model, prompt, timeoutMs, temperature = 0.2 }) {
  const base = ollamaBaseUrl.replace(/\/$/, "");
  const url = `${base}/api/generate`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature }
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Ollama error ${res.status}: ${txt.slice(0, 300)}`);
    }

    const data = await res.json().catch(() => ({}));
    return (data.response || "").trim();
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`Ollama timeout after ${timeoutMs}ms`);
    throw new Error(`Ollama request failed: ${err?.message || err}`);
  } finally {
    clearTimeout(t);
  }
}

export async function triageEmail({
  email,
  ollamaBaseUrl,
  model,
  timeoutMs = 180000,
  maxChars = 2000
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

Rules:

Output / formatting:
- Return ONLY valid JSON in EXACTLY the requested shape.
- Output JSON ONLY. No markdown, no backticks, no extra text.
- Choose ONE category only.
- confidence must be between 0 and 1.

Spam handling:
- Use SPAM_OTHER for marketing, newsletters, promotions, or anything that is not a real member support request.
- If SPAM_OTHER, urgency must be LOW.
- For spam, reply_draft should politely decline and be extremely short.

Safety + accuracy:
- Never claim you completed an action (cancelled membership, issued refund, changed booking, froze membership)
  unless the email explicitly confirms it already happened.
- Never invent gym policies, prices, dates, or account details.
- If the email asks for something you cannot confirm, say you can help and will check it.

Urgency logic:
- HIGH if the message suggests:
  - payment taken incorrectly / charged twice
  - cancellation dispute / angry complaint
  - access blocked / membership not working
  - safety issue / harassment / injury
  - booking issue for today or tomorrow
- MEDIUM if:
  - normal cancellation request
  - freeze request
  - booking change in the next few days
  - billing questions without strong anger or urgency
- LOW if:
  - general questions, pricing, opening hours, future plans
  - non-urgent booking change far in the future

Reply quality requirements:
- reply_draft must be 90–160 words.
- Tone must be modern, friendly, confident, and professional.
- Use short sentences. Avoid robotic wording.
- Provide clear next steps.
- If key info is missing, ask at most ONE clarifying question.
- Always include what you CAN do now, even if asking a question.
- Ignore quoted replies, legal footers, tracking links, or marketing junk in the email body.

Greeting rules:
- If the sender’s first name is clearly present in the email text (examples: "My name is John", "This is Sarah", "Regards, Mike"),
  start the reply with: "Hi John," (first name only).
- If no name is confidently found, start with: "Hi there,"
- Do NOT guess names from the email address.

Sign-off rules:
- Always end the reply with EXACTLY this closing:

Kind regards,
Management Team

- Do not include any other signature text.

Reply structure (must follow):
1) Greeting line (Hi Name / Hi there)
2) 1 sentence acknowledgement
3) 2–4 short sentences explaining the solution / next steps
4) If needed, include up to 2 bullet points for options
5) If needed, ask ONE question (only one)
6) Closing + signature exactly as specified

Category guidance (use ONLY if relevant):
- CANCELLATION: confirm member identity + effective cancellation date.
- FREEZE_REQUEST: ask for freeze start date + duration.
- BOOKING_CHANGE: ask for class/session + preferred new date/time.
- BILLING_INVOICE: ask for date/amount and any identifying detail; reassure and investigate.
- COMPLAINT: apologize, acknowledge, propose next step, offer manager follow-up.
- GENERAL_QUESTION: answer directly if possible; otherwise ask one question.
- SPAM_OTHER: politely decline.

EMAIL:
From: ${email.fromEmail}
Subject: ${email.subject}
Message (cleaned & truncated):
${body}
`.trim();

  const text = await ollamaGenerate({
    ollamaBaseUrl,
    model,
    prompt,
    timeoutMs,
    temperature: 0.2
  });

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
  "title": "2-3 words max, plain English",
  "summary": "1-3 sentences, plain English",
  "key_points": ["up to 5 bullet points, short"]
}

Rules:
- Title must be 2-3 words MAX.
- Remove signatures, legal footers, and quoted replies (assume the text is already cleaned).
- If the message is already short, keep summary very short.
- No markdown, no extra text. Output JSON ONLY.

EMAIL MESSAGE:
${body}
`.trim();

  const text = await ollamaGenerate({
    ollamaBaseUrl,
    model,
    prompt,
    timeoutMs,
    temperature: 0.2
  });

  const json = extractJson(text);
  const parsed = SummarySchema.safeParse(json);
  if (!parsed.success) throw new Error("Summary JSON failed schema validation: " + parsed.error.message);

  return parsed.data;
}
