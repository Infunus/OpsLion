"use client";

import { useEffect, useState } from "react";
import { requestJson } from "../request";
import { emptyWeeklyFixedContent, hasWeeklyFixedContent, type WeeklyFixedContent } from "./fixed-content";

async function settingsRequest(settings?: WeeklyFixedContent) {
  const payload = await requestJson<{ settings: WeeklyFixedContent }>("/local-api/weekly/template-settings", settings ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) } : {});
  if (!payload.settings || Object.keys(emptyWeeklyFixedContent).some((key) => typeof payload.settings[key as keyof WeeklyFixedContent] !== "string")) throw new Error("固定信息未能读取，请重新启动排版台后重试");
  return payload.settings;
}

export function useWeeklyFixedContent() {
  const [settings, setSettings] = useState(emptyWeeklyFixedContent);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    settingsRequest().then((value) => { if (active) { setSettings(value); setLoaded(true); setError(""); } }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "固定信息读取失败"); });
    return () => { active = false; };
  }, [revision]);
  return { settings, loaded, error, ready: loaded && !error && hasWeeklyFixedContent(settings), reload: () => setRevision((value) => value + 1), saved: (value: WeeklyFixedContent) => { setSettings(value); setLoaded(true); setError(""); } };
}

export function FixedContentSettings({ state }: { state: ReturnType<typeof useWeeklyFixedContent> }) {
  const [open, setOpen] = useState(false);
  return <div className="hello-week-fixed-settings">
    <button className="text-button" aria-expanded={open} disabled={!state.loaded && !state.error} onClick={() => setOpen(!open)}>模板固定信息</button>
    <p>联系我们和组织落款自动附在文末，文案、排版、校对的人名留空。</p>
    {state.error ? <p className="weekly-error" role="alert">{state.error} <button className="text-button" onClick={state.reload}>重试读取</button></p> : !state.loaded ? <p role="status">正在读取本机设置…</p> : !state.ready ? <p role="status">导出前，请先填写模板固定信息。</p> : null}
    {open && <SettingsForm initial={state.settings} onSaved={(value) => { state.saved(value); setOpen(false); }} />}
  </div>;
}

function SettingsForm({ initial, onSaved }: { initial: WeeklyFixedContent; onSaved: (value: WeeklyFixedContent) => void }) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return <form onSubmit={async (event) => {
    event.preventDefault(); if (saving) return;
    setSaving(true); setError("");
    try { onSaved(await settingsRequest(draft)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "固定信息保存失败"); }
    finally { setSaving(false); }
  }}>
    <label>落款组织<input required maxLength={300} value={draft.organization} onChange={(event) => setDraft({ ...draft, organization: event.target.value })} /></label>
    <label>学生会公共邮箱<input required type="email" maxLength={300} value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
    <label>学生会负责人及联系方式<input required maxLength={300} value={draft.contactPerson} onChange={(event) => setDraft({ ...draft, contactPerson: event.target.value })} /></label>
    <p>只保存到本机，之后每期自动使用。</p>
    {error && <p className="weekly-error" role="alert">{error}</p>}
    <button className="secondary-button" disabled={saving || !hasWeeklyFixedContent(draft)}>{saving ? "保存中…" : "保存固定信息"}</button>
  </form>;
}
