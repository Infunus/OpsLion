import { createHtmlBridgePackage, resolveLocalBridgeAssets } from "../bridge-package";

/** Both exports carry the same rendered content and all app-owned artwork. */
export async function bundleWeeklyHtml(html: string) {
  const bindings = await resolveLocalBridgeAssets(html);
  return Object.entries(bindings).reduce((text, [source, data]) => text.replaceAll(source.replaceAll("&", "&amp;"), data).replaceAll(source, data), html);
}

export async function createWeeklyBridgePackage(html: string, title: string) {
  const packet = createHtmlBridgePackage(await bundleWeeklyHtml(html), title);
  // Reserve space for the target editor's model wrappers (1.5 MB model limit).
  if (JSON.stringify(packet.native.modules).length > 1_400_000) throw new Error("周报正文过长，超过插件可接收的模块大小，请精简本期内容或分期导出");
  return packet;
}

export async function createWeeklyStandaloneHtml(html: string, title: string) {
  const escapedTitle = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle}</title><style>body{margin:0;background:#fff}article{width:390px;max-width:100%;margin:auto}*{box-sizing:border-box}</style></head><body><article>${await bundleWeeklyHtml(html)}</article></body></html>`;
}
