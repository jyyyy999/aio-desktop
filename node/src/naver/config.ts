/**
 * 설정과 상태. **파이썬 판이 쓰던 파일을 그대로 쓴다.**
 *
 * 쿠키를 두 벌 관리하게 만들지 않는다 — `--cookie` 로 한 번 넣은 것이 어느 쪽으로
 * 돌리든 그대로 쓰인다. 산 기록(naver_buy_state.json)도 같은 이유로 공유한다.
 * 한쪽으로 사 놓고 다른 쪽으로 켰을 때 또 사면 두 개가 된다.
 *
 * 그래서 **둘을 동시에 돌리지 않는다.** 같은 상태 파일에 번갈아 쓰면 마지막에 쓴
 * 쪽만 남는다.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log, useLogFile } from "../log.js";

/** 파이썬 파일들이 있는 곳. 설정·상태·로그가 전부 거기 있다. */
function findBase(): string {
  const env = (process.env["NAVER_HOME"] || "").trim();
  if (env) return resolve(env);
  // dist/naver 에서 돌든 src/naver 에서 돌든 같은 곳을 찾아야 한다. 표지를 보고 올라간다.
  let here = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(here, "naver_buy.py")) || existsSync(join(here, "naver_buy_config.json"))) {
      return here;
    }
    here = dirname(here);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export const BASE = findBase();
export const CONFIG_PATH = join(BASE, "naver_buy_config.json");
export const STATE_PATH = join(BASE, "naver_buy_state.json");
export const LOG_PATH = join(BASE, "naver-buy.log");
// 상품 페이지에서 무엇을 찾았는지 적어 두는 곳. --probe 가 쓴다.
export const DUMP_PATH = join(BASE, "naver-page-dump.txt");
// 결제하기를 누른 뒤 무엇이 떴는지 적어 두는 곳. --dump-pay 와 pg_dump 가 쓴다.
export const PG_DUMP_PATH = join(BASE, "naver-pg-dump.txt");
// 웹훅을 따로 안 적으면 bnkr 쪽 것을 빌려 쓴다. 채널을 두 벌 만들 이유가 없다.
export const BNKR_CONFIG_PATH = join(BASE, "bnkr_buy_config.json");

/**
 * 로그를 네이버 쪽 파일로 돌린다. **이 파일을 들이는 순간 바뀐다.**
 *
 * main() 안에서 부르면 늦다 — 인자를 잘못 줘서 그 앞에서 나는 오류까지 naver-buy.log
 * 에 남아야 한다. 네이버 판의 모든 파일이 이 파일을 거치므로 여기가 가장 이른 자리다.
 */
useLogFile(LOG_PATH);

export const IN_STOCK = "instock";
export const SOLDOUT = "soldout";
export type Status = typeof IN_STOCK | typeof SOLDOUT;
export const STATUS_LABEL: Record<string, string> = { [IN_STOCK]: "구매 가능", [SOLDOUT]: "품절" };

/**
 * 주문서에 도착한 뒤 어디까지 갈 것인가. bnkr 쪽과 이름을 맞췄다.
 *
 *   "open"    (기본) 주문서를 열어 두고 멈춘다. 결제 버튼은 사람이 누른다
 *   "submit"  결제하기까지 누르고 **인증 화면 앞에서** 멈춘다. pg_password 를 적어 뒀으면
 *             비밀번호 자판까지 누른다 — 그러면 결제가 끝난다
 *
 * 롯데온 판에 있는 "agree" 는 두지 않는다. 네이버페이 주문서는 필수 동의를 따로 누르지
 * 않아도 결제하기가 먹었다 (2026-08-20 submit 판에서 막힘 없이 넘어갔다).
 */
export const ORDER_SUBMIT = "submit";
export const ACTIONS = ["open", ORDER_SUBMIT] as const;
export type OrderAction = (typeof ACTIONS)[number];
/** 실제로 어디까지 갔나. 시킨 것(OrderAction)과 다를 수 있다 — 못 가면 opened 에 남는다. */
export type Stage = "opened" | "submitted";

/** 설정의 order_action 을 읽는다. 모르는 값이면 덜 가는 쪽(open)으로 둔다. */
export function actionOf(cfg: Config): OrderAction {
  const raw = String(cfg.order_action ?? "open").toLowerCase();
  return raw === ORDER_SUBMIT ? ORDER_SUBMIT : "open";
}

export interface TargetSpec {
  url?: string;
  ea?: number;
  option?: string;
  max_price?: number;
  label?: string;
}

