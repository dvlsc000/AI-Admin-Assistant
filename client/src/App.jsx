import { useEffect, useMemo, useState } from "react";
import { apiFetch, apiBase } from "./api";

function Badge({ children }) {
  return <span className="badge">{children}</span>;
}

function percent(x) {
  if (typeof x !== "number") return "";
  return `${Math.round(x * 100)}%`;
}

export default function App() {
  const API = apiBase();

  const [me, setMe] = useState(null);
  const [emails, setEmails] = useState([]);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const [health, setHealth] = useState({ ok: false, ollamaOk: null, model: null });

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
    } catch {
      setHealth({ ok: false, ollamaOk: false, model: null });
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

  async function syncInbox() {
    setLoading(true);
    setStatus("Syncing unread inbox + generating drafts…");

    try {
      await refreshHealth();

      const data = await apiFetch("/api/emails/sync", {
        method: "POST",
        body: JSON.stringify({ maxResults: 20 }),
        timeoutMs: 180000
      });

      const secs = Math.round((data.durationMs || 0) / 1000);
      const errNote = data.triageErrors ? ` (AI errors: ${data.triageErrors})` : "";

      setStatus(`Done. Fetched: ${data.fetched}, created: ${data.created}, triaged: ${data.triaged}${errNote} (${secs}s)`);

      await refreshEmails();
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    setLoading(true);
    try {
      await apiFetch("/api/logout", { method: "POST", timeoutMs: 15000 });
      setMe({ user: null });
      setEmails([]);
      setSelected(null);
      setStatus("Logged out.");
    } catch (e) {
      setStatus(`Logout error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (authed) {
      refreshHealth();
      refreshEmails();
    }
  }, [authed]);

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

  const ollamaBadge =
    health.ollamaOk == null ? (
      <Badge>Ollama: ?</Badge>
    ) : health.ollamaOk ? (
      <Badge>Ollama: OK ({health.model})</Badge>
    ) : (
      <Badge>Ollama: DOWN</Badge>
    );

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
            <button onClick={logout} disabled={loading}>
              Logout
            </button>
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {ollamaBadge}
            <button onClick={refreshHealth} disabled={loading}>
              Check health
            </button>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button onClick={syncInbox} disabled={loading}>
              {loading ? "Working…" : "Sync + Draft"}
            </button>
            <button onClick={refreshEmails} disabled={loading}>
              Refresh
            </button>
          </div>

          {status && (
            <div style={{ marginTop: 10 }} className="small">
              {status}
            </div>
          )}
        </div>

        <h3 style={{ marginTop: 16, marginBottom: 8 }}>Inbox</h3>

        <div className="list">
          {emails.length === 0 ? (
            <div className="small">No emails yet. Click “Sync + Draft”.</div>
          ) : (
            emails.map((e) => (
              <button className="listItem" key={e.gmailId} onClick={() => openEmail(e.gmailId)}>
                <div className="row" style={{ alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {e.subject || "(no subject)"}
                    </div>

                    <div className="small" style={{ marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {e.fromEmail}
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                    {e.ai?.category && <Badge>{e.ai.category}</Badge>}
                    {e.ai?.urgency && <Badge>{e.ai.urgency}</Badge>}
                  </div>
                </div>

                <div className="small" style={{ marginTop: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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

            <h3 style={{ marginTop: 16 }}>Email body</h3>
            <pre>{selected.bodyText || selected.snippet || ""}</pre>

            <h3 style={{ marginTop: 16 }}>AI draft reply</h3>
            <pre>{selected.ai?.reply_draft || "(No draft yet — click Sync + Draft)"}</pre>

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
