"use client";

import { useEffect, useRef, useState } from "react";
import { downloadBlob } from "./export-service";
import { recoveryBackup } from "./storage";
import { useWeeklyPersistence } from "./useWeeklyPersistence";
import { readWeeklyCopy } from "./weekly-copy";
import { WeeklyPreview } from "./weekly-template/WeeklyPreview";

export function WeeklyWorkspace({ showToast }: { showToast: (message: string) => void }) {
  const { weekly, setWeekly, ready, writable, saveState, storageError } = useWeeklyPersistence();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);

  const importFile = async (file: File) => {
    const current = ++generation.current;
    setImporting(true); setError("");
    try {
      const copy = await readWeeklyCopy(file);
      if (current !== generation.current) return;
      setWeekly({ preparedCopy: copy });
      showToast("文案已导入，正在按周报模板排版");
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "文案导入失败");
    } finally {
      if (current === generation.current) setImporting(false);
    }
  };

  return <main className="weekly-workspace">
    <header className="weekly-titlebar">
      <div><span className="panel-eyebrow">HELLO WEEK</span><h2>周报</h2><p>导入文案，自动排版与预览，再导出到秀米。</p></div>
      <span className="weekly-save-state" role="status">{ready ? saveState : "正在读取本机草稿…"}</span>
    </header>
    {storageError && <div className="weekly-error" role="alert"><p>{storageError}</p><button className="secondary-button" onClick={async () => {
      try { downloadBlob(JSON.stringify(await recoveryBackup(), null, 2), "opslion-storage-backup.json", "application/json"); }
      catch { setError("备份读取失败，请重试"); }
    }}>下载存储备份</button></div>}
    <section className="weekly-import-panel" aria-label="导入周报文案">
      <div><span className="hello-week-eyebrow">01 · 导入文案</span><h3>导入本期文案</h3><p>使用周报模板约定的 Markdown 或 TXT 文案，导入后即可预览。</p></div>
      <button className="primary-button" disabled={!ready || !writable || importing} onClick={() => inputRef.current?.click()}>{importing ? "正在导入…" : "导入处理好的文案"}</button>
      <input ref={inputRef} type="file" hidden accept=".md,.markdown,.txt" aria-label="导入周报文案文件" disabled={!ready || !writable || importing} onChange={(event) => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        if (file) void importFile(file);
      }} />
    </section>
    {error && <p className="weekly-error" role="alert">{error}</p>}
    <WeeklyPreview key={weekly.preparedCopy?.importedAt || "examples"} copy={weekly.preparedCopy} showToast={showToast} />
  </main>;
}
