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
export function confirmDialog(parent: HTMLElement, message: string, okLabel = 'Delete'): Promise<boolean> {
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
        h('p', {}, message),
        h('div', { class: 'row end' }, h('button', { onclick: () => done(false) }, 'Cancel'), ok),
      ),
    );
    parent.append(overlay);
    window.addEventListener('keydown', onKey, true);
    ok.focus();
  });
}

/**
 * A small window that floats over the graph. It sits next to an anchor point
 * until the user drags it by its header; then it stays where it was dropped.
 */
export class FloatingWindow {
  readonly el = h('div', { class: 'floating hidden' });
  private header = h('div', { class: 'floating-header' });
  readonly body = h('div', { class: 'floating-body' });
  private titleEl = h('span', { class: 'title' });

  constructor(
    private readonly parent: HTMLElement,
    /** User-chosen position, or undefined when attached to the selection. */
    public detached: Position | undefined,
    private readonly onDetach: (pos: Position | undefined) => void,
    onClose: () => void,
  ) {
    this.header.append(
      this.titleEl,
      h('button', { class: 'icon', title: 'Attach to selection', onclick: () => this.setDetached(undefined) }, '⌖'),
      h('button', { class: 'icon', title: 'Close (Esc)', onclick: onClose }, '✕'),
    );
    this.el.append(this.header, this.body);
    this.el.classList.toggle('detached', !!detached);
    parent.append(this.el);
    this.header.addEventListener('mousedown', (e) => this.startDrag(e));
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  show(title: string, content: HTMLElement[]) {
    this.titleEl.textContent = title;
    this.body.replaceChildren(...content);
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
  }

  /** Places the window next to the anchor box (canvas coordinates) unless it was dragged away. */
  place(anchor?: { x1: number; x2: number; y1: number; y2: number }) {
    if (!this.visible) return;
    const pw = this.parent.clientWidth;
    const ph = this.parent.clientHeight;
    const w = this.el.offsetWidth;
    const hgt = this.el.offsetHeight;
    let x: number;
    let y: number;
    if (this.detached) ({ x, y } = this.detached);
    else if (anchor) {
      x = anchor.x2 + 16;
      if (x + w > pw - 8) x = anchor.x1 - w - 16;
      y = (anchor.y1 + anchor.y2) / 2 - 24;
    } else return;
    this.el.style.left = `${Math.max(8, Math.min(x, pw - w - 8))}px`;
    this.el.style.top = `${Math.max(8, Math.min(y, ph - hgt - 8))}px`;
  }

  private setDetached(pos: Position | undefined) {
    this.detached = pos;
    this.el.classList.toggle('detached', !!pos);
    this.onDetach(pos);
  }

  private startDrag(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const startX = e.clientX - this.el.offsetLeft;
    const startY = e.clientY - this.el.offsetTop;
    // No position transition while dragging, so the window sticks to the cursor.
    this.el.classList.add('detached');
    const move = (ev: MouseEvent) => {
      this.detached = { x: ev.clientX - startX, y: ev.clientY - startY };
      this.place();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (this.detached) this.setDetached({ x: parseFloat(this.el.style.left), y: parseFloat(this.el.style.top) });
      else this.el.classList.remove('detached');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
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
