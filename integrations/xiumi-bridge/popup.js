import { capturePage } from "./capture-page.js";
import { applyBridgeInPage } from "./page-runtime.js";
import { normalizePayload } from "./payload.js";
/* global chrome */
let currentPayload = { html: "", replacements: [] };
let currentTemplate = null;
let currentReceipt = null;
const status = document.getElementById("status");
const captureStatus = document.getElementById("captureStatus");
const captureMeta = document.getElementById("captureMeta");
const sendButton = document.getElementById("send");
const downloadButton = document.getElementById("download");

function show(message, kind = "") {
  status.textContent = message;
  status.className = `status ${kind}`;
}

function showCapture(message, kind = "") {
  captureStatus.textContent = message;
  captureStatus.className = `status ${kind}`;
}

function setCapturedTemplate(template) {
  currentTemplate = template;
  const ready = Boolean(template?.html);
  sendButton.disabled = !ready;
  downloadButton.disabled = !ready;
  if (!ready) {
    captureMeta.className = "capture-meta";
    captureMeta.textContent = "";
    return;
  }
  const stats = template.stats || {};
  const blocks = stats.blocks ? ` · ${stats.blocks} 个顶层板块` : "";
  const svgDetail = stats.svgs ? ` · ${stats.svgs} 个 SVG · ${stats.animations || 0} 个动画` : "";
  captureMeta.textContent = `${template.sourceType === "wechat" ? "公众号成品" : "秀米排版"}${blocks} · ${stats.elements || 0} 个节点 · ${stats.images || 0} 张图片 · ${stats.links || 0} 个链接${svgDetail}`;
  captureMeta.className = "capture-meta visible";
}

async function savePayload(payload) {
  currentPayload = normalizePayload(payload);
  await chrome.storage.local.set({ xiumiBridgePayload: currentPayload });
  currentReceipt = null;
  await chrome.storage.local.remove("xiumiBridgeReceipt");
  const count = currentPayload.native.modules.length;
  const images = currentPayload.assetSummary?.embedded || 0;
  const patch = currentPayload.patch;
  show(currentPayload.legacy ? "已读取旧 HTML，将作为一个模块导入。多模块排版请在新版 OpsLion 重新导出。" : `已读取 ${count} 个模块${images ? `，${images} 张内嵌图片将在导入前上传` : ""}。${patch?.available ? `可原位更新 ${patch.operations.length} 处。` : patch?.reasons?.join("；") || ""}`, "ok");
}

chrome.storage.local.get(["xiumiBridgePayload", "xiumiBridgeHtml", "opslionCapturedTemplate", "xiumiBridgeReceipt"]).then((data) => {
  const restored = data.xiumiBridgePayload || data.xiumiBridgeHtml;
  if (restored) { try { currentPayload = normalizePayload(restored); show(`已恢复 ${currentPayload.native.modules.length} 个待导入模块。`, "ok"); } catch (error) { show(error.message, "error"); } }
  currentReceipt = data.xiumiBridgeReceipt || null;
  if (data.opslionCapturedTemplate) {
    setCapturedTemplate(data.opslionCapturedTemplate);
    showCapture("已恢复上一次抓取的排版模板。", "ok");
  }
});

document.getElementById("file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await savePayload(JSON.parse(await file.text()));
  } catch (error) {
    show(error.message || "无法读取这个 Bridge 数据包。", "error");
  }
});

document.getElementById("clipboard").addEventListener("click", async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes("text/html")) {
        await savePayload({ html: await (await item.getType("text/html")).text(), replacements: [] });
        return;
      }
      if (item.types.includes("text/plain")) {
        const source = await (await item.getType("text/plain")).text();
        const escaped = source.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char])).replace(/\n/g, "<br>");
        await savePayload({ html: `<p>${escaped}</p>`, replacements: [] });
        return;
      }
    }
    show("剪贴板中没有可读取的文字或富文本。", "error");
  } catch {
    show("浏览器没有授予剪贴板读取权限。", "error");
  }
});

