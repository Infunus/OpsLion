/** SVG stays inline so Xiumi geometry, XHTML labels and numeric SMIL survive. */
export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

export const svgTags = `svg g defs symbol use rect circle ellipse line polyline polygon path text tspan textPath title desc
  clipPath mask pattern linearGradient radialGradient stop marker image foreignObject animate animateTransform set
  filter feBlend feColorMatrix feComponentTransfer feFuncR feFuncG feFuncB feFuncA feComposite feFlood
  feGaussianBlur feMerge feMergeNode feMorphology feOffset feDropShadow feTurbulence feDisplacementMap feTile`.split(/\s+/);
const tagNames = new Set(svgTags.map((tag) => tag.toLowerCase()));

const presentationAttributes = `transform opacity fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin
  stroke-dasharray stroke-dashoffset stroke-miterlimit vector-effect clip-path clip-rule mask filter marker-start marker-mid marker-end
  color visibility display color-interpolation color-interpolation-filters shape-rendering text-rendering image-rendering pointer-events isolation
  font-family font-size font-style font-weight letter-spacing word-spacing text-anchor dominant-baseline alignment-baseline
  stop-color stop-opacity flood-color flood-opacity`.split(/\s+/);
export const svgStyleProperties = new Set(presentationAttributes.filter((name) => name !== "transform"));
const geometryAttributes = `x y x1 y1 x2 y2 cx cy r rx ry dx dy rotate width height viewBox preserveAspectRatio d points pathLength
  textLength lengthAdjust offset gradientUnits gradientTransform spreadMethod fx fy fr patternUnits patternContentUnits patternTransform
  clipPathUnits maskUnits maskContentUnits refX refY markerUnits markerWidth markerHeight orient
  filterUnits primitiveUnits in in2 result type values mode operator k1 k2 k3 k4 stdDeviation edgeMode radius
  baseFrequency numOctaves seed stitchTiles scale xChannelSelector yChannelSelector slope intercept amplitude exponent tableValues`.split(/\s+/);
const animationAttributes = `attributeName attributeType type begin end dur min max restart repeatCount repeatDur fill calcMode
  values keyTimes keySplines from to by additive accumulate`.split(/\s+/);
const svgCommonAttributes = ["id", "xmlns", "xmlns:xlink", "href", "xlink:href", "style", "class", "data-layout-slot", "data-layout-module"];
export const svgAttributes = [...svgCommonAttributes, ...presentationAttributes, ...geometryAttributes, ...animationAttributes];
const staticAttributes = new Set([...presentationAttributes, ...geometryAttributes].map((name) => name.toLowerCase()));
const animationAttributeNames = new Set(animationAttributes.map((name) => name.toLowerCase()));
const localPaintAttributes = new Set(["fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end"]);
const numericAnimationTargets = new Set(`opacity fill-opacity stroke-opacity stroke-width stroke-dashoffset x y x1 y1 x2 y2
  cx cy r rx ry dx dy width height font-size letter-spacing word-spacing viewbox`.split(/\s+/));
