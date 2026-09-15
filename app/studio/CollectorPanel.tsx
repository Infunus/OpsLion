"use client";
/* eslint-disable @next/next/no-img-element -- Login QR images must bypass image optimization and caching. */

import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "./request";
import { rssRangeError, type RssDateRange } from "./rss-client";
import { ModalDialog } from "./ModalDialog";

interface Account { name: string; bookId: string; enabled: boolean }
interface Book { name: string; bookId: string }
interface Job { id: string; action: string; state: string; stage: string; message: string; completed: number; total: number; result?: { books?: Book[]; code?: string; browser_opened?: boolean } }
interface Archive { id: string; start_date: string; end_date: string; article_count: number; body_count: number; image_count: number; complete: boolean; size: number; issues: { type: string; message: string }[] }
interface Status {
  protocol: string; prepared: boolean; module_available: boolean; node_available: boolean; browser_available: boolean;
  browser_name?: string; login?: { id: string; state: string; message: string; qr_available: boolean; revision: number; expires_at: number } | null;
  session: { state: string; message: string }; accounts: Account[]; has_index: boolean;
  quota: { used: number; max: number; runs: number; max_runs: number }; job: Job | null; resume_job?: Job | null; exports: Archive[];
}
const post = <T,>(path: string, payload: object) => requestJson<T>(`/local-api/collector/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), timeoutMs: 25_000 });
const downloadUrl = (id: string, kind: string) => `/local-api/collector/download?id=${encodeURIComponent(id)}&kind=${kind}`;

export function lastCompleteWeek(): RssDateRange {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  const today = new Date(day + "T00:00:00Z");
  const end = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7 + 1) * 86400000);
  return { startDate: new Date(end.getTime() - 6 * 86400000).toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

export function CollectorPanel({ range, onRangeChange }: { range: RssDateRange; onRangeChange: (patch: Partial<RssDateRange>) => void }) {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [manager, setManager] = useState(false);
  const [link, setLink] = useState("");
  const [books, setBooks] = useState<Book[]>([]);
  const [search, setSearch] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  const running = data?.job?.state === "running" || data?.job?.state === "cancelling";
  const locked = sending || running;
  const dateError = rssRangeError(range);
  const collectionLimit = data && data.quota.max > 0 && data.quota.used >= data.quota.max
    ? "本机今日请求预算已用完，明日可继续采集。已有缓存资料仍可导出、下载。"
    : data && data.quota.max_runs > 0 && data.quota.runs >= data.quota.max_runs
      ? "本机今日目录采集次数已用完，明日可再次采集。已有目录仍可导出，资料可直接下载。" : "";
  const enabled = data?.accounts.filter((item) => item.enabled) || [];
  const previousJob = useRef("");
  const reload = useCallback(async (signal?: AbortSignal) => {
    const result = await requestJson<Status>("/local-api/collector/status", { signal, timeoutMs: 25_000 });
    if (result.protocol !== "opslion-collector/v1") throw new Error("请重新启动排版台，加载公众号采集功能。");
    if (mounted.current) {
      setData(result); setError("");
      if (result.job?.result?.books && previousJob.current !== result.job.id) { setBooks(result.job.result.books); previousJob.current = result.job.id; }
    }
    return result;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 6000;
      try {
        const result = await reload(controller.signal);
        if (["running", "cancelling"].includes(result.job?.state || "")) delay = 1500;
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取采集状态");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, [reload, running]);

  const act = async (action: string, payload: object = {}) => {
    if (locked || pending.current) return;
    pending.current = true; setSending(true); setError("");
    try {
      await post("actions", { action, ...payload });
      await reload();
      if (action === "resolve") setLink("");
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "操作未完成"); }
    finally { pending.current = false; if (mounted.current) setSending(false); }
  };
  const cancel = async () => {
    if (!data?.job || pending.current) return;
    pending.current = true;
    try { await post("cancel", { job_id: data.job.id }); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "停止失败"); }
    finally { pending.current = false; }
  };
  const sessionReady = data?.session.state === "ready";
  const job = data?.job;
  const resumeJob = data?.resume_job || job;
  const resumable = resumeJob && ["paused", "failed", "cancelled"].includes(resumeJob.state) && ["collect", "export"].includes(resumeJob.action);
  const visibleAccounts = data?.accounts.filter((account) => !search || account.name.includes(search)) || [];

  return <section className="collector-panel" aria-label="公众号采集">
    <header className="collector-heading"><div><span className="collector-eyebrow">01 · 准备推文资料</span><h3>公众号采集</h3><p>按日期取得全文与配图，交给你的文案 Skill。</p></div>
      <button className="secondary-button" onClick={() => setManager(true)} disabled={!data}>公众号与登录{data ? ` · ${data.accounts.length}` : ""}</button></header>
    {error && <div className="collector-message error" role="alert"><span>{error}</span><button className="text-button" onClick={() => void reload().catch((reason) => setError(reason.message))}>重新连接</button></div>}
    {!data && !error && <p role="status">正在读取采集状态…</p>}
    {data && !data.prepared && <div className="collector-setup"><div><strong>首次使用，准备采集环境</strong><p>自动安装正文解析所需组件，完成后扫码并添加公众号。</p></div><button className="primary-button" disabled={locked || !data.module_available || !data.node_available || !data.browser_available} onClick={() => void act("initialize")}>初始化采集环境</button>
      {!data.browser_available && <p>默认浏览器暂不支持采集，请在 Windows 默认应用中选择 Edge、Chrome、Brave、Vivaldi 或 Chromium，然后重新连接。</p>}{!data.module_available && <p>采集模块缺失，请重新解压完整项目。</p>}{!data.node_available && <p>未找到 Node.js，请检查项目运行环境。</p>}</div>}
    {data?.prepared && <>
      <div className="collector-summary"><span className={sessionReady ? "collector-session ready" : "collector-session"}><i />{sessionReady ? "已登录微信读书" : data.session.state === "verification" ? "等待完成验证" : "等待登录"}</span><span>{enabled.length} 个公众号参与采集</span>
        {!sessionReady && <button className="text-button" disabled={locked} onClick={() => { setManager(true); void act("login"); }}>扫码登录</button>}
        {!sessionReady && <button className="text-button" disabled={locked} onClick={() => void act("check")}>检查登录</button>}</div>
      {!data.accounts.length && <div className="collector-empty"><strong>添加第一个公众号</strong><p>打开“公众号与登录”，粘贴一篇文章链接，或从微信读书书架选择。</p><button className="secondary-button" onClick={() => setManager(true)}>添加公众号</button></div>}
      <div className="collector-range"><div className="weekly-transfer-dates"><label>开始日期<input aria-label="开始日期" type="date" value={range.startDate} disabled={locked} onChange={(event) => onRangeChange({ startDate: event.target.value })} /></label><span>—</span><label>结束日期<input aria-label="结束日期" type="date" value={range.endDate} disabled={locked} onChange={(event) => onRangeChange({ endDate: event.target.value })} /></label></div><button className="text-button" disabled={locked} onClick={() => onRangeChange(lastCompleteWeek())}>上一完整周</button></div>
      <p className="weekly-date-hint">{dateError || "包含起止两天 · 北京时间"}</p>
      <div className="collector-actions"><button className="primary-button" disabled={locked || !enabled.length || !!dateError || !!collectionLimit} onClick={() => void act("collect", { start_date: range.startDate, end_date: range.endDate })}>采集正文并打包</button><button className="secondary-button" disabled={locked || !enabled.length || !data.has_index || !!dateError} onClick={() => void act("export", { start_date: range.startDate, end_date: range.endDate })}>导出已有资料</button></div>
      {collectionLimit && <p className="collector-hint" role="status">{collectionLimit}</p>}
    </>}
    {job && <div className={`collector-job ${job.state}`} role="status" aria-live="polite"><div><strong>{running ? job.state === "cancelling" ? "正在停止" : "正在处理" : job.result?.code === "verification" ? "等待完成验证" : job.state === "complete" ? "已完成" : "本次操作未完成"}</strong><span>{job.message}</span></div>
      {running && job.total > 0 && <progress value={job.completed} max={job.total} aria-label="采集进度" />}
      {running && <button className="text-button" disabled={job.state === "cancelling"} onClick={() => void cancel()}>停止任务</button>}
      {job.result?.code === "verification" && <button className="text-button" disabled={locked || !data?.browser_available} onClick={() => void act("open-browser")}>重新打开验证页面</button>}
      {resumable && <button className="secondary-button" disabled={locked} onClick={() => void act("resume", { job_id: resumeJob.id })}>继续上次任务</button>}</div>}
    {!!data?.exports.length && <div className="collector-exports"><div className="collector-section-head"><h4>已生成的资料</h4><span>可直接下载，无需再次采集</span></div>{data.exports.map((archive) => <article key={archive.id}>
      <div><strong>{archive.start_date} — {archive.end_date}</strong><p>{archive.body_count}/{archive.article_count} 篇正文 · {archive.image_count} 张配图 · {(archive.size / 1024 / 1024).toFixed(1)} MB</p>{!archive.complete && <span className="collector-incomplete">含缺失项</span>}</div>
      <div className="collector-downloads"><a className="primary-button" href={downloadUrl(archive.id, "zip")} download>{archive.complete ? "下载资料 ZIP" : "下载现有资料 ZIP"}</a><a className="secondary-button" href={downloadUrl(archive.id, "text")} download>下载纯文字</a></div>
      {!!archive.issues.length && <details><summary>查看缺失清单</summary>{archive.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</details>}</article>)}</div>}
    <p className="collector-footnote">微信读书可能延迟或遗漏收录。资料包保留原文链接和缺失清单；图片中的文字未做 OCR。</p>
    {manager && <ModalDialog close={() => setManager(false)} label="公众号与登录">{(dismiss) => <section className="collector-manager">
      <header className="rss-manager-header"><div><h2>公众号与登录</h2><p>使用系统默认浏览器{data?.browser_name ? `（${data.browser_name}）` : ""}的独立采集会话，登录资料只保存在本机。</p></div><button className="small-button" onClick={dismiss}>关闭</button></header>
      <section><h3>微信读书登录</h3><p>{data?.session.message}</p><div className="collector-actions"><button className="primary-button" disabled={locked || !data?.browser_available} onClick={() => void act("login")}>{data?.login && ["expired", "failed", "cancelled"].includes(data.login.state) ? "重新获取二维码" : "扫码登录"}</button><button className="secondary-button" disabled={locked} onClick={() => void act("check")}>检查登录</button></div>
        {data?.login && <div className={`collector-qr ${data.login.state}`}>
          {data.login.qr_available && data.login.state === "waiting" && <img src={`/local-api/collector/login-qr?id=${encodeURIComponent(data.login.id)}&v=${data.login.revision}`} alt="微信读书登录二维码" width={240} height={240} />}
          <p role="status">{data.login.message}</p>
          {running && job?.action === "login" && <button className="text-button" disabled={job.state === "cancelling"} onClick={() => void cancel()}>停止扫码</button>}
        </div>}
        <p className="collector-hint">用微信扫描这里的二维码，手机确认后自动完成登录。遇到人机验证时会自动打开默认浏览器，完成后回到这里检查登录或继续任务。</p>
        <button className="text-button" disabled={locked || !data?.browser_available} onClick={() => void act("open-browser")}>用默认浏览器登录或验证</button>
        {sessionReady && <button className="text-button" disabled={locked} onClick={() => { if (window.confirm("清除本机采集浏览器的登录授权？订阅和已下载文章会保留。")) void act("logout"); }}>清除本机授权</button>}</section>
      <section><h3>添加公众号</h3><form className="collector-link-form" onSubmit={(event) => { event.preventDefault(); void act("resolve", { url: link.trim() }); }}><label htmlFor="collector-article-link">公众号文章链接</label><div><input id="collector-article-link" type="url" value={link} onChange={(event) => setLink(event.target.value)} placeholder="粘贴该公众号的一篇文章链接" required /><button className="secondary-button" disabled={locked || !link.trim()}>添加公众号</button></div></form>
        <button className="text-button" disabled={locked} onClick={() => void act("shelf")}>读取微信读书书架</button>
        {!!books.length && <div className="collector-shelf">{books.filter((book) => !data?.accounts.some((account) => account.bookId === book.bookId)).map((book) => <button key={book.bookId} className="small-button" disabled={locked} onClick={() => void act("add", { bookId: book.bookId })}>添加 {book.name}</button>)}</div>}</section>
      <section><div className="collector-section-head"><h3>已添加的公众号</h3><span>{data?.accounts.length || 0}</span></div>
        {!!data?.accounts.length && <input className="text-input" aria-label="搜索订阅公众号" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索公众号" />}
        <div className="collector-account-list">{visibleAccounts.map((account) => <article key={account.bookId}><div><strong>{account.name}</strong><span>{account.enabled ? "参与采集" : "已暂停"}</span></div><button className="small-button" disabled={locked} onClick={() => void act("update", { bookId: account.bookId, operation: account.enabled ? "pause" : "resume" })}>{account.enabled ? "暂停" : "启用"}</button><button className="text-button" disabled={locked} aria-label={`移除 ${account.name}`} onClick={() => void act("update", { bookId: account.bookId, operation: "remove" })}>移除</button></article>)}</div>
        {!data?.accounts.length && <p>暂无订阅，添加后即可按日期采集。</p>}</section>
      {job && <p className="collector-message" role="status">{job.message}</p>}{error && <p role="alert">{error}</p>}
      {data && <p className="collector-hint">今日请求 {data.quota.used}/{data.quota.max || "不限"} · 目录采集 {data.quota.runs}/{data.quota.max_runs || "不限"} 次。缓存读取不消耗请求预算。</p>}
    </section>}</ModalDialog>}
  </section>;
}
