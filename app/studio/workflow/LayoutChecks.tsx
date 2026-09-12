import { useEffect, useRef } from "react";
import type { CompatibilityIssue } from "../types";
import type { Workflow } from "./types";
import { UsageSummary } from "./UsageSummary";

/** Live checks describe the current draft; they never require a separate signoff. */
export function LayoutChecks({ issues, ready, busy, run }: { issues: CompatibilityIssue[]; ready: boolean; busy: boolean; run?: Workflow["run"] }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const errors = issues.filter((issue) => issue.level === "error");
  const notices = issues.filter((issue) => issue.level === "warning");
  const state = busy ? "busy" : errors.length ? "error" : !ready ? "empty" : notices.length ? "warning" : "ready";
  const label = busy ? "正在自动检查" : errors.length ? `${errors.length} 项待处理` : !ready ? "等待文稿" : notices.length ? `${notices.length} 项排版提示` : "自动检查通过";
  useEffect(() => {
    const close = (event: PointerEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    const closeKey = (event: KeyboardEvent) => { if (event.key === "Escape" && menu.current?.open) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); event.stopPropagation(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeKey);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", closeKey); };
  }, []);
  return <details className="workflow-checks" ref={menu}>
    <summary data-state={state} aria-label={`自动检查：${label}`}><span aria-hidden="true">{state === "ready" ? "✓" : state === "error" || state === "warning" ? "!" : "·"}</span>{label}</summary>
    <div className="workflow-check-results">
      <strong>成稿自动检查</strong>
      <p>自动检查内容去向、缺图、模板编译和基础兼容性。</p>
      {errors.length + notices.length ? <ul>{[...errors, ...notices].map((issue, index) => <li key={index} data-level={issue.level}><b>{issue.title}</b><span>{issue.detail}</span></li>)}</ul> : <p>{busy ? "正在排版，完成后将检查最终结果。" : ready ? "当前检查未发现缺项或兼容性问题，可预览或导出。" : "导入模板和文稿后开始检查。"}</p>}
      {run && <div className="workflow-run-details"><p>{run.mode === "local" ? "本地排版" : "AI 增强"} · 模型请求 {run.requests ?? "未知"} 次</p>{run.mode === "ai" && <UsageSummary usage={run.usage} />}</div>}
    </div>
  </details>;
}
