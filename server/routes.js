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
   * - Fetch latest Gmail inbox messages
   * - Store them in Firestore
   * - If AI missing, call Ollama and store result
   *
   * IMPORTANT: For reliability during development, default maxResults to 1.
   * You can change to 5/10 once everything is stable.
   */
  router.post("/emails/sync", requireAuth, async (req, res) => {
    const startedAt = Date.now();

    try {
      const user = req.user;
      console.log("SYNC START ✅ user:", user.email);

      const oauth2Client = makeOAuthClient({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: env.GOOGLE_CALLBACK_URL,
        tokens: {
          access_token: user.accessToken,
          refresh_token: user.refreshToken || undefined
        }
      });

      // Keep it fast while debugging. Change to 5 or 10 later.
      const MAX_RESULTS = 1;

      console.log("Fetching emails from Gmail… maxResults =", MAX_RESULTS);
      const emails = await fetchLatestEmails({ oauth2Client, maxResults: MAX_RESULTS });
      console.log("Fetched from Gmail ✅ count:", emails.length);

      const emailsRef = firestore.collection("users").doc(user.id).collection("emails");

      let created = 0;
      let triaged = 0;

      for (const e of emails) {
        console.log("Processing email:", e.subject || "(no subject)", "|", e.gmailId);

        const docRef = emailsRef.doc(e.gmailId);
        const snap = await docRef.get();

        if (!snap.exists) {
          await docRef.set({
            ...e,
            createdAt: Date.now(),
            ai: null
          });
          created++;
          console.log("Saved new email ✅");
        }

        const after = await docRef.get();
        const data = after.data();

        if (!data.ai) {
          console.log("Calling Ollama…");
          const triage = await triageEmail({
            email: e,
            ollamaBaseUrl: env.OLLAMA_BASE_URL,
            model: env.OLLAMA_MODEL,
            timeoutMs: 60000,
            maxChars: 1500
          });
          console.log("Ollama done ✅", triage.category, triage.urgency);

          await docRef.update({
            ai: { ...triage, createdAt: Date.now() }
          });

          triaged++;
          console.log("Saved AI result ✅");
        } else {
          console.log("AI already exists — skipping ✅");
        }
      }

      const ms = Date.now() - startedAt;
      console.log(`SYNC DONE ✅ in ${ms}ms`);

      res.json({
        ok: true,
        fetched: emails.length,
        created,
        triaged,
        durationMs: ms
      });
    } catch (err) {
      console.error("SYNC ERROR ❌", err);

      // Return a clear message to the frontend
      res.status(500).json({
        error: "Sync failed",
        details: err.message || String(err)
      });
    }
  });

  /**
   * List latest emails (latest 50)
   */
  router.get("/emails", requireAuth, async (req, res) => {
    const user = req.user;
    const emailsRef = firestore.collection("users").doc(user.id).collection("emails");

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
