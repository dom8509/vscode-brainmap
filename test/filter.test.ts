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

test('expand: matches plus the nodes connected to them, matches marked', () => {
  const critical = { property: 'tags', op: 'has', value: 'critical' } as const;
  assert.deepEqual(nodes({ name: 's', nodeFilter: critical, expand: true }), ['api', 'auth', 'db', 'web']);
  assert.deepEqual(nodes({ name: 's', nodeFilter: critical, expand: true, depth: 1 }), ['api', 'web']);
  assert.deepEqual(nodes({ name: 's', nodeFilter: { property: 'type', op: 'is', value: 'database' }, expand: true, direction: 'upstream', depth: 1 }), ['api', 'auth', 'db']);
  assert.deepEqual([...computeSlice(map, { name: 's', nodeFilter: critical, expand: true }).matches], ['web']);
  assert.equal(computeSlice(map, { name: 's' }).matches.size, 0);
});

test('the global filter loads only matching nodes, connections counted in the whole map', async () => {
  const { applyGlobalFilter, filterOptions } = await import('../src/shared/model');
  const full = normalize({ ...map, settings: { filter: { or: [{ property: 'type', op: 'is', value: 'service' }, { property: 'in', op: 'ge', value: '2' }] } } });
  const loaded = applyGlobalFilter(full);
  assert.deepEqual(loaded.nodes.map((n) => n.id), ['api', 'auth', 'db']);
  assert.deepEqual(loaded.edges.map((e) => `${e.source}>${e.target}`), ['api>auth', 'api>db', 'auth>db']);
  assert.equal(loaded.prefiltered, true);
  assert.equal(applyGlobalFilter(loaded), loaded);
  // A slice works on what is loaded.
  assert.deepEqual([...computeSlice(loaded, { name: 's', nodeFilter: { property: 'tags', op: 'has', value: 'core' } }).nodes].sort(), ['api', 'db']);
  // Without a filter (or an empty one) nothing changes.
  assert.equal(applyGlobalFilter(map), map);
  assert.equal(applyGlobalFilter(normalize({ ...map, settings: { filter: { and: [] } } })).nodes.length, 5);
  // The file keeps the filter, the flag is not saved.
  assert.match(serialize(loaded, 'yaml'), /filter:\n {4}or:/);
  assert.doesNotMatch(serialize(loaded, 'yaml'), /prefiltered/);
  const opts = filterOptions(full);
  assert.equal(opts.total, 5);
  assert.deepEqual(opts.values.type, ['app', 'database', 'note', 'service']);
  assert.deepEqual(opts.values.tags, ['core', 'critical']);
});
