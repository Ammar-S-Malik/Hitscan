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

export function loadCareer(): Career {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof Career, unknown>>;
    const out = { ...EMPTY };
    for (const k of Object.keys(EMPTY) as Array<keyof Career>) {
      const v = raw[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return { ...EMPTY };
  }
}

export function saveCareer(c: Career): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
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
