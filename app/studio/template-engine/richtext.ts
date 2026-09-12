import type { RichText } from "./types";

export function plainRichText(value: string): RichText {
  return value.replace(/\r\n?/g, "\n").split("\n").flatMap((text, index) => index ? [{ break: true as const }, { text }] : [{ text }]);
}
export function richTextToPlain(value: RichText): string {
  return value.map((part) => "text" in part ? part.text : "break" in part ? "\n" : part.content.map((run) => run.text).join("")).join("");
}
export function renderRichText(doc: Document, value: RichText): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const renderRun = (run: { text: string; marks?: string[]; color?: string }): Node => {
    const text = doc.createDocumentFragment();
    run.text.replace(/\r\n?/g, "\n").split("\n").forEach((line, index) => { if (index) text.append(doc.createElement("br")); text.append(doc.createTextNode(line)); });
    let node: Node = text;
    for (const [mark, tag] of [["bold", "strong"], ["italic", "em"], ["underline", "u"], ["strike", "s"]]) {
      if (!run.marks?.includes(mark)) continue;
      const wrapper = doc.createElement(tag);
      if (mark === "bold") wrapper.style.fontWeight = "700";
      if (mark === "italic") wrapper.style.fontStyle = "italic";
      if (mark === "underline") wrapper.style.textDecoration = "underline";
      if (mark === "strike") wrapper.style.textDecoration = "line-through";
      wrapper.append(node); node = wrapper;
    }
    if (run.color) { const span = doc.createElement("span"); span.style.color = run.color; span.append(node); node = span; }
    return node;
  };
  for (const part of value) {
    if ("text" in part) fragment.append(renderRun(part));
    else if ("break" in part) fragment.append(doc.createElement("br"));
    else { const link = doc.createElement("a"); link.href = part.href; link.style.cssText = "color:inherit;text-decoration:underline;"; part.content.forEach((run) => link.append(renderRun(run))); fragment.append(link); }
  }
  return fragment;
}
