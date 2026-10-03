/**
 * 모니터 — 재고를 보기만 하고 사지 않는다. 태스크와 따로 돈다 (TaskManager 를 거치지 않는다).
 *
 * 모니터 하나 = 워커 하나. 태스크와 같은 worker.js · forkLegacy 로 띄우고, 무엇을 띄울지는 어댑터가 정한다
 * (monitorLaunch — 원본의 감시 루프를 dry-run 으로). 원본 출력은 여기서 읽는다:
 *   발견        monitorSignal.found — 원본이 dry-run 구매 자리에서만 찍는 줄. 이 줄 말고는 발견으로 보지 않는다
 *   재고 판정   monitorSignal.stock
 *   확인 회차   progress (태스크와 같다 — 롯데는 제자리 상태 줄의 남은 초가 다시 올라갈 때, 네이버는 재고 줄)
 *   세션 끊김   session.deadLine (네이버) — 프로필을 만료로 돌린다
 *
 * 발견하면 상태를 found 로 두고 "found" 를 낸다. 모니터는 계속 본다 (원본 설정이 발견한 뒤에도 안 끝나게 돼 있다).
 * 구매 전환은 사람이 버튼을 눌러야 한다 — 여기서는 저절로 하지 않는다.
 *
 * 일시정지는 원본에 없다. 멈추고(Ctrl+C) 다시 띄운다 — 회차는 이어서 센다. 그 사이에 풀린 재입고는 놓친다.
 *
 * 네이버는 태스크와 같이 센다 (LiveUse): 요청률 합, 그리고 한 프로필로는 태스크·모니터 통틀어 하나만.
 *
 * 이벤트
 *   "update"      (entry: MonitorEntry)   — 만들었다·고쳤다·상태가 바뀌었다
 *   "removed"     (id: string)
 *   "log"         (line: LogLine)         — taskId 자리에 모니터 id
 *   "found"       (found: MonitorFound)
 *   "sessionDead" (profileId: string, line: string)
 */
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { SITES } from "../shared/sites.js";
import type {
  LogLine, MainMessage, MonitorEntry, MonitorFound, MonitorInput, MonitorState, SiteId, SiteSettings, WorkerMessage,
} from "../shared/types.js";
import { eachLine, forkLegacy } from "./legacy.js";
import type { MonitorStore } from "./monitorStore.js";
import type { ProfileRef } from "./sessions.js";
import { ADAPTERS } from "./sites/index.js";
import type { LiveUse } from "./taskManager.js";

const LOG_KEEP = 2000;
/** 멈추라고 한 뒤 이만큼 지나도 안 끝나면 죽인다. dry-run 이라 붙들고 있을 구매 창이 없다. */
const STOP_GRACE_MS = 8000;
/** 두 번째 Ctrl+C 뒤 이만큼 기다려도 안 끝나면 죽인다. */
const FORCE_GRACE_MS = 3000;
/** 원본이 줄 앞에 붙이는 시각 (TaskManager 의 STAMP 와 같다). */
const STAMP = /^(?:\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (?:\[INFO\] )?|\d\d:\d\d:\d\d {2})/;
/** 로그 파일에서 다시 읽은 줄 — "17:55:37 [매니저] 글" */
const FILE_LINE = /^(\d\d):(\d\d):(\d\d) (\[매니저\] |\[err\] )?(.*)$/;

interface Slot {
  child: ChildProcess | null;
  logs: LogLine[];
  /** 앱을 켠 뒤 처음 로그를 찾을 때 로그 파일의 끝을 읽어 왔나. */
  loaded: boolean;
  exitRequest: number | null;
  stopRequested: boolean;
  /** 일시정지로 멈추는 중인가 (끝나면 paused). */
  pausing: boolean;
  /** 설정이 바뀌어 다시 띄우려고 멈추는 중인가 (끝나면 곧바로 다시 띄운다). */
  restarting: boolean;
  /** 원본의 제자리 상태 줄에서 마지막으로 읽은 "다음 확인 N초". 다시 올라가면 한 바퀴 돈 것이다. */
  countdown: number | null;
  timers: NodeJS.Timeout[];
}

