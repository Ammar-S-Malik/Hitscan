import { CLASSES, DEFAULT_PRIMARY, LOBBY, WEAPONS, isPrimary } from '@hitscan/shared';
import type { MatchInfo, ScoreRow } from '@hitscan/shared';
import { SECONDARY_WEAPON } from '@hitscan/shared';
import { careerXp, rankOf } from './career.ts';
import type { Career } from './career.ts';

const NAME_KEY = 'hitscan.name';
const AI_KEY = 'hitscan.ai';
const CLASS_KEY = 'hitscan.class';

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function minutes(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const TABS = ['mp', 'ai', 'controls', 'settings'] as const;
type Tab = (typeof TABS)[number];

export type AiDifficulty = 'easy' | 'normal' | 'hard';

export interface VsAiConfig {
  map: string; // '' = random
  difficulty: AiDifficulty;
  bots: number;
  scoreLimit: number;
  timeLimit: number;
}

export interface LobbyHandlers {
  onQuick(): void;
  onCreate(name: string, scoreLimit: number, timeLimit: number, map: string): void;
  onJoin(id: number): void;
  onOffline(map: string): void;
  onVsAi(config: VsAiConfig): void;
  onNameChange(name: string): void;
  onClass(primary: number): void;
  onVolume(volume: number): void;
}

interface SavedAi {
  difficulty: AiDifficulty;
  bots: number;
  map: string;
  scoreLimit: number;
  timeLimit: number;
}

const AI_DEFAULTS: SavedAi = { difficulty: 'normal', bots: 3, map: '', scoreLimit: 15, timeLimit: 300 };

function loadAi(): SavedAi {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_KEY) ?? '{}') as Partial<Record<keyof SavedAi, unknown>>;
    return {
      difficulty: raw.difficulty === 'easy' || raw.difficulty === 'hard' || raw.difficulty === 'normal' ? raw.difficulty : AI_DEFAULTS.difficulty,
      bots: typeof raw.bots === 'number' ? raw.bots : AI_DEFAULTS.bots,
      map: typeof raw.map === 'string' ? raw.map : AI_DEFAULTS.map,
      scoreLimit: typeof raw.scoreLimit === 'number' ? raw.scoreLimit : AI_DEFAULTS.scoreLimit,
      timeLimit: typeof raw.timeLimit === 'number' ? raw.timeLimit : AI_DEFAULTS.timeLimit,
    };
  } catch {
    return { ...AI_DEFAULTS };
  }
}

/** The lobby screen: nickname, multiplayer (quick play, match list, create), Play vs AI and free roam. */
export class LobbyUI {
  private root = $('lobby');
  private statusEl = $('lobby-status');
  private pill = $('status-pill');
  private note = $('mp-note');
  private noteText = $('mp-note-text');
  private listEl = $('matchlist');
  private nickEl = $('nick') as HTMLInputElement;
  private buttons: HTMLButtonElement[] = [];
  private joinButtons: HTMLButtonElement[] = [];
  private tab: Tab = 'mp';
  private connected = false;
  private isError = false;
  private difficulty: AiDifficulty = 'normal';
  private aiBots = $('ai-bots') as HTMLSelectElement;
  private aiMap = $('ai-map') as HTMLSelectElement;
  private aiScore = $('ai-score') as HTMLSelectElement;
  private aiTime = $('ai-time') as HTMLSelectElement;
  private mapPlayers = new Map<string, number>();
  private joinHandler: ((id: number) => void) | null = null;
  /** The class picked, as its primary gun (an index into WEAPONS). */
  primary = DEFAULT_PRIMARY;

