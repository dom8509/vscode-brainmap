// Data model of a .brainmap file. Shared by the extension host and the webview.

import { FilterNode, FilterProperty, FilterValues, makeGroup, matches, prune, readFilter } from './filter';

export interface Position {
  x: number;
  y: number;
}

export interface BrainNode {
  id: string;
  label?: string;
  type?: string;
  tags?: string[];
  description?: string;
  /** Overrides the color derived from type/tag styles. */
  color?: string;
  /** Free-form user data, kept untouched. */
  data?: Record<string, unknown>;
}

export interface BrainEdge {
  id: string;
  source: string;
  target: string;
  /** Dependency type, e.g. "depends-on", "part-of". */
  type?: string;
  tags?: string[];
  label?: string;
  /** false = bidirectional edge (arrows on both ends). Default: directed source → target. */
  directed?: boolean;
  data?: Record<string, unknown>;
}

export type NodeShape =
  | 'ellipse'
  | 'round-rectangle'
  | 'rectangle'
  | 'diamond'
  | 'hexagon'
  | 'triangle'
  | 'star';

export interface NodeStyle {
  color?: string;
  shape?: NodeShape;
  size?: number;
}

export interface EdgeStyle {
  color?: string;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  width?: number;
  /** Target length for force layouts. Lower = nodes connected by this type stay closer. */
  length?: number;
}

export type LayoutName =
  | 'force'
  | 'fcose'
  | 'hierarchy'
  | 'breadthfirst'
  | 'concentric'
  | 'circle'
  | 'grid'
  | 'typeColumns'
  | 'typeRows';

export interface LayoutSettings {
  name: LayoutName;
  /** Edge types that define the hierarchy (empty = all edge types). */
  hierarchyEdgeTypes?: string[];
  direction?: 'TB' | 'BT' | 'LR' | 'RL';
  /** Space between nodes (px). */
  nodeSpacing?: number;
  /** Default ideal edge length for force layouts (px). */
  edgeLength?: number;
  /** Keep the force simulation running so dragging moves neighbours. */
  live?: boolean;
  animate?: boolean;
  /** Hierarchy layout: hide edges whose type is not part of the hierarchy. */
  hideOtherEdges?: boolean;
  /** Center the view on the selected element(s). */
  followSelection?: boolean;
  /** Lane layouts: what puts nodes into lanes: 'type', 'tag' or 'data.<key>'. */
  laneBy?: string;
  /** Lane layouts: lane order per laneBy value. Lanes not listed come after, by name. */
  laneOrders?: Record<string, string[]>;
}

export type ColorBy = 'type' | 'tag' | 'none';

export type EdgeLabel = 'label' | 'type' | 'none';

export interface StyleSettings {
  colorBy?: ColorBy;
  /** What connections show as text. Default: their label. */
  edgeLabel?: EdgeLabel;
  /** What groups nodes into areas: 'type', 'tag' or 'data.<key>'. Default: 'type'. */
  groupBy?: string;
  /** Zoomed far out, nodes turn into plain blocks without text. Default: true. */
  simplifyZoomedOut?: boolean;
  /** Properties (keys of a node's data) whose values show on the card, under the name. */
  cardProperties?: string[];
  nodeTypes?: Record<string, NodeStyle>;
  edgeTypes?: Record<string, EdgeStyle>;
  tags?: Record<string, NodeStyle>;
}

export type SliceDirection = 'downstream' | 'upstream' | 'both';

export interface Slice {
  name: string;
  /** Which nodes the slice keeps (none = all). */
  nodeFilter?: FilterNode;
  /** Which edges the slice keeps and follows from the start nodes (none = all). */
  edgeFilter?: FilterNode;
  /** @deprecated Read from older files and turned into nodeFilter. */
  nodeTypes?: string[];
  /** @deprecated Read from older files and turned into nodeFilter. */
  tags?: string[];
  /** @deprecated Read from older files and turned into edgeFilter. */
  edgeTypes?: string[];
  /** Start nodes for a neighbourhood slice. */
  roots?: string[];
  /** Max hops from roots (undefined = unlimited). */
  depth?: number;
  direction?: SliceDirection;
  /** Also show the nodes connected to the matches (follows direction and depth). */
  expand?: boolean;
  /** Mark the nodes that match the node filter. */
  highlight?: boolean;
  /**
   * Nodes without a connection in the slice: 'hide' leaves them out, 'only' shows
   * nothing else. Left out: they show like any other node.
   */
  orphans?: 'hide' | 'only';
}

