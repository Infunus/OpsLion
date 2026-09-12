import { adaptLegacyArticle, plainRichText, richTextToPlain, type ArticleNode, type ParsedArticle } from "../template-engine";
import { templateSlotContexts } from "../template-clone";
import type { CloneTemplateState, StudioProject } from "../types";
import type { Submission } from "./types";
import { addArticleAssets } from "./ingest";
import { bindAsset, cancelImageRequest, imageRequestNodes, projectDraft } from "./assemble";
import { readSlotRichText, writeNativeText } from "./native-text";

export function captureBaseline(state: Submission, project: StudioProject): Submission {
  const prior = project.submission?.applied || project.submission?.base_draft ? project.submission : undefined;
  const missing = (prior?.draft?.nodes ?? prior?.base_draft)?.filter((node) => node.type === "image_ref") ?? [];
  let article: ParsedArticle; let native_bindings: Submission["native_bindings"];
  if (project.mode === "clone" && project.cloneTemplate) {
    native_bindings = {};
    const doc = new DOMParser().parseFromString(project.cloneTemplate.analyzedHtml, "text/html");
    const contexts = templateSlotContexts(project.cloneTemplate); const groups = new Map<string, string[]>();
    const nodes: ArticleNode[] = [{ id: "native:empty-title", type: "article_title", content: [] }];
    const visible = (element: Element) => !project.cloneTemplate!.modules.some((module) => !module.included && module.id === element.closest("[data-layout-module]")?.getAttribute("data-layout-module"));
    const ordered = [...doc.querySelectorAll("[data-layout-slot]")].filter(visible).map((element) => project.cloneTemplate!.slots.find((slot) => slot.id === element.getAttribute("data-layout-slot"))).filter((slot) => slot !== undefined);
    for (const slot of ordered) {
      if (slot.role === "decoration") continue;
      if (slot.kind === "image") {
        if (!slot.value) {
          const pending = missing.find((node) => prior?.native_bindings?.[node.id]?.slot_ids.includes(slot.id));
          if (pending) { nodes.push({ id: pending.id, type: "paragraph", content: plainRichText("【待补图片】") }); native_bindings[pending.id] = { slot_ids: [slot.id], kind: "image" }; }
          continue;
        }
        const priorId = Object.entries(prior?.native_bindings ?? {}).find(([, binding]) => binding.kind === "image" && binding.slot_ids.includes(slot.id))?.[0];
        const id = priorId ?? `native:${slot.id}`;
        nodes.push({ id, type: "image", src: slot.value, alt: slot.label, caption: [], ...(slot.linkUrl ? { link_url: slot.linkUrl } : {}) });
        native_bindings[id] = { slot_ids: [slot.id], kind: "image" };
      } else {
        const group = contexts[slot.id]?.groupId ?? slot.id;
        const existing = groups.get(group);
        if (existing) { existing.push(slot.id); continue; }
        const slots = [slot.id]; groups.set(group, slots);
        const id = `native:${group}`; native_bindings[id] = { slot_ids: slots, kind: "text" };
        nodes.push({ id, type: "paragraph", content: [] });
      }
    }
    for (const node of nodes) {
      if (node.type !== "paragraph" || native_bindings[node.id].kind !== "text") continue;
      node.content = native_bindings[node.id].slot_ids.flatMap((id) => {
        const slot = project.cloneTemplate!.slots.find((item) => item.id === id)!;
        return readSlotRichText(doc, slot);
      });
    }
    const native = [...doc.querySelectorAll("svg text, svg image")].filter(visible);
    for (const [index, element] of native.entries()) {
      if (element.hasAttribute("data-layout-slot")) continue;
      const path: number[] = []; let cursor: Element = element;
      while (cursor !== doc.body && cursor.parentElement) { path.unshift([...cursor.parentElement.children].indexOf(cursor)); cursor = cursor.parentElement; }
      const id = `native:svg-${index}`;
      if (element.localName === "text") { nodes.push({ id, type: "paragraph", content: plainRichText(element.textContent ?? "") }); native_bindings[id] = { slot_ids: [], kind: "text", native_path: path }; }
      else { const src = element.getAttribute("href") || element.getAttribute("xlink:href"); if (src) { nodes.push({ id, type: "image", src, alt: "原生 SVG 配图", caption: [] }); native_bindings[id] = { slot_ids: [], kind: "image", native_path: path }; } }
    }
    article = { schema: "opslion.article/v1", id: project.id, nodes };
  } else article = { ...(project.layout?.article ?? adaptLegacyArticle(project.content, project.id)), id: project.id };
  if (native_bindings && prior?.native_bindings) for (const node of missing) if (prior.native_bindings[node.id]) native_bindings[node.id] = prior.native_bindings[node.id];
  const base_draft = article.nodes.map((node) => missing.find((item) => item.id === node.id) ?? node);
  for (const node of missing) if (!base_draft.some((item) => item.id === node.id)) base_draft.push(node);
  const next = addArticleAssets({ ...state, base_article_id: project.id, base_article: structuredClone(article), native_bindings,
    files: state.files.length ? state.files : prior?.files ?? [], documents: state.documents.length ? state.documents : prior?.documents ?? [],
    main_document_ids: state.main_document_ids.length ? state.main_document_ids : prior?.main_document_ids ?? [],
    base_draft, inherited_requests: prior?.plan?.image_requests ?? prior?.inherited_requests, image_requests_by_node: prior?.image_requests_by_node,
    pending: state.id === prior?.id ? state.pending : prior?.pending ?? state.pending, bindings: prior?.bindings ?? state.bindings,
    assets: [...state.assets, ...(prior?.assets.filter((a) => !state.assets.some((item) => item.id === a.id)) ?? [])] }, article, project.name);
  return { ...next, decisions: state.id === prior?.id ? state.decisions : [...(prior?.decisions ?? []), ...state.decisions], publishing: { ...project.submission?.publishing }, assets: [...next.assets, ...(project.submission?.assets.filter((asset) => asset.id === project.submission?.publishing.cover_asset_id && !next.assets.some((a) => a.id === asset.id)) ?? [])] };
}

