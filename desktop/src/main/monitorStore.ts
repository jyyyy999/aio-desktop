/**
 * 모니터 저장. 태스크(tasks.json · task-homes/)와 따로 둔다 — %APPDATA%/aio-task-manager/
 *
 *   monitors.json            모니터 목록. 모니터마다 정의(def)와 마지막 상태(state)
 *   monitor-homes/<id>/      원본이 읽는 설정을 원본의 파일 이름 그대로 (롯데 lotteon_test_config.json ·
 *                            네이버 smartstore_config.json — 어댑터의 writeMonitorConfig). 원본이 제 집에 쓰는
 *                            것(롯데 로그, 네이버 상태 파일 …)도 여기 쌓인다
 *   monitor-logs/<id>.log    그 모니터의 로그 — 매니저가 받은 원본 출력과 매니저의 말
 *
 * 상태는 도는 동안 자주 바뀐다 (롯데는 매초 상태 줄). 멈춤·발견·팝업처럼 남아야 할 것이 바뀌면 바로 적고,
 * 회차·마지막 확인 따위는 모아서 적는다 (FLUSH_MS). 앱이 꺼질 때 돌던 것은 다음에 켤 때 "멈춤" 이 된다.
 *
 * 프로세스를 모른다. 띄우고 멈추는 것은 MonitorManager 가 한다.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorName, monitorProblem } from "../shared/monitors.js";
import { SITE_IDS } from "../shared/sites.js";
import type { LogLine, MonitorDef, MonitorEntry, MonitorInput, MonitorState, MonitorStatus } from "../shared/types.js";

/** 자주 바뀌는 상태를 모아서 적는 간격. */
const FLUSH_MS = 5000;
/** 로그 파일이 이만큼 커지면 <id>.1.log 로 밀어 두고 새로 쓴다 (하나만 남긴다). */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** 앱이 꺼질 때 이 상태였으면 프로세스가 없어진 것이다 — 다음에 켤 때 "멈춤" 으로 읽는다. */
const GONE_WITH_APP: MonitorStatus[] = ["monitoring", "found", "stopping"];
/** 바뀌면 곧바로 적는 상태 칸. 나머지(회차·마지막 확인·상태 줄)는 모아서 적는다. */
const DURABLE: (keyof MonitorState)[] = ["status", "foundAt", "popupOpen", "startedAt"];

const now = () => new Date().toISOString();

function blankState(id: string): MonitorState {
  return { id, status: "idle", pid: null, checkCount: 0, note: "", popupOpen: false };
}

/** 폼에서 온 것을 다듬는다 — 글은 자르고, 숫자는 정수로, 빈 프로필은 칸째로 뺀다. */
function tidy(input: MonitorInput): MonitorInput {
  const { profileId, ...rest } = input;
  return {
    ...rest,
    name: String(input.name ?? "").trim(),
    productUrl: String(input.productUrl ?? "").trim(),
    option: String(input.option ?? "").trim(),
    ea: Math.trunc(Number(input.ea)),
    maxPrice: Math.trunc(Number(input.maxPrice) || 0),
    checkIntervalMs: Math.round(Number(input.checkIntervalMs)),
    restockOnly: input.restockOnly !== false,
    ...(profileId ? { profileId } : {}),
  };
}

/** 로그 파일에 적는 한 줄. 태스크 창의 캡처와 같은 모양이다. */
function logText(l: LogLine): string {
  const mark = { out: "", err: "[err] ", sys: "[매니저] " } as const;
  return `${new Date(l.at).toTimeString().slice(0, 8)} ${mark[l.stream]}${l.text}`;
}

