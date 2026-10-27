export interface LaneNode {
  id: string;
  label: string;
  type?: string;
  width: number;
  height: number;
}

export interface LaneOptions {
  /** 'columns': one column per type, side by side. 'rows': one row per type, stacked. */
  axis: 'columns' | 'rows';
  /** Space between nodes inside a lane. */
  nodeSpacing: number;
  /** Space between two lanes. */
  laneGap: number;
}

/**
 * Puts the nodes of each type into their own lane (column or row).
 * Inside a lane, nodes sit near the nodes they connect to, so fewer edges cross.
 */
export function laneLayout(nodes: LaneNode[], edges: { source: string; target: string }[], o: LaneOptions) {
  // Lanes in name order, untyped nodes last.
  const lanes = new Map<string, LaneNode[]>();
  for (const n of [...nodes].sort((a, b) => a.label.localeCompare(b.label))) {
    const t = n.type || '';
    if (!lanes.has(t)) lanes.set(t, []);
    lanes.get(t)!.push(n);
  }
  const order = [...lanes.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));

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
