/**
 * 슈프림 설정. 집(aio/node)의 규약을 따른다.
 *
 *   SUPREME_HOME   이 폴더가 설정·상태·로그·크롬 프로필의 집이다 (태스크마다 다르다)
 *   supreme_config.json   원본이 읽는 설정 (어댑터의 writeMonitorConfig 도 이 파일을 쓴다)
 *   supreme_state.json    산 기록·마지막 확인
 *   supreme.log           로그
 *   chrome-profile/       크롬 프로필 — 사람이 한 번 통과한 사람확인(Cloudflare) 쿠키가 여기 남는다
 *
 * 설정 칸 이름은 롯데·반다이남코처럼 **밑줄 이름(snake_case)** 이다. 데스크톱 어댑터가 이 이름 그대로 쓴다.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findBase(): string {
  const env = (process.env["SUPREME_HOME"] || "").trim();
  if (env) return resolve(env);
  // dist/supreme/ 에서 돌든 src/supreme/ 에서 돌든 같은 곳(aio/node)을 찾아야 한다.
  let here = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(here, "package.json")) && existsSync(join(here, "src"))) return here;
    here = dirname(here);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export const BASE = findBase();
export const CONFIG_PATH = join(BASE, "supreme_config.json");
export const STATE_PATH = join(BASE, "supreme_state.json");
export const LOG_PATH = join(BASE, "supreme.log");
/** 결제·캡차 화면을 담아 두는 곳 (실패했을 때 사람이 본다). */
export const SHOT_DIR = join(BASE, "supreme-shots");
/** 크롬 프로필 — 사람이 통과한 사람확인 쿠키가 남는다. */
export const CHROME_PROFILE = join(BASE, "chrome-profile");

/** 상품 한 줄. 데스크톱 태스크 폼의 한 줄이 이대로 온다. */
export interface Target {
  /** 상품 주소 (https://shop.supreme.com/products/<handle>) 또는 handle */
  url: string;
  /** 원하는 사이즈 (쉼표로 여럿, 앞에서부터 우선) */
  option: string;
  ea: number;
  max_price: number;
  label: string;
}

export interface Profile {
  email: string;
  first_name: string;
  last_name: string;
  company: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  card_number: string;
  card_expiry: string;
  card_cvv: string;
  card_holder: string;
  billing_same_as_shipping: boolean;
  /* ── 아래는 슈프림 주문창(Global-e 결제)에만 있는 칸들이다 ──
   * 2026-10-08 에 실제 주문창을 열어 확인: 회사명 칸도, 별도 청구지 주소칸도 없다
   * ("delivery must be the same as your credit card address" — 배송지가 곧 카드 청구지).
   * 대신 한국 카드 결제는 **생년월일과 카드 PIN 앞 2자리**를 요구하고, 동의 체크박스가 결제 전 필수다. */
  /** YYYY-MM-DD. 비우면 사람이 그 칸만 채운다. */
  date_of_birth: string;
  /** 카드 비밀번호 앞 2자리. 비우면 사람이 그 칸만 채운다. */
  card_pin_first_two: string;
  /** 개인통관고유부호 (P + 12자리) — 한국 배송이면 주문창의 "additional information" 이 요구한다. */
  personal_customs_code: string;
  /** 주문서의 "Save this information for next time" */
  save_shipping_information: boolean;
  /** 동의 체크박스 — 전부 자동으로 켠다 (결제 버튼이 눌리려면 필요하다) */
  agree_age14: boolean;
  agree_globale_tos: boolean;
  /** 개인정보 수집·이용 동의 (주문창에 두 칸이다) */
  agree_privacy: boolean;
  agree_third_party: boolean;
  agree_supreme_tos: boolean;
}

