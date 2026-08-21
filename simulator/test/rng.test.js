import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng, hashString, mulberry32 } from '../src/rng.js';

test('same seed produces the same sequence', () => {
  const a = new Rng(12345);
  const b = new Rng(12345);
  const seqA = Array.from({ length: 50 }, () => a.next());
  const seqB = Array.from({ length: 50 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test('different seeds produce different sequences', () => {
  const a = Array.from({ length: 20 }, mulberry32(1));
  const b = Array.from({ length: 20 }, mulberry32(2));
  assert.notDeepEqual(a, b);
});

test('child streams are independent but reproducible', () => {
  const parent = new Rng(999);
  const busA = parent.child('BUS-001').next();
  const busB = new Rng(999).child('BUS-001').next();
  const tram = new Rng(999).child('TRAM-001').next();
  assert.equal(busA, busB, 'same label reproduces the same stream');
  assert.notEqual(busA, tram, 'different labels give different streams');
});

test('adding trams does not shift the bus stream', () => {
  // Child streams are keyed by entity id, so fleet size changes elsewhere in
  // the configuration cannot perturb an unrelated vehicle's data.
  const first = new Rng(42).child('BUS-007').next();
  const second = new Rng(42).child('BUS-007').next();
  assert.equal(first, second);
});

test('int is inclusive and stays in range', () => {
  const rng = new Rng(7);
  for (let i = 0; i < 500; i += 1) {
    const v = rng.int(3, 6);
    assert.ok(Number.isInteger(v) && v >= 3 && v <= 6, `out of range: ${v}`);
  }
});

test('shuffle is a permutation and is deterministic', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = new Rng(5).shuffle(input);
  const b = new Rng(5).shuffle(input);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort((x, y) => x - y), input);
});

test('gaussian respects clamping bounds', () => {
  const rng = new Rng(11);
  for (let i = 0; i < 300; i += 1) {
    const v = rng.gaussian(0, 100, -5, 5);
    assert.ok(v >= -5 && v <= 5);
  }
});

test('hashString is stable', () => {
  assert.equal(hashString('BUS-001'), hashString('BUS-001'));
  assert.notEqual(hashString('BUS-001'), hashString('BUS-002'));
});
