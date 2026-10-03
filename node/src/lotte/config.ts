/**
 * 설정과 상태.
 *
 * bnkr·네이버 판과 달리 **파이썬 짝이 없다.** 나눠 쓸 파일도 없으니 이름만 맞춰
 * 프로젝트 뿌리에 둔다 — 쿠키를 넣고 로그를 읽는 자리가 사이트마다 다른 곳에 흩어지면
 * 사람이 헷갈린다.
 *
 *   lotteon_buy_config.json   설정 (쿠키·상품·웹훅)
 *   lotteon_buy_state.json    산 기록. 켤 때마다 같은 걸 또 사지 않으려는 것
 *   lotteon-buy.log           전부 적는 곳
 *   lotteon-pg-dump.txt       결제창에 무엇이 있었는지 (--dump-pay 가 적는다)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useLogFile } from "../log.js";

/** 프로젝트 뿌리. bnkr 쪽 파일이 표지 노릇을 한다 (거기가 이 프로젝트의 집이다). */
function findBase(): string {
  const env = (process.env["LOTTEON_HOME"] || "").trim();
  if (env) return resolve(env);
  // dist/lotte 에서 돌든 src/lotte 에서 돌든 같은 곳을 찾아야 한다.
  let here = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(here, "lotteon_buy_config.json")) || existsSync(join(here, "bnkr_buy.py"))) {
      return here;
    }
    here = dirname(here);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export const BASE = findBase();
export const CONFIG_PATH = join(BASE, "lotteon_buy_config.json");
export const STATE_PATH = join(BASE, "lotteon_buy_state.json");
export const LOG_PATH = join(BASE, "lotteon-buy.log");
// 상품 페이지에서 무엇을 찾았는지 적어 두는 곳. --probe 가 쓴다.
export const DUMP_PATH = join(BASE, "lotteon-page-dump.txt");
// 결제창에 무엇이 있었는지 적어 두는 곳. --dump-pay 가 쓴다.
export const PG_DUMP_PATH = join(BASE, "lotteon-pg-dump.txt");
// 웹훅을 따로 안 적으면 bnkr 쪽 것을 빌려 쓴다. 채널을 세 벌 만들 이유가 없다.
export const BNKR_CONFIG_PATH = join(BASE, "bnkr_buy_config.json");

/**
 * 로그를 롯데온 쪽 파일로 돌린다. **이 파일을 들이는 순간 바뀐다.**
 *
 * main() 안에서 부르면 늦다 — 인자를 잘못 줘서 그 앞에서 나는 오류까지 lotteon-buy.log
 * 에 남아야 한다. 롯데온 판의 모든 파일이 이 파일을 거치므로 여기가 가장 이른 자리다.
 */
useLogFile(LOG_PATH);

export const IN_STOCK = "instock";
export const SOLDOUT = "soldout";
export type Status = typeof IN_STOCK | typeof SOLDOUT;
export const STATUS_LABEL: Record<string, string> = { [IN_STOCK]: "구매 가능", [SOLDOUT]: "품절" };

/**
 * 주문서에 도착한 뒤 어디까지 갈 것인가. bnkr 쪽과 이름을 맞췄다.
 *
 *   "open"    주문서를 열어 두고 멈춘다
 *   "agree"   필수 동의까지 체크하고 멈춘다
 *   "submit"  (기본) 결제하기를 눌러 **PG 결제창을 띄우고 멈춘다**
 *
 * **submit 이 이 프로그램의 끝이다.** 결제창 안에서는 아무것도 누르지 않는다 —
 * 카드 인증도, 간편결제 비밀번호도, 앱 승인도 거기서 사람이 한다.
 */
