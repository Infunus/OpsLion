import { wordArticle } from "../word-conversion";
import { richTextToPlain } from "../template-engine";
import type { SemanticBundle } from "../semantic-agent";
import { assembleSubmission, resolveAssets } from "../submission/assemble";
import type { SourceNode, Submission, SubmissionPlan } from "../submission/types";
import { revision } from "./document";

/** Only explicit structure and exact asset references are interpreted locally. */
export function planLocalSubmission(input: Submission): Submission {
  const instructionId = `local:user-instructions:${revision(input.user_instructions.trim())}`;
  const pending = input.pending.filter((p) => !p.id.startsWith("local:user-instructions:") || p.id === instructionId);
  const requirements = (id: string, text: string, source_ids: string[] = []) => {
    if (!text.trim() || pending.some((p) => p.id === id) || input.decisions.some((d) => d.id === id)) return;
    pending.push({ id, kind: /^版式\s*[:：]/.test(text.trim()) ? "layout_preference" : "other", message: `请落实或核对要求：${text}`, candidate_ids: [], source_ids });
  };
  requirements(instructionId, input.user_instructions);
  const active = input.documents.filter((doc) => !input.files.find((f) => f.id === doc.file_id)?.disabled);
  for (const doc of active.filter((doc) => input.files.find((f) => f.id === doc.file_id)?.role === "instructions" && !input.main_document_ids.includes(doc.id))) for (const block of doc.blocks) requirements(`instruction:${block.id}`, richTextToPlain(block.content), [block.id]);
  for (const doc of active) for (const note of doc.annotations) requirements(`annotation:${note.id}`, `${doc.name} 批注：${note.text}`, note.source_ids);
  for (const file of input.files.filter((f) => !f.disabled && f.error)) requirements(`file-error:${file.id}`, `${file.relative_path} 未读取：${file.error}`);
  if (input.applied) return resolveAssets({ ...input, pending });
  if (input.mode !== "new") {
    if (!input.base_article || !input.base_draft) throw new Error("请选择基准稿后继续本地排版");
    return assembleSubmission({ ...input, pending, user_instructions: input.user_instructions }, { schema: "opslion/submission-plan/v1", mode: input.mode, base_article_id: input.base_article_id, changes: [], image_requests: [], pending: [] });
  }
  const main = active.filter((doc) => input.main_document_ids.includes(doc.id));
  if (main.length !== 1) throw new Error(active.length ? "请在交稿目录明确选择一份主稿；其他材料会继续保留。" : "请添加 Word 或文字主稿后排版。");
  const doc = main[0];
  const bundle: SemanticBundle = { request: { task: "parse_article_semantics", source: { schema: "opslion/word-snapshot/v1", document_name: doc.name, blocks: doc.blocks, warnings: doc.warnings } }, images: new Map() };
  for (const block of doc.blocks) if (block.kind === "image" && block.image_anchor_id) {
    const asset = input.assets.find((a) => a.origins.some((o) => o.document_id === doc.id && o.occurrence_id === block.image_anchor_id));
    // The request below uses the occurrence identity, never a synthetic image URL.
    if (asset) bundle.images.set(block.image_anchor_id, { id: block.id, type: "image", src: asset.storage_ref, alt: "Word 正文图片", caption: block.caption });
  }
  const article = wordArticle(bundle, input.id);
  const plan: SubmissionPlan = { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: [] }, image_requests: [], pending: [], excluded_sources: [], asset_aliases: [], relations: [] };
  const state = structuredClone(input);
  for (const node of article.nodes) {
    const block = doc.blocks.find((b) => b.id === node.id);
    const source_ids = block ? [block.id] : [];
    const text = "content" in node ? richTextToPlain(node.content).trim() : "";
    const marker = text.match(/^【(?:图片\s*[:：]\s*([^】]+)|(图\s*\d+))】$/);
    if (node.type === "image" || marker) {
      const id = `image:${node.id}`;
      const purpose = marker ? (marker[1] || marker[2]).trim() : node.type === "image" ? node.alt || "Word 正文图片" : "正文配图";
      const selector: SubmissionPlan["image_requests"][number]["selector"] = node.type === "image" ? { kind: "occurrence", document_id: doc.id, occurrence_id: block!.image_anchor_id! } : marker![1] ? { kind: "file", relative_path: marker![1].trim().replaceAll("\\", "/") } : { kind: "label", text: purpose.replace(/\s/g, ""), document_id: doc.id };
      if (selector.kind === "label") for (const asset of state.assets) if (asset.origins.some((o) => o.relative_path.split("/").at(-1)?.replace(/\.[^.]+$/, "").replace(/\s/g, "") === selector.text)) asset.aliases.push({ text: selector.text, document_id: doc.id });
      plan.image_requests.push({ id, purpose, selector, source_ids });
      plan.article!.nodes.push({ id: node.id, type: "image_ref", request_id: id, source_ids, ...(node.type === "image" ? { caption: node.caption, alt: node.alt, link_url: node.link_url } : {}) });
    } else if (node.type === "ul" || node.type === "ol") {
      plan.article!.nodes.push({ ...node, source_ids: [], items: node.items.map((item) => ({ ...item, source_ids: [item.id] })) });
    } else {
      plan.article!.nodes.push({ ...node, source_ids } as SourceNode);
      if (/【[^】]+】/.test(text)) requirements(`instruction:${node.id}`, `保留在正文中的括号说明“${text}”是否需要发表`, source_ids);
    }
  }
  // Missing embedded occurrences must also keep their original reading position.
  for (const block of doc.blocks) if (block.kind === "image" && !plan.article!.nodes.some((n) => n.id === block.id)) {
    const id = `image:${block.id}`; const following = doc.blocks.slice(doc.blocks.indexOf(block) + 1).map((b) => b.id);
    const index = plan.article!.nodes.findIndex((n) => following.includes(n.id));
    plan.article!.nodes.splice(index < 0 ? plan.article!.nodes.length : index, 0, { id: block.id, type: "image_ref", request_id: id, source_ids: [block.id] });
    plan.image_requests.push({ id, purpose: "Word 内嵌图片未读取", selector: { kind: "occurrence", document_id: doc.id, occurrence_id: block.image_anchor_id || block.id }, source_ids: [block.id] });
  }
  if (!plan.article!.nodes.some((n) => n.type === "article_title")) plan.article!.nodes.unshift({ id: `${input.id}:title`, type: "article_title", content: [], source_ids: [] });
  return assembleSubmission({ ...state, pending }, plan);
}