export class MonitorStore {
  private entries: MonitorEntry[];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly dataDir: string) {
    this.entries = this.load();
  }

  // ── 경로 ────────────────────────────────────────────────────────────────

  private get listPath(): string {
    return join(this.dataDir, "monitors.json");
  }

  homeOf(id: string): string {
    return join(this.dataDir, "monitor-homes", id);
  }

  logPathOf(id: string): string {
    return join(this.dataDir, "monitor-logs", `${id}.log`);
  }

  // ── 읽기 · 적기 ─────────────────────────────────────────────────────────

  private load(): MonitorEntry[] {
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(this.listPath, "utf-8"));
    } catch {
      return [];
    }
    const list = (raw as { monitors?: unknown } | null)?.monitors;
    if (!Array.isArray(list)) return [];
    return (list as Partial<MonitorEntry>[])
      .filter((e): e is MonitorEntry => typeof e?.def?.id === "string" && SITE_IDS.includes(e.def.site))
      .map(({ def, state }) => {
        const st: MonitorState = { ...blankState(def.id), ...state, id: def.id, pid: null, note: "" };
        // 앱과 같이 끝난 프로세스다. 일시정지는 원래 프로세스가 없는 상태라 그대로 둔다.
        if (GONE_WITH_APP.includes(st.status)) st.status = "stopped";
        return { def: { ...def, restockOnly: def.restockOnly !== false }, state: st };
      });
  }

  /** 지금 적는다. 모아 두던 것이 있으면 그것도. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.listPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, monitors: this.entries }, null, 2), "utf-8");
      renameSync(tmp, this.listPath);
    } catch {
      // 못 적어도 도는 모니터에는 지장이 없다. 다음 적을 때 다시 해 본다.
    }
  }

  private flushSoon(): void {
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  // ── 목록 ────────────────────────────────────────────────────────────────

  list(): MonitorEntry[] {
    return this.entries;
  }

  get(id: string): MonitorEntry | undefined {
    return this.entries.find((e) => e.def.id === id);
  }

  private at(id: string): number {
    const at = this.entries.findIndex((e) => e.def.id === id);
    if (at < 0) throw new Error(`없는 모니터입니다: ${id}`);
    return at;
  }

  private newId(): string {
    let id: string;
    do id = randomUUID().slice(0, 8);
    while (this.get(id) || existsSync(this.homeOf(id)));
    return id;
  }

  /** → 만든 모니터. 입력이 틀렸으면 까닭을 던진다. 모니터 홈 폴더도 만든다 (원본 설정은 띄울 때 쓴다). */
  create(input: MonitorInput): MonitorEntry {
    const clean = tidy(input);
    const problem = monitorProblem(clean);
    if (problem) throw new Error(problem);
    const at = now();
    const id = this.newId();
    const def: MonitorDef = { ...clean, name: monitorName(clean), id, createdAt: at, updatedAt: at };
    const entry: MonitorEntry = { def, state: blankState(id) };
    this.entries.push(entry);
    mkdirSync(this.homeOf(id), { recursive: true });
    this.flush();
    return entry;
  }

  /** 정의를 고친다. 사이트는 못 바꾼다 — 모니터 홈의 설정 파일 이름이 사이트마다 다르다. */
  update(id: string, input: MonitorInput): MonitorEntry {
    const at = this.at(id);
    const was = this.entries[at]!;
    const clean = tidy(input);
    if (clean.site !== was.def.site) throw new Error("모니터의 사이트는 바꿀 수 없습니다 — 새 모니터를 만드세요.");
    const problem = monitorProblem(clean);
    if (problem) throw new Error(problem);
    const def: MonitorDef = { ...clean, name: monitorName(clean), id, createdAt: was.def.createdAt, updatedAt: now() };
    this.entries[at] = { def, state: was.state };
    this.flush();
    return this.entries[at]!;
  }

  /** 모니터를 지운다 — 목록에서 빼고, 모니터 홈과 로그 파일도 지운다. 도는지는 매니저가 먼저 본다. */
  remove(id: string): void {
    this.entries.splice(this.at(id), 1);
    this.flush();
    rmSync(this.homeOf(id), { recursive: true, force: true });
    rmSync(this.logPathOf(id), { force: true });
    rmSync(this.logPathOf(id).replace(/\.log$/, ".1.log"), { force: true });
  }

  /** 상태를 고친다. 남아야 할 칸(DURABLE)이 바뀌면 바로, 아니면 모아서 적는다. → 고친 한 벌 (없는 모니터면 null) */
  setState(id: string, patch: Partial<MonitorState>): MonitorEntry | null {
    const at = this.entries.findIndex((e) => e.def.id === id);
    if (at < 0) return null;
    const was = this.entries[at]!;
    const state: MonitorState = { ...was.state, ...patch, id };
    this.entries[at] = { def: was.def, state };
    const durable = DURABLE.some((k) => k in patch && patch[k] !== was.state[k]);
    if (durable) this.flush();
    else this.flushSoon();
    return this.entries[at]!;
  }

  // ── 로그 ────────────────────────────────────────────────────────────────

  /** 로그 파일에 잇는다. 너무 커지면 하나 밀어 두고 새로 쓴다. */
  appendLog(id: string, lines: LogLine[]): void {
    if (!lines.length) return;
    const path = this.logPathOf(id);
    try {
      mkdirSync(join(this.dataDir, "monitor-logs"), { recursive: true });
      if (existsSync(path) && statSync(path).size > LOG_ROTATE_BYTES) renameSync(path, path.replace(/\.log$/, ".1.log"));
      appendFileSync(path, lines.map(logText).join("\n") + "\n", "utf-8");
    } catch {
      // 로그 파일을 못 쓴다고 감시를 멈출 이유는 없다.
    }
  }

  /** 로그 파일의 끝 몇 줄. 앱을 다시 켠 뒤 모니터 창이 지난 로그를 보일 때 쓴다. */
  tailLog(id: string, maxLines: number): string[] {
    const path = this.logPathOf(id);
    try {
      const size = statSync(path).size;
      const want = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(want);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buf, 0, want, size - want);
      } finally {
        closeSync(fd);
      }
      const lines = buf.toString("utf-8").split("\n").filter(Boolean);
      // 잘라 읽었으면 첫 줄은 반쪽일 수 있다.
      if (want < size) lines.shift();
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  }
}
