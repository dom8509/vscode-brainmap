import cytoscape, { Core, ElementDefinition, Layouts, NodeSingular } from 'cytoscape';
import cola from 'cytoscape-cola';
import fcose from 'cytoscape-fcose';
import dagre from 'cytoscape-dagre';
import {
  BrainMap,
  DEFAULT_LAYOUT,
  LayoutSettings,
  Position,
  computeSlice,
  autoColor,
  resolveEdgeStyle,
  resolveNodeStyle,
} from '../shared/model';
import { CARD_HEIGHT } from './cards';

cytoscape.use(cola);
cytoscape.use(fcose);
cytoscape.use(dagre);

export interface GraphCallbacks {
  onSelect(ids: string[]): void;
  onBackgroundDoubleClick(pos: Position): void;
  /** Right click on a node, an edge or the background. */
  onContextMenu(target: { kind: 'node' | 'edge' | 'background'; id?: string }, client: Position, pos: Position): void;
  /** Pan, zoom or node movement changed where things are on screen. */
  onViewport(): void;
  /** A dragged node hovers over another node (or left it: `target` undefined). */
  onDropHover(source: string, target: string | undefined): void;
  /** A dragged node was released on another node. */
  onDropConnect(source: string, target: string): void;
  /** Double click on a node. */
  onNodeDoubleClick(id: string): void;
  /** The mouse rests on a node (`undefined` when it leaves). */
  onHover(id: string | undefined): void;
}

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;

export class GraphView {
  readonly cy: Core;
  private layout?: Layouts;
  /** Where nodes that are about to be added should appear. */
  private pending = new Map<string, Position>();
  private selTimer?: number;
  /** Center the view on the selection (layout setting `followSelection`). */
  follow = true;
  /** Dim everything that is not next to the selection. */
  focus = true;
  private dashOffset = 0;
  private dashFrame = 0;
  private drag?: { id: string; start: Position; target?: string; held?: string };

  constructor(container: HTMLElement, private readonly cb: GraphCallbacks) {
    this.cy = cytoscape({
      container,
      wheelSensitivity: 0.3,
      minZoom: 0.05,
      maxZoom: 4,
      boxSelectionEnabled: true,
      selectionType: 'single',
      style: this.stylesheet(),
    });

    this.cy.on('select unselect', () => {
      window.clearTimeout(this.selTimer);
      this.selTimer = window.setTimeout(() => {
        const ids = this.cy.$(':selected').map((e) => e.id());
        if (this.follow && ids.length) this.centerOn(ids);
        this.applyFocus();
        this.cb.onSelect(ids);
      }, 10);
    });

    this.cy.on('cxttap', (e) => {
      const t = e.target;
      const kind = t === this.cy ? 'background' : t.isNode() ? 'node' : 'edge';
      const oe = e.originalEvent as MouseEvent;
      this.cb.onContextMenu({ kind, id: kind === 'background' ? undefined : t.id() }, { x: oe.clientX, y: oe.clientY }, e.position);
    });
    container.addEventListener('contextmenu', (e) => e.preventDefault());
    this.cy.on('viewport position', () => this.cb.onViewport());

    // The canvas changes size when the toolbar wraps or the editor is resized.
    new ResizeObserver(() => this.cy.resize()).observe(container);

    this.cy.on('dbltap', (e) => {
      if (e.target === this.cy) this.cb.onBackgroundDoubleClick(e.position);
      else if (e.target.isNode()) this.cb.onNodeDoubleClick(e.target.id());
    });

    this.cy.on('mouseover', 'node', (e) => {
      e.target.addClass('hover');
      this.cb.onHover(e.target.id());
    });
    this.cy.on('mouseout', 'node', (e) => {
      e.target.removeClass('hover');
      this.cb.onHover(undefined);
    });
    this.cy.on('grab cxttap', () => this.cb.onHover(undefined));

    // Drag a node onto another one to connect them; the dragged node then springs back.
    this.cy.on('grab', 'node', (e) => {
      this.drag = { id: e.target.id(), start: { ...e.target.position() } };
    });
    this.cy.on('drag', 'node', (e) => {
      const drag = this.drag;
      if (!drag || drag.id !== e.target.id()) return;
      const p = e.target.position();
      // Pads are half the dragged card plus a margin, i.e. "the cards are about to touch".
      const inside = (n: any, near: boolean) => {
        const b = n.boundingBox({});
        const px = near ? e.target.width() / 2 + 40 : 0;
        const py = near ? CARD_HEIGHT / 2 + 40 : 0;
        return p.x > b.x1 - px && p.x < b.x2 + px && p.y > b.y1 - py && p.y < b.y2 + py;
      };
      const others = this.cy.nodes().not('.hidden').filter((n) => !n.same(e.target));
      // Live physics pushes nodes apart, so hold the node we approach still until we leave it.
      const near = others.filter((n) => inside(n, true));
      const nearId = near.nonempty() ? near[0].id() : undefined;
      if (nearId !== drag.held) {
        if (drag.held) this.cy.getElementById(drag.held).unlock();
        drag.held = nearId && !near[0].locked() ? nearId : undefined;
        if (drag.held) near[0].lock();
      }
      const over = near.filter((n) => inside(n, false));
      const target = over.nonempty() ? over[0].id() : undefined;
      if (target === drag.target) return;
      if (drag.target) this.cy.getElementById(drag.target).removeClass('drop-target');
      if (target) this.cy.getElementById(target).addClass('drop-target');
      drag.target = target;
      this.cb.onDropHover(drag.id, target);
    });
    this.cy.on('free', 'node', (e) => {
      const drag = this.drag;
      this.drag = undefined;
      if (drag?.held) this.cy.getElementById(drag.held).unlock();
      if (!drag?.target || drag.id !== e.target.id()) return;
      this.cy.getElementById(drag.target).removeClass('drop-target');
      e.target.animate({ position: drag.start } as any, { duration: 300, easing: 'ease-out-cubic' } as any);
      this.cb.onDropConnect(drag.id, drag.target);
      this.cb.onDropHover(drag.id, undefined);
    });
  }

