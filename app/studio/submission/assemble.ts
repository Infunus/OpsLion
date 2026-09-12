import { parsedArticleSchema, richTextToPlain, type ArticleNode, type ParsedArticle } from "../template-engine";
import { submissionPlanSchema, type ContentChange, type DraftNode, type SourceNode, type Submission, type SubmissionPlan } from "./types";
import { wordBlockContent } from "../word-conversion";

export function submissionRequest(state: Submission) {
  if (state.mode !== "new" && (!state.base_article || !state.base_article_id)) throw new Error("请先选择具体基准稿");
  const activeFiles = state.files.filter((file) => !file.disabled);
  const documents = state.documents.filter((doc) => !state.files.find((file) => file.id === doc.file_id)?.disabled);
  const wordDocs = documents.filter((doc) => /\.docx$/i.test(doc.name));
  if (state.mode === "new" && wordDocs.length && state.main_document_ids.length !== 1) throw new Error("请从交稿目录选择一份主稿，其他文档作为参考或说明");
  if (!documents.length && !state.user_instructions.trim()) throw new Error("请添加交稿文件或填写本次修改要求");
  return { task: "prepare_submission", submission_id: state.id,
    context: { mode: state.mode, base_article_id: state.base_article_id, user_instructions: state.user_instructions, main_document_ids: state.main_document_ids, native_baseline: Boolean(state.native_bindings), revision_view: state.revision_view },
    files: activeFiles, documents,
    asset_catalog: state.assets.filter((asset) => !asset.disabled && (!asset.origins.length || !asset.origins.every((o) => state.files.find((f) => f.id === o.file_id)?.disabled))).map((asset) => ({ id: asset.id, media_type: asset.media_type, origins: asset.origins, aliases: asset.aliases, reusable: asset.reusable })),
    base_article: state.base_article ? { ...state.base_article, nodes: state.base_article.nodes.map((node) => node.type === "image" ? { id: node.id, type: node.type, alt: node.alt, caption: node.caption, link_url: node.link_url } : node) } : undefined,
    decisions: state.decisions,
  };
}

export function sourceNode(node: SourceNode, state: Submission): DraftNode {
  const blocks = new Map(state.documents.flatMap((doc) => doc.blocks.map((block) => [block.id, block] as const)));
  const { source_ids, ...value } = node;
  if (value.type === "image_ref") {
    if (!value.request_id) throw new Error("插图位置缺少请求 ID");
    return { id: value.id, type: "image_ref", request_id: value.request_id, caption: value.caption, alt: value.alt, link_url: value.link_url };
  }
  if (value.type === "divider") return { id: value.id, type: "divider" };
  if (value.type === "ul" || value.type === "ol") {
    const items = value.items?.map((item) => { const source = item.source_ids.length === 1 ? blocks.get(item.source_ids[0]) : undefined; return { id: item.id, content: source && richTextToPlain(source.content) === richTextToPlain(item.content) ? wordBlockContent(source) : item.content }; }) ?? source_ids.map((id, index) => {
      const block = blocks.get(id); if (!block || block.kind !== "paragraph") throw new Error("列表来源无法读取");
      return { id: `${value.id}:item-${index + 1}`, content: wordBlockContent(block) };
    });
    return value.type === "ol" ? { id: value.id, type: "ol", start: value.start ?? Number((blocks.get(source_ids[0])?.clues.numbering as { start?: number } | undefined)?.start ?? 1), items } : { id: value.id, type: "ul", items };
  }
  if (value.content !== undefined) {
    const source = source_ids.length === 1 ? blocks.get(source_ids[0]) : undefined;
    const content = source?.kind === "paragraph" && richTextToPlain(source.content) === richTextToPlain(value.content) ? wordBlockContent(source) : value.content;
    return { id: value.id, type: value.type, content };
  }
  if (source_ids.length !== 1 || blocks.get(source_ids[0])?.kind !== "paragraph") throw new Error("正文需要一个原始段落来源，混合编辑说明剥离时应提供明确 content");
  const block = blocks.get(source_ids[0])!;
  const numbering = block.clues.numbering as { label?: string } | undefined;
  return { id: value.id, type: value.type, content: numbering?.label ? [{ text: `${numbering.label} ` }, ...wordBlockContent(block)] : wordBlockContent(block) };
}