  constructor(h: LobbyHandlers, volume: number, maps: Array<{ name: string; size: string; players: number }>, icons: readonly string[] = []) {
    try {
      this.nickEl.value = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      // no storage: start blank
    }
    for (const m of maps) this.mapPlayers.set(m.name, m.players);

    // ---- multiplayer
    const score = $('mscore') as HTMLSelectElement;
    for (const v of LOBBY.scoreLimits) score.add(new Option(String(v), String(v), v === LOBBY.defaultScoreLimit, v === LOBBY.defaultScoreLimit));
    const time = $('mtime') as HTMLSelectElement;
    for (const v of LOBBY.timeLimits) time.add(new Option(`${v / 60} min`, String(v), v === LOBBY.defaultTimeLimit, v === LOBBY.defaultTimeLimit));
    const mapSelect = $('mmap') as HTMLSelectElement;
    mapSelect.add(new Option('Random map', ''));
    for (const m of maps) mapSelect.add(new Option(`${m.name} (${m.size}, up to ${m.players})`, m.name));

    const quick = $('quick') as HTMLButtonElement;
    const create = $('create') as HTMLButtonElement;
    this.buttons = [quick, create];
    quick.addEventListener('click', () => h.onQuick());
    create.addEventListener('click', () => h.onCreate(($('mname') as HTMLInputElement).value, Number(score.value), Number(time.value), mapSelect.value));

    // ---- play vs AI
    const saved = loadAi();
    this.difficulty = saved.difficulty;
    for (const v of LOBBY.scoreLimits) this.aiScore.add(new Option(`${v} kills`, String(v), false, v === saved.scoreLimit));
    for (const v of LOBBY.timeLimits) this.aiTime.add(new Option(`${v / 60} min`, String(v), false, v === saved.timeLimit));
    this.aiMap.add(new Option('Random map', ''));
    for (const m of maps) this.aiMap.add(new Option(`${m.name} (${m.size})`, m.name, false, m.name === saved.map));
    this.fillBots(saved.bots);
    this.aiMap.addEventListener('change', () => this.fillBots(Number(this.aiBots.value)));
    const diffButtons = Array.from($('ai-diff').querySelectorAll('button')) as HTMLButtonElement[];
    const showDiff = (): void => {
      for (const b of diffButtons) b.classList.toggle('on', b.dataset.v === this.difficulty);
    };
    for (const b of diffButtons) {
      b.addEventListener('click', () => {
        this.difficulty = b.dataset.v as AiDifficulty;
        showDiff();
      });
    }
    showDiff();
    $('ai-start').addEventListener('click', () => {
      const config: VsAiConfig = {
        map: this.aiMap.value,
        difficulty: this.difficulty,
        bots: Number(this.aiBots.value),
        scoreLimit: Number(this.aiScore.value),
        timeLimit: Number(this.aiTime.value),
      };
      try {
        localStorage.setItem(AI_KEY, JSON.stringify(config));
      } catch {
        // not saved: fine
      }
      h.onVsAi(config);
    });
    $('offline').addEventListener('click', () => h.onOffline(this.aiMap.value));

    // ---- tabs
    for (const btn of Array.from(this.root.querySelectorAll<HTMLButtonElement>('.tab'))) {
      btn.addEventListener('click', () => this.showTab((TABS as readonly string[]).includes(btn.dataset.tab ?? '') ? (btn.dataset.tab as Tab) : 'mp'));
    }
    $('mp-to-ai').addEventListener('click', () => this.showTab('ai'));

    // ---- class
    try {
      const savedClass = Number(localStorage.getItem(CLASS_KEY));
      if (isPrimary(savedClass)) this.primary = savedClass;
    } catch {
      // no storage: the default class
    }
    const classButtons: HTMLButtonElement[] = [];
    const picture = (weapon: number): HTMLImageElement | null => {
      if (!icons[weapon]) return null;
      const img = make('img');
      img.src = icons[weapon];
      img.alt = '';
      return img;
    };
    const showClass = (): void => {
      for (const b of classButtons) b.classList.toggle('on', Number(b.dataset.p) === this.primary);
      $('class-title').textContent = `${CLASSES.find((c) => c.primary === this.primary)?.name ?? ''} class`;
    };
    for (const c of CLASSES) {
      const b = make('button', 'cls');
      b.dataset.p = String(c.primary);
      const w = WEAPONS[c.primary];
      b.append(make('b', '', c.name), make('small', '', c.role), make('span', 'kit', `${w.magSize} rounds \u00b7 ${w.damage} dmg`));
      const img = picture(c.primary);
      if (img) b.append(img);
      b.addEventListener('click', () => {
        this.primary = c.primary;
        try {
          localStorage.setItem(CLASS_KEY, String(c.primary));
        } catch {
          // not saved: fine
        }
        showClass();
        h.onClass(c.primary);
      });
      classButtons.push(b);
      $('class-list').append(b);
    }
    showClass();
    const side = WEAPONS[SECONDARY_WEAPON];
    const sideCard = make('div', 'gcard');
    sideCard.append(make('b', '', side.name), make('small', '', 'Every class carries one'), make('span', 'kit', `${side.magSize} rounds \u00b7 ${side.damage} dmg`));
    const sideImg = picture(SECONDARY_WEAPON);
    if (sideImg) sideCard.append(sideImg);
    $('secondary-card').append(sideCard);

    // ---- player
    const commitName = (): void => {
      try {
        localStorage.setItem(NAME_KEY, this.nickEl.value);
      } catch {
        // not saved: fine
      }
      h.onNameChange(this.nickEl.value);
    };
    this.nickEl.addEventListener('change', commitName);
    this.nickEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        commitName();
        this.nickEl.blur();
      }
    });
    const slider = document.getElementById('volume') as HTMLInputElement | null; // only on pages that still have a menu volume slider
    if (slider) {
      slider.value = String(Math.round(volume * 100));
      slider.addEventListener('input', () => h.onVolume(Number(slider.value) / 100));
    }
    this.refresh();
  }

  /** The opponent counts that fit the chosen map (a random map has to fit the smallest one). */
  private fillBots(preferred: number): void {
    const sizes = this.aiMap.value === '' ? [...this.mapPlayers.values()] : [this.mapPlayers.get(this.aiMap.value) ?? 6];
    const most = Math.max(1, Math.min(...sizes) - 1);
    const pick = Math.max(1, Math.min(most, Number.isFinite(preferred) ? preferred : 3));
    this.aiBots.replaceChildren();
    for (let n = 1; n <= most; n++) this.aiBots.add(new Option(n === 1 ? '1 bot' : `${n} bots`, String(n), false, n === pick));
  }

  private showTab(tab: Tab): void {
    this.tab = tab;
    for (const id of TABS) {
      $(`tab-${id}`).hidden = id !== tab;
      $(`tabbtn-${id}`).classList.toggle('on', id === tab);
    }
    // The settings controls are one set of elements shared with the pause screen: borrow them while the menu shows them.
    if (tab === 'settings') $('lobby-settings-slot').append($('settings-body'));
  }

  /** Fill in the player card under the main panel. */
  setCareer(c: Career): void {
    const xp = careerXp(c);
    const r = rankOf(xp);
    $('c-rank').textContent = String(r.rank);
    $('c-xp').textContent = `${r.into.toLocaleString()} / ${r.span.toLocaleString()}`;
    $('c-xpfill').style.width = `${Math.min(100, (r.into / r.span) * 100)}%`;
    $('c-kills').textContent = c.kills.toLocaleString();
    $('c-deaths').textContent = c.deaths.toLocaleString();
    $('c-kd').textContent = c.deaths > 0 ? (c.kills / c.deaths).toFixed(2) : c.kills > 0 ? c.kills.toFixed(2) : '0.00';
    $('c-wins').textContent = c.wins.toLocaleString();
  }

  get name(): string {
    return this.nickEl.value;
  }

  show(): void {
    if (this.root.style.display !== 'flex') this.showTab(this.tab); // takes the settings controls back from the pause screen
    this.root.style.display = 'flex';
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  setStatus(text: string, error = false): void {
    this.statusEl.textContent = text;
    this.statusEl.className = error ? 'error' : '';
    this.isError = error;
    this.refresh();
  }

  /** Quick play, create and join need a live connection to the server. */
  setConnected(connected: boolean): void {
    this.connected = connected;
    for (const b of [...this.buttons, ...this.joinButtons]) b.disabled = !connected;
    this.refresh();
  }

  private refresh(): void {
    this.pill.className = this.connected ? 'status ok' : this.isError ? 'status bad' : 'status';
    this.note.hidden = this.connected;
    this.noteText.textContent = this.isError
      ? 'Multiplayer needs the game server, which can’t be reached right now.'
      : 'Connecting to the game server… free hosting can take up to a minute to wake.';
  }

  setMatches(list: MatchInfo[], connected: boolean): void {
    this.listEl.replaceChildren();
    this.joinButtons = [];
    if (list.length === 0) {
      this.listEl.append(make('div', 'empty', connected ? 'No matches yet. Press Quick play to start one.' : 'Matches will show up here once you are connected.'));
      return;
    }
    for (const m of list) {
      const row = make('div', 'match');
      const title = make('div');
      title.append(make('b', '', m.name), make('small', '', `${m.map}  ·  first to ${m.scoreLimit} kills  ·  ${m.timeLimit / 60} min rounds`));
      const count = make('div', 'count', `${m.players}/${m.max}${m.phase === 'ended' ? '  round over' : `  ${minutes(m.left)}`}`);
      const join = make('button', 'primary', m.players >= m.max ? 'Full' : 'Join');
      join.disabled = !connected || m.players >= m.max;
      join.addEventListener('click', () => this.joinHandler?.(m.id));
      this.joinButtons.push(join);
      row.append(title, count, join);
      this.listEl.append(row);
    }
  }

  onJoin(handler: (id: number) => void): void {
    this.joinHandler = handler;
  }
}