const now = () => new Date().toISOString();

export class MonitorManager extends EventEmitter {
  private slots = new Map<string, Slot>();
  private seq = 0;

  constructor(
    private readonly store: MonitorStore,
    private readonly workerPath: string,
    private readonly settingsOf: (site: SiteId) => SiteSettings,
    private readonly profileOf: (id: string) => ProfileRef | null,
    /** 도는 태스크 (TaskManager.liveUses) — 네이버 요청률 합·한 프로필에 하나. */
    private readonly tasks: () => LiveUse[],
  ) {
    super();
  }

  // ── 목록 ────────────────────────────────────────────────────────────────

  list(): MonitorEntry[] {
    return this.store.list();
  }

  /** 모니터 홈 (monitor-homes/<id>) — 원본 설정과 원본이 쓰는 것, "로그 저장" 파일이 여기 있다. */
  homeOf(id: string): string {
    return this.store.homeOf(id);
  }

  private entry(id: string): MonitorEntry {
    const e = this.store.get(id);
    if (!e) throw new Error(`없는 모니터입니다: ${id}`);
    return e;
  }

  create(input: MonitorInput): MonitorEntry {
    const e = this.store.create(input);
    this.emit("update", e);
    return e;
  }

  /** 정의를 고친다. 도는 중이면 바뀐 설정으로 다시 띄운다 (회차는 이어서). */
  update(id: string, input: MonitorInput): MonitorEntry {
    const e = this.store.update(id, input);
    this.emit("update", e);
    if (this.isLive(id)) {
      this.push(id, "sys", "설정이 바뀌어 다시 띄웁니다.");
      this.stop(id, "restart");
    }
    return e;
  }

  /** 지운다. 도는 중이면 먼저 멈추고 끝나기를 기다린다. */
  async remove(id: string): Promise<void> {
    this.entry(id);
    await this.halt(id);
    for (const t of this.slots.get(id)?.timers ?? []) clearTimeout(t);
    this.slots.delete(id);
    this.store.remove(id);
    this.emit("removed", id);
  }

  /**
   * 모니터 창(팝업)이 열렸다·닫혔다. monitors.json 에 남긴다. 앱을 닫느라 닫힌 창은 main 이 알리지 않는다 —
   * 그래서 다음에 켰을 때 마지막에 열려 있었는지 안다.
   */
  setPopupOpen(id: string, open: boolean): void {
    if (this.store.get(id)) this.setState(id, { popupOpen: open });
  }

  // ── 상태 · 로그 ─────────────────────────────────────────────────────────

  private slot(id: string): Slot {
    let s = this.slots.get(id);
    if (!s) {
      s = {
        child: null, logs: [], loaded: false, exitRequest: null, stopRequested: false, pausing: false,
        restarting: false, countdown: null, timers: [],
      };
      this.slots.set(id, s);
    }
    return s;
  }

  private setState(id: string, patch: Partial<MonitorState>): void {
    const e = this.store.setState(id, patch);
    if (e) this.emit("update", e);
  }

  private state(id: string): MonitorState {
    return this.entry(id).state;
  }

  /**
   * 그 모니터의 로그. 앱을 켠 뒤 처음이면 로그 파일의 끝을 읽어 온다 — 지난 실행의 로그도 보이게.
   * 파일에는 날짜가 없어 시각만 오늘 날짜로 읽는다.
   */
  logs(id: string): LogLine[] {
    const s = this.slot(id);
    if (!s.loaded) {
      s.loaded = true;
      const today = new Date();
      const past = this.store.tailLog(id, LOG_KEEP).map((raw): LogLine => {
        const m = FILE_LINE.exec(raw);
        const at = m ? new Date(today.getFullYear(), today.getMonth(), today.getDate(), +m[1]!, +m[2]!, +m[3]!).getTime() : today.getTime();
        const stream = m?.[4] === "[매니저] " ? "sys" : m?.[4] === "[err] " ? "err" : "out";
        return { seq: ++this.seq, taskId: id, at, stream, text: m ? m[5]! : raw };
      });
      s.logs = [...past, ...s.logs].slice(-LOG_KEEP);
    }
    return s.logs;
  }

