import { duplicateTemplateModule, moveTemplateModule, templateSlotContexts } from "./template-clone";
import { makeId, type ArticleContent, type CloneSlot, type CloneTemplateState, type ContentSection } from "./types";

export interface AgentSourceBlock {
  id: string;
  kind: "title" | "subtitle" | "heading" | "paragraph" | "list" | "table" | "ending";
  text: string;
  order: number;
  image_anchor_ids: string[];
}

export interface AgentContentPlan {
  schema: "opslion/content-plan/v1";
  title: PlannedField;
  subtitle: PlannedField;
  lead: PlannedField;
  sections: Array<{
    plan_id: string;
    title: string;
    paragraphs: Array<{ text: string; source_block_ids: string[] }>;
    image_anchor_ids: string[];
    reason: string;
  }>;
  ending: PlannedField;
  unused_source_blocks: Array<{ id: string; reason: string }>;
  unplaced_image_anchors: Array<{ id: string; reason: string }>;
  warnings: Array<{ code: string; message: string; source_block_ids: string[] }>;
  confidence: number;
}

interface PlannedField {
  text: string;
  source_block_ids: string[];
  confidence: number;
}

type SlotTarget = { slot_id: string } | { module_ref: string; slot_index: number };

export type TemplateOperation =
  | { op: "set_text"; slot_target: SlotTarget; value: string; source_block_ids: string[]; reason: string }
  | { op: "set_link"; slot_target: SlotTarget; url: string; source_block_ids: string[]; reason: string }
  | { op: "set_image"; slot_target: SlotTarget; image_anchor_id: string; reason: string }
  | { op: "clear_image"; slot_target: SlotTarget; reason: string }
  | { op: "set_module_visibility"; module_ref: string; visible: boolean; reason: string }
  | { op: "duplicate_module"; source_module_id: string; result_ref: string; after_module_ref: string; reason: string }
  | { op: "move_module"; module_ref: string; after_module_ref: string; reason: string }
  | { op: "manual_review"; message: string; source_block_ids: string[]; module_refs: string[] };

export interface AgentTemplatePlan {
  schema: "opslion/template-plan/v1";
  base_revision: string;
  operations: TemplateOperation[];
  coverage: Array<{ source_block_id: string; operation_indexes: number[] }>;
  unresolved: Array<{ source_block_ids: string[]; image_anchor_ids?: string[]; reason: string }>;
  warnings: Array<{ code: string; message: string; module_refs: string[]; slot_ids: string[] }>;
  deferred_assets?: Array<{
    kind: "image";
    purpose: string;
    preferred_slot_id?: string;
    source_block_ids: string[];
    reason: string;
  }>;
  confidence: number;
}

export interface AgentContentRequestBundle {
  request: object;
  images: Map<string, Pick<ContentSection, "imageUrl" | "imageCaption">>;
}

function contentBlocks(content: ArticleContent) {
  const blocks: AgentSourceBlock[] = [];
  const images: Array<{ id: string; caption: string; after_block_id: string }> = [];
  const imageValues = new Map<string, Pick<ContentSection, "imageUrl" | "imageCaption">>();
  let order = 0;
  const add = (id: string, kind: AgentSourceBlock["kind"], text: string, imageAnchorIds: string[] = []) => {
    blocks.push({ id, kind, text, order: order++, image_anchor_ids: imageAnchorIds });
  };
  if (content.title.trim()) add("field:title", "title", content.title);
  if (content.subtitle.trim()) add("field:subtitle", "subtitle", content.subtitle);
  if (content.lead.trim()) add("field:lead", "paragraph", content.lead);
  content.sections.forEach((section) => {
    const headingId = `${section.id}:heading`;
    const bodyId = `${section.id}:body`;
    const anchorId = `image:${section.id}`;
    const anchors = section.imageUrl ? [anchorId] : [];
    if (section.title.trim()) add(headingId, "heading", section.title);
    add(bodyId, /(^|\n)\s*(?:[-*•]|\d+[.)、])\s+/.test(section.body) ? "list" : "paragraph", section.body, anchors);
    if (section.imageUrl) {
      images.push({ id: anchorId, caption: section.imageCaption, after_block_id: bodyId });
      imageValues.set(anchorId, { imageUrl: section.imageUrl, imageCaption: section.imageCaption });
    }
  });
  if (content.ending.trim()) add("field:ending", "ending", content.ending);
  return { blocks, images, imageValues };
}

