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
  resolveEdgeStyle,
  resolveNodeStyle,
} from '../shared/model';

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
    });

    // Highlight the neighbourhood of the hovered node.
    this.cy.on('mouseover', 'node', (e) => {
      const hood = e.target.closedNeighborhood();
      this.cy.elements().not(hood).addClass('faded');
      hood.addClass('hover');
    });
    this.cy.on('mouseout', 'node', () => this.cy.elements().removeClass('faded hover'));
  }

  private stylesheet(): any[] {
    const fg = cssVar('--vscode-editor-foreground', '#cccccc');
    const bg = cssVar('--vscode-editor-background', '#1e1e1e');
    const focus = cssVar('--vscode-focusBorder', '#007fd4');
    const font = cssVar('--vscode-font-family', 'sans-serif');
    return [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'background-color': 'data(color)',
          shape: 'data(shape)',
          width: 'data(width)',
          height: 'data(size)',
          color: 'data(textColor)',
          'font-family': font,
          'font-size': 12,
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '160px',
          'border-width': 1,
          'border-color': bg,
          'transition-property': 'opacity, background-color, border-width',
          'transition-duration': 200,
        } as any,
      },
      {
        selector: 'node:selected',
        style: { 'border-width': 3, 'border-color': focus, 'overlay-opacity': 0 } as any,
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
          'arrow-scale': 1.1,
          'curve-style': 'bezier',
          label: 'data(label)',
          'font-size': 10,
          'font-family': font,
          color: fg,
          'text-rotation': 'autorotate',
          'text-background-color': bg,
          'text-background-opacity': 0.85,
          'text-background-padding': '2px',
          'transition-property': 'opacity, line-color',
          'transition-duration': 200,
        } as any,
      },
      {
        selector: 'edge:selected',
        style: { width: 4, 'line-color': focus, 'target-arrow-color': focus, 'source-arrow-color': focus, 'overlay-opacity': 0 } as any,
      },
      { selector: '.faded', style: { opacity: 0.25 } },
      { selector: '.dimmed', style: { opacity: 0.1, events: 'no' } as any },
      { selector: '.hidden', style: { display: 'none' } },
      { selector: '.search-hit', style: { 'border-width': 4, 'border-color': '#ffd700' } as any },
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
        const longest = Math.max(...label.split('\n').map((l) => l.length));
        const data = {
          id: n.id,
          label,
          color: st.color,
          textColor: readableText(st.color),
          shape: st.shape,
          size: st.size,
          width: Math.max(st.size, Math.min(longest, 24) * 7 + 24),
          type: n.type ?? '',
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
          width: st.width,
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
    });
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
          rankSep: l.edgeLength,
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
      else if (fit && l.name === 'force' && l.live) this.fit();
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

  fit() {
    this.cy.animate({ fit: { eles: this.cy.elements().not('.hidden'), padding: 40 } } as any, { duration: 400 });
  }
}

/** Black or white, whichever reads better on the given background. */
function readableText(color: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1e1e1e' : '#ffffff';
}
