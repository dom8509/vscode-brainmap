# BrainMap Graph Editor for VS Code

Create and edit graphs visually. Every `*.brainmap` file opens automatically in a graph editor.
The file stays plain **YAML or JSON**, so it diffs nicely in git.

Built on [Cytoscape.js](https://js.cytoscape.org/) with animated layouts
(cola physics, fCoSE, dagre) – with *live physics* the neighbours follow while you drag a node.

## Features

- **Cards** – every node is a card with an icon (picked from its type name) and its type.
  Tags stay off the card; the hover card and the details show them.
- **Groups** – soft colored areas around nodes of the same type (`G` or the *Groups* button).
- **Focus** – select a node: everything else fades and its connections flow (`F` or *Focus*).
- **Zoom out** – cards turn into colored blocks and groups show big names. A minimap sits in the corner.
- **Start** – an empty graph shows a big **+** (or press `Enter`) and three starter templates.
- **Type on the canvas** – new nodes open with their name ready to type.
  `#tag` adds a tag, `:type` sets the type, e.g. `Shipping #core :service`.
  `Tab` makes a child, `Enter` a sibling. `F2` or double-click renames.
- **Drag to connect** – drag a node onto another one and let go. Number keys pick the
  connection type while you drag. The dragged node springs back.
- **Hover = read** – rest the mouse on a node for half a second: a card shows its description,
  all tags and how it is connected (`2 in · 3 out`, `depends-on ×3`). No buttons.
- **Select = act** – a small bar above the selection: type ▾, `#` tag (field with suggestions),
  color, `+` child, connect, delete, `⋯` details. Each button has a tooltip with its shortcut.
  A selected connection gets type, tag, one-way/two-way, reverse, delete; two nodes get
  "A → B" and "↔"; more nodes get "type for all", "tag to all" and "save as slice".
- **Right-click = everything** – every action, with words and shortcuts: add child/sibling,
  connect with…, rename, type ▸, color ▸, tags ▸, focus on this, select neighbours,
  slice from here, duplicate, copy id, open details, delete. With two nodes selected the menu
  starts with A → B, B → A and A ↔ B.
- **Connect with…** (`C`) – type part of another node's name, pick it (↑/↓, Enter) and the
  direction (→ to it, ← from it, ↔ both).
- **Details sidebar** (`D`, `⋯` or the *Details* button) – everything about the selection:
  name, type, tags, description, color, id and all connections; for a connection its
  direction, type, tags and label.
- **Toolbar menus** – *Layout ▾* (spacing, edge length, direction, hierarchy types, run/fit),
  *Style ▾* (colors per type, tag and connection type) and *Slices ▾* (saved views).
- **Delete** – right-click → Delete, the bar, or `Backspace`/`Del`. You are always asked first.
  Deleting a node also deletes all its connections.
- **View follows the selection** (Layout ▾ → "Center view on the selected node").
- **Layouts** – *Physics* (cytoscape-cola, neighbours follow while you drag) and *Hierarchy*
  (dagre, rounded right-angle connections) in the toolbar; more under *More…*.
  Positions are not saved: the layout arranges the graph each time the file opens.
- **Hierarchy by dependency type** – pick which connection types build the hierarchy.
- **Proximity, styling and slices** – spacing, edge length per connection type,
  colors by type or tag, and saved slices (filters plus a neighbourhood).
- **Filters** (*Slices ▾* → *+ New slice* or *Edit*) – work like the filters of
  [Bases](https://github.com/dom8509/vscode-bases): a filter is a property, an operator and a value.
  Groups combine filters with *All*, *Any* or *None of the following* and can be nested.
  - Nodes: name, id, type, tags, description, incoming, outgoing, connections
    (e.g. *connections is 0* finds lonely nodes, *incoming ≥ 5* finds hubs).
  - Connections: type, tags, label, direction (one-way / two-way).
    Only kept connections are shown and followed from the start nodes.
  - Operators: is, is not, contains, does not contain, starts with, has, does not have,
    is empty, is not empty, >, ≥, <, ≤. Text compares ignore case.
  - A filter without its value does not filter yet. The editor counts the matches as you type;
    the *Slices* button shows how many nodes the active slice keeps (`6/10`).
- **Keys** – `Tab` child · `Enter` sibling · `C` connect · `#` tag · `T` type · `D` details · `F` focus · `G` groups ·
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
      nodeFilter:              # and | or | not, nested as deep as you like
        and:
          - or:
              - { property: type, op: is, value: service }
              - { property: type, op: is, value: database }
          - { property: tags, op: hasNot, value: legacy }
    - name: Web app dependencies
      roots: [web]
      edgeFilter: { property: type, op: is, value: depends-on }
      direction: downstream    # downstream | upstream | both
      depth: 2
    # Older files with nodeTypes / tags / edgeTypes still work: they are read as filters.
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
