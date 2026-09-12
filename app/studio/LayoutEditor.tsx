"use client";
import { useEffect, useRef, useState } from "react";
import { StudioIcon } from "./StudioIcon";
import { RichTextInput } from "./RichTextInput";
import { downloadBlob, safeFilename } from "./export-service";
import { makeId } from "./types";
import { safeImageUrl } from "./html-policy";
import { previewAssetUrl } from "./preview-assets";
import { articleTitle, parsedArticleSchema, plainRichText, richTextToPlain, explainLayoutError, type ArticleNode, type ParsedArticle, type RichText } from "./template-engine";

const labels = { paragraph: "正文", heading1: "一级标题", heading2: "二级标题", heading3: "三级标题", quote: "引用", ul: "无序列表", ol: "有序列表", divider: "分割线", image: "图片" };
type BlockKind = keyof typeof labels;
export function LayoutEditor({ article, onChange, openLibrary, notify, chooseDocx, importing, chooseModelDocx, runAgent, agentBusy, pendingImages = {}, openSubmission, openModules }: { article: ParsedArticle; onChange: (article: ParsedArticle) => void; openLibrary: () => void; notify: (message: string) => void; chooseDocx: () => void; importing: boolean; chooseModelDocx: () => void; runAgent: () => void; agentBusy: boolean; pendingImages?: Record<string, boolean>; openSubmission?: () => void; openModules?: () => void }) {
  const importRef = useRef<HTMLInputElement>(null); const [kind, setKind] = useState<BlockKind>("paragraph"); const [imageUrl, setImageUrl] = useState(""); const [bulk, setBulk] = useState<string | null>(null);
  const latest = useRef(article);
  const [jsonText, setJsonText] = useState<string | null>(null);
  const importArticle = (text: string) => {
    try { onChange(parsedArticleSchema.parse(JSON.parse(text))); setJsonText(null); notify("结构化文稿已导入"); }
    catch (error) { notify(explainLayoutError(error)); }
  };
  useEffect(() => { latest.current = article; }, [article]);
  const header = article.nodes.filter((node) => node.type === "article_title" || node.type === "subtitle");
  const blocks = article.nodes.filter((node) => node.type !== "article_title" && node.type !== "subtitle");
  const setBlocks = (nodes: ArticleNode[]) => onChange({ ...article, nodes: [...header, ...nodes] });
  const replace = (id: string, node: ArticleNode) => onChange({ ...article, nodes: article.nodes.map((item) => item.id === id ? node : item) });
  const setText = (node: ArticleNode, content: RichText) => { if ("content" in node) replace(node.id, { ...node, content }); };
  const add = (src?: string) => {
    const id = makeId("node"); let node: ArticleNode;
    if (kind === "image") { if (!safeImageUrl(src ?? imageUrl)) { notify("请填写有效图片地址或选择图片文件"); return; } node = { id, group: id, type: "image", src: safeImageUrl(src ?? imageUrl), alt: "", caption: [] }; setImageUrl(""); }
    else if (kind === "divider") node = { id, type: "divider" };
    else if (kind === "ol") node = { id, type: "ol", start: 1, items: [{ id: makeId("item"), content: [] }] };
    else if (kind === "ul") node = { id, type: "ul", items: [{ id: makeId("item"), content: [] }] };
    else node = { id, type: kind, content: [] };
    setBlocks([...blocks, node]);
  };
  const loadImage = async (file: File | undefined, id?: string) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(file.type) || file.size > 5 * 1024 * 1024) return notify("请选择 5MB 以内的 PNG、JPEG、GIF 或 WebP 图片");
    const reader = new FileReader(); reader.onload = () => {
      const src = String(reader.result); const current = latest.current; const node = current.nodes.find((item) => item.id === id);
      if (node?.type === "image") onChange({ ...current, nodes: current.nodes.map((item) => item.id === id ? { ...node, src, width: undefined, height: undefined } : item) });
      else if (!id) onChange({ ...current, nodes: [...current.nodes, { id: makeId("node"), group: makeId("image-group"), type: "image", src, alt: "", caption: [] }] });
    }; reader.onerror = () => notify("图片读取失败，请重试"); reader.readAsDataURL(file);
  };
  const title = article.nodes[0]; const subtitle = article.nodes.find((node) => node.type === "subtitle");
  return <aside className="editor-panel panel semantic-editor">
    <div className="panel-title-row"><div><span className="panel-eyebrow">内容</span><h2>文稿编辑</h2></div><button className="secondary-button" onClick={openLibrary}><StudioIcon name="layers" />模板库</button></div>
    {openModules && <button className="module-library-entry secondary-button" onClick={openModules}><StudioIcon name="layers" /> 模板模块 <span>标题、正文、图片等</span></button>}
    <div className="editor-quick-actions semantic-imports"><button className="import-document" onClick={chooseDocx} disabled={importing}><StudioIcon name="upload" /><span>{importing ? "正在读取…" : "导入 Word"}</span></button><button className="text-button" onClick={() => setJsonText(jsonText === null ? "" : null)}>导入结构化文稿</button></div>
    {jsonText !== null && <div className="semantic-paste"><label htmlFor="layout-article-json">结构化文稿 JSON</label><p>粘贴解析后的文稿，确认后替换当前文章内容。</p><textarea id="layout-article-json" className="text-area" rows={6} value={jsonText} onChange={(event) => setJsonText(event.target.value)} /><button className="primary-button" disabled={!jsonText.trim()} onClick={() => importArticle(jsonText)}>导入并替换文稿</button><button className="text-button" onClick={() => importRef.current?.click()}>选择 JSON 文件</button><button className="text-button" onClick={() => setJsonText(null)}>取消</button></div>}
    <details className="semantic-agent-tools"><summary>模型语义识别</summary><div className="agent-action-card"><p>原文保留，识别结果审核后套用当前模板。</p><button className="secondary-button" disabled={agentBusy} onClick={chooseModelDocx}>模型解析 Word</button><button className="secondary-button" disabled={agentBusy} onClick={runAgent}>{agentBusy ? "分析中…" : "智能整理"}</button></div></details>
    <div className="semantic-article-actions"><button className="text-button" onClick={() => setBulk(bulk === null ? "" : null)}>粘贴正文</button><button className="text-button" onClick={() => Object.keys(pendingImages).length ? notify("交稿仍有缺图，请下载完整项目备份以保留待补位置") : downloadBlob(JSON.stringify(article, null, 2), `${safeFilename(articleTitle(article))}.article.json`, "application/json")}>下载文稿</button><span>{blocks.length} 项内容</span></div>
    {bulk !== null && <div className="semantic-paste"><label htmlFor="layout-paste">每个空行分隔一个正文段落</label><textarea id="layout-paste" className="text-area" value={bulk} onChange={(event) => setBulk(event.target.value)} /><button className="primary-button" disabled={!bulk.trim()} onClick={() => { setBlocks([...blocks, ...bulk.split(/\n\s*\n/).filter((text) => text.trim()).map((text) => ({ id: makeId("node"), type: "paragraph" as const, content: plainRichText(text) }))]); setBulk(null); }}>添加到正文末尾</button></div>}
    <div className="field-label">文章标题</div>
    {"content" in title && <RichTextInput label="文章标题" className="semantic-title" value={title.content} onChange={(content) => setText(title, content)} />}
    <div className="field-label">副标题 <span>选填</span></div>
    <RichTextInput label="副标题" value={subtitle && "content" in subtitle ? subtitle.content : []} onChange={(content) => {
      const nodes = article.nodes.filter((node) => node.type !== "subtitle");
      if (richTextToPlain(content)) nodes.splice(1, 0, { id: subtitle?.id ?? makeId("subtitle"), type: "subtitle", content });
      onChange({ ...article, nodes });
    }} placeholder="添加副标题…" />
    <div className="semantic-blocks">{blocks.map((node, index) => <article className="semantic-block" key={node.id} data-node-id={node.id}>
      <header className="semantic-block-head"><span className="semantic-kind">{String(index + 1).padStart(2, "0")} · {labels[node.type as BlockKind]}</span><div className="section-tools">
        <button aria-label={`上移第 ${index + 1} 项`} disabled={!index} onClick={() => { const next = [...blocks]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setBlocks(next); }}><StudioIcon name="up" /></button>
        <button aria-label={`下移第 ${index + 1} 项`} disabled={index === blocks.length - 1} onClick={() => { const next = [...blocks]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; setBlocks(next); }}><StudioIcon name="down" /></button>
        <button aria-label={`复制第 ${index + 1} 项`} disabled={pendingImages[node.id]} onClick={() => { const copy = structuredClone(node); copy.id = makeId("node"); if (copy.type === "image") copy.group = copy.id; if ("items" in copy) copy.items = copy.items.map((item) => ({ ...item, id: makeId("item") })); const next = [...blocks]; next.splice(index + 1, 0, copy); setBlocks(next); }}><StudioIcon name="copy" /></button>
        <button aria-label={`删除第 ${index + 1} 项`} onClick={() => setBlocks(blocks.filter((item) => item.id !== node.id))}><StudioIcon name="trash" /></button>
      </div></header>
      {pendingImages[node.id] && <div className="submission-status"><p>此处图片尚未绑定，正文可继续编辑。</p><button className="secondary-button" onClick={openSubmission}>选择或补充图片</button></div>}{"content" in node && !pendingImages[node.id] && <><select className="semantic-type-select" aria-label={`第 ${index + 1} 项类型`} value={node.type} onChange={(event) => replace(node.id, { ...node, type: event.target.value as "paragraph" | "heading1" | "heading2" | "heading3" | "quote" })}>{["paragraph", "heading1", "heading2", "heading3", "quote"].map((type) => <option key={type} value={type}>{labels[type as BlockKind]}</option>)}</select><RichTextInput label={`第 ${index + 1} 项内容`} className={node.type.startsWith("heading") ? "semantic-heading" : ""} value={node.content} onChange={(content) => setText(node, content)} /></>}
      {node.type === "image" && <div className="semantic-image"><span className="semantic-image-preview" role="img" aria-label={node.alt || "内容配图"} style={{ backgroundImage: `url("${previewAssetUrl(node.src).replace(/"/g, "%22")}")` }} /><ImageAddress value={node.src} label={`第 ${index + 1} 项图片地址`} notify={notify} commit={(src) => replace(node.id, { ...node, src, width: undefined, height: undefined })} /><label className="file-button">替换图片<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" onChange={(event) => void loadImage(event.target.files?.[0], node.id)} /></label><input className="text-input compact-input" aria-label={`第 ${index + 1} 项图片描述`} placeholder="图片描述" value={node.alt} onChange={(event) => replace(node.id, { ...node, alt: event.target.value })} /><RichTextInput label={`第 ${index + 1} 项图注`} placeholder="图注（选填）" value={node.caption ?? []} onChange={(caption) => replace(node.id, { ...node, caption })} /></div>}
      {"items" in node && <div className="semantic-list">{node.type === "ol" && <label>起始序号 <input aria-label={`第 ${index + 1} 项起始序号`} type="number" min={1} value={node.start} onChange={(event) => replace(node.id, { ...node, start: Math.max(1, Math.floor(Number(event.target.value) || 1)) })} /></label>}{node.items.map((item, itemIndex) => <div className="semantic-list-item" key={item.id}><span>{node.type === "ol" ? node.start + itemIndex : "•"}</span><RichTextInput label={`第 ${index + 1} 项列表内容 ${itemIndex + 1}`} value={item.content} onChange={(content) => replace(node.id, { ...node, items: node.items.map((entry) => entry.id === item.id ? { ...entry, content } : entry) })} /><button className="icon-button" aria-label={`删除列表项 ${itemIndex + 1}`} onClick={() => replace(node.id, { ...node, items: node.items.filter((entry) => entry.id !== item.id) })}><StudioIcon name="trash" /></button></div>)}<button className="text-button" onClick={() => replace(node.id, { ...node, items: [...node.items, { id: makeId("item"), content: [] }] })}>＋ 添加列表项</button></div>}
      {node.type === "divider" && <hr className="semantic-divider" />}
    </article>)}</div>
    <div className="semantic-add"><label htmlFor="add-semantic-kind">继续添加</label><div><select id="add-semantic-kind" value={kind} onChange={(event) => setKind(event.target.value as BlockKind)}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button className="primary-button" onClick={() => add()}>添加{labels[kind]}</button></div>{kind === "image" && <><input className="text-input" aria-label="新图片地址" placeholder="https://…" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} /><label className="file-button">选择本地图片<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" onChange={(event) => void loadImage(event.target.files?.[0])} /></label></>}</div>
    <input ref={importRef} type="file" accept=".json,.article.json" hidden aria-label="导入结构化文稿文件" onChange={async (event) => { const input = event.currentTarget; const file = input.files?.[0]; if (!file) return; try { importArticle(await file.text()); } catch (error) { notify(explainLayoutError(error)); } finally { input.value = ""; } }} />
  </aside>;
}

function ImageAddress({ value, label, commit, notify }: { value: string; label: string; commit: (value: string) => void; notify: (message: string) => void }) {
  return <input key={value} className="text-input compact-input" aria-label={label} defaultValue={value} onBlur={(event) => { if (event.target.value === value) return; const next = safeImageUrl(event.target.value); if (next) commit(next); else { event.target.value = value; notify("图片地址无效，已保留原图"); } }} />;
}
