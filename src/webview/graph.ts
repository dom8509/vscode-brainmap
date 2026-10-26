import cytoscape, { Core, ElementDefinition, Layouts, NodeSingular } from 'cytoscape';
import cola from 'cytoscape-cola';
import fcose from 'cytoscape-fcose';
import dagre from 'cytoscape-dagre';
import edgehandles from 'cytoscape-edgehandles';
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
cytoscape.use(edgehandles);

export interface GraphCallbacks {
  onSelect(ids: string[]): void;
  /** User moved nodes; positions should be persisted. */
  onPositions(positions: Record<string, Position>): void;
  onConnect(source: string, target: string): void;
  onBackgroundDoubleClick(pos: Position): void;
}

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;

export class GraphView {
  readonly cy: Core;
  private eh: any;
  private layout?: Layouts;
  private saveTimer?: number;
  private connectMode = false;

  constructor(container: HTMLElement, private readonly cb: GraphCallbacks) {
    this.cy = cytoscape({
      container,
      wheelSensitivity: 0.3,
      minZoom: 0.05,
      maxZoom: 4,
      boxSelectionEnabled: true,
      selectionType: 'additive',
      style: this.stylesheet(),
    });

    this.eh = (this.cy as any).edgehandles({
      canConnect: (s: NodeSingular, t: NodeSingular) => !s.same(t),
      edgeParams: () => ({ data: { color: cssVar('--vscode-focusBorder', '#007fd4') } }),
      hoverDelay: 100,
      snap: true,
    });

    this.cy.on('ehcomplete', (_e: unknown, source: NodeSingular, target: NodeSingular, added: any) => {
      added.remove();
      this.cb.onConnect(source.id(), target.id());
    });

    this.cy.on('select unselect', () => {
      window.clearTimeout((this as any).selTimer);
      (this as any).selTimer = window.setTimeout(
        () => this.cb.onSelect(this.cy.$(':selected').map((e) => e.id())),
        10,
      );
    });

    // The canvas changes size when the toolbar wraps or the editor is resized.
    new ResizeObserver(() => this.cy.resize()).observe(container);

    this.cy.on('dragfree', 'node', () => this.schedulePositionSave(1200));

    this.cy.on('dbltap', (e) => {
      if (e.target === this.cy) this.cb.onBackgroundDoubleClick(e.position);
    });

    // Highlight the neighbourhood of the hovered node.
    this.cy.on('mouseover', 'node', (e) => {
      if (this.connectMode) return;
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
          color: '#ffffff',
          'font-family': font,
          'font-size': 12,
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '160px',
          'text-outline-color': 'data(color)',
          'text-outline-width': 1.5,
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
        style: { width: 4, 'line-color': focus, 'target-arrow-color': focus, 'overlay-opacity': 0 } as any,
      },
      { selector: '.faded', style: { opacity: 0.25 } },
      { selector: '.dimmed', style: { opacity: 0.1, events: 'no' } as any },
      { selector: '.hidden', style: { display: 'none' } },
      { selector: '.search-hit', style: { 'border-width': 4, 'border-color': '#ffd700' } as any },
      {
        selector: '.eh-handle, .eh-ghost-node',
        style: { 'background-color': focus, width: 10, height: 10, shape: 'ellipse', label: '' } as any,
      },
      {
        selector: '.eh-preview, .eh-ghost-edge',
        style: { 'line-color': focus, 'target-arrow-color': focus, 'line-style': 'dashed', label: '' } as any,
      },
      { selector: '.eh-hover', style: { 'border-width': 3, 'border-color': focus } as any },
    ];
  }

  /** Brings the cytoscape graph in line with the model, keeping existing positions. */
  sync(map: BrainMap): { added: string[] } {
    const cy = this.cy;
    const added: string[] = [];
    cy.batch(() => {
      const nodeIds = new Set(map.nodes.map((n) => n.id));
      const edgeIds = new Set(map.edges.map((e) => e.id));
      cy.edges().filter((e) => !edgeIds.has(e.id()) && !e.hasClass('eh-preview')).remove();
      cy.nodes().filter((n) => !nodeIds.has(n.id()) && !n.hasClass('eh-ghost-node')).remove();

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
          shape: st.shape,
          size: st.size,
          width: Math.max(st.size, Math.min(longest, 24) * 7 + 24),
          type: n.type ?? '',
        };
        const existing = cy.getElementById(n.id);
        if (existing.nonempty()) {
          existing.data(data);
          if (n.position) {
            const p = existing.position();
            if (Math.round(p.x) !== Math.round(n.position.x) || Math.round(p.y) !== Math.round(n.position.y))
              existing.animate({ position: n.position, duration: 300 } as any);
          }
        } else {
          added.push(n.id);
          toAdd.push({
            group: 'nodes',
            data,
            position: n.position ?? {
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
   * @param persist save the resulting positions to the file.
   */
  runLayout(map: BrainMap, opts: { persist?: boolean; fit?: boolean } = {}) {
    this.stopLayout();
    this.cy.resize();
    const l: Required<LayoutSettings> = { ...DEFAULT_LAYOUT, ...map.settings.layout };
    const edgeStyles = map.settings.style?.edgeTypes ?? {};
    const lengthOf = (edge: any) => edgeStyles[edge.data('type')]?.length ?? l.edgeLength;
    const fit = opts.fit ?? true;
    const visible = this.cy.elements().not('.hidden');
    const anim = { animate: l.animate, animationDuration: 600, animationEasing: 'ease-in-out-cubic', fit, padding: 40 };

    let eles = visible;
    let options: any;
    switch (l.name) {
      case 'force':
        options = {
          name: 'cola',
          animate: true,
          infinite: l.live,
          // Fitting on every tick would fight the user's zoom in live mode.
          fit: fit && !l.live,
          padding: 40,
          randomize: false,
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
      case 'preset':
      default: {
        const positions = new Map(map.nodes.filter((n) => n.position).map((n) => [n.id, n.position!]));
        options = { name: 'preset', ...anim, positions: (n: NodeSingular) => positions.get(n.id()) ?? n.position() };
      }
    }

    const layout = eles.layout(options);
    this.layout = layout;
    if (opts.persist) {
      if (l.name === 'force' && l.live) this.schedulePositionSave(3000);
      else layout.one('layoutstop', () => this.schedulePositionSave(50));
    }
    layout.run();
    if (fit && l.name === 'force' && l.live) window.setTimeout(() => this.layout === layout && this.fit(), 1200);
  }

  private schedulePositionSave(delay: number) {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.cb.onPositions(this.positions()), delay);
  }

  positions(): Record<string, Position> {
    const out: Record<string, Position> = {};
    this.cy.nodes().forEach((n) => {
      if (n.hasClass('eh-ghost-node')) return;
      const p = n.position();
      out[n.id()] = { x: Math.round(p.x), y: Math.round(p.y) };
    });
    return out;
  }

  setConnectMode(on: boolean) {
    this.connectMode = on;
    if (on) this.eh.enableDrawMode();
    else this.eh.disableDrawMode();
    this.cy.elements().removeClass('faded hover');
  }

  select(ids: string[], center = false) {
    this.cy.batch(() => {
      this.cy.$(':selected').unselect();
      ids.forEach((id) => this.cy.getElementById(id).select());
    });
    if (center && ids.length) {
      const eles = this.cy.collection(ids.map((id) => this.cy.getElementById(id)) as any);
      this.cy.animate({ center: { eles }, zoom: Math.max(this.cy.zoom(), 1) } as any, { duration: 400 });
    }
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
