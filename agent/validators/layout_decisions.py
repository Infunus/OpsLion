"""Layout-only contract. No content writing, approval or lock fields are accepted."""


def _keys(value, required, optional=()):
    return isinstance(value, dict) and set(required) <= set(value) <= set(required) | set(optional)


def validate_request(request):
    if not _keys(request, ["task", "schema", "baseRevision", "template", "nodes", "requirements", "observation"]):
        return ["Invalid layout request fields"]
    if request["task"] != "plan_layout" or request["schema"] != "opslion/layout-request/v1" or not isinstance(request["baseRevision"], str) or not 1 <= len(request["baseRevision"]) <= 250:
        return ["Invalid layout revision"]
    template = request["template"]
    if not _keys(template, ["id", "version", "name", "imageGroups"]) or type(template["imageGroups"]) is not bool:
        return ["Invalid template description"]
    if request["observation"] != {"kind": "structural", "compiled": True, "visualReview": "not-run"}:
        return ["Unsupported observation"]
    if not isinstance(request["nodes"], list) or not isinstance(request["requirements"], list):
        return ["Invalid nodes or requirements"]
    ids = []
    for node in request["nodes"]:
        if not _keys(node, ["id", "type", "text", "components", "componentLocked", "groupLocked"], ["currentComponent", "group"]):
            return ["Invalid node fields"]
        if not isinstance(node["id"], str) or not 1 <= len(node["id"]) <= 250 or not isinstance(node["text"], str) or not isinstance(node["components"], list) or any(not isinstance(c, str) for c in node["components"]) or type(node["componentLocked"]) is not bool or type(node["groupLocked"]) is not bool:
            return ["Invalid node components"]
        ids.append(node["id"])
    if len(set(ids)) != len(ids):
        return ["Duplicate node id"]
    if any(not _keys(r, ["id", "text"]) or not isinstance(r["id"], str) for r in request["requirements"]):
        return ["Invalid requirements"]
    return []


def validate_plan(request, plan):
    if not _keys(plan, ["schema", "baseRevision", "id", "decisions", "unresolved"]):
        return ["Invalid decision set fields; approvals and human locks are forbidden"]
    if plan["schema"] != "opslion/layout-decisions/v1" or plan["baseRevision"] != request["baseRevision"] or not isinstance(plan["id"], str) or not 1 <= len(plan["id"]) <= 250:
        return ["Invalid decision identity or stale revision"]
    if not isinstance(plan["decisions"], list) or len(plan["decisions"]) > 200 or not isinstance(plan["unresolved"], list) or len(plan["unresolved"]) > 100:
        return ["Invalid decision list"]
    nodes = {n["id"]: n for n in request["nodes"]}
    order = list(nodes)
    requirements = {r["id"] for r in request["requirements"]}
    used, resolved = set(), set()
    for decision in plan["decisions"]:
        if not isinstance(decision, dict):
            return ["Invalid decision"]
        kind = decision.get("kind")
        if kind == "component_variant":
            if not _keys(decision, ["kind", "nodeId", "componentId"], ["requirementIds"]) or not isinstance(decision["componentId"], str) or not 1 <= len(decision["componentId"]) <= 250:
                return ["Invalid component fields"]
            ids = [decision["nodeId"]]
        elif kind == "image_group":
            if not _keys(decision, ["kind", "nodeIds"], ["requirementIds"]):
                return ["Invalid image group fields"]
            ids = decision["nodeIds"]
            if not isinstance(ids, list) or not 1 <= len(ids) <= 3:
                return ["Invalid image group size"]
        else:
            return ["Unknown decision kind"]
        if any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
            return ["Invalid or duplicate node ids"]
        for node_id in ids:
            node = nodes.get(node_id)
            key = (kind, node_id)
            if not node or key in used:
                return ["Unknown or duplicate target"]
            used.add(key)
            if kind == "component_variant" and (node["componentLocked"] or decision["componentId"] not in node["components"]):
                return ["Invalid component or human lock"]
            if kind == "image_group" and (node["type"] != "image" or node["groupLocked"]):
                return ["Invalid image or human lock"]
        if kind == "image_group":
            if len(ids) > 1 and not request["template"].get("imageGroups"):
                return ["Template does not support image groups"]
            start = order.index(ids[0])
            if order[start:start + len(ids)] != ids:
                return ["Images must remain adjacent and ordered"]
        refs = decision.get("requirementIds", [])
        if not isinstance(refs, list) or any(not isinstance(r, str) or r not in requirements for r in refs):
            return ["Cannot resolve unknown or content requirements"]
        resolved.update(refs)
    for issue in plan["unresolved"]:
        if not _keys(issue, ["id", "message"]) or not isinstance(issue["id"], str) or issue["id"] not in requirements or issue["id"] in resolved or not isinstance(issue["message"], str) or not issue["message"]:
            return ["Invalid unresolved requirement"]
    return []
