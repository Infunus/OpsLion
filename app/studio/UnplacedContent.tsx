"use client";
import { useState } from "react";
import type { CloneTemplateState } from "./types";
import { placeUnplacedContent } from "./local-template-fill";
import { insertNativeModule } from "./canvas/native-model";

export function UnplacedContent({ template, change }: { template: CloneTemplateState; change: (state: CloneTemplateState) => void }) {
  const [module, setModule] = useState(""); const [reason, setReason] = useState(""); const [error, setError] = useState("");
  const apply = (fn: () => CloneTemplateState) => { try { change(fn()); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "未完成"); } };
  if (!template.unplacedContent?.length && !template.pendingAssets?.length) return null;
  return <section className="unplaced-content"><h3>未排入内容</h3><p>逐项安放或明确排除后，才能正式导出。</p>
    <label>追加方式<select aria-label="未排入内容的模块" value={module} onChange={(e) => setModule(e.target.value)}><option value="">追加正文模块</option>{template.modules.filter((m) => m.included).map((m) => <option key={m.id} value={m.id}>复制：{m.label}</option>)}</select></label>
    {template.unplacedContent?.map((item) => <article key={item.id}><p>{item.text}</p><button className="secondary-button" onClick={() => apply(() => placeUnplacedContent(template, item.id, module || undefined))}>{module ? "复制所选模块并写入" : "追加到正文末尾"}</button><button className="text-button" disabled={!reason.trim()} onClick={() => change({ ...template, unplacedContent: template.unplacedContent?.filter((n) => n.id !== item.id), excludedContent: [...(template.excludedContent ?? []), { id: item.id, text: item.text, reason: reason.trim() }] })}>明确排除此项</button></article>)}
    {template.pendingAssets?.filter((asset) => asset.imageUrl).map((asset) => <article key={asset.id}><p>{asset.purpose}</p><button className="secondary-button" onClick={() => apply(() => { const next = insertNativeModule(template, "image", template.modules.at(-1)?.id ?? null, "after", asset.imageUrl).state; return { ...next, pendingAssets: next.pendingAssets?.filter((a) => a.id !== asset.id) }; })}>追加图片模块</button></article>)}
    <input aria-label="排除内容的原因" placeholder="排除原因（明确排除时必填）" value={reason} onChange={(e) => setReason(e.target.value)} />{error && <p role="alert">{error}</p>}
  </section>;
}
