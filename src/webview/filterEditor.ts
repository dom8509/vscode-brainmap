import {
  CONJUNCTIONS,
  Conjunction,
  FilterCondition,
  FilterGroup,
  FilterNode,
  FilterProperty,
  FilterScope,
  childrenOf,
  conjunctionOf,
  isGroup,
  makeGroup,
  operatorsFor,
  propertiesFor,
  propertyOf,
} from '../shared/filter';
import { h, select } from './dom';

/**
 * A value field whose list of known values opens on click, as in Bases: all of
 * them at first, then those that contain what is typed. Arrow keys and Enter pick.
 */
function valueInput(value: string, values: string[], numeric: boolean, onchange: (v: string) => void): HTMLElement {
  const input = h('input', { type: numeric ? 'number' : 'text', value, placeholder: values.length ? `value · ${values.length} known` : 'value' });
  if (!values.length) {
    input.addEventListener('input', () => onchange(input.value));
    return input;
  }
  const list = h('div', { class: 'filter-suggest floating-list hidden', role: 'listbox' });
  let shown: string[] = [];
  let active = -1;
  const pick = (v: string) => {
    input.value = v;
    onchange(v);
    close();
  };
  const draw = () => {
    list.replaceChildren(...shown.map((v, i) =>
      h('div', { class: i === active ? 'filter-suggest-item active' : 'filter-suggest-item', role: 'option', title: v,
        onmousedown: (e: Event) => { e.preventDefault(); pick(v); } }, v)));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const open = (all: boolean) => {
    const q = input.value.trim().toLowerCase();
    shown = values.filter((v) => all || !q || v.toLowerCase().includes(q)).slice(0, 300);
    active = -1;
    if (!shown.length) return close();
    // Fixed, so the scrolling panel around it does not cut it off.
    const r = input.getBoundingClientRect();
    Object.assign(list.style, { left: `${r.left}px`, top: `${r.bottom + 2}px`, minWidth: `${r.width}px`, maxHeight: `${Math.max(120, window.innerHeight - r.bottom - 12)}px` });
    if (!list.isConnected) document.body.append(list);
    list.classList.remove('hidden');
    draw();
  };
  const close = () => {
    list.classList.add('hidden');
    list.remove();
  };
  input.addEventListener('focus', () => open(true));
  input.addEventListener('click', () => list.isConnected || open(true));
  input.addEventListener('input', () => {
    onchange(input.value);
    open(false);
  });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (!list.isConnected) {
      if (e.key === 'ArrowDown') open(true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      draw();
    } else if (e.key === 'Enter' && active >= 0) pick(shown[active]);
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  return input;
}

/**
 * Edits a filter tree in place, as the filter menu of Obsidian Bases does: rows of
 * property / operator / value inside groups of all / any / none. Calls onchange
 * with the root group after every change.
 */
export function filterEditor(
  scope: FilterScope,
  value: FilterNode | undefined,
  suggestions: (property: string) => string[],
  onchange: (f: FilterGroup) => void,
  /** More properties to offer, e.g. the keys of the nodes' data. */
  extra: FilterProperty[] = [],
): HTMLElement {
  const propOf = (id: string) => propertyOf(scope, id, extra);
  const root: FilterGroup = value && isGroup(value) ? value : makeGroup('and', value ? [value] : []);
  const el = h('div', { class: 'filter-editor' });
  const changed = () => onchange(root);
  const rerender = () => {
    el.replaceChildren(group(root, 0));
    changed();
  };

  const setConj = (g: FilterGroup, conj: Conjunction) => {
    const children = childrenOf(g);
    for (const k of ['and', 'or', 'not']) delete (g as any)[k];
    (g as any)[conj] = children;
  };

  const valueControl = (c: FilterCondition) => {
    const prop = propOf(c.property);
    const op = operatorsFor(prop).find((o) => o.op === c.op);
    if (!op?.needsValue) return null;
    if (prop?.choices)
      return select(prop.choices.map((v) => ({ value: v })), c.value, (v) => { c.value = v; changed(); }, { class: 'filter-value' });
    return h('span', { class: 'filter-value' },
      valueInput(c.value ?? '', suggestions(c.property), prop?.kind === 'number', (v) => { c.value = v; changed(); }));
  };

  // The properties by where they come from: the node's own, its data, and (for notes) its file.
  const propertySelect = (c: FilterCondition, onchange: (v: string) => void) => {
    const own = propertiesFor(scope);
    const data = withCurrent(extra, c.property).filter((p) => !own.some((o) => o.id === p.id));
    const groups: [string, FilterProperty[]][] = [
      ['', own],
      ['Properties', data.filter((p) => !p.id.startsWith('data.file.'))],
      ['File', data.filter((p) => p.id.startsWith('data.file.'))],
    ];
    const option = (p: FilterProperty) => h('option', { value: p.id, selected: p.id === c.property }, p.label);
    return h('select', { class: 'filter-prop', title: 'Property', onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) },
      groups.flatMap(([label, props]) => (!props.length ? [] : label ? [h('optgroup', { label }, props.map(option))] : props.map(option))),
    );
  };

  // A property the list does not offer (a data key no node has any more) stays pickable.
  const withCurrent = (list: FilterProperty[], id: string) => (list.some((p) => p.id === id) ? list : [...list, propOf(id) ?? { id, label: id, kind: 'text' as const }]);

  const condition = (c: FilterCondition, remove: () => void) => {
    const prop = propOf(c.property);
    return h('div', { class: 'filter-row' },
      propertySelect(c, (v) => {
        c.property = v;
        const next = propOf(v);
        const ops = operatorsFor(next);
        if (!ops.some((o) => o.op === c.op)) c.op = ops[0].op;
        c.value = next?.choices ? next.choices[0] : undefined;
        rerender();
      }),
      select(operatorsFor(prop).map((o) => ({ value: o.op, label: o.label })), c.op, (v) => {
        c.op = v as FilterCondition['op'];
        rerender();
      }, { class: 'filter-op', title: 'Operator' }),
      valueControl(c),
      h('button', { class: 'filter-x', title: 'Remove filter', 'aria-label': 'Remove filter', onclick: remove }, '×'),
    );
  };

  const group = (g: FilterGroup, depth: number, remove?: () => void): HTMLElement => {
    const children = childrenOf(g);
    const removeChild = (i: number) => () => { children.splice(i, 1); rerender(); };
    const first = propertiesFor(scope)[0];
    return h('div', { class: depth ? 'filter-group nested' : 'filter-group' },
      h('div', { class: 'filter-head' },
        select(CONJUNCTIONS.map((c) => ({ value: c.conj, label: c.label })), conjunctionOf(g), (v) => {
          setConj(g, v as Conjunction);
          rerender();
        }, { class: 'filter-conj', title: 'How the filters combine' }),
        remove && h('button', { class: 'filter-x', title: 'Remove group', 'aria-label': 'Remove group', onclick: remove }, '×'),
      ),
      children.map((c, i) => (isGroup(c) ? group(c, depth + 1, removeChild(i)) : condition(c, removeChild(i)))),
      h('div', { class: 'filter-add' },
        h('button', { class: 'link', onclick: () => {
          children.push({ property: first.id, op: operatorsFor(first)[0].op });
          rerender();
        } }, '+ Add filter'),
        depth < 2 && h('button', { class: 'link', onclick: () => {
          children.push(makeGroup('or', [{ property: first.id, op: operatorsFor(first)[0].op }]));
          rerender();
        } }, '+ Add group'),
      ),
    );
  };

  el.append(group(root, 0));
  return el;
}
