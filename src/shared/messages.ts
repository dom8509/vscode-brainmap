import { BrainMap, FileFormat, FilterOptions } from './model';

/** Messages sent from the extension host to the webview. */
export type HostMessage =
  | {
      type: 'load';
      map: BrainMap;
      format: FileFormat;
      fileName: string;
      readOnly?: boolean;
      /** For a map the host filtered already: what the global filter editor offers over every node. */
      options?: FilterOptions;
      /** A .brainview: which properties become connections, and which it could pick. */
      links?: LinkSettings;
    }
  | { type: 'error'; message: string }
  | { type: 'ui'; bars: BarSettings };

/** Which bars at the bottom of the canvas show; a VS Code setting, the same for every file. */
export interface BarSettings {
  legend: boolean;
  hints: boolean;
}

/** Which properties of a .brainview's notes become connections. */
export interface LinkSettings {
  /** The chosen properties; undefined: every property that holds a [[link]]. */
  chosen?: string[];
  /** Every property the notes have that could be picked. */
  properties: string[];
}

/** Messages sent from the webview to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; map: BrainMap }
  | { type: 'notify'; level: 'info' | 'error'; message: string }
  /** Open the note behind a node of a .brainview. */
  | { type: 'open'; id: string }
  /** Pick the properties of a .brainview that become connections; undefined: every one with a [[link]]. */
  | { type: 'setLinks'; links?: string[] }
  | { type: 'setBar'; bar: keyof BarSettings; show: boolean };
