/**
 * 설정과 상태 — **테스트 판.** 쓰는 파일이 본판과 다르다.
 *
 * 본판(src/config.ts)은 파이썬 판이 쓰던 파일을 그대로 쓴다. 테스트 판이 그걸 같이 쓰면
 * 시험 삼아 돌린 한 판이 본판의 담은 기록·로그·결제창 받아쓰기를 덮는다. 그래서 설정·
 * 상태·로그·덤프를 전부 `bnkr_test_*` 로 갈라 둔다.
 *
 * **쿠키만은 두 벌 관리하지 않는다.** 쿠키는 자주 갈아 끼우는 것이라 두 군데 넣게 하면
 * 반드시 한쪽이 낡는다. 테스트 설정에 쿠키가 비어 있으면 본판 설정(bnkr_buy_config.json)
 * 것을 빌려 온다. 처음 켤 때 본판 설정을 통째로 베껴 오는 것도 같은 이유다 — 감시 대상과
 * 웹훅을 다시 적게 하지 않는다. 베껴 올 때 **결제수단만 네이버페이로 바꾼다.**
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
export const CONFIG_PATH = join(BASE, "bnkr_test_config.json");
export const STATE_PATH = join(BASE, "bnkr_test_state.json");
export const LOG_PATH = join(BASE, "bnkr-test-buy.log");
// 결제창에서 눌러야 할 것을 못 찾았을 때, 그 창에 무엇이 있었는지 적어 두는 곳.
export const PG_DUMP_PATH = join(BASE, "bnkr-test-pg-dump.txt");
/** 본판 설정. 처음 켤 때 베껴 오고, 쿠키가 비었을 때 빌려 온다. 여기에 쓰지는 않는다. */
export const REAL_CONFIG_PATH = join(BASE, "bnkr_buy_config.json");
// 웹훅을 따로 안 적으면 감시 스크립트 것을 빌려 쓴다.
export const STOCK_CONFIG_PATH = join(BASE, "bnkr_config.json");

export type Mode = "ADD" | "DIRECT" | "GIFT";
export type OrderAction = "open" | "agree" | "submit";
/** 누르는 것과 칸에 넣는 것을 한 목록에 섞어 둔다. 순서가 있는 일이라서다. */
export type PgStep = string | { fill?: string; label?: string; value?: string };

/**
 * **네이버페이(카드)로 가는 길.** 이 테스트 판이 본판과 다른 것은 사실상 이 한 줄이다.
 *
 *   1. 이용약관에 동의해 주세요   →  동의합니다 → 다음
 *   2. 결제 수단을 선택해 주세요  →  네이버페이 → 다음
 *   3. 네이버페이 창             →  결제하기
 *
 * 1·2·4번째는 2026-08-17 에 실제로 통과한 그대로다(bnkr-buy.log). 3번째 자리에 그날
 * 들어 있던 것은 `포인트`(label "네이버페이포인트")였고, **여기만 `네이버페이` 로 바꿨다.**
 * 그 목록에는 둘이 나란히 있다 — 포인트로 내는 것과 네이버페이에 물려 둔 카드로 내는
 * 것이 PG 쪽에서 아예 다른 수단이다.
 *
 * **글자가 겹치는 것을 알고 쓴다.** 글자 찾기는 품고 있는 것도 잡으므로(찾는 글자 + 10자
 * 까지) `네이버페이` 는 "네이버페이포인트" 에도 걸린다. 그래도 되는 이유는 고르는 순서에
 * 있다 — 누를 수 있는 것 먼저, **글자가 정확히 같은 것 먼저**, 짧은 것 먼저다. 목록의
 * 두 줄은 생김새가 같으니(둘 다 라디오를 label 로 감싼 꼴) 정확히 같은 쪽이 이긴다.
 * 카카오페이가 label "카카오페이" 로 정확히 잡혔던 것과 같은 자리다.
 *
 * **무엇이 눌렸는지는 로그가 말해 준다.** `결제창에서 '네이버페이' 를 눌렀습니다 — label
 * "…"` 의 따옴표 안이 "네이버페이" 면 카드 쪽이고, "네이버페이포인트" 면 포인트 쪽이다.
 * 뒤엣것이 찍혔다면 그 화면에 네이버페이 줄이 없었다는 뜻이니, 그때 받아 적은
 * bnkr-test-pg-dump.txt 를 보고 진짜 글자로 고친다.
 *
 * 마지막 `결제하기` 는 네이버페이 창의 "동의하고 결제하기" 다(ButtonBox-module_color-
 * npayGreen). 카카오페이 쪽과 달리 **여기서 결제가 확정되지 않는다** — 그다음에 오는
 * 간편결제 비밀번호 자판이 비밀번호를 기다린다. `pg_password` 를 적어 두면 자동으로
 * 넣는다 — 자판은 매 결제마다 숫자 위치가 바뀌므로, 화면에서 읽은 표로 누른다
 * (browser.ts 의 enterPin). 값 자체는 로그·덤프에 남기지 않는다.
 * 카드가 여럿이면 그 창에서 카드를 고르는 단계가 하나 더 있을 수 있는데, **그 화면은
 * 아직 못 봤다.** 안 본 화면의 글자는 적지 않는다.
 */