export interface Settings {
  /** Which nodes are loaded at all; slices and the full graph only see these. */
  filter?: FilterNode;
  layout?: LayoutSettings;
  style?: StyleSettings;
  slices?: Slice[];
  /** Name of the slice currently shown. */
  activeSlice?: string;
  /** Name of the slice the file opens with. Left out: it opens with the slice shown last. */
  defaultSlice?: string;
  /** 'hide' removes nodes outside the slice, 'dim' greys them out. */
  sliceMode?: 'hide' | 'dim';
}

export interface BrainMap {
  version: number;
  title?: string;
  settings: Settings;
  nodes: BrainNode[];
  edges: BrainEdge[];
  /** The global filter was applied already (by the host, for a .brainview); not saved. */
  prefiltered?: boolean;
}

export type FileFormat = 'json' | 'yaml';

const LAYOUT_NAMES: LayoutName[] = ['force', 'fcose', 'hierarchy', 'breadthfirst', 'concentric', 'circle', 'grid', 'typeColumns', 'typeRows'];

export const DEFAULT_LAYOUT: Required<LayoutSettings> = {
  name: 'force',
  hierarchyEdgeTypes: [],
  direction: 'TB',
  nodeSpacing: 40,
  edgeLength: 120,
  live: true,
  animate: true,
  hideOtherEdges: false,
  followSelection: true,
  laneBy: 'type',
  laneOrders: {},
};

export const PALETTE = [
  '#5B9BFF',
  '#3DD68C',
  '#FF9F43',
  '#B98CFF',
  '#F2B84B',
  '#FF6B8B',
  '#4FD1C5',
  '#E879F9',
  '#A3E635',
  '#94A3B8',
];

export function emptyMap(): BrainMap {
  return {
    version: 1,
    title: 'New BrainMap',
    settings: { layout: { ...DEFAULT_LAYOUT }, style: { colorBy: 'type' }, slices: [] },
    nodes: [],
    edges: [],
  };
}

/** Fills in missing fields and drops invalid entries so the UI can rely on the shape. */
export function normalize(raw: unknown): BrainMap {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const nodes: BrainNode[] = [];
  const ids = new Set<string>();
  for (const n of Array.isArray(obj.nodes) ? obj.nodes : []) {
    if (!n || typeof n !== 'object' || n.id === undefined || n.id === null) continue;
    const id = String(n.id);
    if (ids.has(id)) continue;
    ids.add(id);
    // Positions are not stored: the layout places nodes freshly each time the file opens.
    const { position: _p, ...rest } = n;
    nodes.push({ ...rest, id, tags: Array.isArray(n.tags) ? n.tags.map(String) : undefined });
  }
  const edges: BrainEdge[] = [];
  const edgeIds = new Set<string>();
  let counter = 0;
  for (const e of Array.isArray(obj.edges) ? obj.edges : []) {
    if (!e || typeof e !== 'object') continue;
    const source = String(e.source ?? e.from ?? '');
    const target = String(e.target ?? e.to ?? '');
    if (!ids.has(source) || !ids.has(target)) continue;
    let id = e.id !== undefined ? String(e.id) : '';
    while (!id || edgeIds.has(id)) id = `e${++counter}`;
    edgeIds.add(id);
    const { from: _f, to: _t, ...rest } = e;
    edges.push({ ...rest, id, source, target, tags: Array.isArray(e.tags) ? e.tags.map(String) : undefined });
  }
  const settings: Settings = obj.settings && typeof obj.settings === 'object' ? obj.settings : {};
  const layout = { ...DEFAULT_LAYOUT, ...(settings.layout ?? {}) };
  if (!LAYOUT_NAMES.includes(layout.name)) layout.name = DEFAULT_LAYOUT.name;
  return {
    version: typeof obj.version === 'number' ? obj.version : 1,
    title: obj.title,
    settings: {
      ...settings,
      layout,
      style: { colorBy: 'type', ...(settings.style ?? {}) },
      slices: Array.isArray(settings.slices) ? settings.slices.filter((s) => s && s.name).map(readSlice) : [],
      filter: readFilter(settings.filter),
    },
    nodes,
    edges,
  };
}

