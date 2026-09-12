"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { StudioIcon } from "./StudioIcon";
import { SegmentedControl } from "./SegmentedControl";
import { downloadBlob, safeFilename } from "./export-service";
import { preparePreviewHtml } from "./preview-assets";
import { plainLayout, compileArticle, explainLayoutError, loadLayoutTemplates, publishTemplate, removeLayoutTemplate, saveLayoutTemplate, standardArticle, type LayoutState, type ParsedArticle, type TemplateDefinition } from "./template-engine";

const keyOf = (template: TemplateDefinition) => `${template.id}@${template.version}`;
const previewDocument = (html: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#fff;">${preparePreviewHtml(html)}</body></html>`;
function preview(article: ParsedArticle, template: TemplateDefinition, presetId: string | null = null) {
  try { return { html: compileArticle(article, template, presetId).html, error: "" }; }
  catch (error) { return { html: "", error: explainLayoutError(error) }; }
}
export function LayoutLibrary({ article, active, close, apply, notify }: { article: ParsedArticle; active?: LayoutState | null; close: () => void; apply: (template: TemplateDefinition, presetId: string | null) => void; notify: (message: string) => void }) {
  const [saved, setSaved] = useState<TemplateDefinition[]>([]); const [notice, setNotice] = useState(""); const [importing, setImporting] = useState(false);
  const [selectedKey, setSelectedKey] = useState(active ? keyOf(active.template) : "");
  const [presetId, setPresetId] = useState<string | null>(active?.presetId ?? null); const [source, setSource] = useState<"sample" | "article">("sample");
  const importRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const importTemplate = async (text: string) => {
    setImporting(true); setNotice("");
    try { const payload = JSON.parse(text); if (["opslion-template/v1", "opslion-template/v2"].includes(payload.schema)) throw new Error("这是历史参考稿，请在“样式复刻”中导入。"); const template = await saveLayoutTemplate(payload); setSaved((items) => [...items.filter((item) => keyOf(item) !== keyOf(template)), template]); setSelectedKey(keyOf(template)); setPresetId(null); setPaste(null); notify(`已导入“${template.name}”`); }
    catch (error) { setNotice(explainLayoutError(error)); } finally { setImporting(false); }
  };
  useEffect(() => { let cancelled = false; loadLayoutTemplates().then((templates) => { if (!cancelled) setSaved(templates); }).catch(() => { if (!cancelled) setNotice("个人模板暂时无法读取，请重试。"); }); return () => { cancelled = true; }; }, []);
  const templates = useMemo(() => [...new Map([...saved, ...(active && active.template.id !== plainLayout.id ? [active.template] : [])].map((template) => [keyOf(template), template])).values()], [saved, active]);
  const selected = templates.find((template) => keyOf(template) === selectedKey) ?? templates[0];
  const selectedPreset = selected?.presets.some((preset) => preset.id === presetId) ? presetId : null;
  const previews = useMemo(() => new Map(templates.map((template) => [keyOf(template), preview(standardArticle, template)])), [templates]);
  const current = useMemo(() => selected ? preview(source === "sample" ? standardArticle : article, selected, selectedPreset) : { html: "", error: "" }, [source, article, selected, selectedPreset]);
  const downloadSelected = () => {
    if (!selected) return;
    try { downloadBlob(JSON.stringify(publishTemplate(selected), null, 2), `${safeFilename(selected.name)}-${selected.version}.opslion-layout-template.json`, "application/json"); }
    catch (error) { setNotice(explainLayoutError(error)); }
  };
  return <ModalDialog label="文章模板库" close={close}>{(dismiss) => <section className="modal layout-library">
    <header><div><span className="panel-eyebrow">文章版式</span><h2>选择文章模板</h2><p>预览整篇效果，再应用到当前文稿。</p></div><button className="close-button" aria-label="关闭弹窗" onClick={dismiss}><StudioIcon name="close" /></button></header>
    <div className="layout-library-tools"><span>{templates.length} 套模板</span><button className="text-button" disabled={importing} onClick={() => setPaste(paste === null ? "" : null)}>粘贴模板 JSON</button><button className="secondary-button" disabled={importing} onClick={() => importRef.current?.click()}><StudioIcon name="upload" />{importing ? "正在验证…" : "导入模板包"}</button></div>
    {paste !== null && <div className="semantic-paste"><label htmlFor="layout-template-json">模板 JSON</label><textarea id="layout-template-json" className="text-area" rows={6} value={paste} onChange={(event) => setPaste(event.target.value)} /><button className="primary-button" disabled={importing || !paste.trim()} onClick={() => void importTemplate(paste)}>验证并加入模板库</button><button className="text-button" disabled={importing} onClick={() => setPaste(null)}>取消</button></div>}
    {notice && <p className="layout-library-notice" role="status">{notice}</p>}
    {selected ? <div className="layout-library-body"><div className="layout-library-catalog" role="group" aria-label="选择文章模板">
      {templates.map((template) => <button key={keyOf(template)} className={`layout-catalog-card ${keyOf(selected) === keyOf(template) ? "selected" : ""}`} aria-pressed={keyOf(selected) === keyOf(template)} aria-label={`选择${template.name}`} onClick={() => { setSelectedKey(keyOf(template)); setPresetId(null); }}>
        <span className="layout-catalog-preview" aria-hidden="true"><iframe tabIndex={-1} title={`${template.name} 标准样刊缩略图`} sandbox="" srcDoc={previewDocument(previews.get(keyOf(template))?.html ?? "")} /></span>
        <span className="layout-catalog-copy"><strong>{template.name}<StudioIcon name="check" /></strong><span>{template.tags.slice(0, 3).join(" · ")}</span><small>v{template.version}</small></span>
      </button>)}
    </div><div className="layout-library-detail"><div className="layout-detail-heading"><div><h3>{selected.name}</h3><p>{selected.description}</p></div><SegmentedControl value={source} onChange={setSource} label="预览内容" className="property-segment" options={[{ value: "sample", label: "标准样刊" }, { value: "article", label: "当前文章" }]} /></div>
      <div className="layout-detail-presets"><span>配色</span><button aria-pressed={selectedPreset === null} onClick={() => setPresetId(null)}>默认</button>{selected.presets.map((preset) => <button key={preset.id} aria-pressed={selectedPreset === preset.id} onClick={() => setPresetId(preset.id)}>{preset.name}</button>)}</div>
      <div className="layout-detail-preview">{current.error ? <div className="layout-render-error" role="alert"><strong>这个模板暂时无法排版</strong><p>{current.error}</p></div> : <iframe className="layout-full-preview" title="完整文章模板预览" sandbox="" srcDoc={previewDocument(current.html)} />}</div>
    </div></div> : <div className="layout-library-empty" role="status"><StudioIcon name="layers" /><h3>模板库为空</h3><p>导入文章模板包后，即可预览配色并套用到当前文章。</p><button className="primary-button" disabled={importing} onClick={() => importRef.current?.click()}>导入第一个模板</button></div>}
    {selected && <footer className="layout-library-footer"><div><button className="text-button" onClick={downloadSelected}>下载模板包</button>{saved.some((item) => keyOf(item) === keyOf(selected)) && <button className="text-button" onClick={async () => { try { await removeLayoutTemplate(selected.id, selected.version); setSaved((items) => items.filter((item) => keyOf(item) !== keyOf(selected))); setSelectedKey(""); setPresetId(null); notify("已从个人模板库移除，已保存的文章仍保有所用版本"); } catch { setNotice("移除失败，请重试"); } }}>移出模板库</button>}</div><button className="primary-button" disabled={Boolean(current.error)} onClick={() => apply(selected, selectedPreset)}>套用到当前文章<StudioIcon name="arrow" /></button></footer>}
    <input ref={importRef} type="file" accept=".json,.opslion-layout-template.json" hidden aria-label="导入文章模板包文件" onChange={async (event) => {
      const input = event.currentTarget; const file = input.files?.[0]; if (!file) return;
      try { await importTemplate(await file.text()); } catch (error) { setNotice(explainLayoutError(error)); } finally { input.value = ""; }
    }} />
  </section>}</ModalDialog>;
}
