// Used to define what ashape the model's JSON output MUST have, 
// and to validate and safely parse the output before returning it.
import { z } from "zod";

// TriageSchema
// Defines the exact JSON structure we expect back from the "triage" LLM call.
// If model returns anything else (missing keys, extra keys, wrong types), we throw an error instead of returning bad data.
const TriageSchema = z.object({
  // Category MUST be exactly ONE of these 7 options. No more, no less.
  // z.enum([...]) restricts the value to a fixed set of allowed labels. 
  category: z.enum([
    "CANCELLATION",
    "FREEZE_REQUEST",
    "BOOKING_CHANGE",
    "BILLING_INVOICE",
    "COMPLAINT",
    "GENERAL_QUESTION",
    "SPAM_OTHER"
  ]),

  // Urgency MUST be exactly ONE of these 3 options.
  urgency: z.enum(["LOW", "MEDIUM", "HIGH"]),

  // Confidence MUST be a number between 0 and 1.
  confidence: z.number().min(0).max(1),

  // reply_draft MUST be a non-empty string.
  reply_draft: z.string().min(1)
});


// SummarySchema
// Defines the expected JSON structure for the "summarize" LLM call.
const SummarySchema = z.object({
  // Summary MUST be a non-empty string.
  summary: z.string().min(1),

  // Key points is optional, but if present must be an array of 1-5 non-empty strings.
  key_points: z.array(z.string().min(1)).max(5).optional()
});

// Chooses the best available text field from the email object and returns it.
// Priority order:
  // 1) cleanBodyText (pre-cleaned text with signatures and quoted replies removed)
  // 2) bodyText (full raw text of the email)
  // 3) snippet (short preview text, may be truncated)
// If none of these are available, returns an empty string.
// Trims whitespace from the chosen text before returning.
function pickMessage(email) {
  return (email.cleanBodyText || email.bodyText || email.snippet || "").trim();
}

// Pull JSON out of a string by finding the first { and the last } and parsing the text in between.
// Needed in case model adds extra text.
// Throws an error if no braces are found or if the JSON is malformed.
function extractJson(text) {
  // Find the first "{".
  const start = text.indexOf("{");
  // Find the last "}".
  const end = text.lastIndexOf("}");

  // If we can't find both, it's not valid JSON.
  if (start === -1 || end === -1) throw new Error("Model did not return JSON (no braces found).");

  // Extract the substring that should be JSON and try to parse it.
  // end + 1 because slice's end index is exclusive.
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    // If parsing fails, throw an error with the original text for debugging.
    throw new Error("Model returned malformed JSON.");
  }
}

// ollamaGenerate
// Calls an Ollama model with the given prompt and returns the response text.
// Parameters:
  // - ollamaBaseUrl: base URL of the Ollama server (e.g. "http://localhost:11434")
  // - model: name of the model to call (e.g. "triage-v1")
  // - prompt: the text prompt to send to the model
  // - timeoutMs: how long to wait for a response before aborting (in milliseconds)
  // - temperature: controls randomness of the output, default is 0.2 for focused responses
async function ollamaGenerate({ ollamaBaseUrl, model, prompt, timeoutMs, temperature = 0.2 }) {
  // Ensure the base URL does not end with a slash to avoid double slashes in the final URL.
  const base = ollamaBaseUrl.replace(/\/$/, "");
  // The endpoint for generating text from a model.
  const url = `${base}/api/generate`;

  // Set up an AbortController to handle timeouts. If the model takes too long, we can abort the request.
  const controller = new AbortController();
  // Start a timer that will call controller.abort() after timeoutMs milliseconds.
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
