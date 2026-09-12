"use client";
import { useState } from "react";
import { nativeBasics } from "./native-model";
import type { CloneTemplateState } from "../types";

export function NativeModules({ state, insert, position, setPosition, selectedLabel, collapse, back }: {
  state: CloneTemplateState; insert: (kind: string) => void; position: "before" | "after"; setPosition: (value: "before" | "after") => void;
  selectedLabel: string; collapse: () => void; back: () => void;
}) {
  const [query, setQuery] = useState("");
  return <aside className="editor-panel panel template-module-sidebar" aria-label="当前模板模块">
    <div className="panel-title-row"><h2>模板模块</h2><button className="icon-button" aria-label="收起模块边栏" onClick={collapse}>‹</button></div>
    <button className="text-button" onClick={back}>返回逐项编辑</button>
    <p className="module-sidebar-note">{state.name} · 点击原稿模块可按原样插入副本，也可添加基础模块。</p>
    <input type="search" aria-label="搜索模板模块" placeholder="搜索标题、正文或原稿模块" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="module-insertion-position"><span>{selectedLabel || "插入到稿件末尾"}</span><select aria-label="模块插入位置" value={position} disabled={!selectedLabel} onChange={(event) => setPosition(event.target.value as "before" | "after")}><option value="after">选中模块之后</option><option value="before">选中模块之前</option></select></div>
    <div className="native-basic-modules">{Object.entries(nativeBasics).filter(([, label]) => !query || label.includes(query)).map(([kind, label]) => <button className="secondary-button" key={kind} onClick={() => insert(kind)}>插入{label}模块</button>)}</div>
    <h3>原稿模块</h3>
    <div className="template-module-list">{state.modules.filter((module) => !query || module.label.includes(query)).map((module, index) => <button className="template-module-card" key={module.id} aria-label={`插入原稿模块 ${module.label}`} onClick={() => insert(module.id)}><span className="module-card-label"><strong>{String(index + 1).padStart(2, "0")} · {module.label}</strong><span>＋</span></span>{!module.included && <span className="module-sidebar-note">已从稿件移除，可重新插入</span>}</button>)}</div>
  </aside>;
}
