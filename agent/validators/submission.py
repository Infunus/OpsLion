"""Necessary mode, source and target checks for submission assembly plans."""
TEXT_TYPES = {"article_title", "subtitle", "heading1", "heading2", "heading3", "paragraph", "quote"}
OPS = {"set_content", "set_image", "set_image_meta", "insert_nodes", "remove_nodes", "move_nodes"}


def validate_request(request):
    context = request.get("context")
    if not isinstance(context, dict) or context.get("mode") not in {"new", "update", "derive"}:
        return ["缺少交稿模式"]
    if context["mode"] != "new" and (not context.get("base_article_id") or not isinstance(request.get("base_article"), dict)):
        return ["局部更新或派生任务必须指定基准稿"]
    if not isinstance(request.get("documents"), list) or not isinstance(request.get("asset_catalog"), list):
        return ["缺少文档或素材目录"]
    return []


def _validate_plan(request, plan):
    errors = validate_request(request)
    if errors:
        return errors
    context = request["context"]
    allowed = {"schema", "mode", "base_article_id", "article", "changes", "image_requests", "pending", "excluded_sources", "asset_aliases", "publishing", "relations"}
    if not isinstance(plan, dict) or plan.get("schema") != "opslion/submission-plan/v1" or set(plan) - allowed:
        return ["仅返回合法的 opslion/submission-plan/v1"]
    if plan.get("mode") != context["mode"]:
        errors.append("不能改变交稿模式")
    new = context["mode"] == "new"
    if new:
        if not isinstance(plan.get("article"), dict) or not isinstance(plan["article"].get("nodes"), list) or "changes" in plan:
            return errors + ["new 必须输出 article.nodes，不输出 changes"]
    elif plan.get("base_article_id") != context["base_article_id"] or not isinstance(plan.get("changes"), list) or "article" in plan:
        return errors + ["update/derive 必须引用固定基准并输出 changes"]
    image_requests = plan.get("image_requests")
    if not isinstance(image_requests, list) or not isinstance(plan.get("pending"), list):
        return errors + ["需要 image_requests 和 pending 数组"]
    source_ids = {"user:instructions"}
    main_text = set()
    document_ids = set()
    for doc in request["documents"]:
        document_ids.add(doc["id"])
        source_ids.update(block["id"] for block in doc["blocks"])
        source_ids.update(note["id"] for note in doc.get("annotations", []))
        if doc["id"] in context.get("main_document_ids", []):
            main_text.update(block["id"] for block in doc["blocks"] if block["kind"] == "paragraph")
    used = set()
    def sources(value):
        if not isinstance(value, list) or any(not isinstance(item, str) or item not in source_ids for item in value):
            errors.append("引用了未知的交稿来源")
        else:
            used.update(value)
    requests = set()
    assets = {asset["id"] for asset in request["asset_catalog"]}
    selector_keys = {"asset": {"kind", "asset_id"}, "occurrence": {"kind", "document_id", "occurrence_id"}, "file": {"kind", "relative_path"}, "label": {"kind", "text", "document_id", "section_source_id"}, "base_node": {"kind", "article_id", "node_id"}, "reusable": {"kind", "scope_id", "key"}, "description": {"kind", "text", "source_file_ids"}}
    for item in image_requests:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] or set(item) - {"id", "purpose", "selector", "source_ids"}:
            errors.append("图片需求格式无效"); continue
        if item["id"] in requests:
            errors.append("图片需求 ID 重复")
        requests.add(item["id"]); sources(item.get("source_ids", []))
        selector = item.get("selector")
        if not isinstance(selector, dict) or not isinstance(selector.get("kind"), str) or selector["kind"] not in selector_keys or set(selector) - selector_keys.get(selector.get("kind"), set()):
            errors.append("图片定位方式无效"); continue
        if selector["kind"] == "asset" and selector.get("asset_id") not in assets:
            errors.append("不能编造已存在的素材 ID；缺图请使用路径、标签或描述请求")
    targets = {node["id"] for node in (request.get("base_article") or {}).get("nodes", [])}
    def target(value):
        if value not in targets:
            errors.append(f"内容目标不存在：{value}")
    def rich(value):
        if not isinstance(value, list):
            errors.append("content 必须是 RichText 数组"); return
        for run in value:
            if not isinstance(run, dict): errors.append("富文本格式无效"); continue
            if set(run) == {"break"} and run["break"] is True: continue
            if "href" in run:
                if set(run) != {"href", "content"} or not isinstance(run["href"], str) or not run["href"].startswith(("https://", "http://")): errors.append("链接格式无效")
                rich(run.get("content")); continue
            if "color" in run and (not isinstance(run["color"], str) or len(run["color"]) != 7 or run["color"][0] != "#" or any(c not in "0123456789abcdefABCDEF" for c in run["color"][1:])):
                errors.append("文字颜色必须是六位十六进制颜色")
            if set(run) - {"text", "marks", "color"} or not isinstance(run.get("text"), str) or not isinstance(run.get("marks", []), list) or any(mark not in {"bold", "italic", "underline", "strike"} for mark in run.get("marks", [])):
                errors.append("富文本仅支持 text、既有 marks 和链接，不支持 HTML/CSS")
    def node(value):
        if not isinstance(value, dict) or not isinstance(value.get("id"), str) or set(value) - {"id", "type", "source_ids", "content", "request_id", "caption", "alt", "link_url", "start", "items"}:
            errors.append("新增节点字段无效"); return
        if value["id"] in targets: errors.append("新增节点 ID 重复")
        targets.add(value["id"]); sources(value.get("source_ids", []))
        kind = value.get("type")
        if kind not in TEXT_TYPES | {"ul", "ol", "divider", "image_ref"}: errors.append("当前模板不支持此节点类型")
        if "content" in value: rich(value["content"])
        if "caption" in value: rich(value["caption"])
        if kind == "image_ref" and value.get("request_id") not in requests: errors.append("插图位置缺少有效图片请求")
        for item in value.get("items", []): rich(item.get("content")); sources(item.get("source_ids", []))
    if new:
        targets = set()
        for value in plan["article"]["nodes"]: node(value)
    else:
        for op in plan["changes"]:
            if not isinstance(op, dict) or op.get("op") not in OPS: errors.append("未知内容操作"); continue
            if context.get("native_baseline") and op["op"] not in {"set_content", "set_image", "set_image_meta"}: errors.append("原生稿仅支持局部文字和图片修改；结构重组应列 pending")
            if "target_node_id" in op: target(op["target_node_id"])
            for value in op.get("target_node_ids", []): target(value)
            if "anchor_node_id" in op and op["anchor_node_id"] not in {"$start", "$end"}: target(op["anchor_node_id"])
            if op["op"] == "set_content": rich(op.get("content"))
            if op["op"] == "set_image" and op.get("request_id") not in requests: errors.append("换图操作没有对应的素材需求")
            if op["op"] == "insert_nodes":
                for value in op.get("nodes", []): node(value)
    for value in plan.get("excluded_sources", []):
        if not isinstance(value, dict) or value.get("role") not in {"instruction", "reference"} or not value.get("reason"): errors.append("未发表来源需明确为编辑指示或参考材料")
        else: sources([value.get("source_id")])
    for pending in plan["pending"]:
        if not isinstance(pending, dict) or not pending.get("message"): errors.append("待处理项应包含具体问题"); continue
        sources(pending.get("source_ids", []))
        for value in pending.get("candidate_ids", []): target(value)
    if new and main_text - used: errors.append("主稿文字尚无去向，请发表或明确登记为编辑指示/参考：" + ",".join(sorted(main_text - used)[:10]))
    cover = plan.get("publishing", {}).get("cover_request_id")
    if cover is not None and cover not in requests: errors.append("封面需求不存在")
    return errors


def validate_plan(request, plan):
    try:
        return _validate_plan(request, plan)
    except (TypeError, KeyError, AttributeError, ValueError):
        return ["输出中的字段类型不符合交稿契约，请检查数组、对象和 ID"]