export function applyChanges(nodes: DraftNode[], changes: ContentChange[], state: Submission): DraftNode[] {
  const result = structuredClone(nodes);
  const find = (id: string) => { const index = result.findIndex((node) => node.id === id); if (index < 0) throw new Error(`修改目标不存在：${id}`); return index; };
  const anchor = (id: string, position: "before" | "after") => id === "$start" ? 0 : id === "$end" ? result.length : find(id) + (position === "after" ? 1 : 0);
  for (const change of changes) {
    if (change.op === "insert_nodes") result.splice(anchor(change.anchor_node_id, change.position), 0, ...change.nodes.map((node) => sourceNode(node, state)));
    else if (change.op === "remove_nodes") { change.target_node_ids.forEach(find); const ids = new Set(change.target_node_ids); for (let i = result.length - 1; i >= 0; i--) if (ids.has(result[i].id)) result.splice(i, 1); }
    else if (change.op === "move_nodes") {
      if (change.target_node_ids.includes(change.anchor_node_id)) throw new Error("移动位置不能位于被移动节点内");
      const moving = change.target_node_ids.map((id) => result[find(id)]);
      const ids = new Set(change.target_node_ids); for (let i = result.length - 1; i >= 0; i--) if (ids.has(result[i].id)) result.splice(i, 1);
      result.splice(anchor(change.anchor_node_id, change.position), 0, ...moving);
    } else {
      const index = find(change.target_node_id); const old = result[index];
      if (change.op === "set_content") {
        if (!("content" in old)) throw new Error("此节点不支持整体文字替换，请针对具体文字节点修改");
        result[index] = { ...old, content: change.content };
      } else {
        if (old.type !== "image" && old.type !== "image_ref") throw new Error("图片修改目标不是图片");
        if (change.op === "set_image") result[index] = { id: old.id, type: "image_ref", request_id: change.request_id, caption: old.caption, alt: old.alt, link_url: old.link_url, previous: old.type === "image" ? old : old.previous };
        else {
          const next = { ...old };
          if (change.caption !== undefined) next.caption = change.caption ?? [];
          if (change.alt !== undefined) next.alt = change.alt ?? "";
          if (change.link_url !== undefined) { if (change.link_url === null) delete next.link_url; else next.link_url = change.link_url; }
          result[index] = next;
        }
      }
    }
  }
  const ids = result.flatMap((node) => [node.id, ...("items" in node ? node.items.map((item) => item.id) : [])]);
  if (new Set(ids).size !== ids.length) throw new Error("内容操作产生重复的节点 ID");
  return result;
}

