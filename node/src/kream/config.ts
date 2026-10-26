/**
 * KREAM(kream.co.kr) 브랜드배송 설정. 집(aio/node)의 규약을 따른다.
 *
 *   KREAM_HOME          이 폴더가 설정·상태·로그·크롬 프로필의 집이다 (태스크마다 다르다)
 *   kream_config.json   원본이 읽는 설정 (데스크톱 어댑터 sites/kream.ts 도 이 파일을 쓴다)
 *   kream_state.json    산 기록·마지막 재고
 *   kream.log           로그
 *   kream-shots/        실패했을 때의 화면·HTML (사람이 보고 고칠 재료)
 *   chrome-profile/     크롬 프로필
 *
 * 비밀은 파일보다 환경변수를 먼저 본다 — 태스크는 KREAM_COOKIE · KREAM_PG_PASSWORD 로만 받는다
 * (데스크톱이 태스크 홈의 설정에는 비밀을 적지 않는다).
 *
 * 설정 칸 이름은 롯데·슈프림처럼 **밑줄 이름(snake_case)** 이다.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findBase(): string {
  const env = (process.env["KREAM_HOME"] || "").trim();
  if (env) return resolve(env);
  // dist/kream/ 에서 돌든 src/kream/ 에서 돌든 같은 곳(aio/node)을 찾아야 한다.
  let here = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(here, "package.json")) && existsSync(join(here, "src"))) return here;
    here = dirname(here);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export const BASE = findBase();
export const CONFIG_PATH = join(BASE, "kream_config.json");
export const STATE_PATH = join(BASE, "kream_state.json");
export const LOG_PATH = join(BASE, "kream.log");
export const SHOT_DIR = join(BASE, "kream-shots");
export const CHROME_PROFILE = join(BASE, "chrome-profile");
/**
 * 결제 비밀번호까지 넣었는데 완료를 확인하지 못한 시도. 다음 실행에서 **겹쳐 사지 않게** 막는 표시다.
 * (완료 화면을 못 본 채 중지하면 실제로는 결제됐을 수 있다 — 중복 구매가 더 비싸다)
 */
export const PENDING_PATH = join(BASE, "kream-pending.json");

export const ORIGIN = "https://kream.co.kr";

/**
 * --action. **데스크톱 shared/sites.ts 의 KREAM_ACTIONS 와 같아야 한다** (src/legacy/contract.ts 가 맞대 본다).
 *   open    주문서(결제 화면)까지 — 사람이 결제한다
 *   submit  결제하기까지 누른다 — 결제 비밀번호가 있으면 자판까지 누르고(pin.ts), 없으면 사람이 넣는다
 */
export const ACTIONS = ["open", "submit"] as const;
export type OrderAction = (typeof ACTIONS)[number];

/** 상품 한 줄. 데스크톱 태스크 폼의 한 줄이 이대로 온다. */
export interface Target {
  /** 상품 주소 (https://kream.co.kr/products/<번호>) 또는 상품번호 */
  url: string;
  /** 옵션(사이즈) — 옵션 고르기 창에 보이는 글자 그대로 (예: 270, ONE SIZE). 비우면 하나뿐일 때만 고른다 */
  option: string;
  ea: number;
  /** 결제 화면의 최종 금액 상한 (0 = 안 본다) */
  max_price: number;
  label: string;
}

export interface BuyConfig {
  /** 자동구매를 켤지 (false 면 감시만) */
  enabled: boolean;
  /**
   * 결제 화면에서 고를 결제 수단 — 화면에 보이는 글자 (예: "계좌 간편결제", "카드 간편결제", "네이버페이").
   * 비우면 KREAM 이 골라 둔 것(마지막에 쓴 것)을 그대로 쓴다.
   */
  payment_method: string;
  /** 필수 동의 체크를 자동으로 켠다 */
  agree_all: boolean;
  /** 결제하기를 누른 뒤 주문 완료를 기다리는 최대 시간(초) — 자동으로 비밀번호를 눌러도 결제사 승인에 시간이 걸리고, 사람이 넣을 때는 그 시간까지 기다린다 */
  complete_timeout_seconds: number;
  /** 하나 사면 끝낼지 */
  stop_after_success: boolean;
  /** 한 번 돌 때 최대 몇 번 살지 (모니터는 사실상 끝없이 — 어댑터가 큰 수를 적는다) */
  max_buys_per_run: number;
}

