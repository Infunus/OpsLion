import { duplicateTemplateModule } from "../template-clone";
import { makeId, type CloneTemplateState } from "../types";
import type { Submission } from "../submission/types";

export const nativeBasics = { title: "标题", paragraph: "正文", divider: "分割线", image: "图片" };
export type NativeBasic = keyof typeof nativeBasics;
const find = (doc: Document, id: string) => doc.querySelector(`[data-layout-module="${CSS.escape(id)}"]`);

/** Place only at module boundaries; never move content into SVG internals. */
export function placeNativeModule(state: CloneTemplateState, id: string, anchor: string | null, position: "before" | "after") {
  if (!anchor || id === anchor) return state;
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const element = find(doc, id); const target = find(doc, anchor);
  if (!element || !target || element.contains(target)) throw new Error("插入位置已变化，请重新选择模块");
  if (target.parentElement?.namespaceURI !== "http://www.w3.org/1999/xhtml") throw new Error("请选择完整的图文模块作为插入位置");
  target.insertAdjacentElement(position === "before" ? "beforebegin" : "afterend", element);
  const modules = state.modules.filter((module) => module.id !== id); const moved = state.modules.find((module) => module.id === id)!;
  modules.splice(modules.findIndex((module) => module.id === anchor) + (position === "after" ? 1 : 0), 0, moved);
  return { ...state, analyzedHtml: doc.body.innerHTML, modules };
}

export function insertNativeModule(state: CloneTemplateState, kind: NativeBasic | string, anchor: string | null, position: "before" | "after", src = ""): { state: CloneTemplateState; id: string } {
  if (!(kind in nativeBasics)) {
    const next = duplicateTemplateModule(state, kind);
    const id = next.modules.find((module) => !state.modules.some((old) => old.id === module.id))?.id;
    if (!id) throw new Error("该模板模块已不存在");
    return { state: placeNativeModule(next, id, anchor ?? state.modules.at(-1)?.id ?? null, anchor ? position : "after"), id };
  }
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const id = makeId("module"); const slotId = makeId(kind === "image" ? "image" : "text");
  const element = doc.createElement("section"); element.setAttribute("data-layout-module", id);
  element.style.cssText = "margin:16px 0;max-width:100%;box-sizing:border-box;";
  const child = doc.createElement(kind === "title" ? "h2" : kind === "divider" ? "hr" : kind === "image" ? "img" : "p");
  child.style.cssText = kind === "image" ? "display:block;width:100%;height:auto;" : kind === "divider" ? "border:0;border-top:1px solid #d9dfd9;margin:20px 0;" : `margin:0;line-height:1.8;font-size:${kind === "title" ? 20 : 15}px;`;
  if (kind !== "divider") child.setAttribute("data-layout-slot", slotId);
  if (kind === "image") { if (!src) throw new Error("请选择图片"); child.setAttribute("src", src); child.setAttribute("alt", "文章配图"); }
  element.append(child);
  const last = state.modules.at(-1); const target = anchor ? find(doc, anchor) : last ? find(doc, last.id) : null;
  if (anchor && !target) throw new Error("插入位置已变化，请重新选择模块");
  if (target) target.insertAdjacentElement(position === "before" && anchor ? "beforebegin" : "afterend", element);
  else doc.body.append(element);
  const modules = [...state.modules]; const at = anchor ? modules.findIndex((module) => module.id === anchor) + (position === "after" ? 1 : 0) : modules.length;
  modules.splice(at, 0, { id, label: nativeBasics[kind as NativeBasic], included: true, repeatable: true });
  const slots = [...state.slots];
  if (kind !== "divider") slots.push({ id: slotId, kind: kind === "image" ? "image" : "text", label: nativeBasics[kind as NativeBasic], value: src, originalValue: "", role: kind === "image" ? "content_image" : "content" });
  return { state: { ...state, analyzedHtml: doc.body.innerHTML, modules, slots }, id };
}

/** Native SVG bindings are positional; rebase them when sibling modules move. */
export function rebaseNativeBindings(submission: Submission, previous: CloneTemplateState, next: CloneTemplateState): Submission {
  if (!submission.native_bindings || previous.analyzedHtml === next.analyzedHtml) return submission;
  const before = new DOMParser().parseFromString(previous.analyzedHtml, "text/html");
  const after = new DOMParser().parseFromString(next.analyzedHtml, "text/html");
  const pathTo = (element: Element, root: Element) => {
    const path: number[] = [];
    for (let current = element; current !== root && current.parentElement; current = current.parentElement) path.unshift([...current.parentElement.children].indexOf(current));
    return path;
  };
  const native_bindings = Object.fromEntries(Object.entries(submission.native_bindings).map(([id, binding]) => {
    if (!binding.native_path) return [id, binding];
    const target = binding.native_path.reduce<Element | undefined>((element, index) => element?.children[index], before.body);
    const owner = target?.closest("[data-layout-module]");
    if (!target || !owner) throw new Error("原生交稿的位置无法跟随模块移动，请先完成交稿");
    const movedModule = find(after, owner.getAttribute("data-layout-module")!);
    const moved = pathTo(target, owner).reduce<Element | undefined>((element, index) => element?.children[index], movedModule ?? undefined);
    if (!moved || moved.localName !== target.localName) throw new Error("原生交稿的位置已变化，请先完成交稿");
    return [id, { ...binding, native_path: pathTo(moved, after.body) }];
  }));
  return { ...submission, native_bindings };
}
