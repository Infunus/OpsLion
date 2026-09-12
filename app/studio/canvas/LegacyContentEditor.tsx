import type { StudioProject } from "../types";

/** Older projects retain their existing theme and content model while editing. */
export function LegacyContentEditor({ content, change }: { content: StudioProject["content"]; change: (patch: Partial<StudioProject["content"]>) => void }) {
  const sectionChange = (id: string, patch: Partial<StudioProject["content"]["sections"][number]>) => change({ sections: content.sections.map((section) => section.id === id ? { ...section, ...patch } : section) });
  return <div className="legacy-canvas-fields" aria-label="文稿内容编辑">
    <label>文章标题<input aria-label="画布文章标题" value={content.title} onChange={(e) => change({ title: e.target.value })} /></label>
    <label>副标题<input aria-label="画布副标题" value={content.subtitle} onChange={(e) => change({ subtitle: e.target.value })} /></label>
    <label>导语<textarea aria-label="画布导语" value={content.lead} onChange={(e) => change({ lead: e.target.value })} rows={3} /></label>
    {content.sections.filter((section) => section.visible).map((section, index) => <fieldset key={section.id}>
      <legend>第 {index + 1} 节</legend>
      <label>小标题<input aria-label={`画布第 ${index + 1} 节标题`} value={section.title} onChange={(e) => sectionChange(section.id, { title: e.target.value })} /></label>
      <label>正文<textarea aria-label={`画布第 ${index + 1} 节正文`} value={section.body} onChange={(e) => sectionChange(section.id, { body: e.target.value })} rows={6} /></label>
      <details><summary>配图</summary><label>图片地址<input aria-label={`画布第 ${index + 1} 节图片地址`} value={section.imageUrl} onChange={(e) => sectionChange(section.id, { imageUrl: e.target.value })} /></label><label>图注<input aria-label={`画布第 ${index + 1} 节图注`} value={section.imageCaption} onChange={(e) => sectionChange(section.id, { imageCaption: e.target.value })} /></label></details>
    </fieldset>)}
    <label>结语<textarea aria-label="画布结语" value={content.ending} onChange={(e) => change({ ending: e.target.value })} rows={3} /></label>
  </div>;
}
