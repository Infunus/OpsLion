"use client";
import { AutoTextarea } from "./AutoTextarea";
import { UnplacedContent } from "./UnplacedContent";
import { useMemo } from "react";
import type { StudioProject, ContentSection, CloneTemplateState } from "./types";
import { StudioIcon } from "./StudioIcon";
import { SlidingTabs } from "./SlidingTabs";
import { useListMotion } from "./useListMotion";
import { templateSlotContexts } from "./template-clone";
import { articleMentionsImage } from "./project-utils";
import { previewAssetUrl } from "./preview-assets";
export function ComposeEditor(props: {
  project: StudioProject;
  rawImportOpen: boolean;
  rawText: string;
  setRawText: (value: string) => void;
  setRawImportOpen: (value: boolean) => void;
  parseRawText: () => void;
  updateProject: (patch: Partial<StudioProject>) => void;
  updateContent: (patch: Partial<StudioProject["content"]>) => void;
  updateSection: (id: string, patch: Partial<ContentSection>) => void;
  addSection: () => void;
  duplicateSection: (index: number) => void;
  removeSection: (index: number) => void;
  moveSection: (index: number, direction: -1 | 1) => void;
  handleImageFile: (id: string, file?: File) => void;
  chooseDocx: () => void;
  docxImporting: boolean;
  agentConfigured: boolean;
  agentBusy: boolean;
  runAgent: () => void;
  openAgentSettings: () => void;
  openLayoutLibrary: () => void;
  chooseModelDocx: () => void;
}) {
  const { project, rawImportOpen, rawText } = props;
  const sectionListRef = useListMotion(project.content.sections.map((section) => section.id).join(","));
  return (
    <aside className="editor-panel panel">
      <div className="panel-title-row"><div><span className="panel-eyebrow">内容</span><h2>文稿编辑</h2></div><button className="text-button" onClick={() => props.setRawImportOpen(!rawImportOpen)}>{rawImportOpen ? "返回" : "粘贴文本"}</button></div>
      <div className="editor-quick-actions">
        <button className="secondary-button compose-template-entry" onClick={props.openLayoutLibrary}><StudioIcon name="layers" />模板库</button>
        <button className="import-document" onClick={props.chooseDocx} disabled={props.docxImporting}><StudioIcon name="upload" /><span>{props.docxImporting ? "正在读取…" : "导入 Word"}</span><small>DOCX</small></button>
        <details className="optional-tools"><summary title="智能整理"><StudioIcon name="spark" /><span>智能整理</span></summary><div className="agent-action-card"><strong>文案语义识别</strong><p>识别标题层级与图文结构，保留原文，审核后应用。</p><button className="secondary-button" onClick={props.agentConfigured ? props.runAgent : props.openAgentSettings} disabled={props.agentBusy}>{props.agentBusy ? "分析中…" : props.agentConfigured ? "智能整理" : "配置模型"}</button><button className="secondary-button" onClick={props.chooseModelDocx} disabled={props.agentBusy}>模型解析 Word</button></div></details>
      </div>
      {rawImportOpen ? (
        <div className="raw-import">
          <div className="hint-card"><strong>纯文本备用入口</strong><p>第一行作为标题，按小标题自动拆分模块。</p></div>
          <label className="field-label" htmlFor="raw-copy">粘贴原始文案</label>
          <textarea id="raw-copy" className="text-area raw-area" value={rawText} onChange={(event) => props.setRawText(event.target.value)} placeholder={'示例：\n活动标题\n一、活动介绍\n正文……\n二、报名方式\n正文……'} />
          <button className="primary-button full-button" onClick={props.parseRawText}>识别并进入结构化编辑</button>
        </div>
      ) : (
        <>
          <label className="field-label manuscript-label" htmlFor="title">文章标题</label>
          <AutoTextarea id="title" className="manuscript-title" value={project.content.title} onChange={(event) => props.updateContent({ title: event.target.value })} />
          <label className="field-label manuscript-label" htmlFor="subtitle">副标题 <span>选填</span></label>
          <input id="subtitle" className="manuscript-subtitle" value={project.content.subtitle} onChange={(event) => props.updateContent({ subtitle: event.target.value })} placeholder="添加副标题…" />
          <label className="field-label" htmlFor="lead">导语</label>
          <AutoTextarea id="lead" className="manuscript-lead" value={project.content.lead} onChange={(event) => props.updateContent({ lead: event.target.value })} />
          <div className="section-list" ref={sectionListRef}>
            {project.content.sections.map((section, index) => (
              <article className={`section-editor ${section.visible ? "" : "muted-section"}`} key={section.id} data-motion-id={section.id}>
                <div className="section-editor-head">
                  <span className="drag-handle">{String(index + 1).padStart(2, "0")}</span>
                  <div className="section-tools">
                    <button aria-label="上移模块" disabled={index === 0} title="上移" onClick={() => props.moveSection(index, -1)}><StudioIcon name="up" /></button>
                    <button aria-label="下移模块" disabled={index === project.content.sections.length - 1} title="下移" onClick={() => props.moveSection(index, 1)}><StudioIcon name="down" /></button>
                    <button aria-label={section.visible ? "隐藏模块" : "显示模块"} aria-pressed={section.visible} title="显示或隐藏" onClick={() => props.updateSection(section.id, { visible: !section.visible })}><StudioIcon name={section.visible ? "eye" : "eyeOff"} /></button>
                    <button aria-label="复制模块" title="复制" onClick={() => props.duplicateSection(index)}><StudioIcon name="copy" /></button>
                    <button aria-label="删除模块" disabled={project.content.sections.length === 1} title="删除" className="danger-text" onClick={() => props.removeSection(index)}><StudioIcon name="trash" /></button>
                  </div>
                </div>
                <input aria-label={`模块 ${index + 1} 标题`} value={section.title} onChange={(event) => props.updateSection(section.id, { title: event.target.value })} />
                <AutoTextarea aria-label={`模块 ${index + 1} 正文`} value={section.body} onChange={(event) => props.updateSection(section.id, { body: event.target.value })} />
                <details className="image-details">
                  <summary><StudioIcon name="image" />配图</summary>
                  <label className="field-label" htmlFor={`${section.id}-image-url`}>图片 URL</label>
                  <input id={`${section.id}-image-url`} className="text-input compact-input" value={section.imageUrl} onChange={(event) => props.updateSection(section.id, { imageUrl: event.target.value })} placeholder="https://... 或选择本地预览图" />
                  <label className="file-button">选择本地图片<input type="file" accept="image/*" onChange={(event) => props.handleImageFile(section.id, event.target.files?.[0])} /></label>
                  <input className="text-input compact-input" value={section.imageCaption} onChange={(event) => props.updateSection(section.id, { imageCaption: event.target.value })} placeholder="图片说明（选填）" />
                </details>
              </article>
            ))}
          </div>
          <button className="add-section" onClick={props.addSection}><StudioIcon name="plus" />添加段落</button>
          <label className="field-label" htmlFor="ending">结尾</label>
          <AutoTextarea id="ending" className="manuscript-ending" value={project.content.ending} onChange={(event) => props.updateContent({ ending: event.target.value })} />
        </>
      )}
    </aside>
  );
}

