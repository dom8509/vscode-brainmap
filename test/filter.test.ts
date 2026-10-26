import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize } from '../src/shared/format';
import { describeFilter, evaluate, prune } from '../src/shared/filter';
import { computeSlice, normalize, tidySlice } from '../src/shared/model';

const map = normalize({
  nodes: [
    { id: 'web', label: 'Web App', type: 'app', tags: ['critical'] },
    { id: 'api', type: 'service', tags: ['core'], description: 'Public API' },
    { id: 'auth', type: 'service' },
    { id: 'db', type: 'database', tags: ['core'] },
    { id: 'lonely', type: 'note' },
  ],
  edges: [
    { source: 'web', target: 'api', type: 'depends-on' },
    { source: 'api', target: 'auth', type: 'depends-on', tags: ['sync'] },
    { source: 'api', target: 'db', type: 'reads' },
    { source: 'auth', target: 'db', type: 'reads', directed: false },
  ],
});

const nodes = (slice: Parameters<typeof computeSlice>[1]) => [...computeSlice(map, slice).nodes].sort();

test('conditions on text, tags and numbers', () => {
  assert.deepEqual(nodes({ name: 's', nodeFilter: { property: 'type', op: 'is', value: 'Service' } }), ['api', 'auth']);
  assert.deepEqual(nodes({ name: 's', nodeFilter: { property: 'name', op: 'contains', value: 'app' } }), ['web']);
  assert.deepEqual(nodes({ name: 's', nodeFilter: { property: 'tags', op: 'has', value: '#core' } }), ['api', 'db']);
  assert.deepEqual(nodes({ name: 's', nodeFilter: { property: 'tags', op: 'isEmpty' } }), ['auth', 'lonely']);
  assert.deepEqual(nodes({ name: 's', nodeFilter: { property: 'degree', op: 'is', value: '0' } }), ['lonely']);
  assert.deepEqual(nodes({ name: 's', nodeFilter: { property: 'out', op: 'ge', value: '2' } }), ['api']);
  assert.deepEqual(nodes({ name: 's', nodeFilter: { property: 'in', op: 'is', value: '0' } }), ['lonely', 'web']);
});

test('groups combine with all, any and none, and nest', () => {
  assert.deepEqual(
    nodes({ name: 's', nodeFilter: { and: [{ property: 'type', op: 'is', value: 'service' }, { property: 'tags', op: 'has', value: 'core' }] } }),
    ['api'],
  );
  assert.deepEqual(
    nodes({ name: 's', nodeFilter: { or: [{ property: 'type', op: 'is', value: 'app' }, { property: 'type', op: 'is', value: 'database' }] } }),
    ['db', 'web'],
  );
  assert.deepEqual(
    nodes({ name: 's', nodeFilter: { not: [{ property: 'type', op: 'is', value: 'service' }, { property: 'degree', op: 'is', value: '0' }] } }),
    ['db', 'web'],
  );
  assert.deepEqual(
    nodes({
      name: 's',
      nodeFilter: { and: [{ property: 'tags', op: 'isNotEmpty' }, { not: [{ property: 'type', op: 'is', value: 'app' }] }] },
    }),
    ['api', 'db'],
  );
});

test('a filter without its value does not filter yet', () => {
  assert.equal(evaluate({ property: 'type', op: 'is', value: '' }, { type: 'x' }), undefined);
  assert.equal(evaluate({ and: [] }, {}), undefined);
  assert.equal(nodes({ name: 's', nodeFilter: { not: [{ property: 'type', op: 'is' }] } }).length, 5);
  assert.deepEqual(prune({ and: [{ or: [] }, { property: 'type', op: 'is', value: 'a' }] }), { and: [{ property: 'type', op: 'is', value: 'a' }] });
  assert.equal(prune({ and: [{ or: [] }] }), undefined);
  assert.deepEqual(tidySlice({ name: 's', nodeFilter: { and: [] } }), { name: 's' });
});

test('edge filters keep connections and steer the neighbourhood', () => {
  const s = computeSlice(map, { name: 's', edgeFilter: { property: 'direction', op: 'is', value: 'two-way' } });
  assert.equal(s.edges.size, 1);
  assert.deepEqual(nodes({ name: 's', roots: ['web'], edgeFilter: { property: 'type', op: 'is', value: 'depends-on' } }), ['api', 'auth', 'web']);
  assert.deepEqual(nodes({ name: 's', roots: ['web'], edgeFilter: { property: 'tags', op: 'hasNot', value: 'sync' } }), ['api', 'auth', 'db', 'web']);
});

test('old type, tag and edge type lists become filters', () => {
  const m = parse(`
nodes: [{ id: a, type: service, tags: [core] }, { id: b, type: db }, { id: c, type: service }]
edges: [{ source: a, target: b, type: reads }]
settings:
  slices:
    - name: Old
      nodeTypes: [service, db]
      tags: [core]
      edgeTypes: [reads]
`);
  const s = m.settings.slices![0];
  assert.equal(s.nodeTypes, undefined);
  assert.deepEqual(s.nodeFilter, {
    and: [
      { or: [{ property: 'type', op: 'is', value: 'service' }, { property: 'type', op: 'is', value: 'db' }] },
      { property: 'tags', op: 'has', value: 'core' },
    ],
  });
  assert.deepEqual(s.edgeFilter, { and: [{ property: 'type', op: 'is', value: 'reads' }] });
  assert.deepEqual([...computeSlice(m, s).nodes], ['a']);
  assert.deepEqual(parse(serialize(m, 'yaml')), m);
  assert.equal(describeFilter(s.nodeFilter, 'node'), '(type is service or type is db) and tags has core');
});
