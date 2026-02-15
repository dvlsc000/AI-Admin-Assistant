import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, apiBase } from "./api";

function Pill({ tone = "neutral", children, title }) {
  return (
    <span className={`pill pill--${tone}`} title={title}>
      {children}
    </span>
  );
}

function urgencyTone(u) {
  const x = String(u || "").toUpperCase();
  if (x === "HIGH" || x === "URGENT" || x === "CRITICAL") return "danger";
  if (x === "MEDIUM") return "warn";
  if (x === "LOW") return "ok";
  return "neutral";
}

function urgencyIcon(u) {
  const x = String(u || "").toUpperCase();
  if (x === "HIGH" || x === "URGENT" || x === "CRITICAL") return "🚨";
  if (x === "MEDIUM") return "⏳";
  if (x === "LOW") return "✅";
  return "•";
}

function categoryTone(cat) {
  const x = String(cat || "").toUpperCase();
  if (x.includes("FREEZE")) return "info";
  if (x.includes("CANCEL")) return "danger";
  if (x.includes("BILL") || x.includes("PAY")) return "warn";
  if (x.includes("COMPLAINT")) return "danger";
  if (x.includes("BOOK") || x.includes("CLASS")) return "info";
  return "neutral";
}

function categoryIcon(cat) {
  const x = String(cat || "").toUpperCase();
  if (x.includes("FREEZE")) return "🧊";
  if (x.includes("CANCEL")) return "🛑";
  if (x.includes("BILL") || x.includes("PAY")) return "💳";
  if (x.includes("COMPLAINT")) return "🗣️";
  if (x.includes("BOOK") || x.includes("CLASS")) return "📅";
  if (x.includes("GENERAL")) return "❓";
  return "✉️";
}

function prettyLabel(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}


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

  if (!cleaned) return <div className="emailEmpty">(No message body)</div>;

  const paragraphs = cleaned.split(/\n\s*\n/g);

  return (
    <div className="emailViewer">
      <div className="emailPaper">
        {paragraphs.map((p, i) => (
          <p key={i} className="emailPara">
            <LinkifiedText text={p.trim()} />
          </p>
        ))}
      </div>
    </div>
  );
}


// Ensure UI title is 2-3 words max (defensive)
function shortTitle(t) {
  if (!t) return "";
  const words = String(t).trim().split(/\s+/).filter(Boolean).slice(0, 3);
  return words.join(" ");
}

function urgencyRank(u) {
  const x = String(u || "").toUpperCase();
  if (x === "CRITICAL" || x === "URGENT" || x === "HIGH") return 3;
  if (x === "MEDIUM") return 2;
  if (x === "LOW") return 1;
  return 0; // NONE/unknown
}

function safeTime(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
}