export const NPAY_CLICKS: PgStep[] = ["동의합니다", "다음", "네이버페이", "다음", "결제하기"];

/**
 * 비밀번호를 넣고 나서 한 번 더 나오는 마지막 확인 화면에서 누를 것.
 *
 * 네이버페이는 간편결제 비밀번호를 넣으면 마지막 확인 화면이 한 번 더 온다 —
 * 왼쪽에 "결제내용에 동의하시면 '결제' 버튼을 눌러 구매완료합니다." 체크가 있고,
 * 오른쪽에 `결제` 버튼이 있다. (2026-08-25 에 그 화면을 보고 받아 적었다.)
 *
 * 이 목록은 결제가 끝나기를 지켜보는 동안(waitPaid) 계속 두드린다 — 화면이 아직
 * 안 왔으면 못 찾을 뿐이고, 오면 그때 눌린다. 앞엣것을 못 찾으면 뒤엣것은
 * 건드리지 않는다 (체크가 안 됐는데 결제를 누르는 꼴을 막는다).
 */
export const NPAY_FINISH: PgStep[] = ["결제내용에 동의", "결제"];

/** 네이버 로그인 페이지. 네이버페이는 결제창 안에서 네이버에 로그인해야 한다. */
export const NAVER_LOGIN_URL = "https://nid.naver.com/nidlogin.login";

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
  /** 네이버 로그인 세션 파일 (네이버 판 --login 이 적는 Playwright 세션). 비우면 안 쓴다. */
  naver_session: string;
  preheat_browser: boolean;
  meta_fresh_seconds: number;
  order_action: OrderAction;
  pg_capture: boolean;
  pg_clicks: PgStep[];
  /** 간편결제 비밀번호. 비워 두면 자동 입력하지 않는다. 값은 로그·덤프에 남기지 않는다. */
  pg_password: string;
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
  // 네이버페이는 결제창 안에서 네이버에 로그인해야 한다. 재고가 열린 뒤에 로그인을
  // 시작하면 늦으므로 지켜보는 동안 미리 해 둔다. 본판은 이 자리가 비어 있다.
  prelogin_url: NAVER_LOGIN_URL,
  prelogin_marker: "nidlogin",
  prelogin_wait_minutes: 5,
  // 네이버 판(naver/ts --login)이 적어 둔 세션 파일. 적어 두면 크롬에 네이버 쿠키를 같이 심어 네이버페이 창이
  // 로그인된 채로 열리고, 위의 사전 로그인을 사람이 하지 않아도 된다. 상대 경로는 이 설정 파일 옆에서 찾는다.
  // 환경변수 BNKR_NAVER_SESSION 이 먼저다 (데스크톱 앱이 태스크마다 고른 네이버 프로필의 것을 넘긴다).
  naver_session: "",
  preheat_browser: true,
  meta_fresh_seconds: 60,
  order_action: "submit",
  pg_capture: true,
  pg_clicks: NPAY_CLICKS,
  pg_password: "",
  pg_settle_seconds: 3,
  pg_webhook_url: "",
  pg_mention: "",
  pg_probe: [],
  pg_finish: NPAY_FINISH,
  paid_wait_minutes: 10,
  paid_markers: ["주문이 완료", "주문완료", "order_complete", "orderComplete", "order_result"],
  queue_watch: true,
  queue_wait_seconds: 10,
  queue_markers: null,
};

/** 담지 않고 무엇을 담을지만 본다. 프로세스 하나에 하나뿐인 상태라 여기 둔다. */
export const run = { dryRun: false };

