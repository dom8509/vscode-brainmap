import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rect, hullParts, unionPath } from '../src/webview/hulls';

const card = (x: number, y: number): Rect => ({ x1: x, y1: y, x2: x + 100, y2: y + 60 });
const pad = (r: Rect, p = 20): Rect => ({ x1: r.x1 - p, y1: r.y1 - p, x2: r.x2 + p, y2: r.y2 + p });

test('cards of a group with nothing between them form one part', () => {
  const cards = [card(0, 0), card(200, 0), card(400, 0)];
  const parts = hullParts(cards.map((c) => pad(c)), cards, [card(0, 300)]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].size, 3);
  assert.deepEqual(parts[0].anchor, { x: -20, y: -20 });
  assert.equal(parts[0].outside, true);
});

test('a card of another group between them splits the group', () => {
  const cards = [card(0, 0), card(400, 0)];
  const parts = hullParts(cards.map((c) => pad(c)), cards, [card(200, 0)]);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.size), [1, 1]);
});

test('padding stops halfway to a card of another group', () => {
  const cards = [card(0, 0)];
  const [part] = hullParts([pad(cards[0], 40)], cards, [card(0, 80)]);
  // 20 px gap below the card: the outline ends 10 px below it, at y = 70.
  const ys = [...part.path.matchAll(/[MLQ]\s*(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]));
  assert.equal(Math.max(...ys), 70);
});

test('the union of two boxes is one outline, an L has six corners', () => {
  const path = unionPath([{ x1: 0, y1: 0, x2: 100, y2: 40 }, { x1: 0, y1: 0, x2: 40, y2: 100 }], 0);
  assert.equal((path.match(/M/g) ?? []).length, 1);
  assert.equal((path.match(/Q/g) ?? []).length, 6);
  const apart = unionPath([{ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 20, y1: 0, x2: 30, y2: 10 }], 2);
  assert.equal((apart.match(/M/g) ?? []).length, 2);
});
