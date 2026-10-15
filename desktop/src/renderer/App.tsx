import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FIELD_LABEL, isDiscordWebhook, LOGIN_LOG_PREFIX, loginLog, MODE_LABEL, PAYMENT_PIN_DIGITS, pinMatters, planDrop, PREPARE_LOG,
  REPEATING_MODES, SITE_IDS, SITES, siteLog, siteOfUrl, TIMING_BLANK,
} from "../shared/sites";
import type {
  DropSettings, LoginStatus, LogLine, MonitorEntry, MonitorFound, MonitorStatus, OrderAction, Profile, Settings, SiteId, SiteInfo,
  TaskDef, TaskMode, TaskRuntime, TaskStatus, TimingDefaults,
} from "../shared/types";
import { FoundAlerts, MONITOR_LOG, MonitorsPage } from "./Monitors";
import { SupremeOrderPage } from "./SupremeOrder";
import {
  SUPREME_CATEGORIES, describeSupremeCategories, describeSupremeOption, hasSupremeKeyword, isSupremeProductUrl,
  joinSupremeOption, splitSupremeOption, supremeCategories, supremeKeywords, withSupremeCategory,
} from "../shared/supremeSpec";

const aio = window.aio;

/** ipcRenderer.invoke 가 붙이는 앞머리를 뗀 오류 문구. */
export function errText(e: unknown): string {
  return (e as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  idle: "대기",
  scheduled: "예약",
  starting: "시작 중",
  running: "실행 중",
  stopping: "멈추는 중",
  done: "완료",
  failed: "실패",
  stopped: "멈춤",
  crashed: "터짐",
};

export const LIVE: TaskStatus[] = ["starting", "running", "stopping"];

export const LOGIN_LABEL: Record<LoginStatus, string> = {
  logged_out: "미로그인",
  logging_in: "로그인 중",
  logged_in: "로그인됨",
  expired: "만료",
  error: "확인 못 함",
};

type View = "tasks" | "monitors" | "profiles" | "supreme-order";

/** 새 태스크가 처음 고를 프로필 — 그 사이트에서 로그인된 것, 없으면 아무거나. */
/**
 * 이 태스크의 결제 비밀번호가 어느 프로필에서 오나 (main TaskManager.launch 와 같은 순서). 결제창 로그인 프로필
 * (반다이남코 네이버페이 → 네이버 프로필)이 먼저다 — 네이버페이 비밀번호는 네이버 계정의 것이다.
 *   from  비밀번호를 줄 프로필. 없으면 null
 *   ask   비밀번호가 없을 때 넣으라고 할 프로필 (결제창 로그인 프로필이 있으면 그것)
 */
function pinSource(t: TaskDef, profiles: Profile[]): { from: Profile | null; ask: Profile | null } {
  const login = profiles.find((p) => p.id === t.profileId) ?? null;
  const pay = SITES[t.site].payProfileSite ? profiles.find((p) => p.id === t.payProfileId) ?? null : null;
  return { from: pay?.hasPaymentPin ? pay : login?.hasPaymentPin ? login : null, ask: pay ?? login };
}

function defaultProfile(profiles: Profile[], site: SiteId): string | undefined {
  const mine = profiles.filter((p) => p.site === site && p.isActive);
  return (mine.find((p) => p.loginStatus === "logged_in") ?? mine[0])?.id;
}

/**
 * 이 태스크의 로그인에 걸리는 것 (알림 🔔·표에 한 줄). 프로필이 없거나 지워졌으면 TaskManager 가 띄우지 않고,
 * 미로그인·만료면 원본이 세션을 거절한다. 문제가 없으면 null.
 */
function loginIssue(t: TaskDef, profiles: Profile[]): string | null {
  if (!t.profileId) return SITES[t.site].loginOptional.includes(t.mode) ? null : "로그인 프로필 없음";
  const p = profiles.find((one) => one.id === t.profileId);
  if (!p) return "프로필이 지워짐";
  if (p.loginStatus === "logged_in" || p.loginStatus === "logging_in") return null;
  return `${p.name} ${LOGIN_LABEL[p.loginStatus]}`;
}

/** 모니터가 프로세스를 들고 있는 상태 — 그 프로필을 쓰고 있다. */
const MONITOR_LIVE: MonitorStatus[] = ["monitoring", "found", "stopping"];

/**
 * 이 프로필로 지금 도는 태스크·모니터 ("태스크 #03 운동화 270" · "모니터 운동화 270"). 번호는 태스크 목록의 순서다.
 *   except     이 태스크는 빼고 (폼·표에서 제 태스크)
 *   scheduled  예약된 태스크도 (프로필 카드 — 예약도 프로필을 붙잡고 있어 지우기·끄기가 막힌다)
 */
function profileUsers(
  profileId: string, tasks: TaskDef[], runtimes: Record<string, TaskRuntime>, monitors: MonitorEntry[],
  opts: { except?: string; scheduled?: boolean } = {},
): string[] {
  const out: string[] = [];
  tasks.forEach((t, i) => {
    const pay = t.payProfileId === profileId;
    if ((t.profileId !== profileId && !pay) || t.id === opts.except) return;
    const status = runtimes[t.id]?.status ?? "idle";
    const live = LIVE.includes(status);
    if (!live && !(opts.scheduled && status === "scheduled")) return;
    out.push(`태스크 #${String(i + 1).padStart(2, "0")} ${t.label || SITES[t.site].productCode(t.url)}${pay ? " (결제 로그인)" : ""}${live ? "" : " (예약)"}`);
  });
  for (const m of monitors) {
    if (m.def.profileId === profileId && MONITOR_LIVE.includes(m.state.status)) out.push(`모니터 ${m.def.name}`);
  }
  return out;
}

/** 클립보드에 적는다. → 됐나 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 표에 보일 짧은 링크 — 앞의 https://www. 와 뒤의 ?꼬리를 뗀다 (복사는 전체를). 주소가 아니면(롯데 상품번호) 그대로. */
export function shortLink(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.hostname.replace(/^www\./, "")}${u.pathname}`;
  } catch {
    return url.trim();
  }
}

/** 짧은 날짜·시각. 오늘이면 시각만. */
export function when(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

type Filter = SiteId | "all";

function blankTask(site: SiteId, profileId: string | undefined, payProfileId?: string): TaskDef {
  return {
    id: crypto.randomUUID().slice(0, 8),
    site, ...(profileId ? { profileId } : {}), ...(payProfileId ? { payProfileId } : {}), label: "", url: "", option: "", ea: 1, max_price: 0, mode: "watch", action: "",
    ...TIMING_BLANK,
  };
}

/** 초·분을 짧게. 3000 → "3초", 90000 → "1.5분". */
export function span(ms: number): string {
  if (ms >= 60_000) {
    const m = ms / 60_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}분`;
  }
  const sec = ms / 1000;
  return `${Number.isInteger(sec) ? sec : sec.toFixed(1)}초`;
}

/** 표의 모드 아래에 붙는 한 줄 — 씨앗 설정과 다르게 정한 것만. */
function timingSummary(t: TaskDef): string {
  const parts: string[] = [];
  const repeating = REPEATING_MODES.includes(t.mode);
  if (repeating && t.checkIntervalMs !== null) parts.push(`${span(t.checkIntervalMs)}마다`);
  if (repeating && t.monitorDurationMs > 0) parts.push(`${span(t.monitorDurationMs)} 동안`);
  if (t.maxRetries !== null) parts.push(`재시도 ${t.maxRetries}`);
  if (t.stopOnSuccess === false) parts.push(`최대 ${t.maxBuys}번 삼`);
  if (t.mode === "drop") {
    const d = t.dropSettings;
    if (d.dropTime) parts.unshift(`${d.dropTime} 드랍 · ${d.preCheckMinutes}분 전`);
    if (d.intervalMs !== null) parts.push(`드랍 ${span(d.intervalMs)}마다`);
  }
  return parts.join(" · ");
}

/**
 * 있는 줄 뒤에 새 줄을 잇는다. 번호(seq)로 겹친 것을 거른다 — 받아 온 목록과 흘러온 줄은 겹칠 수 있다.
 * 거르는 기준은 화면에 이미 있는 마지막 번호다 (따로 들고 있는 번호는 상태 갱신보다 늦을 수 있다).
 */
export function mergeLogs(have: LogLine[], more: LogLine[]): LogLine[] {
  const last = have.at(-1)?.seq ?? 0;
  const fresh = more.filter((l) => l.seq > last);
  return fresh.length ? [...have, ...fresh] : have;
}

export function idleRuntime(id: string): TaskRuntime {
  return {
    id, status: "idle", pid: null, startedAt: null, endedAt: null, exitCode: null, lastLine: "",
    note: "", rounds: 0, lastCheckAt: null, phase: null, queue: null, restartPending: false, scheduledFor: null, dropAt: null,
  };
}

function actionLabel(t: TaskDef): string {
  // 고를 것이 없는 사이트(슈프림)는 결제 버튼까지 간다.
  if (!SITES[t.site].actions.length) return "결제 버튼까지";
  return t.action ? SITES[t.site].actionLabel[t.action] : "설정 따름";
}

/** 표·태스크 창의 상품 칸 — 슈프림 키워드는 키워드를 이름으로, 카테고리·색·사이즈를 아래 줄로. */
export function targetText(t: TaskDef): { name: string; sub: string } {
  const code = SITES[t.site].productCode(t.url);
  if (t.site === "supreme" && t.url.trim() && !isSupremeProductUrl(t.url)) {
    return {
      name: t.label || supremeKeywords(t.url) || code,
      sub: [`카테고리 ${describeSupremeCategories(t.url)}`, describeSupremeOption(t.option)].filter(Boolean).join(" · "),
    };
  }
  const option = t.site === "supreme" ? describeSupremeOption(t.option) : t.option;
  return { name: t.label || code, sub: [code, option].filter(Boolean).join(" · ") };
}

