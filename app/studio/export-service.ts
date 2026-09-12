import type { StudioProject, CompatibilityIssue } from "./types";
import { plainTextFromHtml, wrapStandaloneHtml } from "./renderer";
import { sanitizeArticleHtml } from "./html-policy";
import { articleTitle } from "./template-engine/adapter";
import { submissionBlockers } from "./submission/assemble";
import { createProjectBridgePackage, resolveLocalBridgeAssets } from "./bridge-package";
import { collectBridgeAssets } from "./bridge-contract";
import { templateContentBlockers } from "./local-template-fill";
export function downloadBlob(content: string | Blob, filename: string, type = "text/plain;charset=utf-8") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

export function safeFilename(value: string) {
  return (value || "wechat-layout").replace(/[\\/:*?"<>|]/g, "-").slice(0, 60);
}

export function createExportActions(project: StudioProject, html: string, issues: CompatibilityIssue[], notify: (message: string) => void, close: () => void) {
  html = sanitizeArticleHtml(html);
  const title = project.mode === "compose" && project.layout ? articleTitle(project.layout.article) : project.content.title;
  const ready = () => { const blockers = [...submissionBlockers(project.submission ?? undefined), ...(project.mode === "clone" ? templateContentBlockers(project.cloneTemplate) : [])]; if (blockers.length) { notify(`交稿尚未完成：${blockers.slice(0, 2).join("；")}。可继续编辑并下载项目备份。`); return false; } if (!html.trim() || issues.some((issue) => issue.level === "error")) { notify("排版尚未完成，请先处理预览中的问题；项目备份仍可下载。"); return false; } return true; };
  const clipboardReady = () => {
    if (!ready()) return false;
    if (collectBridgeAssets(html).some((asset) => asset.status !== "remote")) { notify("文章含本地或内嵌图片，请下载 Bridge 数据包，由插件上传图片后分模块导入秀米。"); return false; }
    return true;
  };
  const copyRichText = async (forceFallback = false) => {
    if (!clipboardReady()) return;
    const plain = plainTextFromHtml(html);
    try {
      if (!forceFallback && "ClipboardItem" in window && navigator.clipboard?.write) {
        const item = new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        });
        await navigator.clipboard.write([item]);
      } else {
        const holder = document.createElement("div");
        holder.contentEditable = "true";
        holder.style.position = "fixed";
        holder.style.left = "-10000px";
        holder.innerHTML = html;
        (document.querySelector("dialog[open]") || document.body).appendChild(holder);
        const range = document.createRange();
        range.selectNodeContents(holder);
        const selection = window.getSelection();
        const previousRanges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)) : [];
        try {
          selection?.removeAllRanges(); selection?.addRange(range);
          if (!document.execCommand("copy")) throw new Error("复制未完成");
        } finally {
          selection?.removeAllRanges(); holder.remove();
          previousRanges.forEach((previous) => selection?.addRange(previous));
        }
      }
      notify("富文本已复制，现在可以粘贴到秀米");
      close();
    } catch {
      notify("自动复制失败，请使用“打开安全复制页”");
    }
  };

  const copySource = async () => {
    if (!ready()) return;
    try {
      await navigator.clipboard.writeText(html);
      notify("HTML 源码已复制");
    } catch {
      notify("浏览器未授权读取剪贴板");
    }
  };

  const openTransferPage = () => {
    if (!clipboardReady()) return;
    const transfer = window.open("", "_blank");
    if (!transfer) return notify("浏览器阻止了新窗口，请允许弹窗后重试");
    transfer.opener = null;
    transfer.document.open();
    transfer.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>秀米安全复制页</title></head><body style="margin:0;background:#eef0eb;font-family:Arial,'Microsoft YaHei',sans-serif;"><div contenteditable="false" style="position:sticky;top:0;z-index:2;padding:14px 18px;background:#20231f;color:#fff;text-align:center;font-size:14px;">按 Ctrl+A 全选，再按 Ctrl+C 复制，然后粘贴到秀米。下方只有最终富文本内容。</div><main style="width:390px;max-width:100%;margin:24px auto;background:#fff;">${html}</main></body></html>`);
    transfer.document.close();
    close();
  };

  const downloadHtml = () => { if (html.trim()) downloadBlob(wrapStandaloneHtml(html, `${title} · 本地预览`), `${safeFilename(project.name)}.preview.html`, "text/html;charset=utf-8"); };
  const downloadBridge = async () => {
    if (!ready()) return false;
    try {
      const packet = createProjectBridgePackage(project, html, title || project.name, await resolveLocalBridgeAssets(html));
      downloadBlob(JSON.stringify({ ...packet, compatibility: issues }, null, 2), `${safeFilename(project.name)}.xiumi.json`, "application/json;charset=utf-8");
      notify("Bridge 数据包已生成，请在秀米用扩展导入、保存并重新打开验证。");
      return true;
    }
    catch (error) { notify(error instanceof Error ? error.message : "Bridge 数据包生成失败"); return false; }
  };
  const exportProject = () => downloadBlob(JSON.stringify({ schema: "wechat-agent-studio/project-v1", project }, null, 2), `${safeFilename(project.name)}.layout.json`, "application/json;charset=utf-8");

  return { copyRichText, copySource, openTransferPage, downloadHtml, downloadBridge, exportProject };
}
