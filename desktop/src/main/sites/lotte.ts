/**
 * 롯데온 — 원본은 aio/node/src/lotte-test, 빌드된 dist/lotte-test/index.js 를 들인다.
 *
 * 원본은 파일 위치를 LOTTEON_HOME 에서, 쿠키·비밀번호를 LOTTEON_COOKIE · LOTTEON_PG_PASSWORD
 * 에서 읽는다. 그래서 태스크마다 홈을 따로 주면 설정·산 기록·로그·결제창 받아쓰기가 전부
 * 따로 쌓이고, 돌릴 파일 경로도 없다. 쿠키는 태스크가 고른 프로필의 lotte-cookie.txt 에서 읽어
 * 환경변수로 넘긴다 — 태스크마다 다른 계정이어도 섞일 것이 없다 (원본은 크롬을 매번 빈 임시
 * 프로필로 띄우고 쿠키를 심는다).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LOTTE_ACTIONS } from "../../shared/sites.js";
import type {
  CommonSettings, MonitorDef, OrderAction, QueuePeek, SiteSettings, TaskDef, TimingDefaults, WebhookInfo,
} from "../../shared/types.js";
import { MONITOR_MAX_BUYS, readJson, writeJsonAtomic, type JsonObject, type SiteAdapter } from "./adapter.js";

const CONFIG = "lotteon_test_config.json";
const STATE = "lotteon_test_state.json";
/** 본판 설정. 테스트 설정에 쿠키가 비었을 때 원본이 여기서 빌려 온다 — 우리도 그렇게 찾는다. */
const REAL_CONFIG = "lotteon_buy_config.json";
/** 웹훅을 따로 안 적었으면 원본이 여기서 빌려 쓴다 (config.ts 의 webhookOf). */
const BNKR_CONFIG = "bnkr_buy_config.json";
/** 원본 config.ts 의 passwordOf 가 먼저 보는 환경변수. */
const PIN_ENV = "LOTTEON_PG_PASSWORD";
/** 프로필 폴더의 쿠키 — Cookie: 줄 그대로 한 줄. */
const COOKIE_FILE = "lotte-cookie.txt";

/** 태스크 홈의 설정에 적는 대상 한 줄. 원본의 TargetSpec 과 맞는지는 src/legacy/contract.ts 가 본다. */
export interface LotteTaskTarget {
  url: string;
  ea: number;
  option: string;
  max_price: number;
  label: string;
}

const entryOf = (s: SiteSettings) => join(s.root, "dist", "lotte-test", "index.js");

const SITE = "https://www.lotteon.com";
/**
 * 원본 http.ts 의 LOGIN_PATH · LOGIN_CHECK_URL. 로그인 안 된 쿠키로 확인 주소에 HEAD 를 던지면
 * 이 경로로 보낸다 (302). LOGIN_PATH 가 같은지는 src/legacy/contract.ts 가 본다.
 */
export const LOTTE_LOGIN_PATH = "/p/member/login";
const LOGIN_CHECK_URL = `${SITE}/p/order/mylotte/orderDeliveryList`;
const LOGIN_URL = `${SITE}${LOTTE_LOGIN_PATH}/common?rtnUrl=${encodeURIComponent(`${SITE}/`)}`;

// ── 열리기 전 대기열 보기 ─────────────────────────────────────────────────────
//
// 원본이 쓰는 두 주소를 **쿠키 없이 읽기만** 한다. 원본 모듈을 main 에 들이지 않고 셈만 옮겨 적는다 — 원본은
// 들이는 순간 제 집(LOTTEON_HOME)에 설정·로그를 만드는 모듈이 딸려 온다.
//   상품 페이지  대기열이 서 있으면 본문 대신 숨은 칸(isWait·waitCnt·limitCnt·session_time_out)이 온다 — tracer.ts gateOf
//   상품 API     아직 안 열렸으면 열리는 시각 — product.ts opensAtOf
// 줄에 서지 않는다. 줄에 서는 것은 대기 화면 스크립트가 순번 쿠키(wcCookie)를 만들어 순번을 물을 때다 (tracer.ts).

