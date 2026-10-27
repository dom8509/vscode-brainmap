import { BrainMap, FileFormat } from './model';

/** Messages sent from the extension host to the webview. */
export type HostMessage =
  | { type: 'load'; map: BrainMap; format: FileFormat; fileName: string }
  | { type: 'error'; message: string }
  | { type: 'ui'; bars: BarSettings };

/** Which bars at the bottom of the canvas show; a VS Code setting, the same for every file. */
export interface BarSettings {
  legend: boolean;
  hints: boolean;
}

/** Messages sent from the webview to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; map: BrainMap }
  | { type: 'notify'; level: 'info' | 'error'; message: string }
  | { type: 'setBar'; bar: keyof BarSettings; show: boolean };
