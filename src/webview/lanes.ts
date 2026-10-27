import type { BrainNode } from '../shared/model';

export interface LaneNode {
  id: string;
  label: string;
  /** Name of the lane the node goes in ('' = no value, always last). */
  lane: string;
  width: number;
  height: number;
}

export interface LaneOptions {
  /** 'columns': one column per lane, side by side. 'rows': one row per lane, stacked. */
  axis: 'columns' | 'rows';
  /** Space between nodes inside a lane. */
  nodeSpacing: number;
  /** Space between two lanes. */
  laneGap: number;
  /** Lanes in this order first; the rest follow by name. */
  order?: string[];
}

/** What nodes can be put into lanes by: type, tag and every key used in `data`. */
export function laneAttributes(nodes: BrainNode[]): { value: string; label: string }[] {
  const keys = new Set<string>();
  for (const n of nodes) for (const [k, v] of Object.entries(n.data ?? {})) if (laneValue(v).length) keys.add(k);
  return [
    { value: 'type', label: 'Type' },
    { value: 'tag', label: 'Tag' },
    ...[...keys].sort().map((k) => ({ value: `data.${k}`, label: k })),
  ];
}

/** The values a node has for `by`. A node can have several (e.g. tags). */
function valuesOf(n: BrainNode, by: string): string[] {
  if (by === 'type') return n.type ? [n.type] : [];
  if (by === 'tag') return n.tags ?? [];
  if (by.startsWith('data.')) return laneValue(n.data?.[by.slice(5)]);
  return [];
}

function laneValue(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(laneValue);
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? (String(v) ? [String(v)] : []) : [];
}

const byOrder = (order: string[] = []) => (a: string, b: string) => {
  if (!a || !b) return !a ? (!b ? 0 : 1) : -1;
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i >= 0 || j >= 0) return i < 0 ? 1 : j < 0 ? -1 : i - j;
  return a.localeCompare(b);
};

/** The lane of a node. With several values, the one whose lane comes first wins. */
export function laneOf(n: BrainNode, by: string, order?: string[]): string {
  return valuesOf(n, by).sort(byOrder(order))[0] ?? '';
}

/** All lanes in display order ('' = nodes without a value, last). */
export function laneNames(nodes: BrainNode[], by: string, order?: string[]): string[] {
  return [...new Set(nodes.map((n) => laneOf(n, by, order)))].sort(byOrder(order));
}

/**
 * Puts the nodes of each lane into their own column or row.
 * Inside a lane, nodes sit near the nodes they connect to, so fewer edges cross.
 */
export function laneLayout(nodes: LaneNode[], edges: { source: string; target: string }[], o: LaneOptions) {
  const lanes = new Map<string, LaneNode[]>();
  for (const n of [...nodes].sort((a, b) => a.label.localeCompare(b.label))) {
    if (!lanes.has(n.lane)) lanes.set(n.lane, []);
    lanes.get(n.lane)!.push(n);
  }
  const order = [...lanes.keys()].sort(byOrder(o.order));

  const lane = new Map<string, number>();
  order.forEach((t, i) => lanes.get(t)!.forEach((n) => lane.set(n.id, i)));
  const neighbours = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!lane.has(e.source) || !lane.has(e.target) || lane.get(e.source) === lane.get(e.target)) continue;
    neighbours.get(e.source)!.push(e.target);
    neighbours.get(e.target)!.push(e.source);
  }

  // A few rounds: each node moves to the average spot of its neighbours in other lanes.
  const spot = new Map<string, number>();
  const place = () => order.forEach((t) => lanes.get(t)!.forEach((n, i, all) => spot.set(n.id, (i + 0.5) / all.length)));
  place();
  for (let round = 0; round < 6; round++) {
    for (const t of order) {
      const own = lanes.get(t)!;
      const want = new Map(own.map((n) => {
        const ns = neighbours.get(n.id)!;
        return [n.id, ns.length ? ns.reduce((s, id) => s + spot.get(id)!, 0) / ns.length : spot.get(n.id)!];
      }));
      own.sort((a, b) => want.get(a.id)! - want.get(b.id)!);
      own.forEach((n, i) => spot.set(n.id, (i + 0.5) / own.length));
    }
  }

  const out: Record<string, { x: number; y: number }> = {};
  const columns = o.axis === 'columns';
  let across = 0;
  for (const t of order) {
    const own = lanes.get(t)!;
    // Thickness of the lane: widest node for columns, tallest for rows.
    const thick = Math.max(...own.map((n) => (columns ? n.width : n.height)));
    const length = own.reduce((s, n) => s + (columns ? n.height : n.width), 0) + o.nodeSpacing * (own.length - 1);
    let along = -length / 2;
    for (const n of own) {
      const size = columns ? n.height : n.width;
      const mid = along + size / 2;
      out[n.id] = columns ? { x: across + thick / 2, y: mid } : { x: mid, y: across + thick / 2 };
      along += size + o.nodeSpacing;
    }
    across += thick + o.laneGap;
  }
  return out;
}