export function createContentAgentRequest(content: ArticleContent, documentName: string, rewriteLevel: "none" | "minimal" | "polish" = "minimal"): AgentContentRequestBundle {
  const source = contentBlocks(content);
  return {
    request: {
      task: "analyze_content",
      policy: { rewrite_level: rewriteLevel, allow_merge: true, allow_split: true, target_section_count: null, preserve_order: true },
      source: { document_name: documentName, blocks: source.blocks, images: source.images },
    },
    images: source.imageValues,
  };
}

export function canApplyContentPlan(plan: AgentContentPlan) {
  return plan.unused_source_blocks.length === 0
    && plan.unplaced_image_anchors.length === 0
    && !plan.warnings.some((item) => ["possible_text_loss", "conflicting_facts"].includes(item.code));
}

export function applyContentPlan(plan: AgentContentPlan, images: Map<string, Pick<ContentSection, "imageUrl" | "imageCaption">>): ArticleContent {
  if (!canApplyContentPlan(plan)) throw new Error("计划仍含未处理内容，不能自动应用");
  const sections: ContentSection[] = [];
  plan.sections.forEach((planned) => {
    const assigned = planned.image_anchor_ids.map((id) => images.get(id)).filter(Boolean) as Array<Pick<ContentSection, "imageUrl" | "imageCaption">>;
    const [firstImage, ...extraImages] = assigned;
    sections.push({
      id: makeId("section"),
      title: planned.title,
      body: planned.paragraphs.map((item) => item.text).filter(Boolean).join("\n\n"),
      imageUrl: firstImage?.imageUrl || "",
      imageCaption: firstImage?.imageCaption || "",
      visible: true,
    });
    extraImages.forEach((image) => sections.push({ id: makeId("section"), title: "", body: "", ...image, visible: true }));
  });
  return { title: plan.title.text, subtitle: plan.subtitle.text, lead: plan.lead.text, sections, ending: plan.ending.text };
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function templateRevision(state: CloneTemplateState) {
  return `tpl-${stableHash(JSON.stringify({ html: state.analyzedHtml, slots: state.slots, modules: state.modules }))}`;
}

function templateSlotDetails(state: CloneTemplateState) {
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const contexts = templateSlotContexts(state);
  return state.slots.map((slot) => {
    const element = doc.querySelector(`[data-layout-slot="${CSS.escape(slot.id)}"]`);
    const moduleElement = element?.closest<HTMLElement>("[data-layout-module]");
    const moduleId = moduleElement?.dataset.layoutModule || state.modules[0]?.id || "";
    const index = [...(moduleElement?.querySelectorAll<HTMLElement>("[data-layout-slot]") || [])]
      .findIndex((item) => item.dataset.layoutSlot === slot.id);
    return {
      id: slot.id,
      module_id: moduleId,
      index_in_module: Math.max(0, index),
      group_id: contexts[slot.id]?.groupId || `${moduleId}:group-${Math.max(0, index) + 1}`,
      group_index: contexts[slot.id]?.groupIndex ?? Math.max(0, index),
      index_in_group: contexts[slot.id]?.indexInGroup ?? 0,
      group_text: contexts[slot.id]?.groupText || slot.value,
      module_label: contexts[slot.id]?.moduleLabel || state.modules.find((module) => module.id === moduleId)?.label || "",
      kind: slot.kind,
      role: slot.kind === "text" ? "content" : slot.role || "unknown",
      label: slot.label,
      current_value: slot.value,
      current_link: slot.linkUrl || "",
    };
  });
}

export function createTemplateAgentRequest(content: ArticleContent, state: CloneTemplateState) {
  const source = contentBlocks(content);
  const details = templateSlotDetails(state);
  const request = {
    task: "plan_template_operations",
    policy: { allow_duplicate: true, allow_hide: true, allow_reorder: true, allow_link_change: true, allow_content_image_change: details.some((slot) => slot.role === "content_image"), allow_deferred_assets: true },
    article: {
      blocks: source.blocks.map((block) => ({ id: block.id, kind: block.kind, text: block.text, image_anchor_ids: block.image_anchor_ids })),
      images: source.images.map((image) => ({ id: image.id, caption: image.caption, source: "user-document" })),
    },
    template: {
      revision: templateRevision(state),
      modules: state.modules.map((module, index) => ({
        id: module.id,
        label: module.label,
        order: index,
        included: module.included,
        role: details.some((slot) => slot.module_id === module.id && (slot.kind === "text" || slot.role === "content_image")) ? "content" : "decoration",
        can_duplicate: details.some((slot) => slot.module_id === module.id && (slot.kind === "text" || slot.role === "content_image")),
        slot_ids: details.filter((slot) => slot.module_id === module.id).map((slot) => slot.id),
      })),
      slots: details,
    },
  };
  return { request, images: source.imageValues };
}

function resolveModuleId(value: string, refs: Map<string, string>, state: CloneTemplateState) {
  if (state.modules.some((module) => module.id === value)) return value;
  return refs.get(value) || "";
}

function resolveSlot(state: CloneTemplateState, target: SlotTarget, refs: Map<string, string>): CloneSlot | undefined {
  if ("slot_id" in target) return state.slots.find((slot) => slot.id === target.slot_id);
  const moduleId = resolveModuleId(target.module_ref, refs, state);
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const moduleElement = doc.querySelector(`[data-layout-module="${CSS.escape(moduleId)}"]`);
  const slotId = [...(moduleElement?.querySelectorAll<HTMLElement>("[data-layout-slot]") || [])][target.slot_index]?.dataset.layoutSlot;
  return state.slots.find((slot) => slot.id === slotId);
}

export function canApplyTemplatePlan(plan: AgentTemplatePlan) {
  return plan.unresolved.length === 0 && !plan.operations.some((item) => item.op === "manual_review");
}

export function applyTemplatePlan(state: CloneTemplateState, plan: AgentTemplatePlan, images: Map<string, Pick<ContentSection, "imageUrl" | "imageCaption">>) {
  if (plan.base_revision !== templateRevision(state)) throw new Error("模板已发生变化，请重新规划");
  if (!canApplyTemplatePlan(plan)) throw new Error("计划仍含需要人工处理的内容，不能自动应用");
  let next = state;
  const refs = new Map<string, string>();
  for (const operation of plan.operations) {
    if (operation.op === "duplicate_module") {
      const before = new Set(next.modules.map((module) => module.id));
      next = duplicateTemplateModule(next, operation.source_module_id);
      const created = next.modules.find((module) => !before.has(module.id));
      if (!created) throw new Error("复制模板模块失败");
      refs.set(operation.result_ref, created.id);
      const afterId = resolveModuleId(operation.after_module_ref, refs, next);
      if (afterId && afterId !== created.id) next = moveTemplateModule(next, created.id, afterId);
    } else if (operation.op === "move_module") {
      const moduleId = resolveModuleId(operation.module_ref, refs, next);
      const afterId = resolveModuleId(operation.after_module_ref, refs, next);
      next = moveTemplateModule(next, moduleId, afterId);
    } else if (operation.op === "set_module_visibility") {
      const moduleId = resolveModuleId(operation.module_ref, refs, next);
      next = { ...next, modules: next.modules.map((module) => module.id === moduleId ? { ...module, included: operation.visible } : module) };
    } else if (operation.op === "set_text" || operation.op === "set_link" || operation.op === "set_image" || operation.op === "clear_image") {
      const slot = resolveSlot(next, operation.slot_target, refs);
      if (!slot) throw new Error("Agent 计划引用了不存在的槽位");
      next = {
        ...next,
        slots: next.slots.map((item) => {
          if (item.id !== slot.id) return item;
          if (operation.op === "set_text") return { ...item, value: operation.value };
          if (operation.op === "set_link") return { ...item, linkUrl: operation.url };
          if (operation.op === "clear_image") return { ...item, value: "" };
          const image = images.get(operation.image_anchor_id);
          if (!image) throw new Error("Agent 计划引用了不存在的文案图片");
          return { ...item, value: image.imageUrl };
        }),
      };
    }
  }
  return {
    ...next,
    draftWarnings: [],
    pendingAssets: (plan.deferred_assets || []).map((asset) => ({
      id: makeId("asset"),
      kind: asset.kind,
      purpose: asset.purpose,
      preferredSlotId: asset.preferred_slot_id,
      reason: asset.reason,
    })),
  };
}