  /** Focus mode: dim what is not next to the selection and let its connections flow. */
  applyFocus() {
    const cy = this.cy;
    cy.batch(() => {
      cy.elements().removeClass('fdim on off');
      const sel = cy.$(':selected');
      if (!this.focus || sel.empty()) return;
      const nodes = sel.nodes().union(sel.edges().connectedNodes());
      const hood = nodes.closedNeighborhood().nodes().union(nodes);
      const active = sel.nodes().connectedEdges().union(sel.edges());
      cy.nodes().not(hood).addClass('fdim');
      active.addClass('on');
      cy.edges().not(active).addClass('off');
    });
    this.animateDashes();
  }

  /** Moves the dash pattern of active connections so they look like they flow. */
  private animateDashes() {
    cancelAnimationFrame(this.dashFrame);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const step = () => {
      const on = this.cy.edges('.on');
      if (on.empty() || reduced) return;
      this.dashOffset = (this.dashOffset - 0.6) % 1000;
      on.style('line-dash-offset', this.dashOffset);
      this.dashFrame = requestAnimationFrame(step);
    };
    this.dashFrame = requestAnimationFrame(step);
  }

  private stylesheet(): any[] {
    const fg = cssVar('--vscode-editor-foreground', '#cccccc');
    const card = cssVar('--vscode-editorWidget-background', '#20232A');
    const border = cssVar('--vscode-widget-border', '#343944');
    const accent = cssVar('--vscode-focusBorder', '#5B9BFF');
    const font = cssVar('--vscode-font-family', 'sans-serif');
    return [
      {
        // The node is an invisible hit box; the HTML card on top draws it.
        selector: 'node',
        style: {
          shape: 'round-rectangle',
          width: 'data(width)',
          height: CARD_HEIGHT,
          'background-opacity': 0,
          'border-width': 0,
          label: '',
          'overlay-opacity': 0,
        } as any,
      },
      {
        selector: 'edge',
        style: {
          width: 'data(width)',
          'line-color': 'data(color)',
          'line-style': 'data(lineStyle)',
          'target-arrow-color': 'data(color)',
          'target-arrow-shape': 'triangle',
          'source-arrow-color': 'data(color)',
          'source-arrow-shape': 'data(sourceArrow)',
          'arrow-scale': 0.85,
          'curve-style': 'bezier',
          'line-cap': 'round',
          label: 'data(label)',
          'font-size': 11,
          'font-family': font,
          color: fg,
          'text-background-color': card,
          'text-background-opacity': 1,
          'text-background-shape': 'round-rectangle',
          'text-background-padding': '3px',
          'text-border-width': 1,
          'text-border-color': border,
          'text-border-opacity': 1,
          'overlay-opacity': 0,
          'transition-property': 'opacity, width',
          'transition-duration': 250,
        } as any,
      },
      { selector: 'edge.taxi-down', style: { 'curve-style': 'round-taxi', 'taxi-direction': 'downward', 'taxi-radius': 18 } as any },
      { selector: 'edge.taxi-up', style: { 'curve-style': 'round-taxi', 'taxi-direction': 'upward', 'taxi-radius': 18 } as any },
      { selector: 'edge.taxi-right', style: { 'curve-style': 'round-taxi', 'taxi-direction': 'rightward', 'taxi-radius': 18 } as any },
      { selector: 'edge.taxi-left', style: { 'curve-style': 'round-taxi', 'taxi-direction': 'leftward', 'taxi-radius': 18 } as any },
      { selector: 'edge.on', style: { width: 2.6, 'line-style': 'dashed', 'line-dash-pattern': [8, 6] } as any },
      { selector: 'edge.off', style: { opacity: 0.12 } },
      {
        selector: 'edge:selected',
        style: { width: 3, 'line-color': accent, 'target-arrow-color': accent, 'source-arrow-color': accent } as any,
      },
      { selector: '.dimmed', style: { opacity: 0.1, events: 'no' } as any },
      { selector: '.hidden', style: { display: 'none' } },
    ];
  }

