"""Validate source-only semantic labels before the browser restores original content."""

KINDS = {"article_title", "subtitle", "heading1", "heading2", "heading3", "paragraph", "quote", "image", "ul", "ol", "divider"}


def validate_request(request):
    source = request.get("source", {})
    if not isinstance(source, dict) or source.get("schema") not in {"opslion/word-snapshot/v1", "opslion/editor-snapshot/v1"}:
        return ["缺少受支持的文档快照"]
    blocks = source.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return ["文档快照必须有 blocks"]
    ids = []
    for block in blocks:
        if not isinstance(block, dict) or not isinstance(block.get("id"), str) or not block["id"] or not isinstance(block.get("kind"), str) or block["kind"] not in {"paragraph", "image", "divider"} or not isinstance(block.get("clues"), dict) or not isinstance(block.get("content"), list):
            return ["来源块格式无效"]
        numbering = block["clues"].get("numbering")
        if numbering is not None and (not isinstance(numbering, dict) or not isinstance(numbering.get("group"), str) or type(numbering.get("level")) is not int or type(numbering.get("ordered")) is not bool or type(numbering.get("start")) is not int or numbering["start"] < 1):
            return ["列表编号线索无效"]
        ids.append(block["id"])
    return [] if len(ids) == len(set(ids)) else ["来源 ID 重复"]


def validate_plan(request, plan):
    errors = validate_request(request)
    if errors:
        return errors
    if not isinstance(plan, dict) or set(plan) != {"schema", "nodes"} or plan.get("schema") != "opslion/semantic-plan/v1" or not isinstance(plan.get("nodes"), list):
        return ["必须返回 opslion/semantic-plan/v1，且仅包含 schema、nodes"]
    blocks = request["source"]["blocks"]
    by_id = {block["id"]: block for block in blocks}
    used = []
    titles = 0
    for index, node in enumerate(plan["nodes"]):
        if not isinstance(node, dict) or set(node) != {"type", "source_ids"} or not isinstance(node.get("type"), str) or node["type"] not in KINDS:
            errors.append(f"节点 {index} 类型或字段无效；不能输出正文或模板决策")
            continue
        ids = node.get("source_ids")
        if not isinstance(ids, list) or not ids or any(not isinstance(item, str) or item not in by_id for item in ids):
            errors.append(f"节点 {index} 引用了不存在的来源")
            continue
        used.extend(ids)
        selected = [by_id[item] for item in ids]
        first, kind = selected[0], node["type"]
        if kind == "article_title":
            titles += 1
            if index != 0:
                errors.append("主标题只能位于文章开头")
        if kind == "subtitle" and (index != 1 or not titles):
            errors.append("副标题须紧随篇名")
        if kind == "image":
            if first["kind"] != "image" or not first.get("image_anchor_id") or any(item["kind"] != "paragraph" or item["clues"].get("numbering") for item in selected[1:]) or (len(selected) > 1 and first.get("caption")):
                errors.append("图片与图注引用无效")
        elif kind == "divider":
            if len(ids) != 1 or first["kind"] != "divider":
                errors.append("不能添加分割线或用分割线替换文字")
        elif any(item["kind"] != "paragraph" for item in selected):
            errors.append("文字节点不能引用图片或分割线")
        elif kind in {"ul", "ol"}:
            numbers = [item["clues"].get("numbering") for item in selected]
            if any(not isinstance(n, dict) or n.get("level") != 0 or n.get("ordered") is not (kind == "ol") or n.get("group") != (numbers[0] or {}).get("group") for n in numbers):
                errors.append("列表只能引用同组、同级、同编号形式的真实列表项")
        elif len(ids) != 1:
            errors.append("正文与标题必须逐段保留")
        elif first["clues"].get("numbering") and kind not in {"heading1", "heading2", "heading3"}:
            errors.append("自动编号段落应保留为列表，或明确识别为章节标题")
    if titles > 1:
        errors.append("主标题最多一个")
    if used != [block["id"] for block in blocks]:
        errors.append("source_ids 展开后须与输入 ID 顺序完全一致，禁止遗漏、重复或重排")
    return errors
