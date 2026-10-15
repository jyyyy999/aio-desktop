/**
 * 사이트 어댑터. 원본 하나를 태스크로 돌리는 데 필요한 **사이트마다 다른 것**을 전부 여기 모은다.
 * TaskManager 와 워커는 이 모양만 알고, 롯데·네이버가 어떻게 다른지는 모른다.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  CommonSettings, LoginStatus, MonitorDef, Profile, QueuePeek, SiteId, SiteInfo, SiteSettings, TaskDef,
} from "../../shared/types.js";

/**
 * 모니터가 원본 설정의 max_buys_per_run 에 적는 값 — 사실상 끝없이. dry-run 도 "샀을 것" 을 산 것으로 세어 이 수에
 * 닿으면 감시를 끝내므로, 발견한 뒤에도 계속 보게 크게 둔다.
 */
export const MONITOR_MAX_BUYS = 1_000_000;

/** 워커를 어떻게 띄울지. 워커는 이것만 보고 원본을 들인다. */
export interface Launch {
  /** 원본 진입점. **들이는 순간 main() 이 돈다.** */
  entry: string;
  /** TS 소스를 그대로 들여야 하면 tsx 를 찾을 원본 프로젝트 폴더. 빌드된 JS 면 null. */
  tsxFrom: string | null;
  /** 원본의 명령줄 인자. process.argv 로 그대로 간다. */
  args: string[];
  /** 원본이 읽는 환경변수 (파일 위치·쿠키·비밀번호). */
  env: Record<string, string>;
  /**
   * 원본이 제 폴더에 박아 둔 파일 → 태스크 홈. 원본이 경로를 바꿀 길을 안 열어 둔 파일만
   * 적는다. 워커가 이 경로로 가는 쓰기를 돌린다 (원본은 모른다).
   */
  redirects: [from: string, to: string][];
  /** 원본의 표준입력으로 흘려 넣을 것 (롯데 --cookie -). 없으면 표준입력을 닫아 둔다. */
  stdin?: string;
}

/**
 * 매니저가 창을 띄워 사람이 로그인하게 하는 방법. 원본에 로그인 명령이 없는 사이트(롯데)에 쓴다.
 * 창이 쿠키를 모아 오면 프로필 폴더에 적는다 (save).
 */
export interface WindowLogin {
  kind: "window";
  /**
   * 창의 저장소. 프로필마다 따로 둔다 — 같이 쓰면 두 번째 프로필의 로그인 창이 첫 계정으로 로그인된
   * 채 열린다. persist: 로 두어 같은 프로필로 다시 로그인할 때는 로그인된 채로 열린다.
   */
  partition(profileId: string): string;
  startUrl: string;
  /** 이 주소에 보내질 쿠키를 모은다 — 브라우저 개발자 도구에서 Cookie 줄을 복사하는 것과 같다. */
  cookieUrl: string;
  /** 로그인 페이지 자체에서는 묻지 않는다 (아직 로그인 전이다). */
  isLoginPage(url: string): boolean;
  /** 이 쿠키로 로그인이 살아 있나 — 원본과 같은 물음으로. */
  alive(cookie: string): Promise<boolean>;
  /** 모은 쿠키(한 줄)를 프로필 폴더에 적는다. */
  save(dir: string, cookie: string): void;
}

/**
 * 원본의 로그인 명령을 그대로 띄운다 (네이버 --login: 원본이 창을 띄우고 판정·저장까지 한다).
 * 원본이 저장하는 자리는 워커가 프로필 폴더로 돌린다 (Launch.redirects).
 */
export interface LegacyLogin {
  kind: "legacy";
  launch(s: SiteSettings, dir: string): Launch;
}

/**
 * **콘솔용** 간편결제 비밀번호 (원본 설정 파일에 사이트마다 하나). 원본을 직접 돌릴 때만 쓰인다 — 태스크는
 * 프로필의 결제 비밀번호를 환경변수로 받는다 (SiteAdapter.launch 의 pin). 원본의 --pin 은 **실행 옵션이 아니라
 * 설정 파일에 적고 끝나는 명령**이다 — 태스크를 띄울 때 붙이면 감시하지 않고 적기만 하고 끝난다.
 */
export interface PinSpec {
  /** 지금 쓰이는 비밀번호 (환경변수 → 설정 파일, 원본과 같은 순서). */
  read(s: SiteSettings): { pin: string; fromEnv: string | null };
  /** 원본 --pin <숫자> 로 적는다. */
  save(s: SiteSettings, digits: string): Launch;
  /**
   * 지운다. 원본에 지우는 명령이 있으면(네이버 --pin clear) 그것으로, 없으면(롯데) 그 칸 하나만 비운다.
   */
  clear(s: SiteSettings): { kind: "legacy"; launch: Launch } | { kind: "file"; apply(): void };
  /** 비밀번호를 넣으면 원본이 어디까지 가나. */
  effect(s: SiteSettings): string;
}

