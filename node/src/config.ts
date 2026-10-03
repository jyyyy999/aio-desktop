/**
 * 설정과 상태. **파이썬 판이 쓰던 파일을 그대로 쓴다.**
 *
 * 쿠키를 두 벌 관리하게 만들지 않는다 — `--cookie` 로 한 번 넣은 것이 어느 쪽으로
 * 돌리든 그대로 쓰인다. 담은 기록(bnkr_buy_state.json)도 같은 이유로 공유한다.
 * 한쪽으로 담아 놓고 다른 쪽으로 켰을 때 또 담으면 두 개가 된다.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 파이썬 파일들이 있는 곳. 설정·상태·로그가 전부 거기 있다. */
function findBase(): string {
  const env = (process.env["BNKR_HOME"] || "").trim();
  if (env) return resolve(env);
  // dist/ 에서 돌든 src/ 에서 돌든 같은 곳을 찾아야 한다. 표지를 보고 올라간다.
  let here = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 5; up++) {
    if (existsSync(join(here, "bnkr_buy.py")) || existsSync(join(here, "bnkr_buy_config.json"))) {
      return here;
    }
    here = dirname(here);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export const BASE = findBase();
export const CONFIG_PATH = join(BASE, "bnkr_buy_config.json");
export const STATE_PATH = join(BASE, "bnkr_buy_state.json");
export const LOG_PATH = join(BASE, "bnkr-buy.log");
// 결제창에서 눌러야 할 것을 못 찾았을 때, 그 창에 무엇이 있었는지 적어 두는 곳.
export const PG_DUMP_PATH = join(BASE, "bnkr-pg-dump.txt");
// 웹훅을 따로 안 적으면 감시 스크립트 것을 빌려 쓴다.
export const STOCK_CONFIG_PATH = join(BASE, "bnkr_config.json");

export type Mode = "ADD" | "DIRECT" | "GIFT";
export type OrderAction = "open" | "agree" | "submit";
/** 누르는 것과 칸에 넣는 것을 한 목록에 섞어 둔다. 순서가 있는 일이라서다. */
export type PgStep = string | { fill?: string; label?: string; value?: string };

export interface DiscoverSpec {
  url?: string;
  keyword?: string;
  sword?: string;
  contains?: string | string[];
  ea?: number;
  mode?: string;
  max_price?: number;
  label?: string;
  max_pages?: number;
}

export interface Config {
  cookie: string;
  discord_webhook_url: string;
  mention: string;
  targets: unknown[];
  poll_interval_seconds: number;
  poll_jitter_seconds: number;
  max_concurrency: number;
  discover: (string | DiscoverSpec)[];
  discover_interval_seconds: number;
  session_check_minutes: number;
  buy_on_restock_only: boolean;
  discord_notify: string[];
  max_carts_per_run: number;
  stop_after_success: boolean;
  cooldown_minutes: number;
  max_price: number;
  allow_option_goods: boolean;
  max_attempts: number;
  retry_delay_seconds: number;
  open_browser: boolean;
  browser: string;
  browser_headless: boolean;
  browser_offscreen: boolean;
  browser_timeout_seconds: number;
  browser_profile_dir: string;
  prelogin_url: string;
  prelogin_marker: string;
  prelogin_wait_minutes: number;
  preheat_browser: boolean;
  meta_fresh_seconds: number;
  order_action: OrderAction;
  pg_capture: boolean;
  pg_clicks: PgStep[];
  pg_settle_seconds: number;
  pg_webhook_url: string;
  pg_mention: string;
  pg_probe: string[];
  pg_finish: PgStep[];
  paid_wait_minutes: number;
  paid_markers: string[];
  queue_watch: boolean;
  queue_wait_seconds: number;
  queue_markers: string[] | null;
  [key: string]: unknown;
}

/**
 * 기본값. 파이썬 판의 DEFAULT_CONFIG 와 같은 것이라, 무엇이 왜 이 값인지는 그쪽
 * 주석에 적혀 있다. 여기서 다시 적으면 둘이 어긋날 때 어느 쪽이 맞는지 알 수 없게 된다.
 */
export const DEFAULT_CONFIG: Config = {
  cookie: "",
  discord_webhook_url: "",
  mention: "@everyone",
  targets: [],
  poll_interval_seconds: 15,
  poll_jitter_seconds: 4,

  // 한 바퀴에 몇 개를 동시에 볼까. **조회와 목록 훑기에만 걸린다** —
  // 담기·주문서·결제는 어떤 값을 주든 한 줄로 간다(계정이 하나고, 수량 제한도 계정당이라
  // 같은 것을 여럿이 두드릴 이유가 없다. 잘못 건드리면 같은 상품을 두 번 담는 쪽으로 간다).
  //
  // 감시 대상이 이 수보다 적으면 아무것도 달라지지 않는다. 20~50개로 늘 때 의미가 생긴다.
  // 올린다고 계속 빨라지지도 않는다 — 한 아이피에서 동시에 두드리는 횟수이기도 하다.
  max_concurrency: 4,

  discover: [],
  discover_interval_seconds: 15,
  session_check_minutes: 10,
  // 품절 → 구매가능 으로 **바뀌는 순간**에만 담는다. 켤 때 이미 팔던 것은 안 건드린다.
  buy_on_restock_only: true,
  discord_notify: ["qr", "paid"],
  // 한 줄 잘못 써서 20개를 담는 일이 없도록 기본값을 보수적으로 둔다.
  max_carts_per_run: 5,
  stop_after_success: true,
  cooldown_minutes: 30,
  max_price: 0,
  allow_option_goods: false,
  max_attempts: 3,
  retry_delay_seconds: 2,
  open_browser: true,
  browser: "selenium",
  browser_headless: false,
  browser_offscreen: false,
  browser_timeout_seconds: 20,
  browser_profile_dir: "",
  prelogin_url: "",
  prelogin_marker: "nidlogin",
  prelogin_wait_minutes: 5,
  preheat_browser: true,
  meta_fresh_seconds: 60,
  order_action: "submit",
  pg_capture: true,
  pg_clicks: ["동의합니다", "다음", "카카오페이", "다음"],
  pg_settle_seconds: 3,
  pg_webhook_url: "",
  pg_mention: "",
  pg_probe: [],
  pg_finish: [],
  paid_wait_minutes: 10,
  paid_markers: ["주문이 완료", "주문완료", "order_complete", "orderComplete", "order_result"],
  queue_watch: true,
  queue_wait_seconds: 10,
  queue_markers: null,
};

/** 담지 않고 무엇을 담을지만 본다. 프로세스 하나에 하나뿐인 상태라 여기 둔다. */
export const run = { dryRun: false };

/**
 * 설정 파일에 적힌 그대로 돌려준다.
 *
 * 환경변수나 빌려온 웹훅을 여기서 섞지 않는다. 섞어 두면 --add 처럼 설정을 저장하는
 * 명령이 그 값을 파일에 박아 넣는다.
 */
export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  }
  const own = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...own };
}

