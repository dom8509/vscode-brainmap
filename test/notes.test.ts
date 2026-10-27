import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseView, serializeView } from '../src/shared/format';
import { computeSlice, dataProperties } from '../src/shared/model';
import { NoteFile, emptyView, notesToMap, readView } from '../src/shared/notes';

const note = (path: string, properties: Record<string, unknown> = {}, links: string[] = [], tags: string[] = []): NoteFile => {
  const name = path.split('/').pop()!;
  return {
    uri: `file:///ws/${path}`,
    path,
    basename: name.replace(/\.[^.]+$/, ''),
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    kind: path.endsWith('.md') ? 'markdown' : 'yaml',
    properties,
    tags,
    links: links.map((target) => ({ target, type: '' })),
  };
};

const files = [
  note('notes/api.md', { title: 'API', type: 'service', status: 'done', priority: 2, 'depends-on': ['[[db]]', '[[Missing]]'] }, ['notes/web.md'], ['core']),
  note('notes/web.md', { type: 'app', description: 'The web app' }, ['notes/api.md', 'notes/api.md', 'other/outside.md']),
  note('notes/db.md', { type: 'database', owners: ['ann', 'bob'] }),
  note('other/outside.md'),
  note('deploy/app.yaml', { a: 1 }),
];

test('notes become nodes, links connections', () => {
  const map = notesToMap(files, emptyView());
  assert.deepEqual(map.nodes.map((n) => n.id), ['notes/api.md', 'notes/web.md', 'notes/db.md', 'other/outside.md']);
  const api = map.nodes[0];
  assert.equal(api.label, 'API');
  assert.equal(api.type, 'service');
  assert.deepEqual(api.tags, ['core']);
  assert.deepEqual(api.data, {
    title: 'API', status: 'done', priority: 2, 'depends-on': ['db', 'Missing'],
    'file.name': 'api', 'file.folder': 'notes', 'file.path': 'notes/api.md',
  });
  assert.equal(map.nodes[1].label, 'web');
  assert.equal(map.nodes[1].description, 'The web app');
  const edges = map.edges.map((e) => `${e.source} > ${e.target} ${e.type ?? ''}`.trim());
  assert.deepEqual(edges, [
    'notes/api.md > notes/db.md depends-on',
    'notes/api.md > notes/web.md',
    'notes/web.md > notes/api.md',
    'notes/web.md > other/outside.md',
  ]);
});

test('folders, type and label come from the source', () => {
  const view = readView({ source: { folder: './notes/', type: 'status', label: 'type' } });
  assert.deepEqual(view.source, { folders: ['notes'], type: 'status', label: 'type' });
  const map = notesToMap(files, view);
  assert.deepEqual(map.nodes.map((n) => n.label), ['service', 'app', 'database']);
  assert.equal(map.nodes[0].type, 'done');
  assert.ok(!map.edges.some((e) => e.target === 'other/outside.md'));
});

test('data keys filter as data.<key>', () => {
  const map = notesToMap(files, emptyView());
  assert.deepEqual(dataProperties(map).map((p) => `${p.id}:${p.kind}`), [
    'data.depends-on:list', 'data.file.folder:text', 'data.file.name:text', 'data.file.path:text',
    'data.owners:list', 'data.priority:number', 'data.status:text', 'data.title:text',
  ]);
  const nodes = (nodeFilter: any) => [...computeSlice(map, { name: 's', nodeFilter }).nodes];
  assert.deepEqual(nodes({ property: 'data.status', op: 'is', value: 'Done' }), ['notes/api.md']);
  assert.deepEqual(nodes({ property: 'data.priority', op: 'ge', value: '2' }), ['notes/api.md']);
  assert.deepEqual(nodes({ property: 'data.owners', op: 'has', value: 'bob' }), ['notes/db.md']);
  assert.deepEqual(nodes({ property: 'id', op: 'startsWith', value: 'other/' }), ['other/outside.md']);
  assert.deepEqual(nodes({ property: 'data.depends-on', op: 'has', value: 'db' }), ['notes/api.md']);
  assert.deepEqual(nodes({ property: 'data.file.folder', op: 'is', value: 'other' }), ['other/outside.md']);
});

test('a view file keeps its source and settings, never nodes', () => {
  const text = 'title: Mine\nsource:\n  folders: [notes]\nsettings:\n  layout:\n    name: hierarchy\nnodes:\n  - id: x\n';
  const view = parseView(text);
  assert.equal(view.title, 'Mine');
  assert.equal(view.settings.layout?.name, 'hierarchy');
  const out = serializeView(view, 'yaml');
  assert.match(out, /folders:\n {4}- notes/);
  assert.doesNotMatch(out, /nodes:/);
  assert.deepEqual(parseView(serializeView(view, 'json')).source, { folders: ['notes'] });
});
