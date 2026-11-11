/** Calls `tick` at a steady rate. If the process falls behind it catches up, a few ticks at a time. */
export interface LoopStats {
  ticks: number;
  totalMs: number; // time spent inside tick() since the last reset
  worstMs: number;
}

export function startTickLoop(tick: () => void, hz: number): { stop: () => void; stats: LoopStats } {
  const period = 1000 / hz;
  const stats: LoopStats = { ticks: 0, totalMs: 0, worstMs: 0 };
  let next = performance.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = (): void => {
    if (stopped) return;
    let now = performance.now();
    let n = 0;
    while (next <= now && n < 5) {
      const t0 = performance.now();
      tick();
      const spent = performance.now() - t0;
      stats.ticks++;
      stats.totalMs += spent;
      stats.worstMs = Math.max(stats.worstMs, spent);
      next += period;
      n++;
    }
    now = performance.now();
    if (next <= now) next = now + period; // far behind: give up catching up rather than spiral
    timer = setTimeout(run, Math.max(0, next - now));
  };
  run();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    stats,
  };
}