/**
 * 처음 켤 때 쓸 설정. **본판 설정을 베끼되 결제수단만 갈아 끼운다.**
 *
 * 감시 대상·쿠키·웹훅을 여기 다시 적게 하지 않는다 — 그러라고 만든 복사본이 아니다.
 * 대신 결제와 얽힌 세 가지는 본판 것을 따라가면 안 된다. 본판은 카카오페이 카톡결제로
 * 가 있고, 그 목록에는 전화번호·생년월일 같은 카카오 쪽 칸까지 들어 있다. 그대로 두면
 * 네이버페이를 시험한다면서 카카오 창을 여는 꼴이 된다.
 *
 * 한 번만 쓴다. 파일이 생긴 뒤로는 이 함수가 돌지 않으니, 테스트 설정을 손으로 고쳐 둔
 * 것이 다음에 켤 때 도로 덮이지 않는다.
 */
function seedFromReal(): Partial<Config> {
  let real: Partial<Config> = {};
  try {
    real = JSON.parse(readFileSync(REAL_CONFIG_PATH, "utf-8")) as Partial<Config>;
  } catch {
    // 본판 설정이 없거나 깨졌으면 기본값으로 시작한다. 그것 때문에 못 켤 일은 아니다.
  }
  // 쿠키는 일부러 안 베낀다. 베껴 두면 그 순간부터 두 벌이 되고, 본판을 갱신해도 이쪽은
  // 낡은 것을 붙들고 있게 된다. 비워 두면 cookieOf 가 매번 본판에서 빌려 온다.
  return {
    ...real, cookie: "",
    pg_clicks: NPAY_CLICKS, pg_finish: NPAY_FINISH, prelogin_url: NAVER_LOGIN_URL,
  };
}

/**
 * 설정 파일에 적힌 그대로 돌려준다.
 *
 * 환경변수나 빌려온 웹훅을 여기서 섞지 않는다. 섞어 두면 --add 처럼 설정을 저장하는
 * 명령이 그 값을 파일에 박아 넣는다.
 */
export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    const seed = { ...DEFAULT_CONFIG, ...seedFromReal() };
    writeFileSync(CONFIG_PATH, JSON.stringify(seed, null, 2), "utf-8");
  }
  const own = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...own };
}

export function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

/**
 * 쿠키. 테스트 설정에 없으면 **본판 설정에서 빌려 온다.**
 *
 * 쿠키는 몇 시간이면 죽는 것이라 두 군데 관리하게 두면 반드시 한쪽이 낡는다. 낡은 쿠키는
 * 조용히 실패하지 않고 장바구니로 튕기는 것으로 나타나서, 정작 보려던 결제창까지 가지도
 * 못한다. `--cookie` 는 어느 쪽으로 넣든 다른 쪽에서 쓰인다.
 *
 * 빌려 오기만 하고 베껴 두지는 않는다. 여기서 테스트 설정에 박아 두면 그다음부터는
 * 본판을 갱신해도 이쪽은 낡은 것을 붙들고 있게 된다.
 */
export function cookieOf(cfg: Config): string {
  const own = (process.env["BNKR_COOKIE"] || cfg.cookie || "").trim();
  if (own) return own;
  try {
    const real = JSON.parse(readFileSync(REAL_CONFIG_PATH, "utf-8")) as Partial<Config>;
    return String(real.cookie || "").trim();
  } catch {
    return "";
  }
}

/**
 * 간편결제 비밀번호. 환경변수 BNKR_PG_PASSWORD 가 설정 파일보다 먼저다 — 파일에 평문으로
 * 남기기 싫을 때 쓰는 길이다. 값 자체는 어디에도 적지 않는다. 로그에는 자릿수만 남는다.
 */
export function passwordOf(cfg: Config): string {
  return (process.env["BNKR_PG_PASSWORD"] || cfg.pg_password || "").trim();
}

/**
 * 네이버 로그인 세션 파일의 경로. 환경변수 BNKR_NAVER_SESSION 이 설정 파일보다 먼저다. 없으면 null.
 * 파일이 있는지는 여기서 보지 않는다 — 없으면 쓰는 쪽(landing.ts)이 그렇다고 말한다.
 */
export function naverSessionOf(cfg: Config): string | null {
  const value = (process.env["BNKR_NAVER_SESSION"] || cfg.naver_session || "").trim();
  if (!value) return null;
  return isAbsolute(value) ? value : join(BASE, value);
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