function uniqueSorted(arr) {
  return Array.from(new Set(arr.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}


export default function App() {
  const API = apiBase();

  const [me, setMe] = useState(null);
  const [emails, setEmails] = useState([]);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  // Filters + sorting
  const [filterUrgency, setFilterUrgency] = useState("ALL");   // HIGH | MEDIUM | LOW | NONE | ALL
  const [filterCategory, setFilterCategory] = useState("ALL"); // e.g. BILLING_PAYMENT | ... | ALL
  const [sortBy, setSortBy] = useState("DATE_DESC");           // DATE_DESC, DATE_ASC, URGENCY_DESC, ...


  // for auto-scrolling to new emails or open email details
  const emailViewRef = useRef(null);

  // kept, but no longer shown in UI
  const [health, setHealth] = useState({ ok: false, ollamaOk: null, model: null });

  // prevent repeated auto-syncs
  const [didInitialSync, setDidInitialSync] = useState(false);

  const authed = useMemo(() => !!me?.user, [me]);

  const urgencyOptions = useMemo(() => {
    // Show common choices even if missing in current batch
    return ["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"];
  }, []);

  const categoryOptions = useMemo(() => {
    const cats = emails.map((e) => e.ai?.category || "").filter(Boolean);
    return ["ALL", ...uniqueSorted(cats)];
  }, [emails]);

  const visibleEmails = useMemo(() => {
    // 1) filter
    let list = emails.filter((e) => {
      const u = String(e.ai?.urgency || "").toUpperCase();
      const c = String(e.ai?.category || "").toUpperCase();

      const urgencyOk =
        filterUrgency === "ALL"
          ? true
          : filterUrgency === "NONE"
            ? !u
            : u === filterUrgency;

      const categoryOk =
        filterCategory === "ALL"
          ? true
          : c === String(filterCategory).toUpperCase();

      return urgencyOk && categoryOk;
    });

    // 2) sort
    const cmp = (a, b) => {
      const au = urgencyRank(a.ai?.urgency);
      const bu = urgencyRank(b.ai?.urgency);

      const ad = safeTime(a.dateIso);
      const bd = safeTime(b.dateIso);

      const ac = String(a.ai?.category || "");
      const bc = String(b.ai?.category || "");

      const acon = typeof a.ai?.confidence === "number" ? a.ai.confidence : -1;
      const bcon = typeof b.ai?.confidence === "number" ? b.ai.confidence : -1;

      const afrom = String(a.fromEmail || "");
      const bfrom = String(b.fromEmail || "");

      const asub = String(a.subject || "");
      const bsub = String(b.subject || "");

      switch (sortBy) {
        case "DATE_ASC":
          return ad - bd;

        case "URGENCY_DESC":
          return bu - au || bd - ad; // tie-breaker by newest
        case "URGENCY_ASC":
          return au - bu || bd - ad;

        case "CATEGORY_ASC":
          return ac.localeCompare(bc) || bd - ad;
        case "CATEGORY_DESC":
          return bc.localeCompare(ac) || bd - ad;

        case "CONF_DESC":
          return bcon - acon || bd - ad;
        case "CONF_ASC":
          return acon - bcon || bd - ad;

        case "FROM_ASC":
          return afrom.localeCompare(bfrom) || bd - ad;
        case "SUBJECT_ASC":
          return asub.localeCompare(bsub) || bd - ad;

        case "DATE_DESC":
        default:
          return bd - ad;
      }
    };

    return [...list].sort(cmp);
  }, [emails, filterUrgency, filterCategory, sortBy]);


  // scroll to top when selecting a new email
  useEffect(() => {
    const key = selected?.gmailId || selected?.id;
    if (!key) return;

    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    emailViewRef.current?.scrollTo?.({ top: 0, behavior: "auto" });
    if (emailViewRef.current) emailViewRef.current.scrollTop = 0;
  }, [selected?.gmailId, selected?.id]);

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

  async function deleteEmail(gmailId) {
    setLoading(true);
    try {
      await apiFetch(`/api/emails/${gmailId}`, { method: "DELETE", timeoutMs: 30000 });

      // update UI list
      setEmails((prev) => prev.filter((e) => e.gmailId !== gmailId));

      // if currently open, close it
      if (selected?.gmailId === gmailId || selected?.id === gmailId) {
        setSelected(null);
      }

      setStatus("Email deleted.");
    } catch (e) {
      setStatus(`Delete error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function clearAllEmails() {
    const ok = window.confirm("Clear ALL stored emails for this user? This cannot be undone.");
    if (!ok) return;

    setLoading(true);
    try {
      const res = await apiFetch("/api/emails", { method: "DELETE", timeoutMs: 60000 });
      setEmails([]);
      setSelected(null);
      setStatus(`Cleared ${res.deleted || 0} emails.`);
    } catch (e) {
      setStatus(`Clear-all error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Auto-sync once after login
  useEffect(() => {
    if (!authed) return;

    // Load whatever is already in Firestore right away
    refreshEmails().catch(() => { });

    if (didInitialSync) return;

    (async () => {
      setLoading(true);
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

        await refreshEmails();
      } catch (e) {
        setStatus(`Error: ${e.message}`);
      } finally {
        setLoading(false);
        setDidInitialSync(true);
      }
    })();
  }, [authed, didInitialSync]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <p className="small">Connect your Gmail (readonly), triage messages, and draft replies using local AI (Ollama).</p>

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
            <button onClick={logout}>Logout</button>
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={clearAllEmails} disabled={loading || emails.length === 0}>
              Clear all
            </button>
          </div>
        </div>

        <h3 style={{ marginTop: 16, marginBottom: 8 }}>Inbox</h3>
        <div className="card" style={{ marginTop: 10 }}>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="small"><b>Filter: Priority</b></div>
              <select value={filterUrgency} onChange={(e) => setFilterUrgency(e.target.value)}>
                {urgencyOptions.map((u) => (
                  <option key={u} value={u}>
                    {u === "ALL" ? "All" : u === "NONE" ? "None/Unknown" : prettyLabel(u)}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="small"><b>Filter: Type</b></div>
              <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
                {categoryOptions.map((c) => (
                  <option key={c} value={c}>
                    {c === "ALL" ? "All" : prettyLabel(c)}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="small"><b>Sort</b></div>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="DATE_DESC">Newest</option>
                <option value="DATE_ASC">Oldest</option>
                <option value="URGENCY_DESC">Priority (High → Low)</option>
                <option value="URGENCY_ASC">Priority (Low → High)</option>
                <option value="CATEGORY_ASC">Type (A → Z)</option>
                <option value="CATEGORY_DESC">Type (Z → A)</option>
                <option value="CONF_DESC">Confidence (High → Low)</option>
                <option value="CONF_ASC">Confidence (Low → High)</option>
                <option value="FROM_ASC">Sender (A → Z)</option>
                <option value="SUBJECT_ASC">Subject (A → Z)</option>
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setFilterUrgency("ALL");
                  setFilterCategory("ALL");
                  setSortBy("DATE_DESC");
                }}
              >
                Reset
              </button>
            </div>
          </div>

          <div className="small" style={{ marginTop: 10 }}>
            Showing <b>{visibleEmails.length}</b> of <b>{emails.length}</b>
          </div>
        </div>

        <div className="list">
          {emails.length === 0 ? (
            <div className="small">{loading ? "Loading inbox…" : "No unread emails found."}</div>
          ) : (
            visibleEmails.map((e) => {

              const displayTitle =
                shortTitle(e.aiSummary?.title) || e.subject || "(no subject)";

              return (
                <button className="listItem" key={e.gmailId} onClick={() => openEmail(e.gmailId)}>
                  <div className="row" style={{ alignItems: "flex-start" }}>
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation(); // prevent opening email
                        deleteEmail(e.gmailId);
                      }}
                      disabled={loading}
                    >
                      Delete
                    </button>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="emailTitle" title={displayTitle}>
                        {displayTitle}
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
                      {e.ai?.category && (
                        <Pill tone={categoryTone(e.ai.category)} title="Category">
                          {categoryIcon(e.ai.category)} {prettyLabel(e.ai.category)}
                        </Pill>
                      )}
                      {e.ai?.urgency && (
                        <Pill tone={urgencyTone(e.ai.urgency)} title="Urgency">
                          {urgencyIcon(e.ai.urgency)} {prettyLabel(e.ai.urgency)}
                        </Pill>
                      )}
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
              );
            })
          )}
        </div>

        {status ? <div className="small" style={{ marginTop: 10 }}>{status}</div> : null}
      </div>

      <div className="main" ref={emailViewRef}>
        {!selected ? (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Select an email</h2>
            <p className="small">Pick an email on the left to see the AI result and draft reply.</p>
          </div>
        ) : (
          <div className="card">
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <h2 style={{ marginTop: 0, marginBottom: 6 }}>
                  {shortTitle(selected.aiSummary?.title) || selected.subject || "(no subject)"}
                </h2>

                <div className="small">
                  <b>From:</b> {selected.fromEmail}
                </div>
                <div className="small">
                  <b>Date:</b> {selected.dateIso || "(unknown)"}
                </div>

                {selected.aiSummary?.title ? (
                  <div className="small" style={{ marginTop: 6 }}>
                    <b>Original subject:</b> {selected.subject || "(no subject)"}
                  </div>
                ) : null}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                {selected.ai?.category && (
                  <Pill tone={categoryTone(selected.ai.category)} title="Category">
                    {categoryIcon(selected.ai.category)} {prettyLabel(selected.ai.category)}
                  </Pill>
                )}
                {selected.ai?.urgency && (
                  <Pill tone={urgencyTone(selected.ai.urgency)} title="Urgency">
                    {urgencyIcon(selected.ai.urgency)} {prettyLabel(selected.ai.urgency)}
                  </Pill>
                )}
                {typeof selected.ai?.confidence === "number" && (
                  <Pill tone="neutral" title="Model confidence">
                    🎯 {percent(selected.ai.confidence)}
                  </Pill>
                )}

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

              <button
                onClick={() => deleteEmail(selected.gmailId || selected.id)}
                disabled={loading}
              >
                Delete email
              </button>
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