/** Reads a slice; the type, tag and edge type lists of older files become filters. */
function readSlice(raw: Slice): Slice {
  const { nodeTypes, tags, edgeTypes, nodeFilter, edgeFilter, ...rest } = raw;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const anyOf = (property: string, op: 'is' | 'has', values: string[]) =>
    values.length === 1 ? { property, op, value: values[0] } : makeGroup('or', values.map((value) => ({ property, op, value })));
  const nodeParts: FilterNode[] = [];
  if (list(nodeTypes).length) nodeParts.push(anyOf('type', 'is', list(nodeTypes)));
  if (list(tags).length) nodeParts.push(anyOf('tags', 'has', list(tags)));
  const oldEdges = list(edgeTypes).length ? anyOf('type', 'is', list(edgeTypes)) : undefined;
  const slice: Slice = { ...rest, name: String(raw.name) };
  if (slice.orphans !== 'hide' && slice.orphans !== 'only') delete slice.orphans;
  const nf = readFilter(nodeFilter) ?? (nodeParts.length ? makeGroup('and', nodeParts) : undefined);
  const ef = readFilter(edgeFilter) ?? (oldEdges ? makeGroup('and', [oldEdges]) : undefined);
  if (nf) slice.nodeFilter = nf;
  if (ef) slice.edgeFilter = ef;
  return slice;
}

export function uniqueTypes(map: BrainMap) {
  const nodeTypes = new Set<string>();
  const edgeTypes = new Set<string>();
  const tags = new Set<string>();
  for (const n of map.nodes) {
    if (n.type) nodeTypes.add(n.type);
    n.tags?.forEach((t) => tags.add(t));
  }
  for (const e of map.edges) {
    if (e.type) edgeTypes.add(e.type);
    e.tags?.forEach((t) => tags.add(t));
  }
  const style = map.settings.style ?? {};
  Object.keys(style.nodeTypes ?? {}).forEach((t) => nodeTypes.add(t));
  Object.keys(style.edgeTypes ?? {}).forEach((t) => edgeTypes.add(t));
  Object.keys(style.tags ?? {}).forEach((t) => tags.add(t));
  return {
    nodeTypes: [...nodeTypes].sort(),
    edgeTypes: [...edgeTypes].sort(),
    tags: [...tags].sort(),
  };
}

/** Deterministic fallback color for a type/tag name. */
export function autoColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function resolveNodeStyle(map: BrainMap, node: BrainNode): Required<NodeStyle> {
  const style = map.settings.style ?? {};
  const typeStyle = (node.type && style.nodeTypes?.[node.type]) || {};
  const tag = node.tags?.find((t) => style.tags?.[t]) ?? node.tags?.[0];
  const tagStyle = (tag && style.tags?.[tag]) || {};
  let color: string | undefined;
  if (style.colorBy === 'tag') color = tagStyle.color ?? (tag ? autoColor(tag) : undefined);
  else if (style.colorBy === 'type')
    color = typeStyle.color ?? (node.type ? autoColor(node.type) : undefined);
  return {
    color: node.color ?? color ?? '#6c7a89',
    shape: typeStyle.shape ?? tagStyle.shape ?? 'round-rectangle',
    size: typeStyle.size ?? tagStyle.size ?? 40,
  };
}

export function resolveEdgeStyle(map: BrainMap, edge: BrainEdge): EdgeStyle & { color: string } {
  const s = (edge.type && map.settings.style?.edgeTypes?.[edge.type]) || {};
  return {
    lineStyle: 'solid',
    width: 2,
    ...s,
    color: s.color ?? (edge.type ? autoColor(edge.type) : '#999999'),
  };
}

export interface SliceResult {
  nodes: Set<string>;
  edges: Set<string>;
  /** Shown nodes that match the node filter (empty without a node filter). */
  matches: Set<string>;
}

