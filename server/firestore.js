import admin from "firebase-admin";
import fs from "fs";

/**
 * Initialize Firebase Admin SDK for Firestore.
 * Uses a local service account JSON file (never commit this file).
 */
export function initFirestore(serviceAccountPath) {
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(
      `Firebase service account JSON not found at: ${serviceAccountPath}\n` +
      `Download from Firebase Console -> Project Settings -> Service accounts -> Generate new private key`
    );
  }

  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8"));

  // Avoid double-initialization when using nodemon
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}
