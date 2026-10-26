type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, any>;

/** Tiny hyperscript helper: h('button', { class: 'x', onclick }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function select(
  options: { value: string; label?: string }[],
  value: string | undefined,
  onchange: (v: string) => void,
  attrs: Attrs = {},
) {
  return h(
    'select',
    { ...attrs, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label ?? o.value)),
  );
}

export function datalist(id: string, values: string[]) {
  return h('datalist', { id }, values.map((v) => h('option', { value: v })));
}

/** A group of checkboxes; calls back with the checked values. */
export function checklist(values: string[], checked: string[] = [], onchange: (v: string[]) => void) {
  const set = new Set(checked);
  if (!values.length) return h('div', { class: 'muted' }, 'none defined');
  return h(
    'div',
    { class: 'checklist' },
    values.map((v) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: set.has(v),
          onchange: (e: Event) => {
            if ((e.target as HTMLInputElement).checked) set.add(v);
            else set.delete(v);
            onchange(values.filter((x) => set.has(x)));
          },
        }),
        v,
      ),
    ),
  );
}

export function field(label: string, ...control: Child[]) {
  return h('label', { class: 'field' }, h('span', {}, label), ...control);
}

export function splitList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
