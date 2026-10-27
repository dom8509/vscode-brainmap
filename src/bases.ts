// The notes of the workspace, from the Bases extension (dom8509.vscode-bases).
// Bases indexes the Markdown files and keeps a cache; BrainMap reads the same
// index instead of keeping its own. The shape is Bases' BasesApi (src/host/api.ts there).

import * as vscode from 'vscode';
import { NoteFile } from './shared/notes';

export const BASES_ID = 'dom8509.vscode-bases';

export interface BasesApi {
  readonly version: number;
  ready(): Promise<void>;
  scanned(): Promise<void>;
  files(): NoteFile[];
  readonly onDidChange: vscode.Event<void>;
}

let api: Promise<BasesApi> | undefined;

/** Activates Bases once and returns its API; rejects with a message for the user when it is missing. */
export function bases(): Promise<BasesApi> {
  api ??= (async () => {
    const ext = vscode.extensions.getExtension<BasesApi>(BASES_ID);
    if (!ext) throw new Error('A .brainview needs the Bases extension (dom8509.vscode-bases). Install it and reload the window.');
    const exported = await ext.activate();
    if (!exported || typeof exported.files !== 'function') throw new Error('The Bases extension is too old for .brainview files. Update it and reload the window.');
    return exported;
  })();
  api.catch(() => (api = undefined));
  return api;
}