  private push(id: string, stream: LogLine["stream"], raw: string): void {
    const s = this.slot(id);
    const text = raw.replace(STAMP, "");
    const line: LogLine = { seq: ++this.seq, taskId: id, at: Date.now(), stream, text };
    s.logs.push(line);
    if (s.logs.length > LOG_KEEP) s.logs.splice(0, s.logs.length - LOG_KEEP);
    this.store.appendLog(id, [line]);
    this.emit("log", line);
  }

  // ── 띄우기 ──────────────────────────────────────────────────────────────

  isLive(id: string): boolean {
    const child = this.slots.get(id)?.child;
    return !!child && child.exitCode === null && child.signalCode === null;
  }

  hasLive(): boolean {
    return this.list().some((e) => this.isLive(e.def.id));
  }

  /** 도는 모니터 — 태스크가 요청률 합과 "한 프로필에 하나" 를 볼 때 쓴다. */
  liveUses(except?: string): LiveUse[] {
    return this.list().flatMap(({ def }) => {
      if (def.id === except || !this.isLive(def.id)) return [];
      const use: LiveUse = { label: `모니터 ${def.name}`, site: def.site, perMin: ADAPTERS[def.site].rate?.monitorPerMin(def) ?? 0 };
      return [def.profileId ? { ...use, profileId: def.profileId } : use];
    });
  }

  /** 이 프로필로 돌고 있는 모니터의 이름. 프로필을 지우거나 로그아웃하기 전에 본다. */
  busyWith(profileId: string): string[] {
    return this.list().filter((e) => e.def.profileId === profileId && this.isLive(e.def.id)).map((e) => `모니터 ${e.def.name}`);
  }

  /** 띄우지 못하게 됐다. 까닭을 로그에 남기고 error 로 둔다. */
  private refuse(id: string, why: string): void {
    this.push(id, "sys", why);
    this.setState(id, { status: "error", lastResult: why });
  }

