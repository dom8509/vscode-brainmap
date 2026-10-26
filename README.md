# BrainMap Graph Editor for VS Code

Create and edit graphs visually. Every `*.brainmap` file opens automatically in a graph editor.
The file stays plain **YAML or JSON**, so it diffs nicely in git.

Built on [Cytoscape.js](https://js.cytoscape.org/) with animated layouts
(cola physics, fCoSE, dagre) – with *live physics* the neighbours follow while you drag a node.

## Features

- **Edit in the UI** – add nodes (double-click / `N`), connect nodes (`E` + drag), delete (`Del`),
  edit label, id, type, tags, color and description in the inspector. Undo/redo with `Ctrl+Z` / `Ctrl+Y`.
- **Layouts** – force (live physics), fCoSE, hierarchy (dagre), tree, concentric, circle, grid, manual.
- **Hierarchy by dependency type** – pick which edge types (e.g. `depends-on`, `part-of`) build the hierarchy.
  Edges of other types are still drawn, or can be hidden.
- **Proximity** – node spacing, edge length and a preferred length per dependency type
  (smaller = connected nodes stay closer).
- **Styling** – color nodes by type or by tag; per type: color, shape, size; per tag: color;
  per edge type: color, line style. A node's own `color` always wins.
- **Slices** – saved views of a part of the graph: filter by node type, tag, edge type and/or
  the neighbourhood of start nodes (downstream / upstream / both, max depth). Nodes outside a slice are hidden or dimmed.
- **Search** – type to highlight, `Enter` to jump to matches.
- `{ } Text` opens the raw file next to the graph. Changes in either view sync both ways.

## File format

Format is detected from the content: a file starting with `{` is JSON, everything else YAML.
The format is kept when saving. New files use the `brainmap.defaultFormat` setting (`yaml` by default).

```yaml
title: Example
settings:
  layout:
    name: hierarchy            # force | fcose | hierarchy | breadthfirst | concentric | circle | grid | preset
    hierarchyEdgeTypes: [depends-on]
    direction: TB              # TB | BT | LR | RL
    nodeSpacing: 40
    edgeLength: 120
    live: true                 # force layout keeps running
  style:
    colorBy: type              # type | tag | none
    nodeTypes:
      service: { color: '#59a14f', shape: round-rectangle, size: 40 }
    tags:
      critical: { color: '#e15759' }
    edgeTypes:
      depends-on: { color: '#76b7b2', lineStyle: solid, length: 120 }
  slices:
    - name: Backend
      nodeTypes: [service, database]
    - name: Web app dependencies
      roots: [web]
      edgeTypes: [depends-on]
      direction: downstream    # downstream | upstream | both
      depth: 2
  activeSlice: Backend
  sliceMode: hide              # hide | dim
nodes:
  - id: web
    label: Web App
    type: app
    tags: [critical]
    description: Free text
    position: { x: 0, y: 0 }   # written by the editor
edges:
  - id: e1
    source: web                # "from"/"to" are accepted too
    target: gateway
    type: depends-on
    label: optional
```

See [`examples/architecture.brainmap`](examples/architecture.brainmap).

## Development

```sh
npm install
npm run build      # bundle extension + webview into dist/
npm test           # unit tests for parsing, slices and styles
npm run package    # build a .vsix
```

Press `F5` in VS Code to start an Extension Development Host with the `examples` folder.

Install the built package with `code --install-extension vscode-brainmap-0.1.0.vsix`.
