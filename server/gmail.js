import { google } from "googleapis";

export function makeOAuthClient({ clientId, clientSecret, redirectUri, tokens }) {
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2.setCredentials(tokens);
  return oauth2;
}

export async function fetchLatestEmails({ oauth2Client, maxResults = 20, labelIds = ["INBOX"] }) {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const listRes = await gmail.users.messages.list({
    userId: "me",
    labelIds,
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

    // ✅ NEW: clean the body so the UI and AI use the "pure message"
    const cleanBodyText = cleanEmailBody(bodyText) || cleanEmailBody(snippet) || "";

    const msgLabelIds = full.data.labelIds || [];
    const isUnread = msgLabelIds.includes("UNREAD");

    results.push({
      gmailId: full.data.id,
      threadId: full.data.threadId || null,
      fromEmail: from,
      subject,
      dateIso: date ? new Date(date).toISOString() : null,
      snippet,
      bodyText,
      cleanBodyText, // ✅ store cleaned version
      labelIds: msgLabelIds,
      isUnread
    });
  }

  return results;
}

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

/**
 * Best-effort "pure message" extraction:
 * - removes common reply separators and quoted blocks
 * - removes common signature separators
 * - removes lines starting with ">"
 */
function cleanEmailBody(text) {
  if (!text) return "";

  let t = String(text).replace(/\r\n/g, "\n").trim();

  // Remove lines that are pure quoted content
  t = t
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n");

  // Cut off at common reply markers
  const replyMarkers = [
    /^On .*wrote:$/im,
    /^From:\s.*$/im,
    /^Sent:\s.*$/im,
    /^To:\s.*$/im,
    /^Subject:\s.*$/im,
    /^-+\s*Original Message\s*-+$/im,
    /^_{2,}$/m,
    /^-{2,}$/m
  ];

  let cutIdx = -1;
  for (const re of replyMarkers) {
    const m = re.exec(t);
    if (m && (cutIdx === -1 || m.index < cutIdx)) cutIdx = m.index;
  }
  if (cutIdx !== -1) t = t.slice(0, cutIdx).trim();

  // Cut off at signature separator: "-- "
  const sig = t.indexOf("\n-- ");
  if (sig !== -1) t = t.slice(0, sig).trim();

  // Collapse excessive blank lines
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return t;
}