export function syncNativeEdits(state: Submission, previous: CloneTemplateState, next: CloneTemplateState): Submission {
  if (!state.draft && state.base_draft && state.base_article) {
    const updated = syncNativeEdits({ ...state, draft: { id: state.base_article.id, nodes: state.base_draft } }, previous, next);
    return { ...updated, draft: undefined, base_draft: updated.draft!.nodes, base_article: projectDraft(updated) };
  }
  if (!state.draft || !state.native_bindings) return state;
  let result = structuredClone(state);
  const removed = new Set(previous.modules.filter((m) => m.included && !next.modules.some((n) => n.id === m.id && n.included)).map((m) => m.id));
  if (removed.size) {
    const doc = new DOMParser().parseFromString(previous.analyzedHtml, "text/html");
    const deleted = new Set(Object.entries(state.native_bindings).filter(([, binding]) => {
      const elements = binding.native_path ? [binding.native_path.reduce<Element | undefined>((e, index) => e?.children[index], doc.body)] : binding.slot_ids.map((id) => [...doc.querySelectorAll("[data-layout-slot]")].find((e) => e.getAttribute("data-layout-slot") === id));
      return elements.length > 0 && elements.every((e) => removed.has(e?.closest("[data-layout-module]")?.getAttribute("data-layout-module") ?? ""));
    }).map(([id]) => id));
    for (const node of state.draft.nodes) if (deleted.has(node.id) && node.type === "image_ref") result = cancelImageRequest(result, node.request_id);
    result.draft!.nodes = result.draft!.nodes.filter((node) => !deleted.has(node.id));
  }
  for (const [id, binding] of Object.entries(state.native_bindings)) {
    if (!binding.slot_ids.some((slotId) => JSON.stringify(previous.slots.find((s) => s.id === slotId)) !== JSON.stringify(next.slots.find((s) => s.id === slotId)))) continue;
    const slots = binding.slot_ids.map((slotId) => next.slots.find((s) => s.id === slotId)).filter((s) => s !== undefined);
    const node = result.draft!.nodes.find((n) => n.id === id); if (!node || !slots.length) continue;
    if (binding.kind === "text" && "content" in node) { const doc = new DOMParser().parseFromString(next.analyzedHtml, "text/html"); node.content = slots.flatMap((slot) => readSlotRichText(doc, slot)); }
    if (binding.kind === "image" && slots[0].value) {
      if (node.type === "image") {
        node.src = slots[0].value; node.link_url = slots[0].linkUrl || undefined;
        const requestId = imageRequestNodes(result)[node.id];
        if (requestId) { const assetId = `${requestId}:manual`; result.assets = [...result.assets.filter((a) => a.id !== assetId), { id: assetId, storage_ref: node.src, media_type: "image/*", origins: [], aliases: [] }]; result.bindings[requestId] = { status: "bound", asset_id: assetId, chosen_by: "user" }; }
      }
      else if (node.type === "image_ref" && previous.slots.find((s) => s.id === slots[0].id)?.value !== slots[0].value) {
        const assetId = `${node.request_id}:manual`; result.assets = [...result.assets.filter((a) => a.id !== assetId), { id: assetId, storage_ref: slots[0].value, media_type: "image/*", origins: [], aliases: [] }]; result = bindAsset(result, node.request_id, assetId);
      }
    }
  }
  return result;
}

