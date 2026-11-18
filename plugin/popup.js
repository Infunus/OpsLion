import { callBlueprint, exportJson } from './blueprint-client.js';
import { initialSequence } from './blueprint-core.js';
import { asNativePlan, createNativeBridgePacket } from './bridge-import.js';
import { normalizeHtmlPacket } from './payload.js';
import { applyBridgeInPage } from './page-runtime.js';
import { saveNewArticleInPage } from './save-new-article.js';
/* global chrome */

const $ = (id) => document.getElementById(id);
let selected = null;
let busy = false;
const CACHE_KEY = 'lastImportPacket';
let selectionVersion = 0;
const selectionLabel = (entry) => entry.kind === 'native'
  ? `${entry.filename}（${entry.packet.sequence.length} 个原生模块）`
  : `旧版 HTML 包：${entry.filename}`;
async function cacheSelection() {
  if (!selected) return;
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: selected });
  } catch (e) {
    status('status', `文件已选中，但无法保存本地缓存：${e.message || e}`, 'error');
  }
}
async function restoreCache() {
  const version = selectionVersion;
  try {
    const saved = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
    if (version !== selectionVersion || selected || !saved) return;
    const plan = saved.kind === 'native' ? asNativePlan({ schema: 'xiumi-bridge/v4', mode: 'native-layout', nativeLayout: saved.packet }) : null;
    selected = plan ? { kind: 'native', packet: plan, filename: saved.filename || '上次导入包' }
      : { kind: 'html', packet: normalizeHtmlPacket(saved.packet), filename: saved.filename || '上次导入包' };
    status('status', `已恢复上次导入包：${selectionLabel(selected)}`, 'ok');
  } catch (e) {
    status('status', '本地缓存不可用，请重新选择导入包', 'error');
  }
}
restoreCache();
function status(id, text, type = '') {
  $(id).textContent = text;
  $(id).className = `status ${type}`;
}
function setBusy(value) {
  busy = value;
  $('capture').disabled = value;
  $('import').disabled = value;
  $('clearCache').disabled = value;
}
function filename(title) {
  return `${String(title || '秀米模板').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim().slice(0, 70) || '秀米模板'}.xiumi.json`;
}
async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/xiumi\.us\//i.test(tab.url || '') || !/#\/paper\//.test(tab.url || '')) {
    throw new Error('请先打开秀米图文编辑页');
  }
  return tab;
}
async function loadFile(file) {
  if (!file) return;
  if (busy) return;
  selectionVersion++;
  selected = null;
  try {
    const data = JSON.parse(await file.text());
    const plan = asNativePlan(data);
    selected = plan ? { kind: 'native', packet: plan, filename: file.name } : { kind: 'html', packet: normalizeHtmlPacket(data), filename: file.name };
    status('status', `已选择：${selectionLabel(selected)}`, 'ok');
    await cacheSelection();
  } catch (e) {
    status('status', `无法读取文件：${e.message}`, 'error');
  }
}
$('file').addEventListener('change', async (event) => {
  await loadFile(event.target.files?.[0]);
  event.target.value = '';
});
$('capture').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  status('captureStatus', '正在抓取……');
  try {
    const tab = await currentTab();
    const { blueprint, message } = await callBlueprint(tab.id, {}, 'capture');
    const packet = createNativeBridgePacket({
      schema: 'opslion-native-layout-plan/v1',
      blueprint,
      sequence: initialSequence(blueprint),
    }, tab.title || '秀米模板');
    exportJson(packet, filename(packet.title));
    selectionVersion++;
    selected = { kind: 'native', packet: packet.nativeLayout, filename: filename(packet.title) };
    await cacheSelection();
    status('captureStatus', `抓取成功：${message} 文件已下载，并已缓存，可直接导回空白稿。`, 'ok');
    status('status', `已选择刚抓取的模板：${selectionLabel(selected)}`, 'ok');
  } catch (e) {
    status('captureStatus', e.message || '抓取失败', 'error');
  } finally { setBusy(false); }
});
$('import').addEventListener('click', async () => {
  if (busy) return;
  if (!selected) return status('status', '请先选择导入文件', 'error');
  setBusy(true);
  status('status', '正在导入……');
  try {
    const tab = await currentTab();
    let result;
    if (selected.kind === 'native') {
      result = await callBlueprint(tab.id, { plan: selected.packet }, 'apply');
    } else {
      const [response] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN', func: applyBridgeInPage,
        args: [selected.packet],
      });
      result = response?.result;
      if (!result) throw new Error('无法连接秀米编辑器');
    }
    if (!result.ok) throw new Error(result.message || '导入失败');
    if (!/#\/paper\/for\/\d+/.test(tab.url || '')) {
      status('status', '正文已导入，正在通过秀米编辑器保存新图文……');
      try {
        const [saveResponse] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN', func: saveNewArticleInPage,
        });
        const saved = saveResponse?.result;
        if (!saved?.ok) throw new Error(saved?.message || '未取得新稿件 ID');
        status('status', `已导入并自动保存为秀米稿件 ${saved.paperId}，请检查排版。`, 'ok');
      } catch (saveError) {
        status('status', `正文已经写入秀米编辑器，但自动保存未完成：${saveError.message || saveError}。请勿刷新页面，当前内容还未确认保存。`, 'error');
      }
    } else {
      status('status', result.message || '导入成功，请检查排版并在秀米保存', 'ok');
    }
  } catch (e) {
    status('status', e.message || '导入失败', 'error');
  } finally { setBusy(false); }
});

$('clearCache').addEventListener('click', async () => {
  if (busy) return;
  selectionVersion++;
  selected = null;
  try {
    await chrome.storage.local.remove(CACHE_KEY);
    status('status', '已清除上次导入包，请重新选择文件');
  } catch (e) { status('status', `清除缓存失败：${e.message || e}`, 'error'); }
});

$('collector').addEventListener('click', async () => {
  const result=await chrome.runtime.sendMessage({action:'open-collector'});
  if(!result?.ok)status('status',result?.message || '采集台打开失败，请重试。','error');
});
