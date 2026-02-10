import express from "express";
import { makeOAuthClient, fetchLatestEmails } from "./gmail.js";
import { triageEmail } from "./ai.js";

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function makeRoutes({ firestore, env }) {
  const router = express.Router();

  const requireAuth = (req, res, next) => {
    if (req.user) return next();
    return res.status(401).json({ error: "Not authenticated. Login at /auth/google" });
  };

  router.get("/me", (req, res) => {
    if (!req.user) return res.json({ user: null });
    const { id, email, displayName } = req.user;
    res.json({ user: { id, email, displayName } });
  });

  /**
   * Sync ONLY unread emails:
   * labelIds: INBOX + UNREAD
   */
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

      const emails = await fetchLatestEmails({
        oauth2Client,
        maxResults,
        labelIds: ["INBOX", "UNREAD"]
      });

      const emailsRef = firestore.collection("users").doc(user.id).collection("emails");

      let created = 0;
      let triaged = 0;

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
          // If Ollama fails for one email, don't brick the whole sync.
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
        durationMs: Date.now() - startedAt
      });
    })
  );

  /**
   * List emails.
   * Default unreadOnly=true.
   *
   * NOTE: We avoid `where + orderBy` (composite index) by fetching and sorting in memory.
   */
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

      // Ensure stable order
      emails.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      res.json({ emails });
    })
  );

  /**
   * Single email by Gmail ID
   */
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

  // Central error handler for this router
  router.use((err, req, res, next) => {
    console.error("API ERROR ❌", err);
    res.status(500).json({ error: "Server error", details: err?.message || String(err) });
  });

  return router;
}
