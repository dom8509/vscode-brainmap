# BrainMap Graph Editor for VS Code

Create and edit graphs visually. Every `*.brainmap` file opens automatically in a graph editor.
The file stays plain **YAML or JSON**, so it diffs nicely in git.

Built on [Cytoscape.js](https://js.cytoscape.org/) with animated layouts
(cola physics, fCoSE, dagre) – with *live physics* the neighbours follow while you drag a node.

## Features

- **Cards** – every node is a card with an icon (picked from its type name), its type and tags.
- **Groups** – soft colored areas around nodes of the same type (`G` or the *Groups* button).
- **Focus** – select a node: everything else fades and its connections flow (`F` or *Focus*).
- **Zoom out** – cards turn into colored blocks and groups show big names. A minimap sits in the corner.
- **Start** – an empty graph shows a big **+** (or press `Enter`) and three starter templates.
- **Type on the canvas** – new nodes open with their name ready to type.
  `#tag` adds a tag, `:type` sets the type, e.g. `Shipping #core :service`.
  `Tab` makes a child, `Enter` a sibling. `F2` or double-click renames.
- **Drag to connect** – drag a node onto another one and let go. Number keys pick the
  connection type while you drag. The dragged node springs back.
- **Connect with node…** – right-click a node, the *Connect…* button or `C`: type part of
  another node's name, pick it (↑/↓, Enter) and the direction (→ to it, ← from it, ↔ both).
- **Two selected nodes** (Ctrl/Shift+click) – connect them from the edit window or right-click.
- **Edit window** – floats next to the selection: name, type pills, tags, connections, actions.
  For a connection: direction (one-way / two-way / reverse), type, tags and label.
  Drag it by its header to park it; ⌖ attaches it again.
- **Delete** – right-click → Delete, or `Backspace`/`Del`. You are always asked first.
  Deleting a node also deletes all its connections.
- **View follows the selection** (⚙ → Layout → "Center view on the selected node").
- **Layouts** – *Physics* (cytoscape-cola, neighbours follow while you drag) and *Hierarchy*
  (dagre, rounded right-angle connections) in the toolbar; more under *More…*.
  Positions are not saved: the layout arranges the graph each time the file opens.
- **Hierarchy by dependency type** – pick which connection types build the hierarchy.
- **Proximity, styling and slices** – in ⚙ settings: spacing, edge length per connection type,
  colors by type or tag, and saved slices (filter by type, tag, connection type, neighbourhood).
- **Keys** – `Tab` child · `Enter` sibling · `C` connect · `F` focus · `G` groups ·
  `Shift+F` fit · `L` layout · `Ctrl+K` search · `Backspace` delete · `Esc` deselect · `Ctrl+Z` undo.
- To see the raw YAML/JSON use VS Code's own *Reopen Editor With… → Text Editor*.
  Changes in either view sync both ways.

## File format

Format is detected from the content: a file starting with `{` is JSON, everything else YAML.
The format is kept when saving. New files use the `brainmap.defaultFormat` setting (`yaml` by default).

```yaml
title: Example
settings:
  layout:
    name: hierarchy            # force | fcose | hierarchy | breadthfirst | concentric | circle | grid
    hierarchyEdgeTypes: [depends-on]
    direction: TB              # TB | BT | LR | RL
    nodeSpacing: 40
    edgeLength: 120
    live: true                 # force layout (cola) keeps running
    followSelection: true      # center the view on the selected node
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
edges:
  - id: e1
    source: web                # "from"/"to" are accepted too
    target: gateway
    type: depends-on
    tags: [sync]
    directed: false            # two-way (↔). Leave out for one-way (→)
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
