/**
 * 태스크를 워커 프로세스로 띄우고, 상태와 로그를 모은다.
 *
 * **사이트를 모른다.** 태스크의 site 로 어댑터(sites/)를 고르고, 어댑터가 돌려준 것
 * (진입점·인자·환경변수·돌릴 파일)을 그대로 워커에 넘긴다.
 *
 * 태스크끼리 나누는 것이 없다. 태스크마다
 *   - 따로 fork 한 프로세스 (하나가 터져도 앱과 다른 태스크는 산다. 원본의 전역 변수도 안 섞인다)
 *   - 따로 태스크 홈 폴더 (설정·산 기록·로그·결제창 받아쓰기가 섞이지 않는다)
 * 를 준다. main 과 워커가 주고받는 것은 IPC 메시지와 표준출력뿐이다.
 *
 * 돌던 중에 태스크를 고치면 (save)
 *   - 원본이 실행 중에 다시 읽는 칸만 바뀌었으면 태스크 홈의 설정만 고쳐 쓴다 (롯데 targets)
 *   - 아니면 다시 시작한다. 구매 중이거나 구매 창이 열려 있으면 그게 끝날 때까지 미룬다
 *
 * 로그인은 태스크가 고른 프로필(profileOf)의 것으로 돈다. 프로필 폴더를 어댑터에 넘기면 어댑터가
 * 원본에 넘길 꼴(롯데 쿠키 환경변수 · 네이버 세션 경로 돌리기)로 바꾼다. 결제 비밀번호도 그 프로필 것을 띄우기
 * 직전에 풀어(pinOf) 환경변수로 넘긴다 — 없으면 빈 값.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIELD_LABEL, MODE_LABEL, modesOf, pinMatters, planDrop, PREPARE_LOG, REPEATING_MODES, SITE_IDS, SITES, TIMING_BLANK } from "../shared/sites.js";
import type {
  CommonSettings, LogLine, MainMessage, Settings, SiteId, SiteInfo, TaskDef, TaskRuntime, WorkerMessage,
} from "../shared/types.js";
import { eachLine, forkLegacy } from "./legacy.js";
import type { ProfileRef } from "./sessions.js";
import { ADAPTERS, type SiteAdapter } from "./sites/index.js";

const LOG_KEEP = 2000;
/** 강제 종료를 보내고 이만큼 기다려도 안 끝나면 죽인다. */
const FORCE_GRACE_MS = 3000;
/** 기다리는 사이트(네이버)를 멈췄는데 이만큼 지나도 안 끝나면 왜 그런지 적어 준다. */
const WAIT_HINT_MS = 4000;
/** 다시 시작을 미뤄 둔 동안 구매가 끝났는지 이만큼마다 본다. */
const BUSY_POLL_MS = 500;
/**
 * 드랍 예약이 띄울 때가 됐는지 이만큼마다 본다. 긴 setTimeout 하나로 두지 않는다 — PC 가 잠들었다
 * 깨면 타이머가 밀리는데, 시계를 자주 보면 깨자마자 알아챈다.
 */
const SCHEDULE_TICK_MS = 500;

interface Slot {
  child: ChildProcess | null;
  rt: TaskRuntime;
  logs: LogLine[];
  /** 원본이 exit 를 청했나. 청 없이 끝났으면 터진 것이다. */
  exitRequest: number | null;
  stopRequested: boolean;
  /** 감시 시간이 다 돼서 우리가 멈췄나. 그러면 사람이 멈춘 것이 아니라 정한 대로 끝난 것이다. */
  expired: boolean;
  /** 설정이 바뀌어 다시 시작하려고 우리가 멈추는 중인가. 끝나면 곧바로 다시 띄운다. */
  restarting: boolean;
  /** 원본이 구매를 시작한다고 말한 때. 원본이 산 기록을 다시 적을 때까지 구매 중으로 본다. */
  busySince: number | null;
  /** 감시 시간을 재기 시작한 때. 설정이 바뀌어 다시 시작해도 이어서 잰다. */
  monitorStartedAt: number | null;
  timers: NodeJS.Timeout[];
  /** 드랍 예약. 프로세스가 생기기 전이라 timers 와 따로 둔다 (timers 는 프로세스가 끝날 때 치운다). */
  schedule: NodeJS.Timeout | null;
  /** 원본의 제자리 상태 줄에서 마지막으로 읽은 "다음 확인 N초". 다시 올라가면 한 바퀴 돈 것이다. */
  countdown: number | null;
}

/** 태스크 파일에서 읽었거나 화면에서 온 태스크에 나중에 생긴 칸을 채운다. */
function normalize(t: Partial<TaskDef>): TaskDef {
  // 프로필 칸은 0.3 에 생겼다. 비었으면(화면의 "없음") 칸째로 뺀다. 결제 로그인 프로필도 같다.
  const { profileId, payProfileId, ...rest } = t;
  return {
    ...TIMING_BLANK,
    ...rest,
    ...(profileId ? { profileId } : {}),
    ...(payProfileId ? { payProfileId } : {}),
    dropSettings: { ...TIMING_BLANK.dropSettings, ...t.dropSettings },
    site: t.site && t.site in ADAPTERS ? t.site : "lotte",
  } as TaskDef;
}

