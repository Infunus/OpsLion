export function normalizePayload(input) {
  const packet = typeof input === "string" ? { html: input } : input;
  if (!packet || typeof packet.html !== "string" || !packet.html.trim()) throw new Error("数据包缺少 HTML 正文");
  if (packet.schema && !["xiumi-bridge/v2", "xiumi-bridge/v3"].includes(packet.schema)) throw new Error("请选择 OpsLion 导出的 .xiumi.json；模板包需要先导入 OpsLion");
  if (packet.schema === "xiumi-bridge/v3") {
    if (!Array.isArray(packet.native?.modules) || !packet.native.modules.length || !Array.isArray(packet.assets)) throw new Error("Bridge v3 缺少模块或素材清单，请重新导出");
    return packet;
  }
  // Legacy HTML has no author-defined boundaries or original-draft identity.
  // Keep the full shell as one explicit module; never advertise text patches.
  return { schema: "xiumi-bridge/v3", html: packet.html, native: { modules: [{ id: "legacy-html", html: packet.html }], pageFormat: { styles: {} } }, assets: [], legacy: true, patch: { available: false, operations: [], reasons: ["旧 HTML 包缺少原稿定位，请用新版插件重新抓取后再做原位更新"] } };
}
