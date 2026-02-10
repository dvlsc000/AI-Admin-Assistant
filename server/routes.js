import express from "express";
import { makeOAuthClient, fetchLatestEmails } from "./gmail.js";
import { triageEmail } from "./ai.js";

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function checkOllamaQuick({ baseUrl, timeoutMs = 2000 }) {
  const url = baseUrl.replace(/\/$/, "") + "/api/tags";
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export function makeRoutes({ firestore, env }) {
  const router = express.Router();

  const requireAuth = (req, res, next) => {
    if (req.user) return next();
    return res.status(401).json({ error: "Not authenticated. Login at /auth/google" });
  };

  router.get("/health", asyncHandler(async (req, res) => {
    const ollamaOk = await checkOllamaQuick({ baseUrl: env.OLLAMA_BASE_URL });
    res.json({
      ok: true,
      ollamaOk,
      model: env.OLLAMA_MODEL
    });
  }));

  router.get("/me", (req, res) => {
    if (!req.user) return res.json({ user: null });
    const { id, email, displayName } = req.user;
    res.json({ user: { id, email, displayName } });
  });

  router.post(
    "/emails/sync",
    requireAuth,
    asyncHandler(async (req, res) => {
      const startedAt = Date.now();
      const user = req.user;

      const maxResults = Math.max(1, Math.min(Number(req.body?.maxResults ?? 20), 50));

      const oauth2Client = makeOAuthClient({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: env.GOOGLE_CALLBACK_URL,
        tokens: {
          access_token: user.accessToken,
          refresh_token: user.refreshToken || undefined
        }
      });

      const ollamaOk = await checkOllamaQuick({ baseUrl: env.OLLAMA_BASE_URL });
      if (!ollamaOk) {
        return res.status(503).json({
          error: "Ollama not reachable",
          details: `Cannot reach ${env.OLLAMA_BASE_URL}. Is Ollama running?`
        });
      }

      const emails = await fetchLatestEmails({
        oauth2Client,
        maxResults,
        labelIds: ["INBOX", "UNREAD"]
      });

      const emailsRef = firestore.collection("users").doc(user.id).collection("emails");

      let created = 0;
      let triaged = 0;
      let triageErrors = 0;

      for (const e of emails) {
        const docRef = emailsRef.doc(e.gmailId);
        const snap = await docRef.get();

        if (!snap.exists) {
          await docRef.set({
            ...e,
            createdAt: Date.now(),
            ai: null
          });
          created++;
        } else {
          await docRef.update({
            isUnread: e.isUnread,
            labelIds: e.labelIds,
            updatedAt: Date.now()
          });
        }

        const after = await docRef.get();
        const data = after.data();

        if (!data.ai) {
          try {
            const triage = await triageEmail({
              email: e,
              ollamaBaseUrl: env.OLLAMA_BASE_URL,
              model: env.OLLAMA_MODEL,
              timeoutMs: 60000,
              maxChars: 1500
            });

            await docRef.update({
              ai: { ...triage, createdAt: Date.now() }
            });

            triaged++;
          } catch (err) {
            triageErrors++;
            await docRef.update({
              ai: {
                category: "GENERAL_QUESTION",
                urgency: "LOW",
                confidence: 0.2,
                reply_draft: "Thanks for your email — we’ll take a look and get back to you shortly.",
                error: String(err?.message || err),
                createdAt: Date.now()
              }
            });

            triaged++;
          }
        }
      }

      res.json({
        ok: true,
        fetched: emails.length,
        created,
        triaged,
        triageErrors,
        durationMs: Date.now() - startedAt
      });
    })
  );

  router.get(
    "/emails",
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user;
      const unreadOnly = req.query.unread !== "false"; // default true

      const emailsRef = firestore.collection("users").doc(user.id).collection("emails");

      let snap;
      if (unreadOnly) {
        snap = await emailsRef.where("isUnread", "==", true).limit(50).get();
      } else {
        snap = await emailsRef.orderBy("createdAt", "desc").limit(50).get();
      }

      const emails = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      emails.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      res.json({ emails });
    })
  );

  router.get(
    "/emails/:gmailId",
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user;
      const { gmailId } = req.params;

      const docRef = firestore.collection("users").doc(user.id).collection("emails").doc(gmailId);
      const snap = await docRef.get();

      if (!snap.exists) return res.status(404).json({ error: "Email not found" });

      res.json({ email: { id: snap.id, ...snap.data() } });
    })
  );

  router.post("/logout", (req, res) => {
    req.logout(() => {
      req.session.destroy(() => res.json({ ok: true }));
    });
  });

  router.use((err, req, res, next) => {
    console.error("API ERROR ❌", err);
    res.status(500).json({ error: "Server error", details: err?.message || String(err) });
  });

  return router;
}
