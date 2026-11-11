import { FIREBASE_CONFIG } from './firebase-config.ts';

/**
 * Optional accounts: sign in with Google or with an email and password to keep your name, class and
 * lifetime stats in the cloud, so they follow you to any browser. Playing as a guest needs none of this.
 *
 * The Firebase SDK is loaded from Google's CDN only when accounts are switched on, so it adds nothing
 * to the game's own download and needs no install.
 */

const SDK = 'https://www.gstatic.com/firebasejs/11.10.0';

export interface AccountUser {
  uid: string;
  name: string; // the name on the account (Google name, or the email before the @)
  email: string;
  photo: string; // picture address, or empty
}

/** What is kept for each player, in the Firestore document players/{uid}. */
export interface Profile {
  nickname?: string;
  primary?: number;
  career?: unknown;
}

/* The small part of the Firebase SDK this file uses. */
interface FbUser {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
}
interface AuthMod {
  getAuth(app: unknown): unknown;
  onAuthStateChanged(auth: unknown, cb: (u: FbUser | null) => void): void;
  GoogleAuthProvider: new () => unknown;
  signInWithPopup(auth: unknown, provider: unknown): Promise<unknown>;
  signInWithEmailAndPassword(auth: unknown, email: string, password: string): Promise<unknown>;
  createUserWithEmailAndPassword(auth: unknown, email: string, password: string): Promise<unknown>;
  sendPasswordResetEmail(auth: unknown, email: string): Promise<void>;
  signOut(auth: unknown): Promise<void>;
}
interface StoreMod {
  getFirestore(app: unknown): unknown;
  doc(db: unknown, path: string, id: string): unknown;
  getDoc(ref: unknown): Promise<{ exists(): boolean; data(): unknown }>;
  setDoc(ref: unknown, data: object, options: { merge: boolean }): Promise<void>;
  serverTimestamp(): unknown;
}

const load = (file: string): Promise<unknown> => import(/* @vite-ignore */ `${SDK}/${file}`);

/** A message a player can act on, for the Firebase error codes people actually hit. */
export function friendlyError(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  switch (code) {
    case 'auth/invalid-email':
      return 'That email address doesn’t look right.';
    case 'auth/missing-password':
      return 'Enter a password.';
    case 'auth/weak-password':
      return 'Pick a password of at least 6 characters.';
    case 'auth/email-already-in-use':
      return 'There is already an account with that email. Sign in instead.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Wrong email or password.';
    case 'auth/too-many-requests':
      return 'Too many tries. Wait a minute and try again.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google window. Allow pop-ups for this site and try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return '';
    case 'auth/unauthorized-domain':
      return 'Sign-in isn’t allowed on this address yet (add it to Firebase’s authorized domains).';
    case 'auth/operation-not-allowed':
      return 'That way of signing in isn’t switched on in Firebase yet.';
    case 'auth/network-request-failed':
      return 'Couldn’t reach the sign-in service. Check your connection.';
    default:
      return 'Something went wrong signing in. Try again.';
  }
}

export class Account {
  /** False when no Firebase project is configured: the sign-in button is hidden and everyone plays as a guest. */
  readonly enabled = FIREBASE_CONFIG.apiKey !== '';
  user: AccountUser | null = null;
  private auth: AuthMod | null = null;
  private store: StoreMod | null = null;
  private authInst: unknown = null;
  private db: unknown = null;
  private ready: Promise<void> | null = null;
  private listeners: Array<(u: AccountUser | null) => void> = [];

  /** Called with the signed-in player whenever that changes (null for a guest), starting with the saved sign-in, if any. */
  onChange(cb: (u: AccountUser | null) => void): void {
    this.listeners.push(cb);
  }

  /** Load Firebase and pick up a sign-in kept from a previous visit. Safe to call more than once. */
  start(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.ready ??= (async () => {
      const [appMod, auth, store] = (await Promise.all([load('firebase-app.js'), load('firebase-auth.js'), load('firebase-firestore.js')])) as [
        { initializeApp(c: object): unknown },
        AuthMod,
        StoreMod,
      ];
      const app = appMod.initializeApp(FIREBASE_CONFIG);
      this.auth = auth;
      this.store = store;
      this.authInst = auth.getAuth(app);
      this.db = store.getFirestore(app);
      auth.onAuthStateChanged(this.authInst, (u) => {
        this.user = u
          ? { uid: u.uid, name: u.displayName || (u.email ?? '').split('@')[0] || 'Player', email: u.email ?? '', photo: u.photoURL ?? '' }
          : null;
        for (const cb of this.listeners) cb(this.user);
      });
    })();
    return this.ready;
  }

  private async need(): Promise<AuthMod> {
    await this.start();
    if (!this.auth) throw new Error('accounts are not available');
    return this.auth;
  }

  async google(): Promise<void> {
    const a = await this.need();
    await a.signInWithPopup(this.authInst, new a.GoogleAuthProvider());
  }

  async signIn(email: string, password: string): Promise<void> {
    const a = await this.need();
    await a.signInWithEmailAndPassword(this.authInst, email.trim(), password);
  }

  async create(email: string, password: string): Promise<void> {
    const a = await this.need();
    await a.createUserWithEmailAndPassword(this.authInst, email.trim(), password);
  }

  async resetPassword(email: string): Promise<void> {
    const a = await this.need();
    await a.sendPasswordResetEmail(this.authInst, email.trim());
  }

  async signOut(): Promise<void> {
    const a = await this.need();
    await a.signOut(this.authInst);
  }

  /** The saved profile of the signed-in player, or null if they have none yet (a new account). */
  async loadProfile(): Promise<Profile | null> {
    if (!this.user || !this.store) return null;
    const snap = await this.store.getDoc(this.store.doc(this.db, 'players', this.user.uid));
    return snap.exists() ? (snap.data() as Profile) : null;
  }

  /** Save (merge) part of the signed-in player's profile. Does nothing for a guest. */
  async saveProfile(p: Profile): Promise<void> {
    if (!this.user || !this.store) return;
    await this.store.setDoc(this.store.doc(this.db, 'players', this.user.uid), { ...p, updated: this.store.serverTimestamp() }, { merge: true });
  }
}
