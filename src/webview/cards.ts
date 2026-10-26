import type { Core, NodeSingular } from 'cytoscape';
import { h } from './dom';

/** Card height in model units. Width comes from the node's `width` data. */
export const CARD_HEIGHT = 64;
/** Below this zoom cards collapse to colored blocks and groups show big names. */
const LOD_ZOOM = 0.45;
const MAX_TAGS = 2;

const ICONS: Record<string, string> = {
  app: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  service: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9zM9 2v2M15 2v2M9 20v2M15 20v2"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  library: '<path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h7M8 11h5"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  idea: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
};

/** Picks an icon from words in the type name, e.g. "user-db" → database. */
function iconFor(type: string): string | undefined {
  const t = type.toLowerCase();
  const rules: [RegExp, string][] = [
    [/db|database|store|table|cache|queue/, 'database'],
    [/service|api|server|backend|gateway|worker|function/, 'service'],
    [/app|ui|frontend|client|web|mobile|screen|page/, 'app'],
    [/lib|package|module|sdk|kit|component/, 'library'],
    [/person|user|team|people|owner|role/, 'person'],
    [/idea|topic|thought|concept|note/, 'idea'],
    [/task|todo|issue|story|ticket/, 'task'],
    [/doc|spec|file|paper|article/, 'doc'],
  ];
  return rules.find(([re]) => re.test(t))?.[1];
}

export function rgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

interface Card {
  el: HTMLElement;
  label: HTMLElement;
  sig: string;
}

/**
 * Draws HTML cards on top of the cytoscape canvas (which keeps doing hit testing,
 * dragging and edges), soft group hulls behind it and a minimap.
 */
export class CardLayer {
  private hullLayer = h('div', { class: 'hull-layer' });
  private cardLayer = h('div', { class: 'card-layer' });
  private minimap = h('canvas', { class: 'minimap', width: 196, height: 120, title: 'Click to move the view' });
  private cards = new Map<string, Card>();
  private hulls = new Map<string, HTMLElement>();
  private frame = 0;
  private ready = false;
  private editing?: string;
  groups = true;

  constructor(private readonly cy: Core, canvas: HTMLElement, overlayParent: HTMLElement) {
    canvas.before(this.hullLayer);
    canvas.after(this.cardLayer);
    overlayParent.append(this.minimap);
    cy.on('render', () => this.schedule());
    this.minimap.addEventListener('mousedown', (e) => this.onMinimap(e));
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  /** Cards created after this call fade and spring in. */
  markReady() {
    this.ready = true;
  }

  private update() {
    const cy = this.cy;
    const zoom = cy.zoom();
    const pan = cy.pan();
    const low = zoom < LOD_ZOOM;
    this.cardLayer.classList.toggle('lod-low', low);
    this.hullLayer.classList.toggle('lod-low', low);

    const seen = new Set<string>();
    cy.nodes().forEach((n) => {
      const id = n.id();
      seen.add(id);
      const card = this.cards.get(id) ?? this.createCard(n);
      this.updateContent(card, n);
      const hidden = n.hasClass('hidden');
      card.el.style.display = hidden ? 'none' : '';
      if (hidden) return;
      const p = n.position();
      const w = n.data('width') as number;
      const x = (p.x - w / 2) * zoom + pan.x;
      const y = (p.y - CARD_HEIGHT / 2) * zoom + pan.y;
      card.el.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
      const cls = card.el.classList;
      cls.toggle('sel', n.selected());
      cls.toggle('dim', n.hasClass('fdim'));
      cls.toggle('slice-dim', n.hasClass('dimmed'));
      cls.toggle('hit', n.hasClass('search-hit'));
      cls.toggle('hover', n.hasClass('hover'));
      cls.toggle('drop', n.hasClass('drop-target'));
    });
    for (const [id, card] of this.cards)
      if (!seen.has(id)) {
        card.el.remove();
        this.cards.delete(id);
      }

    this.updateHulls(zoom, pan);
    this.drawMinimap();
  }

  private createCard(n: NodeSingular): Card {
    const el = h('div', { class: this.ready ? 'card pop' : 'card' });
    const card: Card = { el, label: h('span', { class: 'card-label' }), sig: '' };
    el.addEventListener('animationend', () => el.classList.remove('pop'));
    this.cardLayer.append(el);
    this.cards.set(n.id(), card);
    return card;
  }

  private updateContent(card: Card, n: NodeSingular) {
    const d = n.data();
    const tags: string[] = d.tags ?? [];
    const sig = [d.label, d.type, d.typeName, d.color, d.width, tags.join(',')].join('|');
    if (sig === card.sig || this.editing === n.id()) return;
    card.sig = sig;
    const color: string = d.color;
    const icon = d.type ? iconFor(d.type) : undefined;
    const tile = h('span', { class: 'card-icon', style: { background: rgba(color, 0.16), color } });
    if (icon) tile.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;
    else tile.textContent = (d.label || '?').trim().charAt(0).toUpperCase();
    card.label = h('span', { class: 'card-label' }, d.label);
    card.el.style.width = `${d.width}px`;
    card.el.style.setProperty('--c', color);
    card.el.replaceChildren(
      tile,
      h('span', { class: 'card-text' },
        card.label,
        h('span', { class: 'card-meta' },
          d.typeName && h('span', { class: 'card-type' }, d.typeName),
          tags.slice(0, MAX_TAGS).map((t) => h('span', { class: 'card-chip' }, t)),
          tags.length > MAX_TAGS && h('span', { class: 'card-chip' }, `+${tags.length - MAX_TAGS}`),
        ),
      ),
    );
  }

  /** Turns the card's name into a text field. `done` gets the text and the key that ended editing. */
  editLabel(id: string, done: (value: string, via: 'enter' | 'tab' | 'escape' | 'blur') => void) {
    this.update();
    const card = this.cards.get(id);
    if (!card) return;
    this.editing = id;
    const input = h('input', { class: 'card-input', value: card.label.textContent ?? '', 'aria-label': 'Node name', spellcheck: false });
    let finished = false;
    const finish = (via: 'enter' | 'tab' | 'escape' | 'blur') => {
      if (finished) return;
      finished = true;
      this.editing = undefined;
      card.sig = '';
      card.el.classList.remove('editing');
      done(input.value, via);
      this.schedule();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish('enter');
      else if (e.key === 'Tab') finish('tab');
      else if (e.key === 'Escape') finish('escape');
      else return;
      e.preventDefault();
    });
    input.addEventListener('blur', () => finish('blur'));
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    card.label.replaceWith(input);
    card.el.classList.add('editing');
    input.focus();
    input.select();
  }

