import {
  BrainEdge,
  BrainMap,
  BrainNode,
  DEFAULT_LAYOUT,
  FileFormat,
  LayoutName,
  LayoutSettings,
  Position,
  Slice,
  autoColor,
  emptyMap,
  newId,
  resolveEdgeStyle,
  computeSlice,
  resolveNodeStyle,
  tidySlice,
  uniqueTypes,
} from '../shared/model';
import { describeFilter } from '../shared/filter';
import { filterEditor } from './filterEditor';
import { BarSettings, HostMessage, WebviewMessage } from '../shared/messages';
import { GraphView } from './graph';
import { CardLayer, rgba } from './cards';
import { checklist, datalist, field, h, select, splitList } from './dom';
import { laneAttributes, laneNames } from './lanes';
import { ContextMenu, MenuItem, confirmDialog, pickNode, tagEditor } from './overlays';
import { Point, Popover, barButton, below, colorSwatches, tagPicker, typeList } from './panels';

const vscode = acquireVsCodeApi();
const post = (msg: WebviewMessage) => vscode.postMessage(msg);

type Tab = 'style' | 'layout' | 'slices';

interface UiState {
  details?: boolean;
  edgeType?: string;
  focus?: boolean;
  groups?: boolean;
}

const LAYOUTS: { value: LayoutName; label: string }[] = [
  { value: 'force', label: 'Physics (cola)' },
  { value: 'hierarchy', label: 'Hierarchy' },
  { value: 'fcose', label: 'Organic (fCoSE)' },
  { value: 'breadthfirst', label: 'Tree' },
  { value: 'concentric', label: 'Concentric' },
  { value: 'circle', label: 'Circle' },
  { value: 'grid', label: 'Grid' },
  { value: 'typeColumns', label: 'Columns' },
  { value: 'typeRows', label: 'Rows' },
];

/** Starter graphs offered on an empty canvas. */
const TEMPLATES: { name: string; nodes: BrainNode[]; edges: [string, string, string?][] }[] = [
  {
    name: 'Mind map',
    nodes: [
      { id: 'center', label: 'Main topic', type: 'topic' },
      { id: 'a', label: 'Idea A', type: 'idea' },
      { id: 'b', label: 'Idea B', type: 'idea' },
      { id: 'c', label: 'Idea C', type: 'idea' },
    ],
    edges: [['center', 'a'], ['center', 'b'], ['center', 'c']],
  },
  {
    name: 'Architecture',
    nodes: [
      { id: 'web', label: 'Web App', type: 'app' },
      { id: 'api', label: 'API', type: 'service' },
      { id: 'db', label: 'Database', type: 'database' },
    ],
    edges: [['web', 'api', 'depends-on'], ['api', 'db', 'depends-on']],
  },
  {
    name: 'Dependency tree',
    nodes: [
      { id: 'root', label: 'My project', type: 'module' },
      { id: 'dep1', label: 'Dependency 1', type: 'library' },
      { id: 'dep2', label: 'Dependency 2', type: 'library' },
    ],
    edges: [['root', 'dep1', 'depends-on'], ['root', 'dep2', 'depends-on']],
  },
];

const ICON = {
  logo: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="8" r="3"/><circle cx="10" cy="18" r="3"/><path d="M8.6 7.2l6.6.6M7.4 8.6l1.6 6.6M16.4 10.4l-4.4 5.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  relayout: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  tag: '<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>',
  connect: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8 16c4 0 4-8 8-8"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  details: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  type: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  slice: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  groups: '<rect x="3" y="3" width="11" height="11" rx="3"/><rect x="10" y="10" width="11" height="11" rx="3"/>',
  focus: '<circle cx="12" cy="12" r="3"/><path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/>',
};

/** How long the mouse rests on a node before its hover card shows. */
const HOVER_DELAY = 500;

function svgIcon(paths: string, size = 16): SVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  return wrap.firstElementChild as SVGElement;
}

const kbd = (k: string) => h('kbd', {}, k);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const nameOf = (n: BrainNode | undefined) => n?.label || n?.id || '?';

/** "Shipping #core :service" → name "Shipping", tag "core", type "service". */
function parseQuickName(text: string) {
  const tags: string[] = [];
  let type: string | undefined;
  const words = text.split(/\s+/).filter((w) => {
    if (w.length > 1 && w.startsWith('#')) return tags.push(w.slice(1)), false;
    if (w.length > 1 && w.startsWith(':')) return (type = w.slice(1)), false;
    return true;
  });
  return { label: words.join(' ').trim(), tags, type };
}

class App {
  map: BrainMap = emptyMap();
  format: FileFormat = 'yaml';
  fileName = '';
  selection: string[] = [];
  ui: UiState = vscode.getState<UiState>() ?? {};
  /** The details sidebar on the right. */
  detailsOpen = this.ui.details ?? false;
  /** The open Layout / Style / Slices menu from the toolbar. */
  settings?: { kind: Tab; pop: Popover };
  loaded = false;
  /** Dependency type used for new edges: the last one the user picked. */
  edgeType = this.ui.edgeType ?? '';
  /** Type picked while dragging a node onto another one. */
  dropType?: string;
  dropping?: { source: string; target: string };
  editingSlice?: Slice;

  private graph: GraphView;
  private cards: CardLayer;
  private toolbar = h('div', { class: 'toolbar' });
  private panel = h('div', { class: 'panel' });
  private stage = h('div', { class: 'stage' });
  private error = h('div', { class: 'error hidden' });
  private empty = h('div', { class: 'empty hidden' });
  /** The bars at the bottom; the host sends the setting. */
  bars: BarSettings = { legend: false, hints: false };
  /** The ? and i buttons at the bottom left that show the bars. */
  private barToggles = h('div', { class: 'bar-toggles' });
  private legend = h('div', { class: 'legend floating-bar' });
  private hints = h('div', { class: 'hints floating-bar' });
  private dropChips = h('div', { class: 'drop-chips hidden' });
  private minibar = h('div', { class: 'minibar hidden' });
  private hovercard = h('div', { class: 'hovercard hidden' });
  private hoverTimer?: number;
  private menu: ContextMenu;
  private postTimer?: number;
  private placeFrame = 0;

  constructor(root: HTMLElement) {
    const canvas = h('div', { class: 'canvas' });
    this.stage.append(canvas, this.empty, this.barToggles, this.legend, this.hints, this.dropChips, this.minibar, this.hovercard, this.error);
    root.append(this.toolbar, h('div', { class: 'main' }, this.stage, this.panel));
    this.menu = new ContextMenu(document.body);
    this.graph = new GraphView(canvas, {
      onSelect: (ids) => {
        this.selection = ids;
        Popover.current?.close();
        this.renderSelectionUi();
      },
      onBackgroundDoubleClick: (pos) => this.addNode(pos),
      onNodeDoubleClick: (id) => this.editInline(id),
      onContextMenu: (target, client, pos) => this.openMenu(target, client, pos),
      onViewport: () => {
        cancelAnimationFrame(this.placeFrame);
        this.placeFrame = requestAnimationFrame(() => {
          this.placeMiniBar();
          this.placeDropChips();
          this.placeHoverCard();
        });
      },
      onHover: (id) => this.hover(id),
      onDropHover: (source, target) => {
        this.dropping = target ? { source, target } : undefined;
        this.renderDropChips();
      },
      onDropConnect: (source, target) => this.connect(source, target, true, this.dropType ?? this.edgeType),
    });
    this.graph.focus = this.ui.focus ?? true;
    this.cards = new CardLayer(this.graph.cy, canvas, this.stage);
    this.cards.groups = this.ui.groups ?? true;
    this.graph.groupLayout = this.cards.groups;
    this.renderEmpty();
    this.renderHints();

    window.addEventListener('message', (e: MessageEvent<HostMessage>) => this.onMessage(e.data));
    window.addEventListener('keydown', (e) => this.onKey(e));
    post({ type: 'ready' });
  }

  private saveUi(patch: Partial<UiState>) {
    this.ui = { ...this.ui, ...patch };
    vscode.setState(this.ui);
  }

  // ---------------------------------------------------------------- messaging

  private onMessage(msg: HostMessage) {
    if (msg.type === 'ui') {
      this.bars = msg.bars;
      this.renderOverlays();
      this.renderSettings();
      return;
    }
    if (msg.type === 'error') {
      this.error.textContent = msg.message + ' — fix the file in the text editor.';
      this.error.classList.remove('hidden');
      return;
    }
    this.error.classList.add('hidden');
    const prev = this.map;
    this.map = msg.map;
    this.format = msg.format;
    this.fileName = msg.fileName;
    this.graph.follow = this.layout.followSelection;
    this.cards.simplify = this.map.settings.style?.simplifyZoomedOut ?? true;
    // Render the toolbar first: its height decides the canvas size the layout fits into.
    this.renderToolbar();
    this.graph.sync(this.map);
    const layoutChanged =
      JSON.stringify(prev.settings.layout) !== JSON.stringify(this.map.settings.layout) ||
      prev.settings.activeSlice !== this.map.settings.activeSlice;
    const structureChanged = this.structureChanged();
    if (!this.loaded) {
      // Nothing is stored about positions: the layout arranges the graph on every open.
      this.loaded = true;
      if (this.map.nodes.length === 0) this.graph.centerPoint({ x: 0, y: 0 });
      else this.graph.runLayout(this.map);
      this.cards.markReady();
    } else if (layoutChanged || structureChanged) {
      this.graph.runLayout(this.map, { fit: false });
    }
    this.selection = this.selection.filter((id) => this.graph.cy.getElementById(id).nonempty());
    this.renderSettings();
    this.renderOverlays();
    this.renderSelectionUi();
  }