export interface KreamConfig {
  /** 로그인 쿠키 한 줄 (콘솔용). 태스크는 KREAM_COOKIE 로 받는다 */
  cookie: string;
  discord_webhook_url: string;
  /** 어디까지 (--action 이 없을 때) */
  order_action: OrderAction;
  /** KREAM 간편결제 비밀번호 6자리 (콘솔용). 태스크는 KREAM_PG_PASSWORD 로 받는다 */
  pg_password: string;
  /** 확인 간격 */
  check_interval_ms: number;
  /** 확인 간격의 하한 — 이보다 촘촘히 적어도 이 값으로 올려서 본다 */
  min_interval_ms: number;
  /** 확인이 실패하면 몇 번까지 곧바로 다시 볼까 (넘으면 한 바퀴 쉰다) */
  max_retries: number;
  retry_delay_ms: number;
  /** 품절 → 구매가능으로 바뀌는 순간에만 산다. false 면 켰을 때 이미 살 수 있어도 산다 */
  buy_on_restock_only: boolean;
  /** 크롬을 모니터 밖에 세운다 (사람이 볼 일이 생기면 그 창만 화면 안으로 올린다) */
  offscreen: boolean;
  targets: Target[];
  buy: BuyConfig;
}

export const DEFAULT_CONFIG: KreamConfig = {
  cookie: "",
  discord_webhook_url: "",
  order_action: "submit",
  pg_password: "",
  check_interval_ms: 5000,
  min_interval_ms: 3000,
  max_retries: 3,
  retry_delay_ms: 3000,
  buy_on_restock_only: false,
  offscreen: true,
  targets: [],
  buy: {
    enabled: true,
    payment_method: "",
    agree_all: true,
    complete_timeout_seconds: 180,
    stop_after_success: true,
    max_buys_per_run: 1,
  },
};

/** 실행 중에만 쓰는 값 (설정 파일에 없는 것). */
export const run = { dryRun: false };

type Json = Record<string, unknown>;

function readJson(path: string): Json | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8").replace(/^﻿/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

function targetOf(raw: unknown): Target | null {
  if (typeof raw === "string") return raw.trim() ? { url: raw.trim(), option: "", ea: 1, max_price: 0, label: "" } : null;
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Json;
  const url = str(t["url"]).trim();
  if (!url) return null;
  return {
    url,
    option: str(t["option"]).trim(),
    ea: Math.max(1, Math.floor(num(t["ea"], 1))),
    max_price: Math.max(0, num(t["max_price"], 0)),
    label: str(t["label"]).trim(),
  };
}

export function loadConfig(): KreamConfig {
  const raw = readJson(CONFIG_PATH) ?? {};
  const d = DEFAULT_CONFIG;
  const buy = (raw["buy"] && typeof raw["buy"] === "object" ? raw["buy"] : {}) as Json;
  const action = str(raw["order_action"], d.order_action);
  return {
    cookie: str(raw["cookie"]),
    discord_webhook_url: str(raw["discord_webhook_url"]),
    order_action: (ACTIONS as readonly string[]).includes(action) ? (action as OrderAction) : d.order_action,
    pg_password: str(raw["pg_password"]),
    check_interval_ms: num(raw["check_interval_ms"], d.check_interval_ms),
    min_interval_ms: num(raw["min_interval_ms"], d.min_interval_ms),
    max_retries: Math.max(0, Math.floor(num(raw["max_retries"], d.max_retries))),
    retry_delay_ms: Math.max(0, num(raw["retry_delay_ms"], d.retry_delay_ms)),
    buy_on_restock_only: bool(raw["buy_on_restock_only"], d.buy_on_restock_only),
    offscreen: bool(raw["offscreen"], d.offscreen),
    targets: (Array.isArray(raw["targets"]) ? raw["targets"] : []).map(targetOf).filter((t): t is Target => !!t),
    buy: {
      enabled: bool(buy["enabled"], d.buy.enabled),
      payment_method: str(buy["payment_method"], d.buy.payment_method).trim(),
      agree_all: bool(buy["agree_all"], d.buy.agree_all),
      complete_timeout_seconds: Math.max(10, num(buy["complete_timeout_seconds"], d.buy.complete_timeout_seconds)),
      stop_after_success: bool(buy["stop_after_success"], d.buy.stop_after_success),
      max_buys_per_run: Math.max(1, Math.floor(num(buy["max_buys_per_run"], d.buy.max_buys_per_run))),
    },
  };
}