  /**
   * ▶. 일시정지였으면 회차를 이어서 센다. 이미 돌고 있으면 아무것도 안 한다.
   * @param continuing 설정이 바뀌어 다시 띄우는 것인가 (회차를 이어서 센다)
   */
  start(id: string, continuing = false): void {
    const { def, state } = this.entry(id);
    if (this.isLive(id)) return;
    const resume = continuing || state.status === "paused";
    const spec = SITES[def.site];
    const adapter = ADAPTERS[def.site];
    const settings = this.settingsOf(def.site);

    const info = adapter.info(settings, { webhook: "" });
    if (info.problems.length) return this.refuse(id, info.problems.join(" · "));

    // 롯데는 감시에 프로필을 안 쓴다 (재고 API 가 공개). 네이버는 조회도 로그인 세션으로 한다.
    let profile: ProfileRef | null = null;
    if (def.site === "naver") {
      profile = def.profileId ? this.profileOf(def.profileId) : null;
      if (!profile) return this.refuse(id, "로그인 프로필이 없습니다 (지워졌거나 고르지 않았습니다) — 모니터를 고쳐 프로필을 고르세요.");
      if (profile.site !== def.site) return this.refuse(id, `'${profile.name}' 은 ${SITES[profile.site].name} 프로필입니다 — 모니터를 고쳐 프로필을 다시 고르세요.`);
      if (!profile.hasLogin) return this.refuse(id, `'${profile.name}' 프로필에 로그인 정보가 없습니다 — 프로필 화면에서 로그인하세요.`);
    }

    // 같은 사이트로 도는 태스크·모니터. 네이버는 한 프로필로 하나만, 그리고 요청률을 더한다.
    const others = [...this.tasks(), ...this.liveUses(id)].filter((u) => u.site === def.site);
    if (spec.oneTaskPerProfile && profile) {
      const busy = others.find((u) => u.profileId === profile!.id);
      if (busy) {
        const what = busy.label.startsWith("태스크") ? "태스크" : "그 모니터";
        return this.refuse(id, `이 프로필(${profile.name})은 이미 실행 중입니다 (${busy.label} 실행 중) — 모니터를 시작하려면 ${what}를 먼저 중지하세요.`);
      }
    }
    const rate = adapter.rate;
    if (rate) {
      const total = others.reduce((sum, u) => sum + u.perMin, 0) + rate.monitorPerMin(def);
      if (total > rate.hard) {
        return this.refuse(id, `시작하지 않습니다 — ${spec.name} 태스크·모니터를 합치면 요청률이 ${total.toFixed(1)}회/분으로 거부선(${rate.hard}회/분)을 넘습니다. 돌고 있는 것을 멈추거나 간격을 늘리세요.`);
      }
      if (total > rate.warn) {
        this.push(id, "sys", `주의 — ${spec.name} 태스크·모니터 합계 요청률 ${total.toFixed(1)}회/분이 권장선(${rate.warn}회/분)보다 높습니다. 차단 위험이 있습니다.`);
      }
    }

    const home = this.store.homeOf(id);
    let launch;
    try {
      launch = adapter.monitorLaunch(def, home, settings, profile?.dir ?? null);
    } catch (e) {
      return this.refuse(id, `모니터 폴더를 준비하지 못했습니다: ${(e as Error).message}`);
    }

    const s = this.slot(id);
    s.exitRequest = null;
    s.stopRequested = false;
    s.pausing = false;
    s.restarting = false;
    s.countdown = null;

    const child = forkLegacy(this.workerPath, launch, home);
    s.child = child;
    this.setState(id, {
      status: "monitoring", pid: child.pid ?? null, startedAt: now(), note: "",
      ...(resume ? {} : { checkCount: 0, lastCheckAt: undefined, foundAt: undefined, stock: undefined, lastResult: undefined }),
    });
    const who = profile ? ` · ${profile.name}` : "";
    this.push(id, "sys", `${resume ? "이어서 " : ""}시작 (${spec.name}${who} · pid ${child.pid}) · ${launch.args.filter((a) => !a.includes(home)).join(" ")}`);

    const onLine = (stream: "out" | "err") => (text: string) => {
      // 터미널에서처럼, 표준출력에 줄이 찍히면 제자리 상태 줄은 지워진다.
      if (stream === "out" && this.state(id).note) this.setState(id, { note: "" });
      this.push(id, stream, text);
      this.watchLine(id, text);
    };
    eachLine(child.stdout, onLine("out"), (text) => this.watchStatus(id, s, text));
    eachLine(child.stderr, onLine("err"));

    child.on("message", (msg: WorkerMessage) => {
      if (msg.type === "WORKER_EXIT_REQUEST") s.exitRequest = msg.code;
      else if (msg.type === "FATAL") this.push(id, "sys", `워커 오류: ${msg.message}`);
    });
    child.on("error", (e) => this.push(id, "sys", `프로세스 오류: ${e.message}`));
    child.on("exit", (code, signal) => {
      for (const t of s.timers) clearTimeout(t);
      s.timers = [];
      if (s.child === child) s.child = null;
      if (!this.store.get(id)) return; // 지우는 중이었다
      let status: MonitorState["status"];
      let why = "";
      if (s.pausing) status = "paused";
      else if (s.stopRequested) status = "stopped";
      else if (s.exitRequest === 0) {
        status = "stopped";
        why = "원본이 감시를 끝냈습니다.";
      } else {
        status = "error";
        why = s.exitRequest === null ? "원본이 끝을 알리지 않고 죽었습니다." : `원본이 실패로 끝났습니다 (code ${s.exitRequest}).`;
      }
      this.push(id, "sys", `끝 · ${status} (code ${code ?? "-"}${signal ? `, ${signal}` : ""})${why ? ` — ${why}` : ""}`);
      this.setState(id, { status, pid: null, note: "", ...(why ? { lastResult: why } : {}) });
      if (s.restarting) this.start(id, true);
    });
  }