export interface BoardRow {
  name: string;
  kills: number;
  deaths: number;
  me: boolean;
}

/** A scoreboard table, used for the Tab scoreboard and the end-of-round card. */
export function scoreTable(rows: readonly BoardRow[]): HTMLTableElement {
  const table = make('table', 'sb');
  const head = make('tr');
  for (const label of ['Player', 'Kills', 'Deaths']) head.append(make('th', '', label));
  table.append(head);
  rows.forEach((r, i) => {
    const tr = make('tr', r.me ? 'me' : '');
    const nameCell = make('td');
    nameCell.append(make('span', 'rank', String(i + 1)), document.createTextNode(r.name));
    tr.append(nameCell, make('td', '', String(r.kills)), make('td', '', String(r.deaths)));
    table.append(tr);
  });
  return table;
}

/** The round timer along the top, and the scoreboard shown when a round ends. */
export class MatchHud {
  private bar = $('matchbar');
  private end = $('endscreen');
  private tag = '';
  private countEl: HTMLElement | null = null;
  private timeEl: HTMLElement | null = null;
  private shownKey = '';

  /** A small label before the timer, for example "VS AI". Empty for none. */
  setTag(tag: string): void {
    this.tag = tag;
  }

  hide(): void {
    this.bar.style.display = 'none';
    this.end.style.display = 'none';
  }

