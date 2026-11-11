/** Player settings, saved in the browser. The pause screen edits them. */
export interface SettingsValues {
  sensitivity: number; // multiplier on the base mouse sensitivity
  fov: number; // degrees, vertical
  crosshair: boolean;
  minimap: boolean;
  debug: boolean; // the speed / network readout in the corner
  shadows: boolean; // turn off on a slow computer
}

const KEY = 'hitscan.settings';
const DEFAULTS: SettingsValues = { sensitivity: 1, fov: 75, crosshair: true, minimap: true, debug: true, shadows: true };

function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

export class Settings {
  values: SettingsValues = { ...DEFAULTS };

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof SettingsValues, unknown>>;
      this.values = {
        sensitivity: clamp(raw.sensitivity, 0.2, 3, DEFAULTS.sensitivity),
        fov: clamp(raw.fov, 60, 110, DEFAULTS.fov),
        crosshair: typeof raw.crosshair === 'boolean' ? raw.crosshair : DEFAULTS.crosshair,
        minimap: typeof raw.minimap === 'boolean' ? raw.minimap : DEFAULTS.minimap,
        debug: typeof raw.debug === 'boolean' ? raw.debug : DEFAULTS.debug,
        shadows: typeof raw.shadows === 'boolean' ? raw.shadows : DEFAULTS.shadows,
      };
    } catch {
      // storage missing or damaged: use the defaults
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.values));
    } catch {
      // not saved this time; the settings still apply until the page closes
    }
  }

  /** Hook the controls on the pause screen up to the values. `onChange` runs after every edit. */
  bind(onChange: () => void): void {
    const get = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
    const sens = get<HTMLInputElement>('set-sens');
    const fov = get<HTMLInputElement>('set-fov');
    const sync = (): void => {
      get('set-sens-v').textContent = `${Math.round(this.values.sensitivity * 100)}%`;
      get('set-fov-v').textContent = `${Math.round(this.values.fov)}°`;
    };
    sens.value = String(Math.round(this.values.sensitivity * 100));
    fov.value = String(Math.round(this.values.fov));
    const boxes: Array<['set-xhair' | 'set-map' | 'set-dbg' | 'set-shadows', 'crosshair' | 'minimap' | 'debug' | 'shadows']> = [
      ['set-xhair', 'crosshair'],
      ['set-map', 'minimap'],
      ['set-dbg', 'debug'],
      ['set-shadows', 'shadows'],
    ];
    for (const [id, key] of boxes) {
      const box = get<HTMLInputElement>(id);
      box.checked = this.values[key];
      box.addEventListener('change', () => {
        this.values[key] = box.checked;
        this.save();
        onChange();
      });
    }
    sens.addEventListener('input', () => {
      this.values.sensitivity = clamp(Number(sens.value) / 100, 0.2, 3, 1);
      sync();
      this.save();
      onChange();
    });
    fov.addEventListener('input', () => {
      this.values.fov = clamp(Number(fov.value), 60, 110, 75);
      sync();
      this.save();
      onChange();
    });
    sync();
    onChange();
  }
}