  /** 원본 출력 한 줄에서 알아 둘 것: 발견, 재고 판정, 확인 회차, 세션 끊김. */
  private watchLine(id: string, raw: string): void {
    const { def, state } = this.entry(id);
    const adapter = ADAPTERS[def.site];
    const text = raw.replace(STAMP, "").trim();
    const patch: Partial<MonitorState> = { lastResult: text };
    const stock = adapter.monitorSignal.stock.exec(text);
    if (stock) patch.stock = stock[1]!;
    if (adapter.progress.round?.test(text)) {
      patch.checkCount = state.checkCount + 1;
      patch.lastCheckAt = now();
    }
    const found = adapter.monitorSignal.found.exec(text);
    if (found) {
      const at = now();
      patch.status = "found";
      patch.foundAt = at;
      this.setState(id, patch);
      this.push(id, "sys", `🔴 재고 발견! ${def.name}`);
      const event: MonitorFound = { monitorId: id, site: def.site, name: def.name, url: found[1]!, at, detail: text, onFound: def.onFound };
      this.emit("found", event);
      return;
    }
    this.setState(id, patch);
    if (def.profileId && adapter.session.deadLine.test(text)) this.emit("sessionDead", def.profileId, text);
  }

  /**
   * 원본이 제자리에서 고쳐 쓰는 상태 줄 (롯데 "품절 · 다음 확인 3초"). 로그에는 안 쌓는다. 남은 초가 다시
   * 올라가거나 같은 숫자를 새로 쓰면 원본이 방금 한 번 확인하고 새로 기다리기 시작한 것이다.
   */
  private watchStatus(id: string, s: Slot, text: string): void {
    const { def, state } = this.entry(id);
    const left = ADAPTERS[def.site].progress.countdown?.exec(text);
    const patch: Partial<MonitorState> = { note: text };
    if (left) {
      const n = Number(left[1]);
      if (s.countdown === null || n >= s.countdown) {
        patch.checkCount = state.checkCount + 1;
        patch.lastCheckAt = now();
      }
      s.countdown = n;
    }
    this.setState(id, patch);
  }

  // ── 멈추기 ──────────────────────────────────────────────────────────────

  private later(s: Slot, ms: number, fn: () => void): void {
    s.timers.push(setTimeout(fn, ms));
  }

  private send(child: ChildProcess, msg: MainMessage): boolean {
    try {
      return child.send(msg);
    } catch {
      return false;
    }
  }

  /**
   * 멈추라고 한다 = Ctrl+C 한 번. **이미 멈추는 중이면 강제로 끝낸다** = 두 번째 Ctrl+C.
   * @param why pause 면 끝난 뒤 paused, restart 면 끝나자마자 다시 띄운다.
   */
  stop(id: string, why: "user" | "pause" | "restart" = "user"): void {
    const s = this.slots.get(id);
    if (!s?.child || !this.isLive(id)) {
      // 프로세스가 없는 일시정지를 멈추면 그냥 멈춤이다.
      if (why === "user" && this.store.get(id)?.state.status === "paused") this.setState(id, { status: "stopped" });
      return;
    }
    if (s.stopRequested) return this.forceStop(id);
    const child = s.child;
    s.stopRequested = true;
    s.pausing = why === "pause";
    s.restarting = why === "restart";
    this.setState(id, { status: "stopping" });
    if (!this.send(child, { type: "STOP", force: false })) child.kill();
    this.later(s, STOP_GRACE_MS, () => {
      if (child.exitCode !== null) return;
      this.push(id, "sys", "멈추라는 말에 답이 없어 죽입니다.");
      child.kill();
    });
  }

