/**
 * The lobby protocol. Game traffic (inputs, snapshots, shot events) is binary and fast; the lobby is
 * a conversation (who are you, which matches exist, join this one), so it is JSON in WebSocket text
 * frames. Both sides validate everything they receive: a message that does not fit is ignored.
 */

export const LOBBY = {
  nameMax: 16,
  matchNameMax: 24,
  maxTextBytes: 512, // the server ignores longer text messages
  maxMatches: 8, // matches one server will run at once
  scoreLimits: [5, 10, 15, 25] as readonly number[], // kills that win a round
  defaultScoreLimit: 15,
  timeLimits: [180, 300, 600] as readonly number[], // round length in seconds
  defaultTimeLimit: 300,
  endScreenSeconds: 12, // how long the final scoreboard shows before the next round starts
  lobbyIdleSeconds: 60, // a lobby connection that says nothing for this long is dropped
} as const;

export type MatchPhase = 'playing' | 'ended';

export interface MatchInfo {
  id: number;
  name: string;
  map: string;
  players: number;
  max: number;
  phase: MatchPhase;
  scoreLimit: number;
  timeLimit: number; // seconds per round
  left: number; // seconds left in this round
}

export interface ScoreRow {
  id: number; // the player's id inside the match
  name: string;
  kills: number;
  deaths: number;
}

export type ClientMsg =
  | { t: 'hello'; name: string }
  | { t: 'list' }
  | { t: 'create'; name: string; scoreLimit: number; timeLimit: number; map: string } // map '' = pick one at random
  | { t: 'join'; id: number }
  | { t: 'quick' }
  | { t: 'leave' };

export type ServerMsg =
  | { t: 'hello'; name: string }
  | { t: 'matches'; list: MatchInfo[] }
  | { t: 'joined'; match: MatchInfo }
  | { t: 'left'; reason: string }
  | { t: 'roster'; players: Array<{ id: number; name: string }> }
  | { t: 'clock'; phase: MatchPhase; left: number; scoreLimit: number }
  | { t: 'ended'; winner: number; rows: ScoreRow[]; nextIn: number }
  | { t: 'error'; message: string };

/**
 * Makes a player-chosen name safe to show to others: letters, numbers, spaces, dots, dashes and
 * underscores only (no control characters, no combining marks, no markup), at most 16 characters.
 */
export function sanitizeName(raw: unknown, fallback: string, max: number = LOBBY.nameMax): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickFrom(allowed: readonly number[], v: unknown, fallback: number): number {
  return typeof v === 'number' && allowed.includes(v) ? v : fallback;
}

/** Parses a text message from a client, or returns null if it is not one we understand. */
export function parseClientMessage(text: string): ClientMsg | null {
  if (text.length > LOBBY.maxTextBytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'hello':
      return { t: 'hello', name: sanitizeName(raw.name, '') };
    case 'list':
      return { t: 'list' };
    case 'create':
      return {
        t: 'create',
        name: sanitizeName(raw.name, '', LOBBY.matchNameMax),
        scoreLimit: pickFrom(LOBBY.scoreLimits, raw.scoreLimit, LOBBY.defaultScoreLimit),
        timeLimit: pickFrom(LOBBY.timeLimits, raw.timeLimit, LOBBY.defaultTimeLimit),
        map: typeof raw.map === 'string' ? raw.map.slice(0, 40) : '',
      };
    case 'join':
      return typeof raw.id === 'number' && Number.isInteger(raw.id) && raw.id > 0 ? { t: 'join', id: raw.id } : null;
    case 'quick':
      return { t: 'quick' };
    case 'leave':
      return { t: 'leave' };
    default:
      return null;
  }
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.slice(0, 64) : fallback);

function parseInfo(v: unknown): MatchInfo | null {
  if (!isRecord(v)) return null;
  return {
    id: num(v.id), name: str(v.name), map: str(v.map), players: num(v.players), max: num(v.max),
    phase: v.phase === 'ended' ? 'ended' : 'playing',
    scoreLimit: num(v.scoreLimit), timeLimit: num(v.timeLimit), left: num(v.left),
  };
}

/** Parses a text message from the server (the client trusts it less than it might: it only reads known fields). */
export function parseServerMessage(text: string): ServerMsg | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'hello':
      return { t: 'hello', name: str(raw.name) };
    case 'matches': {
      if (!Array.isArray(raw.list)) return null;
      const list = raw.list.map(parseInfo).filter((m): m is MatchInfo => m !== null).slice(0, 64);
      return { t: 'matches', list };
    }
    case 'joined': {
      const match = parseInfo(raw.match);
      return match ? { t: 'joined', match } : null;
    }
    case 'left':
      return { t: 'left', reason: str(raw.reason) };
    case 'roster': {
      if (!Array.isArray(raw.players)) return null;
      const players = raw.players
        .filter(isRecord)
        .map((p) => ({ id: num(p.id), name: str(p.name) }))
        .slice(0, 64);
      return { t: 'roster', players };
    }
    case 'clock':
      return { t: 'clock', phase: raw.phase === 'ended' ? 'ended' : 'playing', left: num(raw.left), scoreLimit: num(raw.scoreLimit) };
    case 'ended': {
      if (!Array.isArray(raw.rows)) return null;
      const rows = raw.rows
        .filter(isRecord)
        .map((r) => ({ id: num(r.id), name: str(r.name), kills: num(r.kills), deaths: num(r.deaths) }))
        .slice(0, 64);
      return { t: 'ended', winner: num(raw.winner), rows, nextIn: num(raw.nextIn) };
    }
    case 'error':
      return { t: 'error', message: str(raw.message) };
    default:
      return null;
  }
}