document.getElementById("capture").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(?:(?:[^/]+\.)?xiumi\.us|mp\.weixin\.qq\.com|v\.xiumius\.cn)\//i.test(tab.url || "")) {
    return showCapture("请先打开秀米编辑页或已发布的微信公众号文章。", "error");
  }
  showCapture("正在识别正文范围并整理样式……");
  try {
    const [preparation] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const incomplete = document.querySelector('animate[revert-expand],animate.expand-self-animation:not([to])');
        if (!incomplete) return { needsPreview: false };
        const preview = [...document.querySelectorAll('iframe')].some((frame) => {
          try { return new URL(frame.src).hostname === 'v.xiumius.cn'; } catch { return false; }
        });
        if (!preview) {
          const button = [...document.querySelectorAll('button,[role="button"]')].find((node) => node.textContent.trim() === '预览');
          if (!button) return { needsPreview: true, unavailable: true };
          button.click();
        }
        return { needsPreview: true };
      },
    });
    if (preparation.result?.unavailable) return showCapture("这篇推文包含展开 SVG，请先在秀米打开“预览”，再抓取排版。", "error");
    const needsPreview = Boolean(preparation.result?.needsPreview);
    if (needsPreview) showCapture("正在读取秀米预览中的完整 SVG 和展开动画……");
    let results = [];
    for (let attempt = 0; attempt < (needsPreview ? 10 : 1); attempt += 1) {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: capturePage,
      });
      if (!needsPreview || results.some((item) => item.result?.renderedPreview && item.result?.html)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const captured = results
      .map((item) => item.result)
      .filter(Boolean)
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))[0];
    if (captured?.error) return showCapture(captured.error, "error");
    if (needsPreview && !captured?.renderedPreview) return showCapture("秀米预览尚未就绪。请等待预览内容显示后重试，并确认已更新扩展的秀米预览页访问权限。", "error");
    if (!captured?.html) return showCapture("没有识别到文章正文。秀米页面可能需要先点击编辑画布。", "error");
    let nativeModuleHashes;
    if (captured.sourceType === "xiumi" && !captured.renderedPreview) {
      const [baseline] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: applyBridgeInPage, args: [{}, "capture-source"] });
      if (baseline?.result?.ok) nativeModuleHashes = baseline.result.nativeModuleHashes;
    }
    const template = {
      schema: "opslion-template/v2",
      title: captured.title || tab.title || "抓取的排版模板",
      sourceType: captured.sourceType,
      renderedPreview: Boolean(captured.renderedPreview),
      sourceUrl: tab.url || "",
      capturedAt: new Date().toISOString(),
      html: captured.html,
      stats: captured.stats,
      source: { ...captured.source, ...(nativeModuleHashes ? { nativeModuleHashes } : {}), url: tab.url || captured.source.url, ...(tab.url?.match(/\/paper\/for\/(\d+)/)?.[1] ? { paperId: tab.url.match(/\/paper\/for\/(\d+)/)[1] } : {}) },
    };
    await chrome.storage.local.set({ opslionCapturedTemplate: template });
    setCapturedTemplate(template);
    showCapture(captured.renderedPreview ? "已抓取完整 SVG 预览。可以发送到 OpsLion 或下载备份。" : "抓取完成。可以发送到 OpsLion 或下载备份。", "ok");
  } catch {
    showCapture("抓取失败。请刷新页面，点击正文区域后再试。", "error");
  }
});

sendButton.addEventListener("click", async () => {
  if (!currentTemplate) return;
  showCapture("正在发送到本机 OpsLion……");
  try {
    const response = await fetch("http://127.0.0.1:4319/templates/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentTemplate),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "发送失败");
    showCapture("发送成功，正在打开样式复刻。", "ok");
    await chrome.tabs.create({ url: `http://127.0.0.1:3000/?templateImport=1&capture=${encodeURIComponent(payload.template.id)}` });
  } catch (error) {
    showCapture(error instanceof TypeError ? "无法连接 OpsLion。请先双击“启动排版台.bat”。" : `发送失败：${error.message}。可下载模板包后从 OpsLion 导入。`, "error");
  }
});

downloadButton.addEventListener("click", () => {
  if (!currentTemplate) return;
  const filename = `${(currentTemplate.title || "opslion-template").replace(/[\\/:*?"<>|]/g, "-").slice(0, 60)}.opslion-template.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(currentTemplate, null, 2)], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
  showCapture("模板包已下载。", "ok");
});

async function activeXiumiTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://xiumi.us/")) {
    show("请先切换到秀米编辑页面。", "error");
    return null;
  }
  return tab;
}

async function perform(action) {
  if (action !== "verify" && !currentPayload.html) return show("请先导入数据包或读取剪贴板。", "error");
  const tab = await activeXiumiTab();
  if (!tab) return;
  const buttons = ["insert", "replace", "verify"].map((id) => document.getElementById(id));
  buttons.forEach((button) => { button.disabled = true; });
  show(action === "insert" ? "正在检查模块并上传素材，请保持面板打开……" : "正在核对原稿与原生模块……");
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: applyBridgeInPage, args: [currentPayload, action, currentReceipt] });
    if (!result?.result) throw new Error("秀米编辑服务没有返回结果，请检查页面状态");
    const response = result.result;
    show(response.message, response.ok ? "ok" : "error");
    if (response.ok && response.receipt) {
      currentReceipt = response.receipt;
      await chrome.storage.local.set({ xiumiBridgeReceipt: currentReceipt });
    }
  } catch (error) { show(error.message || "无法连接秀米编辑服务，请刷新页面后重试", "error"); }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}
document.getElementById("insert").addEventListener("click", () => void perform("insert"));
document.getElementById("replace").addEventListener("click", () => void perform("patch"));
document.getElementById("verify").addEventListener("click", () => void perform("verify"));