/** What a node offers to a filter. Connections are counted in the whole graph; a two-way edge counts as in and out. */
export function nodeValues(map: BrainMap): (n: BrainNode) => FilterValues {
  const ins = new Map<string, number>();
  const outs = new Map<string, number>();
  const all = new Map<string, number>();
  const inc = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  for (const e of map.edges) {
    const both = e.directed === false;
    inc(outs, e.source);
    inc(ins, e.target);
    if (both) {
      inc(ins, e.source);
      inc(outs, e.target);
    }
    inc(all, e.source);
    if (e.target !== e.source) inc(all, e.target);
  }
  return (n) => ({
    ...dataValues(n.data),
    name: n.label || n.id,
    id: n.id,
    type: n.type,
    tags: n.tags ?? [],
    description: n.description,
    in: ins.get(n.id) ?? 0,
    out: outs.get(n.id) ?? 0,
    degree: all.get(n.id) ?? 0,
  });
}

/** A node's own data as `data.<key>` filter values: lists stay lists, numbers numbers, the rest text. */
function dataValues(data: Record<string, unknown> | undefined): FilterValues {
  const out: FilterValues = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === null || v === undefined) continue;
    out[`data.${k}`] = Array.isArray(v) ? v.map(String) : typeof v === 'number' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/** The data keys of the nodes as filter properties, A to Z; the kind follows the values. */
export function dataProperties(map: BrainMap): FilterProperty[] {
  const kinds = new Map<string, Set<string>>();
  for (const n of map.nodes)
    for (const [k, v] of Object.entries(n.data ?? {})) {
      const set = kinds.get(k) ?? kinds.set(k, new Set()).get(k)!;
      // An empty value says nothing about the kind.
      if (v === null || v === undefined || v === '') continue;
      set.add(Array.isArray(v) ? 'list' : typeof v === 'number' ? 'number' : 'text');
    }
  return [...kinds.keys()].sort((a, b) => a.localeCompare(b)).map((k) => {
    const set = kinds.get(k)!;
    const kind = set.size === 1 ? ([...set][0] as FilterProperty['kind']) : set.has('list') ? 'list' : 'text';
    return { id: `data.${k}`, label: k, kind };
  });
}

/** One value on a card; with a target it is a link to that node. */
export interface CardValue {
  text: string;
  target?: string;
}

/** The names a link can give a node: its id (a path), the file name, its `id` property, its name. */
function nodeNames(n: BrainNode): string[] {
  const file = n.id.split('/').pop()!.replace(/\.md$/i, '');
  return [n.id, n.id.replace(/\.md$/i, ''), file, n.data?.['file.name'], n.data?.id, n.label]
    .filter((x) => typeof x === 'string' || typeof x === 'number')
    .map((x) => String(x).trim().toLowerCase());
}

/**
 * The values of the chosen properties as the card shows them, one list per property;
 * empty ones are left out. `linked(key)` gives the nodes the node connects to by that
 * property: a value naming one of them becomes a link to it.
 */
export function cardProperties(node: BrainNode, keys: string[] | undefined, linked: (key: string) => BrainNode[] = () => []): CardValue[][] {
  const text = (v: unknown) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')).trim();
  return (keys ?? [])
    .map((k) => {
      const v = node.data?.[k];
      const targets = linked(k);
      return (Array.isArray(v) ? v : [v]).map(text).filter(Boolean).map((t): CardValue => {
        const target = targets.find((n) => nodeNames(n).includes(t.toLowerCase()));
        return target ? { text: t, target: target.id } : { text: t };
      });
    })
    .filter((values) => values.length > 0);
}

export function edgeValues(e: BrainEdge): FilterValues {
  return {
    type: e.type,
    tags: e.tags ?? [],
    label: e.label,
    direction: e.directed === false ? 'two-way' : 'one-way',
  };
}

/** Drops empty filter groups before a slice is saved. */
export function tidySlice(slice: Slice): Slice {
  const { nodeFilter, edgeFilter, ...rest } = slice;
  const out: Slice = { ...rest };
  const nf = prune(nodeFilter);
  const ef = prune(edgeFilter);
  if (nf) out.nodeFilter = nf;
  if (ef) out.edgeFilter = ef;
  return out;
}

/** The slice a file opens with: its default slice while that exists, else the one shown last. */
export function openingSlice(settings: Settings): string | undefined {
  const names = new Set((settings.slices ?? []).map((s) => s.name));
  if (settings.defaultSlice && names.has(settings.defaultSlice)) return settings.defaultSlice;
  return settings.activeSlice && names.has(settings.activeSlice) ? settings.activeSlice : undefined;
}