  /** 두 번째 Ctrl+C. 그래도 안 끝나면 죽인다. */
  forceStop(id: string): void {
    const s = this.slots.get(id);
    if (!s?.child || !this.isLive(id)) return;
    const child = s.child;
    s.stopRequested = true;
    s.restarting = false;
    this.push(id, "sys", "강제로 끝냅니다.");
    if (!this.send(child, { type: "STOP", force: true })) child.kill();
    this.later(s, FORCE_GRACE_MS, () => {
      if (child.exitCode === null) child.kill();
    });
  }

  /**
   * 멈추고 끝나기를 기다린다 (늦으면 죽인다). 구매로 전환할 때 쓴다 — 네이버는 같은 프로필로 태스크를 띄우려면
   * 모니터가 먼저 끝나 있어야 한다 (한 프로필에 하나).
   */
  async halt(id: string): Promise<void> {
    const child = this.slots.get(id)?.child;
    if (!child || !this.isLive(id)) return;
    const gone = new Promise((ok) => child.once("exit", ok));
    const drained = new Promise((ok) => child.once("close", ok));
    if (!this.slots.get(id)!.stopRequested) this.stop(id);
    await Promise.race([gone, new Promise((ok) => setTimeout(ok, STOP_GRACE_MS + 1000))]);
    if (this.isLive(id)) {
      child.kill();
      await Promise.race([new Promise((ok) => child.once("exit", ok)), new Promise((ok) => setTimeout(ok, 2000))]);
    }
    // exit 는 표준출력의 마지막 줄(원본의 "멈췄습니다.")보다 먼저 올 수 있다. 그 줄까지 받은 뒤에 돌아간다 —
    // 부른 쪽이 그다음에 적는 말(구매로 전환했다)이 늦게 온 원본의 줄에 덮이지 않게.
    await Promise.race([drained, new Promise((ok) => setTimeout(ok, 1000))]);
  }

  /** 매니저의 말을 그 모니터의 로그에 남긴다 (디스코드로 알렸다, 구매로 전환했다 …). 마지막 줄로도 둔다. */
  note(id: string, text: string): void {
    if (!this.store.get(id)) return;
    this.push(id, "sys", text);
    this.setState(id, { lastResult: text });
  }

  /** 일시정지 — 원본에 없어서 멈췄다가 resume 때 다시 띄운다. 그 사이에 풀린 재입고는 놓친다. */
  pause(id: string): void {
    if (!this.isLive(id)) return;
    this.push(id, "sys", "일시정지합니다 — 다시 이어 볼 때까지 확인하지 않습니다 (그 사이에 풀린 재입고는 놓칠 수 있습니다).");
    this.stop(id, "pause");
  }

  resume(id: string): void {
    if (this.entry(id).state.status !== "paused") return;
    this.start(id, true);
  }

  /** 앱을 닫을 때. 다 멈추고 기다린다. 그래도 안 끝난 것은 죽인다. 앱과 같이 끝나므로 상태는 다음에 켤 때 정리된다. */
  async shutdown(): Promise<void> {
    const live = this.list().map((e) => e.def.id).filter((id) => this.isLive(id));
    const waits = live.map((id) => {
      const child = this.slots.get(id)!.child!;
      return new Promise((ok) => child.once("exit", ok));
    });
    for (const id of live) this.stop(id);
    await Promise.race([Promise.all(waits), new Promise((ok) => setTimeout(ok, STOP_GRACE_MS + 500))]);
    for (const id of live) if (this.isLive(id)) this.slots.get(id)?.child?.kill();
    this.store.flush();
  }
}
