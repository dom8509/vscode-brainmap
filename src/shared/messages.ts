import { BrainMap, FileFormat } from './model';

/** Messages sent from the extension host to the webview. */
export type HostMessage =
  | { type: 'load'; map: BrainMap; format: FileFormat }
  | { type: 'error'; message: string };

/** Messages sent from the webview to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; map: BrainMap }
  | { type: 'notify'; level: 'info' | 'error'; message: string };