/**
 * 로그인 정보가 어디 있고 어떻게 확인하나. 확인하는 법은 원본이 정한 것을 옮겨 적는다.
 * `dir` 은 프로필 폴더 (profiles/<id>) — 로그인 정보는 프로필마다 거기 따로 있다.
 */
export interface SessionSpec {
  loginUrl: string;
  /** 로그인 정보가 저장되는 파일 (프로필 폴더 안). */
  store(dir: string): string;
  check: Profile["sessionCheck"];
  /** 저장된 로그인 정보가 있기는 한가 (살아 있는지는 whoami 가 묻는다). */
  has(dir: string): boolean;
  /** 로그인 쿠키의 만료 시각을 알 수 있으면. */
  expiry(dir: string): string | null;
  /**
   * 원본의 "로그인 살아 있나" 명령. scratch 는 원본이 제 설정·로그를 만들어도 되는 빈 폴더 —
   * 태스크처럼 원본의 집(롯데 LOTTEON_HOME)이 따로 있어야 하는 사이트가 쓴다.
   */
  whoami(s: SiteSettings, dir: string, scratch: string): Launch;
  /**
   * 0.2 까지 원본 파일에 두던 로그인 정보(롯데 설정의 cookie · 네이버 naver/naver_session.json)를 프로필
   * 폴더에 베껴 온다. 프로필로 옮길 때 한 번 쓴다. → 베낀 것이 있었나
   */
  adopt(s: SiteSettings, dir: string): boolean;
  /** whoami 의 끝 코드·출력으로 판정한다. */
  judge(code: number, output: string): { status: LoginStatus; note: string };
  /** 태스크 출력에서 "세션이 끊겼다" 는 줄. 보이면 계정을 만료로 돌린다. */
  deadLine: RegExp;
  login: WindowLogin | LegacyLogin;
  pin: PinSpec;
}

/**
 * 원본이 지금 구매 중인가를 원본 출력과 파일로 알아보는 법. 설정이 바뀌어 다시 시작할 때
 * 구매 도중에 끊지 않으려고 쓴다.
 *
 * 구매를 시작하는 줄(start)이 나온 뒤 원본이 상태 파일(settledBy)을 다시 쓰면 그 구매 처리가
 * 끝난 것이다 — 원본이 산 기록을 확정하는 자리다.
 */
export interface BusySignal {
  start: RegExp;
  settledBy: string;
}

/**
 * 원본 출력으로 알아보는 진행. 모니터링 창의 확인 회차·단계에 쓴다 — 원본은 회차를 세어 찍지 않는다.
 *   round      확인 한 번을 뜻하는 로그 줄 (네이버: 상품마다 찍는 재고 줄)
 *   countdown  제자리에서 고쳐 쓰는 줄의 "다음 확인까지 남은 초" (롯데 ui.ts 의 status). 한 번 기다리는
 *              동안은 줄기만 하므로, 다시 올라가거나 같은 숫자를 새로 쓰면 방금 한 바퀴 본 것이다
 *   buying · checkout · paid  단계가 바뀌는 줄
 */
export interface ProgressSignal {
  round?: RegExp;
  countdown?: RegExp;
  /** 사이트 대기열(줄 서기)에 선 줄. 묶음: 1 내 앞 인원 · 2 줄 전체(없을 수 있다) · 3 예상 남은 초(없을 수 있다) */
  queue?: RegExp;
  /** 대기열을 빠져나왔다는 줄 */
  queueDone?: RegExp;
  buying: RegExp;
  checkout: RegExp;
  paid: RegExp;
}

/**
 * 모니터가 원본 출력에서 알아보는 것.
 *   found  발견. 원본이 dry-run 일 때 구매 자리에서만 찍는 줄이다 — 원본의 구매 판단(재입고 순간·옵션 재고·상한가)을
 *          통과했다는 뜻이라 이 줄 말고는 발견으로 보지 않는다 (오탐 방지). 첫 묶음은 상품 주소.
 *   stock  원본이 말한 재고 판정. 첫 묶음을 MonitorState.stock 에 둔다.
 */
export interface MonitorSignal {
  found: RegExp;
  stock: RegExp;
}

export interface PrepareCommand {
  label: string;
  cmd: string;
  args: string[];
  cwd: string;
}