export function applyNativeDraft(template: CloneTemplateState, state: Submission): CloneTemplateState {
  if (!state.native_bindings || !state.draft) return template;
  const permitted = new Set(["set_content", "set_image", "set_image_meta"]);
  if (state.plan?.changes?.some((change) => !permitted.has(change.op))) throw new Error("原生 HTML/SVG 基准仅支持局部文字和图片修改；结构重组请先使用语义稿");
  const next = structuredClone(template);
  const doc = new DOMParser().parseFromString(next.analyzedHtml, "text/html");
  for (const node of state.draft.nodes) {
    const binding = state.native_bindings[node.id]; if (!binding) continue;
    const before = state.base_article?.nodes.find((n) => n.id === node.id);
    if (JSON.stringify(before) === JSON.stringify(node)) continue;
    if (binding.kind === "image" && (node.type === "image" || node.type === "image_ref") && before?.type === "image") {
      if (JSON.stringify(node.caption ?? []) !== JSON.stringify(before.caption ?? []) || node.alt !== before.alt) throw new Error("原生图片的图注与描述没有可靠内容绑定，请在原生编辑器中修改对应内容");
      if (binding.native_path && node.link_url !== before.link_url) throw new Error("原生 SVG 图片链接没有可靠内容绑定，请在原生编辑器中修改");
    }
    if (binding.native_path) {
      const element = binding.native_path.reduce<Element | undefined>((parent, index) => parent?.children[index], doc.body);
      if (!element) throw new Error("原生 SVG 绑定已失效");
      if (binding.kind === "text" && "content" in node) {
        const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT); const texts: Text[] = []; while (walker.nextNode()) texts.push(walker.currentNode as Text);
        if (texts.length > 1) throw new Error("此 SVG 文字有多个样式分段，请在原生编辑器中逐段修改，避免强调范围错位");
        if (texts.length) texts[0].data = richTextToPlain(node.content); else element.textContent = richTextToPlain(node.content);
      } else if (node.type === "image") {
        if (element.hasAttribute("xlink:href")) element.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", node.src); else element.setAttribute("href", node.src);
      }
      continue;
    }
    const slots = binding.slot_ids.map((id) => { const slot = next.slots.find((s) => s.id === id); if (!slot) throw new Error("原生内容绑定已失效，请重新选择基准"); return slot; });
    if (binding.kind === "image") {
      if (node.type === "image_ref") continue;
      if (node.type !== "image") throw new Error("原生图片目标不能变成文字");
      slots[0].value = node.src; slots[0].linkUrl = node.link_url ?? "";
      if (node.caption?.length && JSON.stringify(node.caption) !== JSON.stringify(before?.type === "image" ? before.caption : [])) throw new Error("原生图片图注没有可靠绑定，请在原生编辑器中修改图注文字");
    } else {
      if (!("content" in node)) throw new Error("原生文字目标类型不匹配");
      writeNativeText(doc, slots, node.content);
    }
  }
  next.analyzedHtml = doc.body.innerHTML;
  return next;
}