  /** Sends the model to the extension host (debounced) which writes it to the file. */
  private save() {
    window.clearTimeout(this.postTimer);
    this.postTimer = window.setTimeout(() => post({ type: 'edit', map: clone(this.map) }), 250);
  }

  /** Applies a model change: re-syncs the graph, re-renders UI and persists. */
  private commit(opts: { relayout?: boolean; fit?: boolean; panel?: boolean; popup?: boolean } = {}) {
    this.graph.follow = this.layout.followSelection;
    this.cards.simplify = this.map.settings.style?.simplifyZoomedOut ?? true;
    this.graph.sync(this.map);
    this.cards.schedule();
    // New or removed nodes/connections re-run the layout so the graph stays arranged.
    if (this.structureChanged() || opts.relayout) this.graph.runLayout(this.map, { fit: opts.fit ?? false });
    this.renderToolbar();
    if (opts.panel !== false) this.renderSettings();
    if (opts.popup) this.detailsKey = '';
    this.renderSelectionUi();
    this.renderOverlays();
    this.save();
  }

  private structureKey = '';

  /** True when nodes or connections were added, removed or rewired since the last call. */
  private structureChanged(): boolean {
    const key = JSON.stringify([
      this.map.nodes.map((n) => n.id),
      this.map.edges.map((e) => [e.source, e.target, e.type ?? '']),
    ]);
    const changed = key !== this.structureKey;
    this.structureKey = key;
    return changed;
  }

  get layout(): Required<LayoutSettings> {
    return { ...DEFAULT_LAYOUT, ...this.map.settings.layout };
  }

  private setLayout(patch: Partial<LayoutSettings>, relayout = true) {
    this.map.settings.layout = { ...this.layout, ...patch };
    this.commit({ relayout, fit: patch.name !== undefined });
  }

  // ---------------------------------------------------------------- editing

  private node(id: string) {
    return this.map.nodes.find((n) => n.id === id);
  }

  private edge(id: string) {
    return this.map.edges.find((e) => e.id === id);
  }

  private nodeTypeColor(type: string) {
    return this.map.settings.style?.nodeTypes?.[type]?.color ?? autoColor(type);
  }

  private nextLabel() {
    const used = new Set(this.map.nodes.map((n) => n.label));
    let i = this.map.nodes.length + 1;
    while (used.has(`Node ${i}`)) i++;
    return `Node ${i}`;
  }

  /** Creates a node, selects it and lets the user type its name right on the card. */
  private addNode(pos: Position, connectFrom?: string) {
    const node: BrainNode = { id: newId('n', this.map.nodes.map((n) => n.id)), label: this.nextLabel() };
    this.graph.placeAt(node.id, pos);
    const parent = connectFrom ? this.node(connectFrom) : undefined;
    // A connected node inherits the type of its parent – usually what you want in a mind map.
    if (parent?.type) node.type = parent.type;
    this.map.nodes.push(node);
    if (parent) this.map.edges.push(this.makeEdge(parent.id, node.id));
    this.commit();
    this.graph.select([node.id]);
    this.editInline(node.id, true);
  }

  private createFirstNode() {
    this.graph.cy.zoom(1);
    this.graph.centerPoint({ x: 0, y: 0 });
    this.addNode({ x: 0, y: 0 });
  }

  private applyTemplate(t: (typeof TEMPLATES)[number]) {
    this.map.nodes = clone(t.nodes);
    this.map.edges = t.edges.map(([source, target, type], i) => ({ id: `e${i + 1}`, source, target, type }));
    this.commit({ relayout: true, fit: true });
  }

  /** Adds a node next to `parentId`, in the direction with the most free space. */
  addChild(parentId: string) {
    const p = this.graph.cy.getElementById(parentId).position();
    const dist = this.layout.edgeLength + 80;
    const others = this.graph.cy.nodes().not('.hidden').map((n) => (n as any).position() as Position);
    let best = { x: p.x, y: p.y + dist };
    let bestScore = -1;
    for (let i = 0; i < 16; i++) {
      // Start pointing down and walk around the circle.
      const a = Math.PI / 2 + (i * Math.PI * 2) / 16;
      const c = { x: p.x + Math.cos(a) * dist * 1.3, y: p.y + Math.sin(a) * dist * 0.8 };
      const score = Math.min(...others.map((o) => Math.hypot(o.x - c.x, (o.y - c.y) * 2)));
      if (score > bestScore + 1) {
        bestScore = score;
        best = c;
      }
    }
    this.addNode(best, parentId);
  }

  /** A new node next to `id` that hangs off the same parent. */
  addSibling(id: string) {
    const parent = this.map.edges.find((e) => e.target === id)?.source;
    if (parent) return this.addChild(parent);
    const p = this.graph.cy.getElementById(id).position();
    this.addNode({ x: p.x + 240, y: p.y });
  }

  /** Name editing on the card. Accepts "#tag" and ":type" words as shortcuts. */
  private editInline(id: string, isNew = false) {
    this.cards.editLabel(id, (value, via) => {
      const node = this.node(id);
      if (!node) return;
      if (via !== 'escape') {
        const q = parseQuickName(value);
        if (q.label) node.label = q.label;
        if (q.type) node.type = q.type;
        if (q.tags.length) node.tags = [...new Set([...(node.tags ?? []), ...q.tags])];
        this.commit({ popup: true });
      } else if (isNew) this.renderSelectionUi();
      if (via === 'tab') this.addChild(id);
    });
  }

  private makeEdge(source: string, target: string, directed = true, type = this.edgeType): BrainEdge {
    return {
      id: newId('e', this.map.edges.map((e) => e.id)),
      source,
      target,
      type: type || undefined,
      directed: directed ? undefined : false,
    };
  }

  /** Lets the user type the name of another node (with suggestions) and connects to it. */
  private async connectWithPicker(id: string, at: Position) {
    // Only offer nodes that are not connected to this one yet (in any direction).
    const linked = new Set([id]);
    for (const e of this.map.edges) {
      if (e.source === id) linked.add(e.target);
      if (e.target === id) linked.add(e.source);
    }
    const options = this.map.nodes
      .filter((n) => !linked.has(n.id))
      .map((n) => ({ id: n.id, label: nameOf(n), detail: [n.type, n.label && n.label !== n.id ? n.id : ''].filter(Boolean).join(' · ') }));
    const picked = await pickNode(at, nameOf(this.node(id)), options);
    if (!picked) return;
    if (picked.direction === 'in') this.connect(picked.id, id, true);
    else this.connect(id, picked.id, picked.direction === 'out');
  }

  private connect(source: string, target: string, directed: boolean, type = this.edgeType) {
    const e = this.makeEdge(source, target, directed, type);
    this.map.edges.push(e);
    this.commit();
    this.graph.select([e.id]);
  }

  /** Asks for confirmation, then deletes the elements and every edge touching a deleted node. */
  async requestDelete(ids: string[]) {
    const nodes = ids.map((id) => this.node(id)).filter((n): n is BrainNode => !!n);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = this.map.edges.filter((e) => ids.includes(e.id) || nodeIds.has(e.source) || nodeIds.has(e.target));
    if (!nodes.length && !edges.length) return;
    const attached = edges.filter((e) => !ids.includes(e.id)).length;
    let title: string;
    let detail = 'You can undo this with Ctrl+Z.';
    if (nodes.length === 1 && edges.length === attached) {
      title = `Delete “${nameOf(nodes[0])}”?`;
      if (attached) detail = `Its ${attached} connection${attached > 1 ? 's' : ''} will be deleted too. ${detail}`;
    } else if (!nodes.length && edges.length === 1)
      title = `Delete the connection “${nameOf(this.node(edges[0].source))} ${edges[0].directed === false ? '↔' : '→'} ${nameOf(this.node(edges[0].target))}”?`;
    else title = `Delete ${nodes.length} node(s) and ${edges.length} connection(s)?`;
    if (!(await confirmDialog(document.body, title, 'Delete', detail))) return;

    const edgeIds = new Set(edges.map((e) => e.id));
    this.map.nodes = this.map.nodes.filter((n) => !nodeIds.has(n.id));
    this.map.edges = this.map.edges.filter((e) => !edgeIds.has(e.id));
    for (const s of this.map.settings.slices ?? []) s.roots = s.roots?.filter((r) => !nodeIds.has(r));
    this.selection = this.selection.filter((id) => !nodeIds.has(id) && !edgeIds.has(id));
    this.commit({ popup: true });
  }

  private renameNodeId(node: BrainNode, value: string) {
    const id = value.trim();
    if (!id || id === node.id) return;
    if (this.node(id)) {
      post({ type: 'notify', level: 'error', message: `A node with id "${id}" already exists.` });
      this.renderSelectionUi();
      return;
    }
    const old = node.id;
    for (const e of this.map.edges) {
      if (e.source === old) e.source = id;
      if (e.target === old) e.target = id;
    }
    for (const s of this.map.settings.slices ?? []) s.roots = s.roots?.map((r) => (r === old ? id : r));
    node.id = id;
    this.commit();
    this.graph.select([id]);
  }

