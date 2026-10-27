import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LaneNode, laneLayout } from '../src/webview/lanes';

const node = (id: string, type?: string): LaneNode => ({ id, label: id, type, width: 200, height: 60 });
const nodes = [node('a', 'service'), node('b', 'service'), node('x', 'db'), node('y', 'db'), node('free')];

test('columns: one column per type, untyped last', () => {
  const p = laneLayout(nodes, [], { axis: 'columns', nodeSpacing: 20, laneGap: 100 });
  assert.equal(p.x.x, p.y.x);
  assert.equal(p.a.x, p.b.x);
  assert.ok(p.x.x < p.a.x && p.a.x < p.free.x);
  assert.notEqual(p.a.y, p.b.y);
});

test('rows: one row per type', () => {
  const p = laneLayout(nodes, [], { axis: 'rows', nodeSpacing: 20, laneGap: 100 });
  assert.equal(p.a.y, p.b.y);
  assert.equal(p.x.y, p.y.y);
  assert.ok(p.x.y < p.a.y);
  assert.notEqual(p.a.x, p.b.x);
});

test('nodes sit next to the nodes they connect to', () => {
  const edges = [{ source: 'a', target: 'y' }, { source: 'b', target: 'x' }];
  const p = laneLayout(nodes, edges, { axis: 'columns', nodeSpacing: 20, laneGap: 100 });
  assert.equal(Math.sign(p.a.y - p.b.y), Math.sign(p.y.y - p.x.y));
});
