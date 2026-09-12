import { normalizeTemplateMetadata } from "./template-clone";
import type { StudioProject } from "./types";
export function cleanCapturedTitle(value: string) {
  return value.replace(/^\(\d+\s*条消息\)\s*/, "").replace(/^图文[:：]\s*/, "").replace(/\s*\|\s*秀米XIUMI\s*$/i, "").trim() || "未命名历史模板";
}
export const normalizeProjectTemplate = (value: StudioProject): StudioProject => {
  if (!value.cloneTemplate) return value;
  const normalized = normalizeTemplateMetadata(value.cloneTemplate);
  return { ...value, cloneTemplate: { ...normalized, name: cleanCapturedTitle(normalized.name) } };
};
export const articleMentionsImage = (content: StudioProject["content"]) => /二维码|扫码|配图|海报|下方(?:图片|问卷|报名码)|如下图|问卷二维码/.test([
  content.lead, ...content.sections.flatMap((section) => [section.title, section.body]), content.ending,
].join("\n"));
