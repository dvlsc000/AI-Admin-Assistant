import express from "express";
import { makeOAuthClient, fetchLatestEmails } from "./gmail.js";
import { triageEmail } from "./ai.js";

/**
 * Firestore layout:
 * users/{userId}
 * users/{userId}/emails/{gmailId}
 */
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
   * Sync:
   * 1) Fetch latest Gmail inbox emails (readonly)
   * 2) Store in Firestore
   * 3) If AI result missing -> call Ollama -> store result
   */
  router.post("/emails/sync", requireAuth, async (req, res) => {
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

      const emails = await fetchLatestEmails({ oauth2Client, maxResults: 10 });

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
        }

        const after = await docRef.get();
        const data = after.data();

        if (!data.ai) {
          const triage = await triageEmail({
            email: e,
            ollamaBaseUrl: env.OLLAMA_BASE_URL,
            model: env.OLLAMA_MODEL
          });

          await docRef.update({
            ai: { ...triage, createdAt: Date.now() }
          });

          triaged++;
        }
      }

      res.json({ ok: true, fetched: emails.length, created, triaged });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Sync failed", details: err.message });
    }
  });

  /**
   * List latest 50 emails
   */
  router.get("/emails", requireAuth, async (req, res) => {
    const user = req.user;
    const emailsRef = firestore.collection("users").doc(user.id).collection("emails");

    // Reliable ordering: createdAt is always set
    const snap = await emailsRef.orderBy("createdAt", "desc").limit(50).get();
    const emails = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    res.json({ emails });
  });

  /**
   * Get one email by gmailId
   */
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
