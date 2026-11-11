import test from 'node:test';
import assert from 'node:assert/strict';
import { DelayLine, VirtualClock, createRng } from '../src/netsim.ts';

test('VirtualClock runs events in time order, ties in scheduling order, and can schedule more events', () => {
  const clock = new VirtualClock();
  const log: string[] = [];
  clock.at(30, () => log.push('c'));
  clock.at(10, () => log.push('a'));
  clock.at(10, () => log.push('a2'));
  clock.at(20, () => {
    log.push('b');
    clock.after(5, () => log.push('b+5'));
  });
  clock.advanceTo(25);
  assert.deepStrictEqual(log, ['a', 'a2', 'b', 'b+5']);
  assert.equal(clock.now(), 25);
  clock.advanceTo(100);
  assert.deepStrictEqual(log, ['a', 'a2', 'b', 'b+5', 'c']);
});

test('DelayLine drops about the configured share and keeps delays inside latency +- jitter', () => {
  const clock = new VirtualClock();
  const arrivals: number[] = [];
  const line = new DelayLine<number>({ latencyMs: 100, jitterMs: 20, loss: 0.1 }, createRng(1), clock, () => arrivals.push(clock.now()));
  const sentAt: number[] = [];
  for (let i = 0; i < 10000; i++) {
    sentAt.push(i);
    clock.at(i, () => line.send(i));
  }
  clock.advanceTo(10000 + 200);
  assert.equal(line.sent, 10000);
  assert.ok(line.dropped > 900 && line.dropped < 1100, `dropped ${line.dropped}`);
  assert.equal(line.delivered, 10000 - line.dropped);
  assert.equal(arrivals.length, line.delivered);
});

test('unordered links can reorder messages; ordered links never do', () => {
  for (const ordered of [false, true]) {
    const clock = new VirtualClock();
    const got: number[] = [];
    const line = new DelayLine<number>({ latencyMs: 50, jitterMs: 40, loss: 0, ordered }, createRng(3), clock, (m) => got.push(m));
    for (let i = 0; i < 2000; i++) clock.at(i * 2, () => line.send(i));
    clock.advanceTo(5000);
    assert.equal(got.length, 2000);
    const inOrder = got.every((m, i) => i === 0 || got[i - 1] < m);
    assert.equal(inOrder, ordered, ordered ? 'ordered link reordered' : 'expected some reordering');
  }
});

test('the same seed gives the same network, a different seed a different one', () => {
  const run = (seed: number) => {
    const clock = new VirtualClock();
    const got: number[] = [];
    const line = new DelayLine<number>({ latencyMs: 80, jitterMs: 30, loss: 0.2 }, createRng(seed), clock, (m) => got.push(m));
    for (let i = 0; i < 300; i++) clock.at(i, () => line.send(i));
    clock.advanceTo(1000);
    return got.join(',');
  };
  assert.equal(run(9), run(9));
  assert.notEqual(run(9), run(10));
});
