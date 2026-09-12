/** Reattach compiler-owned bindings after the normal HTML sanitizer; never allow them in exports. */
export function copyEditingBindings(source: Element, destination: Element) {
  for (const element of [source, ...source.querySelectorAll("[data-op-node], [data-op-source], [data-op-field]")]) {
    const path: number[] = []; let current: Element = element;
    while (current !== source && current.parentElement) { path.unshift([...current.parentElement.children].indexOf(current)); current = current.parentElement; }
    const target = path.reduce<Element | undefined>((parent, index) => parent?.children[index], destination);
    if (!target || target.tagName !== element.tagName) throw new Error("当前模板的编辑绑定无法定位，请使用文稿编辑栏");
    for (const name of ["data-op-node", "data-op-source", "data-op-field"]) { const value = element.getAttribute(name); if (value !== null) target.setAttribute(name, value); }
  }
}
