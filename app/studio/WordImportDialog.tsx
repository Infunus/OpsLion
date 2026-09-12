"use client";
import { useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { ContentPreview, ContentReview } from "./submission/ContentReview";
import type { DocxImportResult } from "./docx-import";
import { wordArticle, wordConversions, type WordConversion } from "./word-conversion";
import type { ParsedArticle } from "./template-engine";

export type WordDestination = "new" | "replace" | "selected";
export function WordImportDialog({ imported, template, selected, close, apply }: { imported: DocxImportResult; template: string; selected?: string | null; close: () => void; apply: (article: ParsedArticle, destination: WordDestination) => Promise<void> }) {
  const [destination, setDestination] = useState<WordDestination>("new");
  const [decisions, setDecisions] = useState<Record<string, "text" | "exclude">>({}); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const issues = wordConversions(imported.bundle.request.source.blocks);
  const article = wordArticle(imported.bundle, imported.article.id, decisions);
  const sources = Object.fromEntries(article.nodes.map((node) => {
    const ids = "items" in node ? node.items.map((item) => item.id) : [node.id];
    return [node.id, ids.flatMap((id) => {
      const block = imported.bundle.request.source.blocks.find((b) => b.id === id); if (!block) return [];
      const image = block.image_anchor_id ? imported.bundle.images.get(block.image_anchor_id) : undefined;
      return [image ?? { id, type: "paragraph" as const, content: block.content }];
    })];
  }));
  return <ModalDialog label="核对 Word 导入" close={close}>{(dismiss) => <section className="modal submission-modal"><header><div><h2>核对 Word 导入</h2><p>{imported.bundle.request.source.document_name} · 目标模板：{template}</p></div><button className="close-button" onClick={dismiss} aria-label="关闭 Word 导入">×</button></header><div className="submission-body">
    <label>导入位置<select aria-label="Word 导入位置" value={destination} onChange={(event) => setDestination(event.target.value as WordDestination)}><option value="new">新建文章，使用当前模板</option><option value="replace">替换当前文章（自动保留修改前版本）</option>{selected && <option value="selected">仅替换画布选中的内容</option>}</select></label>
    <p>文字强调、链接、标题层级和列表起始编号已读取。特殊结构按下面的具体位置处理。</p>
    {issues.map((issue) => <article className="submission-pending" key={issue.id}><strong>{issue.location}</strong><p>{issue.reasons.join("；")}</p>{imported.bundle.request.source.blocks.filter((b) => (b.clues.conversion as WordConversion | undefined)?.id === issue.id).map((block) => <ContentPreview key={block.id} node={{ id: block.id, type: "paragraph", content: block.content }} />)}<select aria-label={`处理 ${issue.id}`} value={decisions[issue.id] ?? ""} onChange={(event) => setDecisions({ ...decisions, [issue.id]: event.target.value as "text" | "exclude" })}><option value="" disabled>保留待处理，选择转换方式后导入</option><option value="text">转为可编辑文字（表格保留行列标记）</option><option value="exclude">明确排除此处内容</option></select></article>)}
    <ContentReview after={article.nodes} sources={sources} />{error && <p role="alert">{error}</p>}
  </div><footer className="submission-footer"><span>{issues.filter((issue) => !decisions[issue.id]).length ? "仍有特殊结构未确认" : `${article.nodes.length} 项内容 · ${imported.imageCount} 张图片`}</span><button className="primary-button" disabled={busy || issues.some((issue) => !decisions[issue.id])} onClick={async () => { setBusy(true); try { await apply(article, destination); } catch (e) { setError(e instanceof Error ? e.message : "导入失败"); } finally { setBusy(false); } }}>确认导入</button></footer></section>}</ModalDialog>;
}
