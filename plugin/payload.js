/** Minimal compatibility with previously produced HTML article packets. */
export function normalizeHtmlPacket(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('文件不是有效的导入包');
  if (input.nativeEdit) throw new Error('旧版原位更新包已停用；请用新版插件重新抓取原生模板');
  if (input.schema && !['xiumi-bridge/v2', 'xiumi-bridge/v3'].includes(input.schema)) throw new Error('不支持的导入包格式');
  if (typeof input.html !== 'string' || !input.html.trim()) throw new Error('HTML 成稿包缺少正文');
  if (input.native?.modules?.length) return input;
  return { html: input.html, native: { modules: [{ html: input.html }], pageFormat: { styles: {} } }, assets: input.assets || [] };
}
