import { LOBBY } from '@hitscan/shared';
import type { MatchInfo, ScoreRow } from '@hitscan/shared';

const NAME_KEY = 'hitscan.name';

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function minutes(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export interface LobbyHandlers {
  onQuick(): void;
  onCreate(name: string, scoreLimit: number, timeLimit: number): void;
  onJoin(id: number): void;
  onOffline(): void;
  onNameChange(name: string): void;
  onVolume(volume: number): void;
}

/** The lobby screen: nickname, the list of open matches, create / quick play / practice offline. */
export class LobbyUI {
  private root = $('lobby');
  private statusEl = $('lobby-status');
  private listEl = $('matchlist');
  private nickEl = $('nick') as HTMLInputElement;
  private buttons: HTMLButtonElement[] = [];
  private joinButtons: HTMLButtonElement[] = [];

  constructor(h: LobbyHandlers, volume: number) {
    try {
      this.nickEl.value = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      // no storage: start blank
    }
    const score = $('mscore') as HTMLSelectElement;
    for (const v of LOBBY.scoreLimits) score.add(new Option(String(v), String(v), v === LOBBY.defaultScoreLimit, v === LOBBY.defaultScoreLimit));
    const time = $('mtime') as HTMLSelectElement;
    for (const v of LOBBY.timeLimits) time.add(new Option(`${v / 60} min`, String(v), v === LOBBY.defaultTimeLimit, v === LOBBY.defaultTimeLimit));

    const quick = $('quick') as HTMLButtonElement;
    const create = $('create') as HTMLButtonElement;
    this.buttons = [quick, create];
    quick.addEventListener('click', () => h.onQuick());
    create.addEventListener('click', () => h.onCreate(($('mname') as HTMLInputElement).value, Number(score.value), Number(time.value)));
    $('offline').addEventListener('click', () => h.onOffline());
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
    const slider = $('volume') as HTMLInputElement;
    slider.value = String(Math.round(volume * 100));
    slider.addEventListener('input', () => h.onVolume(Number(slider.value) / 100));
  }

  get name(): string {
    return this.nickEl.value;
  }

  show(): void {
    this.root.style.display = 'flex';
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  setStatus(text: string, error = false): void {
    this.statusEl.textContent = text;
    this.statusEl.className = error ? 'error' : '';
  }

  /** Quick play, create and join need a live connection to the server. */
  setConnected(connected: boolean): void {
    for (const b of [...this.buttons, ...this.joinButtons]) b.disabled = !connected;
  }

  setMatches(list: MatchInfo[], connected: boolean): void {
    this.listEl.replaceChildren();
    this.joinButtons = [];
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No matches yet. Press Quick play to start one.';
      this.listEl.append(empty);
      return;
    }
    for (const m of list) {
      const row = document.createElement('div');
      row.className = 'match';
      const title = document.createElement('div');
      title.textContent = m.name;
      const sub = document.createElement('small');
      sub.textContent = `${m.map}  ·  first to ${m.scoreLimit} kills  ·  ${m.timeLimit / 60} min rounds`;
      title.append(sub);
      const count = document.createElement('div');
      count.textContent = `${m.players}/${m.max}${m.phase === 'ended' ? '  (round over)' : `  ${minutes(m.left)}`}`;
      const join = document.createElement('button');
      join.textContent = m.players >= m.max ? 'Full' : 'Join';
      join.disabled = !connected || m.players >= m.max;
      join.addEventListener('click', () => this.joinHandler?.(m.id));
      this.joinButtons.push(join);
      row.append(title, count, join);
      this.listEl.append(row);
    }
  }

  private joinHandler: ((id: number) => void) | null = null;

  onJoin(handler: (id: number) => void): void {
    this.joinHandler = handler;
  }
}

/** The round timer along the top, and the scoreboard shown when a round ends. */
export class MatchHud {
  private bar = $('matchbar');
  private end = $('endscreen');

  hide(): void {
    this.bar.style.display = 'none';
    this.end.style.display = 'none';
  }

  setClock(phase: 'playing' | 'ended', left: number, scoreLimit: number): void {
    this.bar.style.display = 'block';
    this.bar.textContent = phase === 'playing' ? `${minutes(left)}   first to ${scoreLimit}` : 'round over';
  }

  showEnd(rows: ScoreRow[], winnerName: string, myId: number, left: number): void {
    const lines = rows.map((r) => `${(r.id === myId ? `${r.name} (you)` : r.name).padEnd(22).slice(0, 22)} ${String(r.kills).padStart(5)} ${String(r.deaths).padStart(7)}`);
    this.end.textContent =
      `${winnerName === '' ? 'No winner this round' : `${winnerName} wins!`}\n\n` +
      `${'PLAYER'.padEnd(22)} ${'KILLS'.padStart(5)} ${'DEATHS'.padStart(7)}\n${lines.join('\n')}\n\nNext round in ${Math.max(0, Math.ceil(left))} s`;
    this.end.style.display = 'block';
  }

  updateEndCountdown(left: number): void {
    const text = this.end.textContent ?? '';
    this.end.textContent = text.replace(/Next round in \d+ s$/, `Next round in ${Math.max(0, Math.ceil(left))} s`);
  }

  hideEnd(): void {
    this.end.style.display = 'none';
  }
}
