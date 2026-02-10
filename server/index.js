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
      // If you deploy with HTTPS on a different domain, use:
      // sameSite: "none",
      // secure: true
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
    scope: ["profile", "email", "https://www.googleapis.com/auth/gmail.readonly"],
    accessType: "offline",
    prompt: "consent"
  })
);

// OAuth callback
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    // IMPORTANT: send user back to the frontend
    res.redirect(env.CLIENT_URL);
  }
);

// API
app.use("/api", makeRoutes({ firestore, env }));

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Backend is running. Go to your frontend to use the app.");
});

app.listen(Number(env.PORT), () => {
  console.log(`Server running: http://localhost:${env.PORT}`);
  console.log(`Frontend:       ${env.CLIENT_URL}`);
  console.log(`Login:          http://localhost:${env.PORT}/auth/google`);
  console.log(`Ollama:         ${env.OLLAMA_BASE_URL} (model: ${env.OLLAMA_MODEL})`);
});
