import {
  BrainEdge,
  BrainMap,
  BrainNode,
  DEFAULT_LAYOUT,
  FileFormat,
  LayoutName,
  LayoutSettings,
  NodeShape,
  Position,
  Slice,
  autoColor,
  emptyMap,
  newId,
  resolveNodeStyle,
  uniqueTypes,
} from '../shared/model';
import { HostMessage, WebviewMessage } from '../shared/messages';
import { GraphView } from './graph';
import { checklist, datalist, field, h, select, splitList } from './dom';
import { ContextMenu, FloatingWindow, MenuItem, confirmDialog, pickNode, tagEditor } from './overlays';

const vscode = acquireVsCodeApi();
const post = (msg: WebviewMessage) => vscode.postMessage(msg);

type Tab = 'style' | 'layout' | 'slices';

interface UiState {
  tab?: Tab;
  panelOpen?: boolean;
  popup?: Position;
  edgeType?: string;
}

const LAYOUTS: { value: LayoutName; label: string }[] = [
  { value: 'force', label: 'Force – cola (live physics)' },
  { value: 'fcose', label: 'Force (fCoSE)' },
  { value: 'hierarchy', label: 'Hierarchy (by dependency type)' },
  { value: 'breadthfirst', label: 'Tree (breadth-first)' },
  { value: 'concentric', label: 'Concentric' },
  { value: 'circle', label: 'Circle' },
  { value: 'grid', label: 'Grid' },
];

const SHAPES: NodeShape[] = ['round-rectangle', 'ellipse', 'rectangle', 'diamond', 'hexagon', 'triangle', 'star'];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const nameOf = (n: BrainNode | undefined) => n?.label || n?.id || '?';

class App {
  map: BrainMap = emptyMap();
  format: FileFormat = 'yaml';
  selection: string[] = [];
  ui: UiState = vscode.getState<UiState>() ?? {};
  tab: Tab = this.ui.tab ?? 'layout';
  panelOpen = this.ui.panelOpen ?? false;
  loaded = false;
  /** Dependency type used for new edges: the last one the user picked. */
  edgeType = this.ui.edgeType ?? '';
  editingSlice?: Slice;

  private graph: GraphView;
  private toolbar = h('div', { class: 'toolbar' });
  private panel = h('div', { class: 'panel' });
  private stage = h('div', { class: 'stage' });
  private status = h('div', { class: 'status' });
  private error = h('div', { class: 'error hidden' });
  private plus = h('button', { class: 'empty-plus hidden', title: 'Create the first node', onclick: () => this.createFirstNode() }, '+');
  private menu: ContextMenu;
  private popup: FloatingWindow;
  private postTimer?: number;
  private placeFrame = 0;

