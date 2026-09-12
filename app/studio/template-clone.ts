import { sanitizeArticleHtml } from "./html-policy";
import { makeId, type CloneModule, type CloneSlot, type CloneTemplateState } from "./types";
import { captureSourceSchema, type CaptureSource, type SourceLocation } from "./bridge-contract";

const compactText = (value: string | null | undefined, limit = 32) => (value || "").replace(/\s+/g, " ").trim().slice(0, limit);
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** Keep a copied SVG's definitions and animation targets inside that copy. */
function isolateSvgIds(root: Element) {
  const elements = [root, ...root.querySelectorAll("*")];
  const scopes = new Map<Element, Map<string, string>>();
  const svgScope = (element: Element): Element | null => {
    let scope: Element | null = null;
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (current.namespaceURI === SVG_NAMESPACE && current.localName === "svg") scope = current;
      if (current === root) break;
    }
    return scope;
  };
  elements.forEach((element) => {
    if (element.namespaceURI !== SVG_NAMESPACE) return;
    const id = element.getAttribute("id");
    const scope = svgScope(element);
    if (!id || !scope) return;
    const ids = scopes.get(scope) || new Map<string, string>();
    const nextId = makeId("svg");
    if (!ids.has(id)) ids.set(id, nextId);
    scopes.set(scope, ids);
    element.setAttribute("id", nextId);
  });
  elements.forEach((element) => {
    const scope = svgScope(element);
    const ids = scope && scopes.get(scope);
    if (!ids) return;
    [...element.attributes].forEach((attribute) => {
      let value = attribute.value;
      if (attribute.localName === "href" && value.startsWith("#")) {
        const nextId = ids.get(value.slice(1));
        if (nextId) value = `#${nextId}`;
      }
      value = value.replace(/url\(\s*(["']?)#([^"'\s)]+)\1\s*\)/gi, (match, _quote: string, id: string) => {
        const nextId = ids.get(id);
        return nextId ? `url(#${nextId})` : match;
      });
      if (["begin", "end"].includes(attribute.localName)) {
        value = value.split(";").map((timing) => {
          const source = timing.trim();
          const id = [...ids.keys()].sort((left, right) => right.length - left.length).find((candidate) => source.startsWith(`${candidate}.`));
          return id ? `${ids.get(id)}${source.slice(id.length)}` : timing;
        }).join(";");
      }
      if (value !== attribute.value) element.setAttributeNS(attribute.namespaceURI, attribute.name, value);
    });
  });
}

function moduleLabel(element: Element, index: number) {
  const emphasized = compactText(element.querySelector("h1,h2,h3,h4,h5,h6,strong")?.textContent, 24);
  const body = compactText(element.textContent, 40);
  const candidate = emphasized || body;
  const searchable = `${candidate} ${body}`;
  let role = "";
  if (/二维码|扫码|报名|Registration/i.test(searchable)) role = "报名";
  else if (/节目要求|主持人要求|征集要求|Requirements?/i.test(searchable)) role = "要求";
  else if (/文案[丨|：:]|排版[丨|：:]|校对[丨|：:]|学生会|工作室/.test(searchable)) role = "署名";
  else if (/标题|Title/i.test(searchable)) role = "标题";
  else if (candidate) role = "正文";
  else if (element.querySelector("img")) return `图片 / 装饰模块 ${index + 1}`;
  else return `结构模块 ${index + 1}`;
  return `${role} · ${candidate || `模块 ${index + 1}`}`.slice(0, 36);
}

function imageSlotLabel(image: Element, index: number) {
  const alt = compactText(image.getAttribute("alt"), 24);
  const context = compactText(image.closest("p,li,figure,section")?.textContent || image.parentElement?.textContent, 24);
  return alt || (context ? `图片 ${index + 1} · ${context}` : `图片 ${index + 1}`);
}

export interface TemplateSlotContext {
  moduleLabel: string;
  groupId: string;
  groupIndex: number;
  indexInGroup: number;
  groupText: string;
}

export function templateSlotContexts(state: CloneTemplateState): Record<string, TemplateSlotContext> {
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const result: Record<string, TemplateSlotContext> = {};
  state.modules.forEach((module, moduleIndex) => {
    const moduleElement = doc.querySelector(`[data-layout-module="${CSS.escape(module.id)}"]`);
    if (!moduleElement) return;
    const groups = new Map<Element, { id: string; index: number; slots: string[]; text: string }>();
    const slotElements = [...moduleElement.querySelectorAll<HTMLElement>("[data-layout-slot]")];
    slotElements.forEach((element) => {
      const groupElement = element.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption")
        || element.parentElement
        || moduleElement;
      let group = groups.get(groupElement);
      if (!group) {
        const index = groups.size;
        group = {
          id: `${module.id}:group-${index + 1}`,
          index,
          slots: [],
          text: compactText(groupElement.textContent, 180),
        };
        groups.set(groupElement, group);
      }
      const slotId = element.dataset.layoutSlot || "";
      if (slotId) group.slots.push(slotId);
    });
    groups.forEach((group) => group.slots.forEach((slotId, indexInGroup) => {
      result[slotId] = {
        moduleLabel: module.label || moduleLabel(moduleElement, moduleIndex),
        groupId: group.id,
        groupIndex: group.index,
        indexInGroup,
        groupText: group.text,
      };
    }));
  });
  return result;
}

export function normalizeTemplateMetadata(state: CloneTemplateState): CloneTemplateState {
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  let changed = false;
  const modules = state.modules.map((module, index) => {
    const element = doc.querySelector(`[data-layout-module="${CSS.escape(module.id)}"]`);
    if (!element) return module;
    const nextLabel = `${moduleLabel(element, index)}${module.repeatable ? "（副本）" : ""}`;
    if (nextLabel === module.label) return module;
    changed = true;
    return { ...module, label: nextLabel };
  });
  const slots = state.slots.map((slot, index) => {
    if (slot.kind !== "image") return slot;
    const element = doc.querySelector(`[data-layout-slot="${CSS.escape(slot.id)}"]`);
    if (!element) return slot;
    const nextLabel = imageSlotLabel(element, index);
    if (nextLabel === slot.label) return slot;
    changed = true;
    return { ...slot, label: nextLabel };
  });
  return changed ? { ...state, modules, slots } : state;
}

export function analyzeTemplateHtml(sourceHtml: string, name: string, provenance?: CaptureSource): CloneTemplateState {
  const source = provenance ? captureSourceSchema.parse(provenance) : undefined;
  sourceHtml = sanitizeArticleHtml(sourceHtml);
  const doc = new DOMParser().parseFromString(sourceHtml, "text/html");
  const slots: CloneSlot[] = [];
  const textNodes: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      const text = node.nodeValue?.trim() || "";
      // Native SVG text/tspan cannot contain HTML spans. XHTML paragraphs in
      // foreignObject remain normal editable text slots.
      if (!parent || parent.namespaceURI !== HTML_NAMESPACE || !text || text.length > 1200 || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  textNodes.forEach((textNode) => {
    const raw = textNode.nodeValue || "";
    const text = raw.trim();
    const prefix = raw.match(/^\s*/)?.[0] || "";
    const suffix = raw.match(/\s*$/)?.[0] || "";
    const linkUrl = textNode.parentElement?.closest("a")?.getAttribute("href") || "";
    const origin = textNode.parentElement?.closest("[data-layout-origin]");
    const coordinates = origin?.getAttribute("data-layout-origin")?.match(/^(\d+):(\d+)$/);
    let sourceLocation: SourceLocation | undefined;
    if (source && origin && coordinates) {
      const moduleIndex = Number(coordinates[1]); const cell = Number(coordinates[2]);
      if (source.modules[moduleIndex]?.cells[cell] === origin.textContent) {
        const range = doc.createRange(); range.setStart(origin, 0); range.setEnd(textNode, 0);
        const start = range.toString().length + prefix.length;
        sourceLocation = { module: moduleIndex, cell, start, end: start + text.length };
      }
    }
    const slotId = makeId("text");
    const wrapper = doc.createElement("span");
    wrapper.setAttribute("data-layout-slot", slotId);
    wrapper.textContent = raw;
    textNode.replaceWith(wrapper);
    slots.push({
      id: slotId,
      label: text.slice(0, 28),
      kind: "text",
      value: text,
      originalValue: text,
      prefix,
      suffix,
      linkUrl,
      originalLinkUrl: linkUrl,
      role: "content",
      ...(sourceLocation ? { sourceLocation } : {}),
    });
  });

  doc.querySelectorAll("img").forEach((image, index) => {
    const src = image.getAttribute("src") || "";
    const slotId = makeId("image");
    image.setAttribute("data-layout-slot", slotId);
    const linkUrl = image.closest("a")?.getAttribute("href") || "";
    slots.push({ id: slotId, label: imageSlotLabel(image, index), kind: "image", value: src, originalValue: src, role: "unknown", linkUrl, originalLinkUrl: linkUrl });
  });

  const modules: CloneModule[] = [];
  const bodyElements = [...doc.body.children];
  const root = bodyElements.length === 1 && bodyElements[0].namespaceURI === HTML_NAMESPACE && bodyElements[0].children.length > 1 ? bodyElements[0] : doc.body;
  const xiumiTopLevel = [...doc.querySelectorAll(".tn-comp-top-level")].filter((element) => !element.parentElement?.closest(".tn-comp-top-level"));
  const moduleElements = xiumiTopLevel.length ? xiumiTopLevel : [...root.children];
  moduleElements.forEach((element, index) => {
    const moduleId = makeId("module");
    element.setAttribute("data-layout-module", moduleId);
    const label = moduleLabel(element, index);
    modules.push({ id: moduleId, label, included: true, repeatable: false });
  });

  if (!slots.length) throw new Error("没有识别到可替换文本。请粘贴包含正文的 HTML 或秀米富文本源码。");
  return { name: name || "历史模板", sourceHtml, analyzedHtml: doc.body.innerHTML, slots, modules, ...(source ? { source } : {}), analyzedAt: new Date().toISOString() };
}

export function pristineTemplateState(state: CloneTemplateState): CloneTemplateState {
  try {
    // Re-analyze the immutable import source so duplicated, moved, or hidden
    // modules are also restored instead of only resetting slot values.
    return analyzeTemplateHtml(state.sourceHtml, state.name, state.source);
  } catch {
    return {
      ...state,
      slots: state.slots.map((slot) => ({
        ...slot,
        value: slot.originalValue,
        linkUrl: slot.originalLinkUrl ?? slot.linkUrl ?? "",
      })),
      modules: state.modules.map((module) => ({ ...module, included: true })),
      pendingAssets: [],
    };
  }
}

export function duplicateTemplateModule(state: CloneTemplateState, moduleId: string): CloneTemplateState {
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const moduleElement = doc.querySelector(`[data-layout-module="${CSS.escape(moduleId)}"]`);
  if (!moduleElement) return state;
  const clone = moduleElement.cloneNode(true) as Element;
  isolateSvgIds(clone);
  const nextModuleId = makeId("module");
  clone.setAttribute("data-layout-module", nextModuleId);
  const nextSlots = [...state.slots];
  [clone, ...clone.querySelectorAll("[data-layout-slot]")].filter((element) => element.hasAttribute("data-layout-slot")).forEach((element) => {
    const originalId = element.getAttribute("data-layout-slot") || "";
    const originalSlot = state.slots.find((slot) => slot.id === originalId);
    if (!originalSlot) return;
    const nextId = makeId(originalSlot.kind);
    element.setAttribute("data-layout-slot", nextId);
    nextSlots.push({ ...originalSlot, id: nextId, label: `${originalSlot.label}（副本）` });
  });
  moduleElement.insertAdjacentElement("afterend", clone);
  const moduleIndex = state.modules.findIndex((item) => item.id === moduleId);
  const nextModules = [...state.modules];
  nextModules.splice(moduleIndex + 1, 0, { id: nextModuleId, label: `${state.modules[moduleIndex]?.label || "模块"}（副本）`, included: true, repeatable: true });
  return { ...state, analyzedHtml: doc.body.innerHTML, slots: nextSlots, modules: nextModules };
}

export function moveTemplateModule(state: CloneTemplateState, moduleId: string, afterModuleId: string): CloneTemplateState {
  if (!moduleId || !afterModuleId || moduleId === afterModuleId) return state;
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const moduleElement = doc.querySelector(`[data-layout-module="${CSS.escape(moduleId)}"]`);
  const afterElement = doc.querySelector(`[data-layout-module="${CSS.escape(afterModuleId)}"]`);
  if (!moduleElement || !afterElement || moduleElement.parentElement !== afterElement.parentElement) return state;
  afterElement.insertAdjacentElement("afterend", moduleElement);
  const modules = state.modules.filter((module) => module.id !== moduleId);
  const moved = state.modules.find((module) => module.id === moduleId);
  const afterIndex = modules.findIndex((module) => module.id === afterModuleId);
  if (!moved || afterIndex < 0) return state;
  modules.splice(afterIndex + 1, 0, moved);
  return { ...state, analyzedHtml: doc.body.innerHTML, modules };
}

export function segmentCapturedTemplate(state: CloneTemplateState): CloneTemplateState {
  if (state.modules.length > 1) return state;
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const candidates = [...doc.querySelectorAll(".tn-comp-top-level")].filter((element) => !element.parentElement?.closest(".tn-comp-top-level"));
  if (candidates.length <= 1) return state;
  doc.querySelectorAll("[data-layout-module]").forEach((element) => element.removeAttribute("data-layout-module"));
  const modules = candidates.map((element, index) => {
    const id = makeId("module");
    element.setAttribute("data-layout-module", id);
    const label = moduleLabel(element, index);
    return { id, label, included: true, repeatable: false };
  });
  return { ...state, analyzedHtml: doc.body.innerHTML, modules };
}
