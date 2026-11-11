/**
 * The Firebase project used for optional accounts. These values are not secret: every Firebase web
 * app ships them to the browser, and the Firestore rules (firestore.rules) are what keep each
 * player's data to themselves. Each can be overridden at build time with a VITE_FIREBASE_* variable
 * (for example to point a fork at its own project); set VITE_FIREBASE_API_KEY=off to turn accounts off.
 */
const env = import.meta.env as Record<string, string | undefined>;

export const FIREBASE_CONFIG = {
  apiKey: env.VITE_FIREBASE_API_KEY === 'off' ? '' : (env.VITE_FIREBASE_API_KEY ?? 'AIzaSyCqsSLkqyebobjmm71Dij-I09rw1ByQoYA'),
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? 'hitscan-d91cf.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? 'hitscan-d91cf',
  appId: env.VITE_FIREBASE_APP_ID ?? '1:115753726433:web:c3db646cfb9ff610f2e2a0',
};
