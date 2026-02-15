import { useEffect, useMemo, useState } from "react";
import { apiFetch, apiBase } from "./api";

function Badge({ children }) {
  return <span className="badge">{children}</span>;
}

function percent(x) {
  if (typeof x !== "number") return "";
  return `${Math.round(x * 100)}%`;
}

function cleanForDisplay(text) {
  if (!text) return "";

  let t = String(text);

  // Remove CSS blocks often appearing in marketing emails
  t = t.replace(/(^|\n)\s*body\s*\{[\s\S]*?\}\s*(?=\n|$)/gi, "\n");
  t = t.replace(/(^|\n)\s*@media\s*[\s\S]*?\}\s*(?=\n|$)/gi, "\n");

  // Remove super long tracking links (example: t1.marketing.ryanair...)
  t = t
    .split("\n")
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;

      // Drop lines that are basically only a huge URL
      const isMostlyUrl = /^https?:\/\/\S{60,}$/i.test(s);
      if (isMostlyUrl) return false;

      // Drop known tracker domains (adjust list as you see them)
      if (/t1\.marketing\.ryanairmail\.com/i.test(s)) return false;

      return true;
    })
    .join("\n");

  // Collapse crazy whitespace
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

// Linkify URLs in text, but truncate them if they're super long
function LinkifiedText({ text }) {
  // Split by URLs, keeping the URLs in the result
  const parts = text.split(/(https?:\/\/[^\s)]+)|(www\.[^\s)]+)/gi);

  return (
    <>
      {parts.map((part, idx) => {
        if (!part) return null;

        const isUrl = /^https?:\/\//i.test(part) || /^www\./i.test(part);
        if (!isUrl) return <span key={idx}>{part}</span>;

        const href = part.startsWith("http") ? part : `https://${part}`;
        const display = part.length > 60 ? part.slice(0, 45) + "…" + part.slice(-10) : part;

        return (
          <a key={idx} href={href} target="_blank" rel="noreferrer">
            {display}
          </a>
        );
      })}
    </>
  );
}

function MessageBody({ text }) {
  const cleaned = cleanForDisplay(text);

  if (!cleaned) return <div className="small">(No message body)</div>;

  const paragraphs = cleaned.split(/\n\s*\n/g);

  return (
    <div style={{ marginTop: 10, lineHeight: 1.5 }}>
      {paragraphs.map((p, i) => (
        <p
          key={i}
          style={{
            marginTop: i === 0 ? 0 : 10,
            marginBottom: 0,
            whiteSpace: "pre-wrap"
          }}
        >
          <LinkifiedText text={p} />
        </p>
      ))}
    </div>
  );
}