export interface BuyConfig {
  /** 자동구매를 켤지 (false 면 감시만) */
  enabled: boolean;
  quantity: number;
  /** 원하는 사이즈가 없으면 이 순서로 내려간다 */
  size_priority: string[];
  ignore_size_if_single_variant: boolean;
  /**
   * 원하는 사이즈가 없을 때 다른 사이즈로 대체할지. **기본 false** —
   * 2026-10-08 에 L 을 원했는데 조용히 Small 을 담았다. 엉뚱한 사이즈를 결제하지 않으려면 꺼 둔다.
   */
  size_fallback: boolean;
  fill_shipping: boolean;
  fill_payment: boolean;
  /** 결제 버튼까지 누를지 (false = 결제 직전에서 멈춤) */
  click_pay: boolean;
  pay_delay_ms: number;
  three_ds_handoff: boolean;
  handoff_on_failure: boolean;
  shipping_prefer: "first" | "cheapest";
  /** 하나 사면 끝낼지 */
  stop_after_success: boolean;
  /** **실행할 때마다 장바구니를 비운다** — 지난 판의 미끼·실패한 담기가 남아 함께 결제되는 것을 막는다 */
  clear_cart_first: boolean;
  /** 한 판에서 실패하면 몇 번까지 처음부터 다시 해 볼까 (바로 포기하지 않는다) */
  retry_attempts: number;
  /** 다시 시도하기 전에 쉬는 시간 */
  retry_delay_ms: number;
  /** 한 번 돌 때 최대 몇 번 살지 (모니터는 사실상 끝없이 — 어댑터가 큰 수를 적는다) */
  max_buys_per_run: number;
}

/**
 * 드랍 대기열(preload) 설정 — 슈프림은 드랍 때 /checkout 앞에 줄을 세운다.
 *
 *   1. 드랍 몇 분 전에 **미끼 상품**을 담고 /checkout 로 가서 큐를 미리 태운다 (주문창에 들어가 대기)
 *   2. 드랍 시각이 되면 장바구니를 **원하는 상품으로 바꾸고** 결제한다
 * 이미 통과한 큐는 살아 있어서 두 번째 진입은 줄을 서지 않는다.
 */
export interface DropConfig {
  /** 큐를 태울 미끼 상품 (주소 또는 handle). 비우면 드랍 모드를 안 쓴다 */
  preload_url: string;
  /** 드랍 시각 HH:MM:SS (로컬). 지났으면 내일로 본다 — late_grace_minutes 안쪽이면 지금 */
  drop_at: string;
  /** 드랍 몇 분 전에 미끼를 담고 큐를 태우기 시작할까 */
  preload_lead_minutes: number;
  /** 드랍 때 바꿔 담을 상품 (비우면 targets[0]) */
  swap_to_url: string;
  /** 대기열에서 기다리는 최대 시간(분) */
  queue_timeout_minutes: number;
  /** 드랍 시각을 이만큼 안쪽으로 지났으면 "지금" 으로 본다 */
  late_grace_minutes: number;
}

export interface CaptchaConfig {
  /** hide = 캡차만 남기고 나머지를 치운다 · dim = 흐리게만 */
  mode: "hide" | "dim";
  /** 사람이 풀 때까지 기다리는 시간 */
  timeout_ms: number;
  /** 집중 모드를 다시 거는 주기 */
  refresh_ms: number;
  banner: string;
  /** 캡차 창을 자동으로 띄울지 */
  open_window: boolean;
}

export interface SupremeConfig {
  origin: string;
  collections: string[];
  check_interval_ms: number;
  jitter_ms: number;
  /** 확인 실패를 이만큼 연달아 하면 멈춘다 (0 = 끝없이) */
  max_retries: number;
  /** 실패한 뒤 쉬는 시간 */
  retry_delay_ms: number;
  /** 0 이면 사람이 멈출 때까지 (ms) */
  monitor_duration_ms: number;
  include_keywords: string[];
  exclude_keywords: string[];
  colors: string[];
  sizes: string[];
  max_price: number;
  monitor_only_available: boolean;
  detect_restock: boolean;
  detect_new_variant: boolean;
  silent_first_scan: boolean;
  buy: BuyConfig;
  drop: DropConfig;
  profile: Profile;
  captcha: CaptchaConfig;
  browser: {
    headless: boolean;
    /** 창을 모니터 밖에 둔다 (사람이 볼 일이 없을 때) */
    offscreen: boolean;
  };
  discord_webhook_url: string;
  /**
   * 빌려온 세션 쿠키 한 줄. 데스크톱 어댑터는 이 칸을 **빈 값으로** 적는다 (비밀은 파일에 남기지 않는다) —
   * 태스크는 SUPREME_COOKIE 환경변수로 받는다. 손으로 돌릴 때만 여기에 적어도 된다.
   */
  cookie: string;
  targets: Target[];
}

