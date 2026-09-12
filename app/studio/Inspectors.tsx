import type { StudioProject } from "./types";
import { findTheme } from "./templates";
import { verifyHtml } from "./renderer";
import { StudioIcon } from "./StudioIcon";
import { SegmentedControl } from "./SegmentedControl";
import type { PageFormat } from "./page-format";

export function PageFormatSummary({ format }: { format?: PageFormat }) {
  if (!format) return null;
  const s = format.styles;
  const values = { 正文: [s["font-size"], s["line-height"] && `行高 ${s["line-height"]}`, s["letter-spacing"] && `字距 ${s["letter-spacing"]}`].filter(Boolean).join(" · "), 纸张: s["background-color"] || "继承母版", 留白: [s["padding-top"], s["padding-right"], s["padding-bottom"], s["padding-left"]].map((value) => value || "0").join(" / "), 背景: s["background-image"] && s["background-image"] !== "none" ? [s["background-size"], s["background-repeat"]].filter(Boolean).join(" · ") : "无背景图" };
  return <details className="template-spec"><summary>全文格式<StudioIcon name="down" /></summary><dl>{Object.entries(values).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}{format.source && <div><dt>来源</dt><dd>原稿正文区域</dd></div>}</dl></details>;
}

export function StylePanel({ project, issues, updateProject, openExport, close }: {
  project: StudioProject; issues: ReturnType<typeof verifyHtml>;
  updateProject: (patch: Partial<StudioProject>) => void; openExport: () => void; close: () => void;
}) {
  const selected = findTheme(project.theme);
  return <aside className="style-panel">
    <header className="inspector-heading"><span className="panel-eyebrow">版式</span><button className="icon-button inspector-close" aria-label="关闭版式设置" onClick={close}><StudioIcon name="close" /></button></header>
    <p className="empty-side">基础排版 · 可从模板库导入文章模板</p>
    <section className="inspector-section"><h3>阅读节奏</h3><SegmentedControl value={project.density} onChange={(density) => updateProject({ density })} label="阅读节奏" className="property-segment" options={[{ value: "comfortable", label: "舒展" }, { value: "compact", label: "紧凑" }]} /></section>
    <section className="inspector-section"><div className="property-heading"><h3>强调色</h3>{project.accentOverride && <button className="text-button" onClick={() => updateProject({ accentOverride: "" })}>重置</button>}</div><div className="accent-palette">{[selected.accent, "#36594a", "#3c536c", "#916458", "#625a76", "#282b28"].filter((color, index, all) => all.indexOf(color) === index).map((color) => <button key={color} className="color-dot" style={{ "backgroundColor": color }} aria-label={`强调色 ${color}`} aria-pressed={(project.accentOverride || selected.accent) === color} onClick={() => updateProject({ accentOverride: color })}><StudioIcon name="check" /></button>)}<label className="custom-color" title="自定义强调色"><StudioIcon name="plus" /><input type="color" aria-label="自定义强调色" value={project.accentOverride || selected.accent} onChange={(event) => updateProject({ accentOverride: event.target.value })}/></label></div></section>
    <details className="template-spec"><summary>版式参数<StudioIcon name="down" /></summary><dl>{Object.entries({ 画布: selected.specification.page, 标题: selected.specification.mainTitle, 正文: selected.specification.body, 图片: selected.specification.image }).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details>
    <div className="inspector-footer"><CompatibilityCard issues={issues}/><button className="text-button inspector-export" onClick={openExport}>导出选项<StudioIcon name="arrow" /></button></div>
  </aside>;
}

export function CloneInspector({ project, issues, openExport, close }: { project: StudioProject; issues: ReturnType<typeof verifyHtml>; openExport: () => void; close: () => void }) {
  const state = project.cloneTemplate;
  const changed = state?.slots.filter((slot) => slot.value !== slot.originalValue || (slot.linkUrl || "") !== (slot.originalLinkUrl || "")).length || 0;
  return <aside className="style-panel"><header className="inspector-heading"><span className="panel-eyebrow">模板概览</span><button className="icon-button inspector-close" aria-label="关闭版式设置" onClick={close}><StudioIcon name="close"/></button></header>
    {state ? <><h2 className="inspector-template-name">{state.name}</h2><div className="clone-status-grid">{[[changed, "已改槽位"], [state.slots.filter((slot) => slot.kind === "image").length, "图片"], [state.modules.filter((module) => module.included).length, "模块"], [state.pendingAssets?.length || 0, "待补素材"]].map(([number, label]) => <article key={label}><span>{number}</span><p>{label}</p></article>)}</div></> : <div className="empty-side"><StudioIcon name="layers"/><p>尚未导入模板</p></div>}
    <PageFormatSummary format={state?.source?.pageFormat} />
    {state && <div className="inspector-footer"><CompatibilityCard issues={issues}/><button className="text-button inspector-export" onClick={openExport}>导出模板<StudioIcon name="arrow"/></button></div>}
  </aside>;
}

export function CompatibilityCard({ issues }: { issues: ReturnType<typeof verifyHtml> }) {
  const count = issues.filter((item) => item.level !== "info").length;
  return <details className={`compat-card ${count ? "has-warning" : ""}`} open={count > 0}><summary><span className="compat-dot"/><strong>{count ? `${count} 项待检查` : "可直接导出"}</strong><StudioIcon name="down"/></summary><div className="issue-list">{issues.map((issue, index) => <article key={index} className={issue.level}><strong>{issue.title}</strong><p>{issue.detail}</p></article>)}</div></details>;
}
