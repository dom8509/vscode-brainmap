import * as yaml from 'js-yaml';
import { BrainMap, FileFormat, emptyMap, normalize } from './model';

export function detectFormat(text: string, fallback: FileFormat = 'yaml'): FileFormat {
  const t = text.trimStart();
  if (!t) return fallback;
  return t.startsWith('{') ? 'json' : 'yaml';
}

export function parse(text: string): BrainMap {
  if (!text.trim()) return emptyMap();
  const raw = detectFormat(text) === 'json' ? JSON.parse(text) : yaml.load(text);
  return normalize(raw);
}

/** Removes undefined values, empty arrays/objects and rounds positions to keep files tidy. */
function clean(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => clean(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0 && k !== 'nodes' && k !== 'edges') continue;
      const c = clean(v, k);
      if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out;
  }
  if (typeof value === 'number' && (key === 'x' || key === 'y')) return Math.round(value);
  if (value === '' && key !== 'label') return undefined;
  return value;
}

export function serialize(map: BrainMap, format: FileFormat): string {
  const data = clean({
    version: map.version,
    title: map.title,
    settings: map.settings,
    nodes: map.nodes,
    edges: map.edges,
  });
  if (format === 'json') return JSON.stringify(data, null, 2) + '\n';
  return yaml.dump(data, { noRefs: true, lineWidth: 120, flowLevel: -1 });
}