function clock(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function uptime(rt: TaskRuntime, now: number): string {
  if (!rt.startedAt) return "—";
  const sec = Math.max(0, Math.floor(((rt.endedAt ?? now) - rt.startedAt) / 1000));
  const m = Math.floor(sec / 60);
  return m ? `${m}m ${sec % 60}s` : `${sec}s`;
}

export function App() {
  const [tasks, setTasks] = useState<TaskDef[]>([]);
  const [runtimes, setRuntimes] = useState<Record<string, TaskRuntime>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [editing, setEditing] = useState<TaskDef | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infos, setInfos] = useState<SiteInfo[]>([]);
  const [preparing, setPreparing] = useState<SiteId | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [view, setView] = useState<View>("tasks");
  const [monitors, setMonitors] = useState<MonitorEntry[]>([]);
  /** 메인 창 위에 뜨는 재고 발견 알림 — 모니터마다 마지막 것 하나. 닫으면 알림만 치운다. */
  const [foundAlerts, setFoundAlerts] = useState<MonitorFound[]>([]);
  const [now, setNow] = useState(Date.now());
  /** 결제 비밀번호 창을 연 프로필. */
  const [pinFor, setPinFor] = useState<string | null>(null);
  /** ▶ 를 눌렀는데 결제 비밀번호가 쓰일 태스크의 프로필에 비밀번호가 없다 — 묻는 중. */
  const [pinAsk, setPinAsk] = useState<{ task: TaskDef; profile: Profile } | null>(null);
  /** 방금 링크를 복사한 태스크 — 그 칸에 잠깐 "복사했습니다" 를 보인다. */
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const off = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(off);
  }, [copied]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const refreshInfo = useCallback(() => void aio.sitesInfo().then(setInfos), []);
  /** 새로 생긴 프로필은 끝에 붙이고, 있던 것은 그 자리에서 바꾼다. */
  const upsertProfile = useCallback((p: Profile) => {
    setProfiles((prev) => (prev.some((one) => one.id === p.id) ? prev.map((one) => (one.id === p.id ? p : one)) : [...prev, p]));
  }, []);
  /** 모니터도 같다 — 새것은 끝에, 있던 것은 그 자리에서. */
  const upsertMonitor = useCallback((e: MonitorEntry) => {
    setMonitors((prev) => (prev.some((one) => one.def.id === e.def.id) ? prev.map((one) => (one.def.id === e.def.id ? e : one)) : [...prev, e]));
  }, []);
  const dismissFound = useCallback((monitorId: string) => setFoundAlerts((prev) => prev.filter((f) => f.monitorId !== monitorId)), []);

  useEffect(() => {
    void aio.listTasks().then(setTasks);
    void aio.runtimes().then((list) => setRuntimes(Object.fromEntries(list.map((r) => [r.id, r]))));
    void aio.listProfiles().then(setProfiles);
    void aio.monitor.list().then(setMonitors);
    refreshInfo();
    const offRt = aio.onRuntime((rt) => setRuntimes((prev) => ({ ...prev, [rt.id]: rt })));
    const offProfile = aio.onProfile(upsertProfile);
    // 모니터에서 구매로 전환한 태스크처럼, 이 창 밖에서 바뀐 태스크 목록도 따라간다.
    const offTasks = aio.onTasks(setTasks);
    const offLogs = aio.onLogs((batch) => {
      const mine = batch.filter((l) => l.taskId === selectedRef.current);
      if (mine.length) setLogs((prev) => mergeLogs(prev, mine).slice(-2000));
    });
    // 모니터 — 목록·로그 패널·재고 발견 알림
    const offMonitor = aio.monitor.onUpdate(upsertMonitor);
    const offMonitorLogs = aio.monitor.onLog((batch) => {
      const sel = selectedRef.current;
      if (!sel?.startsWith(MONITOR_LOG)) return;
      const mine = batch.filter((l) => l.taskId === sel.slice(MONITOR_LOG.length));
      if (mine.length) setLogs((prev) => mergeLogs(prev, mine).slice(-2000));
    });
    const offFound = aio.monitor.onFound((f) => setFoundAlerts((prev) => [...prev.filter((one) => one.monitorId !== f.monitorId), f]));
    const offRemoved = aio.monitor.onRemoved((id) => {
      setMonitors((prev) => prev.filter((m) => m.def.id !== id));
      dismissFound(id);
    });
    // 구매로 전환했다 (이 창이든 모니터 창이든) — 알림을 치우고 태스크 화면에서 그 태스크의 로그를 보인다.
    const offSwitched = aio.monitor.onSwitched(({ monitorId, taskId }) => {
      dismissFound(monitorId);
      setView("tasks");
      setSelected(taskId);
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      offRt();
      offProfile();
      offTasks();
      offLogs();
      offMonitor();
      offMonitorLogs();
      offFound();
      offRemoved();
      offSwitched();
      clearInterval(tick);
    };
  }, [refreshInfo, upsertProfile, upsertMonitor, dismissFound]);

  useEffect(() => {
    setLogs([]);
    if (!selected) return;
    let current = true;
    const monitorId = selected.startsWith(MONITOR_LOG) ? selected.slice(MONITOR_LOG.length) : null;
    void (monitorId ? aio.monitor.getLogs(monitorId) : aio.logs(selected)).then((list) => {
      // 그 사이에 다른 것을 골랐으면 늦게 온 목록은 버린다.
      // 받아 오는 사이에 흘러온 줄이 이미 붙어 있을 수 있다. 번호로 이어 붙인다.
      if (current) setLogs((streamed) => mergeLogs(list, streamed));
    });
    return () => {
      current = false;
    };
  }, [selected]);

  const rtOf = (id: string) => runtimes[id] ?? idleRuntime(id);
  const shown = filter === "all" ? tasks : tasks.filter((t) => t.site === filter);
  const counts = useMemo(() => {
    const c = { live: 0, done: 0, bad: 0, scheduled: 0 };
    for (const t of tasks) {
      const s = (runtimes[t.id] ?? idleRuntime(t.id)).status;
      if (LIVE.includes(s)) c.live++;
      else if (s === "scheduled") c.scheduled++;
      else if (s === "done") c.done++;
      else if (s === "failed" || s === "crashed") c.bad++;
    }
    return c;
  }, [tasks, runtimes]);
  const perSite = (id: SiteId) => tasks.filter((t) => t.site === id).length;

  const saveTask = async (t: TaskDef) => {
    setTasks(await aio.saveTask(t));
    setEditing(null);
  };

  const removeTask = async (t: TaskDef) => {
    if (!(await aio.ask(`'${t.label || SITES[t.site].productCode(t.url)}' 태스크를 지울까요? (돌고 있으면 멈춥니다)`))) return;
    setTasks(await aio.deleteTask(t.id));
    if (selected === t.id) setSelected(null);
  };

  const prepare = async (site: SiteId) => {
    setPreparing(site);
    setSelected(PREPARE_LOG);
    try {
      await aio.prepareSite(site);
    } finally {
      setPreparing(null);
      refreshInfo();
    }
  };

  /** 로그인 창을 띄우고 그 프로필의 로그를 보여 준다. */
  const login = (id: string) => {
    setSelected(loginLog(id));
    void aio.loginProfile(id).catch(() => undefined);
  };

  // 태스크의 로그인에 걸리는 것 (프로필이 없다·만료 …). 사이트마다 모아 알림(🔔)에 올린다.
  const issues = tasks.map((t) => ({ t, issue: loginIssue(t, profiles) })).filter((x) => x.issue);
  const issueLines = (site: SiteId) => [...new Set(issues.filter((x) => x.t.site === site).map((x) => x.issue!))];
  // 태스크가 있는 사이트만 알림에 올린다. 안 쓰는 사이트의 준비 상태로 알림을 채우지 않는다.
  const alerts = infos.filter((i) => perSite(i.site) > 0 && (i.problems.length || i.warnings.length || issueLines(i.site).length));
  const selectedTask = tasks.find((t) => t.id === selected);
  const selectedProfile = selected?.startsWith(LOGIN_LOG_PREFIX) ? profiles.find((p) => loginLog(p.id) === selected) : undefined;
  const selectedSite = SITE_IDS.find((id) => siteLog(id) === selected);
  const selectedMonitor = selected?.startsWith(MONITOR_LOG) ? monitors.find((m) => MONITOR_LOG + m.def.id === selected) : undefined;
  /** 모니터에서 구매 태스크로 넘겼다 — 태스크 화면으로 가서 그 태스크의 로그를 보인다. */
  const onSwitched = (monitorId: string, taskId: string) => {
    dismissFound(monitorId);
    setView("tasks");
    setSelected(taskId);
  };
  const profileOf = (id: string | undefined) => (id ? profiles.find((p) => p.id === id) : undefined);
  /**
   * ▶ 하나. 결제 비밀번호가 쓰일 태스크(사는 모드 + 결제 단계까지)인데 프로필에 비밀번호가 없으면 먼저 묻는다.
   * "전부 시작" 은 묻지 않는다 — main 이 태스크 로그에 적는다.
   */
  const startOne = (t: TaskDef) => {
    const { from, ask } = pinSource(t, profiles);
    const info = infos.find((i) => i.site === t.site);
    if (!from && ask && info && pinMatters(t, info.defaultAction)) return setPinAsk({ task: t, profile: ask });
    void aio.start(t.id);
  };
  const pinProfile = profileOf(pinFor ?? undefined);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" /> AIO <b>Task Manager</b>
        </div>
        <div className="stats">
          <Stat label="태스크" value={tasks.length} />
          <Stat label="실행 중" value={counts.live} tone="live" />
          <Stat label="완료" value={counts.done} tone="ok" />
          <Stat label="실패" value={counts.bad} tone="bad" />
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => {
            const site = filter === "all" ? "lotte" : filter;
            const paySite = SITES[site].payProfileSite;
            setEditing(blankTask(site, defaultProfile(profiles, site), paySite ? defaultProfile(profiles, paySite) : undefined));
          }}>+ 태스크</button>
          <button className="btn go" disabled={!tasks.length} onClick={() => void aio.startAll()}>▶ 전부 시작</button>
          <button className="btn stop" disabled={!counts.live && !counts.scheduled} onClick={() => void aio.stopAll()}>■ 전부 멈춤</button>
          <button className="btn ghost" onClick={() => setSettingsOpen(true)}>설정</button>
          <NoticeBell
            alerts={alerts} issueLines={issueLines} preparing={preparing}
            onPrepare={(site) => void prepare(site)} onProfiles={view === "profiles" ? null : () => setView("profiles")}
          />
        </div>
      </header>

      <FoundAlerts alerts={foundAlerts} monitors={monitors} profiles={profiles} onSwitched={onSwitched} onDismiss={dismissFound} />


      <div className="body">
        <nav className="sidebar">
          <button type="button" className={`side-item ${view === "tasks" ? "on" : ""}`} onClick={() => setView("tasks")}>
            <span>태스크</span><span className="count">{tasks.length}</span>
          </button>
          <button type="button" className={`side-item ${view === "monitors" ? "on" : ""}`} onClick={() => setView("monitors")}>
            <span>모니터{monitors.some((m) => m.state.status === "found") && <span className="found-dot" title="재고를 발견한 모니터가 있습니다" />}</span>
            <span className="count">{monitors.length}</span>
          </button>
          <button type="button" className={`side-item ${view === "profiles" ? "on" : ""}`} onClick={() => setView("profiles")}>
            <span>프로필{issues.length > 0 && <span className="warn-dot" title="로그인이 필요한 태스크가 있습니다" />}</span>
            <span className="count">{profiles.length}</span>
          </button>
          <button type="button" className={`side-item ${view === "supreme-order" ? "on" : ""}`} onClick={() => setView("supreme-order")}>
            <span>슈프림 주문서</span>
          </button>
        </nav>
        <div className="content">
          {view === "tasks" && (
            <nav className="filters">
              <Chip on={filter === "all"} onClick={() => setFilter("all")}>전체 {tasks.length}</Chip>
              {SITE_IDS.map((id) => (
                <Chip key={id} on={filter === id} onClick={() => setFilter(id)} site={id}>
                  {SITES[id].name} {perSite(id)}
                </Chip>
              ))}
            </nav>
          )}

          <main className={view === "supreme-order" ? "grid single" : "grid"}>
            {view === "supreme-order" ? (
              <SupremeOrderPage />
            ) : view === "monitors" ? (
              <MonitorsPage
                monitors={monitors} profiles={profiles} infos={infos} selected={selected} now={now}
                onSelect={setSelected}
                onChanged={(list) => {
                  setMonitors(list);
                  setFoundAlerts((prev) => prev.filter((f) => list.some((m) => m.def.id === f.monitorId)));
                }}
                onUpsert={upsertMonitor}
                onSwitched={onSwitched}
              />
            ) : view === "profiles" ? (
              <ProfilesPage
                profiles={profiles} tasks={tasks} runtimes={runtimes} monitors={monitors} infos={infos} selected={selected}
                onLogin={login}
                onShowLog={setSelected}
                onChanged={(list) => {
                  setProfiles(list);
                  // 지운 프로필을 쓰던 태스크는 main 이 프로필 없음으로 돌렸다.
                  void aio.listTasks().then(setTasks);
                }}
                onUpsert={upsertProfile}
                onPin={setPinFor}
                onInfos={setInfos}
              />
            ) : (
              <section className="tasks">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>사이트</th>
                      <th>프로필</th>
                      <th>상품</th>
                      <th>링크</th>
                      <th>모드</th>
                      <th>어디까지</th>
                      <th>상태</th>
                      <th>시간</th>
                      <th className="grow">마지막 줄</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((t, i) => {
                      const rt = rtOf(t.id);
                      const live = LIVE.includes(rt.status);
                      const target = targetText(t);
                      const p = profileOf(t.profileId);
                      const issue = loginIssue(t, profiles);
                      // 한 프로필에 하나인 사이트(oneTaskPerProfile)에서 다른 태스크·모니터가 이 프로필을 쓰고 있으면 ▶ 가 거절된다.
                      const others = p && SITES[t.site].oneTaskPerProfile ? profileUsers(p.id, tasks, runtimes, monitors, { except: t.id }) : [];
                      const profileTitle = p
                        ? [`${LOGIN_LABEL[p.loginStatus]} — ${p.statusNote}`, p.memo, others.length ? `사용 중: ${others.join(", ")}` : ""]
                          .filter(Boolean).join("\n")
                        : issue ?? "로그인 없이 돕니다";
                      return (
                        <tr key={t.id} className={selected === t.id ? "sel" : ""} onClick={() => setSelected(t.id)}>
                          <td className="muted">{String(i + 1).padStart(2, "0")}</td>
                          <td><SiteTag site={t.site} /></td>
                          <td title={profileTitle}>
                            {p ? (
                              <span>
                                <span className={`login-dot ${p.loginStatus}`} />{p.name}
                                {live ? <span className="muted small"> (사용 중)</span>
                                  : others.length > 0 ? <span className="warn-text small"> (다른 곳에서 사용 중)</span>
                                  : !p.isActive && <span className="muted small"> (꺼짐)</span>}
                              </span>
                            ) : (
                              <span className={issue ? "err" : "muted"}>{t.profileId ? "지워짐" : "없음"}</span>
                            )}
                          </td>
                          <td>
                            <div className="name">{target.name || "(주소 없음)"}</div>
                            <div className="muted small">
                              {target.sub && `${target.sub} · `}{t.ea}개
                              {t.max_price ? ` · ≤${t.max_price.toLocaleString()}원` : ""}
                            </div>
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            {/* 누르면 전체 주소를 복사한다. 여기서 바로 고치지는 않는다 (실수 방지) — 고치기는 ✎ 나 태스크 창에서. */}
                            <button
                              type="button" className="link-copy mono" title={`${t.url}\n누르면 복사합니다`}
                              onClick={() => void copyText(t.url.trim()).then((ok) => setCopied(ok ? t.id : null))}
                            >
                              {copied === t.id ? "복사했습니다" : shortLink(t.url) || "(주소 없음)"}
                            </button>
                          </td>
                          <td>
                            <div>{MODE_LABEL[t.mode]}</div>
                            {timingSummary(t) && <div className="muted small">{timingSummary(t)}</div>}
                          </td>
                          <td className="muted">{actionLabel(t)}</td>
                          <td>
                            <span className={`pill ${rt.status}`}>{STATUS_LABEL[rt.status]}</span>
                            {rt.status === "scheduled" && rt.scheduledFor && (
                              <div className="muted small mono" title={rt.dropAt ? `드랍 ${new Date(rt.dropAt).toLocaleString()}` : undefined}>
                                {countdown(rt.scheduledFor - now)} 뒤
                              </div>
                            )}
                            {rt.restartPending && <span className="pill pending" title="설정이 바뀌어 다시 시작하려고 기다립니다 (구매 중이면 끝난 뒤)">재시작 대기</span>}
                          </td>
                          <td className="muted mono">
                            {uptime(rt, now)}
                            {t.monitorDurationMs > 0 && REPEATING_MODES.includes(t.mode) && ` / ${span(t.monitorDurationMs)}`}
                          </td>
                          {/* 원본이 제자리에서 고쳐 쓰는 상태 줄("품절 · 다음 확인 3초")이 있으면 그것을 — 롯데 원본은 판정이
                              바뀔 때만 로그를 찍어서, 마지막 로그 줄만 보이면 감시가 멈춘 것처럼 보인다. */}
                          <td className="grow last" title={live && rt.note ? `${rt.note}\n마지막 로그: ${rt.lastLine}` : rt.lastLine}>
                            {live && rt.note ? <span className="muted">⟳ {rt.note}</span> : rt.lastLine}
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <div className="row-actions">
                              {rt.status === "stopping" ? (
                                <button className="icon force" title="강제 종료 — 열린 구매 창도 같이 닫힙니다" onClick={() => void aio.stop(t.id)}>강제</button>
                              ) : live ? (
                                <button className="icon stop" title="멈춤 (Ctrl+C 와 같다)" onClick={() => void aio.stop(t.id)}>■</button>
                              ) : rt.status === "scheduled" ? (
                                <button className="icon stop" title="예약 거두기" onClick={() => void aio.stop(t.id)}>■</button>
                              ) : (
                                <button className="icon go" title="시작" onClick={() => startOne(t)}>▶</button>
                              )}
                              <button className="icon" title="태스크 창 — 이 태스크의 상태·로그를 따로 봅니다" onClick={() => void aio.openTaskWatch(t.id)}>🖥</button>
                              <button
                                className="icon" disabled={rt.status === "stopping"} onClick={() => setEditing({ ...t })}
                                title={live ? "고치기 — 돌고 있는 채로 고칩니다" : "고치기"}
                              >✎</button>
                              <button className="icon" title="지우기" onClick={() => void removeTask(t)}>✕</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!shown.length && (
                      <tr>
                        <td colSpan={11} className="empty">
                          태스크가 없습니다. <b>+ 태스크</b> 로 상품 주소(슈프림은 키워드도)를 넣으세요.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>
            )}

            {/* 주문서 화면에는 로그가 없다 — 아래 칸을 비워 두지 않고 주문서가 다 쓴다. */}
            {view !== "supreme-order" && <section className="logs">
              <div className="logs-head">
                <span>
                  로그 · <b>{selected === PREPARE_LOG ? "준비 (빌드·설치)"
                    : selectedProfile ? `${SITES[selectedProfile.site].name} · ${selectedProfile.name} (로그인·세션 확인)`
                    : selectedSite ? `${SITES[selectedSite].name} 공통 (간편결제 비밀번호)`
                    : selectedMonitor ? `모니터 · ${SITES[selectedMonitor.def.site].name} ${selectedMonitor.def.name}`
                    : selectedTask?.label || (selectedTask && SITES[selectedTask.site].productCode(selectedTask.url))
                      || (view === "profiles" ? "프로필의 '로그' 를 누르세요" : view === "monitors" ? "모니터를 고르세요" : "태스크를 고르세요")}</b>
                </span>
                {selectedTask && (
                  <span className="logs-actions">
                    <button className="btn small ghost" onClick={() => void aio.openHome(selectedTask.id)}>폴더 열기</button>
                    <button
                      className="btn small ghost"
                      disabled={LIVE.includes(rtOf(selectedTask.id).status)}
                      title="원본의 --reset 과 같습니다 — 산 기록·쉬는 기록(쿨다운)을 지웁니다. 돌고 있으면 멈춘 뒤 누르세요"
                      onClick={() => {
                        const id = selectedTask.id;
                        void aio.ask("이 태스크의 산 기록·쉬는 기록을 지울까요? (원본의 --reset)\n다음 실행에서 쉬지 않고 바로 다시 보고, 산 것도 다시 삽니다.").then((ok) => { if (ok) void aio.resetState(id); });
                      }}
                    >
                      기록 지우기 (--reset)
                    </button>
                    <button className="btn small ghost" onClick={() => setLogs([])}>화면 비우기</button>
                  </span>
                )}
              </div>
              <LogView lines={logs} />
            </section>}
          </main>
        </div>
      </div>

      {editing && (
        <TaskForm
          task={editing} infos={infos} live={LIVE.includes(rtOf(editing.id).status)}
          profiles={profiles}
          usersOf={(profileId) => profileUsers(profileId, tasks, runtimes, monitors, { except: editing.id })}
          onLogin={login} onUpsertProfile={upsertProfile}
          onCancel={() => setEditing(null)} onSave={(t) => void saveTask(t)}
        />
      )}
      {pinAsk && (
        <PinAskModal
          profile={pinAsk.profile}
          onSetPin={() => {
            setPinFor(pinAsk.profile.id);
            setPinAsk(null);
          }}
          onStart={() => {
            void aio.start(pinAsk.task.id);
            setPinAsk(null);
          }}
          onClose={() => setPinAsk(null)}
        />
      )}
      {pinProfile && (
        <PinModal
          profile={pinProfile} info={infos.find((i) => i.site === pinProfile.site)}
          onSaved={upsertProfile} onClose={() => setPinFor(null)}
        />
      )}
      {settingsOpen && (
        <SettingsForm
          infos={infos}
          profiles={profiles}
          preparing={preparing}
          onPrepare={(site) => void prepare(site)}
          onSaved={refreshInfo}
          onClose={() => {
            setSettingsOpen(false);
            refreshInfo();
          }}
        />
      )}
    </div>
  );
}

/**
 * 상단 바 오른쪽의 알림 (🔔). 사이트마다 원본 준비 문제·경고와 로그인이 필요한 태스크를 모아 둔다. 예전에는 상단 배너로
 * 늘 펼쳐져 화면을 밀어냈다 — 이제는 개수만 보이고 눌러야 펼친다. 막는 문제(problems — 태스크를 안 띄운다)가 있으면
 * 배지가 빨갛다. 바깥을 누르거나 Esc 로 닫는다. 재고 발견 알림(FoundAlerts)은 급한 것이라 여기 넣지 않는다.
 */
function NoticeBell({ alerts, issueLines, preparing, onPrepare, onProfiles }: {
  alerts: SiteInfo[];
  issueLines: (site: SiteId) => string[];
  preparing: SiteId | null;
  onPrepare: (site: SiteId) => void;
  /** 프로필 화면으로. 이미 거기 있으면 null. */
  onProfiles: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const count = alerts.reduce((n, i) => n + i.problems.length + i.warnings.length + (issueLines(i.site).length ? 1 : 0), 0);
  const blocking = alerts.some((i) => i.problems.length > 0);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="notice" ref={box}>
      <button
        type="button" className={`btn ghost notice-btn ${open ? "on" : ""}`} onClick={() => setOpen(!open)}
        title={count ? `알림 ${count}개` : "알림 없음"}
      >
        🔔{count > 0 && <span className={`notice-count ${blocking ? "bad" : ""}`}>{count}</span>}
      </button>
      {open && (
        <div className="notice-pop">
          <div className="notice-head">
            <b>알림</b>
            <span className="muted small">{count ? `${count}개` : ""}</span>
            <span className="grow" />
            <button type="button" className="icon" title="닫기" onClick={() => setOpen(false)}>✕</button>
          </div>
          {!alerts.length && <div className="muted notice-empty">알림이 없습니다.</div>}
          {alerts.map((info) => {
            const lines = issueLines(info.site);
            return (
              <div key={info.site} className="notice-site">
                <div className="notice-site-head">
                  <SiteTag site={info.site} /> <b>{SITES[info.site].name}</b>
                </div>
                <ul className="notice-lines">
                  {info.problems.map((p) => <li key={p} className="bad">{p}</li>)}
                  {info.warnings.map((p) => <li key={p}>{p}</li>)}
                  {lines.length > 0 && <li>로그인이 필요한 태스크가 있습니다 — {lines.join(" · ")}</li>}
                </ul>
                <div className="notice-actions">
                  {info.problems.length > 0 && info.prepare && (
                    <button type="button" className="btn small" disabled={preparing !== null} onClick={() => onPrepare(info.site)}>
                      {preparing === info.site ? "하는 중…" : info.prepare}
                    </button>
                  )}
                  {lines.length > 0 && onProfiles && (
                    <button type="button" className="btn small" onClick={() => { setOpen(false); onProfiles(); }}>프로필 화면</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function SiteTag({ site }: { site: SiteId }) {
  return <span className={`site ${site}`}>{SITES[site].tag}</span>;
}

function Chip({ on, site, onClick, children }: {
  on: boolean; site?: SiteId; onClick: () => void; children: ReactNode;
}) {
  return (
    <button type="button" className={`chip ${on ? "on" : ""} ${site ?? ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function LogView({ lines }: { lines: LogLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div
      className="logview"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.map((l, i) => (
        <div key={i} className={`ln ${l.stream}`}>
          <span className="t">{clock(l.at)}</span>
          <span className="x">{l.text}</span>
        </div>
      ))}
      {!lines.length && <div className="muted empty">아직 아무것도 없습니다.</div>}
    </div>
  );
}

function TaskForm({ task, infos, live, profiles, usersOf, onLogin, onUpsertProfile, onSave, onCancel }: {
  task: TaskDef; infos: SiteInfo[]; live: boolean; profiles: Profile[];
  /** 이 프로필로 지금 도는 (이 태스크 말고) 태스크·모니터. */
  usersOf: (profileId: string) => string[];
  onLogin: (profileId: string) => void; onUpsertProfile: (p: Profile) => void;
  onSave: (t: TaskDef) => void; onCancel: () => void;
}) {
  const [t, setT] = useState(task);
  const set = <K extends keyof TaskDef>(k: K, v: TaskDef[K]) => setT((prev) => ({ ...prev, [k]: v }));
  const spec = SITES[t.site];
  const valid = spec.isProductUrl(t.url);
  const supreme = t.site === "supreme";
  const productUrl = supreme && isSupremeProductUrl(t.url);
  const option = splitSupremeOption(t.option);
  // `#jackets` 만 적으면 그 컬렉션의 아무거나 살 수 있다 — 원본도 키워드 없이는 돌지 않는다.
  const keywordError = supreme && valid && !productUrl && !hasSupremeKeyword(t.url)
    ? "키워드(+box +logo -jacket)를 하나 이상 적으세요 — 카테고리만으로는 사지 않습니다."
    : null;
  /** 고른 "어디까지" 에서 원본이 실제로 어디서 멈추나 — 씨앗 설정(비밀번호·마지막 확인)에 따라 다르다. */
  const info = infos.find((i) => i.site === t.site);
  // 결제 비밀번호는 고른 프로필의 것 (결제창 로그인 프로필이 먼저) — 있으면 원본이 자판까지 누른다.
  const { from: pinFrom, ask: pinAsk } = pinSource(t, profiles);
  const hint = (pinFrom ? info?.actionHintsWithPin : info?.actionHints)?.[t.action];
  const noPin = !pinFrom && !!pinAsk && !!info && pinMatters(t, info.defaultAction);
  const timingError = info ? checkTiming(t, info.timing).error : null;
  // 저장은 프로필이 없을 때만 막는다. 로그인이 안 된 프로필은 고를 수 있다 — 띄우기 전에 로그인하면 된다.
  const profileError = !t.profileId
    ? spec.loginOptional.includes(t.mode) ? null : `${spec.name} ${MODE_LABEL[t.mode]}는 로그인 프로필이 있어야 합니다 — 프로필을 고르세요.`
    : profiles.some((p) => p.id === t.profileId) ? null : "고른 프로필이 지워졌습니다 — 다시 고르세요.";

  /**
   * 사이트를 바꾸면 그 사이트가 모르는 "어디까지" 는 설정 따름으로 되돌린다 (네이버에는 agree 가 없다).
   * 프로필도 그 사이트 것으로 다시 고른다.
   */
  const setSite = (site: SiteId) =>
    setT((prev) => {
      const { profileId: _other, payProfileId: _pay, ...rest } = prev;
      const profileId = prev.site === site ? prev.profileId : defaultProfile(profiles, site);
      const paySite = SITES[site].payProfileSite;
      const payProfileId = !paySite ? undefined : prev.site === site ? prev.payProfileId : defaultProfile(profiles, paySite);
      return {
        ...rest,
        site,
        ...(profileId ? { profileId } : {}),
        ...(payProfileId ? { payProfileId } : {}),
        action: prev.action && (SITES[site].actions as readonly string[]).includes(prev.action) ? prev.action : "",
        // 드랍(--drop)은 롯데 원본에만 있다.
        mode: SITES[site].modes.includes(prev.mode) ? prev.mode : "watch",
      };
    });

  const setUrl = (url: string) => {
    // 다른 사이트 주소를 붙여 넣으면 사이트를 따라 바꾼다.
    const guessed = siteOfUrl(url);
    if (guessed && guessed !== t.site) setSite(guessed);
    set("url", url);
  };

  return (
    <div className="modal-back" onClick={onCancel}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !keywordError && !timingError && !profileError) onSave({ ...t, url: t.url.trim(), label: t.label.trim(), option: t.option.trim() });
        }}
      >
        <h2>{task.url ? "태스크 고치기" : "새 태스크"}</h2>
        {live && <LiveNote before={task} after={t} />}
        <div className="segmented">
          {SITE_IDS.map((id) => (
            <button
              key={id} type="button" className={`${id} ${t.site === id ? "on" : ""}`} onClick={() => setSite(id)}
              disabled={live && id !== task.site} title={live && id !== task.site ? "돌고 있는 태스크는 사이트를 바꿀 수 없습니다" : undefined}
            >
              {SITES[id].name}
            </button>
          ))}
        </div>
        <ProfilePicker
          t={t} profiles={profiles} usersOf={usersOf} error={profileError}
          onPick={(id) => set("profileId", id)} onLogin={onLogin} onCreated={onUpsertProfile}
        />
        {spec.payProfileSite && (
          <PayProfilePicker
            t={t} site={spec.payProfileSite} profiles={profiles} onLogin={onLogin}
            onPick={(id) => setT(({ payProfileId: _old, ...rest }) => ({ ...rest, ...(id ? { payProfileId: id } : {}) }))}
          />
        )}
        <label>
          {supreme ? "상품 주소 또는 키워드" : "상품 주소"}
          <input autoFocus value={t.url} placeholder={spec.placeholder} onChange={(e) => setUrl(e.target.value)} />
          {!valid && t.url && <span className="err">{spec.urlError}</span>}
          {keywordError && <span className="err">{keywordError}</span>}
        </label>
        <label>
          <span>이름 <span className="muted">{supreme ? "(비워 두면 키워드·상품 handle)" : "(비워 두면 상품번호)"}</span></span>
          <input value={t.label} onChange={(e) => set("label", e.target.value)} />
        </label>
        {supreme ? (
          // 슈프림은 **카테고리 · 색 · 사이즈를 따로** 고른다 — 카테고리는 주소 칸의 `#…` 를 바꿔 쓰고(훑을 컬렉션),
          // 색은 상품 이름에서, 사이즈는 variant 에서 고른다. 색·사이즈는 한 칸(option)에 "색 / 사이즈" 로 저장한다.
          <>
            <div className="row">
              <label>
                <span>카테고리 <span className="muted">(좁히면 빠릅니다)</span></span>
                <select
                  value={supremeCategories(t.url)[0] ?? ""} disabled={productUrl}
                  title={productUrl ? "상품 주소로 사면 카테고리가 필요 없습니다" : "주소 칸의 #카테고리 를 바꿉니다"}
                  onChange={(e) => set("url", withSupremeCategory(t.url, e.target.value))}
                >
                  <option value="">전체 (all)</option>
                  {SUPREME_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  {(() => {
                    const own = supremeCategories(t.url)[0];
                    return own && !SUPREME_CATEGORIES.some((c) => c.id === own) ? <option value={own}>{own}</option> : null;
                  })()}
                </select>
              </label>
              <label>
                <span>색 <span className="muted">(상품명의 색)</span></span>
                <input
                  value={option.color} placeholder="Predator Camo"
                  onChange={(e) => set("option", joinSupremeOption(e.target.value, option.size))}
                />
              </label>
              <label>
                사이즈
                <input
                  value={option.size} placeholder="Large"
                  onChange={(e) => set("option", joinSupremeOption(option.color, e.target.value))}
                />
              </label>
            </div>
            <div className="row">
              <label className="narrow">
                수량
                <input type="number" min={1} value={t.ea} onChange={(e) => set("ea", Math.max(1, Number(e.target.value) || 1))} />
              </label>
              <label>
                <span>상한가 <span className="muted">(0 = 없음)</span></span>
                <input type="number" min={0} value={t.max_price} onChange={(e) => set("max_price", Math.max(0, Number(e.target.value) || 0))} />
              </label>
              <label>
                모드
                <select value={t.mode} onChange={(e) => set("mode", e.target.value as TaskMode)}>
                  {spec.modes.map((k) => <option key={k} value={k}>{MODE_LABEL[k]}</option>)}
                </select>
              </label>
            </div>
            <p className="muted small modal-text">
              어디까지 — 슈프림은 고를 것이 없습니다: 담기 → 배송 → 카드 → 동의 → <b>결제 버튼까지</b> 자동이고, 캡차·3DS 만 사람이 합니다.
              주문서(배송·카드)는 왼쪽 <b>슈프림 주문서</b> 에서 적습니다.
            </p>
          </>
        ) : (
          <>
            <div className="row">
              <label>
                옵션 <span className="muted">(글자 일부)</span>
                <input value={t.option} onChange={(e) => set("option", e.target.value)} />
              </label>
              <label className="narrow">
                수량
                <input type="number" min={1} value={t.ea} onChange={(e) => set("ea", Math.max(1, Number(e.target.value) || 1))} />
              </label>
              <label>
                <span>상한가 <span className="muted">(0 = 없음)</span></span>
                <input type="number" min={0} value={t.max_price} onChange={(e) => set("max_price", Math.max(0, Number(e.target.value) || 0))} />
              </label>
            </div>
            <div className="row">
              <label>
                모드
                <select value={t.mode} onChange={(e) => set("mode", e.target.value as TaskMode)}>
                  {spec.modes.map((k) => <option key={k} value={k}>{MODE_LABEL[k]}</option>)}
                </select>
              </label>
              <label>
                어디까지
                <select value={t.action} onChange={(e) => set("action", e.target.value as OrderAction)}>
                  <option value="">설정 따름</option>
                  {spec.actions.map((a) => <option key={a} value={a}>{spec.actionLabel[a]}</option>)}
                </select>
              </label>
            </div>
          </>
        )}
        {hint && (
          <p className="hint">
            {hint}
            {noPin && ` — '${pinAsk!.name}' 프로필에 결제 비밀번호가 없어 결제 단계에서 사람이 넣어야 합니다 (프로필 화면에서 넣을 수 있습니다).`}
          </p>
        )}
        {t.mode === "drop" && info?.timing.drop && (
          <DropFields d={t.dropSettings} floor={info.timing.drop} set={(v) => set("dropSettings", v)} monitorMs={t.monitorDurationMs} />
        )}
        {info && <TimingFields t={t} timing={info.timing} set={set} />}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>취소</button>
          <button type="submit" className="btn primary" disabled={!valid || !!keywordError || !!timingError || !!profileError}>저장</button>
        </div>
      </form>
    </div>
  );
}

const NEW_PROFILE = "__new__";

/**
 * 결제창 로그인 프로필 (sites.ts 의 payProfileSite). 반다이남코 네이버페이는 결제창에서 네이버에 로그인해야 한다 —
 * 네이버 프로필을 고르면 그 세션을 원본 크롬에 같이 심는다. 고르지 않으면 원본이 결제 전에 로그인 창을 띄우고 사람을 기다린다.
 */
function PayProfilePicker({ t, site, profiles, onPick, onLogin }: {
  t: TaskDef; site: SiteId; profiles: Profile[]; onPick: (id: string | undefined) => void; onLogin: (id: string) => void;
}) {
  const mine = profiles.filter((p) => p.site === site);
  const choices = mine.filter((p) => p.isActive || p.id === t.payProfileId);
  const picked = mine.find((p) => p.id === t.payProfileId);
  const gone = !!t.payProfileId && !picked;
  return (
    <div className="picker">
      <label>
        {SITES[site].name}페이 로그인 <span className="muted">(결제창에서 쓸 {SITES[site].name} 프로필)</span>
        <select value={t.payProfileId ?? ""} onChange={(e) => onPick(e.target.value || undefined)}>
          <option value="">없음 — 결제 전에 크롬에서 직접 로그인</option>
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              {`${p.name} (${LOGIN_LABEL[p.loginStatus]})${p.memo ? ` · ${p.memo}` : ""}${p.isActive ? "" : " — 꺼짐"}`}
            </option>
          ))}
        </select>
      </label>
      {picked && picked.loginStatus !== "logged_in" && (
        <div className="account-row">
          <span className={`pill login ${picked.loginStatus}`}>{LOGIN_LABEL[picked.loginStatus]}</span>
          <span className="grow muted">{picked.statusNote} — 이대로면 결제창에서 사람이 로그인해야 합니다.</span>
          {picked.loginStatus !== "logging_in" && (
            <button type="button" className="btn small" onClick={() => onLogin(picked.id)}>로그인</button>
          )}
        </div>
      )}
      {picked && (
        <span className={picked.hasPaymentPin ? "muted small" : "warn-text small"}>
          {picked.hasPaymentPin
            ? `${SITES[site].name}페이 비밀번호는 이 프로필 것을 씁니다.`
            : `이 프로필에 결제 비밀번호가 없습니다 — 프로필 카드의 "결제 비밀번호 넣기" 에 ${SITES[site].name}페이 비밀번호를 넣으면 자판까지 눌러 줍니다.`}
        </span>
      )}
      {!mine.length && <span className="muted small">{SITES[site].name} 프로필이 없습니다 — 프로필 화면에서 만들고 로그인하면 여기서 고를 수 있습니다.</span>}
      {gone && <span className="err small">고른 {SITES[site].name} 프로필이 지워졌습니다 — 다시 고르세요.</span>}
    </div>
  );
}

/**
 * 태스크 폼의 "로그인 프로필". 그 사이트의 프로필 중에서 고르고, 여기서 바로 새로 만들거나 로그인할 수 있다.
 * 롯데 재고만·드라이런은 프로필 없이도 된다 (원본이 공개 페이지로 본다).
 * 꺼 둔 프로필은 목록에 안 나온다 — 이미 고른 것이면 그것만 남겨 둔다.
 */
function ProfilePicker({ t, profiles, usersOf, error, onPick, onLogin, onCreated }: {
  t: TaskDef; profiles: Profile[]; usersOf: (profileId: string) => string[]; error: string | null;
  onPick: (id: string | undefined) => void; onLogin: (id: string) => void; onCreated: (p: Profile) => void;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const spec = SITES[t.site];
  const mine = profiles.filter((p) => p.site === t.site);
  const choices = mine.filter((p) => p.isActive || p.id === t.profileId);
  const picked = mine.find((p) => p.id === t.profileId);
  const optional = spec.loginOptional.includes(t.mode);
  // 그 프로필로 지금 도는 다른 태스크·모니터. 한 프로필에 하나인 사이트(oneTaskPerProfile)면 ▶ 가 거절되고,
  // 아니면 같은 계정으로 같이 돈다는 것만 알린다.
  const inUse = picked ? usersOf(picked.id) : [];

  const create = async () => {
    setBusy(true);
    setFail(null);
    try {
      const p = await aio.createProfile(t.site, naming ?? "");
      onCreated(p);
      onPick(p.id);
      setNaming(null);
    } catch (e) {
      setFail(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="picker">
      <label>
        로그인 프로필
        <select
          value={naming !== null ? NEW_PROFILE : t.profileId ?? ""}
          onChange={(e) => {
            setFail(null);
            if (e.target.value === NEW_PROFILE) return setNaming("");
            setNaming(null);
            onPick(e.target.value || undefined);
          }}
        >
          <option value="">
            {spec.loginOptional.length
              ? `없음 — 로그인 없이 (${spec.loginOptional.map((m) => MODE_LABEL[m]).join("·")}만)`
              : "— 고르세요 —"}
          </option>
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              {`${p.name} (${LOGIN_LABEL[p.loginStatus]})${p.memo ? ` · ${p.memo}` : ""}` +
                `${usersOf(p.id).length ? " — 사용 중" : ""}${p.isActive ? "" : " — 꺼짐"}`}
            </option>
          ))}
          <option value={NEW_PROFILE}>+ 새 프로필 만들기…</option>
        </select>
      </label>
      {naming !== null && (
        <div className="account-actions">
          <input
            className="grow" autoFocus value={naming} placeholder={`새 ${spec.name} 프로필 이름 (비우면 '${spec.name} ${mine.length + 1}')`}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setNaming(null);
              }
            }}
          />
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void create()}>만들기</button>
          <button type="button" className="btn small ghost" onClick={() => setNaming(null)}>취소</button>
        </div>
      )}
      {picked && picked.loginStatus !== "logged_in" && (
        <div className="account-row">
          <span className={`pill login ${picked.loginStatus}`}>{LOGIN_LABEL[picked.loginStatus]}</span>
          <span className="grow muted">{picked.statusNote}</span>
          {picked.loginStatus === "logging_in" ? (
            <button type="button" className="btn small ghost" onClick={() => void aio.cancelLogin(picked.id)}>로그인 취소</button>
          ) : (
            <button type="button" className="btn small" onClick={() => onLogin(picked.id)}>로그인</button>
          )}
        </div>
      )}
      {!t.profileId && optional && <span className="muted small">프로필 없이 돕니다 — 쿠키를 싣지 않고 공개 페이지로 봅니다.</span>}
      {inUse.length > 0 && !spec.oneTaskPerProfile && (
        <span className="muted small">
          이 프로필은 지금 {inUse.join(", ")}에서도 쓰는 중입니다 — 같은 계정으로 같이 돕니다. 같은 상품이면 주문서가 두 번 열립니다.
        </span>
      )}
      {inUse.length > 0 && spec.oneTaskPerProfile && (
        <span className="warn-text small">
          ⚠ 이 프로필은 현재 사용 중입니다 ({inUse.join(", ")}). {spec.name}는 같은 프로필로 동시에 하나만 실행할 수 있습니다
          — 저장은 되지만, 그것이 멈추기 전에는 시작하지 않습니다.
        </span>
      )}
      {picked && !picked.isActive && (
        <span className="muted small">꺼 둔 프로필입니다 — 이 태스크는 그대로 돌지만, 새로 고를 때는 목록에 안 나옵니다.</span>
      )}
      {error && naming === null && <span className="err">{error}</span>}
      {fail && <span className="err">{fail}</span>}
    </div>
  );
}

/**
 * 간격·재시도 칸을 원본이 받는 한계와 맞대 본다. → 막을 것(error)과 알려 줄 것(notes)
 * 막는 것은 원본이 시작을 거절할 값뿐이다 (네이버: 상품 하나를 2초보다 촘촘히). 원본이 알아서
 * 올려 보는 값(롯데 하한)은 막지 않고 알려 준다.
 */
function checkTiming(t: TaskDef, d: TimingDefaults): { error: string | null; notes: string[] } {
  const notes: string[] = [];
  let error: string | null = null;
  const ms = t.checkIntervalMs;
  if (ms !== null && REPEATING_MODES.includes(t.mode)) {
    const sent = d.wholeSeconds ? Math.max(Math.ceil(ms / 1000), 1) * 1000 : ms;
    if (d.wholeSeconds && sent !== ms) notes.push(`초 단위로만 받습니다 — ${span(sent)}로 올려 적습니다.`);
    if (sent < d.minIntervalMs) {
      if (d.wholeSeconds) error = `상품 하나를 ${span(d.minIntervalMs)}보다 촘촘히 보면 원본이 요청률로 거절합니다.`;
      else notes.push(`원본 하한(min_interval_seconds)이 ${span(d.minIntervalMs)}라 ${span(d.minIntervalMs)}마다 봅니다.`);
    } else if (d.rateWarnPerMin !== null && 60_000 / sent > d.rateWarnPerMin) {
      notes.push(`이 태스크 하나로 ${(60_000 / sent).toFixed(1)}회/분 — 권장선(${d.rateWarnPerMin}회/분)보다 높아 로그인 세션이 막힐 수 있습니다.`);
    }
  }
  if (t.stopOnSuccess === false) {
    notes.push(`사도 '다 샀다' 고 적지 않아 다음 재입고에도 또 삽니다 — 한 번 돌 때 최대 ${t.maxBuys}번.`);
  }
  return { error, notes };
}

/** 1:58:03 · 4:05 · 12초 */
export function countdown(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const two = (n: number) => String(n).padStart(2, "0");
  if (h) return `${h}:${two(m)}:${two(sec % 60)}`;
  if (m) return `${m}:${two(sec % 60)}`;
  return `${sec}초`;
}

/**
 * 드랍 모드 (롯데 원본 --drop). 원본은 걸음만 바꾼다 — 1초 주기(±0.2), 재시도 쉼 0초, 실패해도 안 쉼.
 * 드랍 시각은 원본에 없어서 매니저가 재서 그만큼 먼저 띄운다.
 */
function DropFields({ d, floor, monitorMs, set }: {
  d: DropSettings; floor: { intervalMs: number; minIntervalMs: number }; monitorMs: number; set: (v: DropSettings) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const plan = d.dropTime.trim() ? planDrop(d, now) : null;
  const when = (ms: number) => {
    const at = new Date(ms);
    const day = at.toDateString() === new Date(now).toDateString() ? "오늘" : "내일";
    return `${day} ${at.toTimeString().slice(0, 8)}`;
  };
  let preview: string;
  if (!d.dropTime.trim()) preview = "드랍 시각을 비워 두면 ▶ 를 누를 때 바로 드랍 모드로 띄웁니다.";
  else if (!plan) preview = "시각을 알아보지 못했습니다 — HH:mm:ss 로 적어 주세요.";
  else if (plan.late) preview = `드랍 시각(${when(plan.dropAt)})이 막 지났습니다 — ▶ 를 누르면 바로 띄웁니다.`;
  else if (plan.startAt <= now) preview = `${when(plan.dropAt)} 드랍 — 미리 띄울 때가 지나 ▶ 를 누르면 바로 띄웁니다.`;
  else preview = `${when(plan.dropAt)} 드랍 · ▶ 를 누르면 예약하고 ${when(plan.startAt)} 에 띄웁니다 (${countdown(plan.startAt - now)} 뒤).`;
  const slow = d.intervalMs !== null && d.intervalMs < floor.minIntervalMs;
  return (
    <fieldset className="timing drop">
      <legend>드랍 <span className="muted">— 롯데 원본 --drop</span></legend>
      <div className="row">
        <label>
          드랍 시각 <span className="muted">(이 PC 시계)</span>
          <input type="time" step={1} value={d.dropTime} onChange={(e) => set({ ...d, dropTime: e.target.value })} />
        </label>
        <NumField
          label="몇 분 전에 띄울지" value={d.preCheckMinutes} unit={1} step={1} min={0} placeholder="2"
          onChange={(v) => set({ ...d, preCheckMinutes: Math.max(0, Math.round(v ?? 0)) })}
        />
        <NumField
          label="드랍 확인 간격 (초)" value={d.intervalMs} unit={1000} step={0.1} min={0.1} placeholder={`씨앗 ${span(floor.intervalMs)}`}
          onChange={(v) => set({ ...d, intervalMs: v })}
          title="원본 drop_interval_seconds. 원본이 0.5초 밑으로는 올려서 봅니다 (DROP_FLOOR)"
        />
      </div>
      <p className="muted small">{preview}</p>
      <p className="muted small">
        원본이 하는 일: 드랍 확인 간격마다 (씨앗의 drop_jitter_seconds 만큼 흔들어) 보고, 재시도 쉼·실패 뒤 쉬는 시간을 0 으로 둡니다. 조회가 실패한 바퀴 뒤에는
        한 번 평소 간격으로 쉽니다 (봇 차단 대비). 원본에는 시간 제한이 없습니다
        {monitorMs ? ` — 감시 시간 ${span(monitorMs)} 뒤 멈춥니다.` : " — 끝낼 때를 정하려면 아래 감시 시간을 적으세요."}
      </p>
      {slow && <p className="muted small">원본이 {span(floor.minIntervalMs)} 밑으로는 안 내려서 {span(floor.minIntervalMs)}마다 봅니다.</p>}
      <p className="muted small">
        원본은 <b>품절 → 구매가능으로 바뀌는 순간</b>에만 삽니다 (씨앗의 buy_on_restock_only). 드랍 전에 띄워 두어야
        드랍 전의 "품절" 을 보고 풀리는 순간을 잡습니다 — 띄웠을 때 이미 팔고 있으면 사지 않습니다.
      </p>
      <p className="muted small">태스크마다 따로 두드립니다 — 드랍 태스크를 여럿 켜면 그만큼 촘촘해집니다 (롯데온은 Imperva 봇 차단 뒤에 있습니다).</p>
    </fieldset>
  );
}

/** 비우면 null (= 씨앗 설정). 화면 단위(초·분)와 저장 단위(ms)를 오간다. */
function NumField({ label, value, unit, onChange, placeholder, step, min, disabled, title }: {
  label: string; value: number | null; unit: number; onChange: (v: number | null) => void;
  placeholder: string; step: number; min: number; disabled?: boolean; title?: string;
}) {
  return (
    <label title={title}>
      {label}
      <input
        type="number"
        value={value === null ? "" : String(value / unit)}
        placeholder={placeholder}
        step={step}
        min={min}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value.trim();
          const n = Number(raw);
          onChange(raw === "" || !Number.isFinite(n) ? null : Math.max(min, n) * unit);
        }}
      />
    </label>
  );
}

function TimingFields({ t, timing: d, set }: {
  t: TaskDef; timing: TimingDefaults; set: <K extends keyof TaskDef>(k: K, v: TaskDef[K]) => void;
}) {
  const repeating = REPEATING_MODES.includes(t.mode);
  const only = repeating ? undefined : "지켜보기·드라이런에서만 씁니다 (나머지 모드는 한 번 돌고 끝납니다)";
  const { error, notes } = checkTiming(t, d);
  const seedStop = d.stopOnSuccess ? "1개 사면 멈춤" : `최대 ${d.maxBuys}번`;
  return (
    <fieldset className="timing">
      <legend>간격 · 재시도 <span className="muted">— 비워 두면 씨앗 설정</span></legend>
      <div className="row">
        <NumField
          label={t.mode === "drop" ? "평소 확인 간격 (초)" : "확인 간격 (초)"} value={t.checkIntervalMs} unit={1000}
          step={d.wholeSeconds ? 1 : 0.5} min={d.wholeSeconds ? 1 : 0.5}
          placeholder={`씨앗 ${span(d.checkIntervalMs)}`} disabled={!repeating}
          title={t.mode === "drop" ? "드랍 모드에서는 조회가 실패한 바퀴 뒤에 한 번 이 간격으로 쉽니다 (원본 watch.ts)" : only}
          onChange={(v) => set("checkIntervalMs", v)}
        />
        <NumField
          label="감시 시간 (분)" value={t.monitorDurationMs || null} unit={60_000} step={1} min={0}
          placeholder="끝없이" disabled={!repeating} title={only}
          onChange={(v) => set("monitorDurationMs", v ?? 0)}
        />
      </div>
      <div className="row">
        <NumField
          label="재시도 (번)" value={t.maxRetries} unit={1} step={1} min={0}
          placeholder={`씨앗 ${d.maxRetries}번`} title={d.retryScope}
          onChange={(v) => set("maxRetries", v === null ? null : Math.round(v))}
        />
        <NumField
          label="재시도 간격 (초)" value={t.retryDelayMs} unit={1000} step={0.5} min={0}
          placeholder={t.mode === "drop" ? "드랍: 0초" : `씨앗 ${span(d.retryDelayMs)}`} disabled={t.mode === "drop"}
          title={t.mode === "drop" ? "드랍 모드에서는 원본이 재시도 간격과 실패 뒤 쉬는 시간을 0 으로 둡니다" : d.retryScope}
          onChange={(v) => set("retryDelayMs", v)}
        />
      </div>
      <div className="row">
        <label>
          사고 나면
          <select
            value={t.stopOnSuccess === null ? "" : t.stopOnSuccess ? "stop" : "again"}
            onChange={(e) => set("stopOnSuccess", e.target.value === "" ? null : e.target.value === "stop")}
          >
            <option value="">설정 따름 ({seedStop})</option>
            <option value="stop">1개 사면 멈춤</option>
            <option value="again">다음 재입고에도 또 삼</option>
          </select>
        </label>
        {t.stopOnSuccess === false ? (
          <NumField
            label="최대 몇 번" value={t.maxBuys} unit={1} step={1} min={2} placeholder="2"
            onChange={(v) => set("maxBuys", Math.max(2, Math.round(v ?? 2)))}
          />
        ) : <span className="grow" />}
      </div>
      <p className="muted small">재시도는 {d.retryScope} 걸립니다.</p>
      {notes.map((n) => <p key={n} className="muted small">{n}</p>)}
      {error && <p className="err small">{error}</p>}
    </fieldset>
  );
}

/**
 * 돌고 있는 태스크를 고칠 때, 저장하면 무엇이 어떻게 되는지. TaskManager.applyToLive 와 같은 규칙이다.
 *   한 번 돌고 끝나는 모드       → 이번 실행에는 반영하지 않는다
 *   원본이 다시 읽는 칸만 바뀜   → 바로 반영 (롯데 대상 칸)
 *   그 밖                        → 다시 시작 (구매 중·구매 창이 열려 있으면 끝난 뒤)
 */
function LiveNote({ before, after }: { before: TaskDef; after: TaskDef }) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map((k) => k as keyof TaskDef)
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const live = SITES[before.site].liveFields;
  let text: string;
  if (!REPEATING_MODES.includes(before.mode) || !REPEATING_MODES.includes(after.mode)) {
    text = "한 번 돌고 끝나는 모드라 이번 실행에는 반영하지 않습니다 — 다음 실행부터 새 설정입니다.";
  } else if (!changed.length) {
    text = live.length
      ? `${live.map((k) => FIELD_LABEL[k]).join(" · ")} 은 저장하면 바로 반영됩니다. 그 밖의 칸은 다시 시작합니다.`
      : "저장하면 다시 시작합니다 — 이 사이트의 원본은 실행 중에 설정을 다시 읽지 않습니다.";
  } else if (changed.every((k) => live.includes(k))) {
    text = `저장하면 바로 반영됩니다 (${changed.map((k) => FIELD_LABEL[k]).join(" · ")}) — 원본이 다음 확인 때 읽습니다.`;
  } else {
    text = `저장하면 다시 시작합니다 (${changed.map((k) => FIELD_LABEL[k]).join(" · ")}) — 구매 중이거나 구매 창이 열려 있으면 그게 끝난 뒤에.`;
  }
  return <p className="hint live">돌고 있는 태스크입니다. {text}</p>;
}

/**
 * 프로필 화면. 사이트마다 로그인 프로필을 모아 보이고, 만들기·로그인·확인·로그아웃·고치기(이름·메모)·켜고 끄기·지우기를 한다.
 * 로그인은 창 안에서 사람이 한다 — 매니저는 아이디·비밀번호를 보지도 적지도 않는다.
 */
function ProfilesPage({ profiles, tasks, runtimes, monitors, infos, selected, onLogin, onShowLog, onChanged, onUpsert, onPin, onInfos }: {
  profiles: Profile[]; tasks: TaskDef[]; runtimes: Record<string, TaskRuntime>; monitors: MonitorEntry[];
  infos: SiteInfo[]; selected: string | null;
  onLogin: (id: string) => void;
  onShowLog: (logId: string) => void;
  /** 지웠다 — 새 목록. */
  onChanged: (list: Profile[]) => void;
  onUpsert: (p: Profile) => void;
  /** 결제 비밀번호 창을 연다. */
  onPin: (profileId: string) => void;
  onInfos: (infos: SiteInfo[]) => void;
}) {
  const [site, setSite] = useState<Filter>("all");
  /** 만들기 창(null 이 아니면 열림) — edit 가 있으면 그 프로필을 고친다. */
  const [modal, setModal] = useState<{ edit: Profile | null } | null>(null);
  const sites = site === "all" ? SITE_IDS : [site];
  return (
    <section className="profiles-page">
      <div className="page-head">
        <h2>프로필</h2>
        <label className="inline">
          사이트
          <select value={site} onChange={(e) => setSite(e.target.value as Filter)}>
            <option value="all">전체</option>
            {SITE_IDS.map((id) => <option key={id} value={id}>{SITES[id].name}</option>)}
          </select>
        </label>
        <span className="grow" />
        <button type="button" className="btn primary" onClick={() => setModal({ edit: null })}>+ 새 프로필</button>
      </div>
      <p className="muted small page-note">
        로그인은 창 안에서 직접 합니다 (캡차·2단계 인증 포함). 매니저는 아이디·비밀번호를 보지도 적지도 않고, 로그인이 된 뒤의
        쿠키·세션만 프로필 폴더에 적습니다. 태스크는 폼에서 프로필을 고릅니다.
      </p>
      {modal && (
        <ProfileModal
          edit={modal.edit} site={site === "all" ? "lotte" : site} profiles={profiles}
          onSaved={onUpsert} onLogin={onLogin} onClose={() => setModal(null)}
        />
      )}
      {sites.map((id) => {
        const mine = profiles.filter((p) => p.site === id);
        const info = infos.find((i) => i.site === id);
        return (
          <div key={id} className="profile-group">
            <div className="group-head">
              <SiteTag site={id} /> <b>{SITES[id].name}</b> <span className="muted">{mine.length}개</span>
              {SITES[id].oneTaskPerProfile && <span className="muted small">· 프로필 하나로 태스크 하나만 동시에 돕니다</span>}
            </div>
            <div className="profile-cards">
              {mine.map((p) => (
                <ProfileCard
                  key={p.id} p={p} assigned={tasks.filter((t) => t.profileId === p.id).length}
                  users={profileUsers(p.id, tasks, runtimes, monitors, { scheduled: true })}
                  logOpen={selected === loginLog(p.id)}
                  onLogin={() => onLogin(p.id)} onShowLog={() => onShowLog(loginLog(p.id))} onEdit={() => setModal({ edit: p })}
                  onPin={() => onPin(p.id)}
                  onUpsert={onUpsert} onDeleted={onChanged}
                />
              ))}
              {!mine.length && <div className="empty-card muted">{SITES[id].name} 프로필이 없습니다 — <b>+ 새 프로필</b> 로 만드세요.</div>}
            </div>
            {info && (
              <PinRow
                site={id} info={info} onShowLog={() => onShowLog(siteLog(id))}
                onSetPin={async (pin) => onInfos(await aio.setPin(id, pin))}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * 프로필 만들기·고치기 창 (이름 · 사이트 · 메모). 사이트는 만들 때만 고른다 — 사이트마다 로그인 정보의 꼴이 달라
 * (롯데 쿠키 한 줄 · 네이버 세션 파일) 바꿀 수 없다. 만들고 나면 곧바로 로그인할지 묻는다.
 */
function ProfileModal({ edit, site: first, profiles, onSaved, onLogin, onClose }: {
  /** 고칠 프로필. null 이면 새로 만든다. */
  edit: Profile | null;
  /** 새로 만들 때 처음 골라 둘 사이트. */
  site: SiteId;
  profiles: Profile[];
  onSaved: (p: Profile) => void;
  onLogin: (id: string) => void;
  onClose: () => void;
}) {
  const [site, setSite] = useState<SiteId>(edit?.site ?? first);
  const [name, setName] = useState(edit?.name ?? "");
  const [memo, setMemo] = useState(edit?.memo ?? "");
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  /** 방금 만든 프로필 — 로그인할지 묻는 중. */
  const [created, setCreated] = useState<Profile | null>(null);
  const count = profiles.filter((p) => p.site === site).length;

  const save = async () => {
    setBusy(true);
    setFail(null);
    try {
      if (edit) {
        onSaved(await aio.updateProfile(edit.id, { name, memo }));
        onClose();
      } else {
        const p = await aio.createProfile(site, name, memo);
        onSaved(p);
        setCreated(p);
      }
    } catch (e) {
      setFail(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="modal-back" onClick={onClose}>
        <div className="modal narrow-modal" onClick={(e) => e.stopPropagation()}>
          <h2>새 프로필</h2>
          <p className="modal-text">'{created.name}' 프로필이 생성되었습니다. 지금 로그인할까요?</p>
          <p className="muted small modal-text">{LOGIN_HOW[created.site]} 5분 안에 로그인하지 않으면 창이 닫힙니다.</p>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>나중에</button>
            <button type="button" className="btn primary" autoFocus onClick={() => {
              onLogin(created.id);
              onClose();
            }}>로그인</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <form
        className="modal narrow-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void save();
        }}
      >
        <h2>{edit ? "프로필 고치기" : "새 프로필"}</h2>
        <label>
          프로필 이름
          <input
            autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder={edit ? "" : `비우면 '${SITES[site].name} ${count + 1}'`}
          />
        </label>
        <div className="modal-field">
          사이트
          {edit ? (
            <div className="static">
              <SiteTag site={site} /> {SITES[site].name}
              <span className="muted small">— 바꿀 수 없습니다 (사이트마다 로그인 정보의 꼴이 다릅니다)</span>
            </div>
          ) : (
            <div className="segmented">
              {SITE_IDS.map((id) => (
                <button key={id} type="button" className={`${id} ${site === id ? "on" : ""}`} onClick={() => setSite(id)}>{SITES[id].name}</button>
              ))}
            </div>
          )}
        </div>
        <label>
          메모 <span className="muted">(선택 — 어느 계정인지: 개인 계정 · 아이디 …)</span>
          <input value={memo} maxLength={100} onChange={(e) => setMemo(e.target.value)} />
        </label>
        {fail && <span className="err small">{fail}</span>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>취소</button>
          <button type="submit" className="btn primary" disabled={busy}>{edit ? "저장" : "만들기"}</button>
        </div>
      </form>
    </div>
  );
}

/** 로그인 창이 어떻게 뜨나 — 롯데는 매니저가 창을 띄우고, 네이버는 원본 --login 이 띄운다. */
const LOGIN_HOW: Record<SiteId, string> = {
  supreme: "로그인 없이도 살 수 있습니다(게스트 체크아웃). 창을 띄우면 사람 확인(Cloudflare)·hCaptcha 를 직접 통과해 주세요 — 통과한 쿠키가 태스크로 넘어갑니다.",
  lotte: "로그인 창이 뜨면 창 안에서 직접 로그인하세요 (캡차·2단계 인증 포함).",
  naver: "원본의 로그인 창(--login)이 뜨면 창 안에서 직접 로그인하세요.",
  bnkr: "로그인 창이 뜨면 창 안에서 직접 로그인하세요 (reCAPTCHA 포함). 토큰이 한 시간짜리라 오래 두었으면 다시 로그인하세요.",
};

function ProfileCard({ p, assigned, users, logOpen, onLogin, onShowLog, onEdit, onPin, onUpsert, onDeleted }: {
  p: Profile;
  /** 이 프로필을 고른 태스크 수. */
  assigned: number;
  /** 이 프로필로 지금 도는(예약 포함) 태스크·모니터. */
  users: string[];
  logOpen: boolean;
  onLogin: () => void; onShowLog: () => void; onEdit: () => void; onPin: () => void;
  onUpsert: (p: Profile) => void; onDeleted: (list: Profile[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const loggingIn = p.loginStatus === "logging_in";
  // 로그인 정보가 없으면 main 이 logged_out 으로 보낸다 — 그 밖(로그인됨·만료·확인 못 함)은 파일이 있다.
  const stored = p.loginStatus !== "logged_out" && !loggingIn;

  /** main 이 거절하면(돌고 있는 태스크가 있다 따위) 카드에 적는다. */
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setFail(null);
    try {
      await fn();
    } catch (e) {
      setFail(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const note = assigned ? `\n이 프로필을 고른 태스크 ${assigned}개는 프로필 없음으로 돌아갑니다.` : "";
    if (!(await aio.ask(`'${p.name}' 프로필을 지울까요? 로그인 정보와 프로필 폴더가 지워집니다.${note}`))) return;
    void act(async () => onDeleted(await aio.deleteProfile(p.id)));
  };
  const logout = async () => {
    if (!(await aio.ask(`'${p.name}' 에서 로그아웃할까요? 프로필 폴더의 로그인 정보를 지웁니다.`))) return;
    void act(async () => onUpsert(await aio.logoutProfile(p.id)));
  };
  const toggle = () => {
    // 쓰는 중이면 main 도 거절하지만, 까닭을 먼저 보인다.
    if (p.isActive && users.length) {
      setFail(`사용 중이라 끌 수 없습니다 (${users.join(", ")}) — 멈춘 뒤 끄세요.`);
      return;
    }
    void act(async () => onUpsert(await aio.updateProfile(p.id, { isActive: !p.isActive })));
  };

  return (
    <div className={`profile-card ${logOpen ? "sel" : ""} ${p.isActive ? "" : "inactive"}`}>
      <div className="card-top">
        <b className="grow">{p.name}</b>
        {!p.isActive && <span className="pill">꺼짐</span>}
        <span className={`pill login ${p.loginStatus}`}>{LOGIN_LABEL[p.loginStatus]}</span>
      </div>
      {p.memo && <div className="small memo">{p.memo}</div>}
      <div className="muted small">{p.statusNote}</div>
      <div className="muted small">
        마지막 로그인 {when(p.lastLoginAt)} · 마지막 확인 {when(p.lastCheckedAt)}{p.sessionExpiry && ` · 만료 ${when(p.sessionExpiry)}`}
      </div>
      {users.length > 0
        ? <div className="small in-use">현재 사용 중: {users.join(" · ")}</div>
        : <div className="muted small">고른 태스크 {assigned}개 · 지금 쓰는 곳 없음</div>}
      <div className="small pin-line">
        <span className="muted">결제 비밀번호</span>
        {p.hasPaymentPin ? <span className="ok">설정됨</span> : <span className="warn-text">미설정 — 결제 단계에서 사람이 넣습니다</span>}
        <button type="button" className="btn small ghost" disabled={busy} onClick={onPin}>{p.hasPaymentPin ? "바꾸기" : "넣기"}</button>
      </div>
      <div className="muted small path" title={p.cookiesPath}>{p.cookiesPath}</div>
      <div className="account-actions">
        {loggingIn ? (
          <button type="button" className="btn small ghost" onClick={() => void aio.cancelLogin(p.id)}>로그인 취소</button>
        ) : p.loginStatus === "logged_in" ? null : (
          <button type="button" className="btn small primary" disabled={busy} onClick={onLogin}>
            {stored ? "다시 로그인" : "로그인"}
          </button>
        )}
        {stored && (
          <>
            <button type="button" className="btn small" disabled={busy} title="원본 --whoami 로 로그인이 살아 있는지 묻습니다" onClick={() => {
              onShowLog();
              void act(async () => onUpsert(await aio.verifyProfile(p.id)));
            }}>확인</button>
            <button type="button" className="btn small ghost" disabled={busy} onClick={logout}>로그아웃</button>
          </>
        )}
        <span className="grow" />
        <button
          type="button" className="btn small ghost" disabled={busy || loggingIn} onClick={toggle}
          title={p.isActive ? "끄면 태스크 폼에서 고를 수 없습니다 (이미 고른 태스크는 그대로)" : "다시 태스크 폼에서 고를 수 있게 합니다"}
        >{p.isActive ? "끄기" : "켜기"}</button>
        <button type="button" className="icon" title="로그 보기" onClick={onShowLog}>≡</button>
        <button type="button" className="icon" title="고치기 (이름 · 메모)" disabled={busy} onClick={onEdit}>✎</button>
        <button type="button" className="icon" title="지우기" disabled={busy || loggingIn} onClick={remove}>✕</button>
      </div>
      {fail && <span className="err small">{fail}</span>}
    </div>
  );
}

/**
 * 프로필의 결제 비밀번호 창. 숫자 6자리를 두 번 받아 맞으면 main 이 암호화해 프로필 폴더에 적는다. 값은 이 창의
 * 입력칸에만 있다가 저장하면 비우고 창째로 닫는다 — main 은 돌려주지 않는다 (있나 없나만 안다).
 */
function PinModal({ profile, info, onSaved, onClose }: {
  profile: Profile; info: SiteInfo | undefined; onSaved: (p: Profile) => void; onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState({ pin: false, again: false });
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const digitsOnly = (v: string) => v.replace(/\D/g, "").slice(0, PAYMENT_PIN_DIGITS);
  const problem = !pin ? null
    : pin.length !== PAYMENT_PIN_DIGITS ? `${PAYMENT_PIN_DIGITS}자리를 넣어 주세요 (지금 ${pin.length}자리).`
    : again && again !== pin ? "확인 칸과 다릅니다."
    : null;
  const ready = pin.length === PAYMENT_PIN_DIGITS && again === pin;

  const act = async (fn: () => Promise<Profile>) => {
    setBusy(true);
    setFail(null);
    try {
      const p = await fn();
      setPin("");
      setAgain("");
      onSaved(p);
      onClose();
    } catch (e) {
      setFail(errText(e));
      setBusy(false);
    }
  };

  const field = (label: string, key: "pin" | "again", value: string, set: (v: string) => void, first = false) => (
    <label>
      {label}
      <div className="pin-field">
        <input
          type={show[key] ? "text" : "password"} inputMode="numeric" autoComplete="off" autoFocus={first}
          maxLength={PAYMENT_PIN_DIGITS} value={value} onChange={(e) => set(digitsOnly(e.target.value))}
        />
        <button
          type="button" className="icon" title={show[key] ? "가리기" : "보기"}
          onClick={() => setShow((s) => ({ ...s, [key]: !s[key] }))}
        >{show[key] ? "🙈" : "👁"}</button>
      </div>
    </label>
  );

  return (
    <div className="modal-back" onClick={onClose}>
      <form
        className="modal narrow-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void act(() => aio.setProfilePin(profile.id, pin));
        }}
      >
        <h2>결제 비밀번호</h2>
        <div className="static"><SiteTag site={profile.site} /> {profile.name}{profile.memo && <span className="muted"> · {profile.memo}</span>}</div>
        <p className="muted small modal-text">
          지금 {profile.hasPaymentPin ? "저장돼 있습니다" : "없습니다"}. 그 계정의 간편결제 비밀번호 {PAYMENT_PIN_DIGITS}자리를 넣으세요.
        </p>
        {field("비밀번호", "pin", pin, setPin, true)}
        {field("확인", "again", again, setAgain)}
        {problem && <span className="err small">{problem}</span>}
        {info && <p className="hint">이 프로필의 "결제 단계까지" 태스크가 {info.pin.effect}.</p>}
        <p className="muted small modal-text">
          암호화해서 이 프로필 폴더에만 저장합니다 (이 PC 의 이 윈도 계정에서만 풀립니다). 로그·화면에는 나오지 않고, 태스크를 띄울
          때만 풀어 원본에 넘깁니다. 돌고 있는 태스크는 다시 시작할 때부터 씁니다.
        </p>
        {fail && <span className="err small">{fail}</span>}
        <div className="modal-actions">
          {profile.hasPaymentPin && (
            <button
              type="button" className="btn ghost" disabled={busy}
              onClick={() => void aio.ask(`'${profile.name}' 의 결제 비밀번호를 지울까요? 결제 단계에서 사람이 넣어야 합니다.`)
                .then((ok) => { if (ok) void act(() => aio.clearProfilePin(profile.id)); })}
            >지우기</button>
          )}
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={onClose}>취소</button>
          <button type="submit" className="btn primary" disabled={!ready || busy}>저장</button>
        </div>
      </form>
    </div>
  );
}

/** ▶ 를 눌렀는데 결제 비밀번호가 쓰일 태스크의 프로필에 비밀번호가 없다. 실패하는 것은 아니다 — 사람이 넣으면 된다. */
function PinAskModal({ profile, onSetPin, onStart, onClose }: {
  profile: Profile; onSetPin: () => void; onStart: () => void; onClose: () => void;
}) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal narrow-modal" onClick={(e) => e.stopPropagation()}>
        <h2>결제 비밀번호가 없습니다</h2>
        <p className="modal-text">
          '{profile.name}' 프로필에 결제 비밀번호가 설정되지 않았습니다. 이 태스크는 결제 단계까지 가므로, 그때 사람이 넣어야 합니다.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>취소</button>
          <button type="button" className="btn" onClick={onStart}>그래도 시작</button>
          <button type="button" className="btn primary" autoFocus onClick={onSetPin}>결제 비밀번호 넣기</button>
        </div>
      </div>
    </div>
  );
}

const ROOT_HINT: Record<SiteId, string> = {
  supreme: "원본 프로젝트 (aio/node) — dist/supreme/index.js 를 들인다 (Shopify 표준 목록·cart/add.js 로 담는다)",
  lotte: "원본 프로젝트 (aio/node) — dist/lotte-test/index.js 를 들인다",
  naver: "원본 프로젝트 (naver/ts) — src/cli.ts 를 tsx 로 들인다",
  bnkr: "원본 프로젝트 (aio/node) — dist/bnkr-test/index.js 를 들인다",
};

function SettingsForm({ infos, profiles, preparing, onPrepare, onSaved, onClose }: {
  infos: SiteInfo[];
  profiles: Profile[];
  preparing: SiteId | null;
  onPrepare: (site: SiteId) => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => void aio.getSettings().then(setS), []);
  if (!s) return null;
  const setSite = (id: SiteId, key: "root" | "seed", value: string) =>
    setS({ ...s, sites: { ...s.sites, [id]: { ...s.sites[id], [key]: value } } });
  const webhookOk = !s.discordWebhookUrl.trim() || isDiscordWebhook(s.discordWebhookUrl);

  return (
    <div className="modal-back" onClick={onClose}>
      <form
        className="modal wide"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!webhookOk) return;
          await aio.saveSettings(s);
          onSaved();
          onClose();
        }}
      >
        <h2>설정</h2>
        <WebhookBox infos={infos} value={s.discordWebhookUrl} ok={webhookOk} onChange={(v) => setS({ ...s, discordWebhookUrl: v })} />
        {SITE_IDS.map((id) => {
          const info = infos.find((i) => i.site === id);
          const mine = profiles.filter((p) => p.site === id);
          const loggedIn = mine.filter((p) => p.loginStatus === "logged_in").length;
          return (
            <fieldset key={id} className="site-box">
              <legend><SiteTag site={id} /> {SITES[id].name}</legend>
              <label>
                {ROOT_HINT[id]}
                <input value={s.sites[id].root} onChange={(e) => setSite(id, "root", e.target.value)} />
              </label>
              <label>
                씨앗 설정 <span className="muted">(태스크마다 베끼고 대상만 바꾼다)</span>
                <input value={s.sites[id].seed} onChange={(e) => setSite(id, "seed", e.target.value)} />
              </label>
              {info && (
                <ul className="checks">
                  <li className={info.entryExists ? "ok" : "err"}>{info.entryExists ? "✔" : "✖"} 원본 {info.entry}</li>
                  <li className={info.seedExists ? "ok" : "muted"}>{info.seedExists ? "✔" : "–"} 씨앗 설정</li>
                  <li className={loggedIn ? "ok" : "muted"}>
                    {loggedIn ? "✔" : "–"} 로그인 프로필 {mine.length}개 · 로그인됨 {loggedIn}개 <span className="muted">(프로필 화면에서)</span>
                  </li>
                  {[...info.problems, ...info.warnings].map((p) => <li key={p} className="err">{p}</li>)}
                  {info.notes.map((n) => <li key={n} className="muted">{n}</li>)}
                </ul>
              )}
              {info?.prepare && (
                <div>
                  <button type="button" className="btn small ghost" disabled={preparing !== null} onClick={() => onPrepare(id)}>
                    {preparing === id ? "하는 중…" : info.prepare}
                  </button>
                </div>
              )}
            </fieldset>
          );
        })}
        <p className="muted small">
          쿠키·간편결제 비밀번호는 태스크 폴더에 복사하지 않고 환경변수로만 넘깁니다
          (LOTTEON_COOKIE · LOTTEON_PG_PASSWORD · NAVER_PG_PASSWORD). 네이버 세션은 원본이 읽는 자리를 워커가 프로필
          폴더의 파일로 돌립니다. 경로를 바꾸면 저장한 뒤 다음 시작부터 적용됩니다.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>닫기</button>
          <button type="submit" className="btn primary" disabled={!webhookOk}>저장</button>
        </div>
      </form>
    </div>
  );
}

/**
 * 간편결제 비밀번호 (사이트 공통 — 원본 설정 파일에 하나다). 값은 원본 설정 파일에만 있고 화면에는 자릿수만
 * 온다. 적고 지우는 것은 원본 --pin 이 한다 (콘솔에서 넣는 것과 같은 자리). 태스크에는 환경변수로 넘어간다.
 */
function PinRow({ site, info, onSetPin, onShowLog }: {
  site: SiteId; info: SiteInfo; onSetPin: (pin: string | null) => Promise<void>; onShowLog: () => void;
}) {
  const pin = info.pin;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const digits = value.replace(/\D/g, "");
  const run = async (next: string | null) => {
    setBusy(true);
    setMsg(null);
    try {
      await onSetPin(next);
      setValue("");
      setMsg({ ok: true, text: next === null ? "지웠습니다." : `저장했습니다 (${next.length}자리).` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pin-box">
      <div className="account-row">
        <span className="muted">
          콘솔용 간편결제 비밀번호 <span className="small">(원본을 직접 돌릴 때만 — 원본 설정 파일에 하나. 태스크는 프로필의 결제 비밀번호를 씁니다)</span>
        </span>
        <b>{pin.digits ? `${pin.digits}자리 저장됨` : "없음"}</b>
        {pin.fromEnv && <span className="warn-text small">환경변수 {pin.fromEnv} 에서 옵니다 — 여기서 바꿔도 환경변수가 먼저 쓰입니다</span>}
        <span className="grow" />
        <button type="button" className="icon" title="로그 보기" onClick={onShowLog}>≡</button>
      </div>
      <p className="pin-effect small">
        원본을 직접 "결제 단계까지" 로 돌리면 {pin.digits ? "지금" : "넣었을 때"} {pin.effect}.
      </p>
      <div className="account-actions">
        <input
          type="password" inputMode="numeric" autoComplete="off" placeholder="숫자만" maxLength={12} value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="button" className="btn small" disabled={busy || !digits} onClick={() => void run(digits)}>
          {pin.digits ? "바꾸기" : "저장"}
        </button>
        <button
          type="button" className="btn small ghost" disabled={busy || !pin.digits}
          onClick={() => void aio.ask(`${SITES[site].name} 간편결제 비밀번호를 원본 설정에서 지울까요?`).then((ok) => { if (ok) void run(null); })}
        >
          지우기
        </button>
      </div>
      {msg && <p className={`small ${msg.ok ? "ok" : "err"}`}>{msg.text}</p>}
    </div>
  );
}

const SOURCE_LABEL = { shared: "공통 웹훅", seed: "씨앗 설정", borrowed: "빌려 씀", none: "없음" } as const;

/** 두 사이트 공통 디스코드 웹훅. 원본 설정은 고치지 않고, 태스크를 띄울 때 태스크 설정에 넣는다. */
function WebhookBox({ infos, value, ok, onChange }: {
  infos: SiteInfo[]; value: string; ok: boolean; onChange: (v: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await aio.testWebhook(value.trim()));
    } finally {
      setTesting(false);
    }
  };
  return (
    <fieldset className="site-box">
      <legend>디스코드 웹훅 <span className="muted">— 두 사이트 공통</span></legend>
      <label>
        웹훅 주소 <span className="muted">(비워 두면 사이트마다 씨앗 설정의 웹훅)</span>
        <div className="account-actions">
          <input
            className="grow" type={reveal ? "text" : "password"} value={value} autoComplete="off"
            placeholder="https://discord.com/api/webhooks/…" onChange={(e) => onChange(e.target.value)}
          />
          <button type="button" className="btn small ghost" onClick={() => setReveal(!reveal)}>{reveal ? "가리기" : "보기"}</button>
          <button type="button" className="btn small" disabled={!value.trim() || !ok || testing} onClick={() => void test()}>
            {testing ? "보내는 중…" : "보내 보기"}
          </button>
        </div>
        {!ok && <span className="err">디스코드 웹훅 주소 모양이 아닙니다 (https://discord.com/api/webhooks/…).</span>}
        {result && <span className={result.ok ? "ok" : "err"}>{result.message}</span>}
      </label>
      <ul className="checks">
        {infos.map((i) => (
          <li key={i.site} className={i.webhook.source === "none" ? "err" : "muted"}>
            {SITES[i.site].name} 알림 → {SOURCE_LABEL[i.webhook.source]}
            {i.webhook.source !== "none" && ` (${i.webhook.from}) …${i.webhook.tail}`}
          </li>
        ))}
      </ul>
      <p className="muted small">
        원본 설정 파일은 고치지 않습니다. 태스크를 띄울 때 태스크 설정에 넣어 원본이 이리로 보내게 합니다 — 콘솔에서 돌리는
        원본은 지금처럼 제 설정의 웹훅을 씁니다. 저장한 뒤 새로 띄우는 태스크부터 적용됩니다. 무엇을 보낼지는 원본이 정합니다
        (롯데 discord_notify · 네이버 buy.notify).
      </p>
    </fieldset>
  );
}
