/** Portable Xiumi v5 native layout format. Pure functions; safe to use in Node tests. */
export const BLUEPRINT_SCHEMA = "opslion-native-blueprint/v1";
export const BLUEPRINT_PLAN_SCHEMA = "opslion-native-layout-plan/v1";

export function validateBlueprint(input) {
  const b = input?.blueprint?.schema === BLUEPRINT_SCHEMA ? input.blueprint : input;
  if (!b || b.schema !== BLUEPRINT_SCHEMA || !b.source || !/^\d+$/.test(b.source.paperId || "")
      || !Array.isArray(b.modules) || !b.modules.length || b.modules.length > 500
      || !b.pageStyle || typeof b.pageStyle !== "object" || Array.isArray(b.pageStyle)
      || !Array.isArray(b.slots) || b.slots.length > 15000)
    throw new Error("需要包含完整组件树的秀米抓取包（opslion-native-blueprint/v1）");
  const ids = new Set();
  for (const s of b.slots) {
    if (!s || !["text", "image"].includes(s.kind) || typeof s.id !== "string" || ids.has(s.id)
        || !Number.isInteger(s.module) || s.module < 0 || s.module >= b.modules.length
        || !Array.isArray(s.path) || s.path[0] !== s.module) throw new Error("原生模板包含重复或无效的编辑位置");
    ids.add(s.id);
    if (s.kind === "text" && (!Number.isInteger(s.run) || s.run < 0 || typeof s.original !== "string")) throw new Error("文本片段的定位信息有误");
    if (s.kind === "image" && (typeof s.original !== "string" || typeof s.field !== "string")) throw new Error("图片资源的定位信息有误");
  }
  if (JSON.stringify({ modules: b.modules, pageStyle: b.pageStyle }).length > 8_000_000)
    throw new Error("完整模板超过 8MB，请拆分模板后重试");
  return b;
}

export function initialSequence(input) {
  const b = validateBlueprint(input);
  return b.modules.map((_, index) => ({ id: `block-${index + 1}`, source: index, edits: {} }));
}

export function validateLayoutPlan(input) {
  if (!input || input.schema !== BLUEPRINT_PLAN_SCHEMA) throw new Error("原生布局方案格式无效");
  const b = validateBlueprint(input.blueprint);
  if (!Array.isArray(input.sequence) || !input.sequence.length || input.sequence.length > 1000)
    throw new Error("布局生成方案应包含 1–1000 个模块");
  const idSet = new Set();
  const slots = new Map(b.slots.map((s) => [s.id, s]));
  for (const entry of input.sequence) {
    if (!entry || typeof entry.id !== "string" || !entry.id || idSet.has(entry.id) || !Number.isInteger(entry.source)
        || entry.source < 0 || entry.source >= b.modules.length || !entry.edits || typeof entry.edits !== "object"
        || Array.isArray(entry.edits)) throw new Error("布局模块的来源或标识有误");
    idSet.add(entry.id);
    for (const [id, value] of Object.entries(entry.edits)) {
      const slot = slots.get(id);
      if (!slot || slot.module !== entry.source || typeof value !== "string" || value.length > (slot.kind === "image" ? 17_000_000 : 50000))
        throw new Error("布局修改包含无效片段、跨模块引用或过长内容");
      if (slot.kind === "text" && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error("文字包含非法控制字符");
    }
  }
  return { schema: BLUEPRINT_PLAN_SCHEMA, blueprint: b, sequence: input.sequence };
}

