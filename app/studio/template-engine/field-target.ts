/** Preserve an unambiguous inline style shell. Authors bind a leaf for mixed runs. */
export function contentFieldTarget(element: Element, mode: "preserve-shell" | "replace" = "preserve-shell"): HTMLElement {
  if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") throw new Error("可变字段需要 HTML 文本部件；SVG 装饰可保留在字段外部");
  if (mode === "replace") return element as HTMLElement;
  let target = element;
  while (target.children.length) {
    const children = [...target.children];
    // Empty placeholders may contain line breaks, which are content, not a shell.
    if (children.every((child) => child.tagName === "BR")) break;
    const hasOwnText = [...target.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    if (hasOwnText || children.length !== 1 || !/^(SPAN|STRONG|B|EM|I|U|S|SMALL|SUB|SUP|CODE)$/.test(children[0].tagName) || children[0].hasAttribute("data-layout-part") || children[0].hasAttribute("data-layout-slot")) {
      throw new Error("字段包含多个内容或装饰部件，请将绑定移到文本叶节点；需要整体替换时显式设置 mode: replace");
    }
    target = children[0];
  }
  return target as HTMLElement;
}
