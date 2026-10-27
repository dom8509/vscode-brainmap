// Filters of a slice, modelled on Obsidian Bases: a condition is a property, an
// operator and a value; groups combine conditions with all / any / none and can
// be nested. Nodes and edges have their own properties. Plain TypeScript, shared
// by the host, the webview and the tests.

export type Conjunction = 'and' | 'or' | 'not';

export type FilterOperator =
  | 'is' | 'isNot'
  | 'contains' | 'notContains'
  | 'startsWith'
  | 'has' | 'hasNot'
  | 'isEmpty' | 'isNotEmpty'
  | 'gt' | 'ge' | 'lt' | 'le';

export interface FilterCondition {
  property: string;
  op: FilterOperator;
  value?: string;
}

/** In the file a group is `{ and: [...] }`, `{ or: [...] }` or `{ not: [...] }`. */
export type FilterGroup = { and: FilterNode[] } | { or: FilterNode[] } | { not: FilterNode[] };

export type FilterNode = FilterGroup | FilterCondition;

export type FilterScope = 'node' | 'edge';

export type PropertyKind = 'text' | 'list' | 'number' | 'choice';

export interface FilterProperty {
  id: string;
  label: string;
  kind: PropertyKind;
  /** Fixed values for a choice property. */
  choices?: string[];
}

export const NODE_PROPERTIES: FilterProperty[] = [
  { id: 'name', label: 'name', kind: 'text' },
  { id: 'id', label: 'id', kind: 'text' },
  { id: 'type', label: 'type', kind: 'text' },
  { id: 'tags', label: 'tags', kind: 'list' },
  { id: 'description', label: 'description', kind: 'text' },
  { id: 'in', label: 'incoming', kind: 'number' },
  { id: 'out', label: 'outgoing', kind: 'number' },
  { id: 'degree', label: 'connections', kind: 'number' },
];

export const EDGE_PROPERTIES: FilterProperty[] = [
  { id: 'type', label: 'type', kind: 'text' },
  { id: 'tags', label: 'tags', kind: 'list' },
  { id: 'label', label: 'label', kind: 'text' },
  { id: 'direction', label: 'direction', kind: 'choice', choices: ['one-way', 'two-way'] },
];

export const OPERATORS: { op: FilterOperator; label: string; needsValue: boolean; kinds: PropertyKind[] }[] = [
  { op: 'is', label: 'is', needsValue: true, kinds: ['text', 'number', 'choice'] },
  { op: 'isNot', label: 'is not', needsValue: true, kinds: ['text', 'number', 'choice'] },
  { op: 'contains', label: 'contains', needsValue: true, kinds: ['text'] },
  { op: 'notContains', label: 'does not contain', needsValue: true, kinds: ['text'] },
  { op: 'startsWith', label: 'starts with', needsValue: true, kinds: ['text'] },
  { op: 'has', label: 'has', needsValue: true, kinds: ['list'] },
  { op: 'hasNot', label: 'does not have', needsValue: true, kinds: ['list'] },
  { op: 'gt', label: '>', needsValue: true, kinds: ['number'] },
  { op: 'ge', label: '≥', needsValue: true, kinds: ['number'] },
  { op: 'lt', label: '<', needsValue: true, kinds: ['number'] },
  { op: 'le', label: '≤', needsValue: true, kinds: ['number'] },
  { op: 'isEmpty', label: 'is empty', needsValue: false, kinds: ['text', 'list'] },
  { op: 'isNotEmpty', label: 'is not empty', needsValue: false, kinds: ['text', 'list'] },
];

export const CONJUNCTIONS: { conj: Conjunction; label: string }[] = [
  { conj: 'and', label: 'All the following are true' },
  { conj: 'or', label: 'Any of the following are true' },
  { conj: 'not', label: 'None of the following are true' },
];

export function propertiesFor(scope: FilterScope): FilterProperty[] {
  return scope === 'node' ? NODE_PROPERTIES : EDGE_PROPERTIES;
}

/** A property by id; `data.<key>` is a node's own data, compared as text unless `extra` knows better. */
export function propertyOf(scope: FilterScope, id: string, extra: FilterProperty[] = []): FilterProperty | undefined {
  const found = propertiesFor(scope).find((p) => p.id === id) ?? extra.find((p) => p.id === id);
  if (found || scope !== 'node' || !id.startsWith('data.')) return found;
  return { id, label: id.slice(5), kind: 'text' };
}

export function operatorsFor(property: FilterProperty | undefined) {
  return OPERATORS.filter((o) => !property || o.kinds.includes(property.kind));
}

export function isGroup(f: FilterNode): f is FilterGroup {
  return !!f && typeof f === 'object' && ('and' in f || 'or' in f || 'not' in f);
}

export function conjunctionOf(g: FilterGroup): Conjunction {
  return 'and' in g ? 'and' : 'or' in g ? 'or' : 'not';
}

export function childrenOf(g: FilterGroup): FilterNode[] {
  return 'and' in g ? g.and : 'or' in g ? g.or : g.not;
}