/** Computes which nodes and edges belong to a slice. */
export function computeSlice(map: BrainMap, raw: Slice): SliceResult {
  const slice = readSlice(raw);
  const values = nodeValues(map);
  const nodeOk = (n: BrainNode) => matches(slice.nodeFilter, values(n));
  const edgeOk = (e: BrainEdge) => matches(slice.edgeFilter, edgeValues(e));

  const matched = new Set(map.nodes.filter(nodeOk).map((n) => n.id));
  let nodes = matched;
  let candidateEdges = map.edges.filter((e) => edgeOk(e));

  let roots = (slice.roots ?? []).filter((r) => map.nodes.some((n) => n.id === r));
  // Expanding starts at the matches (or the start nodes that match) and may reach any node.
  if (slice.expand) {
    roots = roots.length ? roots.filter((r) => matched.has(r)) : [...matched];
    nodes = new Set(map.nodes.map((n) => n.id));
  }
  if (roots.length || slice.expand) {
    // Breadth-first walk from the roots along the allowed edges.
    const dir = slice.direction ?? 'downstream';
    const maxDepth = slice.depth ?? Infinity;
    const out = new Map<string, string[]>();
    const add = (a: string, b: string) => {
      if (!out.has(a)) out.set(a, []);
      out.get(a)!.push(b);
    };
    for (const e of candidateEdges) {
      const both = e.directed === false;
      if (dir !== 'upstream' || both) add(e.source, e.target);
      if (dir !== 'downstream' || both) add(e.target, e.source);
    }
    const reached = new Set<string>(roots);
    let frontier = roots;
    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const nb of out.get(id) ?? [])
          if (!reached.has(nb) && nodes.has(nb)) {
            reached.add(nb);
            next.push(nb);
          }
      frontier = next;
    }
    nodes = reached;
  }

  let edges = new Set(
    candidateEdges.filter((e) => nodes.has(e.source) && nodes.has(e.target)).map((e) => e.id),
  );
  // A node is an orphan when none of the slice's connections touch it.
  if (slice.orphans) {
    const linked = new Set<string>();
    for (const e of candidateEdges) if (edges.has(e.id)) linked.add(e.source).add(e.target);
    nodes = new Set([...nodes].filter((id) => linked.has(id) === (slice.orphans === 'hide')));
    if (slice.orphans === 'only') edges = new Set();
  }
  const marked = prune(slice.nodeFilter) ? new Set([...matched].filter((id) => nodes.has(id))) : new Set<string>();
  return { nodes, edges, matches: marked };
}

/**
 * The map as the global filter leaves it: only the matching nodes and the edges
 * between them. Connections are counted in the whole map. Unchanged without a filter.
 */
export function applyGlobalFilter(map: BrainMap): BrainMap {
  const filter = prune(map.settings.filter);
  if (map.prefiltered || !filter) return map;
  const values = nodeValues(map);
  const nodes = map.nodes.filter((n) => matches(filter, values(n)));
  const ids = new Set(nodes.map((n) => n.id));
  return { ...map, nodes, edges: map.edges.filter((e) => ids.has(e.source) && ids.has(e.target)), prefiltered: true };
}

/** What a filter editor can offer for a set of nodes: the data keys and the known values per property. */
export interface FilterOptions {
  /** How many nodes there are before the global filter. */
  total: number;
  properties: FilterProperty[];
  values: Record<string, string[]>;
}

export function filterOptions(map: BrainMap, max = 500): FilterOptions {
  const sets = new Map<string, Set<string>>();
  const add = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return;
    const set = sets.get(k) ?? sets.set(k, new Set()).get(k)!;
    if (set.size < max) set.add(String(v));
  };
  for (const n of map.nodes) {
    add('type', n.type);
    n.tags?.forEach((t) => add('tags', t));
    for (const [k, v] of Object.entries(n.data ?? {})) (Array.isArray(v) ? v : [v]).forEach((x) => add(`data.${k}`, x));
  }
  const sort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return {
    total: map.nodes.length,
    properties: dataProperties(map),
    values: Object.fromEntries([...sets].map(([k, set]) => [k, [...set].sort(sort)])),
  };
}

export function newId(prefix: string, existing: Iterable<string>): string {
  const used = new Set(existing);
  let i = 1;
  while (used.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}