  /** Brings the cytoscape graph in line with the model, keeping existing positions. */
  sync(map: BrainMap): { added: string[] } {
    const cy = this.cy;
    const added: string[] = [];
    cy.batch(() => {
      const nodeIds = new Set(map.nodes.map((n) => n.id));
      const edgeIds = new Set(map.edges.map((e) => e.id));
      cy.edges().filter((e) => !edgeIds.has(e.id())).remove();
      cy.nodes().filter((n) => !nodeIds.has(n.id())).remove();

      const center = this.viewportCenter();
      const toAdd: ElementDefinition[] = [];
      for (const n of map.nodes) {
        const st = resolveNodeStyle(map, n);
        const label = n.label || n.id;
        const typeColor = (n.type && map.settings.style?.nodeTypes?.[n.type]?.color) || (n.type ? autoColor(n.type) : st.color);
        const data = {
          id: n.id,
          label,
          color: st.color,
          typeColor,
          type: n.type ?? '',
          typeName: n.type ? n.type.charAt(0).toUpperCase() + n.type.slice(1) : '',
          tags: n.tags ?? [],
          // Wide enough for the name, within limits so the graph stays tidy.
          width: Math.round(Math.max(170, Math.min(260, label.length * 7.4 + 96))),
        };
        const existing = cy.getElementById(n.id);
        if (existing.nonempty()) existing.data(data);
        else {
          added.push(n.id);
          toAdd.push({
            group: 'nodes',
            data,
            position: this.pending.get(n.id) ?? {
              x: center.x + (Math.random() - 0.5) * 200,
              y: center.y + (Math.random() - 0.5) * 200,
            },
          });
        }
      }
      for (const e of map.edges) {
        const st = resolveEdgeStyle(map, e);
        const data = {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label ?? '',
          sourceArrow: e.directed === false ? 'triangle' : 'none',
          type: e.type ?? '',
          color: st.color,
          lineStyle: st.lineStyle,
          width: Math.min(st.width ?? 2, 2),
        };
        const existing = cy.getElementById(e.id);
        if (existing.nonempty() && existing.data('source') === e.source && existing.data('target') === e.target)
          existing.data(data);
        else {
          existing.remove();
          toAdd.push({ group: 'edges', data });
        }
      }
      cy.add(toAdd);
      this.pending.clear();
      this.applySlice(map);
      this.applyHierarchyEdgeVisibility(map);
      this.applyEdgeRouting(map);
    });
    this.applyFocus();
    return { added };
  }

