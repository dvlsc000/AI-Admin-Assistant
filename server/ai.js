/**
 * Local AI using Ollama (FREE).
 * Requires: ollama running locally with `llama3` model.
 */

export async function triageEmail({ email }) {
  const prompt = `
You are an assistant for a small gym.

Return ONLY valid JSON in this exact format:
{
  "category": "CANCELLATION | FREEZE_REQUEST | BOOKING_CHANGE | BILLING_INVOICE | COMPLAINT | GENERAL_QUESTION | SPAM_OTHER",
  "urgency": "LOW | MEDIUM | HIGH",
  "confidence": 0.0,
  "reply_draft": "text"
}

Rules:
- Choose ONE category.
- Use SPAM_OTHER for marketing.
- Confidence is between 0 and 1.
- Reply must be polite and short.

EMAIL:
From: ${email.fromEmail}
Subject: ${email.subject}
Body:
${email.bodyText || email.snippet}
`.trim();

  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3",
      prompt,
      stream: false
    })
  });

  const data = await res.json();

  // Ollama returns raw text → extract JSON
  const text = data.response;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Ollama did not return JSON");
  }

  return JSON.parse(text.slice(start, end + 1));
}
