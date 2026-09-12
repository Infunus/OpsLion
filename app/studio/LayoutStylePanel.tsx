"use client";
import { StudioIcon } from "./StudioIcon";
import { CompatibilityCard, PageFormatSummary } from "./Inspectors";
import { resolveTokens, allowedNodeVariants, type LayoutState } from "./template-engine";
import type { CompatibilityIssue } from "./types";

export function LayoutStylePanel({ layout, update, issues, close, openLibrary, openExport, selected }: { layout: LayoutState; update: (layout: LayoutState) => void; issues: CompatibilityIssue[]; close: () => void; openLibrary: () => void; openExport: () => void; selected?: string | null }) {
  const values = resolveTokens(layout.template, layout.presetId, layout.overrides);
  const node = layout.article.nodes.find((item) => item.id === selected);
  const variants = node && layout.template.mapping[node.type] ? allowedNodeVariants(layout.template.mapping[node.type]!) : [];
  return <aside className="style-panel layout-style-panel"><header className="inspector-heading"><span className="panel-eyebrow">版式</span><button className="icon-button inspector-close" aria-label="关闭版式设置" onClick={close}><StudioIcon name="close" /></button></header>
    <div className="layout-active-template"><small>当前模板 · v{layout.template.version}</small><h2>{layout.template.name}</h2><p>{layout.template.description}</p><button className="secondary-button full-button" onClick={openLibrary}>更换文章模板<StudioIcon name="layers" /></button></div>
    {node && <section className="inspector-section"><h3>所选内容的版式</h3>{variants.length > 1 ? <label>组件样式<select aria-label="所选内容组件样式" value={layout.nodeVariants?.[node.id] ?? ""} onChange={(event) => { const nodeVariants = { ...layout.nodeVariants }; if (event.target.value) nodeVariants[node.id] = event.target.value; else delete nodeVariants[node.id]; update({ ...layout, nodeVariants }); }}><option value="">模板自动选择</option>{variants.map((id) => <option key={id} value={id}>{id}</option>)}</select></label> : <p>此类内容只有一种模板样式。</p>}
      {node.type === "image" && <label>图片组合<select aria-label="所选图片组合" value="" onChange={(event) => {
        if (!event.target.value) return;
        const count = Number(event.target.value); const start = layout.article.nodes.indexOf(node);
        const targets = layout.article.nodes.slice(start, start + count);
        if (targets.length !== count || targets.some((n) => n.type !== "image")) return;
        const ids = new Set(targets.map((n) => n.id)); const group = crypto.randomUUID();
        update({ ...layout, article: { ...layout.article, nodes: layout.article.nodes.map((n) => n.type === "image" && ids.has(n.id) ? { ...n, group } : n) } });
      }}><option value="">{node.group ? "已指定组合" : "模板自动组合"} · 更改</option>{[1, 2, 3].map((count) => <option key={count} value={count} disabled={(count > 1 && !layout.template.rules.sequences.images) || layout.article.nodes.slice(layout.article.nodes.indexOf(node), layout.article.nodes.indexOf(node) + count).filter((n) => n.type === "image").length !== count}>{count === 1 ? "这张图独立显示" : `与后面 ${count - 1} 张组成${count === 2 ? "双" : "三"}图`}</option>)}</select></label>}
    </section>}
    {layout.template.presets.length > 0 && <section className="inspector-section"><h3>配色方案</h3><div className="layout-preset-list"><button aria-pressed={layout.presetId === null} onClick={() => update({ ...layout, presetId: null, overrides: {} })}>默认</button>{layout.template.presets.map((preset) => <button key={preset.id} aria-pressed={layout.presetId === preset.id} onClick={() => update({ ...layout, presetId: preset.id, overrides: {} })}>{preset.name}</button>)}</div></section>}
    <section className="inspector-section"><div className="property-heading"><h3>阅读样式</h3>{Object.keys(layout.overrides).length > 0 && <button className="text-button" onClick={() => update({ ...layout, overrides: {} })}>重置调整</button>}</div>
      {Object.entries(layout.template.tokens).filter(([, token]) => token.editable).map(([name, token]) => <label className="layout-token-control" key={name}><span>{token.label}</span>{token.kind === "color" ? <input type="color" aria-label={token.label} value={String(values[name])} onChange={(event) => update({ ...layout, overrides: { ...layout.overrides, [name]: event.target.value } })} /> : <><output>{values[name]}{token.kind === "length" ? " px" : ""}</output><input type="range" aria-label={token.label} min={token.min} max={token.max} step={token.kind === "number" ? .05 : 1} value={Number(values[name])} onChange={(event) => update({ ...layout, overrides: { ...layout.overrides, [name]: Number(event.target.value) } })} /></>}</label>)}
    </section>
    <PageFormatSummary format={layout.template.pageFormat} />
    <div className="inspector-footer"><CompatibilityCard issues={issues} /><button className="text-button inspector-export" onClick={openExport}>导出选项<StudioIcon name="arrow" /></button></div>
  </aside>;
}