export function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

export function cookieOf(cfg: Config): string {
  return (process.env["BNKR_COOKIE"] || cfg.cookie || "").trim();
}

/**
 * 웹훅. 안 적어 두면 감시 스크립트 설정에서 빌려 온다.
 * 채널을 두 군데 적어 둘 이유가 없다. 빌려 쓰기만 하고 베껴 두지는 않는다.
 */
export function webhookOf(cfg: Config): string {
  const own = (cfg.discord_webhook_url || "").trim();
  if (own) return own;
  const env = (process.env["DISCORD_BNKR_WEBHOOK_URL"] || "").trim();
  if (env) return env;
  try {
    const stock = JSON.parse(readFileSync(STOCK_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    return String(stock["discord_webhook_url"] || "").trim();
  } catch {
    return "";
  }
}

/** 결제창 화면을 보낼 곳. 안 적어 두면 일반 알림과 같은 채널로 간다. */
export function pgWebhookOf(cfg: Config): string {
  return (cfg.pg_webhook_url || "").trim() || webhookOf(cfg);
}

export interface TargetEntry {
  name?: string;
  status?: string;
  stock?: number;
  done?: boolean;
  landed?: boolean;
  blocked?: string;
  carted_at?: string;
  last_try_at?: string;
}

export interface GoodsCache {
  [gno: string]: Record<string, unknown> & { fetched_at?: number };
}

export interface State {
  targets?: Record<string, TargetEntry>;
  goods?: GoodsCache;
  discovered?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

export function loadState(): State {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as State;
  } catch {
    return {};
  }
}

export function saveState(state: State): void {
  if (run.dryRun) return;
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/** 설정 파일이 마지막으로 바뀐 시각. 바뀌었는지만 알면 되므로 내용은 안 본다. */
export function configStamp(): bigint {
  try {
    return statSync(CONFIG_PATH, { bigint: true }).mtimeNs;
  } catch {
    return 0n;
  }
}

/** 크롬 프로필 폴더. 안 정해 뒀으면 null (매번 새 임시 프로필). */
export function profileDir(cfg: Config): string | null {
  const value = (cfg.browser_profile_dir || "").trim();
  if (!value) return null;
  return isAbsolute(value) ? value : join(BASE, value);
}

/** 이 소식을 디스코드로 보낼까. 진행 상황은 화면에 있고, 폰으로 받을 것은 손댈 차례뿐이다. */
export function wants(cfg: Config, event: string): boolean {
  return (cfg.discord_notify || []).includes(event);
}
