/**
 * 로그인 프로필 — 로그인과 세션 확인. 사이트마다 프로필을 여럿 두고, 태스크가 하나를 고른다.
 *
 * 저장 (%APPDATA%/aio-task-manager/)
 *   profiles.json                      프로필 목록 (순서 · 사이트 · 이름)
 *   profiles/<id>/meta.json            그 프로필의 상태 (로그인 상태 · 마지막 로그인 · 마지막 확인 …)
 *   profiles/<id>/lotte-cookie.txt     롯데 쿠키 한 줄
 *   profiles/<id>/naver_session.json   네이버 세션 (원본 --login 이 적는 것과 같은 모양)
 * 로그인 정보는 프로필 폴더의 그 파일에만 있다. 목록과 meta.json 에는 상태만 적는다.
 *
 * 로그인
 *   롯데   매니저 창에서 사람이 로그인 → 창의 쿠키를 한 줄로 모아 프로필 폴더에
 *   네이버 원본 --login 이 창을 띄우고 판정·저장까지 한다. 저장 자리는 워커가 프로필 폴더로 돌린다
 * 로그인됐는지는 원본의 --whoami 로 묻는다 (그 프로필의 쿠키·세션으로).
 *
 * Electron 을 모른다. 로그인 창은 main 이 windows 로 넣어 준다.
 */
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loginLog, PAYMENT_PIN_DIGITS, SITE_IDS, SITES, siteLog } from "../shared/sites.js";
import type { LogLine, MainMessage, Profile, ProfilePatch, SiteId, SiteSettings, WorkerMessage } from "../shared/types.js";
import { eachLine, forkLegacy } from "./legacy.js";
import { ADAPTERS, type Launch, type WindowLogin } from "./sites/index.js";

/** 매니저가 띄우는 로그인 창 (Electron). */
export interface LoginWindows {
  /** 사람이 로그인하면 모은 쿠키, 창을 닫거나 시간이 다 되면 null. */
  open(title: string, partition: string, spec: WindowLogin, note: (text: string) => void): { done: Promise<string | null>; cancel(): void };
  /** 창의 저장소를 비운다 (로그아웃 · 프로필 지우기). 다음 로그인 창이 로그인 안 된 채로 열린다. */
  forget(partition: string): Promise<void>;
}

/**
 * 결제 비밀번호를 잠그고 푸는 것 (Electron safeStorage — 윈도에서는 DPAPI, 이 PC 의 이 윈도 계정에서만 풀린다).
 * main 이 넣어 준다.
 */
export interface PinVault {
  /** 암호화를 쓸 수 있나. 못 쓰면 비밀번호를 받지 않는다 — 평문으로 대신 적지 않는다. */
  available(): boolean;
  seal(text: string): Buffer;
  open(data: Buffer): string;
}

/** 프로필 폴더의 결제 비밀번호 (암호화된 바이트). 있으면 Profile.hasPaymentPin. */
const PIN_FILE = "payment-pin.enc";

/** meta.json 에 적는 것. 화면에 가는 Profile 은 여기에 어댑터가 아는 것(파일 위치·확인 방법)을 붙인 것이다. */
type Meta = Pick<Profile, "id" | "site" | "name" | "memo" | "loginStatus" | "statusNote" | "lastLoginAt" | "lastCheckedAt" | "isActive" | "createdAt" | "updatedAt">;

/** 메모는 한 줄로, 이만큼까지. */
const MEMO_MAX = 100;

/** profiles.json 의 한 줄. */
type Entry = Pick<Profile, "id" | "site" | "name">;

/** TaskManager 가 태스크를 띄울 때 보는 것. */
export interface ProfileRef {
  id: string;
  name: string;
  site: SiteId;
  /** profiles/<id> — 어댑터가 여기서 로그인 정보를 찾는다. */
  dir: string;
  loginStatus: Profile["loginStatus"];
  /** 로그인 정보 파일이 있나 (살아 있는지는 모른다). */
  hasLogin: boolean;
  /** 결제 비밀번호가 저장돼 있나. 값은 SessionManager.paymentPin 으로 띄우기 직전에만 푼다. */
  hasPaymentPin: boolean;
}

