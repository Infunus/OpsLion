#!/usr/bin/env python3
"""Validate an OpsLion model plan against the exact request sent to the model."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _string(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _id_set(items: Any) -> set[str]:
    return {_string(item.get("id")) for item in _list(items) if isinstance(item, dict) and _string(item.get("id"))}


def _validate_confidence(value: Any, path: str, errors: list[str]) -> None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 <= value <= 1:
        errors.append(f"{path} must be a number from 0 to 1")


def _unexpected_fields(value: dict, allowed: set[str], path: str, errors: list[str]) -> None:
    extras = sorted(set(value) - allowed)
    if extras:
        errors.append(f"{path} has unexpected fields: {', '.join(extras)}")


def _source_ids(value: Any, known: set[str], path: str, errors: list[str]) -> set[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        errors.append(f"{path} must be an array of source IDs")
        return set()
    result = set(value)
    unknown = sorted(result - known)
    if unknown:
        errors.append(f"{path} references unknown source IDs: {', '.join(unknown)}")
    return result & known


def _validate_content_warnings(value: Any, source_ids: set[str], errors: list[str]) -> None:
    allowed_codes = {"ambiguous_structure", "conflicting_facts", "possible_text_loss", "missing_referenced_image", "manual_review"}
    if not isinstance(value, list):
        errors.append("warnings must be an array")
        return
    for index, raw_warning in enumerate(value):
        warning = _dict(raw_warning)
        path = f"warnings[{index}]"
        _unexpected_fields(warning, {"code", "message", "source_block_ids"}, path, errors)
        if warning.get("code") not in allowed_codes:
            errors.append(f"{path}.code is unsupported")
        if not _string(warning.get("message")).strip():
            errors.append(f"{path}.message must be non-empty")
        _source_ids(warning.get("source_block_ids"), source_ids, f"{path}.source_block_ids", errors)


def validate_content_plan(request: dict, plan: dict) -> list[str]:
    errors: list[str] = []
    if plan.get("schema") != "opslion/content-plan/v1":
        errors.append("schema must be opslion/content-plan/v1")
    _unexpected_fields(plan, {
        "schema", "title", "subtitle", "lead", "sections", "ending", "unused_source_blocks",
        "unplaced_image_anchors", "warnings", "confidence",
    }, "plan", errors)

    source = _dict(request.get("source"))
    blocks = _list(source.get("blocks"))
    source_ids = _id_set(blocks)
    required_ids = {
        _string(block.get("id")) for block in blocks
        if isinstance(block, dict) and _string(block.get("id")) and _string(block.get("text")).strip()
    }
    image_ids = _id_set(source.get("images"))
    covered: set[str] = set()
    placed_images: list[str] = []

    for field_name in ("title", "subtitle", "lead", "ending"):
        field = _dict(plan.get(field_name))
        if not field:
            errors.append(f"{field_name} must be an object")
            continue
        _unexpected_fields(field, {"text", "source_block_ids", "confidence"}, field_name, errors)
        if not isinstance(field.get("text"), str):
            errors.append(f"{field_name}.text must be a string")
        covered |= _source_ids(field.get("source_block_ids"), source_ids, f"{field_name}.source_block_ids", errors)
        _validate_confidence(field.get("confidence"), f"{field_name}.confidence", errors)

    sections = plan.get("sections")
    if not isinstance(sections, list):
        errors.append("sections must be an array")
        sections = []
    plan_ids: set[str] = set()
    for index, raw_section in enumerate(sections):
        path = f"sections[{index}]"
        section = _dict(raw_section)
        _unexpected_fields(section, {"plan_id", "title", "paragraphs", "image_anchor_ids", "reason"}, path, errors)
        plan_id = _string(section.get("plan_id"))
        if not plan_id or plan_id in plan_ids:
            errors.append(f"{path}.plan_id must be non-empty and unique")
        plan_ids.add(plan_id)
        if not isinstance(section.get("title"), str) or not isinstance(section.get("reason"), str):
            errors.append(f"{path}.title and reason must be strings")
        paragraphs = section.get("paragraphs")
        if not isinstance(paragraphs, list):
            errors.append(f"{path}.paragraphs must be an array")
            paragraphs = []
        for paragraph_index, raw_paragraph in enumerate(paragraphs):
            paragraph_path = f"{path}.paragraphs[{paragraph_index}]"
            paragraph = _dict(raw_paragraph)
            _unexpected_fields(paragraph, {"text", "source_block_ids"}, paragraph_path, errors)
            if not isinstance(paragraph.get("text"), str):
                errors.append(f"{paragraph_path}.text must be a string")
            covered |= _source_ids(paragraph.get("source_block_ids"), source_ids, f"{paragraph_path}.source_block_ids", errors)
        anchors = section.get("image_anchor_ids")
        if not isinstance(anchors, list) or any(not isinstance(item, str) for item in anchors):
            errors.append(f"{path}.image_anchor_ids must be an array of image IDs")
        else:
            unknown = sorted(set(anchors) - image_ids)
            if unknown:
                errors.append(f"{path}.image_anchor_ids contains unknown IDs: {', '.join(unknown)}")
            placed_images.extend(item for item in anchors if item in image_ids)

    unused = plan.get("unused_source_blocks")
    unused_ids: set[str] = set()
    if not isinstance(unused, list):
        errors.append("unused_source_blocks must be an array")
    else:
        for index, raw_item in enumerate(unused):
            item = _dict(raw_item)
            path = f"unused_source_blocks[{index}]"
            _unexpected_fields(item, {"id", "reason"}, path, errors)
            item_id = _string(item.get("id"))
            if item_id not in source_ids:
                errors.append(f"{path}.id is unknown")
            elif item_id in unused_ids:
                errors.append(f"{path}.id is duplicated")
            else:
                unused_ids.add(item_id)
            if not _string(item.get("reason")).strip():
                errors.append(f"{path}.reason must be non-empty")

    missing_sources = sorted(required_ids - covered - unused_ids)
    if missing_sources:
        errors.append(f"non-empty source blocks are not covered: {', '.join(missing_sources)}")

    unplaced = plan.get("unplaced_image_anchors")
    unplaced_ids: list[str] = []
    if not isinstance(unplaced, list):
        errors.append("unplaced_image_anchors must be an array")
    else:
        for index, raw_item in enumerate(unplaced):
            item = _dict(raw_item)
            path = f"unplaced_image_anchors[{index}]"
            _unexpected_fields(item, {"id", "reason"}, path, errors)
            item_id = _string(item.get("id"))
            if item_id not in image_ids:
                errors.append(f"{path}.id is unknown")
            else:
                unplaced_ids.append(item_id)
            if not _string(item.get("reason")).strip():
                errors.append(f"{path}.reason must be non-empty")
    image_counts = {item_id: (placed_images + unplaced_ids).count(item_id) for item_id in image_ids}
    bad_images = sorted(item_id for item_id, count in image_counts.items() if count != 1)
    if bad_images:
        errors.append(f"every image must be placed or unplaced exactly once: {', '.join(bad_images)}")

    _validate_content_warnings(plan.get("warnings"), source_ids, errors)
    _validate_confidence(plan.get("confidence"), "confidence", errors)
    confidence = plan.get("confidence")
    blocking_uncertainty = bool(unused_ids or unplaced_ids) or any(
        isinstance(item, dict) and item.get("code") in {"ambiguous_structure", "conflicting_facts", "possible_text_loss", "manual_review"}
        for item in _list(plan.get("warnings"))
    )
    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and blocking_uncertainty and confidence > 0.7:
        errors.append("confidence must not exceed 0.7 when content has unresolved uncertainty")
    missing_asset = any(
        isinstance(item, dict) and item.get("code") == "missing_referenced_image"
        for item in _list(plan.get("warnings"))
    )
    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and missing_asset and confidence > 0.85:
        errors.append("confidence must not exceed 0.85 when a referenced image is missing")
    return errors


def validate_template_plan(request: dict, plan: dict) -> list[str]:
    errors: list[str] = []
    if plan.get("schema") != "opslion/template-plan/v1":
        errors.append("schema must be opslion/template-plan/v1")
    _unexpected_fields(plan, {
        "schema", "base_revision", "operations", "coverage", "unresolved", "deferred_assets", "warnings", "confidence",
    }, "plan", errors)

    template = _dict(request.get("template"))
    if plan.get("base_revision") != template.get("revision"):
        errors.append("base_revision does not match the template request")
    modules = {item.get("id"): item for item in _list(template.get("modules")) if isinstance(item, dict) and item.get("id")}
    slots = {item.get("id"): item for item in _list(template.get("slots")) if isinstance(item, dict) and item.get("id")}
    article = _dict(request.get("article"))
    article_blocks = _list(article.get("blocks"))
    source_ids = _id_set(article_blocks)
    required_source_ids = {
        _string(block.get("id")) for block in article_blocks
        if isinstance(block, dict) and _string(block.get("id")) and _string(block.get("text")).strip()
    }
    image_ids = _id_set(article.get("images"))
    policy = _dict(request.get("policy"))
    created_refs: dict[str, str] = {}
    operation_sources: list[set[str]] = []
    placed_images: list[str] = []
    allowed_ops = {
        "set_text", "set_link", "set_image", "clear_image", "set_module_visibility", "duplicate_module", "move_module", "manual_review",
    }

    def module_source(module_ref: Any, path: str) -> str:
        value = _string(module_ref)
        if value in modules:
            return value
        if value in created_refs:
            return created_refs[value]
        errors.append(f"{path} references an unknown or not-yet-created module")
        return ""

    def slot_target(value: Any, path: str) -> dict:
        target = _dict(value)
        if set(target) == {"slot_id"}:
            slot_id = _string(target.get("slot_id"))
            if slot_id not in slots:
                errors.append(f"{path}.slot_id is unknown")
                return {}
            return slots[slot_id]
        if set(target) == {"module_ref", "slot_index"}:
            source_module = module_source(target.get("module_ref"), f"{path}.module_ref")
            slot_index = target.get("slot_index")
            if not isinstance(slot_index, int) or isinstance(slot_index, bool) or slot_index < 0:
                errors.append(f"{path}.slot_index must be a non-negative integer")
                return {}
            matches = [slot for slot in slots.values() if slot.get("module_id") == source_module and slot.get("index_in_module") == slot_index]
            if not matches:
                errors.append(f"{path} does not resolve to a source slot")
                return {}
            return matches[0]
        errors.append(f"{path} must contain either slot_id or module_ref plus slot_index")
        return {}

    operations = plan.get("operations")
    if not isinstance(operations, list):
        errors.append("operations must be an array")
        operations = []
    for index, raw_operation in enumerate(operations):
        operation = _dict(raw_operation)
        path = f"operations[{index}]"
        op = operation.get("op")
        if op not in allowed_ops:
            errors.append(f"{path}.op is not allowed")
            operation_sources.append(set())
            continue
        common_sources: set[str] = set()
        if op != "manual_review" and not _string(operation.get("reason")).strip():
            errors.append(f"{path}.reason must be non-empty")
        if op in {"set_text", "set_link"}:
            allowed = {"op", "slot_target", "value" if op == "set_text" else "url", "source_block_ids", "reason"}
            _unexpected_fields(operation, allowed, path, errors)
            resolved_slot = slot_target(operation.get("slot_target"), f"{path}.slot_target")
            if resolved_slot and resolved_slot.get("kind") != "text":
                errors.append(f"{path} must target a text slot")
            value_field = "value" if op == "set_text" else "url"
            if not isinstance(operation.get(value_field), str):
                errors.append(f"{path}.{value_field} must be a string")
            common_sources = _source_ids(operation.get("source_block_ids"), source_ids, f"{path}.source_block_ids", errors)
            if op == "set_link":
                if not policy.get("allow_link_change", False):
                    errors.append(f"{path} is forbidden by policy")
                url = _string(operation.get("url"))
                article_text = "\n".join(_string(block.get("text")) for block in _list(article.get("blocks")) if isinstance(block, dict))
                if url and url not in article_text:
                    errors.append(f"{path}.url does not occur verbatim in the article")
        elif op in {"set_image", "clear_image"}:
            allowed = {"op", "slot_target", "reason"}
            if op == "set_image":
                allowed.add("image_anchor_id")
            _unexpected_fields(operation, allowed, path, errors)
            resolved_slot = slot_target(operation.get("slot_target"), f"{path}.slot_target")
            if resolved_slot and (resolved_slot.get("kind") != "image" or resolved_slot.get("role") != "content_image"):
                errors.append(f"{path} may target only a content_image slot")
            if op == "set_image":
                if operation.get("image_anchor_id") not in image_ids:
                    errors.append(f"{path}.image_anchor_id is unknown")
                else:
                    placed_images.append(operation["image_anchor_id"])
            if not policy.get("allow_content_image_change", False):
                errors.append(f"{path} is forbidden by policy")
        elif op == "set_module_visibility":
            _unexpected_fields(operation, {"op", "module_ref", "visible", "reason"}, path, errors)
            source_module = module_source(operation.get("module_ref"), f"{path}.module_ref")
            if source_module and modules[source_module].get("role") == "decoration":
                errors.append(f"{path} may not change a decoration module")
            if not isinstance(operation.get("visible"), bool):
                errors.append(f"{path}.visible must be boolean")
            if operation.get("visible") is False and not policy.get("allow_hide", False):
                errors.append(f"{path} is forbidden by policy")
        elif op == "duplicate_module":
            _unexpected_fields(operation, {"op", "source_module_id", "result_ref", "after_module_ref", "reason"}, path, errors)
            source_module = _string(operation.get("source_module_id"))
            if source_module not in modules:
                errors.append(f"{path}.source_module_id is unknown")
            elif not modules[source_module].get("can_duplicate", False):
                errors.append(f"{path}.source_module_id is protected from duplication")
            module_source(operation.get("after_module_ref"), f"{path}.after_module_ref")
            result_ref = _string(operation.get("result_ref"))
            if not result_ref or result_ref in modules or result_ref in created_refs:
                errors.append(f"{path}.result_ref must be non-empty and unique")
            elif source_module in modules:
                created_refs[result_ref] = source_module
            if not policy.get("allow_duplicate", False):
                errors.append(f"{path} is forbidden by policy")
        elif op == "move_module":
            _unexpected_fields(operation, {"op", "module_ref", "after_module_ref", "reason"}, path, errors)
            source_module = module_source(operation.get("module_ref"), f"{path}.module_ref")
            if source_module and modules[source_module].get("role") == "decoration":
                errors.append(f"{path} may not move a decoration module")
            module_source(operation.get("after_module_ref"), f"{path}.after_module_ref")
            if not policy.get("allow_reorder", False):
                errors.append(f"{path} is forbidden by policy")
        elif op == "manual_review":
            _unexpected_fields(operation, {"op", "message", "source_block_ids", "module_refs"}, path, errors)
            if not _string(operation.get("message")).strip():
                errors.append(f"{path}.message must be non-empty")
            common_sources = _source_ids(operation.get("source_block_ids"), source_ids, f"{path}.source_block_ids", errors)
            module_refs = operation.get("module_refs")
            if not isinstance(module_refs, list) or any(not isinstance(value, str) for value in module_refs):
                errors.append(f"{path}.module_refs must be an array of module references")
            else:
                for ref_index, module_ref in enumerate(module_refs):
                    module_source(module_ref, f"{path}.module_refs[{ref_index}]")
        operation_sources.append(common_sources)

    covered: set[str] = set()
    coverage = plan.get("coverage")
    if not isinstance(coverage, list):
        errors.append("coverage must be an array")
    else:
        for index, raw_item in enumerate(coverage):
            item = _dict(raw_item)
            path = f"coverage[{index}]"
            _unexpected_fields(item, {"source_block_id", "operation_indexes"}, path, errors)
            source_id = _string(item.get("source_block_id"))
            if source_id not in source_ids:
                errors.append(f"{path}.source_block_id is unknown")
            else:
                covered.add(source_id)
            indexes = item.get("operation_indexes")
            if not isinstance(indexes, list) or any(not isinstance(value, int) or isinstance(value, bool) for value in indexes):
                errors.append(f"{path}.operation_indexes must be an array of integers")
            else:
                for operation_index in indexes:
                    if not 0 <= operation_index < len(operation_sources):
                        errors.append(f"{path} references an invalid operation index")
                    elif source_id not in operation_sources[operation_index]:
                        errors.append(f"{path} references an operation that does not cite this source block")

    unresolved_ids: set[str] = set()
    unresolved_image_ids: list[str] = []
    unresolved = plan.get("unresolved")
    if not isinstance(unresolved, list):
        errors.append("unresolved must be an array")
    else:
        for index, raw_item in enumerate(unresolved):
            item = _dict(raw_item)
            path = f"unresolved[{index}]"
            _unexpected_fields(item, {"source_block_ids", "image_anchor_ids", "reason"}, path, errors)
            unresolved_ids |= _source_ids(item.get("source_block_ids"), source_ids, f"{path}.source_block_ids", errors)
            anchors = item.get("image_anchor_ids", [])
            if not isinstance(anchors, list) or any(not isinstance(value, str) for value in anchors):
                errors.append(f"{path}.image_anchor_ids must be an array of image IDs")
            else:
                unknown = sorted(set(anchors) - image_ids)
                if unknown:
                    errors.append(f"{path}.image_anchor_ids contains unknown IDs: {', '.join(unknown)}")
                unresolved_image_ids.extend(value for value in anchors if value in image_ids)
            if not _string(item.get("reason")).strip():
                errors.append(f"{path}.reason must be non-empty")
    missing_sources = sorted(required_source_ids - covered - unresolved_ids)
    if missing_sources:
        errors.append(f"article blocks are neither covered nor unresolved: {', '.join(missing_sources)}")
    image_counts = {item_id: (placed_images + unresolved_image_ids).count(item_id) for item_id in image_ids}
    bad_images = sorted(item_id for item_id, count in image_counts.items() if count != 1)
    if bad_images:
        errors.append(f"every article image must be used or unresolved exactly once: {', '.join(bad_images)}")

    deferred_assets = plan.get("deferred_assets", [])
    if not isinstance(deferred_assets, list):
        errors.append("deferred_assets must be an array")
        deferred_assets = []
    if deferred_assets and not policy.get("allow_deferred_assets", False):
        errors.append("deferred_assets are forbidden by policy")
    for index, raw_asset in enumerate(deferred_assets):
        asset = _dict(raw_asset)
        path = f"deferred_assets[{index}]"
        _unexpected_fields(asset, {"kind", "purpose", "preferred_slot_id", "source_block_ids", "reason"}, path, errors)
        if asset.get("kind") != "image":
            errors.append(f"{path}.kind must be image")
        if not _string(asset.get("purpose")).strip():
            errors.append(f"{path}.purpose must be non-empty")
        if not _string(asset.get("reason")).strip():
            errors.append(f"{path}.reason must be non-empty")
        _source_ids(asset.get("source_block_ids"), source_ids, f"{path}.source_block_ids", errors)
        preferred_slot_id = asset.get("preferred_slot_id")
        if preferred_slot_id is not None:
            if preferred_slot_id not in slots:
                errors.append(f"{path}.preferred_slot_id is unknown")
            elif slots[preferred_slot_id].get("kind") != "image":
                errors.append(f"{path}.preferred_slot_id must reference an image slot")

    warnings = plan.get("warnings")
    allowed_warning_codes = {"ambiguous_mapping", "insufficient_template", "possible_overflow", "protected_decoration", "stale_content_image", "deferred_asset", "manual_review"}
    if not isinstance(warnings, list):
        errors.append("warnings must be an array")
    else:
        for index, raw_warning in enumerate(warnings):
            warning = _dict(raw_warning)
            path = f"warnings[{index}]"
            _unexpected_fields(warning, {"code", "message", "module_refs", "slot_ids"}, path, errors)
            if warning.get("code") not in allowed_warning_codes:
                errors.append(f"{path}.code is unsupported")
            if not _string(warning.get("message")).strip():
                errors.append(f"{path}.message must be non-empty")
            module_refs = warning.get("module_refs")
            if not isinstance(module_refs, list) or any(not isinstance(value, str) for value in module_refs):
                errors.append(f"{path}.module_refs must be an array of module references")
            else:
                for ref_index, module_ref in enumerate(module_refs):
                    module_source(module_ref, f"{path}.module_refs[{ref_index}]")
            slot_ids = warning.get("slot_ids")
            if not isinstance(slot_ids, list) or any(not isinstance(value, str) for value in slot_ids):
                errors.append(f"{path}.slot_ids must be an array of slot IDs")
            else:
                unknown_slots = sorted(set(slot_ids) - set(slots))
                if unknown_slots:
                    errors.append(f"{path}.slot_ids contains unknown IDs: {', '.join(unknown_slots)}")
    _validate_confidence(plan.get("confidence"), "confidence", errors)
    confidence = plan.get("confidence")
    has_manual_review = any(isinstance(item, dict) and item.get("op") == "manual_review" for item in operations)
    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
        if (unresolved or has_manual_review) and confidence > 0.7:
            errors.append("confidence must not exceed 0.7 when template work is unresolved")
        elif deferred_assets and confidence > 0.85:
            errors.append("confidence must not exceed 0.85 when assets are deferred")
    return errors


def validate_plan(request: dict, plan: dict) -> list[str]:
    if not isinstance(request, dict) or not isinstance(plan, dict):
        return ["request and plan must be JSON objects"]
    task = request.get("task")
    if task == "analyze_content":
        return validate_content_plan(request, plan)
    if task == "plan_template_operations":
        return validate_template_plan(request, plan)
    return ["request.task is unsupported"]


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: validate_plan.py REQUEST.json PLAN.json", file=sys.stderr)
        return 2
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    plan = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    errors = validate_plan(request, plan)
    print(json.dumps({"ok": not errors, "errors": errors}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
