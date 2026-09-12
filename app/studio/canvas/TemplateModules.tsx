"use client";
import { useMemo, useState } from "react";
import { compileArticle, publishTemplate, type ArticleNode, type LayoutState, type NodeKind, type ParsedArticle } from "../template-engine";
import { moduleLabels } from "./model";
import { StudioIcon } from "../StudioIcon";

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1sAAAAASUVORK5CYII=";
export type ModuleChoice = NodeKind | "chapter" | "image-pair" | "image-triple";
function specimen(kind: ModuleChoice): ParsedArticle {
  const title: ArticleNode = { id: "sample-title", type: "article_title", content: kind === "article_title" ? [{ text: "文章的主标题" }] : [] };
  const nodes: ArticleNode[] = [];
  const text = (type: Exclude<NodeKind, "image" | "divider" | "ul" | "ol">, content: string): ArticleNode => ({ id: "sample", type, content: [{ text: content }] });
  if (kind === "chapter") nodes.push(text("heading1", "章节标题"), { id: "sample-body", type: "paragraph", content: [{ text: "文字随内容自然展开。" }] });
  else if (kind === "image" || kind === "image-pair" || kind === "image-triple") for (let i = 0; i < (kind === "image-pair" ? 2 : kind === "image-triple" ? 3 : 1); i++) nodes.push({ id: `sample-${i}`, type: "image", src: pixel, alt: "图片", caption: [{ text: "图片说明" }] });
  else if (kind === "ul" || kind === "ol") nodes.push({ id: "sample", type: kind, ...(kind === "ol" ? { start: 1 } : {}), items: [{ id: "item1", content: [{ text: "第一项内容" }] }, { id: "item2", content: [{ text: "第二项内容" }] }] } as ArticleNode);
  else if (kind === "divider") nodes.push({ id: "sample", type: "divider" });
  else if (kind !== "article_title") nodes.push(text(kind, kind === "paragraph" ? "一段正文，保留清晰的节奏与舒适的留白。" : kind === "quote" ? "值得读者停留的一句话。" : moduleLabels[kind]));
  return { schema: "opslion.article/v1", id: "module-specimen", nodes: [title, ...nodes] };
}
export function TemplateModules({ layout, insert, position, setPosition, selectedLabel, back, collapse }: {
  layout: LayoutState; insert: (kind: ModuleChoice) => void; position: "before" | "after"; setPosition: (value: "before" | "after") => void;
  selectedLabel: string; back: () => void; collapse: () => void;
}) {
  const [query, setQuery] = useState("");
  const modules = useMemo(() => {
    const template = publishTemplate(layout.template);
    const choices: ModuleChoice[] = Object.keys(moduleLabels).filter((type) => Boolean(template.mapping[type as NodeKind])) as NodeKind[];
    if (template.rules.sections.heading1) choices.push("chapter");
    if (template.rules.sequences.images) choices.push("image-pair", "image-triple");
    return choices.map((kind) => {
      const label = kind === "chapter" ? "章节卡片" : kind === "image-pair" ? "双图" : kind === "image-triple" ? "三图" : moduleLabels[kind];
      try {
        const html = compileArticle(specimen(kind), template, layout.presetId, layout.overrides, { editing: true }).html;
        const doc = new DOMParser().parseFromString(html, "text/html");
        if (kind !== "article_title") doc.querySelector('[data-op-node="sample-title"]')?.parentElement?.remove();
        const page = doc.querySelector<HTMLElement>("[data-layout-artifact]"); if (page) page.style.padding = "12px";
        doc.querySelectorAll<HTMLElement>("img").forEach((image) => { image.style.height = "64px"; image.style.background = "#e6eae5"; image.style.objectFit = "contain"; });
        return { kind, label, html: doc.body.innerHTML };
      } catch { return { kind, label, html: "" }; }
    });
  }, [layout.template, layout.presetId, layout.overrides]);
  return <aside className="editor-panel panel template-module-sidebar" aria-label="当前模板模块">
    <div className="panel-title-row"><div><span className="panel-eyebrow">{layout.template.name}</span><h2>模板模块</h2></div><button className="icon-button" aria-label="收起模块边栏" onClick={collapse}><StudioIcon name="collapse" /></button></div>
    <button className="text-button" onClick={back}>返回文稿编辑</button>
    <p className="module-sidebar-note">选择模块，沿用当前模板的字体、配色和间距。</p>
    <input className="text-input" aria-label="搜索模板模块" placeholder="搜索标题、正文、图片…" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="module-insertion-position"><span>{selectedLabel || "文章末尾"}</span><select aria-label="模块插入位置" value={position} onChange={(event) => setPosition(event.target.value as "before" | "after")} disabled={!selectedLabel}><option value="after">在后面插入</option><option value="before">在前面插入</option></select></div>
    <div className="template-module-list">{modules.filter((item) => !query || item.label.includes(query)).map((item) => <button className="template-module-card" key={item.kind} aria-label={`插入${item.label}模块`} onClick={() => insert(item.kind)}>
      <span className="module-card-preview" aria-hidden="true"><span dangerouslySetInnerHTML={{ __html: item.html }} /></span><span className="module-card-label"><strong>{item.label}</strong><span>＋</span></span>
    </button>)}</div>
    {!modules.some((item) => !query || item.label.includes(query)) && <p className="module-sidebar-note">没有匹配的模块。</p>}
    <p className="module-sidebar-note">篇名和副标题各使用一个；重复选择会定位到原处。章节编号、容器和连续图片组合由模板自动处理。</p>
  </aside>;
}
