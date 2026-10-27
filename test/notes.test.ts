import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseView, serializeView } from '../src/shared/format';
import { cardProperties, computeSlice, dataProperties } from '../src/shared/model';
import { NoteFile, emptyView, linkCandidates, notesToMap, readView, resolveNote } from '../src/shared/notes';

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

test('source.links picks the properties that connect, with plain names too', () => {
  const view = readView({ source: { links: ['owners', 'owners', ' '] } });
  assert.deepEqual(view.source.links, ['owners']);
  const people = [...files, note('notes/ann.md')];
  const map = notesToMap(people, view);
  const edges = map.edges.map((e) => `${e.source} > ${e.target} ${e.type ?? ''}`.trim());
  // depends-on is not picked, so its [[db]] makes no connection; owners: [ann, bob] does, by name.
  assert.ok(edges.includes('notes/db.md > notes/ann.md owners'));
  assert.ok(!edges.some((e) => e.endsWith('depends-on')));
  // Text links stay.
  assert.ok(edges.includes('notes/api.md > notes/web.md'));
});

test('empty source.links: no property links, and it is kept in the file', () => {
  const view = readView({ source: { links: [] } });
  assert.deepEqual(view.source.links, []);
  assert.ok(!notesToMap(files, view).edges.some((e) => e.type));
  assert.deepEqual(parseView(serializeView(view, 'yaml')).source.links, []);
  assert.equal(parseView(serializeView(emptyView(), 'yaml')).source.links, undefined);
});

test('link candidates are the notes\' properties but type, tags and description', () => {
  assert.deepEqual(linkCandidates(files, readView({ source: { links: ['extra'] } })), ['depends-on', 'extra', 'owners', 'priority', 'status', 'title']);
});

test('a chosen property of objects links by their target, to a file name or an id', () => {
  const docs = [
    note('notes/a.md', { refers_to: [{ target: 'ID_1', key: 'ID_1' }, { target: '[[c]]' }] }),
    note('notes/b.md', { id: 'ID_1' }),
    note('notes/c.md'),
  ];
  const map = notesToMap(docs, readView({ source: { links: ['refers_to'] } }));
  assert.deepEqual(map.edges.map((e) => `${e.source} > ${e.target} ${e.type}`), [
    'notes/a.md > notes/b.md refers_to',
    'notes/a.md > notes/c.md refers_to',
  ]);
  assert.deepEqual(map.nodes[0].data?.refers_to, ['ID_1', 'c']);
});

test('cards show the values of the chosen properties', () => {
  const view = readView({ settings: { style: { cardProperties: ['status', 'owner', 'missing'] } } });
  const map = notesToMap([note('a.md', { status: 'done', owner: ['Bob', 'Ann'] }), note('b.md')], view);
  assert.deepEqual(map.settings.style?.cardProperties, ['status', 'owner', 'missing']);
  assert.deepEqual(cardProperties(map.nodes[0], map.settings.style?.cardProperties), [
    [{ text: 'done' }],
    [{ text: 'Bob' }, { text: 'Ann' }],
  ]);
  assert.deepEqual(cardProperties(map.nodes[1], map.settings.style?.cardProperties), []);
  // Saved and read back.
  assert.deepEqual(parseView(serializeView(view, 'yaml')).settings.style?.cardProperties, ['status', 'owner', 'missing']);
});

test('a value naming a connected node is a link to it', () => {
  const view = readView({ settings: { style: { cardProperties: ['depends-on', 'status'] } } });
  const files = [note('a.md', { 'depends-on': ['[[api]]', '[[gone]]'], status: 'api' }), note('lib/api.md')];
  const map = notesToMap(files, view);
  const a = map.nodes.find((n) => n.id === 'a.md')!;
  const linked = (k: string) => map.edges.filter((e) => e.source === a.id && e.type === k).map((e) => map.nodes.find((n) => n.id === e.target)!);
  assert.deepEqual(cardProperties(a, ['depends-on', 'status'], linked), [
    [{ text: 'api', target: 'lib/api.md' }, { text: 'gone' }],
    // The same name in a property that does not link stays text.
    [{ text: 'api' }],
  ]);
});

test('[[links]] show without brackets and stay links', () => {
  // A property that does not link keeps its [[links]] as text in the data.
  const view = readView({ source: { links: [] }, settings: { style: { cardProperties: ['related'] } } });
  const map = notesToMap([note('a.md', { related: ['[[lib/api|The API]]', '[[gone]]', 'plain'] }), note('lib/api.md')], view);
  const a = map.nodes.find((n) => n.id === 'a.md')!;
  assert.deepEqual(cardProperties(a, ['related'], () => map.nodes), [[
    { text: 'The API', link: 'lib/api', target: 'lib/api.md' },
    { text: 'gone', link: 'gone' },
    { text: 'plain' },
  ]]);
  assert.equal(resolveNote([note('a.md'), note('lib/api.md')], 'api'), 'lib/api.md');
});
