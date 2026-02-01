import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";

/**
 * Configures Passport Google OAuth.
 * Stores user + tokens in Firestore.
 */
export function configureAuth({ firestore, google }) {
  // Store Firestore user doc id in the session cookie
  passport.serializeUser((user, done) => done(null, user.id));

  // Load user doc from Firestore on each request
  passport.deserializeUser(async (id, done) => {
    try {
      const snap = await firestore.collection("users").doc(id).get();
      if (!snap.exists) return done(null, null);
      done(null, { id: snap.id, ...snap.data() });
    } catch (err) {
      done(err);
    }
  });

  passport.use(
    new GoogleStrategy(
      {
        clientID: google.clientId,
        clientSecret: google.clientSecret,
        callbackURL: google.callbackUrl
      },
      async (accessToken, refreshToken, params, profile, done) => {
        try {
          const googleId = profile.id;
          const email = profile.emails?.[0]?.value || null;
          const displayName = profile.displayName || null;

          // Token expiry timestamp (ms)
          const tokenExpiry = params.expires_in
            ? Date.now() + params.expires_in * 1000
            : null;

          // Find existing user by googleId
          const usersRef = firestore.collection("users");
          const q = await usersRef.where("googleId", "==", googleId).limit(1).get();

          if (q.empty) {
            // Create new user doc
            const docRef = await usersRef.add({
              googleId,
              email,
              displayName,
              accessToken,
              refreshToken: refreshToken || null,
              tokenExpiry,
              createdAt: Date.now()
            });

            return done(null, { id: docRef.id, googleId, email, displayName });
          }

          // Update existing user doc
          const doc = q.docs[0];
          const existing = doc.data();

          await doc.ref.update({
            email,
            displayName,
            accessToken,
            // Google might only return refreshToken the first time.
            refreshToken: refreshToken || existing.refreshToken || null,
            tokenExpiry,
            updatedAt: Date.now()
          });

          return done(null, { id: doc.id, googleId, email, displayName });
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  return passport;
}
