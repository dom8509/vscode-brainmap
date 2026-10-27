// A .brainview file: a graph of the Markdown notes of the workspace. It holds no
// nodes of its own, only where the notes come from and how the graph shows them.
// The notes come from the Bases extension (see src/bases.ts); here they become
// nodes and their links become connections. Plain TypeScript for the tests.

import { BrainEdge, BrainMap, BrainNode, normalize } from './model';

/** A file as the Bases extension shares it (BasesFile in vscode-bases/src/host/api.ts). */
export interface NoteFile {
  uri: string;
  /** Workspace-relative path, e.g. "notes/idea.md". */
  path: string;
  basename: string;
  folder: string;
  kind: 'markdown' | 'yaml';
  properties: Record<string, unknown>;
  tags: string[];
  /** Resolved links: the text's have type "", the link database's their own. */
  links: { target: string; type: string }[];
}

/** Which notes a view shows and which of their properties mean what. */
export interface NoteSource {
  /** Only notes in these folders (and below). Empty: every note. */
  folders?: string[];
  /** The property that gives the type. Default: type. */
  type?: string;
  /** The property that gives the name. Default: title, else the file name. */
  label?: string;
  /**
   * The properties whose values become connections. Their values may be [[links]] or plain
   * names (`depends-on: api`). Left out: every property that holds a [[link]]. Empty: none.
   */
  links?: string[];
}

export interface BrainView {
  title?: string;
  source: NoteSource;
  /** The view's own settings: layout, style, slices. */
  settings: BrainMap['settings'];
}

export function readView(raw: unknown): BrainView {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const src = obj.source && typeof obj.source === 'object' ? obj.source : {};
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
  const source: NoteSource = {};
  const folders = list(src.folders ?? src.folder).map((f) => f.replace(/^\.?\/+|\/+$/g, '')).filter(Boolean);
  if (folders.length) source.folders = folders;
  if (typeof src.type === 'string' && src.type) source.type = src.type;
  if (typeof src.label === 'string' && src.label) source.label = src.label;
  if (src.links !== undefined && src.links !== null) source.links = [...new Set(list(src.links).map((l) => l.trim()).filter(Boolean))];
  const map = normalize({ title: obj.title, settings: obj.settings });
  return { title: typeof obj.title === 'string' ? obj.title : undefined, source, settings: map.settings };
}

export function emptyView(): BrainView {
  const map = normalize({});
  return { title: 'Notes', source: {}, settings: map.settings };
}

const isNote = (f: NoteFile, folders: string[] | undefined) =>
  f.kind === 'markdown' && (!folders?.length || folders.some((d) => f.path.startsWith(`${d}/`)));

/**
 * Finds the note a link in a property names: by path, then by name, then by its `id`
 * property; a name or id only counts when one note has it.
 */
