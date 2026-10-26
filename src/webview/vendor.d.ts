declare module 'cytoscape-cola';
declare module 'cytoscape-fcose';
declare module 'cytoscape-dagre';
declare module 'cytoscape-edgehandles';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T>(state: T): void;
};
