/**
 * 반다이남코코리아몰 — 원본은 aio/node/src/bnkr-test (네이버페이 테스트 판), 빌드된 dist/bnkr-test/index.js 를 들인다.
 *
 * 롯데와 같은 길이다. 원본은 파일 위치를 BNKR_HOME 에서, 쿠키·비밀번호를 BNKR_COOKIE · BNKR_PG_PASSWORD
 * 에서 읽는다 (config.ts 의 findBase · cookieOf · passwordOf). 태스크마다 홈을 따로 주면 설정·담은 기록·로그·
 * 결제창 받아쓰기가 전부 따로 쌓이고, 돌릴 파일 경로도 없다. 쿠키는 태스크가 고른 프로필의 bnkr-cookie.txt
 * 에서 읽어 환경변수로 넘긴다 — 원본은 크롬을 매번 쿠키를 심어 띄운다.
 *
 * 롯데와 다른 것
 *   - 대상은 주소가 아니라 gno 다. 담는 방식(mode)은 DIRECT(바로구매) 하나로 둔다 — "어디까지" 가 주문서·결제창
 *     이야기라서다 (ADD 는 장바구니까지만, GIFT 는 선물 주문서).
 *   - --drop 이 없다.
 *   - --dry-run 은 **한 번만 보고 끝난다** (index.ts: `args.once || run.dryRun`). 그래서 모니터(사지 않고 계속
 *     보기)로 돌릴 수 없다 — sites.ts 의 monitors: false.
 *   - 씨앗 설정의 discover(목록 훑기)는 태스크에서 뺀다. 태스크는 상품 하나다 — **키워드 태스크만 빼고**: 상품 칸에
 *     검색어나 검색 결과 주소를 적으면 targets 를 비우고 discover 에 그 검색 하나를 적는다 (lookOf). 원본이 처음 훑을 때
 *     보이던 것은 기준선으로 두고, 그 뒤 새로 올라오거나 품절이 풀린 것을 담는다.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BNKR_ACTIONS, isBnkrGoods, isBnkrKeyword } from "../../shared/sites.js";
import type { CommonSettings, OrderAction, SiteSettings, TaskDef, TimingDefaults, WebhookInfo } from "../../shared/types.js";
import { fetchText, htmlTitle, readJson, writeJsonAtomic, type JsonObject, type Launch, type SiteAdapter } from "./adapter.js";
import { naver } from "./naver.js";

const CONFIG = "bnkr_test_config.json";
const STATE = "bnkr_test_state.json";
/** 본판 설정. 테스트 설정에 쿠키가 비었을 때 원본이 여기서 빌려 온다 (config.ts 의 cookieOf). */
const REAL_CONFIG = "bnkr_buy_config.json";
/** 웹훅을 따로 안 적었으면 원본이 여기서 빌려 쓴다 (config.ts 의 webhookOf). */
const STOCK_CONFIG = "bnkr_config.json";
/** 원본 config.ts 의 passwordOf 가 먼저 보는 환경변수. */
const PIN_ENV = "BNKR_PG_PASSWORD";
/** 프로필 폴더의 쿠키 — Cookie: 줄 그대로 한 줄. */
const COOKIE_FILE = "bnkr-cookie.txt";

/** 태스크 홈의 설정에 적는 대상 한 줄. 원본 targets.ts 의 parseTarget 이 읽는 칸 — src/legacy/contract.ts 가 본다. */
export interface BnkrTaskTarget {
  gno: string;
  ea: number;
  mode: "DIRECT";
  max_price: number;
  label: string;
}

const entryOf = (s: SiteSettings) => join(s.root, "dist", "bnkr-test", "index.js");

const SITE = "https://www.bnkrmall.co.kr";
/** 원본 site.ts 의 LOGIN_CHECK_URL. 로그인돼 있으면 authmemberno 가 0 이 아니다. */
const LOGIN_CHECK_URL = `${SITE}/member/member_login_check_ajax.do`;
export const BNKR_LOGIN_PATH = "/member/login.do";
const LOGIN_URL = `${SITE}${BNKR_LOGIN_PATH}`;

