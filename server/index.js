import "dotenv/config";
import express from "express";
import cors from "cors";
import session from "express-session";
import passport from "passport";

import { initFirestore } from "./firestore.js";
import { configureAuth } from "./auth.js";
import { makeRoutes } from "./routes.js";

const env = process.env;

function requireEnv(name) {
  if (!env[name]) throw new Error(`Missing env var: ${name}`);
}

requireEnv("PORT");
requireEnv("SESSION_SECRET");
requireEnv("CLIENT_URL");

requireEnv("GOOGLE_CLIENT_ID");
requireEnv("GOOGLE_CLIENT_SECRET");
requireEnv("GOOGLE_CALLBACK_URL");

requireEnv("FIREBASE_SERVICE_ACCOUNT_PATH");

requireEnv("OLLAMA_BASE_URL");
requireEnv("OLLAMA_MODEL");

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true
  })
);

app.use(
  session({
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax"
    }
  })
);

// Firestore
const firestore = initFirestore(env.FIREBASE_SERVICE_ACCOUNT_PATH);

// Auth
configureAuth({
  firestore,
  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackUrl: env.GOOGLE_CALLBACK_URL
  }
});

app.use(passport.initialize());
app.use(passport.session());

// OAuth start
app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: [
      "profile",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly"
    ],
    accessType: "offline",
    prompt: "consent"
  })
);

// OAuth callback
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    // Server-only: go back to home
    res.redirect("/");
  }
);

// API
app.use("/api", makeRoutes({ firestore, env }));

/**
 * Simple server-only UI (no frontend needed)
 */
app.get("/", (req, res) => {
  const user = req.user;

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!user) {
    return res.end(`
      <h2>AI Admin Assistant (Server Only)</h2>
      <p>Status: <b>Not logged in</b></p>
      <p><a href="/auth/google">Login with Google</a></p>
      <hr/>
      <p>After login, click Sync to fetch emails + generate drafts with <b>Ollama</b>.</p>
    `);
  }

  return res.end(`
    <h2>AI Admin Assistant (Server Only)</h2>
    <p>Status: <b>Logged in</b></p>
    <p>User: ${user.email || "(no email)"} </p>

    <hr/>

    <form action="/api/emails/sync" method="post">
      <button type="submit">Sync Inbox + Generate Drafts (Ollama)</button>
    </form>

    <p style="margin-top:10px;">
      View emails JSON: <a href="/api/emails">/api/emails</a>
    </p>

    <form action="/api/logout" method="post" style="margin-top:16px;">
      <button type="submit">Logout</button>
    </form>
  `);
});

app.listen(Number(env.PORT), () => {
  console.log(`Server running: http://localhost:${env.PORT}`);
  console.log(`Login:          http://localhost:${env.PORT}/auth/google`);
  console.log(`Ollama:         ${env.OLLAMA_BASE_URL} (model: ${env.OLLAMA_MODEL})`);
});
