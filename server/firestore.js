import admin from "firebase-admin";
import fs from "fs";

/**
 * Initializes Firebase Admin SDK and returns Firestore instance.
 * Uses the local service account JSON file.
 */
export function initFirestore(serviceAccountPath) {
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(
      `Firebase service account JSON not found at: ${serviceAccountPath}\n` +
      `Download it: Firebase Console -> Project settings -> Service accounts -> Generate new private key`
    );
  }

  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8"));

  // Avoid re-init in nodemon restarts
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}
