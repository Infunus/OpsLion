import { templateSlotContexts } from "./template-clone";
import { makeId, type ArticleContent, type CloneSlot, type CloneTemplateState, type PendingTemplateAsset } from "./types";
import { plainRichText, richTextToPlain, type ParsedArticle } from "./template-engine";
import { writeNativeText } from "./submission/native-text";
import type { Submission, DraftNode } from "./submission/types";
import { insertNativeModule } from "./canvas/native-model";

interface ArticleSegment {
  id: string;
  kind: "title" | "heading" | "body" | "ending";
  text: string;
}

interface TextGroup {
  id: string;
  slots: CloneSlot[];
  originalText: string;
}

export interface LocalTemplateFillReport {
  changedSlots: number;
  mappedSegments: number;
  unmatchedSegments: number;
  clearedHistoricalGroups: number;
  preservedDecorativeGroups: number;
  assignedImages: number;
  pendingImages: number;
  lowConfidenceMatches: number;
}

const compact = (value: string) => value.replace(/\s+/g, " ").trim();
const compareText = (value: string) => value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

function paragraphs(value: string) {
  return value.split(/\n\s*\n|\n+/).map(compact).filter(Boolean);
}

function articleSegments(content: ArticleContent): ArticleSegment[] {
  const result: ArticleSegment[] = [];
  const add = (id: string, kind: ArticleSegment["kind"], text: string) => {
    paragraphs(text).forEach((paragraph, index) => result.push({ id: `${id}:${index}`, kind, text: paragraph }));
  };
  add("title", "title", content.title);
  add("subtitle", "heading", content.subtitle);
  add("lead", "body", content.lead);
  content.sections.filter((section) => section.visible).forEach((section) => {
    add(`${section.id}:heading`, "heading", section.title);
    add(`${section.id}:body`, "body", section.body);
  });
  add("ending", "ending", content.ending);
  return result;
}

function textGroups(state: CloneTemplateState, includeEmpty = false): TextGroup[] {
  const contexts = templateSlotContexts(state);
  const groups = new Map<string, TextGroup>();
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const slots = new Map(state.slots.map((slot) => [slot.id, slot]));
  [...doc.querySelectorAll("[data-layout-slot]")].filter((el) => !state.modules.some((module) => !module.included && module.id === el.closest("[data-layout-module]")?.getAttribute("data-layout-module"))).map((el) => slots.get(el.getAttribute("data-layout-slot")!)).filter((slot) => slot?.kind === "text").forEach((slot, index) => {
    if (!slot) return;
    const id = contexts[slot.id]?.groupId || `slot-group-${index}`;
    const existing = groups.get(id) || { id, slots: [], originalText: "" };
    existing.slots.push(slot);
    existing.originalText = compact(`${existing.originalText}${slot.prefix || ""}${slot.originalValue}${slot.suffix || ""}`);
    groups.set(id, existing);
  });
  return [...groups.values()].filter((group) => includeEmpty || group.originalText);
}

function bigrams(value: string) {
  if (value.length < 2) return new Set(value ? [value] : []);
  return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)));
}