/** 원본 명령을 멈추라고 한 뒤 이만큼 기다려도 안 끝나면 죽인다. */
const STOP_GRACE_MS = 3000;
const META = "meta.json";
/**
 * profiles.json 을 언제 읽고 적었는지 남기는 파일 (데이터 폴더). 목록이 옛 형식으로 되돌아가 있는 까닭을
 * 아직 모른다 (아래 load 의 recover) — 나중에 찾을 때 볼 단서다.
 */
const TRACE = "profiles-trace.log";

const now = () => new Date().toISOString();

function blankMeta(id: string, site: SiteId, name: string): Meta {
  const at = now();
  return { id, site, name, loginStatus: "logged_out", statusNote: "아직 로그인하지 않았습니다", isActive: true, createdAt: at, updatedAt: at };
}

/**
 * 이벤트
 *   "profile" (p: Profile) — 프로필이 생겼거나 상태가 바뀌었다
 */
export class SessionManager extends EventEmitter {
  private metas: Meta[];
  /** 로그인 중인 프로필. 창을 닫거나 원본 명령을 멈추는 법. */
  private running = new Map<string, () => void>();

  constructor(
    private readonly dataDir: string,
    private readonly workerPath: string,
    private readonly settingsOf: (site: SiteId) => SiteSettings,
    private readonly windows: LoginWindows,
    private readonly log: (id: string, stream: LogLine["stream"], text: string) => void,
    private readonly vault: PinVault,
  ) {
    super();
    this.metas = this.load();
    // 앱이 로그인 중에 꺼졌으면 그 상태가 남아 있다. 확인 전까지는 모르는 것이다.
    for (const m of this.metas) if (m.loginStatus === "logging_in") m.loginStatus = "error";
  }

  // ── 파일 ────────────────────────────────────────────────────────────────

  private get listPath(): string {
    return join(this.dataDir, "profiles.json");
  }

  dirOf(id: string): string {
    return join(this.dataDir, "profiles", id);
  }

  /** 원본 명령이 제 설정·로그를 만들어도 되는 빈 폴더. 계정 명령의 작업 폴더이기도 하다. */
  private scratchOf(site: SiteId): string {
    return join(this.dataDir, "sessions", site);
  }

  /** 자취 한 줄 (시각 · 무슨 일). 프로필 id 까지만 적는다 — 이름·메모·로그인 정보는 적지 않는다. */
  private trace(what: string): void {
    try {
      appendFileSync(join(this.dataDir, TRACE), `${now()} ${what}\n`, "utf-8");
    } catch {
      // 자취를 못 남겨도 하던 일은 한다.
    }
  }

