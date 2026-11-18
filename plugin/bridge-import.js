/** Input format compatibility for the one-click Bridge importer. Pure functions. */
import {
  validateLayoutPlan,
} from './blueprint-core.js';

/** A complete native import bundle can be generated from a blueprint + ordered edits. */
export const NATIVE_BRIDGE_SCHEMA = 'xiumi-bridge/v4';

export function asNativePlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema !== NATIVE_BRIDGE_SCHEMA) return null;
  if (value.mode !== 'native-layout' || !value.nativeLayout) throw new Error('原生导入包缺少 nativeLayout');
  return validateLayoutPlan(value.nativeLayout);
}

export function createNativeBridgePacket(plan, title = '秀米原生成稿') {
  const validated = validateLayoutPlan(plan);
  if (typeof title !== 'string' || title.length > 200) throw new Error('成稿标题无效');
  return {
    schema: NATIVE_BRIDGE_SCHEMA,
    mode: 'native-layout',
    title: title.trim() || '秀米原生成稿',
    nativeLayout: validated,
  };
}

