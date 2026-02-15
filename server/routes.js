import express from "express";
import { makeOAuthClient, fetchLatestEmails } from "./gmail.js";
import { triageEmail, summarizeEmail } from "./ai.js";

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

  router.get(
    "/health",
    asyncHandler(async (req, res) => {
      const ollamaOk = await checkOllamaQuick({ baseUrl: env.OLLAMA_BASE_URL });
      res.json({ ok: true, ollamaOk, model: env.OLLAMA_MODEL });
    })
  );

  router.post(
  "/ai/test",
  asyncHandler(async (req, res) => {
    const email = {
      fromEmail: req.body?.fromEmail || "member@example.com",
      subject: req.body?.subject || "Test email",
      snippet: req.body?.message || "",
      bodyText: req.body?.message || "",
      cleanBodyText: req.body?.message || ""
    };

    const triage = await triageEmail({
      email,
      ollamaBaseUrl: env.OLLAMA_BASE_URL,
      model: env.OLLAMA_MODEL,
      timeoutMs: 60000,
      maxChars: 2000
    });

    res.json({ ok: true, triage });
  })
);

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
      const SUMMARY_THRESHOLD = 900; // chars: when to auto-summarize

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
      let summarized = 0;
      let aiErrors = 0;

      for (const e of emails) {
        const docRef = emailsRef.doc(e.gmailId);
        const snap = await docRef.get();

        if (!snap.exists) {
          await docRef.set({
            ...e,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ai: null,
            aiSummary: null
          });
          created++;
        } else {
          await docRef.update({
            isUnread: e.isUnread,
            labelIds: e.labelIds,
            // Keep latest cleaned text in case Gmail formatting changed
            cleanBodyText: e.cleanBodyText,
            snippet: e.snippet,
            updatedAt: Date.now()
          });
        }

        const after = await docRef.get();
        const data = after.data();

        // summary if long and not yet summarized
        const msg = (e.cleanBodyText || e.bodyText || e.snippet || "").trim();
        if (!data.aiSummary && msg.length > SUMMARY_THRESHOLD) {
          try {
            const sum = await summarizeEmail({
              email: e,
              ollamaBaseUrl: env.OLLAMA_BASE_URL,
              model: env.OLLAMA_MODEL,
              timeoutMs: 45000,
              maxChars: 4000
            });
            await docRef.update({ aiSummary: { ...sum, createdAt: Date.now() } });
            summarized++;
          } catch (err) {
            aiErrors++;
            await docRef.update({
              aiSummary: {
                title: "",
                summary: "",
                key_points: [],
                error: String(err?.message || err),
                createdAt: Date.now()
              }
            });
          }
        }

        // triage only if missing
        if (!data.ai || !data.ai.reply_draft || data.ai.error) {
          try {
            const triage = await triageEmail({
              email: e,
              ollamaBaseUrl: env.OLLAMA_BASE_URL,
              model: env.OLLAMA_MODEL,
              timeoutMs: 60000,
              maxChars: 1500
            });

            await docRef.update({ ai: { ...triage, createdAt: Date.now() } });
            triaged++;
          } catch (err) {
            aiErrors++;
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
        summarized,
        aiErrors,
        durationMs: Date.now() - startedAt
      });
    })
  );

  router.get(
    "/emails",
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user;
      const unreadOnly = req.query.unread !== "false";

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

      await markEmailAsRead({ oauth2Client, gmailId });

      if (!snap.exists) return res.status(404).json({ error: "Email not found" });

      res.json({ email: { id: snap.id, ...snap.data() } });
    })
  );

  // Delete ONE email doc
router.delete(
  "/emails/:gmailId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const { gmailId } = req.params;

    const docRef = firestore.collection("users").doc(user.id).collection("emails").doc(gmailId);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Email not found" });

    await docRef.delete();
    res.json({ ok: true, deleted: gmailId });
  })
);

// Delete ALL emails for this user (batched)
router.delete(
  "/emails",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const emailsRef = firestore.collection("users").doc(user.id).collection("emails");

    const BATCH_SIZE = 400; // keep under Firestore 500 limit
    let deleted = 0;

    while (true) {
      const snap = await emailsRef.limit(BATCH_SIZE).get();
      if (snap.empty) break;

      const batch = firestore.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();

      deleted += snap.size;

      // safety: if fewer than batch size, we're done
      if (snap.size < BATCH_SIZE) break;
    }

    res.json({ ok: true, deleted });
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