  private load(): Meta[] {
    let raw: unknown = null;
    let found = "없음";
    try {
      const text = readFileSync(this.listPath, "utf-8");
      found = "깨짐";
      raw = JSON.parse(text);
    } catch {
      // 없거나 깨졌다 — 아래에서 0.2 의 원본 파일을 보고 새로 만든다.
    }
    const list = (raw as { profiles?: unknown } | null)?.profiles;
    if (raw) found = Array.isArray(list) ? `v2 ${list.length}개` : list && typeof list === "object" ? "0.2 형식" : "모르는 형식";
    let mtime = "-";
    try {
      mtime = statSync(this.listPath).mtime.toISOString();
    } catch {
      // 파일이 없다.
    }
    this.trace(`읽음: ${found} · 파일 수정 시각 ${mtime}`);
    if (Array.isArray(list)) {
      return (list as Partial<Entry>[])
        .filter((e): e is Entry => typeof e?.id === "string" && !!e.site && SITE_IDS.includes(e.site))
        .map((e) => this.readMeta(e));
    }
    // 목록이 없거나 0.2 형식인데 프로필 폴더가 이미 있으면 — 옮기기가 한 번 끝난 뒤 profiles.json 만 옛것으로
    // 돌아간 것이다 (2026-09-26 에 실제로 07:22 사본으로 되돌아가 있었다). 다시 옮기면 원본 파일의 (더 오래된)
    // 로그인으로 프로필이 겹치고, 그 뒤에 새로 로그인한 프로필은 목록에서 빠진다. 폴더(meta.json)를 믿고 목록을 되살린다.
    const recovered = this.recover();
    if (recovered.length) {
      this.metas = recovered;
      this.trace(`프로필 폴더에서 목록을 되살림: ${recovered.length}개`);
      this.persistList();
      for (const m of recovered) this.log(loginLog(m.id), "sys", "profiles.json 이 옛 형식이라 프로필 폴더(meta.json)에서 목록을 되살렸습니다.");
      return recovered;
    }
    return this.migrate(list && typeof list === "object" ? (list as Partial<Record<SiteId, Partial<Meta>>>) : {});
  }