function makeResolver(files: NoteFile[]): (raw: string) => string | undefined {
  const paths = new Set(files.map((f) => f.path));
  const unique = (key: (f: NoteFile) => unknown) => {
    const map = new Map<string, string | null>();
    for (const f of files) {
      const k = key(f);
      if (typeof k !== 'string' && typeof k !== 'number') continue;
      const name = String(k).trim().toLowerCase();
      if (name) map.set(name, map.has(name) ? null : f.path);
    }
    return map;
  };
  const byName = unique((f) => f.basename);
  const byId = unique((f) => f.properties?.id);
  return (raw) => {
    const v = raw.replace(/\\/g, '/').replace(/^\.?\//, '').trim();
    if (paths.has(v)) return v;
    if (paths.has(`${v}.md`)) return `${v}.md`;
    return byName.get(v.split('/').pop()!.replace(/\.md$/i, '').toLowerCase()) ?? byId.get(v.toLowerCase()) ?? undefined;
  };
}

/** The [[links]] in a property value: "[[a]]" or a list of them. */
function propertyLinks(value: unknown): string[] {
  const texts = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    for (const m of t.matchAll(/\[\[([^\]|#\n]+)[^\]\n]*\]\]/g)) out.push(m[1].trim());
  }
  return out;
}

/** The fields of an object in a link property that name the note, the first one found wins. */
const TARGET_KEYS = ['target', 'link', 'note', 'path', 'id', 'key'];

/**
 * The names a property chosen as links names: [[links]], else each plain text.
 * An object names its `target` (or link, note, path, id, key): `refers_to: [{ target: api }]`.
 */
function chosenLinks(value: unknown): string[] {
  const items = (Array.isArray(value) ? value : [value]).map((t) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return t;
    const obj = t as Record<string, unknown>;
    return TARGET_KEYS.map((k) => obj[k]).find((x) => typeof x === 'string' || typeof x === 'number');
  });
  return items.flatMap((t) => {
    if (typeof t !== 'string' && typeof t !== 'number') return [];
    const links = propertyLinks(String(t));
    return links.length ? links : [String(t).trim()].filter(Boolean);
  });
}

/** The properties a view can pick as links: every property of its notes but type, tags and description. */
export function linkCandidates(files: NoteFile[], view: BrainView): string[] {
  const used = new Set([view.source.type ?? 'type', 'tags', 'tag', 'description']);
  const names = new Set<string>();
  for (const f of files) {
    if (!isNote(f, view.source.folders)) continue;
    for (const k of Object.keys(f.properties ?? {})) if (!used.has(k)) names.add(k);
  }
  for (const k of view.source.links ?? []) names.add(k);
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/** A property value as a filter can compare it: text, number or a list of texts. */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v)));
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * The graph of a view: one node per note (its path is its id), one connection per
 * link between two shown notes. A [[link]] in a property is a connection of that
 * property's name, e.g. `depends-on: [[api]]`; a link in the text has no type.
 * With `source.links` only the properties listed there connect, and plain names count too.
 */
export function notesToMap(files: NoteFile[], view: BrainView): BrainMap {
  const notes = files.filter((f) => isNote(f, view.source.folders));
  const shown = new Set(notes.map((n) => n.path));
  const resolve = makeResolver(files.filter((f) => f.kind === 'markdown'));
  const typeKey = view.source.type ?? 'type';
  const labelKey = view.source.label ?? 'title';
  // These are the node's own type, tags and description; every other property is data to filter on.
  const used = new Set([typeKey, 'tags', 'tag', 'description']);
  const chosen = view.source.links && new Set(view.source.links);

  const nodes: BrainNode[] = [];
  const edges: BrainEdge[] = [];
  const seen = new Set<string>();
  const connect = (source: string, target: string | undefined, type: string) => {
    if (!target || target === source || !shown.has(target)) return;
    const id = `${source} → ${target}${type ? ` · ${type}` : ''}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ id, source, target, type: type || undefined });
  };

  for (const f of notes) {
    const p = f.properties ?? {};
    const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
    const node: BrainNode = { id: f.path, label: text(p[labelKey]) || f.basename };
    const type = text(p[typeKey]);
    if (type) node.type = type;
    if (f.tags.length) node.tags = [...f.tags];
    const description = text(p.description);
    if (description) node.description = description;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) {
      if (used.has(k)) continue;
      const links = !chosen ? propertyLinks(v) : chosen.has(k) ? chosenLinks(v) : [];
      for (const l of links) connect(f.path, resolve(l), k);
      // A link filters by the name it names: `depends-on has api`.
      data[k] = links.length ? links : plain(v) ?? '';
    }
    // The file's own fields, as Bases has them.
    data['file.name'] = f.basename;
    data['file.folder'] = f.folder;
    data['file.path'] = f.path;
    node.data = data;
    nodes.push(node);
    for (const l of f.links ?? []) connect(f.path, l.target, l.type);
  }
  return { version: 1, title: view.title, settings: view.settings, nodes, edges };
}
