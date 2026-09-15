"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { WeeklyDraft } from "./project-schema";
import { requestJson } from "./request";
import { safeLinkUrl } from "./html-policy";
import { downloadBlob } from "./export-service";
import { recentRssDates, rssRangeError, type RssDateRange } from "./rss-client";
import { buildRssArchive, type RssArchive, type RssCollection } from "./rss-export";
import { RssManagement, type RssAuthorization } from "./RssManagement";
import "./rss-integration.css";

interface RssStatus {
  protocol: string; available: boolean; message?: string; management_version?: number;
  management_mode?: string; management_url?: string;
  feeds: { id: string; mp_name: string; status: number }[];
  refresh?: RssCollection; auth?: RssAuthorization;
}
interface Props { weekly: WeeklyDraft; setWeekly: Dispatch<SetStateAction<WeeklyDraft>>; ready: boolean; writable: boolean }
const post = <T,>(path: string, payload: object = {}, signal?: AbortSignal) => requestJson<T>(`/local-api/${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal, timeoutMs: 35_000,
});

export function WeeklyRssPanel({ weekly, setWeekly, ready, writable }: Props) {
  const [status, setStatus] = useState<RssStatus | null>(null);
  const [refresh, setRefresh] = useState<RssCollection | null>(null);
  const [refreshKnown, setRefreshKnown] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const [pollError, setPollError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [phase, setPhase] = useState("");
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [management, setManagement] = useState(false);
  const [archive, setArchive] = useState<RssArchive | null>(null);
  const [defaultRange] = useState(() => recentRssDates(7));
  const connection = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  const attemptedJob = useRef("");
  const available = ready && !connecting && status?.available === true && status.protocol === "opslion-rss/v1";
  const collecting = refresh?.running === true;
  const nativeManagement = status?.management_mode === "native" ? safeLinkUrl(status.management_url) : "";
  const busy = !!phase || starting;
  const pending = weekly.pendingExport;
  const pendingJob = pending?.jobId;
  const locked = !ready || !writable || (available && !refreshKnown) || busy || collecting || !!pending;
  const range = { startDate: weekly.startDate || defaultRange.startDate, endDate: weekly.endDate || defaultRange.endDate };
  const enabledFeedIds = JSON.stringify(status?.feeds.filter((feed) => feed.status === 1).map((feed) => feed.id) || []);

  const reconnect = useCallback(async () => {
    connection.current?.abort();
    const current = new AbortController(); connection.current = current;
    setConnecting(true); setConnectionError(""); setRefreshKnown(false);
    try {
      const next = await requestJson<RssStatus>("/local-api/status", { signal: current.signal, timeoutMs: 35_000 });
      if (next.protocol !== "opslion-rss/v1") throw new Error("RSS 协议不兼容，请检查适配程序，并重启排版台以更新本地桥接。");
      if (typeof next.available !== "boolean" || !Array.isArray(next.feeds) || next.feeds.some((feed) => !feed || typeof feed.id !== "string" || typeof feed.mp_name !== "string")) throw new Error("RSS 状态格式无效，请检查适配程序。");
      if (current.signal.aborted) return;
      setStatus(next); setRefresh(next.refresh || null); setPollError("");
    } catch (reason) {
      if (!current.signal.aborted) { setStatus(null); setRefresh(null); setConnectionError(reason instanceof Error ? reason.message : "RSS 接入失败"); }
    } finally { if (!current.signal.aborted) setConnecting(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timer = setTimeout(() => { if (ready) void reconnect(); }, 0);
    return () => { clearTimeout(timer); mounted.current = false; connection.current?.abort(); operation.current?.abort(); };
  }, [ready, reconnect]);

  useEffect(() => {
    if (!available) return;
    const current = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await requestJson<RssCollection>("/local-api/refresh/status", { signal: current.signal, timeoutMs: 35_000 });
        if (typeof next.running !== "boolean") throw new Error("RSS 采集状态格式无效，请检查适配程序。");
        if (current.signal.aborted) return;
        setRefresh(next); setRefreshKnown(true); setPollError("");
      } catch (reason) {
        if (current.signal.aborted) return;
        setPollError(reason instanceof Error ? reason.message : "暂时无法读取采集进度");
      }
      timer = setTimeout(() => void poll(), collecting || pendingJob ? 2000 : 5000);
    };
    timer = setTimeout(() => void poll(), collecting || pendingJob ? 500 : 1000);
    return () => { clearTimeout(timer); current.abort(); };
  }, [available, collecting, pendingJob]);

  const clearPending = useCallback((jobId: string) => {
    setWeekly((previous) => previous.pendingExport?.jobId === jobId ? { ...previous, pendingExport: null } : previous);
  }, [setWeekly]);

  const pack = useCallback(async (snapshot: RssDateRange, collection?: RssCollection, jobId?: string) => {
    if (active.current) return;
    active.current = true;
    const current = new AbortController(); operation.current = current;
    setArchive(null); setError(""); setNotice(""); setPhase("正在准备资料包…");
    try {
      const result = await buildRssArchive(snapshot, { signal: current.signal, onProgress: setPhase, collection, enabledFeedIds: JSON.parse(enabledFeedIds) });
      if (current.signal.aborted) return;
      setArchive(result);
      if (!result.issues.length) {
        downloadBlob(result.blob, result.filename, "application/zip");
        setNotice(`已导出 ${result.articleCount} 篇全文、${result.imageCount} 张配图。${result.coverageConfirmed ? "" : "资料基于已有采集数据，覆盖情况见清单。"}`);
      } else setNotice(`资料包有 ${result.issues.length} 项缺失，请查看清单后下载现有资料，或补采后重新导出。`);
      if (jobId) clearPending(jobId);
    } catch (reason) {
      if (!current.signal.aborted) setError(reason instanceof Error ? reason.message : "推文导出失败");
    } finally { active.current = false; if (mounted.current) setPhase(""); }
  }, [clearPending, enabledFeedIds]);

  useEffect(() => {
    if (!pending || !refreshKnown || !refresh || refresh.running || !available || !writable || busy || attemptedJob.current === pending.jobId) return;
    const timer = setTimeout(() => {
      attemptedJob.current = pending.jobId;
      if (refresh.job_id !== pending.jobId) {
        setError("待导出的采集任务已丢失或被后续任务替代，请按原日期重新导出已有推文。");
        clearPending(pending.jobId); return;
      }
      if (refresh.return_code !== 0 || refresh.outcome !== "complete") {
        setError("采集未完整完成，未自动下载资料包。可重试采集，或导出已有推文。");
        clearPending(pending.jobId); return;
      }
      void pack({ startDate: pending.startDate, endDate: pending.endDate }, refresh, pending.jobId);
    }, 0);
    return () => clearTimeout(timer);
  }, [pending, refreshKnown, refresh, available, writable, busy, pack, clearPending]);

  const collect = async () => {
    if (locked || !available || rssRangeError(range) || active.current) return;
    active.current = true; setStarting(true); setError(""); setNotice(""); setArchive(null);
    const current = new AbortController(); operation.current = current;
    const snapshot = { ...range };
    try {
      const next = await post<RssCollection>("refresh", { start_date: snapshot.startDate, end_date: snapshot.endDate, mp_ids: [] }, current.signal);
      if (!next.job_id || typeof next.running !== "boolean") throw new Error("RSS 未返回有效采集任务编号和状态，无法安排自动导出");
      if (current.signal.aborted) return;
      setRefresh(next); setRefreshKnown(true);
      setWeekly((previous) => ({ ...previous, ...snapshot, pendingExport: { jobId: next.job_id!, ...snapshot } }));
    } catch (reason) { if (!current.signal.aborted) setError(reason instanceof Error ? reason.message : "无法启动采集"); }
    finally { active.current = false; if (mounted.current) setStarting(false); }
  };
  const cancel = async () => {
    setCancelling(true); setError("");
    try {
      const next = await post<RssCollection>("refresh/cancel", { job_id: refresh?.job_id }, connection.current?.signal);
      if (typeof next.running !== "boolean") throw new Error("RSS 未返回有效的停止状态，请重新连接后检查任务");
      if (!mounted.current) return;
      setRefresh(next);
      if (pending) clearPending(pending.jobId);
      setNotice("已请求停止采集，已采集推文和导入文案均保留。");
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "停止采集失败"); }
    finally { if (mounted.current) setCancelling(false); }
  };
  const cancelPackaging = () => {
    operation.current?.abort();
    setNotice("已停止打包，推文和文案均保留。");
    if (pending) clearPending(pending.jobId);
  };
  const managementChanged = useCallback(() => { void reconnect(); }, [reconnect]);

  return <section className="weekly-rss-panel" aria-label="RSS 采集与资料导出">
    <header className="weekly-rss-header">
      <div><span className="hello-week-eyebrow">01 · 收集资料</span><h3>公众号推文</h3><p>按日期导出全部公众号的全文与配图，再在别处生成周报文案。</p></div>
      <div className="weekly-rss-actions"><span className={available ? "rss-badge active" : "rss-badge"} role="status">{connecting ? "正在连接 RSS…" : available ? `已接入 · ${status!.feeds.length} 个公众号` : connectionError ? "RSS 接入失败" : "尚未接入 RSS"}</span><button className="small-button" disabled={!ready || connecting || busy} onClick={() => void reconnect()}>重新连接</button>{nativeManagement ? <a className="secondary-button" href={nativeManagement} target="_blank" rel="noopener noreferrer">打开完整 RSS</a> : <button className="secondary-button" disabled={!available || status?.management_version !== 1 || busy} onClick={() => setManagement(true)}>管理公众号</button>}</div>
    </header>
    {connectionError && <p className="weekly-rss-error" role="alert">{connectionError}</p>}
    {!available && !connecting && <details className="weekly-rss-setup"><summary>配置 RSS 接入</summary><p>完整 we-mp-rss 可通过仓库的 <code>scripts/setup-rss.ps1</code> 安装并接入，完成后点击“重新连接”。安装、迁移和其他适配程序的配置见 <code>docs/rss-integration.md</code>。</p><p>周报文案可直接在下方导入。</p></details>}
    {available && !nativeManagement && status?.management_version !== 1 && <p className="weekly-rss-note">当前适配程序未提供公众号管理，请在 RSS 模块中完成授权与订阅。</p>}
    {available && status?.auth?.message && <p className="weekly-rss-note">{status.auth.message}</p>}
    {available && status?.message && <p className="weekly-rss-note">{status.message}</p>}
    <div className="weekly-rss-controls"><div className="weekly-transfer-dates"><label>开始日期<input type="date" aria-label="开始日期" value={range.startDate} disabled={locked} onChange={(event) => setWeekly((previous) => ({ ...previous, startDate: event.target.value }))} /></label><span>—</span><label>结束日期<input type="date" aria-label="结束日期" value={range.endDate} disabled={locked} onChange={(event) => setWeekly((previous) => ({ ...previous, endDate: event.target.value }))} /></label></div>
      <div className="weekly-transfer-actions"><button className="primary-button" disabled={locked || !available || !!rssRangeError(range)} onClick={() => void collect()}>{starting ? "正在启动…" : "采集并导出 ZIP"}</button><button className="secondary-button" disabled={locked || !available || !!rssRangeError(range)} onClick={() => void pack({ ...range }, refresh || undefined)}>导出已有推文 ZIP</button></div></div>
    <p className="weekly-rss-note">{rssRangeError(range) || "包含起止两天 · 北京时间 · 导出该日期内全部已采集文章"}</p>
    {collecting && <div className="weekly-transfer-progress" role="status"><span>{refresh?.message || "正在采集，请等待任务完成…"}</span><button className="text-button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "正在停止…" : "停止采集"}</button></div>}
    {!collecting && refresh?.message && <p className="weekly-rss-note">{refresh.message}</p>}
    {pollError && <p className="weekly-rss-error" role="alert">{pollError}，正在重试读取进度。</p>}
    {pending && !phase && <p className="weekly-rss-note" role="status">已安排：{pending.startDate} — {pending.endDate}，采集完成后自动导出。重新打开周报可继续。<button className="text-button" onClick={() => clearPending(pending.jobId)}>取消自动导出</button></p>}
    {phase && <div className="weekly-transfer-progress" role="status"><span>{phase}</span><button className="text-button" onClick={cancelPackaging}>停止打包</button></div>}
    {error && <p className="weekly-rss-error" role="alert">{error}</p>}
    {pending && !collecting && !busy && error && <button className="text-button" onClick={() => void pack({ startDate: pending.startDate, endDate: pending.endDate }, refresh || undefined, pending.jobId)}>重试打包</button>}
    {notice && <p className="weekly-rss-note" role="status">{notice}</p>}
    {archive && <div className="weekly-archive-ready"><button className="text-button" onClick={() => downloadBlob(archive.blob, archive.filename, "application/zip")}>{archive.issues.length ? "下载现有资料 ZIP（含缺失清单）" : "再次下载 ZIP"}</button>{!!archive.issues.length && <details><summary>查看 {archive.issues.length} 项缺失</summary>{archive.issues.map((issue, index) => <p key={index}>{issue.article_id ? `文章 ${issue.article_id} · ` : ""}{issue.message}</p>)}</details>}</div>}
    {management && <RssManagement close={() => setManagement(false)} onChanged={managementChanged} collecting={collecting} />}
  </section>;
}