function clockOf(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  const day = d.toDateString() === new Date().toDateString() ? "오늘" : `${d.getMonth() + 1}/${d.getDate()}`;
  return `${day} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  return m >= 1 ? `${Number.isInteger(m) ? m : m.toFixed(1)}분` : `${Math.round(ms / 1000)}초`;
}

/** 표·로그에 쓰는 태스크 이름. */
const nameOf = (t: TaskDef): string => t.label || SITES[t.site].productCode(t.url);

/**
 * 사이트를 두드리고 있는 것 하나 — 도는 태스크나 모니터. 네이버 요청률 합과 "한 프로필에 하나" 를 태스크와
 * 모니터가 같이 본다 (같은 IP·같은 로그인 세션으로 요청한다).
 */
export interface LiveUse {
  /** 로그·경고에 쓰는 이름 — "태스크 #03 운동화 270" · "모니터 운동화 270". */
  label: string;
  site: SiteId;
  profileId?: string;
  /** 분당 요청. 한 번 보고 끝나는 것은 0. */
  perMin: number;
}

/**
 * 원본이 줄 앞에 붙이는 시각. 로그 창이 제 시각을 따로 찍으니 뗀다.
 *   네이버 log.ts  "2026-09-26 17:55:37 [INFO] …"
 *   롯데 ui.ts     "17:55:37  ✔  …" — 시각만 뗀다. 뒤의 표시(✔ · ! ✖ ★)는 뜻이 있다
 */
const STAMP = /^(?:\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (?:\[INFO\] )?|\d\d:\d\d:\d\d {2})/;

function readTasks(path: string): TaskDef[] {
  try {
    const raw = (JSON.parse(readFileSync(path, "utf-8")) as { tasks?: Partial<TaskDef>[] }).tasks ?? [];
    // 0.1 의 태스크는 롯데 하나뿐이라 site 가 없고, 간격·재시도·드랍 칸은 그 뒤에 생겼다.
    return raw.map(normalize);
  } catch {
    return [];
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 이벤트
 *   "runtime"      (rt: TaskRuntime)
 *   "log"          (line: LogLine)
 *   "tasks"        (tasks: TaskDef[]) — 태스크 목록을 고쳐 적었다
 *   "sessionDead"  (profileId: string, line: string) — 태스크 출력에 "세션이 끊겼다" 가 보였다
 */
export class TaskManager extends EventEmitter {
  private tasks: TaskDef[] = [];
  private slots = new Map<string, Slot>();
  private seq = 0;

  constructor(
    private readonly dataDir: string,
    private readonly workerPath: string,
    private settings: Settings,
    /** 로그인 프로필을 찾는다 (SessionManager). 없으면 null. */
    private readonly profileOf: (id: string) => ProfileRef | null,
    /** 그 프로필의 결제 비밀번호를 푼다 (SessionManager.paymentPin). 띄우기 직전에만 부른다. 없으면 "", 못 풀면 던진다. */
    private readonly pinOf: (profileId: string) => string,
    /** 그 프로필의 자동 로그인 이메일·비밀번호를 푼다 (SessionManager.loginCredentials). 띄우기 직전에만. 없으면 null, 못 풀면 던진다. */
    private readonly credsOf: (profileId: string) => { email: string; password: string } | null,
    /** 태스크 밖에서 사이트를 두드리는 것 (도는 모니터). 요청률 합과 "한 프로필에 하나" 에 같이 센다. */
    private readonly outside: () => LiveUse[] = () => [],
  ) {
    super();
    mkdirSync(this.homesDir, { recursive: true });
    this.tasks = readTasks(this.tasksPath);
  }

  // ── 경로 ────────────────────────────────────────────────────────────────

  private get tasksPath(): string {
    return join(this.dataDir, "tasks.json");
  }
  private get homesDir(): string {
    return join(this.dataDir, "task-homes");
  }
  homeOf(id: string): string {
    return join(this.homesDir, id);
  }

  private adapterOf(task: TaskDef): SiteAdapter {
    return ADAPTERS[task.site];
  }

  // ── 설정 · 태스크 목록 ───────────────────────────────────────────────────

  setSettings(s: Settings): void {
    this.settings = s;
  }

  settingsOf(site: SiteId) {
    return this.settings.sites[site];
  }

  common(): CommonSettings {
    return { webhook: (this.settings.discordWebhookUrl ?? "").trim() };
  }

  sitesInfo(): SiteInfo[] {
    return SITE_IDS.map((id) => ADAPTERS[id].info(this.settings.sites[id], this.common()));
  }

  list(): TaskDef[] {
    return this.tasks;
  }

  save(input: TaskDef): TaskDef[] {
    // 빠진 간격·재시도·드랍 칸은 씨앗 설정을 따르게 채운다 — 어댑터는 null 만 "비움" 으로 본다.
    const task = normalize(input);
    const at = this.tasks.findIndex((t) => t.id === task.id);
    const prev = at >= 0 ? this.tasks[at] : undefined;
    if (at >= 0) this.tasks[at] = task;
    else this.tasks.push(task);
    this.persist();
    if (prev && this.isLive(task.id)) this.applyToLive(prev, task);
    else if (prev && this.isScheduled(task.id)) this.rearm(task);
    return this.tasks;
  }

  remove(id: string): TaskDef[] {
    this.stop(id);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.slots.delete(id);
    this.persist();
    return this.tasks;
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.tasksPath, JSON.stringify({ tasks: this.tasks }, null, 2), "utf-8");
    this.emit("tasks", this.tasks);
  }

  /** 이 프로필로 돌고 있거나 예약된 태스크의 이름. 프로필을 지우거나 로그아웃하기 전에 본다. */
  busyWith(profileId: string): string[] {
    return this.tasks
      .filter((t) => (t.profileId === profileId || t.payProfileId === profileId) && (this.isLive(t.id) || this.isScheduled(t.id)))
      .map(nameOf);
  }

  /**
   * 프로필이 지워졌다. 그 프로필을 고른 태스크는 프로필 없음으로 돌린다 (띄울 때 고르라고 한다). 결제 로그인 프로필로
   * 고른 것이면 그 칸만 비운다 — 결제창 로그인은 사람이 한다.
   */
  forgetProfile(profileId: string): void {
    if (!this.tasks.some((t) => t.profileId === profileId || t.payProfileId === profileId)) return;
    this.tasks = this.tasks.map((t) => {
      if (t.profileId !== profileId && t.payProfileId !== profileId) return t;
      const { profileId: login, payProfileId: pay, ...rest } = t;
      return {
        ...rest,
        ...(login && login !== profileId ? { profileId: login } : {}),
        ...(pay && pay !== profileId ? { payProfileId: pay } : {}),
      };
    });
    this.persist();
  }

  // ── 상태 · 로그 ─────────────────────────────────────────────────────────

  private slot(id: string): Slot {
    let s = this.slots.get(id);
    if (!s) {
      s = {
        child: null, logs: [], exitRequest: null, stopRequested: false, expired: false,
        restarting: false, busySince: null, monitorStartedAt: null, timers: [], schedule: null, countdown: null,
        rt: {
          id, status: "idle", pid: null, startedAt: null, endedAt: null, exitCode: null, lastLine: "",
          note: "", rounds: 0, lastCheckAt: null, phase: null, queue: null,
          restartPending: false, scheduledFor: null, dropAt: null,
        },
      };
      this.slots.set(id, s);
    }
    return s;
  }

  runtimes(): TaskRuntime[] {
    return this.tasks.map((t) => this.slot(t.id).rt);
  }

  logs(id: string): LogLine[] {
    return this.slot(id).logs;
  }

  private update(id: string, patch: Partial<TaskRuntime>): void {
    const s = this.slot(id);
    s.rt = { ...s.rt, ...patch };
    this.emit("runtime", s.rt);
  }

  private push(id: string, stream: LogLine["stream"], raw: string): void {
    const s = this.slot(id);
    const text = raw.replace(STAMP, "");
    const line: LogLine = { seq: ++this.seq, taskId: id, at: Date.now(), stream, text };
    s.logs.push(line);
    if (s.logs.length > LOG_KEEP) s.logs.splice(0, s.logs.length - LOG_KEEP);
    this.emit("log", line);
    if (text.trim()) this.update(id, { lastLine: text.trim() });
  }

  /** 태스크가 아닌 것(계정 명령)의 출력도 같은 로그 창에 쌓는다. */
  appendLog(id: string, stream: LogLine["stream"], text: string): void {
    this.push(id, stream, text);
  }

  resetState(id: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    this.adapterOf(task).resetState(this.homeOf(id));
    this.push(id, "sys", "산 기록을 지웠습니다.");
  }

  // ── 띄우기 · 멈추기 ─────────────────────────────────────────────────────

  isLive(id: string): boolean {
    const s = this.slots.get(id);
    return !!s?.child && s.child.exitCode === null && s.child.signalCode === null;
  }

  hasLive(): boolean {
    return this.tasks.some((t) => this.isLive(t.id));
  }

  /**
   * 같은 사이트로 도는 태스크들의 분당 요청을 더해 본다. 프로필(계정)이 달라도 더한다 — 이 PC 에서
   * 나가는 요청은 IP 하나로 모인다.
   *
   * 원본의 요청률 안전장치는 프로세스 하나 안의 상품 수로만 센다. 태스크마다 프로세스를
   * 가르면 각자는 한도 아래인데 합치면 넘는다 — 그 합을 여기서 막는다.
   */
  private rateOf(task: TaskDef): { total: number; warn: boolean; refuse: boolean; hard: number; warnAt: number } | null {
    const a = this.adapterOf(task);
    if (!a.rate) return null;
    const s = this.settings.sites[task.site];
    const mine = a.rate.perMin(task, s);
    if (!mine) return null;
    const others = this.tasks
      .filter((t) => t.id !== task.id && t.site === task.site && this.isLive(t.id))
      .reduce((sum, t) => sum + a.rate!.perMin(t, s), 0);
    const monitors = this.outside().filter((u) => u.site === task.site).reduce((sum, u) => sum + u.perMin, 0);
    const total = others + monitors + mine;
    return { total, warn: total > a.rate.warn, refuse: total > a.rate.hard, hard: a.rate.hard, warnAt: a.rate.warn };
  }

  /** → 띄워도 되나 */
  private rateAllows(task: TaskDef): boolean {
    const r = this.rateOf(task);
    if (!r) return true;
    const name = SITES[task.site].name;
    if (r.refuse) {
      this.push(task.id, "sys",
        `시작하지 않습니다 — ${name} 태스크·모니터를 합치면 요청률이 ${r.total.toFixed(1)}회/분으로 거부선(${r.hard}회/분)을 넘습니다. ` +
        "돌고 있는 것을 멈추거나 태스크의 확인 간격을 늘리세요.");
      return false;
    }
    if (r.warn) {
      this.push(task.id, "sys",
        `주의 — ${name} 태스크·모니터 합계 요청률 ${r.total.toFixed(1)}회/분이 권장선(${r.warnAt}회/분)보다 높습니다. 로그인 세션이 막힐 수 있습니다.`);
    }
    return true;
  }

  /**
   * 이 태스크가 쓸 로그인 프로필. 띄울 수 없으면 error 에 까닭을 적는다.
   *   - 고른 프로필이 지워졌거나 다른 사이트 것이다
   *   - 프로필 없이 도는 모드가 아니다 (sites.ts 의 loginOptional)
   *   - 프로필이 로그인 중이다 (로그인 창이 떠 있다 — 끝나야 어느 로그인으로 돌지 정해진다)
   *   - 프로필에 로그인 정보가 없다
   *   - 한 프로필에 태스크 하나인 사이트(sites.ts 의 oneTaskPerProfile — 지금은 없다)에서, 그 프로필로 이미 다른 태스크가 돈다
   */
  private profileFor(task: TaskDef): { profile: ProfileRef | null; error: string | null } {
    const spec = SITES[task.site];
    const optional = spec.loginOptional.includes(task.mode);
    const without = spec.loginOptional.length
      ? `프로필 없이는 ${spec.loginOptional.map((m) => MODE_LABEL[m]).join("·")}만 돕니다`
      : `${spec.name}는 어느 모드도 로그인이 있어야 돕니다`;
    if (!task.profileId) {
      return { profile: null, error: optional ? null : `로그인 프로필을 고르지 않았습니다 — ✎ 로 태스크를 고쳐 프로필을 고르세요 (${without}).` };
    }
    const p = this.profileOf(task.profileId);
    if (!p) return { profile: null, error: "고른 로그인 프로필이 없습니다 (지워졌습니다) — ✎ 로 태스크를 고쳐 프로필을 다시 고르세요." };
    if (p.site !== task.site) return { profile: null, error: `'${p.name}' 은 ${SITES[p.site].name} 프로필입니다 — ✎ 로 프로필을 다시 고르세요.` };
    // 다시 로그인하는 중이면 예전 로그인 파일이 남아 있어 hasLogin 으로는 안 걸린다 — 상태로 막는다.
    if (p.loginStatus === "logging_in") {
      return { profile: null, error: `'${p.name}' 프로필이 로그인 중입니다 — 로그인을 끝내거나 취소한 뒤 다시 시작하세요.` };
    }
    // 자동 로그인 정보가 있으면 쿠키가 없어도 띄운다 — 원본이 크롬에서 로그인한다 (KREAM).
    if (!p.hasLogin && !optional && !p.hasLoginCredentials) {
      return { profile: null, error: `'${p.name}' 프로필에 로그인 정보가 없습니다 — 프로필 화면에서 로그인하세요.` };
    }
    if (spec.oneTaskPerProfile) {
      const other = this.tasks.find((t) => t.id !== task.id && t.profileId === p.id && this.isLive(t.id));
      if (other) {
        return {
          profile: null,
          error: `'${p.name}' 프로필로 이미 도는 태스크가 있습니다 (${nameOf(other)}) — ${spec.name}는 프로필 하나로 태스크 하나만 돌립니다 (로그인 세션째로 요청률을 봅니다).`,
        };
      }
      const monitor = this.outside().find((u) => u.site === task.site && u.profileId === p.id);
      if (monitor) {
        return {
          profile: null,
          error: `'${p.name}' 프로필은 이미 실행 중입니다 (${monitor.label} 실행 중) — 태스크를 시작하려면 모니터를 먼저 중지하세요.`,
        };
      }
    }
    return { profile: p, error: null };
  }

  /**
   * 결제창 로그인에 쓸 프로필 (sites.ts 의 payProfileSite — 반다이남코 네이버페이 → 네이버 프로필). 없거나 쓸 수
   * 없으면 null 이고 로그에 까닭을 적는다 — 띄우기는 한다. 결제창에서 사람이 로그인하면 되니 실패가 아니다.
   */
  private payProfile(task: TaskDef, id: string): ProfileRef | null {
    const site = SITES[task.site].payProfileSite;
    if (!site || !task.payProfileId) return null;
    const p = this.profileOf(task.payProfileId);
    const what = `${SITES[site].name} 결제 로그인`;
    if (!p || p.site !== site) {
      this.push(id, "sys", `${what} 프로필이 없습니다 (지워졌거나 다른 사이트 것) — 결제창 로그인은 사람이 합니다.`);
      return null;
    }
    if (!p.hasLogin || p.loginStatus === "logging_in") {
      this.push(id, "sys", `'${p.name}' 프로필에 로그인 정보가 없습니다 — 결제창 로그인은 사람이 합니다 (프로필 화면에서 로그인하세요).`);
      return null;
    }
    this.push(id, "sys", `${what}: '${p.name}' 프로필의 세션` +
      (p.loginStatus === "expired" ? " — 만료로 표시돼 있습니다. 원본이 안 된다고 하면 프로필 화면에서 다시 로그인하세요." : ""));
    return p;
  }

  /** 도는 태스크 — 모니터가 요청률 합과 "한 프로필에 하나" 를 볼 때 쓴다. */
  liveUses(): LiveUse[] {
    return this.tasks.flatMap((t, i) => {
      if (!this.isLive(t.id)) return [];
      const perMin = this.adapterOf(t).rate?.perMin(t, this.settings.sites[t.site]) ?? 0;
      const use: LiveUse = { label: `태스크 #${String(i + 1).padStart(2, "0")} ${nameOf(t)}`, site: t.site, perMin };
      return [t.profileId ? { ...use, profileId: t.profileId } : use];
    });
  }

  isScheduled(id: string): boolean {
    return !!this.slots.get(id)?.schedule;
  }

  hasScheduled(): boolean {
    return this.tasks.some((t) => this.isScheduled(t.id));
  }

  /** 예약된 태스크의 이름. 앱을 닫을 때 묻는 데 쓴다. */
  scheduledNames(): string[] {
    return this.tasks.filter((t) => this.isScheduled(t.id)).map(nameOf);
  }

  /**
   * ▶. 드랍 시각이 있는 드랍 태스크는 곧바로 띄우지 않고 **예약**한다 — 드랍 몇 분 전에 띄운다.
   * 원본 --drop 에는 시각이 없어서 매니저가 잰다.
   */
  start(id: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`없는 태스크입니다: ${id}`);
    if (this.isLive(id) || this.isScheduled(id)) return;
    if (task.mode === "drop" && task.dropSettings.dropTime.trim()) {
      // 예약해 두고 드랍 직전에야 "로그인이 없다" 로 끝나지 않게, 프로필은 지금 본다.
      const pf = this.profileFor(task);
      if (pf.error) {
        this.push(id, "sys", pf.error);
        this.update(id, { status: "failed" });
        return;
      }
      const plan = planDrop(task.dropSettings, Date.now());
      if (!plan) {
        this.push(id, "sys", `드랍 시각을 알아보지 못했습니다: '${task.dropSettings.dropTime}' — HH:mm:ss 로 적어 주세요.`);
        this.update(id, { status: "failed" });
        return;
      }
      if (plan.late) {
        this.push(id, "sys", `드랍 시각(${clockOf(plan.dropAt)})이 막 지났습니다 — 바로 드랍 모드로 띄웁니다.`);
      } else if (plan.startAt > Date.now() + SCHEDULE_TICK_MS) {
        this.arm(id, plan);
        return;
      } else {
        this.push(id, "sys", `드랍 ${clockOf(plan.dropAt)} — 미리 띄울 때가 이미 지나 바로 띄웁니다.`);
      }
    }
    this.launch(id, false);
  }

  private arm(id: string, plan: { dropAt: number; startAt: number }): void {
    const s = this.slot(id);
    const task = this.tasks.find((t) => t.id === id)!;
    s.schedule = setInterval(() => {
      if (Date.now() < plan.startAt) return;
      this.disarm(id);
      this.push(id, "sys", `드랍 ${task.dropSettings.preCheckMinutes}분 전 — 드랍 모드로 띄웁니다.`);
      this.launch(id, false);
    }, SCHEDULE_TICK_MS);
    this.update(id, { status: "scheduled", scheduledFor: plan.startAt, dropAt: plan.dropAt, endedAt: null });
    this.push(id, "sys", `예약: 드랍 ${clockOf(plan.dropAt)} · ${clockOf(plan.startAt)} 에 드랍 모드로 띄웁니다. 앱이 켜져 있어야 합니다.`);
  }

  /** 예약을 거둔다. → 예약이 있었나 */
  private disarm(id: string): boolean {
    const s = this.slots.get(id);
    if (!s?.schedule) return false;
    clearInterval(s.schedule);
    s.schedule = null;
    this.update(id, { scheduledFor: null });
    return true;
  }

  /** 예약된 태스크를 고쳤다. 드랍 시각이 남아 있으면 새로 잡고, 없어졌으면 예약을 거둔다. */
  private rearm(task: TaskDef): void {
    this.disarm(task.id);
    const plan = task.mode === "drop" && task.dropSettings.dropTime.trim() ? planDrop(task.dropSettings, Date.now()) : null;
    if (!plan || plan.late || plan.startAt <= Date.now()) {
      this.update(task.id, { status: "stopped", dropAt: null });
      this.push(task.id, "sys", "설정이 바뀌어 예약을 거뒀습니다 — ▶ 로 다시 시작하세요.");
      return;
    }
    this.push(task.id, "sys", "설정이 바뀌어 예약을 다시 잡습니다.");
    this.arm(task.id, plan);
  }

  /** @param again 설정이 바뀌어 다시 띄우는 것인가 (감시 시간을 이어서 잰다) */
  private launch(id: string, again: boolean): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`없는 태스크입니다: ${id}`);
    if (this.isLive(id)) return;

    if (!modesOf(task).includes(task.mode)) {
      this.push(id, "sys", SITES[task.site].modes.includes(task.mode)
        ? `${SITES[task.site].name} 키워드 태스크는 '${MODE_LABEL[task.mode]}' 로 돌 수 없습니다 — ${modesOf(task).map((m) => MODE_LABEL[m]).join(" · ")} 중에서 고르세요 (재고만 = 검색 결과 조회).`
        : `${SITES[task.site].name} 원본에는 '${task.mode}' 모드가 없습니다 — 모드를 바꿔 주세요.`);
      this.update(id, { status: "failed" });
      return;
    }
    const adapter = this.adapterOf(task);
    const settings = this.settings.sites[task.site];
    const info = adapter.info(settings, this.common());
    if (info.problems.length) {
      for (const p of info.problems) this.push(id, "sys", p);
      this.update(id, { status: "failed" });
      return;
    }
    const { profile, error } = this.profileFor(task);
    if (error) {
      this.push(id, "sys", error);
      this.update(id, { status: "failed" });
      return;
    }
    if (!this.rateAllows(task)) return;
    if (profile?.loginStatus === "expired") {
      this.push(id, "sys", `주의 — '${profile.name}' 프로필이 만료로 표시돼 있습니다. 원본이 세션을 거절하면 프로필 화면에서 다시 로그인하세요.`);
    }

    // 결제창 로그인 프로필 (반다이남코 네이버페이 → 네이버 프로필). 없거나 못 쓰면 null — 결제창에서 사람이 로그인한다.
    const pay = this.payProfile(task, id);

    // 결제 비밀번호는 프로필 것만 쓴다. 띄우기 직전에 풀어 환경변수로 넘기고 여기서는 들고 있지 않는다 (로그에는 자릿수만).
    // 결제창 로그인 프로필이 있으면 그 프로필 것이 먼저다 — 네이버페이 비밀번호는 네이버 계정의 것이다. 없으면 로그인 프로필 것.
    // 둘 다 없으면 원본이 결제창·인증 화면에서 사람을 기다린다 — 실패가 아니다.
    const pinFrom = pay?.hasPaymentPin ? pay : profile?.hasPaymentPin ? profile : null;
    let pin = "";
    if (pinFrom) {
      try {
        pin = this.pinOf(pinFrom.id);
      } catch (e) {
        this.push(id, "sys", `${(e as Error).message} 비밀번호 없이 띄웁니다.`);
      }
    }
    if (pinMatters(task, info.defaultAction)) {
      this.push(id, "sys", pin
        ? `결제 비밀번호: '${pinFrom!.name}' 프로필의 것 (${pin.length}자리)`
        : `결제 비밀번호가 없습니다 — 결제 단계에서 사람이 넣어야 합니다${pay ? ` ('${pay.name}' 프로필 카드의 "결제 비밀번호 넣기")` : ""}.`);
    }

    const home = this.homeOf(id);
    const payDir = pay?.dir ?? null;
    let launch;
    try {
      launch = adapter.launch(task, home, settings, this.common(), profile?.dir ?? null, pin, payDir);
    } catch (e) {
      this.push(id, "sys", `태스크 폴더를 준비하지 못했습니다: ${(e as Error).message}`);
      this.update(id, { status: "failed" });
      return;
    }

    // 자동 로그인 (KREAM) — 원본이 로그인이 풀린 것을 보면 이 이메일·비밀번호로 다시 로그인한다. 값은 환경변수로만.
    const names = adapter.session.credentials;
    if (names && profile?.hasLoginCredentials) {
      try {
        const creds = this.credsOf(profile.id);
        if (creds) {
          launch = { ...launch, env: { ...launch.env, [names.emailEnv]: creds.email, [names.passwordEnv]: creds.password } };
          this.push(id, "sys", `자동 로그인: '${profile.name}' 프로필의 이메일 — 로그인이 풀리면 원본이 다시 로그인합니다`);
        }
      } catch (e) {
        this.push(id, "sys", `${(e as Error).message} 자동 로그인 없이 띄웁니다.`);
      }
    }

    const s = this.slot(id);
    s.exitRequest = null;
    s.stopRequested = false;
    s.expired = false;
    s.restarting = false;
    s.busySince = null;
    s.countdown = null;
    if (!again || s.monitorStartedAt === null) s.monitorStartedAt = Date.now();

    const child = forkLegacy(this.workerPath, launch, home);
    s.child = child;
    this.update(id, {
      status: "starting", pid: child.pid ?? null, startedAt: Date.now(), endedAt: null, exitCode: null,
      restartPending: false, scheduledFor: null, note: "", phase: null, queue: null,
      // 설정이 바뀌어 다시 띄운 것이면 회차는 이어서 센다.
      ...(again ? {} : { rounds: 0, lastCheckAt: null }),
    });
    const who = profile ? ` · ${profile.name}` : " · 로그인 없이";
    this.push(id, "sys", `시작 (${SITES[task.site].name}${who} · pid ${child.pid}) · ${launch.args.filter((a) => !a.includes(home)).join(" ") || "지켜보기"}`);

    const onLine = (stream: "out" | "err") => (text: string) => {
      // 터미널에서처럼, 표준출력에 줄이 찍히면 제자리 상태 줄은 지워진다 (다음에 기다릴 때 원본이 다시 쓴다).
      if (stream === "out" && s.rt.note) this.update(id, { note: "" });
      this.push(id, stream, text);
      this.watchLine(task, s, text);
    };
    eachLine(child.stdout, onLine("out"), (text) => this.watchStatus(task, s, text));
    eachLine(child.stderr, onLine("err"));

    // 감시 시간. 원본에는 없는 것이라 여기서 잰다. 다 되면 Ctrl+C 와 같이 멈춘다 — 네이버 구매
    // 창이 열려 있으면 원본이 그 창을 기다리는 것도 그대로다 (시간이 다 됐다고 결제 창을 닫지 않는다).
    if (task.monitorDurationMs > 0 && REPEATING_MODES.includes(task.mode)) {
      const left = Math.max(0, task.monitorDurationMs - (Date.now() - s.monitorStartedAt));
      this.later(s, left, () => {
        if (s.child !== child || !this.isLive(id) || s.stopRequested) return;
        s.expired = true;
        this.push(id, "sys", `감시 시간 ${minutes(task.monitorDurationMs)}이 다 돼 멈춥니다.`);
        this.stop(id);
      });
    }

    child.on("message", (msg: WorkerMessage) => {
      if (msg.type === "READY") this.update(id, { status: "running" });
      else if (msg.type === "WORKER_EXIT_REQUEST") s.exitRequest = msg.code;
      else if (msg.type === "FATAL") this.push(id, "sys", `워커 오류: ${msg.message}`);
    });
    child.on("error", (e) => this.push(id, "sys", `프로세스 오류: ${e.message}`));
    child.on("exit", (code, signal) => {
      for (const t of s.timers) clearTimeout(t);
      s.timers = [];
      if (s.child === child) s.child = null;
      const status = s.stopRequested ? (s.expired ? "done" : "stopped")
        : s.exitRequest === null ? "crashed"
        : s.exitRequest === 0 ? "done" : "failed";
      this.push(id, "sys", `끝 · ${status} (code ${code ?? "-"}${signal ? `, ${signal}` : ""})`);
      const again = s.restarting;
      if (!again && s.rt.restartPending) {
        this.push(id, "sys", "태스크가 끝나서 다시 시작하지 않습니다 — 바뀐 설정은 다음 실행부터 씁니다.");
      }
      s.restarting = false;
      s.busySince = null;
      this.update(id, { status, pid: null, endedAt: Date.now(), exitCode: s.exitRequest ?? code, restartPending: false, note: "", queue: null });
      if (again) {
        this.push(id, "sys", "바뀐 설정으로 다시 시작합니다.");
        this.launch(id, true);
      }
    });
  }

  /** 태스크 출력 한 줄에서 알아 둘 것: 한 바퀴 봤나, 어느 단계인가, 구매를 시작했나, 로그인이 끊겼나. */
  private watchLine(task: TaskDef, s: Slot, text: string): void {
    const a = this.adapterOf(task);
    const p = a.progress;
    if (p.round?.test(text)) this.update(task.id, this.roundDone(s));
    if (p.queueDone?.test(text)) this.update(task.id, { queue: null });
    else this.watchQueue(task, text);
    if (p.buying.test(text)) this.update(task.id, { phase: "buying" });
    else if (p.paid.test(text)) this.update(task.id, { phase: "paid" });
    else if (p.checkout.test(text)) this.update(task.id, { phase: "checkout" });
    if (a.busy?.start.test(text)) s.busySince = Date.now();
    if (task.profileId && a.session.deadLine.test(text)) this.emit("sessionDead", task.profileId, text.replace(STAMP, "").trim());
  }

  /**
   * 원본이 제자리에서 고쳐 쓰는 상태 줄 (롯데 "품절 · 다음 확인 3초"). 로그에는 안 쌓고 note 로만 둔다.
   * 한 번 기다리는 동안 남은 초는 줄기만 한다 — 다시 올라가거나 같은 숫자를 새로 쓰면 원본이 방금 한 번
   * 확인하고 새로 기다리기 시작한 것이다.
   */
  private watchStatus(task: TaskDef, s: Slot, text: string): void {
    const left = this.adapterOf(task).progress.countdown?.exec(text);
    const patch: Partial<TaskRuntime> = { note: text };
    const queue = this.queueOf(task, text);
    if (queue) patch.queue = queue;
    if (left) {
      const n = Number(left[1]);
      if (s.countdown === null || n >= s.countdown) Object.assign(patch, this.roundDone(s));
      s.countdown = n;
    }
    this.update(task.id, patch);
  }

  /** 대기열 줄이면 그 상태. 원본이 말한 예상 남은 초는 받은 시각(at)부터 화면이 줄여 보인다. */
  private queueOf(task: TaskDef, text: string): TaskRuntime["queue"] {
    const m = this.adapterOf(task).progress.queue?.exec(text);
    if (!m) return null;
    const num = (v: string | undefined): number | null => (v ? Number(v.replace(/,/g, "")) : null);
    return { ahead: num(m[1]) ?? 0, total: num(m[2]), eta: num(m[3]), at: Date.now() };
  }

  /** 일반 로그 줄에 찍힌 대기열 상태 (감시가 상태 줄을 쓰는 동안은 원본이 로그로 적는다). */
  private watchQueue(task: TaskDef, text: string): void {
    const queue = this.queueOf(task, text);
    if (queue) this.update(task.id, { queue });
  }

  /** 원본이 한 번 확인했다. 확인을 이어 가는 것이니 단계도 "확인 중" 으로 돌아온다 (구매를 접었거나 끝냈다). */
  private roundDone(s: Slot): Partial<TaskRuntime> {
    return { rounds: s.rt.rounds + 1, lastCheckAt: Date.now(), phase: "watching" };
  }

  /**
   * 원본이 지금 구매 중인가. 구매를 시작한다고 말한 뒤 산 기록을 아직 다시 적지 않았으면 구매 중이다.
   * 알아볼 길이 없는 사이트(네이버)는 false — 그쪽은 Ctrl+C 가 구매와 구매 창을 기다려 준다.
   */
  private isBusy(id: string): boolean {
    const s = this.slots.get(id);
    const task = this.tasks.find((t) => t.id === id);
    const busy = task && this.adapterOf(task).busy;
    if (!s || !busy || s.busySince === null) return false;
    if (mtimeOf(join(this.homeOf(id), busy.settledBy)) >= s.busySince) s.busySince = null;
    return s.busySince !== null;
  }

  // ── 돌던 중에 고치기 ────────────────────────────────────────────────────

  private applyToLive(prev: TaskDef, next: TaskDef): void {
    const id = next.id;
    // 두 쪽의 칸을 합쳐서 본다 — 프로필을 "없음" 으로 바꾸면 그 칸이 새 쪽에서 빠진다.
    let changed = [...new Set([...Object.keys(prev), ...Object.keys(next)])]
      .map((k) => k as keyof TaskDef)
      .filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
    // 이미 띄운 뒤라 드랍 시각·미리 띄울 때는 이번 실행과 상관없다. 드랍 걸음(간격)만 다시 시작 거리다.
    if (changed.includes("dropSettings") && prev.dropSettings.intervalMs === next.dropSettings.intervalMs) {
      changed = changed.filter((k) => k !== "dropSettings");
      this.push(id, "sys", "드랍 시각이 바뀌었습니다 — 이미 돌고 있어 다음 예약부터 씁니다.");
    }
    if (!changed.length) return;
    const names = changed.map((k) => FIELD_LABEL[k]).join(" · ");

    // 한 번 돌고 끝나는 모드는 다시 띄우면 그 일을 한 번 더 한다 (지금 구매를 또 산다).
    if (!REPEATING_MODES.includes(prev.mode) || !REPEATING_MODES.includes(next.mode)) {
      this.push(id, "sys", `설정이 바뀌었습니다 (${names}) — 한 번 돌고 끝나는 모드라 이번 실행에는 반영하지 않습니다. 다음 실행부터 새 설정입니다.`);
      return;
    }

    const adapter = this.adapterOf(prev);
    const live = SITES[prev.site].liveFields;
    if (next.site === prev.site && adapter.applyLive && changed.every((k) => live.includes(k))) {
      try {
        adapter.applyLive(next, this.homeOf(id));
        this.push(id, "sys", `바로 반영했습니다 (${names}) — 원본이 다음 확인 때 읽습니다.`);
        return;
      } catch (e) {
        this.push(id, "sys", `바로 반영하지 못했습니다 (${(e as Error).message}) — 다시 시작합니다.`);
      }
    }
    this.requestRestart(next, names);
  }

  private requestRestart(task: TaskDef, names: string): void {
    const id = task.id;
    // 새 프로필로는 못 띄우면(로그인이 없다, 그 프로필로 다른 네이버 태스크가 돈다) 멈추지 않고 그대로 둔다.
    const pf = this.profileFor(task);
    if (pf.error) {
      this.push(id, "sys", `설정이 바뀌었지만 (${names}) 새 설정으로는 띄울 수 없어 다시 시작하지 않습니다 — ${pf.error} 바뀌기 전 설정으로 계속 돕니다.`);
      return;
    }
    const r = this.rateOf(task);
    if (r?.refuse) {
      this.push(id, "sys",
        `설정이 바뀌었지만 (${names}) 새 간격으로는 ${SITES[task.site].name} 요청률이 ${r.total.toFixed(1)}회/분으로 ` +
        `거부선(${r.hard}회/분)을 넘어 다시 시작하지 않습니다 — 바뀌기 전 설정으로 계속 돕니다.`);
      return;
    }
    const busy = this.isBusy(id);
    this.update(id, { restartPending: true });
    this.push(id, "sys", `설정이 바뀌었습니다 (${names}) — 다시 시작합니다${busy ? ". 구매 중이라 그게 끝난 뒤에" : ""}.`);
    if (this.adapterOf(task).stopGraceMs === null) {
      // 네이버: Ctrl+C 가 하던 구매와 열린 구매 창을 기다려 준다. 기다리는 동안은 "멈추는 중" 이다.
      this.push(id, "sys", "구매 중이거나 구매 창이 열려 있으면 그게 끝난 뒤에 다시 시작합니다.");
    }
    this.tryRestart(id);
  }

  private tryRestart(id: string): void {
    const s = this.slots.get(id);
    if (!s || !s.rt.restartPending || s.restarting) return;
    if (!this.isLive(id)) {
      this.update(id, { restartPending: false });
      return;
    }
    if (s.stopRequested) return; // 사람이 멈추는 중이다 — stop 이 다시 시작을 거둔다
    if (this.isBusy(id)) {
      this.later(s, BUSY_POLL_MS, () => this.tryRestart(id));
      return;
    }
    s.restarting = true;
    this.stop(id, "restart");
  }

  // ── 멈추기 ──────────────────────────────────────────────────────────────

  private send(child: ChildProcess, msg: MainMessage): boolean {
    try {
      return child.send(msg);
    } catch {
      return false;
    }
  }

  private later(s: Slot, ms: number, fn: () => void): void {
    s.timers.push(setTimeout(fn, ms));
  }

  /**
   * 멈추라고 한다 = Ctrl+C 한 번. **이미 멈추는 중이면 강제로 끝낸다** = 두 번째 Ctrl+C.
   *
   * 롯데 원본은 Ctrl+C 에 산 기록을 적고 바로 끝난다. 네이버 원본은 감시만 끊고, 열린
   * 구매 창이 있으면 사람이 닫을 때까지 기다린다 — 그 창에서 결제 중일 수 있어서 우리가
   * 시간을 재서 죽이지 않는다 (어댑터의 stopGraceMs 가 null).
   *
   * @param why 사람이 멈춘 것이면 미뤄 둔 다시 시작도 거둔다.
   */
  stop(id: string, why: "user" | "restart" = "user"): void {
    if (this.disarm(id)) {
      this.update(id, { status: "stopped", dropAt: null });
      this.push(id, "sys", "예약을 거뒀습니다.");
      return;
    }
    const s = this.slots.get(id);
    if (!s?.child || !this.isLive(id)) return;
    if (why === "user" && (s.rt.restartPending || s.restarting)) {
      s.restarting = false;
      this.update(id, { restartPending: false });
      this.push(id, "sys", "다시 시작을 거둡니다.");
    }
    if (s.stopRequested) return this.forceStop(id);

    const task = this.tasks.find((t) => t.id === id);
    const grace = task ? this.adapterOf(task).stopGraceMs : FORCE_GRACE_MS;
    const child = s.child;
    s.stopRequested = true;
    this.update(id, { status: "stopping" });
    if (!this.send(child, { type: "STOP", force: false })) child.kill();

    if (grace !== null) {
      this.later(s, grace, () => {
        if (child.exitCode !== null) return;
        this.push(id, "sys", "멈추라는 말에 답이 없어 죽입니다.");
        child.kill();
      });
    } else {
      this.later(s, WAIT_HINT_MS, () => {
        if (child.exitCode !== null) return;
        this.push(id, "sys", "아직 안 끝났습니다 — 구매 창이 열려 있으면 창을 닫아야 끝납니다. 바로 끝내려면 '강제' 를 누르세요 (창도 같이 닫힙니다).");
      });
    }
  }

  /** 두 번째 Ctrl+C. 그래도 안 끝나면 죽인다. 열린 구매 창도 같이 닫힌다. */
  forceStop(id: string): void {
    const s = this.slots.get(id);
    if (!s?.child || !this.isLive(id)) return;
    const child = s.child;
    s.stopRequested = true;
    s.restarting = false;
    this.update(id, { status: "stopping", restartPending: false });
    this.push(id, "sys", "강제로 끝냅니다.");
    if (!this.send(child, { type: "STOP", force: true })) child.kill();
    this.later(s, FORCE_GRACE_MS, () => {
      if (child.exitCode === null) child.kill();
    });
  }

  startAll(): void {
    for (const t of this.tasks) this.start(t.id);
  }

  stopAll(): void {
    for (const t of this.tasks) {
      if (this.slots.get(t.id)?.stopRequested) continue; // 이미 멈추는 중인 것을 강제로 넘기지 않는다
      this.stop(t.id); // 예약도 거둔다
    }
  }

  /** 앱을 닫을 때 예약을 전부 거둔다. 예약은 앱이 켜져 있어야 돈다. */
  cancelSchedules(): void {
    for (const t of this.tasks) if (this.isScheduled(t.id)) this.stop(t.id);
  }

  /** 끝날 때까지 기다린다. 늦어도 ms 뒤에는 돌아온다. → 아직 살아 있는 태스크 id */
  private async settle(ids: string[], ms: number): Promise<string[]> {
    const waits = ids.map((id) => {
      const child = this.slots.get(id)?.child;
      return child && this.isLive(id) ? new Promise((ok) => child.once("exit", ok)) : Promise.resolve();
    });
    await Promise.race([Promise.all(waits), new Promise((ok) => setTimeout(ok, ms))]);
    return ids.filter((id) => this.isLive(id));
  }

  /**
   * 앱을 닫을 때. 다 멈추라고 하고 기다린다. → 그래도 안 끝난 태스크의 이름
   * (구매 창을 붙들고 있는 네이버 태스크다. 죽일지는 사람이 정한다 — killAll)
   */
  async shutdown(): Promise<string[]> {
    const live = this.tasks.filter((t) => this.isLive(t.id)).map((t) => t.id);
    if (!live.length) return [];
    this.stopAll();
    const graces = live.map((id) => {
      const t = this.tasks.find((one) => one.id === id);
      return (t && this.adapterOf(t).stopGraceMs) ?? WAIT_HINT_MS;
    });
    const stuck = await this.settle(live, Math.max(...graces) + 500);
    return stuck.map((id) => {
      const t = this.tasks.find((one) => one.id === id);
      return t ? nameOf(t) : id;
    });
  }

  /** 남은 것을 전부 강제로 끝낸다. */
  async killAll(): Promise<void> {
    const live = this.tasks.filter((t) => this.isLive(t.id)).map((t) => t.id);
    for (const id of live) this.forceStop(id);
    await this.settle(live, FORCE_GRACE_MS + 500);
  }

  /** 원본의 준비 명령(빌드·설치). 원본 소스는 읽기만 하고, dist·node_modules 만 생긴다. */
  prepareSite(site: SiteId): Promise<number> {
    const cmd = ADAPTERS[site].prepare(this.settings.sites[site]);
    const out = PREPARE_LOG;
    if (!cmd) {
      this.push(out, "sys", `${SITES[site].name}: 할 준비가 없습니다.`);
      return Promise.resolve(0);
    }
    return new Promise((resolve) => {
      this.push(out, "sys", `${SITES[site].name} ${cmd.label} · ${cmd.cmd} ${cmd.args.join(" ")} · ${cmd.cwd}`);
      const child = spawn(cmd.cmd, cmd.args, { cwd: cmd.cwd, shell: true, env: { ...process.env, NO_COLOR: "1" } });
      eachLine(child.stdout, (text) => this.push(out, "out", text));
      eachLine(child.stderr, (text) => this.push(out, "err", text));
      child.on("error", (e) => this.push(out, "sys", `${cmd.label} 실패: ${e.message}`));
      child.on("exit", (code) => {
        this.push(out, "sys", code === 0 ? `${cmd.label} 끝` : `${cmd.label} 실패 (code ${code})`);
        resolve(code ?? 1);
      });
    });
  }
}