export const DEFAULT_CONFIG: SupremeConfig = {
  origin: "https://shop.supreme.com",
  collections: ["all"],
  check_interval_ms: 2500,
  jitter_ms: 400,
  max_retries: 0,
  retry_delay_ms: 5000,
  monitor_duration_ms: 0,
  include_keywords: [],
  exclude_keywords: ["gift card", "기프트카드"],
  colors: [],
  sizes: [],
  max_price: 0,
  monitor_only_available: true,
  detect_restock: true,
  detect_new_variant: true,
  silent_first_scan: true,
  buy: {
    enabled: true,
    quantity: 1,
    size_priority: ["Large", "Medium", "X-Large", "Small"],
    ignore_size_if_single_variant: true,
    size_fallback: false,
    fill_shipping: true,
    fill_payment: true,
    click_pay: true,
    pay_delay_ms: 0,
    three_ds_handoff: true,
    handoff_on_failure: true,
    shipping_prefer: "cheapest",
    stop_after_success: true,
    clear_cart_first: true,
    retry_attempts: 3,
    retry_delay_ms: 3000,
    max_buys_per_run: 1,
  },
  drop: {
    preload_url: "",
    drop_at: "",
    preload_lead_minutes: 2,
    swap_to_url: "",
    queue_timeout_minutes: 30,
    late_grace_minutes: 30,
  },
  profile: {
    email: "", first_name: "", last_name: "", company: "", address1: "", address2: "",
    city: "", state: "", zip: "", country: "KR", phone: "",
    card_number: "", card_expiry: "", card_cvv: "", card_holder: "",
    billing_same_as_shipping: true,
    date_of_birth: "", card_pin_first_two: "", personal_customs_code: "", save_shipping_information: false,
    agree_age14: true, agree_globale_tos: true, agree_privacy: true, agree_third_party: true, agree_supreme_tos: true,
  },
  captcha: {
    mode: "hide",
    timeout_ms: 180_000,
    refresh_ms: 1000,
    banner: "hCaptcha를 직접 풀어 주세요. 다 풀면 자동으로 이어서 진행합니다.",
    open_window: true,
  },
  browser: { headless: false, offscreen: true },
  discord_webhook_url: "",
  cookie: "",
  targets: [],
};

/** 실행 중에만 쓰는 스위치 (설정 파일에 남기지 않는다). */
export const run = { dryRun: false };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function merge<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    const before = out[key];
    out[key] = isObject(before) && isObject(value) ? merge(before, value) : value;
  }
  return out as unknown as T;
}

export function loadConfig(): SupremeConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8").replace(/^\uFEFF/, "")) as unknown;
    return merge(DEFAULT_CONFIG, raw);
  } catch {
    return merge(DEFAULT_CONFIG, {});
  }
}

/** 반쯤 쓰인 파일을 원본이 보지 않게 옆에 쓰고 바꿔치기한다. */
export function saveConfig(cfg: SupremeConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
  renameSync(tmp, CONFIG_PATH);
}

export interface State {
  /** 산 기록 — 재입고를 알아보는 기준선과 구분한다 */
  _buy: { at: string; url: string; order_no: string; what: string }[];
  /** 마지막 스냅샷 (재입고 판정의 기준선) */
  seen: Record<string, { available: boolean; at: string }>;
  last_check_at: string;
  rounds: number;
}

export function loadState(): State {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8").replace(/^\uFEFF/, "")) as Partial<State>;
    return { _buy: raw._buy ?? [], seen: raw.seen ?? {}, last_check_at: raw.last_check_at ?? "", rounds: raw.rounds ?? 0 };
  } catch {
    return { _buy: [], seen: {}, last_check_at: "", rounds: 0 };
  }
}

export function saveState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(tmp, STATE_PATH);
}

