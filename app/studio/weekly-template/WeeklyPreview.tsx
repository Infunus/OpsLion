"use client";

import { useMemo, useState } from "react";
import { downloadBlob } from "../export-service";
import { preparePreviewHtml } from "../preview-assets";
import { renderWeeklyCopy, weeklyCopyTemplate, type WeeklyCopy } from "../weekly-copy";
import { FixedContentSettings, useWeeklyFixedContent } from "./FixedContentSettings";
import { helloWeekExamples } from "./examples";
import { renderHelloWeek } from "./render";
import { createWeeklyBridgePackage, createWeeklyStandaloneHtml } from "./export";

interface Props { copy: WeeklyCopy | null; showToast: (message: string) => void }

export function WeeklyPreview({ copy, showToast }: Props) {
  const fixed = useWeeklyFixedContent();
  const imported = useMemo(() => copy ? renderWeeklyCopy(copy, { ...weeklyCopyTemplate, render: (value) => renderHelloWeek(value.text, fixed.settings) }) : null, [copy, fixed.settings]);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [exampleId, setExampleId] = useState(helloWeekExamples[0].id);
  const [width, setWidth] = useState(390);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const example = helloWeekExamples.find((item) => item.id === exampleId)!;
  const sample = useMemo(() => renderHelloWeek(example.text, fixed.settings), [example, fixed.settings]);
  const showingExample = examplesOpen || !copy;
  const html = showingExample ? sample.html : imported?.html || "";
  const title = showingExample ? sample.title : imported?.title || copy?.name || "";
  const preview = useMemo(() => preparePreviewHtml(html), [html]);
  const ready = fixed.ready && !showingExample && Boolean(copy && imported?.ready);
  const exportFile = async (format: "bridge" | "html") => {
    if (!ready || exporting) return;
    setExporting(true); setExportError("");
    try {
      const filename = [...(title || "Hello Week")].map((char) => char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? "_" : char).join("").slice(0, 120);
      if (format === "bridge") downloadBlob(JSON.stringify(await createWeeklyBridgePackage(html, title), null, 2), `${filename}.xiumi.json`, "application/json;charset=utf-8");
      else downloadBlob(await createWeeklyStandaloneHtml(html, title), `${filename}.html`, "text/html;charset=utf-8");
      showToast(format === "bridge" ? "已导出周报 Bridge 包，固定素材已打包" : "已导出周报 HTML，固定素材已内嵌");
    } catch (reason) { setExportError(reason instanceof Error ? reason.message : "周报导出失败，请重试"); }
    finally { setExporting(false); }
  };

  return <section className="weekly-preview hello-week-preview" aria-label="周报排版与预览">
    <header className="weekly-panel-head">
      <div><span className="hello-week-eyebrow">03 · 排版与导出</span><h3>{showingExample ? "Hello Week 模板预览" : "周报预览"}</h3></div>
      <div className="hello-week-export"><button className="primary-button" onClick={() => void exportFile("bridge")} disabled={!ready || exporting}>{exporting ? "正在打包素材…" : "下载 Bridge 包"}</button><button className="secondary-button" onClick={() => void exportFile("html")} disabled={!ready || exporting}>HTML</button></div>
    </header>
    {exportError && <p className="weekly-error" role="alert">{exportError}</p>}
    <div className="hello-week-workbench">
      <aside className="hello-week-info">
        <div className="hello-week-template-info"><span>周报专用 · v1</span><h4>Hello Week</h4><p>18 种模块自动组合。栏目、资讯条数和内容长度均可按本期需要变化。</p><a className="secondary-button" href="/weekly/hello-week-template-v1.zip" download>下载模板与文案示例</a><p className="hello-week-template-hint">把模板包交给生成文案的 skill，输出同一格式的 Markdown。</p></div>
        <FixedContentSettings state={fixed} />
        {copy && <button className="text-button" onClick={() => setExamplesOpen(!examplesOpen)}>{showingExample ? "返回本期周报" : "查看五种模板示例"}</button>}
        {showingExample ? <div className="hello-week-example-picker"><label>参考样式<select aria-label="周报示例" value={exampleId} onChange={(event) => setExampleId(event.target.value)}>{helloWeekExamples.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p>当前为示例文案 · {sample.newsCount} 条资讯。导入本期文案后即可导出。</p><button className="text-button" onClick={() => downloadBlob(example.text, example.filename, "text/markdown;charset=utf-8")}>下载此示例文案</button></div> : copy ? <div className="weekly-prepared-copy">
          <strong>{copy.name}</strong><p role="status" className={imported?.ready ? "" : "hello-week-format-error"}>{imported?.message}</p>
          {!imported?.ready && <p>请在生成文案处按提示修正，再重新导入。</p>}
          <label className="hello-week-source-label">文案原文 · 只读<textarea aria-label="周报文案原文" spellCheck={false} readOnly value={copy.text} /></label>
          <button className="text-button" onClick={() => downloadBlob(copy.text, copy.name, copy.format === "markdown" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8")}>下载文案原文</button>
        </div> : null}
      </aside>
      <div className="hello-week-stage">
        <div className="hello-week-preview-toolbar"><span>{title}</span><label>预览宽度<select aria-label="周报预览宽度" value={width} onChange={(event) => setWidth(Number(event.target.value))}><option value={375}>375</option><option value={390}>390</option><option value={414}>414</option></select></label></div>
        <div className="hello-week-viewport">{preview ? <article className="hello-week-paper" style={{ width }} dangerouslySetInnerHTML={{ __html: preview }} /> : <div className="hello-week-empty"><h4>文案格式待修正</h4><p>{imported?.message}</p><p>原文已保存，修正后重新导入即可自动排版。</p></div>}</div>
      </div>
    </div>
  </section>;
}
