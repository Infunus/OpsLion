"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { requestJson } from "./request";

export interface RssAuthorization {
  state: "authorized" | "expired" | "unverified" | "logged_out";
  authenticated: boolean;
  message: string;
  nickname?: string;
  expires_at?: number;
}
interface Subscription { id: string; mp_name: string; alias: string; status: number; article_count: number }
interface Management { auth: RssAuthorization; feeds: Subscription[]; collecting: boolean }
interface Login {
  state: "waiting" | "scanned" | "authorized" | "expired" | "cancelled" | "blocked";
  session_id?: string; qr_data_url?: string; expires_at?: number; message?: string; auth?: RssAuthorization;
}
interface Candidate { candidate_id: string; mp_name: string; alias: string; article_title: string; subscribed: boolean; feed_id?: string }
const post = <T,>(operation: string, payload: object = {}, signal?: AbortSignal) => requestJson<T>(`/local-api/rss/${operation}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal, timeoutMs: 35_000,
});
const expiryLabel = (stamp?: number) => stamp ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(stamp*1000) : "";

export function RssManagement({ close, onChanged, collecting }: { close: () => void; onChanged: (removedId?: string) => void; collecting: boolean }) {
  const [data, setData] = useState<Management | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [login, setLogin] = useState<Login | null>(null);
  const [url, setUrl] = useState("");
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [search, setSearch] = useState("");
  const controller = useRef<AbortController | null>(null);
  const pendingId = useRef<string | undefined>(undefined);
  const busyRef = useRef(false);
  const resolveGeneration = useRef(0);
  const requestGeneration = useRef(0);
  const locked = collecting || Boolean(data?.collecting);
  const waiting = login?.state === "waiting" || login?.state === "scanned";

  const reload = useCallback(async (signal?: AbortSignal) => {
    const token = ++requestGeneration.current;
    const next = await requestJson<Management>("/local-api/rss/management", { signal });
    if (token === requestGeneration.current && !signal?.aborted) setData(next);
  }, []);

  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    void reload(current.signal).catch((reason) => { if (!current.signal.aborted) setError(reason.message); });
    return () => {
      current.abort();
      requestGeneration.current += 1;
      const sid = pendingId.current;
      if (sid) void post("auth/cancel", { session_id: sid }).catch(() => {});
    };
  }, [reload]);

  useEffect(() => {
    if (!waiting || !login?.session_id) return;
    const sid = login.session_id;
    const current = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await requestJson<Login>(`/local-api/rss/auth/poll?session_id=${encodeURIComponent(sid)}`, { signal: current.signal, timeoutMs: 35_000 });
        if (current.signal.aborted) return;
        setLogin((previous) => ({ ...previous, ...next }));
        setError("");
        if (next.state === "authorized") {
          pendingId.current = undefined;
          if (next.auth) setData((previous) => previous ? { ...previous, auth: next.auth! } : previous);
          setMessage("公众号授权成功");
          onChanged();
          void reload(controller.current?.signal).catch((reason) => {
            if (!controller.current?.signal.aborted) setError(reason.message);
          });
          return;
        }
        if (next.state !== "waiting" && next.state !== "scanned") { pendingId.current = undefined; return; }
      } catch (reason) {
        if (current.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "暂时无法读取授权状态");
      }
      timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => { clearTimeout(timer); current.abort(); };
  }, [waiting, login?.session_id, onChanged, reload]);

  const run = async (name: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(name); setError(""); setMessage("");
    try { await action(); }
    catch (reason) { if (!controller.current?.signal.aborted) setError(reason instanceof Error ? reason.message : "操作失败，请重试"); }
    finally { busyRef.current = false; if (!controller.current?.signal.aborted) setBusy(""); }
  };
  const beginLogin = () => run("login", async () => {
    setLogin(null);
    const result = await post<Login>("auth/start", { renew: true }, controller.current?.signal);
    pendingId.current = result.session_id;
    if (controller.current?.signal.aborted) {
      if (result.session_id) void post("auth/cancel", { session_id: result.session_id }).catch(() => {});
      return;
    }
    setLogin(result);
  });
  const checkLogin = () => run("check", async () => {
    const auth = await post<RssAuthorization>("auth/check", {}, controller.current?.signal);
    setData((current) => current ? { ...current, auth } : current);
    onChanged();
  });
  const logout = () => run("logout", async () => {
    const auth = await post<RssAuthorization>("auth/logout", {}, controller.current?.signal);
    pendingId.current = undefined; setLogin(null);
    setData((current) => current ? { ...current, auth } : current);
    setMessage("本机授权已清除，订阅和文章已保留"); onChanged();
  });
  const resolve = () => run("resolve", async () => {
    const generation = ++resolveGeneration.current;
    setCandidate(null);
    const result = await post<Candidate>("feeds/resolve", { url: url.trim() }, controller.current?.signal);
    if (generation === resolveGeneration.current) setCandidate(result);
  });
  const add = () => candidate && run("add", async () => {
    const result = await post<{ already_subscribed: boolean }>("feeds/add", { candidate_id: candidate.candidate_id }, controller.current?.signal);
    setCandidate(null); setUrl("");
    setMessage(result.already_subscribed ? "这个公众号已经订阅" : "公众号已添加");
    await reload(controller.current?.signal); onChanged();
  });
  const update = (feed: Subscription, action: "pause" | "resume" | "remove") => run(feed.id, async () => {
    await post("feeds/update", { id: feed.id, action }, controller.current?.signal);
    setMessage(action === "remove" ? "订阅已移除，已采集文章保留；再次添加链接可恢复订阅" : action === "pause" ? "已暂停采集这个公众号" : "已恢复订阅");
    await reload(controller.current?.signal); onChanged(action === "remove" ? feed.id : undefined);
  });
  const query = search.trim().toLocaleLowerCase();
  const visible = data?.feeds.filter((feed) => `${feed.mp_name} ${feed.alias}`.toLocaleLowerCase().includes(query)) || [];
  const qr = login?.qr_data_url && /^data:image\/(png|jpeg);base64,[a-z\d+/=]+$/i.test(login.qr_data_url) ? login.qr_data_url : "";

  return <ModalDialog close={close} label="公众号与授权">{(dismiss) => <section className="rss-manager">
    <header className="rss-manager-header"><div><h2>公众号与授权</h2><p>管理采集授权和订阅的公众号</p></div><button className="small-button" onClick={dismiss} aria-label="关闭公众号管理">关闭</button></header>
    {error && <div className="rss-manager-message error" role="alert">{error}<button className="text-button" disabled={!!busy} onClick={() => void run("reload", () => reload(controller.current?.signal))}>重新连接</button></div>}
    {message && <p className="rss-manager-message" role="status">{message}</p>}
    {locked && <p className="rss-manager-message">采集进行中，停止采集后可更改授权和订阅。</p>}
    <div className="rss-manager-columns">
      <section className="rss-auth-panel" aria-label="公众号授权">
        <div className="rss-manager-section-head"><h3>公众号授权</h3><span className={data?.auth.authenticated ? "rss-badge active" : "rss-badge"}>{data?.auth.authenticated ? "已授权" : data?.auth.state === "expired" ? "已过期" : "未授权"}</span></div>
        <p className="rss-auth-description">按 RSS 模块要求，使用具备授权资格的微信扫码，并在手机上确认。</p>
        {data?.auth.nickname && <strong>{data.auth.nickname}</strong>}
        <p className="rss-auth-state">{data?.auth.message || "正在读取授权状态…"}</p>
        {data?.auth.expires_at && <p className="rss-auth-expiry">有效期至 {expiryLabel(data.auth.expires_at)}</p>}
        <div className="rss-auth-actions"><button className="primary-button" disabled={!!busy || locked || !data} onClick={() => void beginLogin()}>{busy === "login" ? "正在获取二维码…" : login || data?.auth.authenticated ? "重新扫码授权" : "扫码授权"}</button>{data && data.auth.state !== "logged_out" && <button className="text-button" disabled={!!busy} onClick={() => void checkLogin()}>{busy === "check" ? "检查中…" : "检查授权"}</button>}</div>
        {login && <div className="rss-login-state" role="status">
          {/* The ephemeral data URL must stay local and bypass any image optimization service. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {waiting && qr && <img src={qr} width={216} height={216} alt="微信公众号授权二维码" />}
          <p>{login.state === "waiting" ? "请用微信扫一扫" : login.state === "scanned" ? "已扫码，请在手机上确认" : login.state === "authorized" ? "授权成功" : login.message || "二维码已失效，请重新获取"}</p>
          {waiting && <button className="text-button" disabled={!!busy} onClick={() => void run("cancel", async () => { await post("auth/cancel", { session_id: login.session_id }, controller.current?.signal); pendingId.current = undefined; setLogin(null); })}>取消本次扫码</button>}
        </div>}
        {data && data.auth.state !== "logged_out" && <button className="text-button rss-logout" disabled={!!busy || locked} onClick={() => void logout()}>清除本机授权</button>}
        <p className="rss-privacy-note">授权加密保存在这台电脑上，清除授权会保留订阅与文章。</p>
      </section>
      <section className="rss-subscription-panel" aria-label="订阅管理">
        <div className="rss-manager-section-head"><h3>订阅的公众号</h3><span>{data?.feeds.length ?? "—"}</span></div>
        <form className="rss-link-form" onSubmit={(event) => { event.preventDefault(); void resolve(); }}>
          <label htmlFor="rss-article-link">通过推文链接添加</label>
          <div><input id="rss-article-link" type="url" value={url} placeholder="粘贴公众号的一篇推文链接" onChange={(event) => { setUrl(event.target.value); setCandidate(null); resolveGeneration.current += 1; }} required /><button className="secondary-button" disabled={!!busy || locked || !url.trim() || !data}>{busy === "resolve" ? "正在识别…" : "识别公众号"}</button></div>
        </form>
        {candidate && <div className="rss-candidate"><strong>{candidate.mp_name}</strong>{candidate.alias && <span>{candidate.alias}</span>}<p>{candidate.article_title || "已从推文识别公众号"}</p><button className="primary-button" disabled={!!busy || locked || candidate.subscribed} onClick={() => void add()}>{candidate.subscribed ? "已订阅" : busy === "add" ? "正在添加…" : "添加订阅"}</button></div>}
        {!!data?.feeds.length && <input className="text-input rss-subscription-search" aria-label="搜索已订阅公众号" placeholder="搜索已订阅的公众号" value={search} onChange={(event) => setSearch(event.target.value)} />}
        <div className="rss-subscriptions">{visible.map((feed) => <article key={feed.id}>
          <div className="rss-subscription-name"><strong>{feed.mp_name}</strong><span className={feed.status === 1 ? "rss-badge active" : "rss-badge"}>{feed.status === 1 ? "已启用" : "已暂停"}</span><p>{feed.alias && `${feed.alias} · `}{feed.article_count} 篇文章</p></div>
          <div className="rss-subscription-actions"><button className="small-button" aria-label={`${feed.status === 1 ? "暂停" : "恢复"} ${feed.mp_name}`} disabled={!!busy || locked} onClick={() => void update(feed, feed.status === 1 ? "pause" : "resume")}>{feed.status === 1 ? "暂停" : "恢复"}</button><button className="text-button" aria-label={`移除 ${feed.mp_name}`} disabled={!!busy || locked} onClick={() => void update(feed, "remove")}>移除</button></div>
        </article>)}</div>
        {data && !visible.length && <p className="rss-manager-empty">{search ? "没有匹配的订阅" : "暂无订阅，粘贴推文链接添加第一个公众号。"}</p>}
      </section>
    </div>
  </section>}</ModalDialog>;
}
