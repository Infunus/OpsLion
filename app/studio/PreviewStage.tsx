"use client";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { StudioIcon } from "./StudioIcon";
import { SegmentedControl } from "./SegmentedControl";
import { PREVIEW_MIN_WIDTH, PREVIEW_MAX_WIDTH } from "./useWorkspacePreferences";
import { EditableArticle, type CanvasEditing } from "./canvas/EditableArticle";
import { NativeArticle, type NativeEditing } from "./canvas/NativeArticle";
import { moduleLabels } from "./canvas/model";

export function PreviewStage({ html, title, empty, width, setWidth, ready, focused, toggleFocus, visualKey, openInspector, error, editing, nativeEditing, fallbackEditor }: {
  html: string; title: string; empty: boolean; width: number; setWidth: (width: number) => void;
  ready: boolean; focused: boolean; toggleFocus: () => void; visualKey: string; openInspector: () => void;
  error?: string;
  editing?: CanvasEditing;
  nativeEditing?: NativeEditing;
  fallbackEditor?: ReactNode;
}) {
  const controls = editing ?? nativeEditing;
  const [readOnlyAt, setReadOnlyAt] = useState<{ request: CanvasEditing["focusRequest"] } | null>(null);
  const [legacyEditing, setLegacyEditing] = useState(false);
  const editMode = controls ? readOnlyAt === null || readOnlyAt.request !== controls.focusRequest : Boolean(fallbackEditor) && legacyEditing;
  const [availableWidth, setAvailableWidth] = useState(390);
  const [resizing, setResizing] = useState(false);
  const viewportRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const resizeStart = useRef<{ x: number; width: number; scale: number } | null>(null);
  const clamp = (value: number) => Math.min(PREVIEW_MAX_WIDTH, Math.max(PREVIEW_MIN_WIDTH, Math.round(value)));
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = viewportRef.current?.animate([{ opacity: .55, translate: "0 5px" }, { opacity: 1, translate: "0 0" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
    return () => animation?.cancel();
  }, [visualKey]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => { if (viewport.clientWidth > 0) setAvailableWidth(viewport.clientWidth); });
    observer.observe(viewport);
    const closeMenu = (event: PointerEvent) => { if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false; };
    const closeMenuKey = (event: KeyboardEvent) => { if (event.key === "Escape" && menuRef.current?.open) { menuRef.current.open = false; event.stopPropagation(); menuRef.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeMenuKey);
    return () => { observer.disconnect(); document.removeEventListener("pointerdown", closeMenu); document.removeEventListener("keydown", closeMenuKey); };
  }, []);
  return <section className="preview-stage">
    <header className="preview-toolbar">
      <SegmentedControl value={editMode ? "edit" : "preview"} label="画布模式" className="canvas-mode-toggle" disabled={!ready || empty || (!controls && !fallbackEditor)} options={[{ value: "preview", label: "预览" }, { value: "edit", label: "编辑" }]} onChange={(mode) => { setReadOnlyAt(mode === "preview" ? { request: controls?.focusRequest ?? null } : null); setLegacyEditing(mode === "edit"); }} />
      <div className="preview-actions">
        {controls && <button className="text-button canvas-modules-trigger" onClick={controls.openModules}>模板模块</button>}
        <details className="preview-size-menu" ref={menuRef}>
          <summary aria-label="调整画布宽度"><span>{width}</span><small>px</small><StudioIcon name="down" /></summary>
          <div className="preview-width-control" style={{ "--range-fill": `${(width - PREVIEW_MIN_WIDTH) / (PREVIEW_MAX_WIDTH - PREVIEW_MIN_WIDTH) * 100}%` } as CSSProperties}>
            <label htmlFor="preview-width">画布宽度 <output htmlFor="preview-width">{width} px</output></label>
            <input disabled={!ready} id="preview-width" type="range" min={PREVIEW_MIN_WIDTH} max={PREVIEW_MAX_WIDTH} step={1} value={width} aria-valuetext={`${width} 像素`} onChange={(event) => setWidth(Number(event.target.value))} />
            <SegmentedControl value={width} onChange={setWidth} disabled={!ready} label="常用画布宽度" className="viewport-toggle" options={[375, 390, 640].map((value) => ({ value, label: String(value), ariaLabel: `${value} 像素` }))} />
          </div>
        </details>
        <span className="toolbar-divider" />
        <button className="icon-button focus-preview" title={focused ? "返回编辑" : "聚焦预览"} aria-label="聚焦预览" aria-pressed={focused} onClick={toggleFocus}><StudioIcon name={focused ? "collapse" : "focus"} /></button>
        <button className="icon-button inspector-trigger" aria-label="打开版式设置" title="版式设置" onClick={openInspector}><StudioIcon name="panel" /></button>
      </div>
    </header>
    {controls?.error && editMode && <p className="canvas-binding-error" role="alert">画布编辑暂不可用：{controls.error}。可继续使用文稿编辑栏。</p>}
    {controls && !controls.error && editMode && <div className="canvas-edit-toolbar" role="toolbar" aria-label="画布编辑工具">
      <button className="icon-button" aria-label="撤销编辑" title="撤销 Ctrl+Z" disabled={!controls.canUndo} onMouseDown={(event) => event.preventDefault()} onClick={controls.undo}>↶</button><button className="icon-button" aria-label="重做编辑" title="重做 Ctrl+Y" disabled={!controls.canRedo} onMouseDown={(event) => event.preventDefault()} onClick={controls.redo}>↷</button>
      {controls.selected ? <><span className="canvas-selected-label">{editing ? moduleLabels[editing.article.nodes.find((node) => node.id === controls.selected)?.type ?? "paragraph"] : nativeEditing?.selectedLabel}</span>
        {editing && [["bold", "加粗", "B"], ["italic", "斜体", "I"], ["underline", "下划线", "U"]].map(([command, name, icon]) => <button key={command} className="icon-button" aria-label={`画布${name}`} onMouseDown={(event) => event.preventDefault()} onClick={() => { const active = document.activeElement; if (active instanceof HTMLElement && active.closest(".editable-article") && active.isContentEditable) { document.execCommand(command); active.dispatchEvent(new Event("input", { bubbles: true })); } }}>{icon}</button>)}
        <span className="toolbar-divider" />{([['up', '上移'], ['down', '下移'], ['duplicate', '复制'], ['delete', '删除']] as const).map(([op, label]) => <button key={op} className="text-button" aria-label={`画布${label}模块`} onClick={() => controls.operate(op)}>{label}</button>)}
        <button className="text-button" onClick={controls.openModules}>＋ 插入</button>
      </> : <span className="canvas-edit-hint">点击文字编辑，选中模块后可移动或删除</span>}
    </div>}
    <div className="preview-canvas">
      <div className="article-paper" data-resizing={resizing} style={{ width, maxWidth: "100%" }}>
        <button className="preview-resize-handle" role="slider" aria-label="拖动调整预览宽度" aria-valuemin={PREVIEW_MIN_WIDTH} aria-valuemax={PREVIEW_MAX_WIDTH} aria-valuenow={width} aria-valuetext={`${width} 像素`} aria-orientation="horizontal" disabled={!ready}
          onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); resizeStart.current = { x: event.clientX, width, scale: width / Math.max(1, availableWidth) }; event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); }}
          onPointerMove={(event) => { if (resizeStart.current) setWidth(clamp(resizeStart.current.width + (event.clientX - resizeStart.current.x) * resizeStart.current.scale)); }}
          onPointerUp={(event) => { resizeStart.current = null; setResizing(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onLostPointerCapture={() => { resizeStart.current = null; setResizing(false); }}
          onKeyDown={(event) => { const step = event.shiftKey ? 10 : 1; const next = event.key === "ArrowRight" ? width + step : event.key === "ArrowLeft" ? width - step : event.key === "Home" ? PREVIEW_MIN_WIDTH : event.key === "End" ? PREVIEW_MAX_WIDTH : null; if (next !== null) { event.preventDefault(); setWidth(clamp(next)); } }}><span /></button>
        <article ref={viewportRef} className="preview-content" aria-label={`${title} 手机预览`}>
          {error ? <div className="layout-render-error" role="alert"><strong>排版暂未完成</strong><p>{error}</p></div> : empty ? <div className="preview-empty"><StudioIcon name="document" /><strong>等待导入模板</strong></div> : editMode && fallbackEditor ? fallbackEditor : controls && !controls.error && editMode ? <div style={{ width, zoom: Math.min(1, availableWidth / width) }}>{editing ? <EditableArticle editing={editing} /> : nativeEditing ? <NativeArticle editing={nativeEditing} /> : null}</div> : <div style={{ width, zoom: Math.min(1, availableWidth / width) }} dangerouslySetInnerHTML={{ __html: html }} />}
        </article>
      </div>
      <div className="preview-note"><span>{Math.round(Math.min(1, availableWidth / width) * 100)}%</span><i />{focused ? "Esc 返回编辑" : "实时排版"}</div>
    </div>
  </section>;
}