function similarity(leftValue: string, rightValue: string) {
  const left = compareText(leftValue);
  const right = compareText(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  let overlap = 0;
  leftPairs.forEach((pair) => { if (rightPairs.has(pair)) overlap += 1; });
  const dice = (2 * overlap) / Math.max(1, leftPairs.size + rightPairs.size);
  const lengthRatio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
  const contains = left.includes(right) || right.includes(left) ? 0.16 : 0;
  return Math.min(1, dice * 0.72 + lengthRatio * 0.18 + contains);
}

function nearestTextBoundary(text: string, desired: number, minimum: number) {
  let best = Math.max(minimum, Math.min(text.length, desired));
  let distance = Number.POSITIVE_INFINITY;
  for (let index = Math.max(minimum, desired - 10); index <= Math.min(text.length, desired + 10); index += 1) {
    const before = text[index - 1] || "";
    const after = text[index] || "";
    if (!/[，。！？；：、,.;:!?\s]/.test(before) && !/[\s]/.test(after)) continue;
    const candidateDistance = Math.abs(index - desired);
    if (candidateDistance < distance) {
      best = index;
      distance = candidateDistance;
    }
  }
  return best;
}

function splitByWeights(text: string, weights: number[]) {
  if (weights.length <= 1) return [text];
  const total = weights.reduce((sum, value) => sum + Math.max(1, value), 0);
  const result: string[] = [];
  let start = 0;
  let cumulative = 0;
  weights.slice(0, -1).forEach((weight) => {
    cumulative += Math.max(1, weight);
    const desired = Math.round((cumulative / total) * text.length);
    const end = nearestTextBoundary(text, desired, start);
    result.push(text.slice(start, end).trim());
    start = end;
  });
  result.push(text.slice(start).trim());
  return result;
}

function preserveUnmatchedGroup(text: string) {
  const normalized = compact(text);
  return normalized.length <= 28 && (/^[A-Za-z\s&·|/]+$/.test(normalized) || !/[\p{L}\p{N}]/u.test(normalized));
}

function fillGroups(groups: TextGroup[], text: string, values: Map<string, string>) {
  const groupParts = splitByWeights(text, groups.map((group) => compareText(group.originalText).length));
  groups.forEach((group, groupIndex) => {
    const slotParts = splitByWeights(groupParts[groupIndex] || "", group.slots.map((slot) => compareText(slot.originalValue).length));
    group.slots.forEach((slot, slotIndex) => values.set(slot.id, slotParts[slotIndex] || ""));
  });
}

function pendingImageAssets(content: ArticleContent, assigned: number): PendingTemplateAsset[] {
  return content.sections
    .filter((section) => section.visible && section.imageUrl.trim())
    .slice(assigned)
    .map((section) => ({
      id: makeId("asset"),
      kind: "image" as const,
      purpose: section.imageCaption || section.title || "文案配图",
      reason: "没有已确认的内容图片槽，请在逐项替换中指定后补位置",
      imageUrl: section.imageUrl,
      imageCaption: section.imageCaption,
    }));
}

export function fillTemplateLocally(content: ArticleContent, state: CloneTemplateState) {
  const segments = articleSegments(content);
  const groups = textGroups(state);
  const values = new Map<string, string>();
  const usedGroups = new Set<string>();
  let cursor = 0;
  let mappedSegments = 0;
  let unmatchedSegments = 0;
  let lowConfidenceMatches = 0;
  const unplacedContent: NonNullable<CloneTemplateState["unplacedContent"]> = [];

  segments.forEach((segment) => {
    if (cursor >= groups.length) {
      unmatchedSegments += 1;
      unplacedContent.push(segment);
      return;
    }
    let best: { start: number; span: number; score: number } | null = null;
    const searchEnd = Math.min(groups.length, cursor + 24);
    for (let start = cursor; start < searchEnd; start += 1) {
      for (let span = 1; span <= Math.min(4, groups.length - start); span += 1) {
        const oldText = groups.slice(start, start + span).map((group) => group.originalText).join("");
        let score = similarity(segment.text, oldText) - (start - cursor) * 0.007 - (span - 1) * 0.012;
        if ((segment.kind === "title" || segment.kind === "heading") && compareText(oldText).length <= 36) score += 0.06;
        if (!best || score > best.score) best = { start, span, score };
      }
    }

    if (!best || best.score < 0.2) {
      let span = 1;
      let capacity = compareText(groups[cursor].originalText).length;
      const target = compareText(segment.text).length;
      while (span < 4 && cursor + span < groups.length && capacity < target * 0.72) {
        capacity += compareText(groups[cursor + span].originalText).length;
        span += 1;
      }
      best = { start: cursor, span, score: 0 };
    }

    const selected = groups.slice(best.start, best.start + best.span);
    fillGroups(selected, segment.text, values);
    selected.forEach((group) => usedGroups.add(group.id));
    cursor = best.start + best.span;
    mappedSegments += 1;
    if (best.score < 0.36) lowConfidenceMatches += 1;
  });

  let clearedHistoricalGroups = 0;
  let preservedDecorativeGroups = 0;
  groups.forEach((group) => {
    if (usedGroups.has(group.id)) return;
    if (preserveUnmatchedGroup(group.originalText)) {
      preservedDecorativeGroups += 1;
      return;
    }
    group.slots.forEach((slot) => values.set(slot.id, ""));
    clearedHistoricalGroups += 1;
  });

  const articleImages = content.sections.filter((section) => section.visible && section.imageUrl.trim());
  const imageSlots = state.slots.filter((slot) => slot.kind === "image" && slot.role === "content_image");
  const assignedImages = Math.min(articleImages.length, imageSlots.length);
  imageSlots.forEach((slot, index) => values.set(slot.id, articleImages[index]?.imageUrl || ""));
  const pendingAssets = pendingImageAssets(content, assignedImages);

  const warnings: string[] = [];
  if (lowConfidenceMatches) warnings.push(`${lowConfidenceMatches} 个文本块仅按顺序套入，请重点检查标题与强调文字`);
  if (unmatchedSegments) warnings.push(`${unmatchedSegments} 个文案块超出模板容量，尚未写入模板`);
  if (clearedHistoricalGroups) warnings.push(`已清空 ${clearedHistoricalGroups} 个没有可靠新文案对应的历史文本组，避免混入往年信息`);
  if (pendingAssets.length) warnings.push(`${pendingAssets.length} 张文案图片没有已确认的内容图片槽，已列为待补素材`);

  const next: CloneTemplateState = {
    ...state,
    slots: state.slots.map((slot) => values.has(slot.id) ? { ...slot, value: values.get(slot.id) || "" } : slot),
    pendingAssets,
    draftWarnings: warnings,
    unplacedContent,
  };
  const changedSlots = next.slots.filter((slot) => slot.value !== slot.originalValue).length;
  return {
    state: next,
    report: {
      mappedSegments,
      unmatchedSegments,
      clearedHistoricalGroups,
      preservedDecorativeGroups,
      assignedImages,
      pendingImages: pendingAssets.length,
      lowConfidenceMatches,
      changedSlots,
    } as LocalTemplateFillReport,
  };
}

/** A new submission keeps the selected historical template and records every source. */
export function fillArticleTemplate(article: ParsedArticle, template: CloneTemplateState, draft?: DraftNode[]) {
  const state = structuredClone(template);
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const groups = textGroups(state, true).filter((group) => group.slots.every((s) => s.role !== "decoration"));
  const images = state.slots.filter((slot) => slot.kind === "image" && slot.role === "content_image");
  const slotOrder = new Map([...doc.querySelectorAll("[data-layout-slot]")].map((element, index) => [element.getAttribute("data-layout-slot"), index]));
  const positions = [...groups.map((group) => ({ kind: "text", order: slotOrder.get(group.slots[0]?.id) ?? Infinity })), ...images.map((slot) => ({ kind: "image", order: slotOrder.get(slot.id) ?? Infinity }))].sort((a, b) => a.order - b.order);
  const native_bindings: NonNullable<Submission["native_bindings"]> = {};
  state.unplacedContent = []; state.pendingAssets = []; state.draftWarnings = [];
  for (const group of groups) for (const slot of group.slots) { slot.value = ""; slot.linkUrl = ""; delete slot.richContent; }
  images.forEach((slot) => { slot.value = ""; slot.linkUrl = ""; });
  let textIndex = 0, imageIndex = 0, positionIndex = 0;
  for (const node of draft ?? article.nodes) {
    if (node.type === "divider") { state.unplacedContent.push({ id: node.id, kind: "divider", text: "分割线" }); continue; }
    if (node.type === "image" || node.type === "image_ref") {
      const slot = positions[positionIndex]?.kind === "image" ? images[imageIndex++] : undefined;
      if (slot) positionIndex++;
      if (slot) { slot.value = node.type === "image" ? node.src : ""; slot.linkUrl = node.link_url ?? ""; native_bindings[node.id] = { kind: "image", slot_ids: [slot.id] }; }
      else state.pendingAssets.push({ id: node.id, kind: "image", purpose: node.alt || "正文配图", imageUrl: node.type === "image" ? node.src : undefined, imageCaption: richTextToPlain(node.caption ?? []), reason: "模板没有符合此处阅读顺序的内容图片位置，请添加或调整图片模块" });
      continue;
    }
    const content = "content" in node ? node.content : node.items.flatMap((item, index) => [...(index ? [{ break: true as const }] : []), { text: node.type === "ol" ? `${node.start + index}. ` : "• " }, ...item.content]);
    if (!richTextToPlain(content)) continue;
    const group = positions[positionIndex]?.kind === "text" ? groups[textIndex++] : undefined;
    if (group) positionIndex++;
    if (group) {
      try { writeNativeText(doc, group.slots, content); native_bindings[node.id] = { kind: "text", slot_ids: group.slots.map((slot) => slot.id) }; continue; }
      catch { /* Retain the complete source in the actionable queue. */ }
    }
    state.unplacedContent.push({ id: node.id, kind: node.type, text: richTextToPlain(content), content });
    if (positions[positionIndex]?.kind === "image" && !state.draftWarnings.includes("模板图文顺序与新稿不一致，未适配的内容已保留在未排清单")) state.draftWarnings.push("模板图文顺序与新稿不一致，未适配的内容已保留在未排清单");
  }
  state.analyzedHtml = doc.body.innerHTML;
  return { state, native_bindings };
}

export function placeUnplacedContent(template: CloneTemplateState, id: string, moduleId?: string) {
  const source = template.unplacedContent?.find((item) => item.id === id);
  if (!source) throw new Error("该文案已处理");
  if (source.kind === "divider") { const next = insertNativeModule(template, "divider", template.modules.at(-1)?.id ?? null, "after").state; return { ...next, unplacedContent: next.unplacedContent?.filter((item) => item.id !== id) }; }
  const added = insertNativeModule(template, moduleId || "paragraph", template.modules.at(-1)?.id ?? null, "after");
  const state = structuredClone(added.state);
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const root = doc.querySelector(`[data-layout-module="${CSS.escape(added.id)}"]`)!;
  const ids = new Set([...root.querySelectorAll("[data-layout-slot]")].map((element) => element.getAttribute("data-layout-slot")));
  const slots = state.slots.filter((slot) => ids.has(slot.id) && slot.kind === "text");
  if (!slots.length) throw new Error("所选模块没有文字位置，请选择正文模块");
  // A copied multi-paragraph module is ambiguous; let the user choose a smaller module.
  writeNativeText(doc, slots, source.content ?? plainRichText(source.text));
  state.analyzedHtml = doc.body.innerHTML;
  state.unplacedContent = state.unplacedContent?.filter((item) => item.id !== id);
  return state;
}

export function templateContentBlockers(template?: CloneTemplateState | null) {
  return [...(template?.unplacedContent?.map((item) => `文案未排入：${item.text.slice(0, 60)}`) ?? []), ...(template?.pendingAssets?.map((asset) => `配图未排入：${asset.purpose}`) ?? [])];
}