export function saveConfig(cfg: KreamConfig): void {
  writeJsonAtomic(CONFIG_PATH, cfg);
}

export function ensureDirs(): void {
  mkdirSync(BASE, { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });
}

/** 로그인 쿠키 — 환경변수가 먼저 (태스크마다 다른 프로필). */
export function cookieOf(cfg: KreamConfig): string {
  return (process.env["KREAM_COOKIE"] ?? cfg.cookie ?? "").trim();
}

/**
 * 결제 비밀번호. 환경변수에 **적혀 있기만 하면**(빈 값도) 그것을 쓴다 — 데스크톱은 프로필에 비밀번호가 없을 때
 * 빈 값을 넘겨, 콘솔용 설정 파일의 비밀번호가 태스크로 새어 들지 않게 한다.
 */
export function pinOf(cfg: KreamConfig): string {
  const env = process.env["KREAM_PG_PASSWORD"];
  return (env !== undefined ? env : cfg.pg_password).replace(/\D/g, "");
}

/**
 * 자동 로그인에 쓸 이메일·비밀번호. **환경변수로만** 받는다 — 설정 파일에는 칸이 없다. 데스크톱이 프로필에 암호화해 둔
 * 것을 태스크·로그인을 띄우기 직전에 풀어 넘긴다. 없으면 null (사람이 로그인한다).
 */
export function credentialsOf(): { email: string; password: string } | null {
  const email = (process.env["KREAM_LOGIN_EMAIL"] ?? "").trim();
  const password = process.env["KREAM_LOGIN_PASSWORD"] ?? "";
  return email && password ? { email, password } : null;
}

/** 다시 로그인해 받은 쿠키를 적어 둘 프로필의 쿠키 파일 (데스크톱이 KREAM_COOKIE_FILE 로 알려 준다). 없으면 "". */
export function cookieFileOf(): string {
  return (process.env["KREAM_COOKIE_FILE"] ?? "").trim();
}

export function webhookOf(cfg: KreamConfig): string {
  return (process.env["KREAM_WEBHOOK"] || cfg.discord_webhook_url || "").trim();
}

/** 산 기록 하나. */
export interface BuyRecord {
  at: string;
  order_no: string;
  what: string;
}

export interface State {
  /** 상품번호 → 산 기록 (--reset 이 지운다) */
  _buy: Record<string, BuyRecord>;
  /** 상품번호 → 마지막으로 본 재고 (재입고 순간을 알아보는 재료) */
  last: Record<string, { in_stock: boolean; price: number; at: string }>;
}

export function loadState(): State {
  const raw = readJson(STATE_PATH) ?? {};
  const buy = raw["_buy"] && typeof raw["_buy"] === "object" ? (raw["_buy"] as State["_buy"]) : {};
  const last = raw["last"] && typeof raw["last"] === "object" ? (raw["last"] as State["last"]) : {};
  return { _buy: buy, last };
}

export function saveState(state: State): void {
  writeJsonAtomic(STATE_PATH, state);
}

/** 결제 비밀번호까지 넣고 완료를 못 본 시도 — 겹쳐 사기를 막는 표시. */
export interface PendingBuy {
  at: string;
  what: string;
}

export function readPending(): PendingBuy | null {
  const raw = readJson(PENDING_PATH);
  if (!raw) return null;
  const at = str(raw["at"]);
  const what = str(raw["what"]);
  return at ? { at, what } : null;
}

export function writePending(what: string): void {
  writeJsonAtomic(PENDING_PATH, { at: new Date().toISOString(), what });
}

export function clearPending(): void {
  try {
    rmSync(PENDING_PATH, { force: true });
  } catch {
    /* 없으면 그만 */
  }
}
