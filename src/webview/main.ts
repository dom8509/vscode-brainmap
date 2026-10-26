import {
  BrainEdge,
  BrainMap,
  BrainNode,
  DEFAULT_LAYOUT,
  FileFormat,
  LayoutName,
  LayoutSettings,
  NodeShape,
  Slice,
  autoColor,
  emptyMap,
  newId,
  uniqueTypes,
} from '../shared/model';
import { HostMessage, WebviewMessage } from '../shared/messages';
import { GraphView } from './graph';
import { checklist, datalist, field, h, select, splitList } from './dom';

const vscode = acquireVsCodeApi();
const post = (msg: WebviewMessage) => vscode.postMessage(msg);

type Tab = 'inspect' | 'style' | 'layout' | 'slices';

const LAYOUTS: { value: LayoutName; label: string }[] = [
  { value: 'force', label: 'Force (physics)' },
  { value: 'fcose', label: 'Force (fCoSE)' },
  { value: 'hierarchy', label: 'Hierarchy (by dependency type)' },
  { value: 'breadthfirst', label: 'Tree (breadth-first)' },
  { value: 'concentric', label: 'Concentric' },
  { value: 'circle', label: 'Circle' },
  { value: 'grid', label: 'Grid' },
  { value: 'preset', label: 'Manual (saved positions)' },
];

const SHAPES: NodeShape[] = ['round-rectangle', 'ellipse', 'rectangle', 'diamond', 'hexagon', 'triangle', 'star'];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

class App {
  map: BrainMap = emptyMap();
  format: FileFormat = 'yaml';
  selection: string[] = [];
  tab: Tab = vscode.getState<{ tab?: Tab }>()?.tab ?? 'inspect';
  connect = false;
  loaded = false;
  newNodeType = '';
  newEdgeType = '';
  editingSlice?: Slice;

  private graph: GraphView;
  private toolbar = h('div', { class: 'toolbar' });
  private panel = h('div', { class: 'panel' });
  private status = h('div', { class: 'status' });
  private error = h('div', { class: 'error hidden' });
  private postTimer?: number;

  constructor(root: HTMLElement) {
    const canvas = h('div', { class: 'canvas' });
    root.append(this.toolbar, h('div', { class: 'main' }, h('div', { class: 'stage' }, canvas, this.status, this.error), this.panel));
    this.graph = new GraphView(canvas, {
      onSelect: (ids) => {
        this.selection = ids;
        if (ids.length && this.tab !== 'slices') this.tab = 'inspect';
        this.renderPanel();
      },
      onPositions: (positions) => {
        for (const n of this.map.nodes) if (positions[n.id]) n.position = positions[n.id];
        this.save();
      },
      onConnect: (source, target) => this.addEdge(source, target),
      onBackgroundDoubleClick: (pos) => this.addNode(pos),
    });

    window.addEventListener('message', (e: MessageEvent<HostMessage>) => this.onMessage(e.data));
    window.addEventListener('keydown', (e) => this.onKey(e));
    post({ type: 'ready' });
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
    // Render the toolbar first: its height decides the canvas size the layout fits into.
    this.renderToolbar();
    const { added } = this.graph.sync(this.map);
    const layoutChanged =
      JSON.stringify(prev.settings.layout) !== JSON.stringify(this.map.settings.layout) ||
      prev.settings.activeSlice !== this.map.settings.activeSlice;
    if (!this.loaded) {
      this.loaded = true;
      const allPlaced = this.map.nodes.length > 0 && this.map.nodes.every((n) => n.position);
      if (allPlaced && this.layout.name !== 'force') this.graph.cy.fit(undefined, 40);
      else this.graph.runLayout(this.map);
    } else if (layoutChanged || (added.length && this.layout.name === 'force' && this.layout.live)) {
      this.graph.runLayout(this.map, { fit: false });
    }
    this.selection = this.selection.filter((id) => this.graph.cy.getElementById(id).nonempty());
    this.render();
  }

  /** Sends the model to the extension host (debounced) which writes it to the file. */
  private save() {
    window.clearTimeout(this.postTimer);
    this.postTimer = window.setTimeout(() => post({ type: 'edit', map: clone(this.map) }), 250);
  }