function validatePlan(state: Submission, plan: SubmissionPlan) {
  if (plan.mode !== state.mode || (state.mode !== "new" && plan.base_article_id !== state.base_article_id)) throw new Error("模型改变了任务模式或基准稿");
  if (state.mode === "new" ? !plan.article || plan.changes !== undefined : !plan.changes || plan.article !== undefined) throw new Error("模型输出与任务模式不符");
  const sourceIds = new Set(["user:instructions", ...state.documents.flatMap((doc) => [...doc.blocks.map((b) => b.id), ...doc.annotations.map((a) => a.id)])]);
  const used: string[] = [];
  const consume = (node: SourceNode) => { used.push(...node.source_ids, ...(node.items?.flatMap((item) => item.source_ids) ?? [])); };
  plan.article?.nodes.forEach(consume); plan.changes?.forEach((op) => { if (op.op === "insert_nodes") op.nodes.forEach(consume); });
  used.push(...plan.image_requests.flatMap((request) => request.source_ids), ...plan.excluded_sources.map((item) => item.source_id), ...plan.pending.flatMap((item) => item.source_ids));
  if (used.some((id) => !sourceIds.has(id))) throw new Error("计划引用了未知交稿来源");
  if (state.mode === "new") for (const doc of state.documents.filter((d) => state.main_document_ids.includes(d.id))) {
    for (const block of doc.blocks.filter((b) => b.kind === "paragraph")) if (!used.includes(block.id)) throw new Error(`主稿文字尚未处理：${block.id}。编辑指示和参考材料应明确登记用途。`);
  }
  const requestIds = plan.image_requests.map((r) => r.id); if (new Set(requestIds).size !== requestIds.length) throw new Error("图片需求 ID 重复");
  for (const request of plan.image_requests) {
    const inherited = state.inherited_requests?.find((r) => r.id === request.id);
    if (inherited && JSON.stringify(inherited.selector) !== JSON.stringify(request.selector)) throw new Error("新的图片请求与旧请求重名，请使用新的图片请求 ID，避免改变已审图片");
  }
  for (const request of plan.image_requests) if (request.selector.kind === "asset" && !state.assets.some((a) => a.id === (request.selector as { asset_id: string }).asset_id)) throw new Error("模型引用了不存在的素材 ID");
  const pendingIds = plan.pending.map((p) => p.id); if (new Set(pendingIds).size !== pendingIds.length) throw new Error("待处理项 ID 重复");
  for (const pending of plan.pending) if (pending.kind === "select_target" && pending.candidate_ids.some((id) => !state.base_article?.nodes.some((node) => node.id === id))) throw new Error("候选修改目标不存在");
  for (const alias of plan.asset_aliases) {
    if (!state.assets.some((a) => a.id === alias.asset_id) || !state.documents.some((d) => d.id === alias.document_id) || (alias.section_source_id && !sourceIds.has(alias.section_source_id))) throw new Error("素材标签的资源或作用域不存在");
  }
}

