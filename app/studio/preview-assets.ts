import { sanitizeArticleHtml, safeImageUrl } from "./html-policy";
import { copyEditingBindings } from "./template-engine/editing-bindings";

const PROXIED_ASSET_HOSTS = [
  "statics.xiumi.us",
  "img.xiumi.us",
  "mmbiz.qpic.cn",
  "mmbiz.qlogo.cn",
  "wx.qlogo.cn",
  "thirdwx.qlogo.cn",
];

function isProxiedHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return PROXIED_ASSET_HOSTS.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

export function previewAssetUrl(value: string) {
  const source = safeImageUrl(value);
  if (!source) return "";
  if (/^data:image\//i.test(source) || /^blob:/i.test(source)) return source;
  if (/^\/(?:local-api\/assets\/proxy\?|assets\/)/i.test(source)) return source;
  if (/^(data:|#)/i.test(source)) return "";
  try {
    const absolute = new URL(source, "https://xiumi.us/");
    if (!["http:", "https:"].includes(absolute.protocol)) return "";
    absolute.protocol = "https:";
    if (!isProxiedHost(absolute.hostname)) return absolute.href;
    return `/local-api/assets/proxy?url=${encodeURIComponent(absolute.href)}`;
  } catch {
    return "";
  }
}

function replaceStyleUrls(style: string) {
  return style.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, _quote: string, source: string) => {
    const resolved = previewAssetUrl(source);
    if (!resolved || resolved === source) return match;
    return `url("${resolved.replace(/"/g, "%22")}")`;
  });
}

/** Prepare remote Xiumi/WeChat assets for the localhost preview only. */
export function preparePreviewHtml(html: string, options: { editing?: boolean } = {}) {
  const boundHtml = options.editing ? html : "";
  html = sanitizeArticleHtml(html);
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (boundHtml) copyEditingBindings(new DOMParser().parseFromString(boundHtml, "text/html").body, doc.body);
  doc.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
    image.setAttribute("src", previewAssetUrl(image.getAttribute("src") || ""));
  });
  doc.querySelectorAll("svg image").forEach((image) => {
    if (image.namespaceURI !== "http://www.w3.org/2000/svg") return;
    [...image.attributes].filter((attribute) => attribute.localName === "href").forEach((attribute) => {
      const source = attribute.value;
      if (source.startsWith("#")) return;
      image.setAttributeNS(attribute.namespaceURI, attribute.name, previewAssetUrl(source));
    });
  });
  doc.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const style = element.getAttribute("style") || "";
    const normalized = replaceStyleUrls(style);
    if (normalized !== style) element.setAttribute("style", normalized);
  });
  return doc.body.innerHTML;
}
