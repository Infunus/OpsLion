import { collectBridgeAssets, nativeArticleFromHtml, type NativeArticle } from "./bridge-contract";
import { safeLinkUrl, sanitizeArticleHtml } from "./html-policy";
import { plainTextFromHtml, renderCloneTemplate } from "./renderer";
import { pristineTemplateState } from "./template-clone";
import { compileArticle } from "./template-engine/render";
import type { StudioProject } from "./types";

export function createHtmlBridgePackage(html: string, title: string, native: NativeArticle = nativeArticleFromHtml(html)) {
  html = sanitizeArticleHtml(html);
  const assets = collectBridgeAssets(html);
  const compact = (value: string) => assets.reduce((text, asset) => asset.status === "embedded" ? text.replaceAll(asset.src, `opslion-asset://${asset.id}`) : text, value);
  return {
    schema: "xiumi-bridge/v3" as const, title, html: compact(html), plainText: plainTextFromHtml(html), generatedAt: new Date().toISOString(), native: { modules: native.modules.map((module) => ({ ...module, html: compact(module.html) })), pageFormat: { ...native.pageFormat, styles: Object.fromEntries(Object.entries(native.pageFormat.styles).map(([key, value]) => [key, compact(value)])) } }, assets,
    assetSummary: { embedded: assets.filter((asset) => asset.status === "embedded").length, embeddedBytes: assets.reduce((total, asset) => total + asset.bytes, 0), local: assets.filter((asset) => asset.status === "local").length },
  };
}

/** Bundle app-owned files before download; Xiumi cannot resolve a localhost path. */
export async function resolveLocalBridgeAssets(html: string): Promise<Record<string, string>> {
  const bindings: Record<string, string> = {};
  for (const asset of collectBridgeAssets(html).filter((asset) => asset.status === "local")) {
    if (!/^\/(?:assets\/|local-api\/assets\/proxy\?)/.test(asset.src)) throw new Error("有图片尚未绑定为可导出的素材");
    const response = await fetch(asset.src);
    if (!response.ok) throw new Error("本地素材读取失败，请检查图片后重新导出");
    const blob = await response.blob();
    if (blob.size > 12 * 1024 * 1024 || !/^image\/(png|jpe?g|gif|webp|avif)$/.test(blob.type)) throw new Error("本地图片需要 PNG、JPEG、GIF、WebP 或 AVIF，且不超过 12MB");
    const value = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
    bindings[asset.src] = value;
  }
  return bindings;
}

export function createProjectBridgePackage(project: StudioProject, html: string, title: string, assetBindings: Record<string, string> = {}) {
  const layout = project.mode === "compose" ? project.layout : null;
  const state = project.mode === "clone" ? project.cloneTemplate : null;
  const native = layout ? compileArticle(layout.article, layout.template, layout.presetId, layout.overrides, { native: true, nodeVariants: layout.nodeVariants }).native! : nativeArticleFromHtml(html, state?.source?.pageFormat);
  const rewrite = (value: string) => Object.entries(assetBindings).reduce((text, [src, replacement]) => text.replaceAll(src.replaceAll("&", "&amp;"), replacement).replaceAll(src, replacement), value);
  const packet = createHtmlBridgePackage(rewrite(html), title, { modules: native.modules.map((module) => ({ ...module, html: rewrite(module.html) })), pageFormat: { ...native.pageFormat, styles: Object.fromEntries(Object.entries(native.pageFormat.styles).map(([key, value]) => [key, rewrite(value)])) } });
  const reasons: string[] = [];
  if (!state?.source?.paperId) reasons.push("缺少秀米原稿定位，请用新版插件重新抓取原稿后再做原位更新");
  if (!state?.source?.nativeModuleHashes?.length) reasons.push("缺少原生模块基线，请用新版插件从秀米编辑页重新抓取");
  const changed = state?.slots.filter((slot) => slot.value !== slot.originalValue || (slot.linkUrl || "") !== (slot.originalLinkUrl || "")) ?? [];
  if (changed.some((slot) => slot.kind === "image")) reasons.push("图片已改变，请使用完整的分模块导入");
  if (changed.some((slot) => slot.kind === "text" && !slot.sourceLocation)) reasons.push("部分文字没有可靠的原位置，请重新抓取或分模块导入");
  if (state) {
    const reset = { ...state, slots: state.slots.map((slot) => ({ ...slot, value: slot.originalValue, linkUrl: slot.originalLinkUrl ?? "" })) };
    if (renderCloneTemplate({ ...project, cloneTemplate: reset }) !== renderCloneTemplate({ ...project, cloneTemplate: pristineTemplateState(state) })) reasons.push("模块结构或顺序已改变，请使用完整的分模块导入");
  }
  const operations = changed.filter((slot) => slot.kind === "text" && slot.sourceLocation).map((slot) => ({ ...slot.sourceLocation!, search: slot.originalValue, text: slot.value, expectedHref: safeLinkUrl(slot.originalLinkUrl), href: safeLinkUrl(slot.linkUrl) }));
  if (!changed.length) reasons.push("没有需要写回的修改");
  return { ...packet, patch: { source: state?.source, operations, available: reasons.length === 0, reasons } };
}