export interface Config {
  cookie: string;
  discord_webhook_url: string;
  mention: string;
  targets: (string | TargetSpec)[];
  poll_interval_seconds: number;
  poll_jitter_seconds: number;
  min_interval_seconds: number;
  session_check_minutes: number;
  buy_on_restock_only: boolean;
  discord_notify: string[];
  max_buys_per_run: number;
  stop_after_success: boolean;
  cooldown_minutes: number;
  max_price: number;
  max_attempts: number;
  retry_delay_seconds: number;
  open_browser: boolean;
  browser_headless: boolean;
  browser_timeout_seconds: number;
  browser_poll_interval_seconds?: number;
  order_action: string;
  use_api: boolean;
  pg_dump: boolean;
  pg_password: string;
  paid_wait_minutes: number;
  paid_markers: string[];
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
  // 상품 페이지 한 장이 무겁다. 이보다 촘촘하게 두드리지 않는다.
  min_interval_seconds: 5,
  session_check_minutes: 10,
  // 품절 → 구매가능 으로 **바뀌는 순간**에만 산다.
  buy_on_restock_only: true,
  discord_notify: ["opened", "blocked", "session"],
  max_buys_per_run: 1,
  stop_after_success: true,
  cooldown_minutes: 30,
  max_price: 0,
  max_attempts: 3,
  retry_delay_seconds: 2,
  open_browser: true,
  // **켜지 마라.** headless 크롬으로 열면 네이버가 상품 페이지 대신 막는 화면을 준다.
  browser_headless: false,
  browser_timeout_seconds: 20,
  order_action: "open",
  use_api: false,
  // ↓ 여기서부터는 파이썬 판에 없는 것이다. 롯데온 판에서 가져왔다.
  //
  // 결제하기 다음이 어긋나면(결제창 신호를 못 봤거나 사이트가 막았으면) 화면을
  // naver-pg-dump.txt 에 받아 적는다. 결제창은 아무 때나 띄워 볼 수 있는 화면이 아니라,
  // 어긋난 그 판이 고칠 재료를 얻을 유일한 기회다.
  pg_dump: true,
  // 네이버페이 간편결제 비밀번호. 적어 두면 결제하기 뒤 뜨는 자판을 읽어 눌러 준다
  // (pin.ts). **비워 두면 누르지 않는다** — 그게 기본이다. 네이버페이는 비밀번호를
  // 넣는 순간 결제가 끝나므로, 이걸 채우면 사람 손 없이 산다. 파일에 평문으로 남는 것이
  // 싫으면 환경변수 NAVER_PG_PASSWORD 로 넘긴다.
  pg_password: "",
  // 결제창까지 간 뒤 결제가 끝나기를 이만큼 지켜본다. discord_notify 에 "paid" 가 있어야 돈다.
  paid_wait_minutes: 10,
  // 결제 완료로 볼 글자(주소나 화면). **네이버페이 완료 화면은 아직 못 봤다** — 롯데온
  // 판과 같은 일반 문구만 넣어 둔다. 화면 글자는 주문서(/ordersheet)를 떠났을 때만 믿는다.
  paid_markers: ["주문이 완료", "주문완료", "결제가 완료", "결제 완료"],
};

/** 사지 않고 무엇을 살지만 본다. 프로세스 하나에 하나뿐인 상태라 여기 둔다. */
export const run = { dryRun: false };

/**
 * 할 말은 이미 화면에 적었으니 조용히 1 로 끝내라는 뜻.
 *
 * 캡차 벽처럼 "고칠 자리가 있는 고장" 이 아닌 것들이 여기로 온다. 그런 것까지 오류
 * 메시지를 한 줄 더 뱉으면, 정작 사람이 읽어야 할 안내가 그 아래로 밀린다.
 */
export class Quit extends Error {
  constructor() {
    super("");
  }
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    throw new Error(`${basename(CONFIG_PATH)} 을 만들었습니다. 상품과 쿠키를 넣고 다시 실행해 주세요.`);
  }
  seenAt = mtimeOf();
  const own = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...own };
}

export function saveConfig(cfg: Config): void {
  // 이번 실행에서만 바꾼 값(--action)은 파일에 쓰지 않는다.
  const out: Record<string, unknown> = { ...cfg };
  for (const key of Object.keys(RUN_OVERRIDES)) {
    if (key in savedValues) out[key] = savedValues[key];
    else delete out[key];
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2), "utf-8");
  // 우리가 쓴 것을 사람이 고친 것으로 읽어 들이지 않게 한다.
  seenAt = mtimeOf();
}

// --- 켜 놓은 채로 설정 고치기 ---
//
// 감시 루프가 바퀴마다 reloadConfig 를 부른다. 파일이 바뀌었으면 다시 읽어 **같은 cfg
// 객체에** 덮어쓴다 — cfg 를 들고 있는 모든 자리(주문·알림·비밀번호)가 따로 챙기지 않아도
// 새 값을 보게 하려는 것이다.

/** 마지막으로 읽은(또는 우리가 쓴) 설정 파일의 수정 시각. */
let seenAt = 0;
/** 고치다 만(JSON 이 깨진) 파일을 이미 일러 준 수정 시각. 같은 말을 되풀이하지 않는다. */
let badAt = 0;