export function CloneEditor(props: {
  changeTemplate: (state: CloneTemplateState) => void;
  project: StudioProject;
  cloneSource: string;
  cloneName: string;
  clonePanel: "slots" | "modules";
  setCloneSource: (value: string) => void;
  setCloneName: (value: string) => void;
  setClonePanel: (value: "slots" | "modules") => void;
  analyzeClone: () => void;
  updateCloneSlot: (id: string, value: string) => void;
  updateCloneSlotLink: (id: string, linkUrl: string) => void;
  updateCloneSlotRole: (id: string, role: NonNullable<CloneTemplateState["slots"][number]["role"]>) => void;
  handleCloneImageFile: (id: string, file?: File) => void;
  toggleCloneModule: (id: string) => void;
  duplicateClone: (id: string) => void;
  restoreClone: () => void;
  resolvePendingAsset: (id: string) => void;
  resetClone: () => void;
  chooseHtmlFile: () => void;
  chooseDocx: () => void;
  docxImporting: boolean;
  agentConfigured: boolean;
  agentBusy: boolean;
  runLocalFill: () => void;
  runAgent: () => void;
  openAgentSettings: () => void;
  saveTemplate: () => void;
  openTemplateLibrary: () => void;
}) {
  const state = props.project.cloneTemplate;
  const slotContexts = useMemo(() => state ? templateSlotContexts(state) : {}, [state]);
  const documentImageCount = props.project.content.sections.filter((section) => section.imageUrl.trim()).length;
  const documentMentionsImage = articleMentionsImage(props.project.content);
  return (
    <aside className="editor-panel panel">
      <div className="panel-title-row"><div><h2>历史模板</h2></div>{state && <button className="small-button" onClick={props.resetClone}>重新导入</button>}</div>
      {!state ? (
        <div className="clone-import">
          <button className="secondary-button template-library-entry" onClick={props.openTemplateLibrary}>从历史模板库选择 →</button>
          <div className="hint-card warm-hint"><strong>导入历史排版</strong><p>粘贴内联样式 HTML，或读取模板包。</p></div>
          <label className="field-label" htmlFor="clone-name">模板名称</label>
          <input id="clone-name" className="text-input" value={props.cloneName} onChange={(event) => props.setCloneName(event.target.value)} />
          <div className="field-label-row"><label className="field-label" htmlFor="clone-source">HTML / 富文本源码</label><button className="text-button" onClick={props.chooseHtmlFile}>从文件读取</button></div>
          <textarea id="clone-source" className="text-area clone-source" value={props.cloneSource} onChange={(event) => props.setCloneSource(event.target.value)} placeholder="粘贴包含内联 style 的历史文章 HTML……" />
          <button className="primary-button full-button" onClick={props.analyzeClone}>分析结构和替换位</button>

        </div>
      ) : (
        <>
          <div className="template-summary"><span>模板</span><strong>{state.name}</strong><p>{state.slots.length} 个替换位 · {state.modules.length} 个模块</p></div>
          <UnplacedContent template={state} change={props.changeTemplate} />
          <div className="template-library-actions"><button className="secondary-button" onClick={props.saveTemplate}>保存为模板</button><button className="text-button" onClick={props.openTemplateLibrary}>打开模板库</button><button className="text-button" onClick={props.restoreClone}>恢复原稿</button></div>
          <div className="template-agent-card">
            <div><span>待套版文案</span><strong>{props.project.content.title || "尚未导入文案"}</strong><p>{props.project.content.sections.length} 个内容板块 · {documentImageCount} 张文案图片 · DOCX 本地解析</p></div>
            <div><button className="small-button" onClick={props.chooseDocx} disabled={props.docxImporting}>{props.docxImporting ? "读取中…" : "导入新版 DOCX"}</button><button className="secondary-button local-fill-button" onClick={props.runLocalFill}>本地一键套版</button><button className="primary-button" onClick={props.agentConfigured ? props.runAgent : props.openAgentSettings} disabled={props.agentBusy}>{props.agentBusy ? "规划中…" : props.agentConfigured ? "Agent 智能套版" : "Agent 套版（未配置）"}</button></div>
          </div>
          
          {documentMentionsImage && documentImageCount === 0 && <div className="clone-risk-note"><b>!</b><div><strong>文案提到了二维码或图片，但 DOCX 暂无对应素材</strong><p>可以先完成正文套版，二维码稍后再补；导出前请确认没有沿用往年的内容图。</p></div></div>}
          {Boolean(state.draftWarnings?.length) && <div className="local-draft-warnings"><strong>本地套版校对清单</strong>{state.draftWarnings?.map((warning, index) => <p key={`${warning}-${index}`}>• {warning}</p>)}</div>}
          {Boolean(state.pendingAssets?.length) && <div className="pending-assets"><strong>{state.pendingAssets?.length} 项素材待补</strong><p>不影响继续编辑正文，但正式导出前需要补齐或确认不再使用。</p>{state.pendingAssets?.map((asset) => <article key={asset.id}>{asset.imageUrl && <span className="pending-asset-preview" style={{ backgroundImage: `url("${previewAssetUrl(asset.imageUrl).replace(/"/g, "%22")}")` }} />}<span><b>{asset.purpose}</b>{asset.reason}</span><button className="text-button" onClick={() => props.resolvePendingAsset(asset.id)}>明确不使用此图</button></article>)}</div>}
          <SlidingTabs value={props.clonePanel} onChange={props.setClonePanel} label="模板编辑区域" className="editor-tabs" items={[{ id: "slots", label: "逐项替换" }, { id: "modules", label: "模块结构" }]} />
          {props.clonePanel === "slots" ? (
            <div className="slot-list">
              {state.slots.map((slot, index) => (
                <label className="slot-editor" key={slot.id}>
                  <span><b>{String(index + 1).padStart(2, "0")}</b>{slot.label}</span>
                  {slot.kind === "image" ? <div className="image-slot-editor"><div className="image-slot-preview">{slot.value.trim() ? <span className="image-slot-thumbnail" role="img" aria-label={`图片槽 ${index + 1} 预览`} style={{ backgroundImage: `url("${previewAssetUrl(slot.value).replace(/"/g, "%22")}")` }} /> : <span>待补 / 已移除</span>}</div><div><input className="text-input compact-input" value={slot.value} onChange={(event) => props.updateCloneSlot(slot.id, event.target.value)} placeholder="图片 URL（可稍后补）" /><label className="file-button clone-image-file">选择本地图片<input type="file" accept="image/*" onChange={(event) => props.handleCloneImageFile(slot.id, event.target.files?.[0])} /></label><select aria-label={`图片用途 ${index + 1}`} className="slot-role-select" value={slot.role || "unknown"} onChange={(event) => props.updateCloneSlotRole(slot.id, event.target.value as NonNullable<CloneTemplateState["slots"][number]["role"]>)}><option value="unknown">保护图片（未分类）</option><option value="content_image">内容配图（套版时替换）</option><option value="decoration">装饰图片（保留原图）</option></select><small>{slotContexts[slot.id]?.moduleLabel}{slotContexts[slot.id]?.groupText ? ` · ${slotContexts[slot.id].groupText}` : ""}</small><small className={slot.value === slot.originalValue ? "original" : "changed"}>{slot.value === slot.originalValue ? "沿用历史模板原图" : slot.value.trim() ? "已替换图片" : "等待后续补图"}</small></div></div> : <><textarea value={slot.value} onChange={(event) => props.updateCloneSlot(slot.id, event.target.value)} /><input className="text-input compact-input slot-link-input" value={slot.linkUrl || ""} onChange={(event) => props.updateCloneSlotLink(slot.id, event.target.value)} placeholder="超链接 URL（选填）" /></>}
                </label>
              ))}
            </div>
          ) : (
            <div className="module-list">
              {state.modules.map((module, index) => (
                <article className="module-row" key={module.id}>
                  <button className={`module-toggle ${module.included ? "on" : ""}`} onClick={() => props.toggleCloneModule(module.id)} aria-label="显示或隐藏模块"><i /></button>
                  <div><strong>{String(index + 1).padStart(2, "0")} · {module.label}</strong><p>{module.included ? "已显示" : "已隐藏"}</p></div>
                  <button className="small-button" onClick={() => props.duplicateClone(module.id)}>复制</button>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </aside>
  );
}