export function makeGroup(conj: Conjunction, children: FilterNode[] = []): FilterGroup {
  return conj === 'and' ? { and: children } : conj === 'or' ? { or: children } : { not: children };
}

/** A condition is active once it has everything it needs; others do not filter yet. */
export function isActive(c: FilterCondition): boolean {
  const op = OPERATORS.find((o) => o.op === c.op);
  return !!op && (!op.needsValue || (c.value ?? '').trim() !== '');
}

/** The values a node or an edge offers to its filter. */
export type FilterValues = Record<string, string | string[] | number | undefined>;

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

function test(c: FilterCondition, values: FilterValues): boolean {
  const raw = values[c.property];
  const want = norm(c.value);
  if (Array.isArray(raw)) {
    const items = raw.map(norm);
    switch (c.op) {
      case 'has': return items.includes(want.replace(/^#/, ''));
      case 'hasNot': return !items.includes(want.replace(/^#/, ''));
      case 'isEmpty': return items.length === 0;
      case 'isNotEmpty': return items.length > 0;
      default: return false;
    }
  }
  if (typeof raw === 'number') {
    const n = Number(c.value);
    if (Number.isNaN(n)) return false;
    switch (c.op) {
      case 'is': return raw === n;
      case 'isNot': return raw !== n;
      case 'gt': return raw > n;
      case 'ge': return raw >= n;
      case 'lt': return raw < n;
      case 'le': return raw <= n;
      default: return false;
    }
  }
  const text = norm(raw);
  switch (c.op) {
    case 'is': return text === want;
    case 'isNot': return text !== want;
    case 'contains': return text.includes(want);
    case 'notContains': return !text.includes(want);
    case 'startsWith': return text.startsWith(want);
    case 'isEmpty': return text === '';
    case 'isNotEmpty': return text !== '';
    default: return false;
  }
}

/** true or false, or undefined when nothing in the filter is active yet. */
export function evaluate(f: FilterNode | undefined, values: FilterValues): boolean | undefined {
  if (!f) return undefined;
  if (!isGroup(f)) return isActive(f) ? test(f, values) : undefined;
  const results = childrenOf(f)
    .map((c) => evaluate(c, values))
    .filter((r): r is boolean => r !== undefined);
  if (!results.length) return undefined;
  switch (conjunctionOf(f)) {
    case 'and': return results.every(Boolean);
    case 'or': return results.some(Boolean);
    case 'not': return !results.some(Boolean);
  }
}

/** Whether a filter lets an element through; an inactive filter lets everything through. */
export function matches(f: FilterNode | undefined, values: FilterValues): boolean {
  return evaluate(f, values) !== false;
}

/** How many conditions of a filter are active: the number on the Filter button. */
export function countConditions(f: FilterNode | undefined): number {
  if (!f) return 0;
  if (!isGroup(f)) return isActive(f) ? 1 : 0;
  return childrenOf(f).reduce((n, c) => n + countConditions(c), 0);
}

/** Drops empty groups, so the file only keeps what filters. Undefined when nothing is left. */
export function prune(f: FilterNode | undefined): FilterNode | undefined {
  if (!f) return undefined;
  if (!isGroup(f)) return f.property && f.op ? f : undefined;
  const children = childrenOf(f).map(prune).filter((c): c is FilterNode => !!c);
  return children.length ? makeGroup(conjunctionOf(f), children) : undefined;
}

/** Keeps what a file holds that looks like a filter and drops the rest. */
export function readFilter(raw: unknown): FilterNode | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  for (const conj of ['and', 'or', 'not'] as const) {
    if (Array.isArray(o[conj]))
      return makeGroup(conj, (o[conj] as unknown[]).map(readFilter).filter((c): c is FilterNode => !!c));
  }
  if (typeof o.property !== 'string' || !OPERATORS.some((x) => x.op === o.op)) return undefined;
  const c: FilterCondition = { property: o.property, op: o.op as FilterOperator };
  if (o.value !== undefined && o.value !== null) c.value = String(o.value);
  return c;
}

/** A short line for the slice list: `type is service and tags has core`. */
export function describeFilter(f: FilterNode | undefined, scope: FilterScope, nested = false): string {
  if (!f) return '';
  if (!isGroup(f)) {
    if (!isActive(f)) return '';
    const p = propertyOf(scope, f.property)?.label ?? f.property;
    const op = OPERATORS.find((o) => o.op === f.op)!;
    return op.needsValue ? `${p} ${op.label} ${f.value}` : `${p} ${op.label}`;
  }
  const children = childrenOf(f);
  const parts = children.map((c) => describeFilter(c, scope, children.length > 1)).filter(Boolean);
  if (!parts.length) return '';
  const conj = conjunctionOf(f);
  const text = parts.join(conj === 'and' ? ' and ' : conj === 'or' ? ' or ' : ', ');
  if (conj === 'not') return `none of (${text})`;
  return nested && parts.length > 1 ? `(${text})` : text;
}