/** 명령줄로 이번 실행에서만 바꾼 값. 다시 읽어도 이게 이긴다 (--action 따위). */
export const RUN_OVERRIDES: Partial<Config> = {};
/** 덮어쓰기 전 파일에 있던 값. saveConfig 가 그대로 돌려 적는다. */
const savedValues: Record<string, unknown> = {};

/** 이번 실행에서만 값을 바꾼다. 파일에는 쓰지 않고, 다시 읽어도 유지된다. */
export function overrideForRun<K extends keyof Config>(cfg: Config, key: K, value: Config[K]): void {
  if (!(key in RUN_OVERRIDES) && key in cfg) savedValues[key as string] = cfg[key];
  RUN_OVERRIDES[key] = value;
  cfg[key] = value;
}

function mtimeOf(): number {
  try {
    return statSync(CONFIG_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

// 값을 화면에 적지 않는 칸. 무엇이 바뀌었는지만 말한다.
const SECRET_KEYS = new Set(["cookie", "pg_password", "discord_webhook_url"]);

/**
 * 설정 파일이 바뀌었으면 다시 읽는다. → 바뀐 칸 이름들 (안 바뀌었으면 null)
 *
 * **고치다 만 파일은 읽지 않는다.** 저장하는 도중이나 쉼표 하나 빠진 파일을 읽으면
 * JSON 이 깨진다. 그때는 한 번 일러 주고 예전 값으로 계속 돈다 — 감시를 멈추지 않는다.
 * 다음에 저장하면 그때 읽는다.
 */
export function reloadConfig(cfg: Config): string[] | null {
  const at = mtimeOf();
  if (!at || at === seenAt) return null;

  let fresh: Config;
  try {
    const own = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
    fresh = { ...DEFAULT_CONFIG, ...own };
  } catch (e) {
    if (badAt !== at) {
      badAt = at;
      log.warn(`${basename(CONFIG_PATH)} 을 읽지 못했습니다 — 예전 설정으로 계속 봅니다 ` +
        `(${(e as Error).message.split("\n")[0]}). 고쳐서 저장하면 그때 읽습니다.`);
    }
    return null;
  }
  seenAt = at;

  for (const key of Object.keys(RUN_OVERRIDES)) {
    savedValues[key] = fresh[key];
  }
  Object.assign(fresh, RUN_OVERRIDES);
  const keys = new Set([...Object.keys(cfg), ...Object.keys(fresh)]);
  const changed = [...keys].filter((key) => JSON.stringify(cfg[key]) !== JSON.stringify(fresh[key]));
  if (!changed.length) return null;

  for (const key of Object.keys(cfg)) {
    if (!(key in fresh)) delete cfg[key];
  }
  Object.assign(cfg, fresh);

  const shown = changed.map((key) => SECRET_KEYS.has(key) ? `${key}(값은 안 적음)` : key);
  log.info(`설정이 바뀌어 다시 읽었습니다 — ${shown.join(", ")}`);
  return changed;
}

/** 간편결제 비밀번호. 환경변수가 먼저다. 숫자만 남긴다. */
export function passwordOf(cfg: Config): string {
  return (process.env["NAVER_PG_PASSWORD"] || cfg.pg_password || "").replace(/\D/g, "");
}

export function cookieOf(cfg: Config): string {
  return (process.env["NAVER_COOKIE"] || cfg.cookie || "").trim();
}

/** 웹훅을 따로 안 적었으면 bnkr 쪽 것을 빌려 쓴다. 빌려 쓰기만 하고 베껴 두지는 않는다. */
export function webhookOf(cfg: Config): string {
  const own = (cfg.discord_webhook_url || "").trim();
  if (own) return own;
  try {
    const borrowed = JSON.parse(readFileSync(BNKR_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    return String(borrowed["discord_webhook_url"] || "").trim();
  } catch {
    return "";
  }
}

export function wants(cfg: Config, event: string): boolean {
  return (cfg.discord_notify || []).includes(event);
}

/** 상태 파일에 상품마다 적어 두는 것. 파이썬 판이 쓰는 이름 그대로다. */
export interface TargetEntry {
  name?: string;
  status?: string;
  stock?: number;
  done?: boolean;
  opened?: boolean;
  blocked?: string;
  opened_at?: string;
  last_try_at?: string;
  stage?: Stage;
}

export interface State {
  targets?: Record<string, TargetEntry>;
  [key: string]: unknown;
}

export function loadState(): State {
  if (!existsSync(STATE_PATH)) return { targets: {} };
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as State;
  } catch {
    return { targets: {} };
  }
}

export function saveState(state: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/** 상태 파일에서 이 상품의 자리. 없으면 만들어 준다. */
export function entryOf(state: State, key: string): TargetEntry {
  const targets = (state.targets ??= {});
  return (targets[key] ??= {});
}
