import * as path from 'path';
import * as vscode from 'vscode';
import { BasesApi, bases } from './bases';
import { detectFormat, parse, parseView, serialize, serializeView } from './shared/format';
import { notesToMap } from './shared/notes';
import { FileFormat, applyGlobalFilter, emptyMap, filterOptions } from './shared/model';
import { HostMessage, WebviewMessage } from './shared/messages';

const VIEW_TYPE = 'brainmap.graphEditor';
const NOTES_VIEW_TYPE = 'brainmap.notesView';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new BrainMapEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.window.registerCustomEditorProvider(NOTES_VIEW_TYPE, new NotesViewProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('brainmap.newFile', newFile),
    vscode.commands.registerCommand('brainmap.newView', newView),
    vscode.commands.registerCommand('brainmap.openAsText', (uri?: vscode.Uri) =>
      reopenWith(uri, 'default'),
    ),
    vscode.commands.registerCommand('brainmap.openGraphEditor', (uri?: vscode.Uri) =>
      reopenWith(uri, uri?.path.endsWith('.brainview') || activeUri()?.path.endsWith('.brainview') ? NOTES_VIEW_TYPE : VIEW_TYPE),
    ),
  );
}

export function deactivate() {}

function activeUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText) return tab.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

async function reopenWith(uri: vscode.Uri | undefined, viewType: string) {
  const target = uri ?? activeUri();
  if (target) await vscode.commands.executeCommand('vscode.openWith', target, viewType);
}

async function newFile() {
  const format = vscode.workspace.getConfiguration('brainmap').get<FileFormat>('defaultFormat', 'yaml');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const uri = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, 'graph.brainmap') : undefined,
    filters: { BrainMap: ['brainmap'] },
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serialize(emptyMap(), format)));
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

async function newView() {
  const format = vscode.workspace.getConfiguration('brainmap').get<FileFormat>('defaultFormat', 'yaml');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const uri = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, 'notes.brainview') : undefined,
    filters: { 'BrainMap view': ['brainview'] },
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeView(parseView(''), format)));
  await vscode.commands.executeCommand('vscode.openWith', uri, NOTES_VIEW_TYPE);
}

/** The webview of both editors; `post` sends to it. */
function setUpWebview(context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
  const webview = panel.webview;
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
  };
  webview.html = html(context, webview);
  const post = (msg: HostMessage) => webview.postMessage(msg);
  const sendBars = () => {
    const config = vscode.workspace.getConfiguration('brainmap');
    post({ type: 'ui', bars: { legend: config.get('showLegend', false), hints: config.get('showShortcuts', false) } });
  };
  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('brainmap.showLegend') || e.affectsConfiguration('brainmap.showShortcuts')) sendBars();
  });
  panel.onDidDispose(() => configSub.dispose());
  /** Handles the messages both editors share; false for the others. */
  const common = async (msg: WebviewMessage): Promise<boolean> => {
    switch (msg.type) {
      case 'setBar':
        await vscode.workspace
          .getConfiguration('brainmap')
          .update(msg.bar === 'legend' ? 'showLegend' : 'showShortcuts', msg.show, vscode.ConfigurationTarget.Global);
        return true;
      case 'notify':
        if (msg.level === 'error') vscode.window.showErrorMessage(msg.message);
        else vscode.window.showInformationMessage(msg.message);
        return true;
    }
    return false;
  };
  return { webview, post, sendBars, common };
}

/** Replaces the whole text of a document. */
async function replaceText(document: vscode.TextDocument, next: string) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), next);
  await vscode.workspace.applyEdit(edit);
}

/**
 * A .brainview: the Markdown notes of the workspace as a graph. The notes come
 * from the Bases index and stay read-only here; the file only keeps where they
 * come from and the view's settings (layout, style, slices).
 */
class NotesViewProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const { webview, post, sendBars, common } = setUpWebview(this.context, panel);
    const defaultFormat = vscode.workspace.getConfiguration('brainmap').get<FileFormat>('defaultFormat', 'yaml');
    let lastWritten: string | undefined;
    let api: BasesApi | undefined;
    let basesSub: vscode.Disposable | undefined;
    let timer: NodeJS.Timeout | undefined;
    /** Node id (the note's path) → the note's URI, for opening it. */
    let uris = new Map<string, string>();

    const send = () => {
      if (!api) return;
      const text = document.getText();
      try {
        const files = api.files();
        uris = new Map(files.map((f) => [f.path, f.uri]));
        // Notes outside the global filter never reach the webview.
        const all = notesToMap(files, parseView(text));
        const map = applyGlobalFilter(all);
        post({ type: 'load', map, format: detectFormat(text, defaultFormat), fileName: path.basename(document.uri.path), readOnly: true, options: filterOptions(all) });
      } catch (err) {
        post({ type: 'error', message: `Could not read ${document.fileName}: ${(err as Error).message}` });
      }
    };
    // Bases fires often while it scans; the graph follows a little later.
    const sendSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(send, 300);
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString() || e.contentChanges.length === 0) return;
      if (document.getText() === lastWritten) return;
      send();
    });
    panel.onDidDispose(() => {
      clearTimeout(timer);
      changeSub.dispose();
      basesSub?.dispose();
    });

    webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      if (await common(msg)) return;
      switch (msg.type) {
        case 'ready':
          sendBars();
          try {
            api = await bases();
            await api.ready();
          } catch (err) {
            post({ type: 'error', message: (err as Error).message });
            return;
          }
          basesSub ??= api.onDidChange(sendSoon);
          send();
          break;
        case 'edit': {
          // Only the view's own part goes into the file; the notes stay as they are.
          const text = document.getText();
          const view = parseView(text);
          const filterChanged = JSON.stringify(view.settings.filter) !== JSON.stringify(msg.map.settings.filter);
          view.title = msg.map.title;
          view.settings = msg.map.settings;
          const next = serializeView(view, detectFormat(text, defaultFormat));
          if (next === text) return;
          lastWritten = next;
          await replaceText(document, next);
          // Another global filter loads other notes.
          if (filterChanged) send();
          break;
        }
        case 'open': {
          const uri = uris.get(msg.id);
          if (uri) await vscode.window.showTextDocument(vscode.Uri.parse(uri), { viewColumn: vscode.ViewColumn.Beside, preview: true });
          break;
        }
      }
    });
  }
}

class BrainMapEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const { webview, post, sendBars, common } = setUpWebview(this.context, panel);
    const defaultFormat = vscode.workspace
      .getConfiguration('brainmap')
      .get<FileFormat>('defaultFormat', 'yaml');
    // Text we wrote ourselves; used to skip echoing our own edits back to the webview.
    let lastWritten: string | undefined;

    const sendDocument = () => {
      const text = document.getText();
      try {
        post({ type: 'load', map: parse(text), format: detectFormat(text, defaultFormat), fileName: path.basename(document.uri.path) });
      } catch (err) {
        post({ type: 'error', message: `Could not parse ${document.fileName}: ${(err as Error).message}` });
      }
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString() || e.contentChanges.length === 0) return;
      if (document.getText() === lastWritten) return;
      sendDocument();
    });
    panel.onDidDispose(() => changeSub.dispose());

    webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      if (await common(msg)) return;
      switch (msg.type) {
        case 'ready':
          sendBars();
          sendDocument();
          break;
        case 'edit': {
          const text = document.getText();
          const next = serialize(msg.map, detectFormat(text, defaultFormat));
          if (next === text) return;
          lastWritten = next;
          await replaceText(document, next);
          break;
        }
      }
    });
  }
}

function html(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const asset = (...p: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...p));
  const nonce = Array.from({ length: 32 }, () => Math.random().toString(36)[2]).join('');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${asset('media', 'webview.css')}" rel="stylesheet">
  <title>BrainMap</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
}
