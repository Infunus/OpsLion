import createDOMPurify from "dompurify";
import { HTML_NAMESPACE, SVG_NAMESPACE, isSafeSvgAnimation, isSafeSvgTag, isSvgElement, prepareSvgMarkup, removeEmptySvgMarkup, safeSvgAttribute, safeSvgLocalUrl, svgAttributes, svgStyleProperties, svgTags } from "./svg-policy";

/** One policy for imported HTML, saved templates, previews and exported articles. */
export function safeLinkUrl(value: string | undefined): string {
  try {
    const url = new URL(value?.trim() || "");
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}

export function safeImageUrl(value: string): string {
  const source = value.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(source)) return source;
  if (source.startsWith("//")) return safeLinkUrl(`https:${source}`);
  // App-owned preview proxy and shipped decorative assets only.
  if (/^\/(?:local-api\/assets\/proxy\?|assets\/)[^\\\s]*$/i.test(source)) return source;
  return safeLinkUrl(source);
}

const cssProperties = new Set(`color background background-color background-image background-position background-size background-repeat
  font font-family font-size font-style font-weight line-height letter-spacing word-spacing text-align text-decoration text-indent text-transform
  white-space word-break overflow-wrap vertical-align display box-sizing width min-width max-width height min-height max-height
  margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left
  border border-top border-right border-bottom border-left border-width border-style border-color border-radius border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius
  box-shadow opacity overflow overflow-x overflow-y position top right bottom left float clear list-style list-style-type border-collapse border-spacing
  object-fit object-position transform transform-origin flex flex-direction flex-wrap align-items justify-content gap`.split(/\s+/));

function safeStyle(raw: string, svg = false): string {
  const style = document.createElement("span").style;
  const output = document.createElement("span").style;
  style.cssText = raw;
  for (const property of style) {
    // The browser expands shorthand borders into these longhand declarations.
    if (!cssProperties.has(property) && !(svg && svgStyleProperties.has(property)) && !/^border-(top|right|bottom|left)-(width|style|color)$/.test(property)
      && !/^text-decoration-(line|style|color|thickness)$/.test(property) && property !== "list-style-position") continue;
    let value = style.getPropertyValue(property);
    if (/[\\]|\/\*|(?:expression|var|attr|env|image-set)\s*\(|(?:javascript|vbscript)\s*:/i.test(value)) continue;
    if (property === "position" && !["static", "relative", "absolute"].includes(value)) continue;
    let unsafe = false;
    value = value.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_match, _quote, url: string) => {
      const svgReference = svg ? safeSvgLocalUrl(url) : "";
      const onlyLocalReference = svg && ["fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end"].includes(property);
      const safe = svgReference || (onlyLocalReference ? "" : safeImageUrl(url));
      if (!safe) unsafe = true;
      return `url("${safe.replace(/"/g, "%22")}")`;
    });
    if (!unsafe) output.setProperty(property, value, svg ? style.getPropertyPriority(property) : "");
  }
  return output.cssText;
}

const htmlTags = ["section", "article", "main", "header", "footer", "div", "span", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "blockquote", "pre", "code", "ul", "ol", "li", "a", "img", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col"];
const htmlAttributes = ["href", "src", "alt", "title", "style", "class", "width", "height", "colspan", "rowspan", "align", "valign", "start", "type", "data-layout-slot", "data-layout-module", "data-layout-origin", "data-layout-artifact", "data-weekly-artifact"];
const htmlAttributeNames = new Set(htmlAttributes);
const svgOnlyTagNames = new Set(svgTags.map((tag) => tag.toLowerCase()).filter((tag) => !htmlTags.includes(tag)));

let purifier: ReturnType<typeof createDOMPurify> | undefined;
export function sanitizeArticleHtml(html: string): string {
  // Imported HTML must never pass through unchanged during server rendering.
  if (typeof window === "undefined") return "";
  if (!purifier) {
    purifier = createDOMPurify(window);
    purifier.addHook("uponSanitizeElement", (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (!isSvgElement(element)) {
        if (svgOnlyTagNames.has(element.localName.toLowerCase())) element.remove();
        return;
      }
      if (!isSafeSvgTag(element) || (["animate", "animateTransform", "set"].includes(element.localName) && !isSafeSvgAnimation(element))) element.remove();
    });
    purifier.addHook("beforeSanitizeAttributes", (node) => {
      if (node.nodeName === "IMG" && !node.getAttribute("src")) {
        node.setAttribute("src", node.getAttribute("data-src") || node.getAttribute("data-original") || "");
      }
    });
    purifier.addHook("uponSanitizeAttribute", (node, data) => {
      const svg = isSvgElement(node);
      if (svg && !["style", "class", "data-layout-slot", "data-layout-module"].includes(data.attrName)) {
        data.attrValue = safeSvgAttribute(node, data.attrName, data.attrValue, safeImageUrl);
      } else if (!svg) {
        const xhtmlNamespace = data.attrName === "xmlns" && data.attrValue === HTML_NAMESPACE && !!node.closest("foreignObject");
        if (!htmlAttributeNames.has(data.attrName) && !xhtmlNamespace) data.keepAttr = false;
        if (data.attrName === "href") data.attrValue = safeLinkUrl(data.attrValue);
        if (data.attrName === "src") data.attrValue = node.nodeName === "IMG" ? safeImageUrl(data.attrValue) : "";
      }
      if (data.attrName === "style") data.attrValue = safeStyle(data.attrValue, svg);
      if (data.attrName === "class") data.attrValue = data.attrValue.split(/\s+/).filter((value) => value === "tn-comp-top-level").join(" ");
      if (!data.attrValue) data.keepAttr = false;
    });
    purifier.addHook("afterSanitizeAttributes", (node) => {
      if (node.nodeName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
    });
  }
  return removeEmptySvgMarkup(purifier.sanitize(prepareSvgMarkup(html), {
    ALLOWED_TAGS: [...htmlTags, ...svgTags],
    ALLOWED_ATTR: [...htmlAttributes, ...svgAttributes],
    ALLOWED_NAMESPACES: [HTML_NAMESPACE, SVG_NAMESPACE],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  }));
}