/** 원본 site.ts 의 parseGno 와 같은 모양 — 숫자 네 자리 이상. 주소를 통째로 줘도 된다. */
export function gnoOf(url: string): string {
  return /gno=(\d{4,})/.exec(url)?.[1] ?? /(\d{4,})/.exec(url)?.[1] ?? url.trim();
}

function targetOf(task: TaskDef): BnkrTaskTarget {
  return { gno: gnoOf(task.url), ea: task.ea || 1, mode: "DIRECT", max_price: task.max_price || 0, label: task.label };
}

/** 키워드 태스크가 적는 훑을 목록 한 줄. 원본 config.ts 의 DiscoverSpec 칸 — src/legacy/contract.ts 가 본다. */
export interface BnkrDiscoverEntry {
  /** 검색어나 목록 주소 — 원본 parseWatch 가 둘 다 읽는다. */
  url: string;
  ea: number;
  mode: "DIRECT";
  max_price: number;
}

/**
 * 키워드 태스크가 씨앗 설정 위에 고쳐 적는 칸.
 *   discover_interval_seconds 0  목록을 바퀴마다 훑는다 — 원본은 훑은 지 이만큼 지났을 때만 훑는데, 바퀴 사이(확인 간격
 *                                ± 흔들림)가 이보다 짧으면 한 바퀴씩 건너뛴다. 확인 간격이 곧 훑는 간격이 되게 한다.
 *   buy_on_restock_only false     원본의 훑기가 "새로 올라왔다 · 품절이 풀렸다" 를 이미 가려 감시에 넣는다. 그런데 넣은
 *                                상품은 원본 checkTarget 에게 처음 보는 것이라, 켜 두면 "이미 판매 중" 으로 보고 안 담는다.
 *                                대상(targets)은 비워 두므로 이 칸이 닿는 것은 훑기가 찾아낸 것뿐이다.
 */
export interface BnkrKeywordFields {
  discover_interval_seconds: number;
  buy_on_restock_only: boolean;
}

function discoverOf(task: TaskDef): BnkrDiscoverEntry {
  return { url: task.url.trim(), ea: task.ea || 1, mode: "DIRECT", max_price: task.max_price || 0 };
}

/** 태스크 홈 설정의 대상 칸 — 상품 하나면 targets, 키워드면 discover. */
function lookOf(task: TaskDef): { targets: BnkrTaskTarget[]; discover: BnkrDiscoverEntry[] } & Partial<BnkrKeywordFields> {
  if (!isBnkrKeyword(task.url)) return { targets: [targetOf(task)], discover: [] };
  return { targets: [], discover: [discoverOf(task)], discover_interval_seconds: 0, buy_on_restock_only: false };
}