  /** Applies a model change: re-syncs the graph, re-renders UI and persists. */
  private commit(opts: { relayout?: boolean; fit?: boolean; panel?: boolean } = {}) {
    const { added } = this.graph.sync(this.map);
    if (opts.relayout || (added.length && this.layout.name === 'force' && this.layout.live))
      this.graph.runLayout(this.map, { persist: true, fit: opts.fit ?? false });
    this.renderToolbar();
    if (opts.panel !== false) this.renderPanel();
    this.renderStatus();
    this.save();
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

  addNode(pos?: { x: number; y: number }) {
    const id = newId('n', this.map.nodes.map((n) => n.id));
    const ext = this.graph.cy.extent();
    const node: BrainNode = {
      id,
      label: `Node ${id.slice(1)}`,
      type: this.newNodeType || undefined,
      position: pos ?? { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 },
    };
    // A node selected at creation time becomes the parent of the new node.
    const parent = this.selection.length === 1 ? this.node(this.selection[0]) : undefined;
    this.map.nodes.push(node);
    if (parent && !pos) {
      const p = this.graph.cy.getElementById(parent.id).position();
      node.position = { x: p.x + 60 + Math.random() * 60, y: p.y + 80 };
      this.map.edges.push(this.makeEdge(parent.id, id));
    }
    this.commit();
    this.selection = [id];
    this.graph.select([id]);
    this.tab = 'inspect';
    this.renderPanel();
    (this.panel.querySelector('input[name=label]') as HTMLInputElement | null)?.select();
  }

  private makeEdge(source: string, target: string): BrainEdge {
    return {
      id: newId('e', this.map.edges.map((e) => e.id)),
      source,
      target,
      type: this.newEdgeType || undefined,
    };
  }

  addEdge(source: string, target: string) {
    const e = this.makeEdge(source, target);
    this.map.edges.push(e);
    this.commit();
    this.graph.select([e.id]);
  }

  deleteSelection() {
    if (!this.selection.length) return;
    const ids = new Set(this.selection);
    this.map.nodes = this.map.nodes.filter((n) => !ids.has(n.id));
    const nodeIds = new Set(this.map.nodes.map((n) => n.id));
    this.map.edges = this.map.edges.filter((e) => !ids.has(e.id) && nodeIds.has(e.source) && nodeIds.has(e.target));
    for (const s of this.map.settings.slices ?? []) s.roots = s.roots?.filter((r) => nodeIds.has(r));
    this.selection = [];
    this.commit();
  }

  private renameNode(node: BrainNode, newIdValue: string) {
    const id = newIdValue.trim();
    if (!id || id === node.id) return;
    if (this.node(id)) {
      post({ type: 'notify', level: 'error', message: `A node with id "${id}" already exists.` });
      this.renderPanel();
      return;
    }
    const old = node.id;
    for (const e of this.map.edges) {
      if (e.source === old) e.source = id;
      if (e.target === old) e.target = id;
    }
    for (const s of this.map.settings.slices ?? []) s.roots = s.roots?.map((r) => (r === old ? id : r));
    node.id = id;
    this.selection = [id];
    this.commit();
    this.graph.select([id]);
  }

  private toggleConnect(on = !this.connect) {
    this.connect = on;
    this.graph.setConnectMode(on);
    this.renderToolbar();
    this.renderStatus();
  }

  private showSlice(name: string | undefined) {
    this.map.settings.activeSlice = name || undefined;
    this.commit({ relayout: true, fit: true });
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        this.deleteSelection();
        break;
      case 'n':
        this.addNode();
        break;
      case 'e':
        this.toggleConnect();
        break;
      case 'f':
        this.graph.fit();
        break;
      case 'l':
        this.graph.runLayout(this.map, { persist: true });
        break;
      case 'Escape':
        if (this.connect) this.toggleConnect(false);
        else this.graph.select([]);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  // ---------------------------------------------------------------- rendering

  render() {
    this.renderToolbar();
    this.renderPanel();
    this.renderStatus();
  }

  private renderStatus() {
    const slice = this.map.settings.activeSlice;
    const visible = this.graph.cy.nodes().not('.hidden').not('.dimmed').length;
    this.status.textContent =
      `${this.map.nodes.length} nodes · ${this.map.edges.length} edges · ${this.format.toUpperCase()}` +
      (slice ? ` · slice "${slice}" (${visible} nodes)` : '') +
      (this.connect ? ' · CONNECT MODE: drag from one node to another (Esc to exit)' : '');
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
        if (hits.length) this.graph.select(hits, true);
      },
      oninput: (e: Event) => this.graph.highlightSearch((e.target as HTMLInputElement).value),
    });