  private updateHulls(zoom: number, pan: { x: number; y: number }) {
    const groups = new Map<string, { color: string; name: string; x1: number; y1: number; x2: number; y2: number; n: number }>();
    if (this.groups) {
      this.cy.nodes().forEach((n) => {
        const type = n.data('type') as string;
        if (!type || n.hasClass('hidden')) return;
        const p = n.position();
        const w = n.data('width') / 2;
        const g = groups.get(type) ?? { color: n.data('typeColor'), name: n.data('typeName'), x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity, n: 0 };
        g.x1 = Math.min(g.x1, p.x - w);
        g.x2 = Math.max(g.x2, p.x + w);
        g.y1 = Math.min(g.y1, p.y - CARD_HEIGHT / 2);
        g.y2 = Math.max(g.y2, p.y + CARD_HEIGHT / 2);
        g.n++;
        groups.set(type, g);
      });
    }
    for (const [type, g] of groups) {
      let el = this.hulls.get(type);
      if (!el) {
        el = h('div', { class: 'hull' }, h('span', { class: 'hull-label' }));
        this.hullLayer.append(el);
        this.hulls.set(type, el);
      }
      const pad = 24;
      const top = 34;
      const x = (g.x1 - pad) * zoom + pan.x;
      const y = (g.y1 - top) * zoom + pan.y;
      Object.assign(el.style, {
        transform: `translate(${x}px, ${y}px)`,
        width: `${(g.x2 - g.x1 + pad * 2) * zoom}px`,
        height: `${(g.y2 - g.y1 + top + pad) * zoom}px`,
        borderRadius: `${28 * zoom}px`,
        background: rgba(g.color, 0.06),
        borderColor: rgba(g.color, 0.32),
      });
      const label = el.firstElementChild as HTMLElement;
      label.textContent = `${g.name} · ${g.n}`;
      label.style.color = g.color;
    }
    for (const [type, el] of this.hulls)
      if (!groups.has(type)) {
        el.remove();
        this.hulls.delete(type);
      }
  }

  private mini?: { scale: number; ox: number; oy: number };

  private drawMinimap() {
    const ctx = this.minimap.getContext('2d');
    if (!ctx) return;
    const W = this.minimap.width;
    const H = this.minimap.height;
    ctx.clearRect(0, 0, W, H);
    const nodes = this.cy.nodes().not('.hidden');
    this.minimap.classList.toggle('hidden', nodes.length < 2);
    if (nodes.length < 2) return;
    const bb = nodes.boundingBox({});
    const ext = this.cy.extent();
    const x1 = Math.min(bb.x1, ext.x1);
    const y1 = Math.min(bb.y1, ext.y1);
    const x2 = Math.max(bb.x2, ext.x2);
    const y2 = Math.max(bb.y2, ext.y2);
    const pad = 8;
    const scale = Math.min((W - pad * 2) / (x2 - x1), (H - pad * 2) / (y2 - y1));
    const ox = pad + ((W - pad * 2) - (x2 - x1) * scale) / 2 - x1 * scale;
    const oy = pad + ((H - pad * 2) - (y2 - y1) * scale) / 2 - y1 * scale;
    this.mini = { scale, ox, oy };
    nodes.forEach((n) => {
      const p = n.position();
      const w = n.data('width') * scale;
      const hgt = Math.max(3, CARD_HEIGHT * scale);
      ctx.globalAlpha = n.hasClass('fdim') || n.hasClass('dimmed') ? 0.3 : 1;
      ctx.fillStyle = n.data('color');
      ctx.beginPath();
      ctx.roundRect(p.x * scale + ox - w / 2, p.y * scale + oy - hgt / 2, w, hgt, 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    ctx.strokeStyle = getComputedStyle(this.minimap).getPropertyValue('--bm-accent').trim() || '#5B9BFF';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(ext.x1 * scale + ox, ext.y1 * scale + oy, (ext.x2 - ext.x1) * scale, (ext.y2 - ext.y1) * scale, 4);
    ctx.stroke();
  }

  private onMinimap(e: MouseEvent) {
    const move = (ev: MouseEvent) => {
      if (!this.mini) return;
      const r = this.minimap.getBoundingClientRect();
      const mx = (ev.clientX - r.left - this.mini.ox) / this.mini.scale;
      const my = (ev.clientY - r.top - this.mini.oy) / this.mini.scale;
      const z = this.cy.zoom();
      this.cy.pan({ x: this.cy.width() / 2 - mx * z, y: this.cy.height() / 2 - my * z });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    move(e);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
}
