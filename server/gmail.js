import { google } from "googleapis";

/**
 * Build OAuth2 client and attach tokens.
 */
export function makeOAuthClient({ clientId, clientSecret, redirectUri, tokens }) {
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2.setCredentials(tokens); // { access_token, refresh_token }
  return oauth2;
}

/**
 * Fetch latest N inbox emails and return simplified objects.
 */
export async function fetchLatestEmails({ oauth2Client, maxResults = 10 }) {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const listRes = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults
  });

  const msgs = listRes.data.messages || [];
  const results = [];

  for (const m of msgs) {
    const full = await gmail.users.messages.get({
      userId: "me",
      id: m.id,
      format: "full"
    });

    const payload = full.data.payload;
    const headers = payload?.headers || [];

    const getHeader = (name) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

    const subject = getHeader("Subject");
    const from = getHeader("From");
    const date = getHeader("Date");
    const snippet = full.data.snippet || "";

    const bodyText = extractBodyText(payload);

    results.push({
      gmailId: full.data.id,
      threadId: full.data.threadId || null,
      fromEmail: from,
      subject,
      dateIso: date ? new Date(date).toISOString() : null,
      snippet,
      bodyText
    });
  }

  return results;
}

/**
 * Extract plain text from Gmail MIME payload.
 */
function extractBodyText(payload) {
  if (!payload) return "";

  const parts = payload.parts || [];
  if (parts.length) {
    const plain = findPart(parts, "text/plain");
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);

    const html = findPart(parts, "text/html");
    if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));

    const any = parts.find((p) => p?.body?.data);
    if (any?.body?.data) return decodeBase64Url(any.body.data);
  }

  if (payload.body?.data) return decodeBase64Url(payload.body.data);

  return "";
}

function findPart(parts, mimeType) {
  for (const p of parts) {
    if (p.mimeType === mimeType) return p;
    if (p.parts) {
      const nested = findPart(p.parts, mimeType);
      if (nested) return nested;
    }
  }
  return null;
}

function decodeBase64Url(data) {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf-8");
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