  setClock(phase: 'playing' | 'ended', left: number, scoreLimit: number): void {
    this.bar.style.display = 'block';
    this.bar.className = phase === 'playing' ? '' : 'over';
    const text = phase === 'playing' ? minutes(left) : '0:00';
    const goal = phase === 'playing' ? `First to ${scoreLimit} kills` : 'Round over';
    const key = `${this.tag}|${goal}`;
    if (this.timeEl && this.shownKey === key) {
      if (this.timeEl.textContent !== text) this.timeEl.textContent = text;
      return;
    }
    this.shownKey = key;
    const clock = make('div', 'clock');
    const ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ico.setAttribute('viewBox', '0 0 16 16');
    ico.setAttribute('class', 'ico');
    ico.innerHTML = '<path d="M6 0h4v2H6zM2 3h12v13H2zm2 2v9h8V5zm3 1h2v4H7z" fill="currentColor"/>';
    this.timeEl = make('span', 't', text);
    clock.append(ico, this.timeEl);
    const parts: HTMLElement[] = [clock, make('div', 'g', goal)];
    if (this.tag) parts.push(make('span', 'tag', this.tag));
    this.bar.replaceChildren(...parts);
  }

  showEnd(rows: ScoreRow[], winnerId: number, myId: number, left: number): void {
    const winner = rows.find((r) => r.id === winnerId);
    const mine = winnerId !== 0 && winnerId === myId;
    const banner = make('div', `end-banner ${mine ? 'win' : 'lose'}`, winner === undefined ? 'Draw' : mine ? 'Victory' : `${winner.name} wins`);
    const sub = make('div', 'end-sub', winner === undefined ? 'Nobody came out ahead this round.' : mine ? 'You finished first.' : 'Better luck next round.');
    const board = scoreTable(rows.map((r) => ({ name: r.id === myId ? `${r.name} (you)` : r.name, kills: r.kills, deaths: r.deaths, me: r.id === myId })));
    const next = make('div', 'end-next');
    this.countEl = make('b', '', String(Math.max(0, Math.ceil(left))));
    next.append('Next round in ', this.countEl, ' s');
    this.end.replaceChildren(banner, sub, board, next);
    this.end.style.display = 'block';
  }

  updateEndCountdown(left: number): void {
    if (this.countEl) this.countEl.textContent = String(Math.max(0, Math.ceil(left)));
  }

  hideEnd(): void {
    this.end.style.display = 'none';
  }
}