  private viewportCenter(): Position {
    const ext = this.cy.extent();
    return { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 };
  }

  applySlice(map: BrainMap) {
    const cy = this.cy;
    cy.elements().removeClass('hidden dimmed');
    const slice = map.settings.slices?.find((s) => s.name === map.settings.activeSlice);
    if (!slice) return;
    const res = computeSlice(map, slice);
    const cls = map.settings.sliceMode === 'dim' ? 'dimmed' : 'hidden';
    cy.nodes().forEach((n) => {
      if (!res.nodes.has(n.id())) n.addClass(cls);
    });
    cy.edges().forEach((e) => {
      if (!res.edges.has(e.id())) e.addClass(cls);
    });
  }

  /** Hierarchies get rounded right-angle connections in the flow direction. */
  private applyEdgeRouting(map: BrainMap) {
    const l = { ...DEFAULT_LAYOUT, ...map.settings.layout };
    const cls = { TB: 'taxi-down', BT: 'taxi-up', LR: 'taxi-right', RL: 'taxi-left' }[l.direction];
    this.cy.edges().removeClass('taxi-down taxi-up taxi-right taxi-left');
    if (l.name === 'hierarchy') this.cy.edges().addClass(cls);
  }

  /** In hierarchy mode edges outside the hierarchy can be hidden. */
  private applyHierarchyEdgeVisibility(map: BrainMap) {
    const l = { ...DEFAULT_LAYOUT, ...map.settings.layout };
    if (l.name !== 'hierarchy' || !l.hierarchyEdgeTypes.length || !l.hideOtherEdges) return;
    const types = new Set(l.hierarchyEdgeTypes);
    this.cy.edges().forEach((e) => {
      if (!types.has(e.data('type'))) e.addClass('hidden');
    });
  }

  stopLayout() {
    this.layout?.stop();
    this.layout = undefined;
  }

  /**
   * Runs the configured layout over the visible elements.
   */
  runLayout(map: BrainMap, opts: { fit?: boolean } = {}) {
    this.stopLayout();
    this.cy.resize();
    const l: Required<LayoutSettings> = { ...DEFAULT_LAYOUT, ...map.settings.layout };
    const edgeStyles = map.settings.style?.edgeTypes ?? {};
    const lengthOf = (edge: any) => edgeStyles[edge.data('type')]?.length ?? l.edgeLength;
    const fit = (opts.fit ?? true) && !(this.follow && this.cy.$(':selected').nonempty());
    const visible = this.cy.elements().not('.hidden');
    const anim = { animate: l.animate, animationDuration: 600, animationEasing: 'ease-in-out-cubic', fit, padding: 40 };

    let eles = visible;
    let options: any;
    switch (l.name) {
      case 'force':
      default:
        options = {
          name: 'cola',
          animate: true,
          infinite: l.live,
          // Fitting on every tick would fight the user's zoom in live mode.
          fit: fit && !l.live,
          padding: 40,
          randomize: false,
          centerGraph: false,
          avoidOverlap: true,
          handleDisconnected: true,
          nodeSpacing: () => l.nodeSpacing / 2,
          edgeLength: lengthOf,
          maxSimulationTime: 4000,
        };
        break;
      case 'fcose':
        options = {
          name: 'fcose',
          ...anim,
          quality: 'proof',
          randomize: false,
          nodeSeparation: l.nodeSpacing,
          idealEdgeLength: lengthOf,
          nodeRepulsion: () => 4500 + l.nodeSpacing * 100,
          edgeElasticity: () => 0.45,
        };
        break;
      case 'hierarchy': {
        const types = new Set(l.hierarchyEdgeTypes);
        // Only edges of the selected dependency types shape the hierarchy.
        eles = visible.nodes().union(
          visible.edges().filter((e) => !types.size || types.has(e.data('type'))),
        );
        options = {
          name: 'dagre',
          ...anim,
          rankDir: l.direction,
          nodeSep: l.nodeSpacing,
          rankSep: Math.max(l.edgeLength, 60),
          edgeSep: 10,
        };
        break;
      }
      case 'breadthfirst': {
        const types = new Set(l.hierarchyEdgeTypes);
        const edges = visible.edges().filter((e) => !types.size || types.has(e.data('type')));
        eles = visible.nodes().union(edges);
        const roots = visible.nodes().filter((n) => n.incomers('edge').intersection(edges).empty());
        options = { name: 'breadthfirst', ...anim, directed: true, roots, spacingFactor: 0.6 + l.nodeSpacing / 50 };
        break;
      }
      case 'concentric':
        options = {
          name: 'concentric',
          ...anim,
          minNodeSpacing: l.nodeSpacing,
          concentric: (n: NodeSingular) => n.degree(false),
          levelWidth: () => 2,
        };
        break;
      case 'circle':
        options = { name: 'circle', ...anim, spacingFactor: 0.6 + l.nodeSpacing / 50 };
        break;
      case 'grid':
        options = { name: 'grid', ...anim, avoidOverlapPadding: l.nodeSpacing };
        break;
    }

    const layout = eles.layout(options);
    this.layout = layout;
    // With a selection and followSelection, the selection decides the view instead of fitting everything.
    // Read the selection when the layout settles: it may change while the layout runs.
    const settle = () => {
      const selected = this.follow ? this.cy.$(':selected').map((e) => e.id()) : [];
      if (selected.length) this.centerOn(selected);
      else if ((fit && l.name === 'force' && l.live) || !this.allInView()) this.fit();
    };
    if (l.name === 'force' && l.live) window.setTimeout(() => this.layout === layout && settle(), 1200);
    else layout.one('layoutstop', settle);
    layout.run();
  }

