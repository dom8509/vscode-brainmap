import { PALETTE } from '../shared/model';
import { h } from './dom';

export interface Point {
  x: number;
  y: number;
}

let open: Popover | undefined;

/**
 * A small floating box (type list, tag field, settings…). Only one is open at a time.
 * It closes on a click outside, on Esc, or when another one opens.
 */
export class Popover {
  readonly el = h('div', { class: 'popover' });

  constructor(
    at: Point,
    content: HTMLElement[],
    /** `owner`: the element (or a CSS selector for it) that opened the box; clicks on it do not count as outside. */
    private readonly opts: { className?: string; onClose?: () => void; owner?: HTMLElement | string } = {},
  ) {
    open?.close();
    open = this;
    if (opts.className) this.el.classList.add(opts.className);
    this.el.append(...content);
    document.body.append(this.el);
    this.moveTo(at);
    window.addEventListener('mousedown', this.outside, true);
    window.addEventListener('keydown', this.esc, true);
  }

  static get current() {
    return open;
  }

  /** Places the box with its top-left corner at `at` (client coordinates), kept inside the window. */
  moveTo(at: Point) {
    const r = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.max(6, Math.min(at.x, window.innerWidth - r.width - 6))}px`;
    this.el.style.top = `${Math.max(6, Math.min(at.y, window.innerHeight - r.height - 6))}px`;
  }

  set(content: HTMLElement[]) {
    this.el.replaceChildren(...content);
  }

  close() {
    if (open !== this) return;
    open = undefined;
    this.el.remove();
    window.removeEventListener('mousedown', this.outside, true);
    window.removeEventListener('keydown', this.esc, true);
    this.opts.onClose?.();
  }

  private outside = (e: Event) => {
    const t = e.target as Element;
    const owner = this.opts.owner;
    if (this.el.contains(t)) return;
    // A list a field inside opened over the page (e.g. a filter's values) belongs to the popover.
    if (t.closest?.('.floating-list')) return;
    if (typeof owner === 'string' ? t.closest?.(owner) : owner?.contains(t)) return;
    this.close();
  };

  private esc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };
}

/** Point just below an element, for opening a popover from a button. */
export function below(el: Element, gap = 6): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + gap };
}

/** A list of types to pick from, plus a field for a new one. */
export function typeList(opts: {
  types: string[];
  current?: string;
  colorOf: (t: string) => string;
  listId: string;
  placeholder?: string;
  onPick: (t: string | undefined) => void;
}): HTMLElement[] {
  const input = h('input', {
    class: 'pop-input',
    placeholder: opts.placeholder ?? '+ new type',
    list: opts.listId,
    onkeydown: (e: KeyboardEvent) => {
      const v = input.value.trim();
      if (e.key === 'Enter' && v) opts.onPick(v);
    },
  });
  return [
    h('div', { class: 'pop-list' },
      opts.types.map((t) =>
        h('button', { class: t === opts.current ? 'pop-item active' : 'pop-item', onclick: () => opts.onPick(t) },
          h('span', { class: 'dot', style: { background: opts.colorOf(t) } }),
          h('span', { class: 'grow' }, t),
          t === opts.current && h('span', { class: 'check-mark' }, '✓'),
        ),
      ),
      opts.current && h('button', { class: 'pop-item muted', onclick: () => opts.onPick(undefined) }, 'No type'),
    ),
    input,
  ];
}

/**
 * A tag field with suggestions from `known`. Enter takes the best match or creates a new tag.
 * Keeps itself open so several tags can be added in a row.
 */
export function tagPicker(opts: { current: string[]; known: string[]; onChange: (tags: string[]) => void }): HTMLElement {
  let current = [...opts.current];
  let query = '';
  let active = 0;
  const root = h('div', { class: 'tag-picker' });
  const field = h('div', { class: 'tag-field' });
  const input = h('input', { class: 'tag-input', placeholder: '# tag…', 'aria-label': 'Tag', spellcheck: false });
  const list = h('div', { class: 'pop-list' });
  // Chips live in their own box: re-adding the input would move it in the DOM and drop its focus.
  const chips = h('span', { class: 'tag-chips' });
  field.append(chips, input);
  root.append(field, list);

  const matches = () => {
    const q = query.trim().replace(/^#/, '').toLowerCase();
    return [...new Set(opts.known)]
      .filter((t) => !current.includes(t) && (!q || t.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)) || a.localeCompare(b))
      .slice(0, 6);
  };
  const add = (tag: string) => {
    tag = tag.trim().replace(/^#/, '');
    if (tag && !current.includes(tag)) {
      current = [...current, tag];
      opts.onChange(current);
    }
    query = '';
    input.value = '';
    active = 0;
    render();
    input.focus();
  };
  const render = () => {
    chips.replaceChildren(
      ...current.map((t) =>
        h('span', { class: 'chip' }, t,
          h('button', { class: 'chip-x', 'aria-label': `Remove ${t}`, onclick: () => {
            current = current.filter((x) => x !== t);
            opts.onChange(current);
            render();
            input.focus();
          } }, '×'),
        ),
      ),
    );
    const q = query.trim().replace(/^#/, '');
    const found = matches();
    const isNew = !!q && !opts.known.some((t) => t.toLowerCase() === q.toLowerCase()) && !current.includes(q);
    const items = found.map((t) => ({ label: t, value: t, create: false }));
    if (isNew) items.push({ label: `Create “${q}”`, value: q, create: true });
    active = Math.min(active, Math.max(0, items.length - 1));
    list.replaceChildren(
      ...(items.length
        ? items.map((it, i) =>
            h('button', {
              class: i === active && q ? 'pop-item active' : 'pop-item',
              onmousedown: (e: Event) => {
                e.preventDefault();
                add(it.value);
              },
            }, h('span', { class: 'muted' }, it.create ? '+' : '#'), it.label),
          )
        : [h('div', { class: 'pop-empty' }, current.length ? 'Type to add another tag' : 'Type a tag, Enter adds it')]),
    );
    (root as any).items = items;
  };
  input.addEventListener('input', () => {
    query = input.value;
    active = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    const items: { value: string }[] = (root as any).items ?? [];
    if (e.key === 'ArrowDown') active = Math.min(active + 1, items.length - 1);
    else if (e.key === 'ArrowUp') active = Math.max(active - 1, 0);
    else if (e.key === 'Enter') {
      const q = query.trim();
      if (items[active] && q) add(items[active].value);
      else if (q) add(q);
    } else if (e.key === 'Backspace' && !input.value && current.length) {
      current = current.slice(0, -1);
      opts.onChange(current);
    } else return;
    e.preventDefault();
    render();
  });
  render();
  requestAnimationFrame(() => input.focus());
  return root;
}

/** Color swatches; `undefined` means "use the type/tag color". */
export function colorSwatches(current: string | undefined, onPick: (c: string | undefined) => void): HTMLElement[] {
  return [
    h('div', { class: 'swatches' },
      PALETTE.map((c) =>
        h('button', {
          class: c.toLowerCase() === current?.toLowerCase() ? 'swatch active' : 'swatch',
          style: { background: c },
          'aria-label': `Color ${c}`,
          onclick: () => onPick(c),
        }),
      ),
    ),
    h('div', { class: 'row' },
      h('input', { type: 'color', value: current ?? PALETTE[0], 'aria-label': 'Custom color', onchange: (e: Event) => onPick((e.target as HTMLInputElement).value) }),
      h('span', { class: 'muted small grow' }, 'Custom'),
      current && h('button', { class: 'link-btn', onclick: () => onPick(undefined) }, 'Use type color'),
    ),
  ];
}

/** A small icon button with a styled tooltip that names it and its shortcut. */
export function barButton(icon: Node, label: string, key: string | undefined, onclick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `bar-btn tipped ${cls}`, 'aria-label': label, onclick },
    icon,
    h('span', { class: 'tip' }, label, key && h('kbd', {}, key)),
  );
}