export const ACTIONS = ["open", "agree", "submit"] as const;
export type OrderAction = (typeof ACTIONS)[number];
export type Stage = "opened" | "agreed" | "submitted";

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
  max_concurrency: number;
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
  order_action: OrderAction;
  pay_method: string[];
  pay_method_mark: string;
  pay_card: string;
  pg_dump: boolean;
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: Config = {
  cookie: "",
  discord_webhook_url: "",
  mention: "@everyone",
  targets: [],
  poll_interval_seconds: 15,
  poll_jitter_seconds: 4,
  // 상품 페이지 한 장이 27KB 다(재 봤다). 이보다 촘촘하게 두드리지 않는다.
  min_interval_seconds: 5,
  // 조회에만 걸린다. 담기·주문서·결제창은 어떤 값을 주든 한 줄로 간다 —
  // 계정이 하나고, 크롬도 한 창이다.
  max_concurrency: 4,
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
  // 켜지 마라. 결제창은 새 창으로 뜨는 물건이라 headless 에서 볼 것이 없다.
  browser_headless: false,
  browser_timeout_seconds: 20,
  // 결제창을 띄우는 데까지가 이 프로그램의 끝이다.
  order_action: "submit",

  /**
   * 주문서에서 고를 결제수단. **한 줄이 한 단계**이고, `|` 로 여러 이름을 적어 두면
   * 그중 눌리는 것을 누른다.
   *
   * 기본값이 L.PAY 간편결제다. **"L.PAY" 가 아니라 "간편결제" 인 이유**는, 주문서를
   * 받아 적어 보니 결제수단이 탭 아홉 개인데 롯데 것만 제 이름 대신 그렇게 앉아 있어서다
   * (카카오페이·네이버페이·토스페이·삼성페이는 각자 제 이름의 탭을 갖고 있다).
   *
   *   간편결제 · 신용카드 · 충전결제 · 퀵계좌이체 ·
   *   카카오페이 · 네이버페이 · 토스페이 · 삼성페이 · 온누리상품권
   *
   * 탭 안에서 카드까지 정해 두고 싶으면 단계를 늘린다:
   *   ["간편결제", "롯데카드"]
   *
   * **비워 두면 건드리지 않는다.** 화면에 이미 골라져 있는 것으로 결제창을 띄운다
   * (받아 적었을 때 켜져 있던 것은 카카오페이였다).
   */
  pay_method: ["간편결제", "L.PAY 카드"],

  /**
   * 결제수단을 고른 **뒤에** 화면에 보여야 하는 글자. `|` 로 여러 철자를 적는다.
   *
   * 탭을 눌렀다고 그것이 L.PAY 라는 보장은 없다. 눌린 뒤에 무엇이 떴는지로 확인한다 —
   * 이게 없으면 "간편결제" 가 딴 것을 가리키게 바뀌었을 때 조용히 엉뚱한 수단으로
   * 결제창을 띄운다. 사이트 안에서 `L.PAY` 와 `L.pay` 가 섞여 나와 둘 다 적어 둔다.
   *
   * 안 보이면 결제하기를 누르지 않는다. 비워 두면 확인하지 않는다.
   */
  pay_method_mark: "L.PAY|L.pay|엘페이",

  /**
   * 간편결제 안에서 고를 **카드**. 이름의 일부면 된다 ("롯데", "1234").
   *
   * 비워 두면 **등록된 카드가 하나일 때만** 그것을 고른다. 여러 개인데 안 적어 뒀으면
   * 고르지 않고 목록을 적어 준다 — 남의 카드를 우리가 정할 일이 아니다.
   */
  pay_card: "",

  // 결제창에서 뭔가 어긋났을 때만 받아 적는다. 사람 정보는 지우고 적는다.
  pg_dump: true,
};

/** 사지 않고 무엇을 살지만 본다. 프로세스 하나에 하나뿐인 상태라 여기 둔다. */
export const run = { dryRun: false };

/**
 * 할 말은 이미 화면에 적었으니 조용히 1 로 끝내라는 뜻.
 * 고칠 자리가 있는 고장이 아닌 것들이 여기로 온다.
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
  const own = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...own };
}

export function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

export function cookieOf(cfg: Config): string {
  return (process.env["LOTTEON_COOKIE"] || cfg.cookie || "").trim();
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

/** 어디까지 갈지. 설정에 모르는 값이 적혀 있으면 그렇게 말하고 open 으로 물러선다. */
export function actionOf(cfg: Config): OrderAction {
  const raw = String(cfg.order_action ?? "submit").toLowerCase() as OrderAction;
  return ACTIONS.includes(raw) ? raw : "open";
}

/** 간편결제 안에서 고를 카드. */
export function payCardOf(cfg: Config): string {
  return String(cfg.pay_card ?? "").trim();
}

/** 결제수단을 고른 뒤 화면에 보여야 하는 글자. */
export function payMarkOf(cfg: Config): string {
  return String(cfg.pay_method_mark ?? "").trim();
}

/** 고를 결제수단. 문자열 하나로 적어 놔도 받는다. */
export function payMethodOf(cfg: Config): string[] {
  const raw = cfg.pay_method;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  return list.map((one) => String(one).trim()).filter(Boolean);
}

/** 상태 파일에 상품마다 적어 두는 것. */
export interface TargetEntry {
  name?: string;
  status?: string;
  price?: number;
  done?: boolean;
  opened?: boolean;
  stage?: Stage;
  blocked?: string;
  opened_at?: string;
  last_try_at?: string;
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