  /** ` · 12/40`: how many nodes the active slice shows. */
  private sliceCount(): string {
    const slice = this.map.settings.slices?.find((s) => s.name === this.map.settings.activeSlice);
    if (!slice) return '';
    return ` · ${computeSlice(this.map, slice).nodes.size}/${this.map.nodes.length}`;
  }

  private showSlice(name: string | undefined) {
    this.map.settings.activeSlice = name || undefined;
    this.commit({ relayout: true, fit: true });
  }

  private toggleFocus() {
    this.graph.focus = !this.graph.focus;
    this.saveUi({ focus: this.graph.focus });
    this.graph.applyFocus();
    this.renderToolbar();
  }

  private toggleGroups() {
    this.cards.groups = !this.cards.groups;
    this.graph.groupLayout = this.cards.groups;
    this.saveUi({ groups: this.cards.groups });
    this.cards.schedule();
    this.graph.runLayout(this.map, { fit: false });
    this.renderToolbar();
  }

  // ---------------------------------------------------------------- context menu & keys

  /** Right-click: every action, with words and shortcuts. The mini bar only repeats the most used ones. */
  private openMenu(target: { kind: 'node' | 'edge' | 'background'; id?: string }, at: Position, pos: Position) {
    this.hover(undefined);
    Popover.current?.close();
    const items: MenuItem[] = [];
    const selNodes = this.selection.filter((s) => this.node(s));
    if (target.kind === 'node' && target.id && selNodes.length > 2 && selNodes.includes(target.id)) {
      const nodes = selNodes.map((id) => this.node(id)!);
      items.push(
        { label: `Set type for all ${nodes.length}`, hint: '▸', action: () => this.openTypePopover(at, nodes) },
        { label: 'Add tag to all', hint: '▸', action: () => this.openTagPopover(at, nodes) },
        { label: 'Save as slice', action: () => this.sliceFrom(selNodes, 'Selection', 'both', 0) },
        'separator',
        { label: 'Delete all…', hint: '⌫', danger: true, action: () => this.requestDelete(this.selection) },
      );
    } else if (target.kind === 'node' && target.id) {
      const id = target.id;
      const node = this.node(id)!;
      if (selNodes.length === 2 && selNodes.includes(id)) {
        const other = selNodes.find((s) => s !== id)!;
        const [a, b] = [nameOf(this.node(other)), nameOf(node)];
        items.push(
          { label: `Connect ${a} → ${b}`, action: () => this.connect(other, id, true) },
          { label: `Connect ${b} → ${a}`, action: () => this.connect(id, other, true) },
          { label: `Connect ${a} ↔ ${b}`, action: () => this.connect(other, id, false) },
          'separator',
        );
      }
      items.push(
        { label: 'Add child', hint: 'Tab', action: () => this.addChild(id) },
        { label: 'Add sibling', hint: 'Enter', action: () => this.addSibling(id) },
        { label: 'Connect with…', hint: 'C', action: () => this.connectWithPicker(id, at) },
        'separator',
        { label: 'Rename', hint: 'F2', action: () => this.editInline(id) },
        { label: 'Type', hint: '▸', action: () => this.openTypePopover(at, [node]) },
        { label: 'Color', hint: '▸', action: () => this.openColorPopover(at, node) },
        { label: 'Tags', hint: '▸', action: () => this.openTagPopover(at, [node]) },
        'separator',
        { label: 'Focus on this', action: () => {
          if (!this.graph.focus) this.toggleFocus();
          this.graph.select([id]);
        } },
        { label: 'Select neighbours', action: () => this.graph.select(this.graph.cy.getElementById(id).closedNeighborhood().nodes().map((n) => n.id())) },
        { label: 'Slice from here', action: () => this.sliceFrom([id]) },
        'separator',
        { label: 'Duplicate', action: () => this.duplicate(id) },
        { label: 'Copy id', action: () => this.copyText(id) },
        { label: 'Open details', hint: 'D', action: () => {
          this.graph.select([id]);
          this.toggleDetails(true);
        } },
        'separator',
        { label: 'Delete…', hint: '⌫', danger: true, action: () => this.requestDelete([id]) },
      );
    } else if (target.kind === 'edge' && target.id) {
      const e = this.edge(target.id);
      if (!e) return;
      const two = e.directed === false;
      items.push(
        { label: 'Type', hint: '▸', action: () => this.openEdgeTypePopover(at, e) },
        { label: 'Tags', hint: '▸', action: () => this.openTagPopover(at, [e]) },
        'separator',
        two
          ? { label: 'Make one-way →', action: () => { e.directed = undefined; this.commit({ popup: true }); } }
          : { label: 'Make two-way ↔', action: () => { e.directed = false; this.commit({ popup: true }); } },
        ...(!two ? [{ label: 'Reverse', action: () => this.reverse(e) }] : []),
        { label: 'Edit label', action: () => this.editEdgeLabel(e.id) },
        { label: 'Open details', hint: 'D', action: () => {
          this.graph.select([e.id]);
          this.toggleDetails(true);
        } },
        'separator',
        { label: 'Delete…', hint: '⌫', danger: true, action: () => this.requestDelete([e.id]) },
      );
    } else {
      items.push(
        { label: 'Add node here', hint: 'dbl-click', action: () => this.addNode(pos) },
        'separator',
        { label: 'Fit view', hint: 'Enter', action: () => this.graph.fit() },
        { label: 'Run layout', hint: 'L', action: () => this.graph.runLayout(this.map) },
        { label: this.cards.groups ? 'Hide groups' : 'Show groups', hint: 'G', action: () => this.toggleGroups() },
        { label: this.graph.focus ? 'Focus off' : 'Focus on', hint: 'F', action: () => this.toggleFocus() },
        'separator',
        { label: 'Save view as slice', action: () => this.saveViewAsSlice() },
      );
    }
    this.menu.show(items, at);
  }

  private duplicate(id: string) {
    const n = this.node(id);
    if (!n) return;
    const copy: BrainNode = { ...clone(n), id: newId('n', this.map.nodes.map((x) => x.id)), label: `${nameOf(n)} copy` };
    const p = this.graph.cy.getElementById(id).position();
    this.graph.placeAt(copy.id, { x: p.x + 40, y: p.y + 100 });
    this.map.nodes.push(copy);
    this.commit();
    this.graph.select([copy.id]);
  }

  private copyText(text: string) {
    navigator.clipboard?.writeText(text).then(
      () => post({ type: 'notify', level: 'info', message: `Copied "${text}"` }),
      () => post({ type: 'notify', level: 'error', message: 'Could not copy to the clipboard.' }),
    );
  }

  private editEdgeLabel(id: string) {
    this.graph.select([id]);
    this.toggleDetails(true);
    window.setTimeout(() => (this.panel.querySelector('input[name=edge-label]') as HTMLInputElement | null)?.focus(), 50);
  }

  /** The selected nodes and their neighbours, or a new slice to fill in. */
  private saveViewAsSlice() {
    const nodes = this.selection.filter((id) => this.node(id));
    if (nodes.length) return this.sliceFrom(nodes, 'Selection', 'both', 1);
    this.editingSlice = { name: newId('Slice ', (this.map.settings.slices ?? []).map((s) => s.name)) };
    this.openSettings('slices');
  }

  private reverse(e: BrainEdge) {
    [e.source, e.target] = [e.target, e.source];
    this.commit({ popup: true });
  }

  private centerView() {
    if (this.selection.length) this.graph.centerOn(this.selection);
    else this.graph.fit();
  }

