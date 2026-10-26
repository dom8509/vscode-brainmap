import * as vscode from 'vscode';
import { detectFormat, parse, serialize } from './shared/format';
import { FileFormat, emptyMap } from './shared/model';
import { HostMessage, WebviewMessage } from './shared/messages';

const VIEW_TYPE = 'brainmap.graphEditor';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new BrainMapEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('brainmap.newFile', newFile),
    vscode.commands.registerCommand('brainmap.openAsText', (uri?: vscode.Uri) =>
      reopenWith(uri, 'default'),
    ),
    vscode.commands.registerCommand('brainmap.openGraphEditor', (uri?: vscode.Uri) =>
      reopenWith(uri, VIEW_TYPE),
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

class BrainMapEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webview.html = this.html(webview);

    const defaultFormat = vscode.workspace
      .getConfiguration('brainmap')
      .get<FileFormat>('defaultFormat', 'yaml');
    // Text we wrote ourselves; used to skip echoing our own edits back to the webview.
    let lastWritten: string | undefined;

    const post = (msg: HostMessage) => webview.postMessage(msg);
    const sendDocument = () => {
      const text = document.getText();
      try {
        post({ type: 'load', map: parse(text), format: detectFormat(text, defaultFormat) });
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
      switch (msg.type) {
        case 'ready':
          sendDocument();
          break;
        case 'edit': {
          const text = document.getText();
          const next = serialize(msg.map, detectFormat(text, defaultFormat));
          if (next === text) return;
          lastWritten = next;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), next);
          await vscode.workspace.applyEdit(edit);
          break;
        }
        case 'notify':
          if (msg.level === 'error') vscode.window.showErrorMessage(msg.message);
          else vscode.window.showInformationMessage(msg.message);
          break;
      }
    });
  }

  private html(webview: vscode.Webview): string {
    const asset = (...p: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
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
}
