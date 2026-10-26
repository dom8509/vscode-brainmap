// Geometry of the group outlines. A group hugs its own cards: every card gets a
// padded box, and two cards of a group are joined by the box around both only
// when no card of another group sits inside it. What stays joined forms one
// part; the outline of each part is the union of its boxes, with rounded corners.
// Pure functions, so the tests can run them without a browser.

export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface HullPart {
  /** SVG path in model coordinates. */
  path: string;
  /** Top left of the box the label goes in. */
  anchor: { x: number; y: number };
  /** No box has room above its card: the label goes above the outline. */
  outside: boolean;
  size: number;
}

/** Cards further apart than this (center to center) are not joined. */
const MAX_BRIDGE = 600;
/** Space above a card that the group's name needs. */
const LABEL_ROOM = 26;

const overlaps = (a: Rect, b: Rect) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
const around = (a: Rect, b: Rect): Rect => ({
  x1: Math.min(a.x1, b.x1),
  y1: Math.min(a.y1, b.y1),
  x2: Math.max(a.x2, b.x2),
  y2: Math.max(a.y2, b.y2),
});

/**
 * Splits a group into parts and outlines each one.
 * @param boxes the padded boxes of the group's cards
 * @param cards the boxes of the group's own cards (unpadded), same order
 * @param foreign the cards of every other group, unpadded
 */
export function hullParts(padded: Rect[], cards: Rect[], foreign: Rect[], radius = 28): HullPart[] {
  const boxes = padded.map((b, i) => fit(b, cards[i], foreign));
  const n = boxes.length;
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const center = (r: Rect) => ({ x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 });

  // Kruskal: the shortest free joins first, so each part is a tree of short bridges.
  const pairs: { a: number; b: number; d: number }[] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      const ca = center(cards[a]);
      const cb = center(cards[b]);
      const d = Math.hypot(ca.x - cb.x, ca.y - cb.y);
      if (d <= MAX_BRIDGE) pairs.push({ a, b, d });
    }
  pairs.sort((p, q) => p.d - q.d);
  const bridges: { box: Rect; member: number }[] = [];
  for (const { a, b } of pairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    const box = around(boxes[a], boxes[b]);
    if (foreign.some((f) => overlaps(box, f))) continue;
    parent[ra] = rb;
    bridges.push({ box, member: a });
  }

  const parts = new Map<number, Rect[]>();
  boxes.forEach((r, i) => {
    const root = find(i);
    if (!parts.has(root)) parts.set(root, []);
    parts.get(root)!.push(r);
  });
  for (const br of bridges) parts.get(find(br.member))!.push(br.box);

  const out: HullPart[] = [];
  for (const [root, rects] of parts) {
    const members = boxes.map((_, i) => i).filter((i) => find(i) === root);
    // The label sits in the topmost box with room above its card.
    const topmost = (list: number[]) =>
      list.reduce((a, b) => (boxes[b].y1 < boxes[a].y1 || (boxes[b].y1 === boxes[a].y1 && boxes[b].x1 < boxes[a].x1) ? b : a));
    const roomy = members.filter((i) => cards[i].y1 - boxes[i].y1 >= LABEL_ROOM);
    const at = boxes[topmost(roomy.length ? roomy : members)];
    out.push({ path: unionPath(rects, radius), anchor: { x: at.x1, y: at.y1 }, outside: !roomy.length, size: members.length });
  }
  return out;
}

/** Shrinks a card's padding where a card of another group is close, to half the gap between them. */
function fit(box: Rect, card: Rect, foreign: Rect[]): Rect {
  const r = { ...box };
  const half = (gap: number) => Math.max(4, gap / 2);
  for (const f of foreign) {
    const besideY = f.y1 < r.y2 && f.y2 > r.y1;
    const besideX = f.x1 < r.x2 && f.x2 > r.x1;
    if (besideY && f.x1 >= card.x2) r.x2 = Math.min(r.x2, card.x2 + half(f.x1 - card.x2));
    if (besideY && f.x2 <= card.x1) r.x1 = Math.max(r.x1, card.x1 - half(card.x1 - f.x2));
    if (besideX && f.y1 >= card.y2) r.y2 = Math.min(r.y2, card.y2 + half(f.y1 - card.y2));
    if (besideX && f.y2 <= card.y1) r.y1 = Math.max(r.y1, card.y1 - half(card.y1 - f.y2));
  }
  return r;
}