export interface SiteAdapter {
  readonly id: SiteId;
  /** 앱이 aio/desktop 에 있을 때의 기본 위치. */
  defaults(aioDir: string): SiteSettings;
  info(s: SiteSettings, common: CommonSettings): SiteInfo;
  /**
   * 이 사이트 태스크의 알림이 가는 웹훅 (공통 → 씨앗 설정 → 빌려 씀, SiteInfo.webhook 과 같은 순서). 없으면 "".
   * 모니터의 재고 발견 알림도 이리로 보낸다 — 모니터는 dry-run 이라 원본이 보내지 않는다.
   */
  webhookUrl(s: SiteSettings, common: CommonSettings): string;
  /**
   * 태스크 홈에 원본이 읽을 설정을 쓰고, 워커를 어떻게 띄울지 돌려준다.
   * @param profileDir 태스크가 고른 로그인 프로필의 폴더. 없으면 로그인 없이 (TaskManager 가 그래도 되는 모드인지 먼저 본다).
   * @param pin 그 프로필의 결제 비밀번호. 없으면 "". **원본의 비밀번호 환경변수에 언제나 적는다** (빈 값도) — 사용자
   *            환경변수나 원본 설정 파일의 콘솔용 비밀번호가 태스크로 새어 들지 않게. 태스크 홈 설정에는 적지 않는다.
   * @param payProfileDir 결제창 로그인에 쓸 프로필(TaskDef.payProfileId)의 폴더. 없으면 null — 사람이 로그인한다.
   */
  launch(
    task: TaskDef, home: string, s: SiteSettings, common: CommonSettings, profileDir: string | null, pin: string,
    payProfileDir: string | null,
  ): Launch;
  /** 산 기록을 지운다 (원본의 --reset 과 같은 일). */
  resetState(home: string): void;
  /**
   * 모니터 홈에 원본이 읽을 설정을 **원본의 파일 이름 그대로** 쓴다 (롯데 lotteon_test_config.json · 네이버
   * smartstore_config.json). 씨앗을 베끼고 대상을 모니터의 상품 하나로, 사지 않는 감시(dry-run)가 발견한 뒤에도
   * 멈추지 않게 몇 칸을 고친다. 비밀(쿠키·비밀번호)과 웹훅은 비운다 — 알림은 매니저가 보낸다. → 쓴 파일
   */
  writeMonitorConfig(def: MonitorDef, home: string, s: SiteSettings): string;
  /**
   * 모니터를 어떻게 띄울지. 모니터 홈에 설정을 쓰고(writeMonitorConfig), 원본의 감시 루프를 dry-run 으로 띄우는
   * 인자를 돌려준다 — 원본이 구매 자리에서 멈추고 "…눌렀을 것입니다" 만 찍는다. 워커는 태스크와 같다.
   * @param profileDir 모니터의 로그인 프로필 폴더. 네이버는 있어야 하고(조회도 로그인 세션으로 한다), 롯데는 안 쓴다.
   */
  monitorLaunch(def: MonitorDef, home: string, s: SiteSettings, profileDir: string | null): Launch;
  /** 모니터가 원본 출력에서 알아보는 것. 확인 회차는 태스크와 같은 progress 로 센다. */
  readonly monitorSignal: MonitorSignal;
  /**
   * 멈추라고 한 뒤 이만큼 지나도 안 끝나면 죽인다. null 이면 기다린다 — 원본이 열린 구매
   * 창을 사람이 닫을 때까지 붙들고 있는 경우다. 그때 죽이면 결제하던 창이 같이 닫힌다.
   */
  readonly stopGraceMs: number | null;
  /**
   * 같은 로그인으로 도는 태스크끼리 더할 분당 요청과 그 한도. 원본의 요청률 안전장치는
   * 프로세스 하나 안에서만 센다 — 태스크를 프로세스로 가르면 그 합은 여기서 세야 한다.
   */
  readonly rate?: {
    perMin(task: TaskDef, s: SiteSettings): number;
    /** 모니터 하나의 분당 요청. 간격은 모니터가 정한다. */
    monitorPerMin(def: MonitorDef): number;
    warn: number;
    hard: number;
  };
  /** 준비 명령(빌드·설치). 할 것이 없으면 null. */
  prepare(s: SiteSettings): PrepareCommand | null;
  session: SessionSpec;
  /**
   * 돌고 있는 태스크에 바뀐 칸(sites.ts 의 liveFields)만 태스크 홈의 설정에 고쳐 쓴다. 원본이
   * 다음 바퀴에 스스로 읽는다. 원본이 실행 중에 설정을 다시 읽지 않는 사이트는 없다.
   */
  applyLive?(task: TaskDef, home: string): void;
  /** 구매 중인지 알아보는 법. 없으면 "멈춤 = Ctrl+C" 가 이미 구매를 기다려 준다는 뜻이다 (네이버). */
  busy?: BusySignal;
  progress: ProgressSignal;
  /**
   * 열리기 전 대기열을 바깥에서 본다 — 쿠키 없이 읽기만 하고 줄에 서지 않는다. 대기열이 있는 사이트(롯데)만.
   * 태스크 창이 켰을 때만 main 이 몇 초마다 부른다. 못 읽으면 error 에 까닭.
   */
  peekQueue?(task: TaskDef): Promise<Omit<QueuePeek, "taskId" | "at">>;
}

/** 원본이 읽는 도중에 반쯤 쓰인 파일을 보지 않게, 옆에 쓰고 바꿔치기한다. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

export type JsonObject = Record<string, unknown>;

export function readJson(path: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8").replace(/^﻿/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
  } catch {
    return null;
  }
}

export function objectAt(obj: JsonObject | null, key: string): JsonObject {
  const value = obj?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
