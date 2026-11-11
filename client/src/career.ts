/** Lifetime totals, kept in this browser only. They are for the menu's player card; the server never sees them. */
export interface Career {
  kills: number;
  deaths: number;
  headshots: number;
  wins: number;
  rounds: number;
}

const KEY = 'hitscan.career';
const EMPTY: Career = { kills: 0, deaths: 0, headshots: 0, wins: 0, rounds: 0 };

/** Cleans anything that looks like career totals (from storage or the cloud) into a Career. */
export function toCareer(raw: unknown): Career {
  const out = { ...EMPTY };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Partial<Record<keyof Career, unknown>>;
  for (const k of Object.keys(EMPTY) as Array<keyof Career>) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
  }
  return out;
}

/**
 * Two copies of the same account's totals (the cloud's, and this browser's, which may hold games played
 * while the save had not gone through yet) combined: totals only ever grow, so the larger of each wins.
 */
export function mergeCareer(a: Career, b: Career): Career {
  const out = { ...EMPTY };
  for (const k of Object.keys(EMPTY) as Array<keyof Career>) out[k] = Math.max(a[k], b[k]);
  return out;
}

/** The storage key for a signed-in account's totals in this browser; the guest's are under the plain key. */
const keyFor = (uid?: string): string => (uid ? `${KEY}.${uid}` : KEY);

export function loadCareer(uid?: string): Career {
  try {
    return toCareer(JSON.parse(localStorage.getItem(keyFor(uid)) ?? '{}'));
  } catch {
    return { ...EMPTY };
  }
}

/** True if this browser has kept totals for that account (or for the guest) before. */
export function hasCareer(uid?: string): boolean {
  try {
    return localStorage.getItem(keyFor(uid)) !== null;
  } catch {
    return false;
  }
}

export function saveCareer(c: Career, uid?: string): void {
  try {
    localStorage.setItem(keyFor(uid), JSON.stringify(c));
  } catch {
    // not saved: the totals still count until the page closes
  }
}

/** Experience: 100 a kill, 50 more for a headshot, 500 for winning a round. */
export function careerXp(c: Career): number {
  return c.kills * 100 + c.headshots * 50 + c.wins * 500;
}

/** Rank n starts at 500 * n * (n - 1) experience, so each rank takes 1000 more than the last. */
export function rankOf(xp: number): { rank: number; into: number; span: number } {
  const rank = Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * Math.max(0, xp)) / 1000)) / 2));
  const start = 500 * rank * (rank - 1);
  return { rank, into: xp - start, span: 1000 * rank };
}
