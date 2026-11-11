/**
 * The Firebase project used for optional accounts. These values are not secret: every Firebase web
 * app ships them to the browser, and the Firestore rules (firestore.rules) are what keep each
 * player's data to themselves. Leave apiKey empty to turn accounts off; the game works the same
 * without them. Each can also be set at build time with a VITE_FIREBASE_* variable.
 */
const env = import.meta.env as Record<string, string | undefined>;

export const FIREBASE_CONFIG = {
  apiKey: env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? '',
  appId: env.VITE_FIREBASE_APP_ID ?? '',
};