  /** profiles/<id>/meta.json 들에서 목록을 다시 만든다 (만든 순서대로). */
  private recover(): Meta[] {
    let ids: string[] = [];
    try {
      ids = readdirSync(join(this.dataDir, "profiles"));
    } catch {
      return [];
    }
    const out: Meta[] = [];
    for (const id of ids) {
      let stored: Partial<Meta>;
      try {
        stored = JSON.parse(readFileSync(join(this.dirOf(id), META), "utf-8")) as Partial<Meta>;
      } catch {
        continue;
      }
      if (stored.id !== id || !stored.site || !SITE_IDS.includes(stored.site)) continue;
      out.push({ ...blankMeta(id, stored.site, String(stored.name || `${SITES[stored.site].name} 계정`)), ...stored, id, site: stored.site });
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private readMeta(e: Entry): Meta {
    let stored: Partial<Meta> = {};
    try {
      stored = JSON.parse(readFileSync(join(this.dirOf(e.id), META), "utf-8")) as Partial<Meta>;
    } catch {
      // meta.json 이 없다 — 목록에 적힌 것만으로 시작한다. 상태는 다음 확인에서 안다.
    }
    return { ...blankMeta(e.id, e.site, e.name), ...stored, id: e.id, site: e.site };
  }

  /**
   * 0.2 는 사이트마다 계정 하나였다 — profiles.json 이 { profiles: { lotte: {…}, naver: {…} } } 이고, 로그인 정보는
   * 원본 파일(롯데 씨앗 설정의 cookie · naver/naver_session.json)에 있었다. 로그인 정보가 있는 사이트는 그것을
   * 프로필 폴더로 베껴 프로필 하나로 만든다 — 다시 로그인하지 않아도 되게. 원본 파일은 그대로 둔다 (콘솔은
   * 지금처럼 그것을 쓴다). 예전 profiles.json 은 profiles.v1.json 으로 남긴다.
   */
  private migrate(old: Partial<Record<SiteId, Partial<Meta>>>): Meta[] {
    if (existsSync(this.listPath)) {
      try {
        copyFileSync(this.listPath, join(this.dataDir, "profiles.v1.json"));
      } catch {
        // 남기지 못해도 옮기는 데는 지장이 없다.
      }
    }
    const out: Meta[] = [];
    for (const site of SITE_IDS) {
      const id = this.newId();
      let adopted = false;
      try {
        adopted = ADAPTERS[site].session.adopt(this.settingsOf(site), this.dirOf(id));
      } catch {
        adopted = false;
      }
      if (!adopted) continue;
      const was = old[site] ?? {};
      const meta: Meta = {
        ...blankMeta(id, site, String(was.name || `${SITES[site].name} 계정`)),
        loginStatus: was.loginStatus && was.loginStatus !== "logging_in" ? was.loginStatus : "error",
        statusNote: "원본 파일의 로그인을 옮겨 왔습니다 — 확인 전입니다",
        ...(was.lastLoginAt ? { lastLoginAt: was.lastLoginAt } : {}),
        ...(was.createdAt ? { createdAt: was.createdAt } : {}),
      };
      out.push(meta);
      this.writeMeta(meta);
      this.log(loginLog(id), "sys", `원본 파일의 로그인 정보를 이 프로필로 옮겼습니다 → ${basename(ADAPTERS[site].session.store(this.dirOf(id)))}`);
    }
    this.metas = out;
    this.persistList();
    return out;
  }

  private newId(): string {
    let id: string;
    do id = randomUUID().slice(0, 8);
    while (this.metas?.some((m) => m.id === id) || existsSync(this.dirOf(id)));
    return id;
  }

  /** 목록을 적는다. 반쯤 쓰인 파일이 남지 않게 옆에 쓰고 바꿔치기한다. */
  private persistList(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const profiles: Entry[] = this.metas.map(({ id, site, name }) => ({ id, site, name }));
      const tmp = `${this.listPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 2, profiles }, null, 2), "utf-8");
      renameSync(tmp, this.listPath);
      this.trace(`적음: v2 ${profiles.length}개 [${profiles.map((p) => `${p.site}:${p.id}`).join(", ")}]`);
    } catch (e) {
      // 못 적어도 meta.json 이 남아서 다음에 켤 때 폴더에서 목록을 되살린다 (recover). 조용히 넘기지는 않는다.
      console.error(`[sessions] profiles.json 을 적지 못했습니다: ${(e as Error).message}`);
      this.trace(`적지 못함: ${(e as Error).message}`);
    }
  }

  private writeMeta(m: Meta): void {
    try {
      mkdirSync(this.dirOf(m.id), { recursive: true });
      writeFileSync(join(this.dirOf(m.id), META), JSON.stringify(m, null, 2), "utf-8");
    } catch {
      // 상태를 못 적어도 다음 확인에서 다시 안다.
    }
  }

  // ── 상태 ────────────────────────────────────────────────────────────────

  private metaOf(id: string): Meta {
    const m = this.metas.find((one) => one.id === id);
    if (!m) throw new Error(`없는 프로필입니다: ${id}`);
    return m;
  }

  private view(m: Meta): Profile {
    const a = ADAPTERS[m.site].session;
    const dir = this.dirOf(m.id);
    // 프로필 폴더에 로그인 정보가 없으면 무엇이 적혀 있든 로그아웃이다 (폴더에서 지웠을 수도 있다).
    const gone = !a.has(dir) && m.loginStatus !== "logging_in";
    const expiry = a.expiry(dir);
    return {
      ...m,
      loginStatus: gone ? "logged_out" : m.loginStatus,
      statusNote: gone ? "저장된 로그인 정보가 없습니다" : m.statusNote,
      loginUrl: a.loginUrl,
      ...(expiry ? { sessionExpiry: expiry } : {}),
      cookiesPath: a.store(dir),
      sessionCheck: a.check,
      hasPaymentPin: existsSync(join(dir, PIN_FILE)),
    };
  }

  list(): Profile[] {
    return this.metas.map((m) => this.view(m));
  }

  get(id: string): Profile {
    return this.view(this.metaOf(id));
  }

  ref(id: string): ProfileRef | null {
    const m = this.metas.find((one) => one.id === id);
    if (!m) return null;
    const dir = this.dirOf(id);
    return {
      id, name: m.name, site: m.site, dir, loginStatus: this.view(m).loginStatus, hasLogin: ADAPTERS[m.site].session.has(dir),
      hasPaymentPin: existsSync(join(dir, PIN_FILE)),
    };
  }

  /** 상태를 고쳐 적고 알린다. 그 사이에 지워진 프로필이면 아무것도 안 한다. */
  private set(id: string, patch: Partial<Meta>): void {
    const at = this.metas.findIndex((one) => one.id === id);
    if (at < 0) return;
    const m: Meta = { ...this.metas[at]!, ...patch, updatedAt: now() };
    this.metas[at] = m;
    this.writeMeta(m);
    if (patch.name !== undefined) this.persistList();
    this.emit("profile", this.view(m));
  }

  // ── 만들기 · 고치기 · 지우기 ──────────────────────────────────────────────

  private checkName(site: SiteId, name: string, self: string | null): string {
    const n = name.trim();
    if (!n) throw new Error("프로필 이름을 적어 주세요.");
    if (this.metas.some((m) => m.site === site && m.id !== self && m.name === n)) {
      throw new Error(`${SITES[site].name}에 같은 이름의 프로필이 있습니다: ${n}`);
    }
    return n;
  }

  private checkMemo(memo: string): string {
    const one = memo.replace(/\s+/g, " ").trim();
    if (one.length > MEMO_MAX) throw new Error(`메모는 ${MEMO_MAX}자까지입니다.`);
    return one;
  }

  create(site: SiteId, name: string, memo = ""): Profile {
    if (!SITE_IDS.includes(site)) throw new Error(`모르는 사이트입니다: ${site}`);
    const count = this.metas.filter((m) => m.site === site).length;
    const m: Meta = {
      ...blankMeta(this.newId(), site, this.checkName(site, name.trim() || `${SITES[site].name} ${count + 1}`, null)),
      memo: this.checkMemo(memo),
    };
    this.metas.push(m);
    this.writeMeta(m);
    this.persistList();
    const p = this.view(m);
    this.emit("profile", p);
    return p;
  }

  update(id: string, patch: ProfilePatch): Profile {
    const m = this.metaOf(id);
    const next: Partial<Meta> = {};
    if (patch.name !== undefined) next.name = this.checkName(m.site, patch.name, id);
    if (patch.memo !== undefined) next.memo = this.checkMemo(String(patch.memo));
    // 쓰는 중인지는 main 이 먼저 본다 (태스크·모니터를 아는 쪽).
    if (patch.isActive !== undefined) next.isActive = !!patch.isActive;
    this.set(id, next);
    return this.get(id);
  }

  /** 프로필 폴더(로그인 정보째)를 지운다. 그 프로필로 도는 태스크가 없는지는 main 이 먼저 본다. */
  async remove(id: string): Promise<Profile[]> {
    const m = this.metaOf(id);
    if (this.running.has(id)) throw new Error("로그인 중입니다 — 로그인을 끝내거나 취소한 뒤 지우세요.");
    await this.forgetWindow(m);
    rmSync(this.dirOf(id), { recursive: true, force: true });
    this.metas = this.metas.filter((one) => one.id !== id);
    this.persistList();
    return this.list();
  }

  /**
   * 로그아웃 = 프로필 폴더의 로그인 정보를 지운다. 롯데는 로그인 창의 저장소도 비워서 다음 로그인 창이
   * 로그인 안 된 채로 열리게 한다. 사이트 쪽 세션을 끊는 것은 아니다 (원본에도 그런 명령이 없다).
   */
  async logout(id: string): Promise<Profile> {
    const m = this.metaOf(id);
    if (this.running.has(id)) throw new Error("로그인 중입니다 — 먼저 로그인을 취소하세요.");
    rmSync(ADAPTERS[m.site].session.store(this.dirOf(id)), { force: true });
    await this.forgetWindow(m);
    this.log(loginLog(id), "sys", "로그아웃했습니다 — 프로필 폴더의 로그인 정보를 지웠습니다.");
    this.set(id, { loginStatus: "logged_out", statusNote: "로그아웃했습니다" });
    return this.get(id);
  }

  private async forgetWindow(m: Meta): Promise<void> {
    const login = ADAPTERS[m.site].session.login;
    if (login.kind === "window") await this.windows.forget(login.partition(m.id)).catch(() => undefined);
  }

  // ── 결제 비밀번호 ───────────────────────────────────────────────────────
  //
  // 프로필마다 하나 — 간편결제 비밀번호는 계정의 것이라, 사이트 공통으로 두면 다른 계정의 태스크가 그 비밀번호를
  // 자판에 누른다 (몇 번 틀리면 결제 수단이 잠긴다). 값은 로그·화면·JSON 어디에도 내지 않고 자릿수만 적는다.
  // 로그아웃해도 남는다 (로그인 세션과 따로다). 프로필을 지우면 폴더째 지워진다.

  private pinPath(id: string): string {
    return join(this.dirOf(id), PIN_FILE);
  }

  setPaymentPin(id: string, raw: string): Profile {
    this.metaOf(id);
    const digits = String(raw ?? "");
    if (!/^\d+$/.test(digits)) throw new Error("결제 비밀번호는 숫자만 받습니다.");
    if (digits.length !== PAYMENT_PIN_DIGITS) {
      throw new Error(`결제 비밀번호는 ${PAYMENT_PIN_DIGITS}자리입니다 (넣은 것은 ${digits.length}자리) — 두 원본 다 ${PAYMENT_PIN_DIGITS}자리로 누릅니다.`);
    }
    if (!this.vault.available()) {
      throw new Error("이 PC 에서는 암호화 저장을 쓸 수 없어 저장하지 않습니다 (평문으로는 적지 않습니다).");
    }
    const path = this.pinPath(id);
    mkdirSync(this.dirOf(id), { recursive: true });
    // 반쯤 쓰인 파일이 남지 않게 옆에 쓰고 바꿔치기한다.
    writeFileSync(`${path}.tmp`, this.vault.seal(digits));
    renameSync(`${path}.tmp`, path);
    this.log(loginLog(id), "sys", `결제 비밀번호를 암호화해 저장했습니다 (${digits.length}자리). 돌고 있는 태스크는 다시 시작할 때부터 씁니다.`);
    this.set(id, {});
    return this.get(id);
  }

  clearPaymentPin(id: string): Profile {
    this.metaOf(id);
    rmSync(this.pinPath(id), { force: true });
    this.log(loginLog(id), "sys", "결제 비밀번호를 지웠습니다 — 결제 단계에서 사람이 넣어야 합니다.");
    this.set(id, {});
    return this.get(id);
  }

  /**
   * 태스크를 띄우기 직전에만 부른다 (TaskManager). 없으면 "". 풀지 못하면 던진다 — 다른 윈도 계정·다른 PC 에서
   * 옮겨 온 파일이면 DPAPI 가 풀지 못한다. 돌려준 값을 여기서 들고 있지 않는다.
   */
  paymentPin(id: string): string {
    let sealed: Buffer;
    try {
      sealed = readFileSync(this.pinPath(id));
    } catch {
      return "";
    }
    if (!this.vault.available()) throw new Error("이 PC 에서는 암호화를 쓸 수 없어 결제 비밀번호를 풀지 못했습니다.");
    try {
      return this.vault.open(sealed);
    } catch {
      throw new Error("결제 비밀번호를 풀지 못했습니다 (다른 윈도 계정이나 PC 에서 저장한 것일 수 있습니다) — 프로필 화면에서 다시 넣으세요.");
    }
  }

  // ── 원본 명령 ───────────────────────────────────────────────────────────

  /** 원본 명령 하나를 워커로 돌린다. 출력은 logId 의 로그에 쌓는다. */
  private run(logId: string, site: SiteId, launch: Launch): { child: ChildProcess; done: Promise<{ code: number; output: string }> } {
    const cwd = this.scratchOf(site);
    mkdirSync(cwd, { recursive: true });
    const child = forkLegacy(this.workerPath, launch, cwd);
    let output = "";
    let asked: number | null = null;
    const onLine = (stream: "out" | "err") => (text: string) => {
      output += `${text}\n`;
      this.log(logId, stream, text);
    };
    eachLine(child.stdout, onLine("out"));
    eachLine(child.stderr, onLine("err"));
    child.on("message", (msg: WorkerMessage) => {
      if (msg.type === "WORKER_EXIT_REQUEST") asked = msg.code;
      else if (msg.type === "FATAL") this.log(logId, "sys", `워커 오류: ${msg.message}`);
    });
    const done = new Promise<{ code: number; output: string }>((resolve) => {
      child.on("error", (e) => this.log(logId, "sys", `프로세스 오류: ${e.message}`));
      // close 는 표준출력이 다 흘러온 뒤에 온다 — 판정에 끝 줄까지 필요하다.
      child.on("close", (code) => resolve({ code: asked ?? code ?? 1, output }));
    });
    return { child, done };
  }

  /** Ctrl+C 와 같다. 원본 로그인 명령은 처리기가 없어 워커가 바로 끝내고, 창도 같이 닫힌다. */
  private stopChild(child: ChildProcess): void {
    try {
      child.send({ type: "STOP", force: false } satisfies MainMessage);
    } catch {
      child.kill();
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, STOP_GRACE_MS);
  }

  // ── 확인 · 로그인 ───────────────────────────────────────────────────────

  /** 원본 --whoami 로 이 프로필의 로그인이 살아 있는지 묻는다. */
  async check(id: string): Promise<Profile> {
    const m = this.metaOf(id);
    const a = ADAPTERS[m.site].session;
    const dir = this.dirOf(id);
    if (this.running.has(id)) return this.get(id);
    if (!a.has(dir)) {
      this.set(id, { loginStatus: "logged_out", statusNote: "저장된 로그인 정보가 없습니다", lastCheckedAt: now() });
      return this.get(id);
    }
    this.log(loginLog(id), "sys", "로그인이 살아 있는지 원본에 묻습니다 (--whoami)");
    const launch = a.whoami(this.settingsOf(m.site), dir, this.scratchOf(m.site));
    const { code, output } = await this.run(loginLog(id), m.site, launch).done;
    const verdict = a.judge(code, output);
    this.set(id, { loginStatus: verdict.status, statusNote: verdict.note, lastCheckedAt: now() });
    return this.metas.some((one) => one.id === id) ? this.get(id) : this.view(m);
  }

  /** 로그인 정보가 있는 프로필만 확인한다 (앱을 켤 때). 하나씩 — 같은 순간에 두드리지 않는다. */
  async checkAll(): Promise<void> {
    for (const m of [...this.metas]) {
      if (!this.metas.includes(m) || !ADAPTERS[m.site].session.has(this.dirOf(m.id))) continue;
      await this.check(m.id).catch(() => undefined);
    }
  }

  /**
   * 로그인 창을 띄운다. 사람이 로그인하면 프로필 폴더에 적고, 원본으로 확인까지 한 뒤 돌아온다.
   * 아이디·비밀번호는 매니저가 보지도 적지도 않는다 — 창 안에서 사람이 넣는다.
   */
  async login(id: string): Promise<Profile> {
    if (this.running.has(id)) return this.get(id);
    const m = this.metaOf(id);
    const a = ADAPTERS[m.site].session;
    const s = this.settingsOf(m.site);
    const dir = this.dirOf(id);
    const logId = loginLog(id);
    const note = (text: string) => {
      this.log(logId, "sys", text);
      this.set(id, { statusNote: text });
    };
    this.set(id, { loginStatus: "logging_in", statusNote: "로그인 창을 띄웁니다" });
    mkdirSync(dir, { recursive: true });

    let saved = false;
    try {
      if (a.login.kind === "legacy") {
        note("원본의 로그인 명령을 띄웁니다 (--login) — 열린 창에서 직접 로그인하세요.");
        const run = this.run(logId, m.site, a.login.launch(s, dir));
        this.running.set(id, () => this.stopChild(run.child));
        const { code } = await run.done;
        saved = code === 0;
        if (saved) {
          // 원본은 원래 자리(naver/naver_session.json)에 적었다고 말한다. 워커가 쓰기를 이리로 돌렸다.
          this.log(logId, "sys", `세션은 이 프로필 폴더에 저장됐습니다: ${a.store(dir)}`);
        } else {
          this.log(logId, "sys", "원본이 로그인을 저장하지 않았습니다 (창을 닫았거나 시간이 다 됐습니다).");
        }
      } else {
        const spec = a.login;
        note("로그인 창을 띄웁니다 — 창 안에서 직접 로그인하세요.");
        const win = this.windows.open(`${SITES[m.site].name} 로그인 — ${m.name}`, spec.partition(id), spec, note);
        this.running.set(id, win.cancel);
        const cookie = await win.done;
        if (cookie) {
          spec.save(dir, cookie);
          saved = true;
          const pieces = cookie.split(";").filter((p) => p.includes("=")).length;
          note(`로그인을 확인했습니다 — 쿠키 ${pieces}개를 프로필 폴더에 적었습니다 (${basename(a.store(dir))}).`);
        } else {
          this.log(logId, "sys", "로그인하지 않고 창이 닫혔습니다.");
        }
      }
    } catch (e) {
      this.log(logId, "sys", `로그인 중 오류: ${(e as Error).message}`);
    } finally {
      this.running.delete(id);
    }

    if (saved) this.set(id, { lastLoginAt: now() });
    // 저장했든 안 했든 지금 프로필 폴더의 로그인이 살아 있는지로 상태를 정한다.
    return this.check(id);
  }

  cancelLogin(id: string): void {
    this.running.get(id)?.();
  }

  cancelAll(): void {
    for (const cancel of this.running.values()) cancel();
  }

  /**
   * **콘솔용** 간편결제 비밀번호를 원본 설정 파일에 적는다 (null 이면 지운다). 사이트 공통이다 — 원본 --pin 이 적는
   * 자리와 같아서 콘솔에서 넣은 것과 한 곳이다. 태스크는 이것을 쓰지 않는다 (프로필의 결제 비밀번호를 쓴다).
   * 값은 로그에 남기지 않는다 (원본도 자릿수만 적는다).
   */
  async setPin(site: SiteId, raw: string | null): Promise<void> {
    const a = ADAPTERS[site].session.pin;
    const s = this.settingsOf(site);
    const logId = siteLog(site);
    if (raw === null) {
      const how = a.clear(s);
      if (how.kind === "file") {
        how.apply();
        this.log(logId, "sys", "간편결제 비밀번호를 지웠습니다 (원본 설정의 pg_password).");
      } else {
        this.log(logId, "sys", "간편결제 비밀번호를 지웁니다 (원본 --pin clear).");
        const { code } = await this.run(logId, site, how.launch).done;
        if (code !== 0) throw new Error(`원본이 비밀번호를 지우지 못했습니다 (code ${code}).`);
      }
    } else {
      const digits = raw.replace(/\D/g, "");
      if (!digits) throw new Error("비밀번호는 숫자만 넣어 주세요.");
      this.log(logId, "sys", `간편결제 비밀번호를 원본 설정에 적습니다 (--pin, ${digits.length}자리).`);
      const { code } = await this.run(logId, site, a.save(s, digits)).done;
      if (code !== 0) throw new Error(`원본이 비밀번호를 적지 못했습니다 (code ${code}).`);
    }
  }

  /** 태스크가 "세션이 끊겼다" 고 말했다. 원본이 확인해 준 것이니 다시 묻지 않고 만료로 돌린다. */
  sessionDead(id: string, line: string): void {
    const m = this.metas.find((one) => one.id === id);
    if (!m || m.loginStatus === "expired" || m.loginStatus === "logging_in") return;
    this.set(id, { loginStatus: "expired", statusNote: `태스크가 알렸습니다 — ${line}`, lastCheckedAt: now() });
  }
}