  /** The next sync adds node `id` at `pos` instead of a random spot. */
  placeAt(id: string, pos: Position) {
    this.pending.set(id, pos);
  }

  select(ids: string[]) {
    this.cy.batch(() => {
      this.cy.$(':selected').unselect();
      ids.forEach((id) => this.cy.getElementById(id).select());
    });
  }

  centerOn(ids: string[], duration = 350) {
    const eles = this.cy.collection(ids.map((id) => this.cy.getElementById(id)) as any).not('.hidden');
    if (eles.empty()) return;
    this.cy.stop(true);
    this.cy.animate({ center: { eles } } as any, { duration });
  }

  /** Screen box (relative to the canvas) of an element. */
  renderedBox(id: string) {
    const el = this.cy.getElementById(id);
    if (el.empty() || el.hasClass('hidden')) return undefined;
    // For a connection include both end nodes, so a window placed beside it doesn't cover them.
    const eles = el.isEdge() ? el.union(el.connectedNodes()) : el;
    return eles.renderedBoundingBox({ includeLabels: false } as any);
  }

  /** Puts the model point (x, y) in the middle of the canvas. */
  centerPoint(p: Position) {
    this.cy.resize();
    this.cy.pan({ x: this.cy.width() / 2 - p.x * this.cy.zoom(), y: this.cy.height() / 2 - p.y * this.cy.zoom() });
  }

  highlightSearch(text: string): string[] {
    const q = text.trim().toLowerCase();
    this.cy.nodes().removeClass('search-hit');
    if (!q) return [];
    const hits = this.cy
      .nodes()
      .not('.hidden')
      .filter((n) => `${n.data('label')} ${n.id()} ${n.data('type')}`.toLowerCase().includes(q));
    hits.addClass('search-hit');
    return hits.map((n) => n.id());
  }

  /** True when every visible node is inside the viewport. */
  private allInView(): boolean {
    const bb = this.cy.nodes().not('.hidden').boundingBox({});
    const ext = this.cy.extent();
    return bb.w === 0 || (bb.x1 >= ext.x1 && bb.x2 <= ext.x2 && bb.y1 >= ext.y1 && bb.y2 <= ext.y2);
  }

  fit() {
    this.cy.animate({ fit: { eles: this.cy.elements().not('.hidden'), padding: 40 } } as any, { duration: 400 });
  }
}