export default function App() {
  const API = apiBase();

  const [me, setMe] = useState(null);
  const [emails, setEmails] = useState([]);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  // kept, but no longer shown in UI
  const [health, setHealth] = useState({ ok: false, ollamaOk: null, model: null });

  // prevent repeated auto-syncs
  const [didInitialSync, setDidInitialSync] = useState(false);

  const authed = useMemo(() => !!me?.user, [me]);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch("/api/me", { timeoutMs: 15000 });
        setMe(data);
      } catch {
        setMe({ user: null });
      }
    })();
  }, []);

  async function refreshHealth() {
    try {
      const h = await apiFetch("/api/health", { timeoutMs: 5000 });
      setHealth(h);
      return h;
    } catch {
      const h = { ok: false, ollamaOk: false, model: null };
      setHealth(h);
      return h;
    }
  }

  async function refreshEmails() {
    const data = await apiFetch("/api/emails?unread=true", { timeoutMs: 30000 });
    setEmails(data.emails || []);
  }

  async function openEmail(gmailId) {
    const data = await apiFetch(`/api/emails/${gmailId}`, { timeoutMs: 30000 });
    setSelected(data.email || null);
  }

  // Auto-sync once after login
  useEffect(() => {
    if (!authed) return;

    // Load whatever is already in Firestore right away
    refreshEmails().catch(() => {});

    if (didInitialSync) return;

    (async () => {
      setLoading(true);
      setStatus("Syncing inbox + generating drafts…");

      try {
        // Silent health check so sync errors are nicer if Ollama is down
        await refreshHealth();

        const data = await apiFetch("/api/emails/sync", {
          method: "POST",
          body: JSON.stringify({ maxResults: 20 }),
          timeoutMs: 180000
        });

        const secs = Math.round((data.durationMs || 0) / 1000);
        const errNote = data.aiErrors ? ` (AI errors: ${data.aiErrors})` : "";
        setStatus(
          `Done. Fetched: ${data.fetched}, created: ${data.created}, triaged: ${data.triaged}${errNote} (${secs}s)`
        );

        await refreshEmails();
      } catch (e) {
        setStatus(`Error: ${e.message}`);
      } finally {
        setLoading(false);
        setDidInitialSync(true);
      }
    })();
  }, [authed, didInitialSync]);

  async function logout() {
    setLoading(true);
    try {
      await apiFetch("/api/logout", { method: "POST", timeoutMs: 15000 });
      setMe({ user: null });
      setEmails([]);
      setSelected(null);
      setStatus("Logged out.");
      setDidInitialSync(false);
    } catch (e) {
      setStatus(`Logout error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  if (!me) return <div style={{ padding: 24 }}>Loading…</div>;

  if (!authed) {
    return (
      <div style={{ padding: 24, maxWidth: 720 }}>
        <h2 style={{ marginTop: 0 }}>AI Admin Assistant</h2>
        <p className="small">
          Connect your Gmail (readonly), triage messages, and draft replies using local AI (Ollama).
        </p>

        <div className="card">
          <div className="row">
            <div>
              <div style={{ fontWeight: 800 }}>Login required</div>
              <div className="small">Google OAuth happens on your server.</div>
            </div>
            <a href={`${API}/auth/google`}>
              <button>Login with Google</button>
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="sidebar">
        <div className="card">
          <div className="row">
            <div>
              <div className="small">Logged in as</div>
              <div style={{ fontWeight: 900 }}>{me.user.email}</div>
              <div className="small">{me.user.displayName || ""}</div>
            </div>
            <button onClick={logout}>
              Logout
            </button>
          </div>

        </div>

        <h3 style={{ marginTop: 16, marginBottom: 8 }}>Inbox</h3>

        <div className="list">
          {emails.length === 0 ? (
            <div className="small">{loading ? "Loading inbox…" : "No unread emails found."}</div>
          ) : (
            emails.map((e) => (
              <button className="listItem" key={e.gmailId} onClick={() => openEmail(e.gmailId)}>
                <div className="row" style={{ alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 900,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {e.subject || "(no subject)"}
                    </div>

                    <div
                      className="small"
                      style={{
                        marginTop: 4,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {e.fromEmail}
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                    {e.ai?.category && <Badge>{e.ai.category}</Badge>}
                    {e.ai?.urgency && <Badge>{e.ai.urgency}</Badge>}
                  </div>
                </div>

                <div
                  className="small"
                  style={{
                    marginTop: 8,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  }}
                >
                  {e.snippet || ""}
                </div>

                {typeof e.ai?.confidence === "number" && (
                  <div className="small" style={{ marginTop: 8 }}>
                    Confidence: {percent(e.ai.confidence)}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="main">
        {!selected ? (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Select an email</h2>
            <p className="small">Pick an email on the left to see the AI result and draft reply.</p>
          </div>
        ) : (
          <div className="card">
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <h2 style={{ marginTop: 0, marginBottom: 6 }}>{selected.subject || "(no subject)"}</h2>
                <div className="small">
                  <b>From:</b> {selected.fromEmail}
                </div>
                <div className="small">
                  <b>Date:</b> {selected.dateIso || "(unknown)"}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                {selected.ai?.category && <Badge>{selected.ai.category}</Badge>}
                {selected.ai?.urgency && <Badge>Urgency: {selected.ai.urgency}</Badge>}
                {typeof selected.ai?.confidence === "number" && <Badge>Conf: {percent(selected.ai.confidence)}</Badge>}
              </div>
            </div>

            {selected.aiSummary?.summary ? (
              <div className="card" style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>Short summary</div>
                <div className="small" style={{ whiteSpace: "pre-wrap" }}>
                  {selected.aiSummary.summary}
                </div>

                {Array.isArray(selected.aiSummary.key_points) && selected.aiSummary.key_points.length > 0 && (
                  <ul style={{ marginTop: 10, marginBottom: 0 }}>
                    {selected.aiSummary.key_points.map((p, idx) => (
                      <li key={idx} className="small">
                        {p}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            <h3 style={{ marginTop: 16 }}>Message</h3>
            <MessageBody text={(selected.cleanBodyText || selected.bodyText || selected.snippet || "").trim()} />

            <h3 style={{ marginTop: 16 }}>AI draft reply</h3>
            <pre>{selected.ai?.reply_draft || "(No draft available yet)"}</pre>

            <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              <button
                onClick={() => navigator.clipboard.writeText(selected.ai?.reply_draft || "")}
                disabled={!selected.ai?.reply_draft}
              >
                Copy reply
              </button>
              <button onClick={() => setSelected(null)}>Close</button>
            </div>

            <div className="small" style={{ marginTop: 12 }}>
              Safety: this app does not auto-send emails. You manually copy/paste.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
