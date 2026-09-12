"use client";
/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { renderRichText, richTextToPlain, type RichText } from "../template-engine";
import { RichTextInput } from "../RichTextInput";
import { previewAssetUrl } from "../preview-assets";
import type { DraftNode } from "./types";
import { moduleLabels } from "../canvas/model";

export function RichPreview({ value }: { value: RichText }) {
  const element = document.createElement("div"); element.append(renderRichText(document, value));
  return <div className="review-rich" dangerouslySetInnerHTML={{ __html: element.innerHTML }} />;
}
export function ContentPreview({ node }: { node: DraftNode }) {
  const content = "content" in node ? node.content : node.type === "image" || node.type === "image_ref" ? node.caption ?? [] : [];
  const links = content.flatMap((part) => "href" in part ? [part.href] : []);
  return <div className="review-content">
    {node.type === "image" && <img src={previewAssetUrl(node.src)} alt={node.alt || "正文配图"} />}
    {node.type === "image_ref" && <p className="submission-notice">{node.previous ? "待替换图片" : "待补图片"}{node.previous?.type === "image" && <img src={previewAssetUrl(node.previous.src)} alt="暂留原图" />}</p>}
    {content.length > 0 && <RichPreview value={content} />}
    {"items" in node && node.items.map((item, index) => <div key={item.id}>{node.type === "ol" ? node.start + index : "•"} <RichPreview value={item.content} /></div>)}
    {node.type === "divider" && <hr />}
    {[...new Set([...links, ...("link_url" in node && node.link_url ? [node.link_url] : [])])].map((href) => <small className="review-link" key={href}>链接：{href}</small>)}
  </div>;
}
export function ContentReview({ before = [], after, sources, components = {}, change, revert, locate }: {
  before?: DraftNode[]; after: DraftNode[]; sources?: Record<string, DraftNode[]>; components?: Record<string, string>;
  change?: (id: string, content: RichText) => void; revert?: (id: string) => void; locate?: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(!before.length);
  const ids = [...after.map((node) => node.id), ...before.filter((node) => !after.some((n) => n.id === node.id)).map((node) => node.id)];
  const rows = ids.map((id) => {
    const old = before.find((node) => node.id === id); const next = after.find((node) => node.id === id);
    const moved = old && next && before.filter((n) => after.some((b) => n.id === b.id)).indexOf(old) !== after.filter((n) => before.some((b) => n.id === b.id)).indexOf(next);
    const status = !old ? "新增" : !next ? "删除" : JSON.stringify(old) !== JSON.stringify(next) ? "修改" : moved ? "位置变化" : "未变化";
    return { id, old, next, status };
  });
  return <section className="content-review"><div className="submission-section-title"><h3>{before.length ? "修改前 / 修改后" : "交稿来源 / 组装内容"}</h3><button className="text-button" onClick={() => setShowAll(!showAll)}>{showAll ? "只看变化" : `显示全部（${rows.filter((r) => r.status === "未变化").length} 项未变化）`}</button></div>
    {rows.filter((row) => showAll || row.status !== "未变化").map(({ id, old, next, status }, index) => <article className="review-row" key={id} data-review-node={id}>
      <header><strong>{index + 1} · {status}</strong><span>{components[id] || (next?.type === "image_ref" || old?.type === "image_ref" ? "待补图片" : moduleLabels[(next ?? old)!.type as keyof typeof moduleLabels])}</span>{locate && next && <button className="text-button" onClick={() => locate(id)}>定位到画布</button>}{revert && status !== "未变化" && <button className="text-button" onClick={() => revert(id)}>{old ? "保留这一项原稿" : "排除此项"}</button>}</header>
      <div className="review-columns"><div><small>{before.length ? "原稿" : "素材原文"}</small>{old ? <ContentPreview node={old} /> : sources?.[id]?.length ? sources[id].map((node) => <ContentPreview key={node.id} node={node} />) : <p>新增内容</p>}</div><div><small>结果</small>{next ? <ContentPreview node={next} /> : <p>此项将删除</p>}</div></div>
      {change && next && "content" in next && <details><summary>修正这一项 · {richTextToPlain(next.content).slice(0, 24)}</summary><RichTextInput label={`修正 ${id}`} value={next.content} onChange={(content) => change(id, content)} /></details>}
    </article>)}
  </section>;
}