  constructor(root: HTMLElement) {
    const canvas = h('div', { class: 'canvas' });
    this.stage.append(canvas, this.plus, this.status, this.error);
    root.append(this.toolbar, h('div', { class: 'main' }, this.stage, this.panel));
    this.menu = new ContextMenu(document.body);
    this.popup = new FloatingWindow(
      this.stage,
      this.ui.popup,
      (pos) => this.saveUi({ popup: pos }),
      () => this.graph.select([]),
    );
    this.graph = new GraphView(canvas, {
      onSelect: (ids) => {
        this.selection = ids;
        this.renderPopup();
        this.renderToolbar();
      },
      onBackgroundDoubleClick: (pos) => this.addNode(pos),
      onContextMenu: (target, client, pos) => this.openMenu(target, client, pos),
      onViewport: () => {
        cancelAnimationFrame(this.placeFrame);
        this.placeFrame = requestAnimationFrame(() => this.placePopup());
      },
    });

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
    if (msg.type === 'error') {
      this.error.textContent = msg.message + ' — fix the file in the text editor.';
      this.error.classList.remove('hidden');
      return;
    }
    this.error.classList.add('hidden');
    const prev = this.map;
    this.map = msg.map;
    this.format = msg.format;
    this.graph.follow = this.layout.followSelection;
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
    } else if (layoutChanged || structureChanged) {
      this.graph.runLayout(this.map, { fit: false });
    }
    this.selection = this.selection.filter((id) => this.graph.cy.getElementById(id).nonempty());
    this.renderPanel();
    this.renderStatus();
    // Don't rebuild the popup under the user's cursor while they are typing in it.
    if (!this.popup.el.contains(document.activeElement)) this.renderPopup();
  }

  /** Sends the model to the extension host (debounced) which writes it to the file. */
  private save() {
    window.clearTimeout(this.postTimer);
    this.postTimer = window.setTimeout(() => post({ type: 'edit', map: clone(this.map) }), 250);
  }

  /** Applies a model change: re-syncs the graph, re-renders UI and persists. */
  private commit(opts: { relayout?: boolean; fit?: boolean; panel?: boolean; popup?: boolean } = {}) {
    this.graph.follow = this.layout.followSelection;
    this.graph.sync(this.map);
    // New or removed nodes/connections re-run the layout so the graph stays arranged.
    if (this.structureChanged() || opts.relayout) this.graph.runLayout(this.map, { fit: opts.fit ?? false });
    this.renderToolbar();
    if (opts.panel !== false) this.renderPanel();
    if (opts.popup) this.renderPopup();
    else this.placePopup();
    this.renderStatus();
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

  private nextLabel() {
    const used = new Set(this.map.nodes.map((n) => n.label));
    let i = this.map.nodes.length + 1;
    while (used.has(`Node ${i}`)) i++;
    return `Node ${i}`;
  }

  /** Creates a node, selects it and puts the cursor into its name field. */
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
    this.focusName();
  }

  private createFirstNode() {
    this.graph.cy.zoom(1);
    this.graph.centerPoint({ x: 0, y: 0 });
    this.addNode({ x: 0, y: 0 });
  }

  /** Adds a node next to `parentId`, in the direction with the most free space. */
  addConnectedNode(parentId: string) {
    const p = this.graph.cy.getElementById(parentId).position();
    const dist = this.layout.edgeLength + 40;
    const others = this.graph.cy.nodes().not('.hidden').map((n) => (n as any).position() as Position);
    let best = { x: p.x + dist, y: p.y };
    let bestScore = -1;
    for (let i = 0; i < 16; i++) {
      // Start pointing down-right and walk around the circle.
      const a = Math.PI / 4 + (i * Math.PI * 2) / 16;
      const c = { x: p.x + Math.cos(a) * dist, y: p.y + Math.sin(a) * dist };
      const score = Math.min(...others.map((o) => Math.hypot(o.x - c.x, o.y - c.y)));
      if (score > bestScore + 1) {
        bestScore = score;
        best = c;
      }
    }
    this.addNode(best, parentId);
  }

  private focusName() {
    window.setTimeout(() => {
      const input = this.popup.body.querySelector('input[name=label]') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    }, 30);
  }

  private makeEdge(source: string, target: string, directed = true): BrainEdge {
    return {
      id: newId('e', this.map.edges.map((e) => e.id)),
      source,
      target,
      type: this.edgeType || undefined,
      directed: directed ? undefined : false,
    };
  }

  /** Lets the user type the name of another node (with suggestions) and connects to it. */
  private async connectWithPicker(id: string, at: Position) {
    const options = this.map.nodes
      .filter((n) => n.id !== id)
      .map((n) => ({ id: n.id, label: nameOf(n), detail: [n.type, n.label && n.label !== n.id ? n.id : ''].filter(Boolean).join(' · ') }));
    const picked = await pickNode(at, nameOf(this.node(id)), options);
    if (!picked) return;
    if (picked.direction === 'in') this.connect(picked.id, id, true);
    else this.connect(id, picked.id, picked.direction === 'out');
  }

  private connect(source: string, target: string, directed: boolean) {
    const e = this.makeEdge(source, target, directed);
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
    let message: string;
    if (nodes.length === 1 && edges.length === attached)
      message = `Delete node "${nameOf(nodes[0])}"?` + (attached ? ` Its ${attached} connection${attached > 1 ? 's' : ''} will be deleted too.` : '');
    else if (!nodes.length && edges.length === 1)
      message = `Delete the connection "${nameOf(this.node(edges[0].source))} ${edges[0].directed === false ? '↔' : '→'} ${nameOf(this.node(edges[0].target))}"?`;
    else message = `Delete ${nodes.length} node(s) and ${edges.length} connection(s)?`;
    if (!(await confirmDialog(document.body, message))) return;

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
      this.renderPopup();
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

  private showSlice(name: string | undefined) {
    this.map.settings.activeSlice = name || undefined;
    this.commit({ relayout: true, fit: true });
  }

  // ---------------------------------------------------------------- context menu & keys

  private openMenu(target: { kind: 'node' | 'edge' | 'background'; id?: string }, at: Position, pos: Position) {
    const items: MenuItem[] = [];
    if (target.kind === 'node' && target.id) {
      const id = target.id;
      items.push(
        { label: '＋ Add connected node', hint: 'N', action: () => this.addConnectedNode(id) },
        { label: 'Connect with node…', hint: 'C', action: () => this.connectWithPicker(id, at) },
      );
      const selectedNodes = this.selection.filter((s) => this.node(s));
      if (selectedNodes.length === 2 && selectedNodes.includes(id)) {
        const other = selectedNodes.find((s) => s !== id)!;
        const [a, b] = [nameOf(this.node(other)), nameOf(this.node(id))];
        items.push(
          'separator',
          { label: `Connect ${a} → ${b}`, action: () => this.connect(other, id, true) },
          { label: `Connect ${b} → ${a}`, action: () => this.connect(id, other, true) },
          { label: `Connect ${a} ↔ ${b}`, action: () => this.connect(other, id, false) },
        );
      }
      items.push(
        'separator',
        { label: 'Edit', action: () => this.graph.select([id]) },
        { label: 'Slice from here', action: () => this.sliceFrom([id]) },
        'separator',
        { label: 'Delete node…', hint: '⌫', danger: true, action: () => this.requestDelete([id]) },
      );
    } else if (target.kind === 'edge' && target.id) {
      const e = this.edge(target.id);
      if (!e) return;
      const bidirectional = e.directed === false;
      items.push(
        { label: 'Edit', action: () => this.graph.select([e.id]) },
        bidirectional
          ? { label: 'Make one-way →', action: () => { e.directed = undefined; this.commit({ popup: true }); } }
          : { label: 'Make two-way ↔', action: () => { e.directed = false; this.commit({ popup: true }); } },
        ...(!bidirectional ? [{ label: 'Reverse direction ⇄', action: () => this.reverse(e) }] : []),
        'separator',
        { label: 'Delete connection…', hint: '⌫', danger: true, action: () => this.requestDelete([e.id]) },
      );
    } else {
      items.push(
        { label: '＋ Add node here', action: () => this.addNode(pos) },
        'separator',
        { label: 'Fit view', hint: 'F', action: () => this.graph.fit() },
        { label: 'Run layout', hint: 'L', action: () => this.graph.runLayout(this.map) },
      );
    }
    this.menu.show(items, at);
  }

  private reverse(e: BrainEdge) {
    [e.source, e.target] = [e.target, e.source];
    this.commit({ popup: true });
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || this.menu.open || document.querySelector('.modal')) return;
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        this.requestDelete(this.selection);
        break;
      case 'n': {
        const nodes = this.selection.filter((id) => this.node(id));
        if (nodes.length === 1) this.addConnectedNode(nodes[0]);
        else if (!this.map.nodes.length) this.createFirstNode();
        else {
          const ext = this.graph.cy.extent();
          this.addNode({ x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 });
        }
        break;
      }
      case 'c': {
        const nodes = this.selection.filter((id) => this.node(id));
        if (nodes.length !== 1) return;
        const box = this.graph.renderedBox(nodes[0]);
        const r = this.stage.getBoundingClientRect();
        this.connectWithPicker(nodes[0], box ? { x: r.x + box.x2 + 12, y: r.y + box.y1 } : { x: r.x + 40, y: r.y + 40 });
        break;
      }
      case 'f':
        this.graph.fit();
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

  // ---------------------------------------------------------------- floating editor

  private placePopup() {
    if (!this.popup.visible) return;
    if (this.selection.length === 1) {
      const box = this.graph.renderedBox(this.selection[0]);
      if (!box) return this.popup.hide();
      this.popup.place(box);
    } else {
      const boxes = this.selection.map((id) => this.graph.renderedBox(id)).filter((b) => !!b);
      if (!boxes.length) return this.popup.hide();
      this.popup.place({
        x1: Math.min(...boxes.map((b) => b!.x1)),
        x2: Math.max(...boxes.map((b) => b!.x2)),
        y1: Math.min(...boxes.map((b) => b!.y1)),
        y2: Math.max(...boxes.map((b) => b!.y2)),
      });
    }
  }

  private renderPopup() {
    const sel = this.selection;
    const node = sel.length === 1 ? this.node(sel[0]) : undefined;
    const edge = sel.length === 1 ? this.edge(sel[0]) : undefined;
    const twoNodes = sel.length === 2 && sel.every((id) => this.node(id));
    if (node) this.popup.show('Node', this.nodeEditor(node));
    else if (edge) this.popup.show('Connection', this.edgeEditor(edge));
    else if (twoNodes)
      this.popup.show('2 nodes selected', [
        h('p', { class: 'muted small' }, 'Right-click one of them to connect the two.'),
        h('div', { class: 'row' },
          h('button', { onclick: () => this.connect(sel[0], sel[1], true) }, `${nameOf(this.node(sel[0]))} → ${nameOf(this.node(sel[1]))}`),
          h('button', { onclick: () => this.connect(sel[0], sel[1], false) }, '↔'),
        ),
      ]);
    else if (sel.length > 1)
      this.popup.show(`${sel.length} selected`, [
        h('div', { class: 'row' }, h('button', { class: 'danger', onclick: () => this.requestDelete(sel) }, 'Delete all…')),
      ]);
    else this.popup.hide();
    // Wait a frame so the centering animation has started before measuring.
    requestAnimationFrame(() => this.placePopup());
  }

  /** Text input that writes the model on change (blur or Enter). */
  private input(value: string | undefined, apply: (v: string) => void, attrs: Record<string, any> = {}) {
    return h('input', {
      value: value ?? '',
      ...attrs,
      onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && (e.target as HTMLInputElement).blur(),
      onchange: (e: Event) => {
        apply((e.target as HTMLInputElement).value);
        this.commit({ panel: this.panelOpen });
      },
    });
  }

  private nodeEditor(node: BrainNode): HTMLElement[] {
    const color = resolveNodeStyle(this.map, node).color;
    const more = h('details', { class: 'more' },
      h('summary', {}, 'More'),
      field('Id', h('input', {
        value: node.id,
        onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && (e.target as HTMLInputElement).blur(),
        onchange: (e: Event) => this.renameNodeId(node, (e.target as HTMLInputElement).value),
      })),
      field('Color', h('div', { class: 'row' },
        h('input', { type: 'color', value: color, onchange: (e: Event) => { node.color = (e.target as HTMLInputElement).value; this.commit({ panel: false }); } }),
        node.color
          ? h('button', { onclick: () => { node.color = undefined; this.commit({ panel: false, popup: true }); } }, 'use type/tag color')
          : h('span', { class: 'muted small' }, 'from type/tag'),
      )),
      field('Description', h('textarea', { rows: 3, value: node.description ?? '',
        onchange: (e: Event) => { node.description = (e.target as HTMLTextAreaElement).value || undefined; this.commit({ panel: false }); } })),
    );
    return [
      field('Name', this.input(node.label, (v) => (node.label = v), { name: 'label' })),
      field('Type', this.input(node.type, (v) => (node.type = v.trim() || undefined), { list: 'dl-node-types', placeholder: 'e.g. service' })),
      field('Tags', tagEditor(node.tags ?? [], (tags) => {
        node.tags = tags.length ? tags : undefined;
        this.commit({ panel: this.panelOpen });
      }, 'dl-tags')),
      more,
      h('div', { class: 'row' },
        h('button', { title: 'Add a connected node (N)', onclick: () => this.addConnectedNode(node.id) }, '＋ Connected node'),
        h('button', { title: 'Connect with an existing node (C)', onclick: (e: MouseEvent) => this.connectWithPicker(node.id, { x: e.clientX, y: e.clientY }) }, 'Connect…'),
        h('button', { class: 'danger', title: 'Delete (Backspace)', onclick: () => this.requestDelete([node.id]) }, 'Delete…'),
      ),
    ];
  }

  private edgeEditor(edge: BrainEdge): HTMLElement[] {
    const bidirectional = edge.directed === false;
    const link = (id: string) => h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.graph.select([id]); } }, nameOf(this.node(id)));
    return [
      h('div', { class: 'edge-ends' }, link(edge.source), h('span', { class: 'arrow' }, bidirectional ? '↔' : '→'), link(edge.target)),
      field('Direction', h('div', { class: 'segmented' },
        h('button', { class: bidirectional ? '' : 'active', onclick: () => { edge.directed = undefined; this.commit({ panel: false, popup: true }); } }, '→ one-way'),
        h('button', { class: bidirectional ? 'active' : '', onclick: () => { edge.directed = false; this.commit({ panel: false, popup: true }); } }, '↔ two-way'),
        !bidirectional && h('button', { class: 'rev', title: 'Reverse direction', onclick: () => this.reverse(edge) }, '⇄'),
      )),
      field('Type', this.input(edge.type, (v) => {
        edge.type = v.trim() || undefined;
        if (edge.type) {
          this.edgeType = edge.type;
          this.saveUi({ edgeType: edge.type });
        }
      }, { list: 'dl-edge-types', placeholder: 'e.g. depends-on' })),
      field('Tags', tagEditor(edge.tags ?? [], (tags) => {
        edge.tags = tags.length ? tags : undefined;
        this.commit({ panel: this.panelOpen });
      }, 'dl-tags')),
      field('Label', this.input(edge.label, (v) => (edge.label = v || undefined), { placeholder: 'optional' })),
      h('div', { class: 'row' },
        h('button', { class: 'danger', title: 'Delete (Backspace)', onclick: () => this.requestDelete([edge.id]) }, 'Delete…'),
      ),
    ];
  }

  // ---------------------------------------------------------------- toolbar, status, side panel

  private renderStatus() {
    const empty = this.map.nodes.length === 0;
    this.plus.classList.toggle('hidden', !empty);
    const slice = this.map.settings.activeSlice;
    const visible = this.graph.cy.nodes().not('.hidden').not('.dimmed').length;
    this.status.textContent = empty
      ? ''
      : `${this.map.nodes.length} nodes · ${this.map.edges.length} connections · ${this.format.toUpperCase()}` +
        (slice ? ` · slice "${slice}" (${visible} nodes)` : '') +
        ' · right-click for actions · Ctrl/Shift+click to select more';
  }

  private renderLayoutState() {
    this.saveUi({ panelOpen: this.panelOpen, tab: this.tab });
    this.panel.classList.toggle('hidden', !this.panelOpen);
    this.renderToolbar();
    this.renderPanel();
    requestAnimationFrame(() => {
      this.graph.cy.resize();
      this.placePopup();
    });
  }

  private renderToolbar() {
    const types = uniqueTypes(this.map);
    const l = this.layout;
    const slices = this.map.settings.slices ?? [];
    const hierarchyValue = l.hierarchyEdgeTypes.length === 0 ? '' : l.hierarchyEdgeTypes.length === 1 ? l.hierarchyEdgeTypes[0] : '__multi';
    const search = h('input', {
      type: 'search',
      placeholder: 'Search…',
      class: 'search',
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

    this.toolbar.replaceChildren(
      h('div', { class: 'group' },
        select(LAYOUTS, l.name, (v) => this.setLayout({ name: v as LayoutName }), { title: 'Layout' }),
        (l.name === 'hierarchy' || l.name === 'breadthfirst') &&
          select(
            [
              { value: '', label: 'by: all types' },
              ...types.edgeTypes.map((t) => ({ value: t, label: `by: ${t}` })),
              ...(hierarchyValue === '__multi' ? [{ value: '__multi', label: `by: ${l.hierarchyEdgeTypes.join(', ')}` }] : []),
            ],
            hierarchyValue,
            (v) => v !== '__multi' && this.setLayout({ hierarchyEdgeTypes: v ? [v] : [] }),
            { title: 'Dependency type that defines the hierarchy' },
          ),
        h('button', { class: 'icon', title: 'Run layout again (L)', onclick: () => this.graph.runLayout(this.map) }, '↻'),
        h('button', { class: 'icon', title: 'Fit everything into view (F)', onclick: () => this.graph.fit() }, '⛶'),
      ),
      h('div', { class: 'group' },
        select(
          [{ value: '', label: 'Full graph' }, ...slices.map((s) => ({ value: s.name, label: `Slice: ${s.name}` }))],
          this.map.settings.activeSlice ?? '',
          (v) => this.showSlice(v),
          { title: 'Show a slice of the graph' },
        ),
      ),
      h('div', { class: 'group grow' }, search),
      h('div', { class: 'group' },
        h('button', { class: this.panelOpen ? 'active' : '', title: 'Style, layout and slice settings', onclick: () => { this.panelOpen = !this.panelOpen; this.renderLayoutState(); } }, '⚙ Settings'),
      ),
      datalist('dl-node-types', types.nodeTypes),
      datalist('dl-edge-types', types.edgeTypes),
      datalist('dl-tags', types.tags),
    );
  }

  private renderPanel() {
    this.panel.classList.toggle('hidden', !this.panelOpen);
    if (!this.panelOpen) return;
    const tabs: [Tab, string][] = [['layout', 'Layout'], ['style', 'Style'], ['slices', 'Slices']];
    const body = this.tab === 'style' ? this.stylePanel() : this.tab === 'slices' ? this.slicePanel() : this.layoutPanel();
    this.panel.replaceChildren(
      h('div', { class: 'tabs' },
        tabs.map(([id, label]) =>
          h('button', { class: this.tab === id ? 'tab active' : 'tab', onclick: () => { this.tab = id; this.renderLayoutState(); } }, label),
        ),
      ),
      h('div', { class: 'panel-body' }, body),
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
        select(SHAPES.map((v) => ({ value: v })), s.shape ?? 'round-rectangle', (v) => { s.shape = v as NodeShape; this.commit({ panel: false }); }),
        h('input', { type: 'number', min: 10, max: 200, value: s.size ?? 40, title: 'Size', class: 'num',
          onchange: (e: Event) => { s.size = Number((e.target as HTMLInputElement).value) || undefined; this.commit({ panel: false }); } }),
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
    return h('div', {},
      field('Layout', select(LAYOUTS, l.name, (v) => this.setLayout({ name: v as LayoutName }))),
      slider('Node spacing (proximity)', l.nodeSpacing, 0, 200, (v) => this.setLayout({ nodeSpacing: v })),
      slider(l.name === 'hierarchy' ? 'Level distance' : 'Edge length', l.edgeLength, 20, 500, (v) => this.setLayout({ edgeLength: v })),
      l.name === 'force' && h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: l.live, onchange: (e: Event) => this.setLayout({ live: (e.target as HTMLInputElement).checked }) }),
        'Live physics with cola (neighbours follow while dragging)'),
      l.name !== 'force' && h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: l.animate, onchange: (e: Event) => this.setLayout({ animate: (e.target as HTMLInputElement).checked }) }),
        'Animate transitions'),
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
        h('button', { onclick: () => this.graph.runLayout(this.map) }, '↻ Run layout'),
      ),
    );
  }

  private sliceFrom(roots: string[]) {
    this.tab = 'slices';
    this.panelOpen = true;
    this.renderLayoutState();
    this.editingSlice = { name: `${this.node(roots[0])?.label || roots[0]} neighbourhood`, roots, direction: 'downstream' };
    this.renderPanel();
  }

  private slicePanel(): HTMLElement {
    const slices = (this.map.settings.slices ??= []);
    const active = this.map.settings.activeSlice;
    const list = h('div', { class: 'slices' },
      h('div', { class: active ? 'slice' : 'slice active' },
        h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.showSlice(undefined); } }, 'Full graph')),
      slices.map((s) =>
        h('div', { class: s.name === active ? 'slice active' : 'slice' },
          h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.showSlice(s.name); } }, s.name),
          h('span', { class: 'muted small' }, describeSlice(s)),
          h('div', { class: 'row' },
            h('button', { onclick: () => { this.editingSlice = clone(s); (this.editingSlice as any).__orig = s.name; this.renderPanel(); } }, 'Edit'),
            h('button', { class: 'danger', onclick: () => {
              this.map.settings.slices = slices.filter((x) => x !== s);
              if (active === s.name) this.map.settings.activeSlice = undefined;
              this.commit({ relayout: active === s.name });
            } }, '✕'),
          ),
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
        : h('button', { onclick: () => { this.editingSlice = { name: newId('Slice ', slices.map((s) => s.name)) }; this.renderPanel(); } }, '+ New slice'),
    );
  }

  private sliceEditor(s: Slice & { __orig?: string }): HTMLElement {
    const types = uniqueTypes(this.map);
    const save = () => {
      const slices = (this.map.settings.slices ??= []);
      const { __orig, ...slice } = s;
      if (!slice.name.trim()) return;
      const idx = slices.findIndex((x) => x.name === (__orig ?? slice.name));
      if (idx >= 0) slices[idx] = slice;
      else slices.push(slice);
      if (__orig && this.map.settings.activeSlice === __orig) this.map.settings.activeSlice = slice.name;
      this.editingSlice = undefined;
      this.showSlice(slice.name);
    };
    return h('div', { class: 'slice-editor' },
      h('h4', {}, s.__orig ? `Edit slice` : 'New slice'),
      field('Name', h('input', { value: s.name, oninput: (e: Event) => (s.name = (e.target as HTMLInputElement).value) })),
      field('Node types', checklist(types.nodeTypes, s.nodeTypes, (v) => (s.nodeTypes = v))),
      field('Tags (any of)', checklist(types.tags, s.tags, (v) => (s.tags = v))),
      field('Dependency types', checklist(types.edgeTypes, s.edgeTypes, (v) => (s.edgeTypes = v))),
      field('Start nodes (ids, comma separated)',
        h('div', { class: 'row' },
          h('input', { value: (s.roots ?? []).join(', '), onchange: (e: Event) => (s.roots = splitList((e.target as HTMLInputElement).value)) }),
          h('button', { title: 'Use selected nodes', onclick: () => {
            s.roots = this.selection.filter((id) => this.node(id));
            this.renderPanel();
          } }, 'use selection'),
        )),
      field('Follow edges', select(
        [{ value: 'downstream', label: 'Downstream (outgoing)' }, { value: 'upstream', label: 'Upstream (incoming)' }, { value: 'both', label: 'Both directions' }],
        s.direction ?? 'downstream', (v) => (s.direction = v as any))),
      field('Max depth (empty = unlimited)', h('input', { type: 'number', min: 0, value: s.depth ?? '',
        onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; s.depth = v === '' ? undefined : Number(v); } })),
      h('p', { class: 'muted small' }, 'Filters combine: node types AND tags, edges by dependency type. With start nodes, only nodes reachable over the allowed edges are shown.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: save }, 'Save & show'),
        h('button', { onclick: () => { this.editingSlice = undefined; this.renderPanel(); } }, 'Cancel'),
      ),
    );
  }
}

function describeSlice(s: Slice): string {
  const parts: string[] = [];
  if (s.nodeTypes?.length) parts.push(`types: ${s.nodeTypes.join(', ')}`);
  if (s.tags?.length) parts.push(`tags: ${s.tags.join(', ')}`);
  if (s.edgeTypes?.length) parts.push(`edges: ${s.edgeTypes.join(', ')}`);
  if (s.roots?.length) parts.push(`from ${s.roots.join(', ')} ${s.direction ?? 'downstream'}${s.depth !== undefined ? ` ≤${s.depth}` : ''}`);
  return parts.join(' · ') || 'everything';
}

new App(document.getElementById('app')!);