  private onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      (this.toolbar.querySelector('.search input') as HTMLInputElement | null)?.focus();
      return;
    }
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    // Keys inside the edit window, toolbar or settings keep their normal meaning (Tab moves focus).
    if (t?.closest?.('.floating, .toolbar, .panel, .context-menu')) return;
    if (e.ctrlKey || e.metaKey || e.altKey || this.menu.open || document.querySelector('.modal, .picker')) return;
    // While dragging onto another node, number keys pick the connection type.
    if (this.dropping && /^[1-9]$/.test(e.key)) {
      const types = this.dropTypes();
      const pick = types[Number(e.key) - 1];
      if (pick !== undefined) {
        this.dropType = pick;
        this.renderDropChips();
      }
      e.preventDefault();
      return;
    }
    const nodes = this.selection.filter((id) => this.node(id));
    const one = nodes.length === 1 && this.selection.length === 1 ? nodes[0] : undefined;
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        this.requestDelete(this.selection);
        break;
      case 'Tab':
      case 'n':
        if (one) this.addChild(one);
        else if (!this.map.nodes.length) this.createFirstNode();
        else return;
        break;
      case 'Enter':
        // Shift+Enter, or Enter with nothing selected, centers the view (on the selection, if any).
        if (e.shiftKey || (!this.selection.length && this.map.nodes.length)) this.centerView();
        else if (one) this.addSibling(one);
        else if (!this.map.nodes.length) this.createFirstNode();
        else return;
        break;
      case 'F2':
        if (!one) return;
        this.editInline(one);
        break;
      case '#':
      case 't': {
        const target = one ? this.node(one) : this.selectedEdge();
        if (!target) return;
        const btn = this.minibar.querySelector(e.key === '#' ? '[aria-label="Add tag"]' : '[aria-label="Change type"]');
        const at = btn ? below(btn) : { x: 200, y: 200 };
        if (e.key === '#') this.openTagPopover(at, [target], btn as HTMLElement);
        else if (one) this.openTypePopover(at, [target as BrainNode], btn as HTMLElement);
        else this.openEdgeTypePopover(at, target as BrainEdge, btn as HTMLElement);
        break;
      }
      case 'd':
        this.toggleDetails();
        break;
      case 'c': {
        if (!one) return;
        const box = this.graph.renderedBox(one);
        const r = this.stage.getBoundingClientRect();
        this.connectWithPicker(one, box ? { x: r.x + box.x2 + 12, y: r.y + box.y1 } : { x: r.x + 40, y: r.y + 40 });
        break;
      }
      case 'f':
        this.toggleFocus();
        break;
      case 'F':
        this.graph.fit();
        break;
      case 'g':
        this.toggleGroups();
        break;
      case 'l':
        this.graph.runLayout(this.map);
        break;
      case 'Escape':
        this.graph.select([]);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  // ---------------------------------------------------------------- drag to connect

  private dropTypes(): string[] {
    const types = uniqueTypes(this.map).edgeTypes;
    return types.length ? types : [''];
  }

  private renderDropChips() {
    if (!this.dropping) {
      this.dropChips.classList.add('hidden');
      this.dropType = undefined;
      return;
    }
    const types = this.dropTypes();
    const current = this.dropType ?? (types.includes(this.edgeType) ? this.edgeType : types[0]);
    this.dropType = current;
    this.dropChips.replaceChildren(
      h('div', { class: 'drop-chip-row' },
        types.slice(0, 9).map((t, i) =>
          h('span', { class: t === current ? 'drop-chip active' : 'drop-chip' }, kbd(String(i + 1)), t || 'connection'),
        ),
      ),
      h('div', { class: 'drop-hint' }, 'Release to connect · number keys pick the type'),
    );
    this.dropChips.classList.remove('hidden');
    this.placeDropChips();
  }

  private placeDropChips() {
    if (!this.dropping) return;
    const box = this.graph.renderedBox(this.dropping.target);
    if (!box) return;
    this.dropChips.style.left = `${box.x1}px`;
    this.dropChips.style.top = `${box.y2 + 10}px`;
  }

  // ---------------------------------------------------------------- selection: mini bar, hover card, details

  /** Re-renders everything that depends on the selection. */
  private renderSelectionUi() {
    this.renderMiniBar();
    this.renderDetails();
  }

  private selectedNode() {
    return this.selection.length === 1 ? this.node(this.selection[0]) : undefined;
  }

  private selectedEdge() {
    return this.selection.length === 1 ? this.edge(this.selection[0]) : undefined;
  }

  private edgeTypeColor(type: string) {
    return this.map.settings.style?.edgeTypes?.[type]?.color ?? autoColor(type);
  }

  /** The small bar above the selection with the most used actions. Everything else is in the right-click menu. */
  private renderMiniBar() {
    const sel = this.selection;
    const node = this.selectedNode();
    const edge = this.selectedEdge();
    const nodes = sel.map((id) => this.node(id)).filter((n): n is BrainNode => !!n);
    const icon = (k: keyof typeof ICON) => svgIcon(ICON[k], 16);
    const sep = () => h('span', { class: 'bar-sep' });
    const typeButton = (type: string | undefined, color: string, onclick: (b: HTMLElement) => void) => {
      const b: HTMLButtonElement = h('button', { class: 'bar-type tipped', 'aria-label': 'Change type' },
        h('span', { class: 'dot', style: { background: color } }),
        type ?? 'No type',
        svgIcon(ICON.chevron, 10),
        h('span', { class: 'tip' }, 'Change type', kbd('T')),
      );
      b.onclick = () => onclick(b);
      return b;
    };
    let content: Node[] = [];
    if (node) {
      content = [
        typeButton(node.type, node.type ? this.nodeTypeColor(node.type) : 'var(--bm-muted)', (b) => this.openTypePopover(below(b), [node], b)),
        sep(),
        barButton(icon('tag'), 'Add tag', '#', (e) => this.openTagPopover(below(e.currentTarget as Element), [node], e.currentTarget as HTMLElement)),
        barButton(h('span', { class: 'color-dot', style: { background: resolveNodeStyle(this.map, node).color } }), 'Color', undefined,
          (e) => this.openColorPopover(below(e.currentTarget as Element), node, e.currentTarget as HTMLElement)),
        barButton(icon('plus'), 'Add child', 'Tab', () => this.addChild(node.id)),
        barButton(icon('connect'), 'Connect with…', 'C', (e) => this.connectWithPicker(node.id, below(e.currentTarget as Element))),
        barButton(icon('trash'), 'Delete', '⌫', () => this.requestDelete([node.id]), 'danger'),
        barButton(icon('more'), 'Details', 'D', () => this.toggleDetails(true)),
      ];
    } else if (edge) {
      const two = edge.directed === false;
      content = [
        typeButton(edge.type, edge.type ? this.edgeTypeColor(edge.type) : 'var(--bm-muted)', (b) => this.openEdgeTypePopover(below(b), edge, b)),
        sep(),
        barButton(icon('tag'), 'Add tag', '#', (e) => this.openTagPopover(below(e.currentTarget as Element), [edge], e.currentTarget as HTMLElement)),
        barButton(h('span', { class: 'bar-text' }, two ? '↔' : '→'), two ? 'Make one-way' : 'Make two-way', undefined, () => {
          edge.directed = two ? undefined : false;
          this.commit({ popup: true });
        }),
        !two && barButton(icon('swap'), 'Reverse', undefined, () => this.reverse(edge)),
        barButton(icon('trash'), 'Delete', '⌫', () => this.requestDelete([edge.id]), 'danger'),
        barButton(icon('more'), 'Details', 'D', () => this.toggleDetails(true)),
      ].filter((x): x is HTMLButtonElement => !!x);
    } else if (nodes.length === 2 && sel.length === 2) {
      const [a, b] = nodes;
      content = [
        h('span', { class: 'bar-label' }, '2 nodes'),
        sep(),
        barButton(h('span', { class: 'bar-text' }, `${nameOf(a)} → ${nameOf(b)}`), 'Connect one-way', undefined, () => this.connect(a.id, b.id, true), 'wide'),
        barButton(h('span', { class: 'bar-text' }, '↔'), 'Connect both ways', undefined, () => this.connect(a.id, b.id, false)),
        barButton(icon('trash'), 'Delete both', '⌫', () => this.requestDelete(sel), 'danger'),
      ];
    } else if (sel.length > 1) {
      content = [
        h('span', { class: 'bar-label' }, `${sel.length} selected`),
        sep(),
        nodes.length > 0 && barButton(icon('type'), 'Set type for all', undefined, (e) => this.openTypePopover(below(e.currentTarget as Element), nodes, e.currentTarget as HTMLElement)),
        nodes.length > 0 && barButton(icon('tag'), 'Add tag to all', undefined, (e) => this.openTagPopover(below(e.currentTarget as Element), nodes, e.currentTarget as HTMLElement)),
        nodes.length > 0 && barButton(icon('slice'), 'Save as slice', undefined, () => this.sliceFrom(nodes.map((n) => n.id), 'Selection', 'both', 0)),
        barButton(icon('trash'), 'Delete all', '⌫', () => this.requestDelete(sel), 'danger'),
      ].filter((x): x is HTMLElement => !!x);
    }
    this.minibar.replaceChildren(...content);
    this.minibar.classList.toggle('hidden', content.length === 0);
    requestAnimationFrame(() => this.placeMiniBar());
  }

  private placeMiniBar() {
    if (this.minibar.classList.contains('hidden')) return;
    const boxes = this.selection.map((id) => this.graph.renderedBox(id)).filter((b): b is NonNullable<typeof b> => !!b);
    if (!boxes.length) {
      this.minibar.style.visibility = 'hidden';
      return;
    }
    this.minibar.style.visibility = '';
    const x1 = Math.min(...boxes.map((b) => b.x1));
    const x2 = Math.max(...boxes.map((b) => b.x2));
    const y1 = Math.min(...boxes.map((b) => b.y1));
    const y2 = Math.max(...boxes.map((b) => b.y2));
    const w = this.minibar.offsetWidth;
    const hgt = this.minibar.offsetHeight;
    let y = y1 - hgt - 12;
    if (y < 8) y = y2 + 12;
    const x = Math.max(8, Math.min((x1 + x2) / 2 - w / 2, this.stage.clientWidth - w - 8));
    this.minibar.style.transform = `translate(${x}px, ${y}px)`;
  }

  private openTypePopover(at: Point, nodes: BrainNode[], owner?: HTMLElement) {
    const types = uniqueTypes(this.map).nodeTypes;
    const current = nodes.length === 1 ? nodes[0].type : undefined;
    const pop = new Popover(at, typeList({
      types, current, colorOf: (t) => this.nodeTypeColor(t), listId: 'dl-node-types',
      onPick: (t) => {
        nodes.forEach((n) => (n.type = t));
        pop.close();
        this.commit({ popup: true });
      },
    }), { owner, className: 'pop-narrow' });
  }

  private openEdgeTypePopover(at: Point, edge: BrainEdge, owner?: HTMLElement) {
    const pop = new Popover(at, typeList({
      types: uniqueTypes(this.map).edgeTypes, current: edge.type, colorOf: (t) => this.edgeTypeColor(t), listId: 'dl-edge-types',
      onPick: (t) => {
        edge.type = t;
        if (t) {
          this.edgeType = t;
          this.saveUi({ edgeType: t });
        }
        pop.close();
        this.commit({ popup: true });
      },
    }), { owner, className: 'pop-narrow' });
  }

  /** Tag field with suggestions. With several targets, new tags are added to all of them. */
  private openTagPopover(at: Point, targets: (BrainNode | BrainEdge)[], owner?: HTMLElement) {
    const single = targets.length === 1 ? targets[0] : undefined;
    new Popover(at, [tagPicker({
      current: single?.tags ?? [],
      known: uniqueTypes(this.map).tags,
      onChange: (tags) => {
        if (single) single.tags = tags.length ? tags : undefined;
        else targets.forEach((t) => (t.tags = [...new Set([...(t.tags ?? []), ...tags])]));
        this.commit({ panel: false });
      },
    })], { owner, className: 'pop-narrow' });
  }

  private openColorPopover(at: Point, node: BrainNode, owner?: HTMLElement) {
    const pop = new Popover(at, colorSwatches(node.color, (c) => {
      node.color = c;
      pop.close();
      this.commit({ panel: false });
    }), { owner, className: 'pop-narrow' });
  }

  // Hover card: read only, shows what does not fit on the card.

  private hovered?: string;

  private hover(id: string | undefined) {
    window.clearTimeout(this.hoverTimer);
    if (!id) {
      this.hovered = undefined;
      this.hovercard.classList.add('hidden');
      return;
    }
    this.hoverTimer = window.setTimeout(() => {
      if (this.menu.open || Popover.current || document.querySelector('.card-input')) return;
      this.hovered = id;
      this.renderHoverCard();
    }, HOVER_DELAY);
  }

  private renderHoverCard() {
    const n = this.hovered ? this.node(this.hovered) : undefined;
    if (!n) return this.hovercard.classList.add('hidden');
    const ins = this.map.edges.filter((e) => e.target === n.id);
    const outs = this.map.edges.filter((e) => e.source === n.id);
    const counts = new Map<string, number>();
    [...ins, ...outs].forEach((e) => e.type && counts.set(e.type, (counts.get(e.type) ?? 0) + 1));
    this.hovercard.replaceChildren(
      h('div', { class: 'hc-head' },
        h('span', { class: 'dot', style: { background: resolveNodeStyle(this.map, n).color } }),
        h('b', {}, nameOf(n)),
        n.type && h('span', { class: 'muted small' }, n.type),
      ),
      n.description ? h('div', { class: 'hc-desc' }, n.description) : h('div', { class: 'hc-desc muted' }, 'No description'),
      h('div', { class: 'hc-tags' }, (n.tags ?? []).map((t) => h('span', { class: 'chip' }, t))),
      h('div', { class: 'hc-foot' },
        h('span', {}, `${ins.length} in · ${outs.length} out`),
        h('span', {}, [...counts].map(([t, c]) => `${t} ×${c}`).join(' · ')),
      ),
    );
    this.hovercard.classList.remove('hidden');
    this.placeHoverCard();
  }

  private placeHoverCard() {
    if (this.hovercard.classList.contains('hidden') || !this.hovered) return;
    const box = this.graph.renderedBox(this.hovered);
    if (!box) return this.hovercard.classList.add('hidden');
    const w = this.hovercard.offsetWidth;
    const hgt = this.hovercard.offsetHeight;
    let x = box.x2 + 14;
    if (x + w > this.stage.clientWidth - 8) x = box.x1 - w - 14;
    const y = Math.max(8, Math.min(box.y1 - 4, this.stage.clientHeight - hgt - 8));
    this.hovercard.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
  }

  // Details sidebar: everything about the selection, including the rarely used fields.

  private detailsKey = '';

  private toggleDetails(open = !this.detailsOpen) {
    this.detailsOpen = open;
    this.saveUi({ details: open });
    this.detailsKey = '';
    this.renderDetails();
    this.renderToolbar();
    requestAnimationFrame(() => {
      this.graph.cy.resize();
      this.placeMiniBar();
    });
  }

  private renderDetails() {
    this.panel.classList.toggle('hidden', !this.detailsOpen);
    if (!this.detailsOpen) return;
    const key = this.selection.join(',');
    // Don't rebuild the form under the cursor while the user is typing in it.
    if (key === this.detailsKey && this.panel.contains(document.activeElement)) return;
    this.detailsKey = key;
    const node = this.selectedNode();
    const edge = this.selectedEdge();
    const color = node ? resolveNodeStyle(this.map, node).color : edge ? resolveEdgeStyle(this.map, edge).color : 'var(--bm-accent)';
    const title = node ? nameOf(node) : edge ? 'Connection' : this.selection.length ? `${this.selection.length} selected` : 'Details';
    const body = node ? this.nodeDetails(node) : edge ? this.edgeDetails(edge) : this.selection.length
      ? [h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: () => this.requestDelete(this.selection) }, svgIcon(ICON.trash, 15), ' Delete all…'))]
      : [h('p', { class: 'muted' }, 'Select a node or a connection. Its details show up here: description, id, colors and all connections.')];
    this.panel.replaceChildren(
      h('div', { class: 'details-head' },
        h('span', { class: 'dot', style: { background: color } }),
        h('span', { class: 'details-title' }, title),
        h('button', { class: 'icon-btn', 'aria-label': 'Close details', title: 'Close (D)', onclick: () => this.toggleDetails(false) }, svgIcon(ICON.close, 14)),
      ),
      h('div', { class: 'details-body' }, ...body.filter((x): x is HTMLElement => !!x)),
    );
  }

  /** Text input that writes the model on change (blur or Enter). */
  private input(value: string | undefined, apply: (v: string) => void, attrs: Record<string, any> = {}) {
    return h('input', {
      value: value ?? '',
      ...attrs,
      onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && (e.target as HTMLInputElement).blur(),
      onchange: (e: Event) => {
        apply((e.target as HTMLInputElement).value);
        this.commit({ panel: false });
      },
    });
  }

  /** Pills to pick one of the known types, plus a field for a new one. */
  private typePicker(current: string | undefined, known: string[], colorOf: (t: string) => string, listId: string, apply: (t: string | undefined) => void) {
    const types = [...new Set([...known, ...(current ? [current] : [])])];
    return h('div', { class: 'type-pills' },
      types.map((t) =>
        h('button', {
          class: t === current ? 'pill active' : 'pill',
          style: t === current ? { borderColor: rgba(colorOf(t), 0.7), background: rgba(colorOf(t), 0.16) } : {},
          title: t === current ? 'Click again to clear' : `Set type to ${t}`,
          onclick: () => apply(t === current ? undefined : t),
        }, h('span', { class: 'dot', style: { background: colorOf(t) } }), t),
      ),
      h('input', {
        class: 'pill-input', placeholder: '+ type', list: listId,
        onkeydown: (e: KeyboardEvent) => {
          const v = (e.target as HTMLInputElement).value.trim();
          if (e.key === 'Enter' && v) apply(v);
        },
      }),
    );
  }

  private nodeDetails(node: BrainNode): (HTMLElement | false)[] {
    const types = uniqueTypes(this.map);
    const conns = this.map.edges.filter((e) => e.source === node.id || e.target === node.id);
    return [
      field('Name', this.input(node.label, (v) => (node.label = v), { class: 'name-input' })),
      field('Type', this.typePicker(node.type, types.nodeTypes, (t) => this.nodeTypeColor(t), 'dl-node-types', (t) => {
        node.type = t;
        this.detailsKey = '';
        this.commit({ popup: true });
      })),
      field('Tags', tagEditor(node.tags ?? [], (tags) => {
        node.tags = tags.length ? tags : undefined;
        this.commit({ panel: false });
      }, 'dl-tags')),
      field('Description', h('textarea', { rows: 5, value: node.description ?? '', placeholder: 'What is this?',
        onchange: (e: Event) => { node.description = (e.target as HTMLTextAreaElement).value || undefined; this.commit({ panel: false }); } })),
      field('Color', h('div', { class: 'swatch-field' }, ...colorSwatches(node.color, (c) => {
        node.color = c;
        this.detailsKey = '';
        this.commit({ popup: true });
      }))),
      field('Id', h('input', {
        value: node.id, class: 'mono',
        onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && (e.target as HTMLInputElement).blur(),
        onchange: (e: Event) => this.renameNodeId(node, (e.target as HTMLInputElement).value),
      })),
      h('div', { class: 'field' },
        h('span', {}, `Connections · ${conns.length}`),
        conns.length
          ? h('div', { class: 'conns' },
              conns.map((e) => {
                const other = e.source === node.id ? e.target : e.source;
                return h('button', { class: 'conn', onclick: () => this.graph.select([other]) },
                  h('span', { class: 'conn-arrow' }, e.directed === false ? '↔' : e.source === node.id ? '→' : '←'),
                  h('span', { class: 'conn-name' }, nameOf(this.node(other))),
                  e.type && h('span', { class: 'conn-type', style: { color: this.edgeTypeColor(e.type) } }, e.type),
                );
              }))
          : h('span', { class: 'muted small' }, 'None yet. Drag this node onto another one, or press C.'),
      ),
    ];
  }

  private edgeDetails(edge: BrainEdge): (HTMLElement | false)[] {
    const two = edge.directed === false;
    const link = (id: string) => h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.graph.select([id]); } }, nameOf(this.node(id)));
    return [
      h('div', { class: 'edge-ends' }, link(edge.source), h('span', { class: 'arrow' }, two ? '↔' : '→'), link(edge.target)),
      field('Direction', h('div', { class: 'segmented' },
        h('button', { class: two ? '' : 'active', onclick: () => { edge.directed = undefined; this.detailsKey = ''; this.commit({ popup: true }); } }, '→ one-way'),
        h('button', { class: two ? 'active' : '', onclick: () => { edge.directed = false; this.detailsKey = ''; this.commit({ popup: true }); } }, '↔ two-way'),
        !two && h('button', { class: 'rev', title: 'Reverse direction', onclick: () => this.reverse(edge) }, '⇄'),
      )),
      field('Type', this.typePicker(edge.type, uniqueTypes(this.map).edgeTypes, (t) => this.edgeTypeColor(t), 'dl-edge-types', (t) => {
        edge.type = t;
        if (t) {
          this.edgeType = t;
          this.saveUi({ edgeType: t });
        }
        this.detailsKey = '';
        this.commit({ popup: true });
      })),
      field('Tags', tagEditor(edge.tags ?? [], (tags) => {
        edge.tags = tags.length ? tags : undefined;
        this.commit({ panel: false });
      }, 'dl-tags')),
      field('Label', this.input(edge.label, (v) => (edge.label = v || undefined), { placeholder: 'optional', name: 'edge-label' })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn danger', onclick: () => this.requestDelete([edge.id]) }, svgIcon(ICON.trash, 15), ' Delete…'),
      ),
    ];
  }

  // ---------------------------------------------------------------- toolbar, overlays, side panel

  private renderEmpty() {
    this.empty.replaceChildren(
      h('div', { class: 'plus-wrap' },
        h('span', { class: 'ring' }),
        h('span', { class: 'ring ring2' }),
        h('button', { class: 'empty-plus', 'aria-label': 'Create the first node', title: 'Create the first node', onclick: () => this.createFirstNode() }, svgIcon(ICON.plus, 34)),
      ),
      h('div', { class: 'empty-title' }, 'Start with one thought'),
      h('div', { class: 'empty-hint' }, 'Click ', h('b', {}, '+'), ' or press ', kbd('Enter'), ', then just type.'),
      h('div', { class: 'templates' },
        TEMPLATES.map((t) => h('button', { class: 'template', onclick: () => this.applyTemplate(t) }, t.name)),
      ),
    );
  }

  private renderHints() {
    const item = (k: string, label: string) => h('span', {}, kbd(k), ' ', label);
    this.hints.replaceChildren(
      item('Tab', 'child'), item('Enter', 'sibling'), item('C', 'connect'), item('F2', 'rename'), item('#', 'tag'), item('T', 'type'),
      item('⌫', 'delete'), item('F', 'focus'), item('G', 'groups'), item('L', 'layout'), item('D', 'details'),
      item('⇧Enter', 'center'), item('Ctrl K', 'search'), item('Esc', 'deselect'),
      h('span', {}, 'drag onto a node to connect · right-click for more'),
    );
  }

  private renderBarToggles() {
    const btn = (bar: keyof BarSettings, label: string, title: string) =>
      h('button', {
        class: this.bars[bar] ? 'bar-toggle on' : 'bar-toggle',
        title,
        'aria-label': title,
        'aria-pressed': String(this.bars[bar]),
        onclick: () => this.showBar(bar, !this.bars[bar]),
      }, label);
    this.barToggles.replaceChildren(
      btn('hints', '?', 'Keyboard shortcuts'),
      btn('legend', 'i', 'Legend and stats'),
    );
  }

  private showBar(bar: keyof BarSettings, show: boolean) {
    this.bars = { ...this.bars, [bar]: show };
    this.renderOverlays();
    post({ type: 'setBar', bar, show });
  }

  /** Empty state, legend and hint bar. */
  private renderOverlays() {
    const empty = this.map.nodes.length === 0;
    this.empty.classList.toggle('hidden', !empty);
    this.renderBarToggles();
    this.barToggles.classList.toggle('hidden', empty);
    this.legend.classList.toggle('hidden', empty || !this.bars.legend);
    this.hints.classList.toggle('hidden', empty || !this.bars.hints);
    if (empty) return;
    const types = uniqueTypes(this.map);
    const usedNodeTypes = types.nodeTypes.filter((t) => this.map.nodes.some((n) => n.type === t));
    const usedEdgeTypes = types.edgeTypes.filter((t) => this.map.edges.some((e) => e.type === t));
    const lineSample = (t: string) => {
      const st = resolveEdgeStyle(this.map, { id: '', source: '', target: '', type: t });
      const dash = st.lineStyle === 'dashed' ? '5 3' : st.lineStyle === 'dotted' ? '2 4' : '';
      const wrap = document.createElement('span');
      wrap.innerHTML = `<svg width="22" height="6" aria-hidden="true"><path d="M1 3h20" stroke="${st.color}" stroke-width="2" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/></svg>`;
      return wrap.firstElementChild as SVGElement;
    };
    const slice = this.map.settings.activeSlice;
    const visible = this.graph.cy.nodes().not('.hidden').not('.dimmed').length;
    this.legend.replaceChildren(h('div', { class: 'legend-inner' },
      usedNodeTypes.length > 0 && h('div', { class: 'legend-row' },
        usedNodeTypes.map((t) => h('span', { class: 'legend-item' }, h('span', { class: 'dot', style: { background: this.nodeTypeColor(t) } }), t)),
      ),
      usedEdgeTypes.length > 0 && h('div', { class: 'legend-row muted' },
        usedEdgeTypes.map((t) => h('span', { class: 'legend-item' }, lineSample(t), t)),
      ),
      h('div', { class: 'legend-row muted small' },
        `${this.map.nodes.length} nodes · ${this.map.edges.length} connections · ${this.format.toUpperCase()}` +
          (slice ? ` · slice “${slice}”: ${visible} shown` : ''),
      ),
    ));
  }

  // Layout, Style and Slices live in menus under the toolbar.

  private openSettings(kind: Tab) {
    const current = this.settings;
    if (current && Popover.current === current.pop) {
      current.pop.close();
      if (current.kind === kind) return;
    }
    const btn = this.toolbar.querySelector(`[data-menu="${kind}"]`);
    const pop = new Popover(btn ? below(btn) : { x: 200, y: 60 }, [this.settingsBody(kind)], {
      className: 'pop-settings',
      owner: `[data-menu="${kind}"]`,
      onClose: () => {
        if (this.settings?.pop === pop) this.settings = undefined;
        this.toolbar.querySelector(`[data-menu="${kind}"]`)?.classList.remove('open');
      },
    });
    this.settings = { kind, pop };
    this.toolbar.querySelector(`[data-menu="${kind}"]`)?.classList.add('open');
  }

  private settingsBody(kind: Tab): HTMLElement {
    return kind === 'style' ? this.stylePanel() : kind === 'slices' ? this.slicePanel() : this.layoutPanel();
  }

  /** Rebuilds the open settings menu, unless the user is typing in it. */
  private renderSettings() {
    const s = this.settings;
    if (!s || Popover.current !== s.pop) return;
    const active = document.activeElement as HTMLInputElement | null;
    if (active && s.pop.el.contains(active) && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes(active.type)))) return;
    s.pop.set([this.settingsBody(s.kind)]);
  }

  private renderToolbar() {
    const types = uniqueTypes(this.map);
    const l = this.layout;
    const lanes = l.name === 'typeColumns' || l.name === 'typeRows';
    const hierarchyValue = l.hierarchyEdgeTypes.length === 0 ? '' : l.hierarchyEdgeTypes.length === 1 ? l.hierarchyEdgeTypes[0] : '__multi';
    const searchInput = h('input', {
      type: 'search',
      placeholder: 'Search…',
      'aria-label': 'Search nodes',
      onkeydown: (e: KeyboardEvent) => {
        if (e.key !== 'Enter') return;
        const hits = this.graph.highlightSearch((e.target as HTMLInputElement).value);
        if (hits.length) {
          this.graph.select(hits.slice(0, 1));
          this.graph.centerOn(hits);
        }
      },
      oninput: (e: Event) => this.graph.highlightSearch((e.target as HTMLInputElement).value),
    });
    const seg = (name: LayoutName, label: string) =>
      h('button', { class: l.name === name ? 'seg active' : 'seg', onclick: () => l.name !== name && this.setLayout({ name }) }, label);
    const others = LAYOUTS.filter((x) => x.value !== 'force' && x.value !== 'hierarchy');
    const isOther = others.some((x) => x.value === l.name);
    // The label hides when the bar gets narrow; the icon stays.
    const toggle = (on: boolean, icon: string, label: string, title: string, onclick: () => void) =>
      h('button', { class: on ? 'toggle on' : 'toggle', title, 'aria-label': label, 'aria-pressed': String(on), onclick },
        svgIcon(icon, 14), h('span', { class: 'tb-label' }, label));
    const iconBtn = (icon: string, title: string, onclick: () => void) =>
      h('button', { class: 'icon-btn', title, 'aria-label': title, onclick }, svgIcon(icon));
    const menuBtn = (kind: Tab, label: string) =>
      h('button', {
        class: this.settings?.kind === kind && Popover.current === this.settings.pop ? 'menu-btn open' : 'menu-btn',
        'data-menu': kind,
        onclick: () => this.openSettings(kind),
      }, label, svgIcon(ICON.chevron, 11));
    const slice = this.map.settings.activeSlice;

    // Brand on the left; how the graph is arranged and what it shows in the middle; search and
    // view toggles on the right, with Details always last. Narrow, the middle moves to a second row.
    this.toolbar.replaceChildren(
      h('div', { class: 'brand' },
        h('span', { class: 'logo' }, svgIcon(ICON.logo, 20)),
        h('b', {}, 'BrainMap'),
        this.fileName && h('span', { class: 'muted file-name', title: this.fileName }, `/ ${this.fileName}`),
      ),
      h('div', { class: 'tb-main' },
        h('div', { class: 'group', role: 'group', 'aria-label': 'Arrange' },
          h('div', { class: 'segmented-bar' },
            seg('force', 'Physics'),
            seg('hierarchy', 'Hierarchy'),
            select(
              [{ value: '', label: isOther ? '' : 'More…' }, ...others],
              isOther ? l.name : '',
              (v) => v && this.setLayout({ name: v as LayoutName }),
              { class: isOther ? 'seg-select active' : 'seg-select', title: 'Other layouts' },
            ),
          ),
          (l.name === 'hierarchy' || l.name === 'breadthfirst') &&
            select(
              [
                { value: '', label: 'by all types' },
                ...types.edgeTypes.map((t) => ({ value: t, label: `by ${t}` })),
                ...(hierarchyValue === '__multi' ? [{ value: '__multi', label: `by ${l.hierarchyEdgeTypes.join(', ')}` }] : []),
              ],
              hierarchyValue,
              (v) => v !== '__multi' && this.setLayout({ hierarchyEdgeTypes: v ? [v] : [] }),
              { class: 'chip-select', title: 'Dependency type that defines the hierarchy' },
            ),
          lanes &&
            select(
              laneAttributes(this.map.nodes).map((a) => ({ value: a.value, label: `by ${a.label}` })),
              l.laneBy,
              (v) => this.setLayout({ laneBy: v }),
              { class: 'chip-select', title: 'Attribute that puts nodes into columns or rows' },
            ),
          menuBtn('layout', 'Layout'),
        ),
        h('div', { class: 'group', role: 'group', 'aria-label': 'Show' },
          menuBtn('style', 'Style'),
          menuBtn('slices', slice ? `Slice: ${slice}${this.sliceCount()}` : 'Slices'),
        ),
      ),
      h('div', { class: 'tb-end' },
        h('label', { class: 'search' }, svgIcon(ICON.search, 14), searchInput, kbd('Ctrl K')),
        h('div', { class: 'group', role: 'group', 'aria-label': 'View' },
          toggle(this.cards.groups, ICON.groups, 'Groups', 'Show groups (G)', () => this.toggleGroups()),
          toggle(this.graph.focus, ICON.focus, 'Focus', 'Dim everything not next to the selection (F)', () => this.toggleFocus()),
          iconBtn(ICON.fit, 'Fit view (Shift+F)', () => this.graph.fit()),
        ),
        h('span', { class: 'tb-sep', 'aria-hidden': 'true' }),
        toggle(this.detailsOpen, ICON.details, 'Details', 'Details sidebar (D)', () => this.toggleDetails()),
      ),
      datalist('dl-node-types', types.nodeTypes),
      datalist('dl-edge-types', types.edgeTypes),
      datalist('dl-tags', types.tags),
    );
  }

  private stylePanel(): HTMLElement {
    const style = (this.map.settings.style ??= { colorBy: 'type' });
    const types = uniqueTypes(this.map);
    // Live preview for color pickers without re-rendering the panel.
    const color = (current: string, apply: (v: string) => void) =>
      h('input', { type: 'color', value: current,
        oninput: (e: Event) => { apply((e.target as HTMLInputElement).value); this.graph.sync(this.map); },
        onchange: () => this.commit({ panel: false }) });

    const nodeRows = types.nodeTypes.map((t) => {
      const s = ((style.nodeTypes ??= {})[t] ??= {});
      return h('div', { class: 'style-row' },
        color(s.color ?? autoColor(t), (v) => (s.color = v)),
        h('span', { class: 'name' }, t),
      );
    });
    const tagRows = types.tags.map((t) => {
      const s = ((style.tags ??= {})[t] ??= {});
      return h('div', { class: 'style-row' }, color(s.color ?? autoColor(t), (v) => (s.color = v)), h('span', { class: 'name' }, t));
    });
    const edgeRows = types.edgeTypes.map((t) => {
      const s = ((style.edgeTypes ??= {})[t] ??= {});
      return h('div', { class: 'style-row' },
        color(s.color ?? autoColor(t), (v) => (s.color = v)),
        h('span', { class: 'name' }, t),
        select(['solid', 'dashed', 'dotted'].map((v) => ({ value: v })), s.lineStyle ?? 'solid', (v) => { s.lineStyle = v as any; this.commit({ panel: false }); }),
        h('input', { type: 'number', min: 10, max: 1000, step: 10, value: s.length ?? '', placeholder: String(this.layout.edgeLength), class: 'num',
          title: 'Proximity: preferred edge length for force layouts (smaller = closer)',
          onchange: (e: Event) => { s.length = Number((e.target as HTMLInputElement).value) || undefined; this.commit({ relayout: this.isForce(), panel: false }); } }),
      );
    });

    return h('div', {},
      field('Color nodes by', select(
        [{ value: 'type', label: 'Node type' }, { value: 'tag', label: 'Node tag (first styled tag)' }, { value: 'none', label: 'Nothing' }],
        style.colorBy ?? 'type',
        (v) => { style.colorBy = v as any; this.commit({ panel: false }); },
      )),
      field('Connections show', select(
        [{ value: 'label', label: 'Label' }, { value: 'type', label: 'Type' }, { value: 'none', label: 'Nothing' }],
        style.edgeLabel ?? 'label',
        (v) => { style.edgeLabel = v as any; this.commit({ panel: false }); },
      )),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: style.simplifyZoomedOut ?? true,
          onchange: (e: Event) => { style.simplifyZoomedOut = (e.target as HTMLInputElement).checked; this.commit({ panel: false }); } }),
        'Hide text on nodes when zoomed far out'),
      h('h4', {}, 'Node types'), nodeRows.length ? nodeRows : h('p', { class: 'muted' }, 'No node types yet. Set a type in the inspector.'),
      h('h4', {}, 'Tags'), tagRows.length ? tagRows : h('p', { class: 'muted' }, 'No tags yet.'),
      h('h4', {}, 'Dependency (edge) types'),
      edgeRows.length ? [h('p', { class: 'muted small' }, 'color · line · length (proximity in force layouts)'), ...edgeRows] : h('p', { class: 'muted' }, 'No edge types yet.'),
    );
  }

  private isForce() {
    return this.layout.name === 'force' || this.layout.name === 'fcose';
  }

  private layoutPanel(): HTMLElement {
    const l = this.layout;
    const types = uniqueTypes(this.map);
    const slider = (label: string, value: number, min: number, max: number, apply: (v: number) => void) => {
      const out = h('span', { class: 'value' }, String(value));
      return field(label, h('div', { class: 'row' },
        h('input', { type: 'range', min, max, value,
          oninput: (e: Event) => (out.textContent = (e.target as HTMLInputElement).value),
          onchange: (e: Event) => apply(Number((e.target as HTMLInputElement).value)) }),
        out));
    };
    const hierarchical = l.name === 'hierarchy' || l.name === 'breadthfirst';
    const lanes = l.name === 'typeColumns' || l.name === 'typeRows';
    return h('div', {},
      field('Layout', select(LAYOUTS, l.name, (v) => this.setLayout({ name: v as LayoutName }))),
      slider('Node spacing (proximity)', l.nodeSpacing, 0, 200, (v) => this.setLayout({ nodeSpacing: v })),
      slider(l.name === 'hierarchy' ? 'Level distance' : l.name === 'typeColumns' || l.name === 'typeRows' ? 'Lane distance' : 'Edge length', l.edgeLength, 20, 500, (v) => this.setLayout({ edgeLength: v })),
      l.name === 'force' && h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: l.live, onchange: (e: Event) => this.setLayout({ live: (e.target as HTMLInputElement).checked }) }),
        'Live physics with cola (neighbours follow while dragging)'),
      l.name !== 'force' && h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: l.animate, onchange: (e: Event) => this.setLayout({ animate: (e.target as HTMLInputElement).checked }) }),
        'Animate transitions'),
      lanes && this.lanePanel(),
      hierarchical && [
        l.name === 'hierarchy' && field('Direction', select(
          [{ value: 'TB', label: 'Top → bottom' }, { value: 'BT', label: 'Bottom → top' }, { value: 'LR', label: 'Left → right' }, { value: 'RL', label: 'Right → left' }],
          l.direction, (v) => this.setLayout({ direction: v as any }))),
        h('h4', {}, 'Hierarchy from dependency types'),
        h('p', { class: 'muted small' }, 'Only edges of the checked types build the hierarchy. None checked = all types.'),
        checklist(types.edgeTypes, l.hierarchyEdgeTypes, (v) => this.setLayout({ hierarchyEdgeTypes: v })),
        l.name === 'hierarchy' && h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: l.hideOtherEdges, onchange: (e: Event) => this.setLayout({ hideOtherEdges: (e.target as HTMLInputElement).checked }) }),
          'Hide edges of other types'),
      ],
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: l.followSelection, onchange: (e: Event) => this.setLayout({ followSelection: (e.target as HTMLInputElement).checked }, false) }),
        'Center view on the selected node'),
      h('div', { class: 'row' },
        h('button', { onclick: () => this.graph.runLayout(this.map) }, svgIcon(ICON.relayout, 14), 'Run layout ', kbd('L')),
        h('button', { onclick: () => this.graph.fit() }, svgIcon(ICON.fit, 14), 'Fit view ', kbd('⇧F')),
      ),
    );
  }

  /** Lane layouts: which attribute makes the lanes, and the order of the lanes. */
  private lanePanel() {
    const l = this.layout;
    const names = laneNames(this.map.nodes, l.laneBy, l.laneOrders[l.laneBy]);
    const move = (i: number, by: number) => {
      const order = names.filter(Boolean);
      const [name] = order.splice(i, 1);
      order.splice(i + by, 0, name);
      this.setLayout({ laneOrders: { ...l.laneOrders, [l.laneBy]: order } });
    };
    const last = names.filter(Boolean).length - 1;
    return [
      field(l.name === 'typeColumns' ? 'Columns by' : 'Rows by',
        select(laneAttributes(this.map.nodes), l.laneBy, (v) => this.setLayout({ laneBy: v }))),
      h('h4', {}, l.name === 'typeColumns' ? 'Column order (left → right)' : 'Row order (top → bottom)'),
      h('div', { class: 'lane-order' },
        names.map((name, i) =>
          h('div', { class: 'lane-row' },
            h('span', { class: name ? 'name' : 'name muted' }, name || '(none)'),
            name && h('button', { class: 'icon-btn', title: 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
            name && h('button', { class: 'icon-btn', title: 'Move down', disabled: i === last, onclick: () => move(i, 1) }, '↓'),
          ),
        ),
      ),
      !!l.laneOrders[l.laneBy]?.length && h('button', { onclick: () => {
        const { [l.laneBy]: _drop, ...rest } = l.laneOrders;
        this.setLayout({ laneOrders: rest });
      } }, 'Sort by name'),
    ];
  }

  private sliceFrom(roots: string[], name?: string, direction: Slice['direction'] = 'downstream', depth?: number) {
    this.editingSlice = { name: name ?? `${nameOf(this.node(roots[0]))} neighbourhood`, roots, direction, depth };
    this.openSettings('slices');
  }

  private slicePanel(): HTMLElement {
    const slices = (this.map.settings.slices ??= []);
    const active = this.map.settings.activeSlice;
    const list = h('div', { class: 'slices' },
      h('div', { class: active ? 'slice' : 'slice active' },
        h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.showSlice(undefined); } }, 'Full graph')),
      slices.map((s) =>
        h('div', { class: s.name === active ? 'slice active' : 'slice' },
          h('div', { class: 'slice-head' },
            h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.showSlice(s.name); } }, s.name),
            h('button', { class: 'slice-icon', title: 'Edit slice', 'aria-label': `Edit slice ${s.name}`, onclick: () => {
              this.editingSlice = clone(s);
              (this.editingSlice as any).__orig = s.name;
              this.renderSettings();
            } }, svgIcon(ICON.pencil, 14)),
            h('button', { class: 'slice-icon danger', title: 'Delete slice', 'aria-label': `Delete slice ${s.name}`, onclick: () => {
              this.map.settings.slices = slices.filter((x) => x !== s);
              if (active === s.name) this.map.settings.activeSlice = undefined;
              this.commit({ relayout: active === s.name });
            } }, svgIcon(ICON.trash, 14)),
          ),
          h('span', { class: 'muted small' }, describeSlice(s)),
        ),
      ),
    );
    return h('div', {},
      field('Nodes outside the slice', select(
        [{ value: 'hide', label: 'Hide' }, { value: 'dim', label: 'Dim' }],
        this.map.settings.sliceMode ?? 'hide',
        (v) => { this.map.settings.sliceMode = v as any; this.commit({ relayout: true }); })),
      list,
      this.editingSlice
        ? this.sliceEditor(this.editingSlice)
        : h('button', { onclick: () => { this.editingSlice = { name: newId('Slice ', slices.map((s) => s.name)) }; this.renderSettings(); } }, '+ New slice'),
    );
  }

  private sliceEditor(s: Slice & { __orig?: string }): HTMLElement {
    const types = uniqueTypes(this.map);
    const save = () => {
      const slices = (this.map.settings.slices ??= []);
      const { __orig, ...rest } = s;
      const slice = tidySlice(rest);
      if (!slice.name.trim()) return;
      const idx = slices.findIndex((x) => x.name === (__orig ?? slice.name));
      if (idx >= 0) slices[idx] = slice;
      else slices.push(slice);
      if (__orig && this.map.settings.activeSlice === __orig) this.map.settings.activeSlice = slice.name;
      this.editingSlice = undefined;
      this.showSlice(slice.name);
    };
    const names = this.map.nodes.map((n) => nameOf(n));
    const nodeSuggestions = (p: string) =>
      p === 'type' ? types.nodeTypes : p === 'tags' ? types.tags : p === 'name' ? names : p === 'id' ? this.map.nodes.map((n) => n.id) : [];
    const edgeSuggestions = (p: string) =>
      p === 'type' ? types.edgeTypes : p === 'tags' ? types.tags : p === 'label' ? [...new Set(this.map.edges.map((e) => e.label ?? '').filter(Boolean))] : [];
    const count = h('p', { class: 'muted small filter-count' });
    const updateCount = () => {
      const res = computeSlice(this.map, s);
      count.textContent = `Matches ${res.nodes.size} of ${this.map.nodes.length} nodes · ${res.edges.size} of ${this.map.edges.length} connections`;
    };
    updateCount();
    return h('div', { class: 'slice-editor' },
      h('h4', {}, s.__orig ? `Edit slice` : 'New slice'),
      field('Name', h('input', { value: s.name, oninput: (e: Event) => (s.name = (e.target as HTMLInputElement).value) })),
      h('h4', {}, 'Nodes'),
      filterEditor('node', s.nodeFilter, nodeSuggestions, (f) => { s.nodeFilter = f; updateCount(); }),
      h('h4', {}, 'Connections'),
      filterEditor('edge', s.edgeFilter, edgeSuggestions, (f) => { s.edgeFilter = f; updateCount(); }),
      h('h4', {}, 'Neighbourhood'),
      field('Start nodes (ids, comma separated)',
        h('div', { class: 'row' },
          h('input', { value: (s.roots ?? []).join(', '), onchange: (e: Event) => { s.roots = splitList((e.target as HTMLInputElement).value); updateCount(); } }),
          h('button', { title: 'Use selected nodes', onclick: () => {
            s.roots = this.selection.filter((id) => this.node(id));
            this.renderSettings();
          } }, 'use selection'),
        )),
      field('Follow edges', select(
        [{ value: 'downstream', label: 'Downstream (outgoing)' }, { value: 'upstream', label: 'Upstream (incoming)' }, { value: 'both', label: 'Both directions' }],
        s.direction ?? 'downstream', (v) => { s.direction = v as any; updateCount(); })),
      field('Max depth (empty = unlimited)', h('input', { type: 'number', min: 0, value: s.depth ?? '',
        onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; s.depth = v === '' ? undefined : Number(v); updateCount(); } })),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: !!s.expand, onchange: (e: Event) => { s.expand = (e.target as HTMLInputElement).checked || undefined; updateCount(); } }),
        'Also show nodes connected to the matching nodes'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: !!s.highlight, onchange: (e: Event) => { s.highlight = (e.target as HTMLInputElement).checked || undefined; } }),
        'Highlight the matching nodes'),
      h('p', { class: 'muted small' }, 'A filter without its value does not filter yet. With start nodes, only nodes reachable over the kept connections are shown. "Also show connected nodes" starts at the matching nodes and follows the kept connections, in the direction and up to the depth above.'),
      count,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: save }, 'Save & show'),
        h('button', { onclick: () => { this.editingSlice = undefined; this.renderSettings(); } }, 'Cancel'),
      ),
    );
  }
}

function describeSlice(s: Slice): string {
  const parts: string[] = [];
  const nodes = describeFilter(s.nodeFilter, 'node');
  const edges = describeFilter(s.edgeFilter, 'edge');
  if (nodes) parts.push(nodes);
  if (edges) parts.push(`connections: ${edges}`);
  if (s.roots?.length) parts.push(`from ${s.roots.join(', ')} ${s.direction ?? 'downstream'}${s.depth !== undefined ? ` ≤${s.depth}` : ''}`);
  if (s.expand) parts.push(`+ connected ${s.direction ?? 'downstream'}${s.depth !== undefined ? ` ≤${s.depth}` : ''}`);
  return parts.join(' · ') || 'everything';
}

new App(document.getElementById('app')!);