/** The outline of a union of rectangles as one SVG path; holes run the other way round. */
export function unionPath(rects: Rect[], radius: number): string {
  const xs = [...new Set(rects.flatMap((r) => [r.x1, r.x2]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.y1, r.y2]))].sort((a, b) => a - b);
  const cols = xs.length - 1;
  const rows = ys.length - 1;
  if (cols < 1 || rows < 1) return '';
  const filled = new Uint8Array(cols * rows);
  for (const r of rects) {
    const i1 = xs.indexOf(r.x1);
    const i2 = xs.indexOf(r.x2);
    const j1 = ys.indexOf(r.y1);
    const j2 = ys.indexOf(r.y2);
    for (let i = i1; i < i2; i++) for (let j = j1; j < j2; j++) filled[j * cols + i] = 1;
  }
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < cols && j < rows && filled[j * cols + i] === 1;

  // Boundary edges between grid points, clockwise on screen (y grows down).
  type P = [number, number];
  const edges = new Map<string, P[]>();
  const key = (p: P) => `${p[0]},${p[1]}`;
  const add = (from: P, to: P) => {
    const k = key(from);
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k)!.push(to);
  };
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      if (!inside(i, j)) continue;
      if (!inside(i, j - 1)) add([i, j], [i + 1, j]);
      if (!inside(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
      if (!inside(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
      if (!inside(i - 1, j)) add([i, j + 1], [i, j]);
    }

  let d = '';
  for (const startKey of [...edges.keys()]) {
    while (edges.get(startKey)?.length) {
      const start = startKey.split(',').map(Number) as P;
      const loop: P[] = [start];
      let cur = start;
      let dir: P = [0, 0];
      for (;;) {
        const outs = edges.get(key(cur))!;
        // Where two parts touch at a corner, turn right to keep their loops apart.
        let k = 0;
        if (outs.length > 1) {
          const right: P = [-dir[1], dir[0]];
          const r = outs.findIndex((o) => o[0] - cur[0] === right[0] && o[1] - cur[1] === right[1]);
          if (r >= 0) k = r;
        }
        const next = outs.splice(k, 1)[0];
        dir = [Math.sign(next[0] - cur[0]), Math.sign(next[1] - cur[1])];
        cur = next;
        if (cur[0] === start[0] && cur[1] === start[1]) break;
        loop.push(cur);
      }
      d += roundedLoop(simplify(loop.map(([i, j]) => [xs[i], ys[j]] as P)), radius);
    }
  }
  return d;
}

/** Drops points in the middle of straight runs. */
function simplify(pts: [number, number][]): [number, number][] {
  return pts.filter((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length];
    const b = pts[(i + 1) % pts.length];
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
  });
}

function roundedLoop(pts: [number, number][], radius: number): string {
  const n = pts.length;
  if (n < 3) return '';
  const f = (v: number) => Math.round(v * 10) / 10;
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n];
    const p = pts[i];
    const b = pts[(i + 1) % n];
    const la = Math.hypot(p[0] - a[0], p[1] - a[1]);
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const r = Math.min(radius, la / 2, lb / 2);
    const s: [number, number] = [p[0] + ((a[0] - p[0]) / la) * r, p[1] + ((a[1] - p[1]) / la) * r];
    const e: [number, number] = [p[0] + ((b[0] - p[0]) / lb) * r, p[1] + ((b[1] - p[1]) / lb) * r];
    d += `${i === 0 ? 'M' : 'L'}${f(s[0])} ${f(s[1])}Q${f(p[0])} ${f(p[1])} ${f(e[0])} ${f(e[1])}`;
  }
  return d + 'Z';
}