const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?";
const numericValue = new RegExp(`^${number}(?:%|px|em|rem|ex)?(?:[\\s,]+${number}(?:%|px|em|rem|ex)?)*$`, "i");
const clockValue = new RegExp(`^${number}(?:ms|s|min|h)?$`, "i");
// Underscores keep generated IDs usable in Blink's SMIL event-value parser.
// Source IDs may still contain hyphens and are remapped before validation.
const safeId = /^opslion_svg_\d+_\d+$/;
const referenceId = /^[A-Za-z0-9_.:-]+$/;
const localUrlPattern = /url\(\s*(["']?)#([A-Za-z0-9_.:-]+)\1\s*\)/gi;
const animationEvents = "click|touchstart|touchend|mousedown|mouseup|mouseenter|mouseleave|pointerdown|pointerup|begin|end";
const timingReference = new RegExp(`(^|;)\\s*([A-Za-z0-9_.:-]+)\\.(${animationEvents})\\b`, "g");
const transformTypes = /^(translate|scale|rotate|skewX|skewY)$/;

export function isSvgElement(node: Element) { return node.namespaceURI === SVG_NAMESPACE; }
export function isSafeSvgTag(node: Element) { return tagNames.has(node.localName.toLowerCase()); }
export function safeSvgLocalUrl(value: string) { return /^#opslion_svg_\d+_\d+$/.test(value.trim()) ? value.trim() : ""; }

function safeTiming(value: string) {
  return value.split(";").every((part) => {
    const item = part.trim();
    if (item === "indefinite" || clockValue.test(item)) return true;
    return new RegExp(`^(?:opslion_svg_\\d+_\\d+\\.)?(?:${animationEvents})(?:\\s*[+-]\\s*${number}(?:ms|s|min|h))?$`, "i").test(item);
  });
}

/** Animations may change numeric geometry/opacity on their parent, never URLs or markup. */
export function isSafeSvgAnimation(node: Element) {
  const target = (node.getAttribute("attributeName") || "").toLowerCase();
  if (node.hasAttribute("href") || node.hasAttribute("xlink:href")) return false;
  if (node.localName === "set") {
    if (target !== "visibility" || !/^(visible|hidden|collapse)$/.test(node.getAttribute("to") || "")) return false;
  } else if (node.localName === "animateTransform") {
    if (target !== "transform" || !transformTypes.test(node.getAttribute("type") || "")) return false;
  } else if (!numericAnimationTargets.has(target)) return false;
  for (const name of ["from", "to", "by"]) {
    const value = node.getAttribute(name);
    if (value !== null && !(node.localName === "set" && name === "to") && !numericValue.test(value.trim())) return false;
  }
  const values = node.getAttribute("values");
  if (values !== null && !values.split(";").every((value) => numericValue.test(value.trim()))) return false;
  for (const name of ["begin", "end"]) {
    const value = node.getAttribute(name);
    if (value !== null && !safeTiming(value)) return false;
  }
  return true;
}

function safeAnimationAttribute(node: Element, name: string, value: string) {
  if (!animationAttributeNames.has(name)) return "";
  if (node.localName === "set") {
    if (name === "attributename") return value === "visibility" ? value : "";
    if (name === "to") return /^(visible|hidden|collapse)$/.test(value) ? value : "";
    if (["from", "by", "values", "type", "additive", "accumulate", "keytimes", "keysplines", "calcmode"].includes(name)) return "";
  }
  if (node.localName === "animateTransform") {
    if (name === "attributename") return value === "transform" ? value : "";
    if (name === "type") return transformTypes.test(value) ? value : "";
  }
  if (["from", "to", "by"].includes(name)) return numericValue.test(value) ? value : "";
  if (name === "values") return value.split(";").every((part) => numericValue.test(part.trim())) ? value : "";
  if (["begin", "end"].includes(name)) return safeTiming(value) ? value : "";
  if (["dur", "min", "max", "repeatdur"].includes(name)) return value === "indefinite" || clockValue.test(value) ? value : "";
  if (name === "repeatcount") return value === "indefinite" || /^\d+(?:\.\d+)?$/.test(value) ? value : "";
  if (name === "attributename") return numericAnimationTargets.has(value.toLowerCase()) ? value : "";
  if (name === "attributetype") return /^(XML|CSS|auto)$/.test(value) ? value : "";
  if (name === "fill") return /^(freeze|remove)$/.test(value) ? value : "";
  if (name === "restart") return /^(always|whenNotActive|never)$/.test(value) ? value : "";
  if (name === "calcmode") return /^(discrete|linear|paced|spline)$/.test(value) ? value : "";
  if (name === "additive") return /^(replace|sum)$/.test(value) ? value : "";
  if (name === "accumulate") return /^(none|sum)$/.test(value) ? value : "";
  if (["keytimes", "keysplines"].includes(name)) return value.split(/[;,\s]+/).every((part) => /^\d*\.?\d+$/.test(part) && Number(part) <= 1) ? value : "";
  return "";
}

export function safeSvgAttribute(node: Element, name: string, raw: string, imageUrl: (value: string) => string) {
  const value = raw.trim();
  name = name.toLowerCase();
  if (name === "id") return safeId.test(value) ? value : "";
  if (name === "xmlns") return value === SVG_NAMESPACE ? value : "";
  if (name === "xmlns:xlink") return value === "http://www.w3.org/1999/xlink" ? value : "";
  if (["animate", "animateTransform", "set"].includes(node.localName)) return safeAnimationAttribute(node, name, value);
  if (name === "href" || name === "xlink:href") {
    if (node.localName === "image") return imageUrl(value);
    return ["use", "textPath", "linearGradient", "radialGradient", "pattern"].includes(node.localName) ? safeSvgLocalUrl(value) : "";
  }
  if (!staticAttributes.has(name) || /[\\<>]|\/\*|(?:javascript|vbscript)\s*:|(?:expression|var|attr|env|image-set)\s*\(/i.test(value)) return "";
  if (/url\s*\(/i.test(value)) {
    if (!localPaintAttributes.has(name)) return "";
    let unsafe = false;
    const stripped = value.replace(localUrlPattern, (_match, _quote: string, id: string) => {
      if (!safeId.test(id)) unsafe = true;
      return "";
    });
    if (unsafe || /url\s*\(/i.test(stripped)) return "";
  }
  return value;
}

/** Scope every SVG reference before DOMPurify checks IDs, including clobbering names. */
export function prepareSvgMarkup(html: string) {
  if (!/<svg[\s>]/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const roots = [...doc.querySelectorAll("svg")].filter((node) => isSvgElement(node) && !node.parentElement?.closest("svg"));
  roots.forEach((root, rootIndex) => {
    const nodes = [root, ...root.querySelectorAll("*")].filter(isSvgElement);
    // Unknown SVG wrappers must not hoist their children into the article.
    nodes.filter((node) => !isSafeSvgTag(node)).forEach((node) => node.remove());
    // Reject targeted animation before a missing fragment could erase its href.
    nodes.filter((node) => ["animate", "animateTransform", "set"].includes(node.localName)
      && (node.hasAttribute("href") || node.hasAttribute("xlink:href"))).forEach((node) => node.remove());
    const ids = new Map<string, string>();
    let counter = 0;
    nodes.filter((node) => (node === root || root.contains(node)) && node.hasAttribute("id")).forEach((node) => {
      const original = node.getAttribute("id") || "";
      const replacement = `opslion_svg_${rootIndex + 1}_${++counter}`;
      if (referenceId.test(original) && !ids.has(original)) ids.set(original, replacement);
      node.setAttribute("id", replacement);
    });
    nodes.forEach((node) => {
      for (const attr of [...node.attributes]) {
        let value = attr.value;
        if (["href", "xlink:href"].includes(attr.name) && value.trim().startsWith("#")) {
          value = ids.has(value.trim().slice(1)) ? `#${ids.get(value.trim().slice(1))}` : "";
        }
        let missing = false;
        value = value.replace(localUrlPattern, (_match, _quote: string, id: string) => {
          const replacement = ids.get(id);
          if (!replacement) missing = true;
          return replacement ? `url(#${replacement})` : "url(#opslion_svg_missing)";
        });
        if (["begin", "end"].includes(attr.name)) {
          value = value.replace(timingReference, (_match, separator: string, id: string, event: string) => {
            const replacement = ids.get(id);
            if (!replacement) missing = true;
            return replacement ? `${separator}${replacement}.${event}` : "";
          });
          // Dropping an unresolved trigger would change it into an immediate animation.
          if (missing && ["animate", "animateTransform", "set"].includes(node.localName)) node.remove();
        }
        if ((missing && attr.name !== "style") || !value) node.removeAttribute(attr.name);
        else if (value !== attr.value) node.setAttributeNS(attr.namespaceURI, attr.name, value);
      }
    });
  });
  return doc.body.innerHTML;
}

export function removeEmptySvgMarkup(html: string) {
  if (!/<svg[\s>]/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  [...doc.querySelectorAll("svg")].reverse().forEach((node) => {
    if (!node.children.length && !node.textContent?.trim()) node.remove();
  });
  return prepareSvgMarkup(doc.body.innerHTML);
}