    this.toolbar.replaceChildren(
      h('div', { class: 'group' },
        h('button', { title: 'Add node (N). With one node selected the new node becomes its child.', onclick: () => this.addNode() }, '+ Node'),
        h('input', { class: 'type-input', placeholder: 'node type', list: 'dl-node-types', value: this.newNodeType, title: 'Type for new nodes',
          onchange: (e: Event) => (this.newNodeType = (e.target as HTMLInputElement).value.trim()) }),
        h('button', { class: this.connect ? 'active' : '', title: 'Connect mode (E): drag from node to node to create an edge', onclick: () => this.toggleConnect() }, '⤳ Connect'),
        h('input', { class: 'type-input', placeholder: 'edge type', list: 'dl-edge-types', value: this.newEdgeType, title: 'Dependency type for new edges',
          onchange: (e: Event) => (this.newEdgeType = (e.target as HTMLInputElement).value.trim()) }),
        h('button', { title: 'Delete selection (Del)', disabled: !this.selection.length, onclick: () => this.deleteSelection() }, '🗑'),
      ),
      h('div', { class: 'group' },
        select(LAYOUTS, l.name, (v) => this.setLayout({ name: v as LayoutName }), { title: 'Layout' }),
        (l.name === 'hierarchy' || l.name === 'breadthfirst') &&
          select(
            [
              { value: '', label: 'by: all edge types' },
              ...types.edgeTypes.map((t) => ({ value: t, label: `by: ${t}` })),
              ...(hierarchyValue === '__multi' ? [{ value: '__multi', label: `by: ${l.hierarchyEdgeTypes.join(', ')}` }] : []),
            ],
            hierarchyValue,
            (v) => v !== '__multi' && this.setLayout({ hierarchyEdgeTypes: v ? [v] : [] }),
            { title: 'Dependency type that defines the hierarchy' },
          ),
        h('button', { title: 'Run layout again (L)', onclick: () => this.graph.runLayout(this.map, { persist: true }) }, '↻ Layout'),
        h('button', { title: 'Fit to screen (F)', onclick: () => this.graph.fit() }, '⛶ Fit'),
      ),
      h('div', { class: 'group' },
        select(
          [{ value: '', label: 'Slice: full graph' }, ...slices.map((s) => ({ value: s.name, label: `Slice: ${s.name}` }))],
          this.map.settings.activeSlice ?? '',
          (v) => this.showSlice(v),
          { title: 'Show a slice of the graph' },
        ),
      ),
      h('div', { class: 'group grow' }, search),
      h('div', { class: 'group' }, h('button', { title: 'Open the file as text', onclick: () => post({ type: 'openText' }) }, '{ } Text')),
      datalist('dl-node-types', types.nodeTypes),
      datalist('dl-edge-types', types.edgeTypes),
      datalist('dl-tags', types.tags),
    );
  }

  private renderPanel() {
    vscode.setState({ tab: this.tab });
    const tabs: [Tab, string][] = [['inspect', 'Inspector'], ['style', 'Style'], ['layout', 'Layout'], ['slices', 'Slices']];
    const body =
      this.tab === 'inspect' ? this.inspector()
      : this.tab === 'style' ? this.stylePanel()
      : this.tab === 'layout' ? this.layoutPanel()
      : this.slicePanel();
    this.panel.replaceChildren(
      h('div', { class: 'tabs' },
        tabs.map(([id, label]) =>
          h('button', { class: this.tab === id ? 'tab active' : 'tab', onclick: () => { this.tab = id; this.renderPanel(); } }, label),
        ),
      ),
      h('div', { class: 'panel-body' }, body),
    );
  }

  private inspector(): HTMLElement {
    const sel = this.selection;
    if (sel.length === 0) {
      return h('div', {},
        field('Title', h('input', { value: this.map.title ?? '', onchange: (e: Event) => { this.map.title = (e.target as HTMLInputElement).value; this.commit({ panel: false }); } })),
        h('p', { class: 'muted' }, 'Select a node or edge to edit it.'),
        h('ul', { class: 'help' },
          h('li', {}, h('b', {}, 'Double-click'), ' empty space: new node'),
          h('li', {}, h('b', {}, 'N'), ': new node (child of selection)'),
          h('li', {}, h('b', {}, 'E'), ': connect mode – drag node to node'),
          h('li', {}, h('b', {}, 'Del'), ': delete selection'),
          h('li', {}, h('b', {}, 'Shift+drag'), ': box select'),
          h('li', {}, h('b', {}, 'L'), ' layout · ', h('b', {}, 'F'), ' fit · ', h('b', {}, 'Ctrl+Z'), ' undo'),
        ),
      );
    }
    if (sel.length > 1) return this.multiInspector();
    const node = this.node(sel[0]);
    if (node) return this.nodeInspector(node);
    const edge = this.edge(sel[0]);
    if (edge) return this.edgeInspector(edge);
    return h('div', {});
  }

  private text(value: string | undefined, apply: (v: string) => void, attrs: Record<string, any> = {}) {
    return h('input', { value: value ?? '', ...attrs, onchange: (e: Event) => { apply((e.target as HTMLInputElement).value); this.commit({ panel: false }); } });
  }

  private nodeInspector(node: BrainNode): HTMLElement {
    const outgoing = this.map.edges.filter((e) => e.source === node.id);
    const incoming = this.map.edges.filter((e) => e.target === node.id);
    const link = (id: string) => h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.graph.select([id], true); } }, this.node(id)?.label || id);
    return h('div', {},
      h('h3', {}, 'Node'),
      field('Label', h('textarea', { name: 'label', rows: 2, value: node.label ?? '', onchange: (e: Event) => { node.label = (e.target as HTMLTextAreaElement).value; this.commit({ panel: false }); } })),
      field('Id', h('input', { value: node.id, onchange: (e: Event) => this.renameNode(node, (e.target as HTMLInputElement).value) })),
      field('Type', this.text(node.type, (v) => (node.type = v.trim() || undefined), { list: 'dl-node-types' })),
      field('Tags (comma separated)', this.text(node.tags?.join(', '), (v) => (node.tags = splitList(v)), { list: 'dl-tags' })),
      field('Color override',
        h('div', { class: 'row' },
          h('input', { type: 'color', value: node.color ?? '#6c7a89', onchange: (e: Event) => { node.color = (e.target as HTMLInputElement).value; this.commit({ panel: false }); } }),
          node.color && h('button', { onclick: () => { node.color = undefined; this.commit(); } }, 'reset'),
        ),
      ),
      field('Description', h('textarea', { rows: 4, value: node.description ?? '', onchange: (e: Event) => { node.description = (e.target as HTMLTextAreaElement).value || undefined; this.commit({ panel: false }); } })),
      h('div', { class: 'row' },
        h('button', { onclick: () => this.addNode() }, '+ Child'),
        h('button', { onclick: () => this.sliceFrom([node.id]) }, 'Slice from here'),
        h('button', { class: 'danger', onclick: () => this.deleteSelection() }, 'Delete'),
      ),
      (outgoing.length > 0 || incoming.length > 0) && h('h4', {}, 'Connections'),
      h('ul', { class: 'links' },
        outgoing.map((e) => h('li', {}, '→ ', link(e.target), h('span', { class: 'muted' }, ` ${e.type ?? ''}`))),
        incoming.map((e) => h('li', {}, '← ', link(e.source), h('span', { class: 'muted' }, ` ${e.type ?? ''}`))),
      ),
    );
  }

  private edgeInspector(edge: BrainEdge): HTMLElement {
    const nodeOptions = this.map.nodes.map((n) => ({ value: n.id, label: n.label || n.id }));
    return h('div', {},
      h('h3', {}, 'Edge'),
      field('Source', select(nodeOptions, edge.source, (v) => { edge.source = v; this.commit({ panel: false }); })),
      field('Target', select(nodeOptions, edge.target, (v) => { edge.target = v; this.commit({ panel: false }); })),
      field('Dependency type', this.text(edge.type, (v) => (edge.type = v.trim() || undefined), { list: 'dl-edge-types' })),
      field('Label', this.text(edge.label, (v) => (edge.label = v || undefined))),
      h('div', { class: 'row' },
        h('button', { onclick: () => { [edge.source, edge.target] = [edge.target, edge.source]; this.commit({ panel: false }); } }, '⇄ Reverse'),
        h('button', { class: 'danger', onclick: () => this.deleteSelection() }, 'Delete'),
      ),
    );
  }

  private multiInspector(): HTMLElement {
    const nodes = this.selection.map((id) => this.node(id)).filter((n): n is BrainNode => !!n);
    const edges = this.selection.map((id) => this.edge(id)).filter((e): e is BrainEdge => !!e);
    return h('div', {},
      h('h3', {}, `${nodes.length} nodes, ${edges.length} edges selected`),
      nodes.length > 0 && field('Set type of nodes', this.text('', (v) => nodes.forEach((n) => (n.type = v.trim() || undefined)), { list: 'dl-node-types' })),
      nodes.length > 0 && field('Add tag to nodes', this.text('', (v) => {
        const tags = splitList(v);
        nodes.forEach((n) => (n.tags = [...new Set([...(n.tags ?? []), ...tags])]));
      }, { list: 'dl-tags' })),
      edges.length > 0 && field('Set dependency type of edges', this.text('', (v) => edges.forEach((e) => (e.type = v.trim() || undefined)), { list: 'dl-edge-types' })),
      h('div', { class: 'row' },
        nodes.length > 0 && h('button', { onclick: () => this.sliceFrom(nodes.map((n) => n.id)) }, 'Slice from these'),
        h('button', { class: 'danger', onclick: () => this.deleteSelection() }, 'Delete all'),
      ),
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
        'Live physics (neighbours follow while dragging)'),
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
      h('div', { class: 'row' },
        h('button', { onclick: () => this.graph.runLayout(this.map, { persist: true }) }, '↻ Run layout'),
        h('button', { title: 'Keep the current positions and switch to manual layout', onclick: () => {
          const pos = this.graph.positions();
          for (const n of this.map.nodes) n.position = pos[n.id];
          this.setLayout({ name: 'preset' }, false);
        } }, '📌 Pin positions'),
      ),
    );
  }

  private sliceFrom(roots: string[]) {
    this.tab = 'slices';
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
