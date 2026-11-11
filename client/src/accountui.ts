import { friendlyError } from './account.ts';
import type { Account, AccountUser } from './account.ts';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

/** The sign-in button in the menu's top bar, the "playing as guest" note, and the sign-in window. */
export class AccountUI {
  private mode: 'create' | 'signin' = 'create';
  private busy = false;
  private root = $('auth');
  private msg = $('auth-msg');
  private email = $('auth-email') as HTMLInputElement;
  private pass = $('auth-pass') as HTMLInputElement;
  private submit = $('auth-submit') as HTMLButtonElement;
  private btn = $('acct-btn') as HTMLButtonElement;

  constructor(private account: Account) {
    if (!account.enabled) {
      // No Firebase project configured: everyone is a guest and nothing about accounts is shown.
      this.btn.hidden = true;
      $('guest-note').hidden = true;
      return;
    }
    this.btn.addEventListener('click', () => this.open());
    $('guest-signin').addEventListener('click', () => this.open());
    $('auth-close').addEventListener('click', () => this.close());
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.root.hidden) this.close();
    });
    for (const b of Array.from(this.root.querySelectorAll<HTMLButtonElement>('.atabs button'))) {
      b.addEventListener('click', () => this.setMode(b.dataset.m === 'signin' ? 'signin' : 'create'));
    }
    $('auth-google').addEventListener('click', () => this.run(() => account.google()));
    $('auth-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = this.email.value;
      const pass = this.pass.value;
      void this.run(() => (this.mode === 'create' ? account.create(email, pass) : account.signIn(email, pass)));
    });
    $('auth-forgot').addEventListener('click', () => {
      if (!this.email.value.trim()) return this.say('Enter your email above first, then press "Forgot password?".', true);
      void this.run(async () => {
        await account.resetPassword(this.email.value);
        this.say('Check your inbox for a link to set a new password.', false);
      }, false);
    });
    $('auth-signout').addEventListener('click', () => void this.run(() => account.signOut(), false));
    // Typing in the window must not reach the game's own key handling.
    for (const input of [this.email, this.pass]) input.addEventListener('keydown', (e) => e.stopPropagation());
    this.setMode('create');
    this.setUser(null);
  }

  /** Show who is signed in (or that you are a guest) in the top bar and the window. */
  setUser(u: AccountUser | null): void {
    if (!this.account.enabled) return;
    $('auth-out').hidden = u !== null;
    $('auth-in').hidden = u === null;
    $('guest-note').hidden = u !== null;
    $('auth-title').textContent = u ? 'Your account' : 'Save your progress';
    ($('auth-close') as HTMLButtonElement).textContent = u ? 'Done' : 'Keep playing as guest';
    this.btn.replaceChildren();
    this.btn.classList.toggle('in', u !== null);
    if (u) {
      if (u.photo) {
        const img = document.createElement('img');
        img.src = u.photo;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        this.btn.append(img);
      } else {
        const initial = document.createElement('i');
        initial.textContent = u.name.slice(0, 1).toUpperCase();
        this.btn.append(initial);
      }
      const label = document.createElement('span');
      label.textContent = u.name;
      this.btn.append(label);
      $('auth-name').textContent = u.name;
      $('auth-email-shown').textContent = u.email;
      const photo = $('auth-photo') as HTMLImageElement;
      photo.hidden = !u.photo;
      if (u.photo) {
        photo.referrerPolicy = 'no-referrer';
        photo.src = u.photo;
      }
      this.say('', false);
      this.pass.value = '';
    } else {
      this.btn.textContent = 'Sign in';
    }
  }

  /** Firebase could not be loaded (offline, or blocked): say so in the window instead of failing silently. */
  setUnavailable(): void {
    this.say('Accounts can’t be reached right now. You can keep playing as a guest.', true);
  }

  open(): void {
    this.root.hidden = false;
    if (!this.account.user) setTimeout(() => this.email.focus(), 0);
  }

  close(): void {
    this.root.hidden = true;
  }

  private setMode(m: 'create' | 'signin'): void {
    this.mode = m;
    for (const b of Array.from(this.root.querySelectorAll<HTMLButtonElement>('.atabs button'))) b.classList.toggle('on', b.dataset.m === m);
    this.submit.textContent = m === 'create' ? 'Create account' : 'Sign in';
    this.pass.autocomplete = m === 'create' ? 'new-password' : 'current-password';
    ($('auth-forgot') as HTMLButtonElement).hidden = m === 'create';
    this.say('', false);
  }

  private say(text: string, error: boolean): void {
    this.msg.textContent = text;
    this.msg.className = error ? 'amsg bad' : 'amsg';
  }

  /** Run a sign-in action with the buttons disabled; close the window when it signs you in or out. */
  private async run(action: () => Promise<void>, closeAfter = true): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.root.classList.add('busy');
    this.say('', false);
    try {
      await action();
      if (closeAfter) this.close();
    } catch (err) {
      const text = friendlyError(err);
      if (text) this.say(text, true);
    } finally {
      this.busy = false;
      this.root.classList.remove('busy');
    }
  }
}
