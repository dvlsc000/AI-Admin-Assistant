import OpenAI from "openai";
import { z } from "zod";

/**
 * Strict schema so your server doesn't break.
 * If the AI output is invalid JSON, we throw an error.
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

export function makeOpenAI(apiKey) {
  return new OpenAI({ apiKey });
}

/**
 * Ask OpenAI to classify the email and draft a reply.
 * Returns a validated JS object.
 */
export async function triageEmail({ openai, model, email }) {
  const system = `
You are an assistant for a small gym.

Tasks:
1) Choose exactly ONE category from the list.
2) Choose urgency: LOW / MEDIUM / HIGH.
3) Draft a short, polite reply (human will approve).

Rules:
- If spam/marketing: SPAM_OTHER.
- Do not invent policies.
- If details are missing, ask ONE clarifying question.
- Output JSON only. No extra text.
Categories:
CANCELLATION, FREEZE_REQUEST, BOOKING_CHANGE, BILLING_INVOICE, COMPLAINT, GENERAL_QUESTION, SPAM_OTHER
`.trim();

  const user = `
From: ${email.fromEmail}
Subject: ${email.subject}
Body:
${email.bodyText || email.snippet || ""}
`.trim();

  const resp = await openai.responses.create({
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  const text = (resp.output_text || "").trim();

  // Parse JSON safely even if model adds whitespace
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Try to extract JSON object if extra content appears
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("AI did not return JSON.");
    json = JSON.parse(text.slice(start, end + 1));
  }

  const parsed = TriageSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("AI output failed schema validation: " + parsed.error.message);
  }

  return parsed.data;
}