/** 빌려온 쿠키 (사람이 로그인 창에서 통과한 세션). 환경변수 → 설정 → 프로필 파일 순서다. */
export function cookieOf(cfg: SupremeConfig): string {
  const env = (process.env["SUPREME_COOKIE"] || "").trim();
  if (env) return env;
  const own = (cfg.cookie || "").trim();
  if (own) return own;
  try {
    return readFileSync(join(BASE, "supreme-cookie.txt"), "utf-8").trim();
  } catch {
    return "";
  }
}

export function webhookOf(cfg: SupremeConfig): string {
  return (process.env["SUPREME_WEBHOOK"] || cfg.discord_webhook_url || "").trim();
}

/** 드랍 시각(HH:MM:SS)을 절대 시각으로. 지났으면 내일 — 단 late_grace 안쪽이면 지금. */
export function nextDropTime(at: string, lateGraceMinutes = 30, now = Date.now()): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(at || "").trim());
  if (!m) return null;
  const [h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || mi > 59 || se > 59) return null;
  const when = new Date(now);
  when.setHours(h, mi, se, 0);
  let dropAt = when.getTime();
  const graceMs = Math.max(0, lateGraceMinutes) * 60_000;
  if (dropAt <= now) {
    if (now - dropAt <= graceMs) return now; // 방금 지났다 — 지금 시작
    dropAt += 24 * 60 * 60_000;
  }
  return dropAt;
}

/**
 * **비밀**은 환경변수로도 받는다 — 환경변수가 파일보다 먼저다.
 *
 * 데스크톱(대시보드)은 주문서 프로필을 암호화해 보관하다가, 태스크를 띄울 때만 이 변수들로 넘긴다.
 * 그래야 카드·생년월일·PIN 이 태스크 홈의 설정 파일에 평문으로 남지 않는다.
 * (손으로 돌릴 때는 설정 파일에 적어도 된다.)
 */
export interface Secrets {
  card_number: string;
  card_expiry: string;
  card_cvv: string;
  card_holder: string;
  date_of_birth: string;
  card_pin_first_two: string;
  personal_customs_code: string;
}

export function secretsOf(cfg: SupremeConfig): Secrets {
  const env = process.env;
  const pick = (name: string, fromFile: string): string => (env[name] || "").trim() || fromFile;
  return {
    card_number: pick("SUPREME_CARD_NUMBER", cfg.profile.card_number),
    card_expiry: pick("SUPREME_CARD_EXPIRY", cfg.profile.card_expiry),
    card_cvv: pick("SUPREME_CARD_CVV", cfg.profile.card_cvv),
    card_holder: pick("SUPREME_CARD_HOLDER", cfg.profile.card_holder),
    date_of_birth: pick("SUPREME_DOB", cfg.profile.date_of_birth),
    card_pin_first_two: pick("SUPREME_CARD_PIN2", cfg.profile.card_pin_first_two),
    personal_customs_code: pick("SUPREME_CUSTOMS_CODE", cfg.profile.personal_customs_code),
  };
}

export function ensureDirs(): void {
  mkdirSync(BASE, { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(CHROME_PROFILE, { recursive: true });
}

/**
 * 데스크톱 어댑터가 태스크 홈에 적는 **간격·재시도 칸**. 원본(lotte/bnkr)과 같은 이름을 쓴다 —
 * src/legacy/contract.ts 가 그 이름이 설정에 있는지 맞대 본다.
 */
export interface SupremeTimingFields {
  check_interval_ms: number | null;
  max_retries: number | null;
  retry_delay_ms: number | null;
  monitor_duration_ms: number | null;
}

/** 태스크 폼의 한 줄 → 설정의 한 줄. 어댑터가 이 모양으로 적는다. */
export interface SupremeTaskTarget {
  url: string;
  option: string;
  ea: number;
  max_price: number;
  label: string;
}

/** 모니터가 홈에 적는 칸 (writeMonitorConfig). */
export interface SupremeMonitorFields {
  top: {
    origin: string;
    collections: string[];
    check_interval_ms: number;
    discord_webhook_url: string;
  };
  buy: {
    targets: SupremeTaskTarget[];
    max_buys_per_run: number;
    stop_after_success: boolean;
  };
}
