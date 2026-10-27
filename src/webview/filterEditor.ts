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

let listCounter = 0;

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
  const props = [...propertiesFor(scope), ...extra];
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
    const id = `filter-values-${++listCounter}`;
    const values = suggestions(c.property);
    return h('span', { class: 'filter-value' },
      h('input', {
        type: prop?.kind === 'number' ? 'number' : 'text',
        value: c.value ?? '',
        placeholder: 'value',
        list: values.length ? id : undefined,
        oninput: (e: Event) => { c.value = (e.target as HTMLInputElement).value; changed(); },
      }),
      values.length > 0 && h('datalist', { id }, values.map((v) => h('option', { value: v }))),
    );
  };

  // A property the list does not offer (a data key no node has any more) stays pickable.
  const withCurrent = (list: FilterProperty[], id: string) => (list.some((p) => p.id === id) ? list : [...list, propOf(id) ?? { id, label: id, kind: 'text' as const }]);

  const condition = (c: FilterCondition, remove: () => void) => {
    const prop = propOf(c.property);
    return h('div', { class: 'filter-row' },
      select(withCurrent(props, c.property).map((p) => ({ value: p.id, label: p.label })), c.property, (v) => {
        c.property = v;
        const next = propOf(v);
        const ops = operatorsFor(next);
        if (!ops.some((o) => o.op === c.op)) c.op = ops[0].op;
        c.value = next?.choices ? next.choices[0] : undefined;
        rerender();
      }, { class: 'filter-prop', title: 'Property' }),
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
