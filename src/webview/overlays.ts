import { Position } from '../shared/model';
import { h } from './dom';

export type MenuItem =
  | { label: string; action: () => void; danger?: boolean; hint?: string }
  | 'separator';

/** A right-click menu at a screen position. Closes on outside click, Esc or scroll. */
export class ContextMenu {
  private el = h('div', { class: 'context-menu hidden', role: 'menu' });

  constructor(parent: HTMLElement) {
    parent.append(this.el);
    const close = (e: Event) => {
      if (!this.el.contains(e.target as Node)) this.hide();
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('wheel', () => this.hide(), true);
    window.addEventListener('blur', () => this.hide());
  }

  get open() {
    return !this.el.classList.contains('hidden');
  }

  show(items: MenuItem[], at: Position) {
    this.el.replaceChildren(
      ...items.map((item) =>
        item === 'separator'
          ? h('div', { class: 'separator' })
          : h(
              'button',
              {
                class: item.danger ? 'item danger' : 'item',
                role: 'menuitem',
                onclick: () => {
                  this.hide();
                  item.action();
                },
              },
              h('span', {}, item.label),
              item.hint && h('span', { class: 'hint' }, item.hint),
            ),
      ),
    );
    this.el.classList.remove('hidden');
    // Keep the menu inside the window.
    const { width, height } = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.min(at.x, window.innerWidth - width - 4)}px`;
    this.el.style.top = `${Math.min(at.y, window.innerHeight - height - 4)}px`;
    (this.el.querySelector('button') as HTMLButtonElement | null)?.focus();
  }

  hide() {
    this.el.classList.add('hidden');
  }
}

/** Modal yes/no dialog. Enter confirms, Esc cancels. */
export function confirmDialog(parent: HTMLElement, message: string, okLabel = 'Delete', detail?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      overlay.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const ok = h('button', { class: 'primary danger-solid', onclick: () => done(true) }, okLabel);
    const overlay = h(
      'div',
      { class: 'modal-backdrop', onmousedown: (e: Event) => e.target === overlay && done(false) },
      h(
        'div',
        { class: 'modal', role: 'dialog' },
        h('div', { class: 'modal-title' }, message),
        detail && h('p', {}, detail),
        h('div', { class: 'row end' }, h('button', { onclick: () => done(false) }, 'Cancel'), ok),
      ),
    );
    parent.append(overlay);
    window.addEventListener('keydown', onKey, true);
    ok.focus();
  });
}

/** Editable list of tags shown as chips, with an input to add more. */
export function tagEditor(tags: string[], onchange: (tags: string[]) => void, listId: string): HTMLElement {
  const wrap = h('div', { class: 'tags' });
  const render = () => {
    const input = h('input', {
      class: 'tag-input',
      placeholder: tags.length ? '+ tag' : 'add tag…',
      list: listId,
      onkeydown: (e: KeyboardEvent) => {
        const value = input.value.trim().replace(/,$/, '');
        if ((e.key === 'Enter' || e.key === ',') && value) {
          e.preventDefault();
          add(value);
        } else if (e.key === 'Backspace' && !input.value && tags.length) {
          set(tags.slice(0, -1));
        }
      },
      onchange: () => input.value.trim() && add(input.value.trim()),
    });
    wrap.replaceChildren(
      ...tags.map((t) =>
        h('span', { class: 'chip' }, t, h('button', { class: 'chip-x', title: `Remove ${t}`, onclick: () => set(tags.filter((x) => x !== t)) }, '×')),
      ),
      input,
    );
    return input;
  };
  const set = (next: string[]) => {
    tags = next;
    onchange(tags);
    render().focus();
  };
  const add = (value: string) => {
    if (!tags.includes(value)) set([...tags, value]);
    else render().focus();
  };
  render();
  return wrap;
}

export interface PickOption {
  id: string;
  label: string;
  detail?: string;
}

export type Direction = 'out' | 'in' | 'both';

/**
 * Small search box with suggestions to pick a node by name.
 * Arrow keys move through the list, Enter picks, Esc cancels.
 */
export function pickNode(
  at: Position,
  from: string,
  options: PickOption[],
): Promise<{ id: string; direction: Direction } | undefined> {
  return new Promise((resolve) => {
    let direction: Direction = 'out';
    let active = 0;
    let matches: PickOption[] = [];

    const done = (result?: { id: string; direction: Direction }) => {
      box.remove();
      window.removeEventListener('mousedown', outside, true);
      resolve(result);
    };
    const outside = (e: Event) => {
      if (!box.contains(e.target as Node)) done();
    };

    const input = h('input', { class: 'picker-input', placeholder: 'Type a node name…', autocomplete: 'off', spellcheck: false });
    const list = h('div', { class: 'picker-list', role: 'listbox' });
    const dirButtons = (['out', 'in', 'both'] as Direction[]).map((d) =>
      h('button', {
        title: d === 'out' ? `${from} → other` : d === 'in' ? `other → ${from}` : 'Both ways',
        onclick: () => {
          direction = d;
          dirButtons.forEach((b, i) => b.classList.toggle('active', ['out', 'in', 'both'][i] === d));
          input.focus();
        },
      }, d === 'out' ? '→' : d === 'in' ? '←' : '↔'),
    );
    dirButtons[0].classList.add('active');

    const render = () => {
      const q = input.value.trim().toLowerCase();
      // Names that start with the query come first, then names that contain it.
      const score = (o: PickOption) => {
        const l = o.label.toLowerCase();
        if (!q) return 1;
        if (l.startsWith(q)) return 0;
        if (l.includes(q) || o.id.toLowerCase().includes(q)) return 1;
        return -1;
      };
      matches = options
        .map((o) => ({ o, s: score(o) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s || a.o.label.localeCompare(b.o.label))
        .slice(0, 50)
        .map((x) => x.o);
      active = Math.min(active, Math.max(0, matches.length - 1));
      list.replaceChildren(
        ...(matches.length
          ? matches.map((o, i) =>
              h('div', {
                class: i === active ? 'picker-item active' : 'picker-item',
                role: 'option',
                onmousedown: (e: Event) => {
                  e.preventDefault();
                  done({ id: o.id, direction });
                },
              }, h('span', {}, o.label), o.detail && h('span', { class: 'hint' }, o.detail)),
            )
          : [h('div', { class: 'picker-empty' }, 'No matching node')]),
      );
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    };

    input.addEventListener('input', () => {
      active = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') active = Math.min(active + 1, matches.length - 1);
      else if (e.key === 'ArrowUp') active = Math.max(active - 1, 0);
      else if (e.key === 'Enter') {
        if (matches[active]) done({ id: matches[active].id, direction });
      } else if (e.key === 'Escape') done();
      else return;
      e.preventDefault();
      e.stopPropagation();
      render();
    });

    const box = h('div', { class: 'picker' },
      h('div', { class: 'picker-head' }, h('span', { class: 'title' }, `Connect "${from}" with`), h('div', { class: 'segmented small' }, dirButtons)),
      input,
      list,
    );
    document.body.append(box);
    render();
    const { width, height } = box.getBoundingClientRect();
    box.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - width - 4))}px`;
    box.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - height - 4))}px`;
    window.addEventListener('mousedown', outside, true);
    input.focus();
  });
}