export function assembleSubmission(input: Submission, raw: unknown): Submission {
  const plan = submissionPlanSchema.parse(raw); validatePlan(input, plan);
  let nodes = plan.mode === "new" ? plan.article!.nodes.map((node) => sourceNode(node, input)) : applyChanges(input.base_draft ?? input.base_article!.nodes, plan.changes!, input);
  plan.image_requests = [...(input.inherited_requests ?? []).filter((r) => !plan.image_requests.some((item) => item.id === r.id)), ...plan.image_requests];
  if (!nodes.some((node) => node.type === "article_title")) nodes = [{ id: `${input.id}:empty-title`, type: "article_title", content: [] }, ...nodes];
  const requests = new Set(plan.image_requests.map((r) => r.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (plan.relations.some((relation) => relation.node_ids.some((id) => !nodeIds.has(id)))) throw new Error("图文关联引用了不存在的正文节点");
  if (nodes.some((node) => node.type === "image_ref" && !requests.has(node.request_id)) || (plan.publishing?.cover_request_id && !requests.has(plan.publishing.cover_request_id))) throw new Error("插图或封面位置引用了未知需求");
  const state: Submission = { ...input, plan, draft: { id: input.base_article?.id ?? input.id, nodes }, pending: [...input.pending.filter((p) => !plan.pending.some((item) => item.id === p.id)), ...plan.pending], bindings: { ...input.bindings }, applied: true,
    image_requests_by_node: { ...input.image_requests_by_node, ...Object.fromEntries(nodes.flatMap((node) => node.type === "image_ref" ? [[node.id, node.request_id]] : [])) },
    assets: input.assets.map((asset) => ({ ...asset, aliases: [...asset.aliases, ...plan.asset_aliases.filter((alias) => alias.asset_id === asset.id).map((alias) => ({ text: alias.text, document_id: alias.document_id, section_source_id: alias.section_source_id }))] })),
    publishing: plan.publishing ? { ...input.publishing, cover_request_id: plan.publishing.cover_request_id, ...(plan.publishing.cover_request_id === null ? { cover_asset_id: null } : {}) } : input.publishing };
  const resolved = resolveAssets(state); projectDraft(resolved); return resolved;
}

export function resolveAssets(input: Submission): Submission {
  const state = structuredClone(input);
  for (const request of state.plan?.image_requests ?? state.inherited_requests ?? []) {
    if (state.decisions.some((decision) => decision.id === request.id && decision.resolution === "用户明确取消该处图片需求")) continue;
    if (state.bindings[request.id]?.status === "bound") continue;
    const s = request.selector;
    const matches = state.assets.filter((asset) => {
      if (asset.disabled) return false;
      if (asset.origins.length && asset.origins.every((o) => state.files.find((f) => f.id === o.file_id)?.disabled)) return false;
      if (s.kind === "asset") return asset.id === s.asset_id;
      if (s.kind === "file") return asset.origins.some((o) => o.relative_path === s.relative_path);
      if (s.kind === "occurrence") return asset.origins.some((o) => o.document_id === s.document_id && o.occurrence_id === s.occurrence_id);
      if (s.kind === "label") return asset.aliases.some((a) => a.text === s.text && a.document_id === s.document_id && a.section_source_id === s.section_source_id);
      if (s.kind === "base_node") return asset.origins.some((o) => o.article_id === s.article_id && o.node_id === s.node_id);
      if (s.kind === "reusable") return asset.reusable?.scope_id === s.scope_id && asset.reusable.key === s.key;
      return !s.source_file_ids?.length || asset.origins.some((o) => s.source_file_ids!.includes(o.file_id));
    });
    state.bindings[request.id] = matches.length === 1 && s.kind !== "description" ? { status: "bound", asset_id: matches[0].id, chosen_by: "exact_match" } : { status: "pending", reason: s.kind === "description" ? "描述需要人工选图，未按文件名猜测图片内容" : matches.length ? "找到多个素材，请选择" : "尚未收到明确引用的素材", candidate_asset_ids: matches.map((a) => a.id) };
  }
  return applyBindings(state);
}
export function imageRequestNodes(state: Submission): Record<string, string> {
  const result = { ...Object.fromEntries(state.plan?.article?.nodes.flatMap((n) => n.type === "image_ref" && n.request_id ? [[n.id, n.request_id]] : []) ?? []),
    ...Object.fromEntries(state.plan?.changes?.flatMap((change) => change.op === "set_image" ? [[change.target_node_id, change.request_id]] : change.op === "insert_nodes" ? change.nodes.flatMap((n) => n.type === "image_ref" && n.request_id ? [[n.id, n.request_id]] : []) : []) ?? []), ...state.image_requests_by_node };
  for (const decision of state.decisions) if (decision.resolution === "用户保留此项原稿") delete result[decision.id];
  for (const [nodeId, requestId] of Object.entries(result)) if (state.decisions.some((decision) => decision.id === requestId && decision.resolution === "用户明确取消该处图片需求")) delete result[nodeId];
  return result;
}
function applyBindings(state: Submission): Submission {
  state.image_requests_by_node = imageRequestNodes(state);
  const nodes = (state.draft?.nodes ?? state.base_draft)?.map((node) => {
    const requestId = node.type === "image_ref" ? node.request_id : state.image_requests_by_node?.[node.id];
    if (!requestId || (node.type !== "image_ref" && node.type !== "image")) return node;
    state.image_requests_by_node = { ...state.image_requests_by_node, [node.id]: requestId };
    const binding = state.bindings[requestId]; const asset = binding?.status === "bound" ? state.assets.find((a) => a.id === binding.asset_id) : undefined;
    if (!asset) return node;
    const group = node.type === "image" ? node.group : node.previous?.type === "image" ? node.previous.group : undefined;
    return { id: node.id, type: "image" as const, src: asset.storage_ref, alt: node.alt ?? "", caption: node.caption, link_url: node.link_url, ...(group ? { group } : {}) };
  });
  if (nodes) { if (state.draft) state.draft.nodes = nodes; else state.base_draft = nodes; }
  const cover = state.publishing.cover_request_id ? state.bindings[state.publishing.cover_request_id] : undefined;
  if (cover?.status === "bound") state.publishing.cover_asset_id = cover.asset_id;
  return state;
}
export function bindAsset(input: Submission, requestId: string, assetId: string): Submission {
  if (!(input.plan?.image_requests ?? input.inherited_requests)?.some((r) => r.id === requestId) || !input.assets.some((a) => a.id === assetId)) throw new Error("图片需求或素材不存在");
  const state = structuredClone(input); state.bindings[requestId] = { status: "bound", asset_id: assetId, chosen_by: "user" }; return applyBindings(state);
}
export function cancelImageRequest(input: Submission, requestId: string): Submission {
  const state = structuredClone(input); const nodes = state.draft?.nodes ?? state.base_draft ?? [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]; if (node.type !== "image_ref" || node.request_id !== requestId || node.previous) continue;
    const previous = nodes[index - 1];
    if (previous && "content" in previous && /扫码|扫描|见图|如下图/.test(richTextToPlain(previous.content))) state.pending.push({ id: `${requestId}:text-check`, kind: "other", message: "已取消此处插图；相邻正文仍有扫码或看图说明，请修改关联文字或明确确认保留。", candidate_ids: [], source_ids: [] });
  }
  const remaining = nodes.flatMap((node) => node.type !== "image_ref" || node.request_id !== requestId ? [node] : node.previous ? [node.previous] : []);
  if (state.draft) state.draft.nodes = remaining; else if (state.base_draft) state.base_draft = remaining;
  if (state.publishing.cover_request_id === requestId) state.publishing = { cover_asset_id: null, cover_request_id: null };
  state.decisions.push({ id: requestId, resolution: "用户明确取消该处图片需求" }); return state;
}
export function unresolvedImages(state: Submission) {
  const ids = new Set([...((state.draft?.nodes ?? state.base_draft)?.flatMap((node) => node.type === "image_ref" ? [node.request_id] : []) ?? []), ...(state.publishing.cover_request_id && state.bindings[state.publishing.cover_request_id]?.status !== "bound" ? [state.publishing.cover_request_id] : [])]);
  return (state.plan?.image_requests ?? state.inherited_requests ?? []).filter((r) => ids.has(r.id));
}
export function projectDraft(state: Submission): ParsedArticle {
  if (!state.draft) throw new Error("交稿尚未组装");
  return parsedArticleSchema.parse({ schema: "opslion.article/v1", id: state.draft.id, nodes: state.draft.nodes.map((node): ArticleNode => node.type === "image_ref" ? { id: node.id, type: "paragraph", content: [{ text: `【${node.previous ? "待替换图片" : "待补图片"}：${(state.plan?.image_requests ?? state.inherited_requests)?.find((r) => r.id === node.request_id)?.purpose ?? "未绑定"}】` }] } : node) });
}
export function syncDraftEdits(state: Submission, article: ParsedArticle): Submission {
  if (!state.draft && state.base_draft) {
    const updated = syncDraftEdits({ ...state, draft: { id: article.id, nodes: state.base_draft } }, article);
    return { ...updated, draft: undefined, base_draft: updated.draft!.nodes, base_article: projectDraft(updated) };
  }
  if (!state.draft) return state;
  // Deleting a pending position is an explicit human cancellation, including its future binding.
  for (const node of state.draft.nodes) if (node.type === "image_ref" && !article.nodes.some((n) => n.id === node.id)) state = cancelImageRequest(state, node.request_id);
  if (!state.draft) return state;
  const references = new Map(state.draft.nodes.filter((node) => node.type === "image_ref").map((node) => [node.id, node]));
  const next = { ...state, assets: [...state.assets], bindings: { ...state.bindings }, draft: { id: article.id, nodes: article.nodes.map((node) => references.get(node.id) ?? node) } };
  for (const node of article.nodes) {
    const requestId = imageRequestNodes(state)[node.id];
    if (node.type !== "image" || !requestId || state.draft.nodes.find((n) => n.id === node.id && n.type === "image" && n.src === node.src)) continue;
    const assetId = `${requestId}:manual`;
    next.assets = [...next.assets.filter((a) => a.id !== assetId), { id: assetId, storage_ref: node.src, media_type: "image/*", origins: [], aliases: [] }];
    next.bindings[requestId] = { status: "bound", asset_id: assetId, chosen_by: "user" };
  }
  return next;
}
export function submissionBlockers(state?: Submission) {
  if (!state || (!state.applied && !state.base_draft)) return [];
  return [...unresolvedImages(state).map((r) => `待补素材：${r.purpose}`), ...state.pending.map((p) => p.message), ...(!state.applied && state.base_draft && state.user_instructions.trim() ? ["本次局部修改尚未审核应用"] : [])];
}