/** 원본 http.ts 의 Session 이 보내는 것과 같은 브라우저 이름. */
const PEEK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
/** 원본 product.ts 의 STOCK_API. */
const STOCK_API = "https://pbf.lotteon.com/product/v2/detail/search/base/sitm";

/** 상품 주소(또는 상품번호) → 상품 번호 · 단품 번호. 원본 targets.ts 와 같은 규칙 (단품이 없으면 _001). */
function itemOf(url: string): { key: string; sitm: string; page: string } {
  const u = url.trim();
  const key = /product\/([A-Za-z0-9_-]+)/.exec(u)?.[1] ?? u;
  const sitm = decodeURIComponent(/[?&]sitmNo=([^&#]+)/.exec(u)?.[1] ?? "") || `${key}_001`;
  return { key, sitm, page: `${SITE}/p/product/${key}?sitmNo=${encodeURIComponent(sitm)}` };
}

async function peekGet(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": PEEK_UA, "Accept-Language": "ko-KR,ko;q=0.9" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 원본 tracer.ts 의 gateOf 와 같은 셈. */
function gateOf(html: string): Pick<QueuePeek, "waiting" | "count" | "limit" | "session" | "pageEta"> {
  const hidden = (id: string) => new RegExp(`id="${id}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? "";
  if (!hidden("tracer_domain")) return { waiting: false, count: 0, limit: 0, session: 0, pageEta: 0 };
  const count = Number(hidden("waitCnt")) || 0;
  const limit = Number(hidden("limitCnt")) || 0;
  const session = Number(hidden("session_time_out")) || 0;
  const waiting = hidden("isWait") === "T";
  return { waiting, count, limit, session, pageEta: waiting && limit ? Math.round((session / limit) * count) : 0 };
}

/** 원본 product.ts 의 stamp — API 의 시각 칸 → YYYYMMDDHHmmss. */
const stamp = (v: unknown): string => {
  const digits = v == null ? "" : String(v).replace(/\D/g, "");
  return digits ? digits.padEnd(14, "0").slice(0, 14) : "";
};
const kstNow = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().replace(/\D/g, "").slice(0, 14);
/** 원본 product.ts 의 kstMs — YYYYMMDDHHmmss (한국 시각) → epoch ms. */
const kstMs = (at: string): number =>
  new Date(`${at.slice(0, 4)}-${at.slice(4, 6)}-${at.slice(6, 8)}T${at.slice(8, 10)}:${at.slice(10, 12)}:${at.slice(12, 14)}+09:00`).getTime();

/**
 * 원본 product.ts 의 opensAtOf 와 같은 셈 — 판매 시작 전이면 그 시각, 예약배송이면 예약주문 시작. 예약주문 시작은
 * 열리기 전에 null 로 와서 배송 안내 줄("26.10.10 10:00 ~ …")에서 읽는다. → ms / null
 */
function opensAtOf(data: JsonObject): number | null {
  const now = kstNow();
  const basic = (data["basicInfo"] ?? {}) as JsonObject;
  const dlv = (data["dlvInfo"] ?? {}) as JsonObject;
  const start = stamp(basic["slStrtDttm"]);
  if (start && now < start) return kstMs(start);
  if (dlv["dvRsvDvsCd"] === "RSV_DV") {
    const from = stamp(dlv["rsvOdStrtDttm"]);
    if (from) return now < from ? kstMs(from) : null;
    const list = Array.isArray(dlv["dvList"]) ? (dlv["dvList"] as JsonObject[]) : [];
    for (const one of list) {
      const m = /(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})/.exec(String(one?.["odTxt"] ?? ""));
      if (!m) continue;
      const at = `20${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}00`;
      return now < at ? kstMs(at) : null;
    }
  }
  return null;
}

/** 상품 API 의 이름 (원본 product.ts 와 같은 칸 — basicInfo.pdNm). */
async function productName(url: string): Promise<string | null> {
  const { sitm } = itemOf(url);
  const api = `${STOCK_API}/${encodeURIComponent(sitm)}?sitmNo=${encodeURIComponent(sitm)}&isNotContainOptMapping=true`;
  const data = ((JSON.parse(await peekGet(api)) as JsonObject)["data"] ?? {}) as JsonObject;
  const basic = (data["basicInfo"] ?? {}) as JsonObject;
  return String(basic["pdNm"] ?? basic["spdNm"] ?? "").trim() || null;
}

async function peekQueue(task: TaskDef): Promise<Omit<QueuePeek, "taskId" | "at">> {
  const { sitm, page } = itemOf(task.url);
  const api = `${STOCK_API}/${encodeURIComponent(sitm)}?sitmNo=${encodeURIComponent(sitm)}&isNotContainOptMapping=true`;
  const [html, body] = await Promise.allSettled([peekGet(page), peekGet(api)]);
  let opensAt: number | null = null;
  if (body.status === "fulfilled") {
    try {
      opensAt = opensAtOf(((JSON.parse(body.value) as JsonObject)["data"] ?? {}) as JsonObject);
    } catch {
      opensAt = null; // 열리는 시각을 모를 뿐, 대기열은 따로 본다.
    }
  }
  if (html.status === "rejected") {
    return { waiting: false, count: 0, limit: 0, session: 0, pageEta: 0, opensAt, error: `상품 페이지를 못 받았습니다: ${(html.reason as Error).message}` };
  }
  return { ...gateOf(html.value), opensAt, error: null };
}

function targetOf(task: TaskDef): LotteTaskTarget {
  return {
    url: task.url.trim(),
    ea: task.ea || 1,
    option: task.option,
    max_price: task.max_price || 0,
    label: task.label,
  };
}

/** 원본 loginAlive 와 같은 물음: 200 이면 살아 있다. 로그인 페이지로 보내면 끊긴 것이다. */
async function loginAlive(cookie: string): Promise<boolean> {
  const res = await fetch(LOGIN_CHECK_URL, {
    method: "HEAD",
    headers: { Cookie: cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  return res.status === 200;
}

/**
 * 태스크의 간격·재시도를 원본 설정 칸으로 옮긴 것. 원본 Config 에 있는 칸·타입인지는
 * src/legacy/contract.ts 가 본다.
 */
export interface LotteTimingFields {
  poll_interval_seconds?: number;
  drop_interval_seconds?: number;
  max_attempts?: number;
  retry_delay_seconds?: number;
  stop_after_success?: boolean;
  max_buys_per_run?: number;
}

/**
 * 모니터가 원본 설정에 적는 칸. 원본 Config 에 있는 칸·타입인지는 src/legacy/contract.ts 가 본다.
 *
 * 모니터는 --dry-run 으로 돈다. dry-run 도 구매 자리까지 가면 "샀을 것" 을 산 것으로 세어
 *   max_buys_per_run 에 닿으면 감시를 끝내고, stop_after_success 면 그 상품을 "다 샀다" 로 두고,
 *   시도한 상품은 cooldown_minutes 동안 쉰다
 * — 발견한 뒤에도 계속 보려면 셋 다 풀어야 한다. 발견을 무엇으로 볼지는 buy_on_restock_only 다.
 */
export interface LotteMonitorFields {
  targets: LotteTaskTarget[];
  buy_on_restock_only: boolean;
  poll_interval_seconds: number;
  drop_interval_seconds?: number;
  max_buys_per_run: number;
  stop_after_success: boolean;
  cooldown_minutes: number;
}

/** 모니터 간격이 씨앗의 하한(min_interval_seconds, 기본 5초)보다 짧으면 드랍 걸음(--drop)으로 돈다. */
export function monitorDrop(def: MonitorDef, s: SiteSettings): boolean {
  return def.checkIntervalMs < timingOf(readJson(s.seed) ?? {}).minIntervalMs;
}

/** 모니터 홈에 원본 설정(lotteon_test_config.json)을 쓴다. → 쓴 파일 */
function writeMonitorConfig(def: MonitorDef, home: string, s: SiteSettings): string {
  mkdirSync(home, { recursive: true });
  const seed = readJson(s.seed) ?? {};
  const floor = timingOf(seed).minIntervalMs;
  const drop = monitorDrop(def, s);
  const fields: LotteMonitorFields = {
    targets: [{ url: def.productUrl.trim(), ea: def.ea || 1, option: def.option, max_price: def.maxPrice || 0, label: def.name }],
    buy_on_restock_only: def.restockOnly,
    // 드랍 걸음이면 평소 간격은 씨앗 하한으로 둔다 — 원본은 조회가 실패한 바퀴 뒤에 이 간격으로 한 번 쉰다.
    poll_interval_seconds: (drop ? floor : def.checkIntervalMs) / 1000,
    ...(drop ? { drop_interval_seconds: def.checkIntervalMs / 1000 } : {}),
    max_buys_per_run: MONITOR_MAX_BUYS,
    stop_after_success: false,
    cooldown_minutes: 0,
  };
  const path = join(home, CONFIG);
  writeJsonAtomic(path, { ...seed, ...fields, cookie: "", pg_password: "", discord_webhook_url: "" });
  return path;
}

/** 원본 watch.ts 의 DROP_FLOOR — 드랍 모드에서도 이 밑으로는 조회 간격을 안 내린다(초). */
const DROP_FLOOR_SECONDS = 0.5;

/** 원본은 설정 파일을 DEFAULT_CONFIG 위에 얹어 읽는다 — 칸이 없으면 기본값, 있으면 그 값. */
const pick = (seed: JsonObject, key: string, dflt: number): number =>
  typeof seed[key] === "number" ? (seed[key] as number) : dflt;

/** 씨앗 설정의 간격·재시도. 원본 watch.ts 와 같은 규칙이다. */
function timingOf(seed: JsonObject): TimingDefaults {
  const floor = pick(seed, "min_interval_seconds", 5);
  const maxBuys = pick(seed, "max_buys_per_run", 1);
  return {
    checkIntervalMs: Math.max(floor, pick(seed, "poll_interval_seconds", 15)) * 1000,
    minIntervalMs: floor * 1000,
    wholeSeconds: false,
    maxRetries: Math.max(1, Number(pick(seed, "max_attempts", 3) || 1)) - 1,
    retryDelayMs: pick(seed, "retry_delay_seconds", 2) * 1000,
    // 원본은 max_buys_per_run 만큼 사면 감시를 끝낸다. stop_after_success 는 "다 샀다" 고 적어 다시 안 사게 한다.
    stopOnSuccess: seed["stop_after_success"] !== false && maxBuys <= 1,
    maxBuys,
    retryScope: "재고 조회와 구매 시도(주문서 열기)가 실패했을 때",
    rateWarnPerMin: null,
    drop: {
      intervalMs: Math.max(DROP_FLOOR_SECONDS, pick(seed, "drop_interval_seconds", 1)) * 1000,
      minIntervalMs: DROP_FLOOR_SECONDS * 1000,
    },
  };
}

const PIN_EFFECT = "결제창이 뜨면 간편결제 비밀번호 자판까지 누릅니다 — 결제 확정은 사람이 누릅니다";

function timingFields(task: TaskDef): LotteTimingFields {
  const out: LotteTimingFields = {};
  // 원본이 min_interval_seconds 아래로는 올려서 본다. 하한은 씨앗 설정 것을 그대로 둔다.
  if (task.checkIntervalMs !== null) out.poll_interval_seconds = task.checkIntervalMs / 1000;
  // 드랍 모드의 걸음. 원본이 0.5초 밑으로는 올려서 본다 (DROP_FLOOR).
  if (task.dropSettings.intervalMs !== null) out.drop_interval_seconds = task.dropSettings.intervalMs / 1000;
  if (task.maxRetries !== null) out.max_attempts = task.maxRetries + 1;
  if (task.retryDelayMs !== null) out.retry_delay_seconds = task.retryDelayMs / 1000;
  if (task.stopOnSuccess === true) Object.assign(out, { stop_after_success: true, max_buys_per_run: 1 });
  if (task.stopOnSuccess === false) Object.assign(out, { stop_after_success: false, max_buys_per_run: Math.max(2, task.maxBuys) });
  return out;
}

/** 씨앗 설정의 order_action. 원본 actionOf: 기본 submit, 모르는 값이면 open. */
function defaultActionOf(seed: JsonObject): Exclude<OrderAction, ""> {
  const raw = String(seed["order_action"] ?? "submit").toLowerCase();
  return LOTTE_ACTIONS.find((a) => a === raw) ?? "open";
}

/** "어디까지" 마다 원본이 실제로 어디서 멈추나 (비밀번호가 있을 때 / 없을 때). 원본 order.ts 의 arrivalLine 과 같은 말이다. */
function actionHints(seed: JsonObject, hasPin: boolean): Partial<Record<OrderAction, string>> {
  const hints: Partial<Record<OrderAction, string>> = {
    open: "주문서까지만 갑니다 — 결제는 사람이 누릅니다",
    agree: "주문서에서 필수 동의까지 하고 멈춥니다",
    submit: hasPin
      ? "결제창까지 띄우고 간편결제 비밀번호까지 누릅니다 — 결제 확정은 사람이 누릅니다"
      : "결제창까지 띄웁니다 — 비밀번호와 결제 확정은 사람이 누릅니다",
  };
  const dflt = defaultActionOf(seed);
  hints[""] = `씨앗 설정(${dflt}) — ${hints[dflt]}`;
  return hints;
}

/**
 * 간편결제 비밀번호 (사이트 공통). 원본 passwordOf 와 같은 순서 — 환경변수 → 씨앗 설정.
 * **태스크 홈에는 적지 않는다.** 환경변수로만 넘겨서, 비밀이 태스크 수만큼 복제되지 않게.
 */
function pinOf(s: SiteSettings): { pin: string; fromEnv: string | null } {
  const env = String(process.env[PIN_ENV] || "").trim();
  if (env) return { pin: env, fromEnv: PIN_ENV };
  return { pin: String(readJson(s.seed)?.["pg_password"] || "").trim(), fromEnv: null };
}

/** 프로필의 쿠키. 쿠키도 태스크 홈에는 적지 않고 환경변수(LOTTEON_COOKIE)로만 넘긴다. */
function cookieIn(dir: string): string {
  try {
    return readFileSync(join(dir, COOKIE_FILE), "utf-8").trim();
  } catch {
    return "";
  }
}

/** 0.2 까지 쓰던 쿠키 — 원본과 같은 순서로 씨앗 설정 → 본판 설정. 프로필로 옮길 때만 읽는다. */
function seedCookie(s: SiteSettings): string {
  const seed = readJson(s.seed) ?? {};
  const real = readJson(join(dirname(s.seed), REAL_CONFIG)) ?? {};
  return String(seed["cookie"] || real["cookie"] || "").trim();
}

/**
 * 원본이 알림을 보낼 웹훅. 두 사이트 공통 웹훅 → 씨앗 설정 → bnkr 설정 (원본 webhookOf 의 빌려 쓰기).
 *
 * 태스크는 LOTTEON_HOME 이 태스크 홈이라 원본이 bnkr 설정을 거기서 찾다가 못 찾는다. 그래서
 * 빌려 쓰는 것까지 여기서 해서 태스크 설정에 적어 준다.
 */
function webhookOf(s: SiteSettings, common: CommonSettings): { url: string; info: WebhookInfo } {
  const tail = (url: string) => url.slice(-6);
  if (common.webhook) return { url: common.webhook, info: { source: "shared", tail: tail(common.webhook), from: "공통 웹훅" } };
  const own = String(readJson(s.seed)?.["discord_webhook_url"] || "").trim();
  if (own) return { url: own, info: { source: "seed", tail: tail(own), from: basename(s.seed) } };
  const borrowed = String(readJson(join(dirname(s.seed), BNKR_CONFIG))?.["discord_webhook_url"] || "").trim();
  if (borrowed) return { url: borrowed, info: { source: "borrowed", tail: tail(borrowed), from: BNKR_CONFIG } };
  return { url: "", info: { source: "none", tail: "", from: "" } };
}

export const lotte: SiteAdapter = {
  id: "lotte",
  stopGraceMs: 6000, // 원본의 SIGINT 처리기는 산 기록을 적고 바로 exit 한다. 6초면 넉넉하다

  defaults(aio) {
    const test = join(aio, CONFIG);
    const real = join(aio, REAL_CONFIG);
    return { root: join(aio, "node"), seed: existsSync(test) || !existsSync(real) ? test : real };
  },

  info(s, common) {
    const entry = entryOf(s);
    const { pin, fromEnv } = pinOf(s);
    const webhook = webhookOf(s, common);
    const problems: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];
    if (!existsSync(entry)) problems.push(`원본 빌드가 없습니다 (${entry}) — '원본 빌드' 를 누르세요.`);
    if (!webhook.url) warnings.push("디스코드 웹훅이 없습니다 — '결제해 주세요' 알림이 안 갑니다 (설정에서 공통 웹훅을 넣으세요).");
    if (!existsSync(s.seed)) notes.push("씨앗 설정이 없어 원본 기본값으로 돕니다.");
    if (pin) notes.push("원본 설정에 콘솔용 간편결제 비밀번호가 있습니다 — 원본을 직접 돌릴 때만 씁니다 (태스크는 프로필의 결제 비밀번호).");
    return {
      site: "lotte", entry, entryExists: existsSync(entry), seed: s.seed, seedExists: existsSync(s.seed),
      pin: { digits: pin.length, fromEnv, effect: PIN_EFFECT }, problems, warnings, notes,
      actionHints: actionHints(readJson(s.seed) ?? {}, false), actionHintsWithPin: actionHints(readJson(s.seed) ?? {}, true),
      defaultAction: defaultActionOf(readJson(s.seed) ?? {}), timing: timingOf(readJson(s.seed) ?? {}), webhook: webhook.info,
      prepare: "원본 빌드 (npm run build)",
    };
  },

  webhookUrl: (s, common) => webhookOf(s, common).url,

  launch(task: TaskDef, home, s, common, profileDir, pin) {
    // 씨앗 설정을 그대로 베끼되 **대상만 이 태스크의 상품 하나로** 바꾼다. 쿠키·비밀번호는
    // 비워 둔다 (환경변수로 간다 — 비밀번호는 씨앗의 콘솔용이 아니라 프로필 것). 산 기록은 건드리지 않는다.
    mkdirSync(home, { recursive: true });
    const target = targetOf(task);
    const webhook = webhookOf(s, common).url;
    const cfg = {
      ...readJson(s.seed), ...timingFields(task), cookie: "", pg_password: "", targets: [target],
      ...(webhook ? { discord_webhook_url: webhook } : {}),
    };
    writeFileSync(join(home, CONFIG), JSON.stringify(cfg, null, 2), "utf-8");

    const args: string[] = [];
    switch (task.mode) {
      case "once": args.push("--once"); break;
      case "dry-run": args.push("--dry-run"); break;
      case "status": args.push("--status"); break;
      // 대상은 설정에 이미 하나뿐이지만, 주소를 같이 넘겨야 원본이 "그 상품" 을 바로 산다.
      case "buy": args.push("--buy", target.url); break;
      // 지켜보기 + 빠른 걸음. 원본은 --drop 을 감시에만 건다 (--buy·--status 에는 걸음이 없다).
      case "drop": args.push("--drop"); break;
      case "watch": break;
    }
    if (task.action) args.push("--action", task.action);

    // 프로필이 없으면 쿠키도 없다 (재고만·드라이런). 태스크 홈에는 본판 설정이 없어 원본이 다른 데서
    // 빌려 오지도 않는다 — 다른 계정의 쿠키가 새어 들 길이 없다.
    const cookie = profileDir ? cookieIn(profileDir) : "";
    return {
      entry: entryOf(s),
      tsxFrom: null,
      args,
      // AIO_TTY: 원본은 기다리는 동안 "품절 · 다음 확인 3초" 를 제자리에서 고쳐 쓰는데, 화면(TTY)일 때만
      // 찍는다 (ui.ts). 워커가 표준출력을 화면처럼 보이게 해서 그 줄을 받는다 — 모니터링 창의 회차·남은 초.
      // 비밀번호는 프로필 것, 없으면 빈 값 — 원본은 환경변수를 설정보다 먼저 보고, 태스크 설정의 pg_password 는 비었다.
      env: { LOTTEON_HOME: home, LOTTEON_COOKIE: cookie, LOTTEON_PG_PASSWORD: pin, AIO_TTY: "1" },
      redirects: [],
    };
  },

  resetState(home) {
    rmSync(join(home, STATE), { force: true });
  },

  writeMonitorConfig,

  monitorLaunch(def, home, s) {
    writeMonitorConfig(def, home, s);
    return {
      entry: entryOf(s),
      tsxFrom: null,
      // --dry-run: 쿠키 없이 재고만 보고, 구매 자리에서 "[dry-run] 여기서 바로 구매하기를 눌렀을 것입니다" 만 찍는다.
      // 산 기록·디스코드도 안 쓴다. 씨앗 하한보다 촘촘하면 드랍 걸음(--drop)으로 — 원본이 둘을 같이 받는다.
      args: ["--dry-run", ...(monitorDrop(def, s) ? ["--drop"] : [])],
      // 쿠키·비밀번호는 비운다 — 사용자 환경변수가 새어 들지 않게. 상태 줄(다음 확인 N초)은 태스크처럼 받는다.
      env: { LOTTEON_HOME: home, LOTTEON_COOKIE: "", LOTTEON_PG_PASSWORD: "", AIO_TTY: "1" },
      redirects: [],
    };
  },

  // 원본 order.ts 의 doBuy 가 dry-run 일 때만 찍는 줄 · watch.ts 의 sayWhyChanged ("[키] 판정 품절 ← SOLD_OUT").
  monitorSignal: {
    found: /\[dry-run\] 여기서 바로 구매하기를 눌렀을 것입니다 — (\S+)/,
    stock: / 판정 (구매 가능|품절) ← /,
  },

  applyLive(task, home) {
    // 원본은 기다리는 사이에 설정 파일의 targets 만 다시 읽는다 (watch.ts 의 reread). 그 칸만
    // 고쳐 쓴다. 나머지 칸은 원본이 이미 읽어 들인 값으로 돈다.
    const path = join(home, CONFIG);
    const cfg = readJson(path);
    if (!cfg) throw new Error(`태스크 설정을 읽지 못했습니다: ${path}`);
    writeJsonAtomic(path, { ...cfg, targets: [targetOf(task)] });
  },

  // "구매 가능, 바로 구매하기를 누릅니다" 뒤에 원본은 구매를 마치고(또는 접고) 산 기록을 적는다.
  busy: { start: /구매 가능, 바로 구매하기를 누릅니다/, settledBy: STATE },

  // 원본 order.ts 의 말들. 주문서·결제창이 열리면 "…크롬 창에서 직접 해주세요", 다 끝나면 "결제 완료 — …".
  progress: {
    countdown: /다음 확인 (\d+)초/,
    // tracer.ts 의 lineOf: "대기열 내 앞 273명 · 줄 281명 · 예상 12초 · 5초째"
    queue: /대기열 내 앞 ([\d,]+)명(?: · 줄 ([\d,]+)명)?(?: · 예상 (\d+)초)?/,
    queueDone: /대기열을 통과했습니다/,
    buying: /구매 가능, 바로 구매하기를 누릅니다/,
    checkout: /직접 해주세요/,
    paid: /결제 완료 — /,
  },

  peekQueue,
  productName,

  session: {
    loginUrl: LOGIN_URL,
    // 로그인 창이 모은 쿠키를 프로필 폴더에 한 줄로 적는다. 태스크는 그 줄을 LOTTEON_COOKIE 로 받는다.
    store: (dir) => join(dir, COOKIE_FILE),
    check: { url: LOGIN_CHECK_URL, detection: { type: "url", value: LOTTE_LOGIN_PATH } },
    has: (dir) => !!cookieIn(dir),
    expiry: () => null, // 어느 쿠키가 로그인을 지는지 원본도 모른다 — 물어봐서 안다
    whoami(s, dir, scratch) {
      return {
        entry: entryOf(s),
        tsxFrom: null,
        args: ["--whoami"],
        // 태스크가 쓰는 것과 같은 쿠키를 묻는다. 원본은 켤 때 제 집에 설정·로그를 만드니 빈 폴더를 집으로
        // 준다 — 씨앗 설정 옆(콘솔의 집)에 두면 원본이 거기 쿠키를 빌려 쓸 수 있어 다른 계정을 묻게 된다.
        env: { LOTTEON_HOME: scratch, LOTTEON_COOKIE: cookieIn(dir), LOTTEON_PG_PASSWORD: "" },
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
      if (code === 0 && out.includes("세션이 살아 있습니다")) return { status: "logged_in", note: "원본이 확인했습니다" };
      if (out.includes("저장된 쿠키가 없습니다")) return { status: "logged_out", note: "저장된 쿠키가 없습니다" };
      if (out.includes("세션이 끊겼습니다")) return { status: "expired", note: "쿠키는 있지만 로그인이 끊겼습니다" };
      return { status: "error", note: lastLine(out) || `원본이 ${code} 로 끝났습니다` };
    },
    deadLine: /세션이 (이미 )?끊겼습니다/,
    pin: {
      read: pinOf,
      // 원본 --pin <숫자>: 쿠키처럼 씨앗 설정 옆 테스트 설정의 pg_password 에 적는다.
      save: (s, digits) => ({
        entry: entryOf(s), tsxFrom: null, args: ["--pin", digits], env: { LOTTEON_HOME: dirname(s.seed) }, redirects: [],
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
      effect: () => PIN_EFFECT,
    },
    login: {
      kind: "window",
      partition: (profileId) => `persist:login-lotte-${profileId}`,
      startUrl: LOGIN_URL,
      cookieUrl: `${SITE}/`,
      isLoginPage: (url) => url.includes(LOTTE_LOGIN_PATH) || !/(^|\.)lotteon\.com$/.test(hostOf(url)),
      alive: loginAlive,
      save(dir, cookie) {
        // 원본 --cookie 가 받는 것과 같은 Cookie: 줄. 원본 설정이 아니라 프로필 폴더에 둔다 — 계정마다 한 벌.
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, COOKIE_FILE), `${cookie.trim()}\n`, "utf-8");
      },
    },
  },

  prepare(s) {
    // 원본 파일은 읽기만 하고, dist 만 새로 구워진다.
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
