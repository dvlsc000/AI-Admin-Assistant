import "dotenv/config";
import express from "express";
import cors from "cors";
import session from "express-session";
import passport from "passport";

import { initFirestore } from "./firestore.js";
import { configureAuth } from "./auth.js";
import { makeRoutes } from "./routes.js";
import { makeOpenAI } from "./ai.js";

const env = process.env;

if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.OPENAI_API_KEY) {
  console.warn("Warning: Missing env vars. Check your .env file.");
}

const app = express();
app.use(express.json());

// Server-only: we allow browser access from itself; also safe for later frontend.
app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true
  })
);

// Sessions store logged-in state (cookie)
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

// Init Firestore
const firestore = initFirestore(env.FIREBASE_SERVICE_ACCOUNT_PATH);

// Init OAuth strategy
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

// OAuth login route
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
    // Server-only: redirect back to server home page
    res.redirect("/");
  }
);

// OpenAI client
const openai = makeOpenAI(env.OPENAI_API_KEY);

// API routes
app.use("/api", makeRoutes({ firestore, openai, env }));

/**
 * Simple server-only home page so you can use the server without a frontend.
 */
app.get("/", (req, res) => {
  const user = req.user;
  res.setHeader("Content-Type", "text/html");

  if (!user) {
    return res.end(`
      <h2>Inbox Triage Server</h2>
      <p>Status: <b>Not logged in</b></p>
      <p><a href="/auth/google">Login with Google</a></p>
      <hr/>
      <p>After login, come back here and click Sync.</p>
    `);
  }

  return res.end(`
    <h2>Inbox Triage Server</h2>
    <p>Status: <b>Logged in</b></p>
    <p>User: ${user.email || "(no email)"} </p>
    <hr/>
    <form action="/api/emails/sync" method="post">
      <button type="submit">Sync Inbox + Generate Drafts</button>
    </form>
    <p>Then open: <a href="/api/emails">/api/emails</a></p>
    <form action="/api/logout" method="post" style="margin-top:12px;">
      <button type="submit">Logout</button>
    </form>
  `);
});

app.listen(env.PORT || 3001, () => {
  console.log(`Server running: http://localhost:${env.PORT || 3001}`);
  console.log(`Login here:     http://localhost:${env.PORT || 3001}/auth/google`);
});
