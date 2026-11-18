import { nativeBlueprintInPage } from "./blueprint-runtime.js";
export async function callBlueprint(tabId, request, action) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: nativeBlueprintInPage, args: [JSON.stringify(request), action] });
  if (!result?.result) throw new Error("无法连接秀米的原生组件模型，请检查编辑页是否加载完成");
  if (!result.result.ok) throw new Error(result.result.message || "原生模板操作失败");
  return result.result;
}
export function exportJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
