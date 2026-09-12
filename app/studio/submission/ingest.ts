import { makeId } from "../types";
import { extractWordSnapshot } from "../word-snapshot";
import { plainRichText } from "../template-engine";
import type { Asset, Submission } from "./types";
import { wordConversions } from "../word-conversion";

const mimeOf = (name: string) => ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain", md: "text/markdown" } as Record<string, string>)[name.split(".").pop()?.toLowerCase() ?? ""];
const asData = (file: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
export function emptySubmission(mode: Submission["mode"] = "new"): Submission {
  return { schema: "opslion/submission/v1", id: makeId("submission"), mode, user_instructions: "", files: [], documents: [], main_document_ids: [], assets: [], revision_view: "accepted", bindings: {}, pending: [], publishing: {}, applied: false, decisions: [] };
}
export async function ingestFiles(previous: Submission, input: File[]): Promise<Submission> {
  const submission = structuredClone(previous);
  const files: Array<{ file: File; path: string }> = [];
  let expanded = 0;
  const registerError = (path: string, error: string) => submission.files.push({ id: makeId("file"), relative_path: path, media_type: "application/octet-stream", role: "reference", error });
  for (const file of input) {
    if (file.size > 50 * 1024 * 1024) { registerError(file.name, "单个文件超过 50MB"); continue; }
    if (!/\.zip$/i.test(file.name)) { files.push({ file, path: file.webkitRelativePath || file.name }); continue; }
    try {
      const { default: JSZip } = await import("jszip"); const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const entries = Object.values(zip.files).filter((entry) => !entry.dir && !entry.name.startsWith("__MACOSX/") && !/(^|\/)\.(DS_Store|_)/.test(entry.name));
      if (entries.length > 300) throw new Error("ZIP 内文件超过 300 个");
      for (const entry of entries) {
        const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
        if (/^[\\/]|^[A-Za-z]:/.test(original) || original.replaceAll("\\", "/").split("/").includes("..")) { registerError(original, "不接受越出交稿目录的路径"); continue; }
        const path = original.replaceAll("\\", "/");
        const mime = mimeOf(path);
        if (!mime) { registerError(path, "不支持此文件格式，未读取"); continue; }
        const data = await entry.async("uint8array"); expanded += data.byteLength;
        if (expanded > 100 * 1024 * 1024) throw new Error("ZIP 展开内容超过 100MB");
        files.push({ file: new File([data as BlobPart], path.split("/").pop()!, { type: mime }), path });
      }
    } catch (error) { registerError(file.name, error instanceof Error ? error.message : "ZIP 无法读取或已加密"); }
  }
  for (const { file, path } of files) {
    const fileId = makeId("file"); const mime = mimeOf(path);
    const role = mime?.startsWith("image/") ? "asset" : /\.(txt|md)$/i.test(path) ? "instructions" : "reference";
    const record: Submission["files"][number] = { id: fileId, relative_path: path, media_type: mime || file.type || "application/octet-stream", role };
    submission.files.push(record);
    try {
      if (mime?.startsWith("image/")) {
        const storage_ref = await asData(new Blob([await file.arrayBuffer()], { type: mime }));
        submission.assets.push({ id: makeId("asset"), storage_ref, media_type: mime, origins: [{ file_id: fileId, relative_path: path }], aliases: [{ text: path }] });
      } else if (/\.docx$/i.test(path)) {
        const documentId = fileId;
        const bundle = await extractWordSnapshot(file, { revisionView: submission.revision_view, collectAnnotations: true });
        const prefix = (id: string) => `${documentId}:${id}`;
        const blocks = bundle.request.source.blocks.map((block) => ({ ...block, id: prefix(block.id), image_anchor_id: block.image_anchor_id ? prefix(block.image_anchor_id) : undefined, clues: { ...block.clues, paragraph_id: block.clues.paragraph_id ? prefix(String(block.clues.paragraph_id)) : undefined } }));
        for (const conversion of wordConversions(blocks)) submission.pending.push({ id: prefix(conversion.id), kind: "other", message: `${path} · ${conversion.location}：${conversion.reasons.join("；")}。请核对转换后的文字或排除此处内容。`, candidate_ids: [], source_ids: blocks.filter((b) => (b.clues as Record<string, unknown>).conversion && ((b.clues as Record<string, unknown>).conversion as { id: string }).id === conversion.id).map((b) => b.id) });
        submission.documents.push({ id: documentId, file_id: fileId, name: path, blocks, warnings: bundle.request.source.warnings, annotations: (bundle.request.source.annotations ?? []).map((note) => ({ ...note, id: prefix(note.id), source_ids: note.source_ids.map(prefix) })) });
        for (const [occurrenceId, image] of bundle.images) submission.assets.push({ id: makeId("asset"), storage_ref: image.src, media_type: image.src.split(";")[0].slice(5), origins: [{ file_id: fileId, relative_path: path, document_id: documentId, occurrence_id: prefix(occurrenceId) }], aliases: [] });
      } else if (/\.(txt|md)$/i.test(path)) {
        if (file.size > 320 * 1024) throw new Error("说明文字超过 320KB");
        const content = await file.text();
        submission.documents.push({ id: fileId, file_id: fileId, name: path, blocks: content.split(/\r?\n\s*\r?\n/).filter(Boolean).map((text, index) => ({ id: `${fileId}:p${index + 1}`, kind: "paragraph", content: plainRichText(text), clues: {} })), warnings: [], annotations: [] });
      } else throw new Error("不支持此文件格式，未读取");
    } catch (error) { record.error = error instanceof Error ? error.message : "文件读取失败"; }
  }
  const candidates = submission.documents.filter((doc) => /\.docx$/i.test(doc.name) && !submission.files.find((f) => f.id === doc.file_id)?.error);
  if (!submission.main_document_ids.length && candidates.length === 1) {
    submission.main_document_ids = [candidates[0].id]; submission.files.find((f) => f.id === candidates[0].file_id)!.role = "main";
  }
  return submission;
}

export function removeSubmissionFile(input: Submission, fileId: string, disable = false): Submission {
  const file = input.files.find((item) => item.id === fileId); if (!file) return input;
  const sourceIds = new Set(input.documents.filter((doc) => doc.file_id === fileId).flatMap((doc) => doc.blocks.map((block) => block.id)));
  const affected = input.plan?.article?.nodes.filter((node) => node.source_ids.some((id) => sourceIds.has(id))).map((node) => node.id) ?? [];
  const pending = input.pending.filter((p) => !p.source_ids.some((id) => sourceIds.has(id)));
  if (input.applied || input.base_draft) pending.push({ id: `file-change:${fileId}`, kind: "other", message: `${file.relative_path} 已${disable ? "停用" : "移除"}。已排内容保留，请核对${affected.length ? `关联的 ${affected.length} 项内容` : "本次修改影响"}。`, candidate_ids: affected, source_ids: [] });
  const used = new Set(Object.values(input.bindings).flatMap((b) => b.status === "bound" ? [b.asset_id] : []));
  if (input.publishing.cover_asset_id) used.add(input.publishing.cover_asset_id);
  const assets = disable ? input.assets : input.assets.flatMap((asset) => !asset.origins.length || asset.origins.some((origin) => origin.file_id !== fileId) ? [asset] : used.has(asset.id) || (input.draft?.nodes ?? input.base_draft)?.some((n) => n.type === "image" && n.src === asset.storage_ref) ? [{ ...asset, disabled: true }] : []);
  return { ...input, assets, files: disable ? input.files.map((f) => f.id === fileId ? { ...f, disabled: true } : f) : input.files.filter((f) => f.id !== fileId), documents: disable ? input.documents : input.documents.filter((doc) => doc.file_id !== fileId), main_document_ids: input.main_document_ids.filter((id) => id !== fileId), pending };
}
export function addArticleAssets(submission: Submission, article: { id: string; nodes: Array<{ id: string; type: string; src?: string; alt?: string }> }, name: string): Submission {
  const assets: Asset[] = article.nodes.filter((node) => node.type === "image" && node.src).map((node) => ({ id: makeId("asset"), storage_ref: node.src!, media_type: "image/*", origins: [{ file_id: article.id, relative_path: `${name}/${node.id}`, article_id: article.id, node_id: node.id }], aliases: node.alt ? [{ text: node.alt }] : [] }));
  return { ...submission, assets: [...submission.assets, ...assets.filter((asset) => !submission.assets.some((old) => old.origins.some((origin) => origin.article_id === article.id && origin.node_id === asset.origins[0].node_id)))] };
}
