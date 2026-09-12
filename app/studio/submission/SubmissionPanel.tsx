"use client";
/* Local submission images must retain their data/proxy URLs; no remote image optimizer is involved. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { requestAgentPlan } from "../agent-client";
import { loadReusableAssets, saveReusableAssets } from "../storage";
import { ModalDialog } from "../ModalDialog";
import { previewAssetUrl } from "../preview-assets";
import { compileArticle, richTextToPlain } from "../template-engine";
import type { StudioProject } from "../types";
import { captureBaseline } from "./baseline";
import { emptySubmission, ingestFiles, addArticleAssets, removeSubmissionFile } from "./ingest";
import { applyChanges, assembleSubmission, bindAsset, cancelImageRequest, resolveAssets, imageRequestNodes, submissionRequest, unresolvedImages } from "./assemble";
import type { Asset, Submission, DraftNode } from "./types";

import { ContentPreview, ContentReview } from "./ContentReview";
import { commitSubmission, submissionTemplateName } from "./project";
import { templateContentBlockers } from "../local-template-fill";
import { renderProject } from "../renderer";
import { preparePreviewHtml } from "../preview-assets";

export function SubmissionPanel({ project, projects, configured, ai, runLayout, layoutBusy, close, configure, update, apply, notify }: {
  project: StudioProject; projects: StudioProject[]; configured: boolean; close: () => void; configure: () => void;
  ai: boolean; runLayout: () => void; layoutBusy: boolean;
  update: (mutate: (state: Submission) => Submission) => void; apply: (state: Submission) => Promise<boolean>; notify: (message: string) => void;
}) {
  const state = project.submission!;
  const currentNodes = state.draft?.nodes ?? state.base_draft ?? [];
  const selectorLabel = (selector: NonNullable<Submission["plan"]>["image_requests"][number]["selector"]) => selector.kind === "file" ? selector.relative_path : selector.kind === "label" || selector.kind === "description" ? selector.text : selector.kind === "reusable" ? `${selector.scope_id} / ${selector.key}` : selector.kind === "asset" ? state.assets.find((a) => a.id === selector.asset_id)?.origins[0]?.relative_path || "指定素材" : selector.kind === "base_node" ? "指定旧稿中的图片" : "Word 中的指定配图";
  const [busy, setBusy] = useState(""); const [review, setReview] = useState<Submission | null>(null); const [error, setError] = useState("");
  const [reusable, setReusable] = useState<Asset[]>([]); const [scope, setScope] = useState(""); const [assetKey, setAssetKey] = useState(""); const [selectedAsset, setSelectedAsset] = useState("");
  const [referenceId, setReferenceId] = useState("");
  const replaceId = useRef<string | null>(null); const input = useRef<HTMLInputElement>(null); const controller = useRef<AbortController | null>(null); const latest = useRef(project);
  const reviewSource = useRef("");
  const fingerprint = (value: StudioProject) => JSON.stringify([value.id, value.content, value.layout?.article, value.cloneTemplate, value.submission]);
  useEffect(() => { latest.current = project; }, [project]);
  useEffect(() => { void loadReusableAssets().then(setReusable).catch(() => {}); return () => controller.current?.abort(); }, []);
  const run = async () => {
    if (!configured) { configure(); return; }
    const captured = fingerprint(project); const active = new AbortController(); controller.current = active; setBusy("理解交稿中…"); setError("");
    try {
      const result = await requestAgentPlan(submissionRequest(state), active.signal);
      if (active.signal.aborted) return;
      if (captured !== fingerprint(latest.current)) throw new Error("交稿或当前文稿已修改，请重新理解，旧结果未应用");
      reviewSource.current = captured; setReview(assembleSubmission(state, result.plan));
    } catch (e) { if (!active.signal.aborted) setError(e instanceof Error ? e.message : "交稿理解失败"); }
    finally { if (controller.current === active) { controller.current = null; setBusy(""); } }
  };
  const add = async (files: File[]) => {
    const base = state; const replacing = replaceId.current; replaceId.current = null; const active = new AbortController(); controller.current = active; setBusy("读取交稿文件…"); setError("");
    try {
      const loaded = await ingestFiles(base, files);
      if (active.signal.aborted) return;
      update((current) => {
        if (current.id !== base.id) return current;
        const merge = <T extends { id: string }>(old: T[], incoming: T[], original: T[]) => [...old, ...incoming.filter((item) => !original.some((prior) => prior.id === item.id))];
        let next = { ...current, pending: merge(current.pending, loaded.pending, base.pending), files: merge(current.files, loaded.files, base.files), documents: merge(current.documents, loaded.documents, base.documents), assets: merge(current.assets, loaded.assets, base.assets), main_document_ids: current.main_document_ids.length ? current.main_document_ids : loaded.main_document_ids };
        if (replacing) {
          const wasMain = current.main_document_ids.includes(replacing);
          next = removeSubmissionFile(next, replacing, true);
          const replacement = loaded.documents.find((d) => !base.documents.some((old) => old.id === d.id));
          if (wasMain && replacement) next.main_document_ids = [replacement.id];
          if (current.applied && replacement) {
            next = captureBaseline({ ...next, mode: "update", applied: false, plan: undefined, draft: undefined, user_instructions: `请根据新版 ${replacement.name} 核对当前稿，只修改修订涉及的内容，保留其他已审内容与版式。` }, latest.current);
          }
        }
        return current.applied || current.base_draft ? resolveAssets(next) : next;
      });
    } catch (e) { setError(e instanceof Error ? e.message : "读取失败"); }
    finally { if (controller.current === active) { controller.current = null; setBusy(""); } }
  };
  const mutate = (fn: (s: Submission) => Submission) => { setError(""); try { update(fn); } catch (e) { setError(e instanceof Error ? e.message : "操作未完成"); } };
  const requests = unresolvedImages(state);
  const used = new Set(Object.values(state.bindings).flatMap((b) => b.status === "bound" ? [b.asset_id] : []));
  if (state.publishing.cover_asset_id) used.add(state.publishing.cover_asset_id);
  const markMode = (mode: Submission["mode"]) => mutate((current) => {
    const next = { ...current, mode, base_article: undefined, base_article_id: undefined, base_draft: undefined, inherited_requests: undefined, native_bindings: undefined };
    return mode === "new" ? next : captureBaseline(next, project);
  });
  return <ModalDialog close={close} label="交稿与素材">{(dismiss) => <section className="modal submission-modal">
    <header className="submission-header"><div><h2>交稿与素材</h2><p>正文、编辑要求和配图一起交，自动匹配素材并套用当前模板。</p></div><button className="close-button" aria-label="关闭交稿" onClick={dismiss}>×</button></header>
    <div className="submission-body">
      <p className="submission-target">目标模板：<strong>{submissionTemplateName(state.mode === "derive" ? [project, ...projects].find((p) => p.id === state.base_article_id) ?? project : project)}</strong>{project.mode === "clone" && <span>历史模板容量不足的内容会列入未排入清单，处理后才能导出。</span>}</p>
      {!state.applied && <section className="submission-context">
        <div className="submission-modes">{([['new', '新建文章'], ['update', '修改当前稿'], ['derive', '基于旧稿新建']] as const).map(([mode, title]) => <button key={mode} className="secondary-button" aria-pressed={state.mode === mode} disabled={Boolean(busy)} onClick={() => markMode(mode)}>{title}</button>)}</div>
        {state.mode !== "new" && <label>基准稿{state.mode === "update" ? <strong>{project.name}（未提及的内容保留）</strong> : <select aria-label="派生基准稿" value={state.base_article_id ?? ""} onChange={(event) => { const base = [project, ...projects].find((p) => p.id === event.target.value); if (base) mutate((current) => captureBaseline({ ...current, assets: current.assets.filter((a) => !a.origins.some((o) => o.article_id)) }, base)); }}><option value="">选择一份旧稿</option>{[project, ...projects.filter((p) => p.id !== project.id)].map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</label>}
        <label>本次要求<textarea aria-label="交稿要求" className="text-area" value={state.user_instructions} onChange={(event) => mutate((current) => ({ ...current, user_instructions: event.target.value }))} placeholder="例如：正文中的图3用附件合影；仅修改报名说明，其他内容保留。" /></label>
        {!state.documents.length && <label>Word 修订视图<select aria-label="修订视图" value={state.revision_view} onChange={(event) => mutate((current) => ({ ...current, revision_view: event.target.value as Submission["revision_view"] }))}><option value="accepted">接受修订后的内容</option><option value="original">修订前的内容</option></select></label>}
      </section>}
      <section><div className="submission-section-title"><h3>{state.applied ? "补充素材" : "交稿目录"}</h3><button className="secondary-button" disabled={Boolean(busy)} onClick={() => input.current?.click()}>{state.applied ? "追加图片 / 文件" : "添加 Word、图片或 ZIP"}</button></div>
        <input ref={input} aria-label="交稿文件" type="file" multiple accept=".zip,.docx,.png,.jpg,.jpeg,.gif,.webp,.avif,.txt,.md" hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void add(files); }} />
        {state.files.map((file) => <div className="submission-file" key={file.id}>
          <span>{file.relative_path}{file.disabled && <small>已停用</small>}{file.error && <small role="alert">未读取：{file.error}</small>}</span>
          {!state.applied && !file.error && !file.disabled && <select aria-label={`用途 ${file.relative_path}`} value={state.main_document_ids.includes(file.id) ? "main" : file.role} onChange={(event) => mutate((current) => ({ ...current, main_document_ids: event.target.value === "main" ? [file.id] : current.main_document_ids.filter((id) => id !== file.id), files: current.files.map((f) => f.id === file.id ? { ...f, role: event.target.value as typeof file.role } : f.role === "main" && event.target.value === "main" ? { ...f, role: "reference" } : f) }))}><option value="reference">参考材料</option><option value="instructions">交稿说明</option>{state.documents.some((d) => d.file_id === file.id) && <option value="main">主稿</option>}<option value="asset">素材</option></select>}
          <button className="text-button" disabled={Boolean(busy)} onClick={() => { replaceId.current = file.id; input.current?.click(); }}>替换文件</button>
          <button className="text-button" disabled={Boolean(busy)} onClick={() => mutate((current) => file.disabled ? { ...current, main_document_ids: file.role === "main" ? [file.id] : current.main_document_ids, files: current.files.map((f) => f.id === file.id ? { ...f, disabled: false } : f) } : removeSubmissionFile(current, file.id, true))}>{file.disabled ? "启用" : "停用"}</button>
          <button className="text-button" disabled={Boolean(busy)} onClick={() => mutate((current) => removeSubmissionFile(current, file.id))}>移除</button>
        </div>)}
        {state.documents.filter((d) => /\.docx$/i.test(d.name)).length > 1 && !state.main_document_ids.length && !state.applied && <p className="submission-notice">多份 Word 尚未指定主稿，请在目录中选择；系统不会把它们拼成一篇。</p>}
      </section>
      {requests.length > 0 && <section><h3>待绑定图片</h3>{requests.map((request) => {
        const ref = (state.draft?.nodes ?? state.base_draft)?.find((n) => n.type === "image_ref" && n.request_id === request.id); const binding = state.bindings[request.id];
        return <article className="submission-pending" key={request.id}><strong>{request.purpose}</strong><p>{binding?.status === "pending" ? binding.reason : "待绑定"}</p><small>{selectorLabel(request.selector)}</small>
          {ref?.type === "image_ref" && ref.previous?.type === "image" && <div><img className="submission-thumb" src={previewAssetUrl(ref.previous.src)} alt="待替换旧图" /><button className="text-button" onClick={() => mutate((current) => { const old = ref.previous!; if (old.type !== "image") return current; const asset: Asset = { id: `${request.id}:original`, storage_ref: old.src, media_type: "image/*", origins: [], aliases: [] }; return bindAsset({ ...current, assets: [...current.assets, asset] }, request.id, asset.id); })}>本次仍沿用原图</button></div>}
          <select aria-label={`绑定 ${request.purpose}`} value="" onChange={(event) => { if (event.target.value) mutate((current) => bindAsset(current, request.id, event.target.value)); }}><option value="">从本次、旧稿或固定素材选择</option>{state.assets.map((asset) => <option value={asset.id} key={asset.id}>{asset.origins[0]?.relative_path || asset.reusable?.key || asset.id}{binding?.status === "pending" && binding.candidate_asset_ids.includes(asset.id) ? "（候选）" : ""}</option>)}</select>
          <button className="text-button" onClick={() => mutate((current) => cancelImageRequest(current, request.id))}>{ref?.type === "image_ref" && ref.previous ? "取消换图，保留原图" : "取消这处插图需求"}</button>
        </article>;
      })}</section>}
      {currentNodes.some((node) => node.type === "image") && <section><h3>文章配图与来源</h3>{currentNodes.map((node, index) => {
        if (node.type !== "image") return null;
        const requestId = imageRequestNodes(state)[node.id];
        const binding = requestId ? state.bindings[requestId] : undefined;
        const asset = binding?.status === "bound" ? state.assets.find((a) => a.id === binding.asset_id) : state.assets.find((a) => a.storage_ref === node.src);
        return <article className="submission-image-binding" key={node.id}><ContentPreview node={node} /><div><strong>第 {index + 1} 项 · {node.alt || "正文配图"}</strong><p>来源：{asset?.origins[0]?.relative_path || "文章内图片"}</p><select aria-label={`替换文章配图 ${node.id}`} value={asset?.id ?? ""} onChange={(event) => mutate((current) => {
          if (requestId) return bindAsset(current, requestId, event.target.value);
          const replacement = current.assets.find((a) => a.id === event.target.value); const activeNodes = current.draft?.nodes ?? current.base_draft; if (!replacement || !activeNodes) return current;
          const nodes = activeNodes.map((item) => item.id === node.id ? { ...node, src: replacement.storage_ref } : item);
          return current.draft ? { ...current, draft: { ...current.draft, nodes } } : { ...current, base_draft: nodes };
        })}><option value="" disabled>选择替换素材</option>{state.assets.map((a) => <option key={a.id} value={a.id}>{a.origins[0]?.relative_path || a.reusable?.key || a.id}</option>)}</select></div></article>;
      })}</section>}
      {state.publishing.cover_asset_id && <section><h3>发布封面</h3><img className="submission-thumb" src={previewAssetUrl(state.assets.find((asset) => asset.id === state.publishing.cover_asset_id)!.storage_ref)} alt="已绑定的发布封面" /><p className="submission-notice">已保存为发布信息，正文不重复插入。</p></section>}
      {state.pending.length > 0 && <section><h3>需要处理</h3>{state.pending.map((pending) => <article className="submission-pending" key={pending.id}><p>{pending.message}</p>{state.documents.flatMap((d) => d.blocks).filter((b) => pending.source_ids.includes(b.id)).map((b) => <ContentPreview key={b.id} node={{ id: b.id, type: "paragraph", content: b.content }} />)}<button className="secondary-button" onClick={() => mutate((current) => ({ ...current, pending: current.pending.filter((p) => p.id !== pending.id), decisions: [...current.decisions, { id: pending.id, resolution: pending.kind === "layout_preference" ? "用户已在画布落实并核对版式要求" : "用户已核对本项当前内容，确认保留" }] }))}>{pending.kind === "layout_preference" ? "已在画布落实此要求" : "已核对，按当前内容保留"}</button>{pending.kind === "select_target" && pending.proposed_change && "target_node_id" in pending.proposed_change && <select aria-label={`选择目标 ${pending.id}`} defaultValue="" onChange={(event) => { const target = event.target.value; if (!target) return; mutate((current) => ({ ...current, draft: current.draft ? { ...current.draft, nodes: applyChanges(current.draft.nodes, [{ ...pending.proposed_change!, target_node_id: target } as typeof pending.proposed_change], current) } : undefined, pending: current.pending.filter((p) => p.id !== pending.id), decisions: [...current.decisions, { id: pending.id, resolution: `选择目标 ${target}` }] })); }}><option value="">选择要修改的内容</option>{pending.candidate_ids.map((id) => { const node = state.draft?.nodes.find((n) => n.id === id); return <option value={id} key={id}>{node && "content" in node ? richTextToPlain(node.content).slice(0, 60) : id}</option>; })}</select>}<button className="text-button" onClick={() => mutate((current) => ({ ...current, pending: current.pending.filter((p) => p.id !== pending.id), decisions: [...current.decisions, { id: pending.id, resolution: "用户明确取消此要求，保留当前稿" }] }))}>{pending.kind === "layout_preference" ? "明确接受偏差，保留当前版式" : "取消此要求，保留当前稿"}</button></article>)}</section>}
      <section><div className="submission-section-title"><h3>素材 · {state.assets.length}</h3><span>{used.size} 项已绑定，其余可保留备用</span></div>
        <div className="submission-assets">{state.assets.map((asset) => <button className="submission-asset" aria-pressed={selectedAsset === asset.id} key={asset.id} onClick={() => setSelectedAsset(asset.id)}><img src={previewAssetUrl(asset.storage_ref)} alt={asset.origins[0]?.relative_path ?? "素材"} /><span>{asset.origins[0]?.relative_path || asset.reusable?.key || asset.id}</span><small>{used.has(asset.id) ? "已绑定" : "未分配"}</small></button>)}</div>
        <div className="submission-reference"><select aria-label="素材来源旧稿" value={referenceId} onChange={(event) => setReferenceId(event.target.value)}><option value="">选择允许取图的旧稿</option>{[project, ...projects.filter((p) => p.id !== project.id)].map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className="secondary-button" disabled={!referenceId} onClick={() => { const reference = [project, ...projects].find((p) => p.id === referenceId); if (reference) mutate((current) => { const base = captureBaseline(emptySubmission(), reference); const next = addArticleAssets(current, base.base_article!, reference.name); return current.applied || current.base_draft ? resolveAssets(next) : next; }); }}>加入该稿图片</button></div>
        <details><summary>账号 / 栏目固定素材</summary><div className="submission-reference"><input aria-label="固定素材范围" placeholder="账号或栏目" value={scope} onChange={(event) => setScope(event.target.value)} /><input aria-label="固定素材键" placeholder="如 follow-qr" value={assetKey} onChange={(event) => setAssetKey(event.target.value)} /><button className="secondary-button" disabled={!selectedAsset || !scope.trim() || !assetKey.trim()} onClick={async () => { const selected = state.assets.find((a) => a.id === selectedAsset); if (!selected) return; const asset = { ...selected, reusable: { scope_id: scope.trim(), key: assetKey.trim() } }; const next = [...reusable.filter((a) => a.reusable?.scope_id !== scope.trim() || a.reusable?.key !== assetKey.trim()), asset]; try { await saveReusableAssets(next); setReusable(next); notify("已保存固定素材"); } catch { setError("固定素材保存失败"); } }}>将所选图设为固定素材</button></div>{reusable.map((asset) => <button className="text-button" key={`${asset.reusable?.scope_id}:${asset.reusable?.key}`} onClick={() => mutate((current) => { const next = { ...current, assets: [...current.assets.filter((a) => a.id !== asset.id), asset] }; return current.applied || current.base_draft ? resolveAssets(next) : next; })}>加入 {asset.reusable?.scope_id} / {asset.reusable?.key}</button>)}</details>
      </section>
      {review && <SubmissionReview project={state.mode === "derive" ? [project, ...projects].find((p) => p.id === state.base_article_id) ?? project : project} review={review} setReview={setReview} busy={Boolean(busy)} apply={async () => {
        if (reviewSource.current !== fingerprint(latest.current)) { setError("交稿或文稿已修改，请重新理解后应用"); return; }
        setBusy("应用中…"); try { if (await apply(review)) setReview(null); } finally { setBusy(""); }
      }} />}
      {!state.applied && <details><summary>高级 · 理解材料关系与局部修改</summary><p>模型建议将在单独的对照中审核，需先启用 AI 增强。</p><button className="secondary-button" disabled={Boolean(busy) || (configured && !ai)} onClick={() => void run()}>{configured ? "理解并组装交稿" : "配置模型"}</button></details>}
      {error && <p className="submission-error" role="alert">{error}</p>}
    </div>
    <footer className="submission-footer">{state.applied ? <><button className="secondary-button" onClick={() => mutate(() => captureBaseline(emptySubmission("update"), project))}>开始新的局部修改</button><button className="secondary-button" onClick={dismiss}>继续编辑文章</button></> : <span>缺图保留位置，含糊要求进入待办；成稿可直接修改。</span>}{busy ? <button className="secondary-button" onClick={() => { controller.current?.abort(); controller.current = null; setBusy(""); }}>取消等待</button> : <button className="primary-button" disabled={layoutBusy} onClick={runLayout}>一键排版</button>}</footer>
  </section>}</ModalDialog>;
}

function SubmissionReview({ project, review, setReview, busy, apply }: { project: StudioProject; review: Submission; setReview: (state: Submission) => void; busy: boolean; apply: () => Promise<void> }) {
  let preview = "", problem = ""; let blockers: string[] = []; const components: Record<string, string> = {};
  try {
    const result = commitSubmission(project, review); preview = preparePreviewHtml(renderProject(result));
    if (result.mode === "clone") blockers = templateContentBlockers(result.cloneTemplate);
    else if (result.layout) {
      const layout = result.layout; const plan = compileArticle(layout.article, layout.template, layout.presetId, layout.overrides, { nodeVariants: layout.nodeVariants }).plan;
      const walk = (item: typeof plan.page) => { item.primarySources.forEach((id) => { components[id] = item.component; }); Object.values(item.regions).forEach((children) => children.forEach(walk)); }; walk(plan.page);
    }
  } catch (e) { problem = e instanceof Error ? e.message : "模板排版失败"; }
  const blocks = new Map(review.documents.flatMap((doc) => doc.blocks.map((b) => [b.id, b] as const)));
  const sources = Object.fromEntries(review.plan?.article?.nodes.map((node) => [node.id, node.source_ids.flatMap((id): DraftNode[] => { const block = blocks.get(id); return block ? [{ id, type: "paragraph", content: block.content }] : []; })]) ?? []);
  return <section className="submission-review"><h3>组装结果 · {submissionTemplateName(project)}</h3><p>{review.draft?.nodes.length} 项正文内容 · {unresolvedImages(review).length} 项图片待绑定 · {review.pending.length} 项待处理</p>
    {blockers.map((message) => <p className="submission-error" key={message}>{message}</p>)}{problem && <p role="alert">{problem}</p>}
    <ContentReview before={review.base_draft ?? review.base_article?.nodes} after={review.draft?.nodes ?? []} sources={sources} components={components} change={(id, content) => setReview({ ...review, draft: { ...review.draft!, nodes: review.draft!.nodes.map((node) => node.id === id && "content" in node ? { ...node, content } : node) } })} revert={(id) => {
      const before = (review.base_draft ?? review.base_article?.nodes)?.find((node) => node.id === id);
      const nodes = review.draft!.nodes.filter((node) => node.id !== id);
      if (before) nodes.splice(Math.max(0, (review.base_draft ?? review.base_article!.nodes).findIndex((node) => node.id === id)), 0, before);
      else if (review.draft!.nodes.find((node) => node.id === id)?.type === "article_title") nodes.unshift({ id, type: "article_title", content: [] });
      setReview({ ...review, draft: { ...review.draft!, nodes }, decisions: [...review.decisions, { id, resolution: before ? "用户保留此项原稿" : "用户在核对中明确排除此项" }] });
    }} />
    {review.plan?.excluded_sources.map((source) => <p key={source.source_id}>作为{source.role === "instruction" ? "编辑指示" : "参考材料"}：{source.reason}</p>)}
    <details><summary>查看实际模板排版</summary><div className="submission-layout-preview" dangerouslySetInnerHTML={{ __html: preview }} /></details>
    <button className="primary-button" disabled={busy || Boolean(problem)} onClick={() => void apply()}>应用组装结果</button>
  </section>;
}
