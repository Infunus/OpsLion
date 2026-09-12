/** Runs inside the selected page/frame; keep this function self-contained. */
export function capturePage() {
  const hostname = location.hostname.toLowerCase();
  const isWechat = hostname === "mp.weixin.qq.com";
  const isXiumi = hostname === "xiumi.us" || hostname.endsWith(".xiumi.us");
  const isPreview = hostname === "v.xiumius.cn";
  if (!isWechat && !isXiumi && !isPreview) return null;

  let root = isWechat ? document.querySelector("#js_content") : null;
  if (isPreview) {
    root = [...document.querySelectorAll("article.paper,article.tn-cube-box")]
      .filter((element) => getComputedStyle(element).display !== "none")
      .sort((a, b) => b.querySelectorAll("*").length - a.querySelectorAll("*").length)[0] || null;
  }
  if (!root && isXiumi) {
    // Xiumi v5 uses one page component containing many independent
    // contenteditable text cells. Picking the largest editable captures
    // only one paragraph, so prefer the page component itself.
    root = document.querySelector('[tn-comp-role="page"].tn-page-inst')
      || document.querySelector('.tn-page-inst[tn-comp-role="page"]')
      || document.querySelector("article.tn-paper-document-root");
    if (!root) {
      const candidates = [...document.querySelectorAll([
        '[contenteditable="true"]',
        ".ProseMirror",
        ".edui-body-container",
        ".xiumi-editor",
        '[class*="editor-content"]',
      ].join(","))]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const computed = getComputedStyle(element);
          const contentSize = (element.textContent || "").trim().length + element.querySelectorAll("img,svg").length * 80;
          return rect.width > 220 && rect.height > 120 && contentSize > 30 && computed.display !== "none" && computed.visibility !== "hidden";
        })
        .sort((left, right) => {
          const score = (element) => {
            const rect = element.getBoundingClientRect();
            return Math.min(rect.width * rect.height, 1200000) + (element.textContent || "").length * 10 + element.querySelectorAll("img,svg,section").length * 120;
          };
          return score(right) - score(left);
        });
      root = candidates[0] || null;
    }
  }
  if (!root) return null;
  // The style pin is the article surface. The outer editor often reports 16px
  // while the real page declares 87.5% (14px), its own paper colour and padding.
  const pagePin = [...root.children].find((element) => element.classList.contains("tn-comp-style-pin"));
  if (pagePin) root = pagePin;

  const originalNodes = [root, ...root.querySelectorAll("*")];
  if (originalNodes.length > 3500) {
    return { error: "正文节点超过 3500 个，请缩小模板范围后重试。" };
  }
  const clone = root.cloneNode(true);
  const cloneNodes = [clone, ...clone.querySelectorAll("*")];
  const moduleElements = [...root.querySelectorAll(".tn-comp-top-level")].filter((element) => !element.parentElement?.closest(".tn-comp-top-level"));
  const modules = moduleElements.map((module, index) => {
    const cells = [...module.querySelectorAll('[contenteditable="true"]')].filter((cell) => !cell.parentElement?.closest('[contenteditable="true"]'));
    cells.forEach((cell, cellIndex) => cloneNodes[originalNodes.indexOf(cell)]?.setAttribute("data-layout-origin", `${index}:${cellIndex}`));
    return { index, cells: cells.map((cell) => cell.textContent || "") };
  });
  const formatProperties = ["font-family", "font-size", "line-height", "letter-spacing", "color", "text-align", "text-indent", "padding-top", "padding-right", "padding-bottom", "padding-left", "background-color", "background-image", "background-size", "background-position", "background-repeat"];
  const pageStyle = getComputedStyle(root);
  const capturedAt = new Date().toISOString();
  const pageFormat = { styles: Object.fromEntries(formatProperties.map((property) => [property, pageStyle.getPropertyValue(property)]).filter(([, value]) => value)), source: { selector: pagePin ? ".tn-page-inst > .tn-comp-style-pin" : isWechat ? "#js_content" : "article", url: location.href, capturedAt } };
  const svgNamespace = "http://www.w3.org/2000/svg";
  // Definitions inherit presentation from <use>. Do not turn an unspecified
  // default black fill into an explicit style on the referenced path.
  const styleRules = [];
  const collectRules = (rules) => {
    for (const rule of rules) {
      if (rule.selectorText && rule.style) styleRules.push(rule);
      else if (rule.cssRules && (!rule.conditionText || !rule.media || matchMedia(rule.conditionText).matches)) collectRules(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try { collectRules(sheet.cssRules); } catch { /* Cross-origin stylesheets are opaque. */ }
  }
  const declaredStyles = new WeakMap();
  const hasCssDeclaration = (element, property) => {
    if (!declaredStyles.has(element)) {
      const properties = new Set();
      for (const rule of styleRules) {
        try { if (element.matches(rule.selectorText)) for (const name of rule.style) properties.add(name); } catch { /* Unsupported selector. */ }
      }
      declaredStyles.set(element, properties);
    }
    return declaredStyles.get(element).has(property);
  };
  const svgPaintProperties = [
    "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
    "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "clip-path", "clip-rule", "mask", "filter",
    "stop-color", "stop-opacity", "flood-color", "flood-opacity", "color-interpolation-filters",
    "text-anchor", "dominant-baseline", "paint-order", "vector-effect", "pointer-events", "isolation", "transform-origin",
  ];
  const localReference = (source) => {
    if (source.startsWith("#")) return source;
    try {
      const url = new URL(source, location.href);
      if (url.hash && url.href.split("#")[0] === location.href.split("#")[0]) return url.hash;
      return url.href;
    } catch { return source; }
  };
  const styleProperties = [
    "display", "position", "float", "clear", "box-sizing", "overflow", "opacity", "transform",
    "z-index", "flex", "flex-grow", "flex-shrink", "flex-basis", "flex-direction", "flex-wrap",
    "align-items", "align-content", "align-self", "justify-content", "gap", "column-count", "column-gap",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
    "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
    "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-radius",
    "background-color", "background-image", "background-position", "background-size", "background-repeat",
    "color", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
    "text-align", "text-decoration-line", "text-decoration-color", "text-indent", "text-overflow",
    "white-space", "word-break", "overflow-wrap", "vertical-align", "list-style-type", "box-shadow",
  ];
  const ignorable = new Set([
    "none", "normal", "static", "visible", "1", "auto", "0px", "rgba(0, 0, 0, 0)",
    "matrix(1, 0, 0, 1, 0, 0)",
  ]);
  for (let index = 0; index < Math.min(originalNodes.length, cloneNodes.length); index += 1) {
    const original = originalNodes[index];
    const target = cloneNodes[index];
    const computed = getComputedStyle(original);
    const isSvg = original.namespaceURI === svgNamespace;
    const definition = isSvg && Boolean(original.closest("defs,symbol"));
    styleProperties.forEach((property) => {
      if (target.style.getPropertyValue(property)) return;
      const cssDeclared = isSvg && hasCssDeclaration(original, property);
      if (isSvg && target.hasAttribute(property) && !cssDeclared) return;
      if (definition && !cssDeclared) return;
      const value = computed.getPropertyValue(property);
      const resetSpacing = value === "0px" && /^(margin|padding)-/.test(property);
      if (!value || (ignorable.has(value) && !cssDeclared && !resetSpacing && !(property === "display" && value === "none"))) return;
      if (property === "display" && ["block", "inline"].includes(value) && !cssDeclared) return;
      target.style.setProperty(property, value);
    });
    if (isSvg) {
      svgPaintProperties.forEach((property) => {
        if (target.style.getPropertyValue(property)) return;
        const cssDeclared = hasCssDeclaration(original, property);
        if (definition && !cssDeclared) return;
        if (target.hasAttribute(property) && !cssDeclared) return;
        const value = computed.getPropertyValue(property);
        if (value && (!ignorable.has(value) || cssDeclared)) target.style.setProperty(property, value);
      });
    }
    // SVG geometry is expressed in its own viewBox, often with animated percentages.
    // A measured CSS pixel width/height would override these authored attributes.
    if (!isSvg && (original.matches("img,canvas") || computed.position === "absolute" || computed.position === "fixed")) {
      ["top", "right", "bottom", "left", "width", "min-width", "max-width", "height", "min-height", "max-height", "object-fit"].forEach((property) => {
        if (target.style.getPropertyValue(property)) return;
        const value = computed.getPropertyValue(property);
        if (value && !ignorable.has(value)) target.style.setProperty(property, value);
      });
    }
  }

  clone.querySelectorAll([
    "script", "noscript", "style", "link", "iframe", "form", "input", "button", "textarea", "select", "option", "audio", "video",
    ".global-format", ".tn-comment-panel", ".content-statistics", ".page-assist-on-toolbar", ".page-comment-on-toolbar",
  ].join(",")).forEach((node) => node.remove());
  [clone, ...clone.querySelectorAll("*")].forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name.startsWith("ng-") || name.startsWith("tn-") || name.startsWith("opera-")
        || ["contenteditable", "spellcheck", "tabindex", "draggable"].includes(name)) {
        element.removeAttribute(attribute.name);
      }
    });
    [
      "ng-scope", "ng-binding", "tn-state-active", "tn-in-cell-state-active", "tn-editing-mode-preview",
      "tn-atom-dropping-sink", "tn-atom-dragging-source", "tn-editing-cell-frozen-toggle-enabled", "active",
    ].forEach((className) => element.classList.remove(className));
    const inlineStyle = element.getAttribute("style") || "";
    const normalizedStyle = inlineStyle.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, _quote, source) => {
      if (/^(data:|blob:|#)/i.test(source)) return match;
      try {
        return `url("${localReference(source).replace(/"/g, "%22")}")`;
      } catch {
        return match;
      }
    });
    if (normalizedStyle !== inlineStyle) element.setAttribute("style", normalizedStyle);
  });
  clone.querySelectorAll("img").forEach((image) => {
    const source = image.getAttribute("data-src") || image.getAttribute("data-original") || image.getAttribute("src") || "";
    if (source) {
      try {
        image.setAttribute("src", new URL(source, location.href).href);
      } catch {
        image.setAttribute("src", source);
      }
    }
    image.removeAttribute("srcset");
    image.removeAttribute("data-src");
    image.removeAttribute("data-original");
  });
  clone.querySelectorAll("a").forEach((link) => {
    if (!(link.textContent || "").trim() && !link.querySelector("img,svg,path,use,rect,circle,ellipse,polygon,polyline,image")) {
      link.remove();
      return;
    }
    const href = link.getAttribute("href") || "";
    if (!/^javascript:/i.test(href)) {
      try {
        link.setAttribute("href", new URL(href, location.href).href);
      } catch {
        link.setAttribute("href", href);
      }
    }
    else link.removeAttribute("href");
  });
  clone.querySelectorAll("svg image,svg use").forEach((element) => {
    for (const name of ["href", "xlink:href"]) {
      const source = element.getAttribute(name);
      if (!source) continue;
      const normalized = localReference(source);
      if (element.localName === "use" && !normalized.startsWith("#")) {
        element.removeAttribute(name);
      } else if (/^(?:https?:|data:image\/|#)/i.test(normalized)) {
        element.setAttribute(name, normalized);
      } else element.removeAttribute(name);
    }
  });

  const title = isWechat
    ? document.querySelector("#activity-name")?.textContent?.trim() || document.title
    : document.title.replace(/[-_|].*秀米.*$/i, "").trim() || "秀米排版模板";
  const html = clone.outerHTML;
  return {
    title,
    sourceType: isWechat ? "wechat" : "xiumi",
    renderedPreview: isPreview,
    incompleteAnimations: !isPreview && Boolean(root.querySelector("animate[revert-expand],animate.expand-self-animation:not([to])")),
    html,
    source: { url: location.href, ...(location.hash.match(/\/paper\/for\/(\d+)/)?.[1] ? { paperId: location.hash.match(/\/paper\/for\/(\d+)/)[1] } : {}), capturedAt, pageFormat, modules },
    stats: {
      elements: clone.querySelectorAll("*").length + 1,
      images: clone.querySelectorAll("img").length,
      svgs: clone.querySelectorAll("svg").length,
      animations: clone.querySelectorAll("animate,animateTransform,set").length,
      links: clone.querySelectorAll("a[href]").length,
      textLength: (clone.textContent || "").trim().length,
      blocks: clone.querySelectorAll(".tn-comp-top-level").length,
    },
    score: (isPreview ? 100000000 : 0) + html.length + (clone.textContent || "").length * 4,
  };
}