/** 원본 loginInfo 와 같은 물음: authmemberno 가 0 이 아니면 살아 있다. */
async function loginAlive(cookie: string): Promise<boolean> {
  const res = await fetch(LOGIN_CHECK_URL, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${SITE}/`,
    },
    body: "",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status !== 200) return false;
  try {
    // 원본 주석대로 선언된 인코딩(ISO-8859-1)을 믿지 않는다 — 숫자만 보면 되니 그대로 읽는다.
    const data = JSON.parse(await res.text()) as { authmemberno?: unknown };
    return Number(data.authmemberno ?? 0) > 0;
  } catch {
    return false; // JSON 자리에 로그인 페이지가 오면 끊긴 것이다
  }
}

/**
 * 태스크의 간격·재시도를 원본 설정 칸으로 옮긴 것. 원본 Config 에 있는 칸·타입인지는
 * src/legacy/contract.ts 가 본다.
 */
export interface BnkrTimingFields {
  poll_interval_seconds?: number;
  max_attempts?: number;
  retry_delay_seconds?: number;
  stop_after_success?: boolean;
  max_carts_per_run?: number;
}

/** 원본 watch.ts: 기다림은 Math.max(3, 주기 ± 흔들림) — 3초 밑으로는 안 내려간다. */
const FLOOR_SECONDS = 3;

/** 원본은 설정 파일을 DEFAULT_CONFIG 위에 얹어 읽는다 — 칸이 없으면 기본값, 있으면 그 값. */
const pick = (seed: JsonObject, key: string, dflt: number): number =>
  typeof seed[key] === "number" ? (seed[key] as number) : dflt;

/** 씨앗 설정의 간격·재시도. 원본 watch.ts · cart.ts 와 같은 규칙이다. */
function timingOf(seed: JsonObject): TimingDefaults {
  const maxCarts = pick(seed, "max_carts_per_run", 5);
  return {
    checkIntervalMs: Math.max(FLOOR_SECONDS, pick(seed, "poll_interval_seconds", 15)) * 1000,
    minIntervalMs: FLOOR_SECONDS * 1000,
    wholeSeconds: false,
    maxRetries: Math.max(1, Number(pick(seed, "max_attempts", 3) || 1)) - 1,
    retryDelayMs: pick(seed, "retry_delay_seconds", 2) * 1000,
    // 대상이 하나라 stop_after_success 면 한 번 담고 "다 끝났다" 로 끝난다. 아니면 max_carts_per_run 만큼.
    stopOnSuccess: seed["stop_after_success"] !== false,
    maxBuys: maxCarts,
    retryScope: "재고 조회·장바구니 담기·주문서 열기가 실패했을 때",
    rateWarnPerMin: null,
    drop: null,
  };
}

function timingFields(task: TaskDef): BnkrTimingFields {
  const out: BnkrTimingFields = {};
  if (task.checkIntervalMs !== null) out.poll_interval_seconds = task.checkIntervalMs / 1000;
  if (task.maxRetries !== null) out.max_attempts = task.maxRetries + 1;
  if (task.retryDelayMs !== null) out.retry_delay_seconds = task.retryDelayMs / 1000;
  if (task.stopOnSuccess === true) Object.assign(out, { stop_after_success: true, max_carts_per_run: 1 });
  if (task.stopOnSuccess === false) Object.assign(out, { stop_after_success: false, max_carts_per_run: Math.max(2, task.maxBuys) });
  return out;
}

/** 씨앗 설정의 order_action. 칸이 없으면 원본 기본값 submit. 모르는 값은 open 으로 둔다. */
function defaultActionOf(seed: JsonObject): Exclude<OrderAction, ""> {
  const raw = String(seed["order_action"] ?? "submit").toLowerCase();
  return BNKR_ACTIONS.find((a) => a === raw) ?? "open";
}

/** 씨앗 설정의 pg_finish (비밀번호 뒤 마지막 확인). 칸이 없으면 원본 기본값. */
function finishStepsOf(seed: JsonObject): string[] {
  const raw = seed["pg_finish"];
  const steps = Array.isArray(raw) ? raw : ["결제내용에 동의", "결제"];
  return steps.map((s) => (typeof s === "string" ? s : String((s as { label?: string })?.label ?? "칸 채우기")));
}

function pinEffectOf(seed: JsonObject): string {
  const steps = finishStepsOf(seed);
  return steps.length
    ? `결제창에서 네이버페이 → 간편결제 비밀번호 → 마지막 확인(${steps.join(" → ")})까지 누릅니다 — 사람 손 없이 결제됩니다`
    : "결제창에서 네이버페이 → 간편결제 비밀번호까지 누릅니다 — 마지막 확인은 사람이 누릅니다";
}

/** "어디까지" 마다 원본이 실제로 어디서 멈추나 (비밀번호가 있을 때 / 없을 때). 원본 site.ts 의 STAGE_LABEL 과 같은 말이다. */
function actionHints(seed: JsonObject, hasPin: boolean): Partial<Record<OrderAction, string>> {
  const steps = finishStepsOf(seed);
  const hints: Partial<Record<OrderAction, string>> = {
    open: "주문서까지만 띄웁니다 — 필수 동의와 결제는 사람이 누릅니다",
    agree: "주문서에서 필수 동의 2개까지 하고 멈춥니다",
    submit: hasPin
      ? pinEffectOf(seed)
      : "결제창에서 네이버페이까지 고르고 비밀번호 자판에서 멈춥니다 — 비밀번호는 사람이 넣습니다" +
        (steps.length ? `. 넣고 나면 마지막 확인(${steps.join(" → ")})은 원본이 눌러 줍니다` : ""),
  };
  const dflt = defaultActionOf(seed);
  hints[""] = `씨앗 설정(${dflt}) — ${hints[dflt]}`;
  return hints;
}

/**
 * 콘솔용 간편결제 비밀번호. 원본 passwordOf 와 같은 순서 — 환경변수 → 씨앗 설정.
 * **태스크 홈에는 적지 않는다.** 태스크는 프로필 것을 환경변수로만 받는다.
 */
function pinOf(s: SiteSettings): { pin: string; fromEnv: string | null } {
  const env = String(process.env[PIN_ENV] || "").trim();
  if (env) return { pin: env, fromEnv: PIN_ENV };
  return { pin: String(readJson(s.seed)?.["pg_password"] || "").trim(), fromEnv: null };
}

/** 프로필의 쿠키. 쿠키도 태스크 홈에는 적지 않고 환경변수(BNKR_COOKIE)로만 넘긴다. */
function cookieIn(dir: string): string {
  try {
    return readFileSync(join(dir, COOKIE_FILE), "utf-8").trim();
  } catch {
    return "";
  }
}

/** 원본과 같은 순서로 씨앗 설정 → 본판 설정의 쿠키. 프로필로 옮길 때만 읽는다. */
function seedCookie(s: SiteSettings): string {
  const seed = readJson(s.seed) ?? {};
  const real = readJson(join(dirname(s.seed), REAL_CONFIG)) ?? {};
  return String(seed["cookie"] || real["cookie"] || "").trim();
}

/**
 * 원본이 알림을 보낼 웹훅. 공통 웹훅 → 씨앗 설정 → bnkr_config.json (원본 webhookOf 의 빌려 쓰기).
 * 태스크는 BNKR_HOME 이 태스크 홈이라 원본이 bnkr_config.json 을 거기서 찾다가 못 찾는다. 빌려 쓰기까지
 * 여기서 해서 태스크 설정에 적어 준다.
 */
function webhookOf(s: SiteSettings, common: CommonSettings): { url: string; info: WebhookInfo } {
  const tail = (url: string) => url.slice(-6);
  if (common.webhook) return { url: common.webhook, info: { source: "shared", tail: tail(common.webhook), from: "공통 웹훅" } };
  const own = String(readJson(s.seed)?.["discord_webhook_url"] || "").trim();
  if (own) return { url: own, info: { source: "seed", tail: tail(own), from: basename(s.seed) } };
  const borrowed = String(readJson(join(dirname(s.seed), STOCK_CONFIG))?.["discord_webhook_url"] || "").trim();
  if (borrowed) return { url: borrowed, info: { source: "borrowed", tail: tail(borrowed), from: STOCK_CONFIG } };
  return { url: "", info: { source: "none", tail: "", from: "" } };
}

/** 태스크 홈에 설정을 쓴 뒤 원본을 띄우는 법. 상품 하나든 키워드든 같다. */
function launchOf(
  s: SiteSettings, home: string, args: string[], profileDir: string | null, pin: string, payProfileDir: string | null,
): Launch {
  // 프로필이 없으면 쿠키도 없다 (재고만·드라이런). 태스크 홈에는 본판 설정이 없어 원본이 다른 데서
  // 빌려 오지도 않는다 — 다른 계정의 쿠키가 새어 들 길이 없다.
  const cookie = profileDir ? cookieIn(profileDir) : "";
  return {
    entry: entryOf(s),
    tsxFrom: null,
    args,
    // AIO_TTY: 원본은 기다리는 동안 "지켜보는 중 · 1개 · 다음 확인 3초" 를 제자리에서 고쳐 쓰는데, 화면(TTY)일
    // 때만 찍는다 (../ui.ts — 롯데와 같은 화면 모듈). 워커가 표준출력을 화면처럼 보이게 해서 그 줄을 받는다.
    // BNKR_NAVER_SESSION: 결제 로그인 프로필(네이버)의 세션 파일. 원본이 크롬에 네이버 쿠키를 같이 심어 네이버페이 창이
    // 로그인된 채로 열린다. 원본은 읽기만 한다. 없으면 빈 값 — 씨앗 설정의 콘솔용 경로도 태스크 설정에서 비웠다.
    env: {
      BNKR_HOME: home, BNKR_COOKIE: cookie, BNKR_PG_PASSWORD: pin, AIO_TTY: "1",
      BNKR_NAVER_SESSION: payProfileDir ? naver.session.store(payProfileDir) : "",
    },
    redirects: [],
  };
}

/** 원본 --dry-run 은 한 번 보고 끝난다. 모니터는 sites.ts 에서 막지만, 여기까지 오면 까닭을 말하고 거절한다. */
const NO_MONITOR = "반다이남코 원본의 --dry-run 은 한 번만 보고 끝나서 모니터로 돌릴 수 없습니다.";

export const bnkr: SiteAdapter = {
  id: "bnkr",
  stopGraceMs: 6000, // 원본의 SIGINT 처리기는 "종료합니다." 를 찍고 바로 exit 한다 (크롬은 detach 라 남는다)

  defaults(aio) {
    const test = join(aio, CONFIG);
    const real = join(aio, REAL_CONFIG);
    return { root: join(aio, "node"), seed: existsSync(test) || !existsSync(real) ? test : real };
  },

  info(s, common) {
    const entry = entryOf(s);
    const seed = readJson(s.seed) ?? {};
    const { pin, fromEnv } = pinOf(s);
    const webhook = webhookOf(s, common);
    const problems: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];
    if (!existsSync(entry)) problems.push(`원본 빌드가 없습니다 (${entry}) — '원본 빌드' 를 누르세요.`);
    if (!webhook.url) warnings.push("디스코드 웹훅이 없습니다 — 결제창·결제 완료 알림이 안 갑니다 (설정에서 공통 웹훅을 넣으세요).");
    if (seed["buy_on_restock_only"] === false) {
      warnings.push("씨앗 설정의 buy_on_restock_only 가 false 입니다 — 지켜보기·한 번만은 지금 팔고 있는 상품을 바로 담고 결제까지 갑니다.");
    }
    if (!existsSync(s.seed)) notes.push("씨앗 설정이 없어 원본 기본값으로 돕니다.");
    if (String(seed["prelogin_url"] || "").trim()) {
      notes.push("씨앗 설정의 prelogin_url 때문에 지켜보기를 켜면 크롬에 네이버 로그인 창이 먼저 뜹니다 (최대 prelogin_wait_minutes 분 기다림).");
    }
    notes.push("드라이런은 원본이 한 번만 보고 끝납니다 (원본 --dry-run). 모니터는 지원하지 않습니다.");
    if (pin) notes.push("원본 설정에 콘솔용 간편결제 비밀번호가 있습니다 — 원본을 직접 돌릴 때만 씁니다 (태스크는 프로필의 결제 비밀번호).");
    return {
      site: "bnkr", entry, entryExists: existsSync(entry), seed: s.seed, seedExists: existsSync(s.seed),
      pin: { digits: pin.length, fromEnv, effect: pinEffectOf(seed) }, problems, warnings, notes,
      actionHints: actionHints(seed, false), actionHintsWithPin: actionHints(seed, true),
      defaultAction: defaultActionOf(seed), timing: timingOf(seed), webhook: webhook.info,
      prepare: "원본 빌드 (npm run build)",
    };
  },

  webhookUrl: (s, common) => webhookOf(s, common).url,

  launch(task: TaskDef, home, s, common, profileDir, pin, payProfileDir) {
    // 씨앗 설정을 그대로 베끼되 **대상만 이 태스크의 것으로** 바꾼다 — 상품 하나면 targets 에 그것만 (목록 훑기는 뺀다),
    // 키워드면 targets 를 비우고 discover 에 그 검색 하나만 (lookOf). 쿠키·비밀번호는 비워 둔다 (환경변수로 간다).
    // 담은 기록은 건드리지 않는다 — 키워드의 기준선(처음 훑을 때 보이던 것)도 거기 남는다.
    mkdirSync(home, { recursive: true });
    const target = targetOf(task);
    const webhook = webhookOf(s, common).url;
    const cfg = {
      ...readJson(s.seed), ...timingFields(task), cookie: "", pg_password: "", naver_session: "", ...lookOf(task),
      ...(webhook ? { discord_webhook_url: webhook } : {}),
    };
    writeFileSync(join(home, CONFIG), JSON.stringify(cfg, null, 2), "utf-8");

    const args: string[] = [];
    if (isBnkrKeyword(task.url)) {
      // 지켜보기: 원본이 목록을 훑어 새로 올라오거나 품절이 풀린 것을 담는다. 재고만: 원본 --find 로 검색 결과를 한 번 보인다
      // (상품번호·이름·품절 여부·값 — 로그인 없이). 나머지 모드는 sites.ts 의 modesOf 가 막는다.
      if (task.mode === "status") args.push("--find", task.url.trim());
      else if (task.action) args.push("--action", task.action);
      return launchOf(s, home, args, profileDir, pin, payProfileDir);
    }
    switch (task.mode) {
      case "once": args.push("--once"); break;
      case "dry-run": args.push("--dry-run"); break;
      case "status": args.push("--status"); break;
      // 원본 --buy 는 설정의 대상을 보지 않고 이 gno 를 DIRECT 로 바로 담는다. 수량은 --ea 로 (상한가는 안 본다).
      case "buy": args.push("--buy", target.gno, "--ea", String(target.ea)); break;
      case "watch": case "drop": break; // drop 은 이 사이트에 없다 (sites.ts 의 modes)
    }
    if (task.action) args.push("--action", task.action);
    return launchOf(s, home, args, profileDir, pin, payProfileDir);
  },

  resetState(home) {
    rmSync(join(home, STATE), { force: true });
  },

  writeMonitorConfig() {
    throw new Error(NO_MONITOR);
  },

  monitorLaunch() {
    throw new Error(NO_MONITOR);
  },

  // 모니터를 띄우지 않으니 맞을 줄이 없다.
  monitorSignal: { found: /(?!)/, stock: /(?!)/ },

  applyLive(task, home) {
    // 원본은 설정 파일이 바뀌면 기다리던 것을 접고 바로 다시 읽는다 (watch.ts 의 reloadConfig). 대상 칸만 고쳐 쓴다.
    const path = join(home, CONFIG);
    const cfg = readJson(path);
    if (!cfg) throw new Error(`태스크 설정을 읽지 못했습니다: ${path}`);
    // 키워드는 바로 못 고친다 — 원본은 바뀐 설정에 대상(targets)이 없으면 쓰던 설정을 그대로 지킨다 (reloadConfig).
    // 키워드에서 상품으로 바꿀 때도 다시 띄운다 — 대상만 고치면 키워드용 칸(buy_on_restock_only false)이 남는다.
    // 던지면 매니저가 다시 시작한다.
    if (isBnkrKeyword(task.url) || (Array.isArray(cfg["discover"]) && cfg["discover"].length)) {
      throw new Error("키워드 태스크는 원본이 바뀐 목록을 다시 읽지 않습니다");
    }
    writeJsonAtomic(path, { ...cfg, targets: [targetOf(task)] });
  },

  // "재고 N개, 담습니다" 뒤에 원본은 담기·주문서·결제창을 마치고(또는 접고) 담은 기록을 적는다.
  busy: { start: /재고 [\d,]+개, 담습니다|담긴 것으로 .+ 다시 시도합니다/, settledBy: STATE },

  // 원본 watch.ts · cart.ts · landing.ts 의 말들.
  // 상품 페이지의 숨은 값 goodsName (원본 site.ts 가 담을 때 쓰는 것). 없으면 og:title.
  // 키워드 태스크는 상품이 아니라 읽지 않는다.
  productName: async (url) => {
    if (!isBnkrGoods(url)) return null;
    const html = await fetchText(`${SITE}/goods/detail.do?gno=${encodeURIComponent(gnoOf(url))}`);
    const hidden = /name=["']goodsName["'][^>]*value=["']([^"']*)["']/i.exec(html)?.[1]?.trim();
    return hidden || htmlTitle(html);
  },
  progress: {
    countdown: /다음 확인 (\d+)초/,
    buying: /재고 [\d,]+개, 담습니다|담기 성공 \(|담긴 것으로 .+ 다시 시도합니다/,
    // log.info(`${LANDING_LABEL[mode]} — ${STAGE_LABEL[stage]}`): 주문서·결제창이 크롬에 떴다
    checkout: /(?:주문서 열기|결제하러 가기|선물 주문서 열기) — |남은 클릭은 직접 해주세요/,
    paid: /(?:^|\s)결제 완료$/,
  },

  session: {
    loginUrl: LOGIN_URL,
    // 로그인 창이 모은 쿠키를 프로필 폴더에 한 줄로 적는다. 태스크는 그 줄을 BNKR_COOKIE 로 받는다.
    store: (dir) => join(dir, COOKIE_FILE),
    check: { url: LOGIN_CHECK_URL, detection: { type: "url", value: BNKR_LOGIN_PATH } },
    has: (dir) => !!cookieIn(dir),
    expiry: () => null, // MEMBER_TOKEN 은 한 시간짜리지만 원본이 도는 동안 새로 받아 쓴다 — 물어봐서 안다
    whoami(s, dir, scratch) {
      return {
        entry: entryOf(s),
        tsxFrom: null,
        args: ["--whoami"],
        // 원본은 켤 때 제 집에 설정·로그를 만드니 빈 폴더를 집으로 준다 — 씨앗 설정 옆(콘솔의 집)에 두면 원본이
        // 거기 본판 설정의 쿠키를 빌려 쓸 수 있어 다른 계정을 묻게 된다.
        env: { BNKR_HOME: scratch, BNKR_COOKIE: cookieIn(dir), BNKR_PG_PASSWORD: "" },
        redirects: [],
      };
    },
    adopt(s, dir) {
      const cookie = seedCookie(s);
      if (!cookie) return false;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, COOKIE_FILE), `${cookie}\n`, "utf-8");
      return true;
    },
    judge(code, out) {
      if (code === 0 && out.includes("로그인됨 — ")) return { status: "logged_in", note: "원본이 확인했습니다" };
      if (out.includes("세션 쿠키가 없습니다")) return { status: "logged_out", note: "저장된 쿠키가 없습니다" };
      if (out.includes("로그인되어 있지 않습니다")) return { status: "expired", note: "쿠키는 있지만 로그인이 끊겼습니다" };
      return { status: "error", note: lastLine(out) || `원본이 ${code} 로 끝났습니다` };
    },
    deadLine: /로그인 세션이 (끊겼습니다|아닙니다)|로그인되어 있지 않습니다/,
    pin: {
      read: pinOf,
      // 원본 --pin <숫자>: 씨앗 설정 옆 테스트 설정의 pg_password 에 적는다.
      save: (s, digits) => ({
        entry: entryOf(s), tsxFrom: null, args: ["--pin", digits], env: { BNKR_HOME: dirname(s.seed) }, redirects: [],
      }),
      // 원본에 지우는 명령이 없다 (--pin 은 숫자만 받는다). 그 칸 하나만 비운다.
      clear: (s) => ({
        kind: "file",
        apply() {
          const path = join(dirname(s.seed), CONFIG);
          const cfg = readJson(path);
          if (cfg && cfg["pg_password"]) writeJsonAtomic(path, { ...cfg, pg_password: "" });
        },
      }),
      effect: (s) => pinEffectOf(readJson(s.seed) ?? {}),
    },
    login: {
      kind: "window",
      partition: (profileId) => `persist:login-bnkr-${profileId}`,
      startUrl: LOGIN_URL,
      cookieUrl: `${SITE}/`,
      isLoginPage: (url) => url.includes(BNKR_LOGIN_PATH) || !/(^|\.)bnkrmall\.co\.kr$/.test(hostOf(url)),
      alive: loginAlive,
      save(dir, cookie) {
        // 원본 --cookie 가 받는 것과 같은 Cookie: 줄. 원본 설정이 아니라 프로필 폴더에 둔다 — 계정마다 한 벌.
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, COOKIE_FILE), `${cookie.trim()}\n`, "utf-8");
      },
    },
  },

  prepare(s) {
    // 롯데와 같은 원본 프로젝트(aio/node)다. 한 번 구우면 둘 다 새로 구워진다.
    return { label: "원본 빌드", cmd: "npm", args: ["run", "build"], cwd: s.root };
  },
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function lastLine(out: string): string {
  return out.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? "";
}
