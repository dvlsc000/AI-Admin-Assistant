import express from "express";
import { makeOAuthClient, fetchLatestEmails } from "./gmail.js";
import { triageEmail } from "./ai.js";

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
   * Sync ONLY unread emails from Gmail:
   * labelIds: INBOX + UNREAD
   */
  router.post("/emails/sync", requireAuth, async (req, res) => {
    const startedAt = Date.now();

    try {
      const user = req.user;

      const oauth2Client = makeOAuthClient({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: env.GOOGLE_CALLBACK_URL,
        tokens: {
          access_token: user.accessToken,
          refresh_token: user.refreshToken || undefined
        }
      });

      // Increase this later if you want (20/50)
      const MAX_RESULTS = 20;

      const emails = await fetchLatestEmails({
        oauth2Client,
        maxResults: MAX_RESULTS,
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
          // Update unread flag/labels in case it changed
          await docRef.update({
            isUnread: e.isUnread,
            labelIds: e.labelIds,
            updatedAt: Date.now()
          });
        }

        const after = await docRef.get();
        const data = after.data();

        // Only triage if AI missing
        if (!data.ai) {
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
        }
      }

      const ms = Date.now() - startedAt;

      res.json({
        ok: true,
        fetched: emails.length,
        created,
        triaged,
        durationMs: ms
      });
    } catch (err) {
      console.error("SYNC ERROR ❌", err);
      res.status(500).json({ error: "Sync failed", details: err.message || String(err) });
    }
  });

  /**
   * List emails.
   * Default: return ONLY unread emails.
   * You can also call /api/emails?unread=false to show all.
   */
  router.get("/emails", requireAuth, async (req, res) => {
    const user = req.user;
    const unreadOnly = req.query.unread !== "false"; // default true

    const emailsRef = firestore.collection("users").doc(user.id).collection("emails");

    let query = emailsRef.orderBy("createdAt", "desc").limit(50);

    if (unreadOnly) {
      query = emailsRef.where("isUnread", "==", true).orderBy("createdAt", "desc").limit(50);
    }

    const snap = await query.get();
    const emails = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    res.json({ emails });
  });

  router.get("/emails/:gmailId", requireAuth, async (req, res) => {
    const user = req.user;
    const gmailId = req.params.gmailId;

    const doc = await firestore
      .collection("users")
      .doc(user.id)
      .collection("emails")
      .doc(gmailId)
      .get();

    if (!doc.exists) return res.status(404).json({ error: "Not found" });

    res.json({ email: { id: doc.id, ...doc.data() } });
  });

  router.post("/logout", (req, res) => {
    req.logout(() => {
      req.session.destroy(() => res.json({ ok: true }));
    });
  });

  return router;
}
