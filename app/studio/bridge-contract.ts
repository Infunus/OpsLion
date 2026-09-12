import { z } from "zod";
import { pageFormatSchema, pageProperties, type PageFormat } from "./page-format";
import { safeLinkUrl, sanitizeArticleHtml } from "./html-policy";

export const sourceLocationSchema = z.object({ module: z.number().int().nonnegative(), cell: z.number().int().nonnegative(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict();
export const captureSourceSchema = z.object({
  url: z.string().max(4000).transform(safeLinkUrl), paperId: z.string().regex(/^\d+$/).optional(), capturedAt: z.string().max(50),
  pageFormat: pageFormatSchema.optional(),
  modules: z.array(z.object({ index: z.number().int().nonnegative(), cells: z.array(z.string()) })).max(5000),
  nativeModuleHashes: z.array(z.string().regex(/^[a-f\d]{64}$/)).max(5000).optional(),
}).strict();
export type CaptureSource = z.infer<typeof captureSourceSchema>;
export type SourceLocation = z.infer<typeof sourceLocationSchema>;
export interface NativeModule { id: string; html: string }
export interface NativeArticle { modules: NativeModule[]; pageFormat: PageFormat }
export interface BridgeAsset { id: string; src: string; kind: "image" | "background"; occurrences: number; status: "embedded" | "remote" | "local"; bytes: number }

export function collectBridgeAssets(html: string): BridgeAsset[] {
  const holder = document.createElement("template"); holder.innerHTML = html;
  const assets = new Map<string, BridgeAsset>();
  const add = (src: string, kind: BridgeAsset["kind"]) => {
    if (!src || src.startsWith("#")) return;
    const previous = assets.get(src);
    if (previous) { previous.occurrences++; return; }
    const status = /^data:/i.test(src) ? "embedded" : /^https?:\/\//i.test(src) ? "remote" : "local";
    assets.set(src, { id: `asset-${assets.size + 1}`, src, kind, occurrences: 1, status, bytes: status === "embedded" ? Math.ceil((src.split(",")[1]?.length ?? 0) * .75) : 0 });
  };
  for (const element of holder.content.querySelectorAll("*")) {
    if (element.tagName === "IMG") add(element.getAttribute("src") || "", "image");
    if (element.namespaceURI === "http://www.w3.org/2000/svg" && element.localName === "image") add(element.getAttribute("href") || element.getAttribute("xlink:href") || "", "image");
    for (const match of (element.getAttribute("style") || "").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(match[1], "background");
  }
  return [...assets.values()];
}

/** Split at known module boundaries, retaining ancestor shells and outside decorations once. */
export function partitionNativeArticle(root: HTMLElement, targets: Element[], format?: PageFormat): NativeArticle {
  if (!targets.length) targets = [root];
  const indexes = new Map(targets.map((target, index) => [target, index]));
  let current = 0;
  const split = (node: Node): Map<number, Node> => {
    if (node instanceof Element && indexes.has(node)) { current = indexes.get(node)!; return new Map([[current, node.cloneNode(true)]]); }
    if (!node.childNodes.length) return new Map([[current, node.cloneNode(false)]]);
    const pieces = new Map<number, Node>();
    for (const child of node.childNodes) for (const [index, piece] of split(child)) {
      if (!pieces.has(index)) pieces.set(index, node.cloneNode(false));
      pieces.get(index)!.appendChild(piece);
    }
    return pieces;
  };
  const styles = format?.styles ?? Object.fromEntries(pageProperties.map((property) => [property, root.style.getPropertyValue(property)]).filter(([, value]) => value));
  const modules = [...split(root)].map(([index, node]) => {
    const element = node as HTMLElement;
    // These are applied once to Xiumi's native page, not repeated on every module.
    for (const property of pageProperties) element.style.removeProperty(property);
    for (const item of [element, ...element.querySelectorAll("*")]) for (const attribute of [...item.attributes]) if (/^data-(?:op-|layout-)/.test(attribute.name)) item.removeAttribute(attribute.name);
    return { id: `module-${index + 1}`, html: element.outerHTML };
  });
  // Sanitize the complete set once so independent modules keep unique SVG IDs.
  const cleaned = document.createElement("template"); cleaned.innerHTML = sanitizeArticleHtml(modules.map((module) => module.html).join(""));
  if (cleaned.content.children.length !== modules.length) throw new Error("模块清理改变了顶层结构，请检查母版根元素");
  return { modules: modules.map((module, index) => ({ ...module, html: cleaned.content.children[index].outerHTML })), pageFormat: { ...format, styles } };
}

export function nativeArticleFromHtml(html: string, format?: PageFormat): NativeArticle {
  const holder = document.createElement("div"); holder.innerHTML = sanitizeArticleHtml(html);
  let root = holder.children.length === 1 ? holder.firstElementChild as HTMLElement : holder;
  if (root.namespaceURI !== "http://www.w3.org/1999/xhtml") {
    const wrapper = document.createElement("section"); wrapper.append(root); root = wrapper;
  }
  const native = [...root.querySelectorAll(".tn-comp-top-level")].filter((element) => !element.parentElement?.closest(".tn-comp-top-level"));
  return partitionNativeArticle(root, native.length ? native : root.children.length ? [...root.children] : [root], format);
}
