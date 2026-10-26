import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, parse, serialize } from '../src/shared/format';
import { computeSlice, normalize, resolveNodeStyle } from '../src/shared/model';

const yamlText = `
title: Demo
nodes:
  - id: a
    type: service
    tags: [core]
  - id: b
    type: db
  - id: c
    type: service
    tags: [edge]
  - id: d
edges:
  - source: a
    target: b
    type: depends-on
  - from: b
    to: c
    type: part-of
  - source: c
    target: d
    type: depends-on
  - source: a
    target: missing
`;

test('detects format', () => {
  assert.equal(detectFormat('{"a":1}'), 'json');
  assert.equal(detectFormat('a: 1'), 'yaml');
  assert.equal(detectFormat('', 'json'), 'json');
});

test('parses yaml, accepts from/to and drops dangling edges', () => {
  const m = parse(yamlText);
  assert.equal(m.nodes.length, 4);
  assert.equal(m.edges.length, 3);
  assert.deepEqual(m.edges[1].source, 'b');
  assert.ok(m.edges.every((e) => e.id));
  assert.equal(m.settings.layout?.name, 'force');
});

test('round-trips json and yaml', () => {
  const m = parse(yamlText);
  for (const f of ['json', 'yaml'] as const) {
    const text = serialize(m, f);
    assert.equal(detectFormat(text), f);
    assert.deepEqual(parse(text), m);
  }
});

test('slice by type and tag', () => {
  const m = parse(yamlText);
  const s = computeSlice(m, { name: 's', nodeTypes: ['service'] });
  assert.deepEqual([...s.nodes].sort(), ['a', 'c']);
  assert.equal(s.edges.size, 0);
  const t = computeSlice(m, { name: 't', tags: ['core'] });
  assert.deepEqual([...t.nodes], ['a']);
});

test('slice by neighbourhood and edge type', () => {
  const m = parse(yamlText);
  const all = computeSlice(m, { name: 'n', roots: ['a'] });
  assert.deepEqual([...all.nodes].sort(), ['a', 'b', 'c', 'd']);
  const one = computeSlice(m, { name: 'n', roots: ['a'], depth: 1 });
  assert.deepEqual([...one.nodes].sort(), ['a', 'b']);
  const dep = computeSlice(m, { name: 'n', roots: ['a'], edgeTypes: ['depends-on'] });
  assert.deepEqual([...dep.nodes].sort(), ['a', 'b']);
  const up = computeSlice(m, { name: 'n', roots: ['d'], direction: 'upstream' });
  assert.deepEqual([...up.nodes].sort(), ['a', 'b', 'c', 'd']);
});

test('colors by type, tag and override', () => {
  const m = normalize({
    settings: { style: { colorBy: 'tag', tags: { core: { color: '#ff0000' } } } },
    nodes: [{ id: 'a', tags: ['x', 'core'] }, { id: 'b', color: '#00ff00', tags: ['core'] }],
  });
  assert.equal(resolveNodeStyle(m, m.nodes[0]).color, '#ff0000');
  assert.equal(resolveNodeStyle(m, m.nodes[1]).color, '#00ff00');
});

test('bidirectional edges are followed both ways in slices', () => {
  const m = normalize({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [{ source: 'b', target: 'a', directed: false, tags: ['x'] }, { source: 'c', target: 'b' }],
  });
  assert.deepEqual(m.edges[0].tags, ['x']);
  const s = computeSlice(m, { name: 's', roots: ['a'], direction: 'downstream' });
  assert.deepEqual([...s.nodes].sort(), ['a', 'b']);
});
