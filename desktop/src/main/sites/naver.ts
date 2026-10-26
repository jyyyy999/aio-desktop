/**
 * 네이버 스마트스토어·브랜드스토어 — 원본은 naver/ts, **TS 소스(src/cli.ts)를 tsx 로 그대로** 들인다.
 * 원본도 빌드 없이 tsx 로 도는 프로젝트라 dist 가 없다.
 *
 * 원본은 파일 위치를 제 폴더 위(naver/)에 박아 두었다 (cli.ts 의 ROOT). 그중
 *   설정 · 상태     --config · --state 로 바꿀 수 있다 → 태스크 홈으로
 *   로그 · 받아쓰기  바꿀 길이 없다 → 워커가 쓰기를 태스크 홈으로 돌린다 (redirects)
 *   로그인 세션      바꿀 길이 없다 (cli.ts 의 SESSION_PATH, 절대 경로) → 워커가 읽기·쓰기를 태스크가
 *                    고른 프로필의 naver_session.json 으로 돌린다 (redirects)
 *
 * 세션을 원본 자리에 복사해 넣었다 빼는 식으로는 안 된다. 원본은 시작할 때만이 아니라 **구매 창을
 * 열 때마다**(browser.ts 의 openBuyer) 세션 파일을 다시 읽는다 — 다른 프로필의 태스크가 그 사이에
 * 파일을 바꿔 넣으면 다른 계정으로 구매 창이 열린다. 돌리기는 프로세스마다라 그럴 일이 없다.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isNaverSearch, NAVER_ACTIONS } from "../../shared/sites.js";
import type { CommonSettings, MonitorDef, OrderAction, SiteSettings, TaskDef, TimingDefaults, WebhookInfo } from "../../shared/types.js";
import { MONITOR_MAX_BUYS, objectAt, readJson, writeJsonAtomic, type JsonObject, type SiteAdapter } from "./adapter.js";

const CONFIG = "smartstore_config.json";
const STATE = "smartstore_state.ts.json";
// cli.ts 가 ROOT 에 박아 둔 이름들.
const LOG = "smartstore-ts.log";
const PG_DUMP = "smartstore-ts-pg-dump.txt";
const SESSION = "naver_session.json";

/**
 * 원본 watch.ts 의 요청률 선 (RATE_WARN_PER_MIN · RATE_HARD_PER_MIN). 같은 값인지는
 * src/legacy/contract.ts 가 본다. README: "2초마다 보면 네이버는 로그인 세션째로 막는다."
 */
export const NAVER_RATE = { warn: 10, hard: 30 } as const;

/** 스토어 검색 태스크가 설정의 searches 에 적는 한 줄. 원본 config.ts 의 parseSearch 가 읽는다 — src/legacy/contract.ts 가 본다. */
export interface NaverSearchEntry {
  url: string;
  ea: number;
  option: string;
  max_price: number;
}

const entryOf = (s: SiteSettings) => join(s.root, "src", "cli.ts");
/** cli.ts 의 ROOT — `resolve(import.meta.dirname, "..", "..")`, 곧 naver/ts 의 위. */
const baseOf = (s: SiteSettings) => resolve(s.root, "..");
const hasTsx = (s: SiteSettings) => existsSync(join(s.root, "node_modules", "tsx", "package.json"));

type StoredCookie = { name?: unknown; expires?: unknown };

function sessionCookies(file: string): StoredCookie[] {
  const cookies = readJson(file)?.["cookies"];
  return Array.isArray(cookies) ? (cookies as StoredCookie[]) : [];
}

/** 세션 파일에 로그인 쿠키가 둘 다 있나. 원본 cmdWhoami 와 같은 기준이다 (살아 있는지는 묻지 않는다). */
function hasSession(file: string): boolean {
  const names = new Set(sessionCookies(file).map((c) => c.name));
  return names.has("NID_AUT") && names.has("NID_SES");
}

/** 프로필 폴더의 세션 파일. 원본 자리의 것과 같은 모양(Playwright storageState)이다. */
const sessionIn = (dir: string) => join(dir, SESSION);

/**
 * 원본이 세션 파일을 읽고 쓰는 자리(naver/naver_session.json)를 프로필 폴더의 것으로. 워커가 이 경로로
 * 가는 existsSync · readFileSync · fs.promises(Playwright 의 storageState) 를 돌린다.
 */
const sessionRedirect = (s: SiteSettings, dir: string): [string, string] => [join(baseOf(s), SESSION), sessionIn(dir)];

// 원본 fetcher.ts 의 doLogin 이 여는 곳, commands.ts 의 cmdWhoami 가 묻는 곳.
const LOGIN_URL = "https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fsmartstore.naver.com%2F";
const LOGIN_CHECK_URL = "https://nid.naver.com/user2/help/myInfoV2?lang=ko_KR";

function lastLine(out: string): string {
  return out.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? "";
}

// 아래는 씨앗 설정을 원본 config.ts 와 **같은 규칙**으로 읽는다 (기본값·하한·환경변수 순서).

// 원본 config.ts 가 설정 파일보다 먼저 보는 환경변수들.
const PIN_ENV = "NAVER_PG_PASSWORD";
const WEBHOOK_ENV = "DISCORD_SMARTSTORE_WEBHOOK_URL";

/** 간편결제 비밀번호와 어디서 왔나 — 환경변수 → buy.pg_password. */
function pinSource(seed: JsonObject): { pin: string; fromEnv: string | null } {
  const env = String(process.env[PIN_ENV] || "").replace(/\D/g, "");
  if (env) return { pin: env, fromEnv: PIN_ENV };
  return { pin: String(objectAt(seed, "buy")["pg_password"] || "").replace(/\D/g, ""), fromEnv: null };
}

const pinOf = (seed: JsonObject): string => pinSource(seed).pin;

/** 원본이 알림을 보낼 웹훅. 두 사이트 공통 웹훅 → 환경변수 → 씨앗 설정. */
function webhookOf(seed: JsonObject, s: SiteSettings, common: CommonSettings): { url: string; info: WebhookInfo } {
  const tail = (url: string) => url.slice(-6);
  if (common.webhook) return { url: common.webhook, info: { source: "shared", tail: tail(common.webhook), from: "공통 웹훅" } };
  const env = String(process.env[WEBHOOK_ENV] || "").trim();
  if (env) return { url: env, info: { source: "seed", tail: tail(env), from: WEBHOOK_ENV } };
  const own = String(seed["discord_webhook_url"] || "").trim();
  if (own) return { url: own, info: { source: "seed", tail: tail(own), from: basename(s.seed) } };
  return { url: "", info: { source: "none", tail: "", from: "" } };
}

/** config.ts 의 int · flt — 숫자로 읽히면 그 값(int 는 소수점을 버린다), 아니면 기본값. */
const num = (v: unknown, dflt: number): number =>
  Number.isFinite(Number(v)) && v !== "" && v !== null && v !== undefined ? Number(v) : dflt;

/** 감시 간격(초). 태스크가 정했으면 그것 — 원본은 정수 초만 받아서 올림한다 (덜 두드리는 쪽). */
function intervalOf(seed: JsonObject, task?: TaskDef): number {
  if (task && task.checkIntervalMs !== null) return Math.max(Math.ceil(task.checkIntervalMs / 1000), 1);
  return Math.max(Math.trunc(num(seed["check_interval_seconds"], 30)), 1);
}

/**
 * 상품 하나를 이보다 촘촘히 보면 원본 watch.ts 가 요청률 거부선에 걸려 시작하지 않는다.
 * (태스크는 상품 하나다: 60 / 간격 > 거부선 이면 거절.)
 */
const MIN_INTERVAL_SECONDS = Math.ceil(60 / NAVER_RATE.hard);

/** 씨앗 설정의 간격·재시도. 원본 config.ts 의 parseConfig · parseBuy 와 같은 규칙이다. */
function timingOf(seed: JsonObject): TimingDefaults {
  const buy = objectAt(seed, "buy");
  const maxBuys = Math.max(Math.trunc(num(buy["max_buys_per_run"], 1)), 1);
  return {
    checkIntervalMs: intervalOf(seed) * 1000,
    minIntervalMs: MIN_INTERVAL_SECONDS * 1000,
    wholeSeconds: true,
    maxRetries: Math.max(Math.trunc(num(buy["max_attempts"], 2)), 1) - 1,
    retryDelayMs: num(buy["retry_delay_seconds"], 2) * 1000,
    // 원본은 max_buys_per_run 만큼 사면 감시를 끝낸다. stop_after_success 는 "다 샀다" 고 적어 다시 안 사게 한다.
    stopOnSuccess: buy["stop_after_success"] !== false && maxBuys <= 1,
    maxBuys,
    retryScope: "구매 시도(주문서 열기)가 실패했을 때 — 재고 조회가 막히면 원본이 알아서 물러났다 다시 봅니다",
    rateWarnPerMin: NAVER_RATE.warn,
    drop: null, // 네이버 원본에는 --drop 이 없다
  };
}

/** 태스크의 간격·재시도를 원본 설정 칸으로. 맨 위 칸과 "buy" 칸으로 나뉜다. */
export interface NaverTimingFields {
  top: { check_interval_seconds?: number };
  buy: { max_attempts?: number; retry_delay_seconds?: number; stop_after_success?: boolean; max_buys_per_run?: number };
}

function timingFields(task: TaskDef, seed: JsonObject): NaverTimingFields {
  const out: NaverTimingFields = { top: {}, buy: {} };
  if (task.checkIntervalMs !== null) out.top.check_interval_seconds = intervalOf(seed, task);
  if (task.maxRetries !== null) out.buy.max_attempts = task.maxRetries + 1;
  if (task.retryDelayMs !== null) out.buy.retry_delay_seconds = task.retryDelayMs / 1000;
  if (task.stopOnSuccess === true) Object.assign(out.buy, { stop_after_success: true, max_buys_per_run: 1 });
  if (task.stopOnSuccess === false) Object.assign(out.buy, { stop_after_success: false, max_buys_per_run: Math.max(2, task.maxBuys) });
  return out;
}

/**
 * 모니터가 원본 설정에 적는 칸. 맨 위 칸과 "buy" 칸으로 나뉜다. 원본이 읽어 옮기는 칸인지는
 * src/legacy/contract.ts 가 본다.
 *
 * 모니터는 --watch --dry-run 으로 돈다. 발견은 buy.targets 의 구매 판단(옵션 재고·상한가·재입고 순간)이 가르고,
 * dry-run 도 "샀을 것" 을 산 것으로 세어 max_buys_per_run 에 닿으면 끝나고 시도한 상품은 cooldown_minutes 동안
 * 쉰다 — 발견한 뒤에도 계속 보려면 풀어 둔다.
 */
export interface NaverMonitorFields {
  top: { products: string[]; categories: string[]; check_interval_seconds: number; discord_webhook_url: string };
  buy: {
    targets: { url: string; ea: number; option: string; max_price: number; label: string }[];
    buy_on_restock_only: boolean;
    max_buys_per_run: number;
    stop_after_success: boolean;
    cooldown_minutes: number;
    pg_password: string;
  };
}

/** 모니터 홈에 원본 설정(smartstore_config.json)을 쓴다. → 쓴 파일 */
function writeMonitorConfig(def: MonitorDef, home: string, s: SiteSettings): string {
  mkdirSync(home, { recursive: true });
  const seed = readJson(s.seed) ?? {};
  const url = def.productUrl.trim();
  const fields: NaverMonitorFields = {
    // 감시 대상은 이 상품 하나. 카테고리(신상품) 감시는 모니터 몫이 아니라 뺀다. 간격은 원본이 정수 초로만 받는다.
    top: {
      products: [url], categories: [],
      check_interval_seconds: Math.max(Math.ceil(def.checkIntervalMs / 1000), MIN_INTERVAL_SECONDS),
      discord_webhook_url: "",
    },
    buy: {
      targets: [{ url, ea: def.ea || 1, option: def.option, max_price: def.maxPrice || 0, label: def.name }],
      buy_on_restock_only: def.restockOnly,
      max_buys_per_run: MONITOR_MAX_BUYS,
      stop_after_success: false,
      cooldown_minutes: 0,
      pg_password: "",
    },
  };
  const path = join(home, CONFIG);
  writeJsonAtomic(path, { ...seed, ...fields.top, buy: { ...objectAt(seed, "buy"), ...fields.buy } });
  return path;
}

/** buy.order_action. 모르는 값이면 원본처럼 덜 가는 쪽(open)으로 물러선다. */
function actionOf(seed: JsonObject): Exclude<OrderAction, ""> {
  const raw = String(objectAt(seed, "buy")["order_action"] ?? "submit").toLowerCase();
  return NAVER_ACTIONS.find((a) => a === raw) ?? "open";
}

/**
 * 비밀번호 뒤 마지막 확인 화면에서 원본이 차례로 누르는 것 (buy.finish_steps). 원본의 기본값과
 * 같다. 이 칸이 원본에 있는지는 src/legacy/contract.ts 가 본다.
 */
export const NAVER_FINISH_DEFAULT = ["결제내용에 동의", "결제"];

function finishStepsOf(seed: JsonObject): string[] {
  const raw = objectAt(seed, "buy")["finish_steps"];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : NAVER_FINISH_DEFAULT;
}

/** 간편결제 비밀번호를 넣으면 원본이 어디까지 가나. */
function pinEffectOf(seed: JsonObject): string {
  const steps = finishStepsOf(seed);
  return `결제하기 → 간편결제 비밀번호${steps.length ? ` → 마지막 확인(${steps.join(" → ")})` : ""}까지 누릅니다 — 사람 손 없이 결제됩니다`;
}

/** "어디까지" 마다 원본이 실제로 어디서 멈추나 (비밀번호가 있을 때 / 없을 때). 원본 order.ts 의 arrivalLine 과 같은 말이다. */
function actionHints(seed: JsonObject, hasPin: boolean): Partial<Record<OrderAction, string>> {
  const steps = finishStepsOf(seed);
  const finish = steps.length ? ` → 마지막 확인(${steps.join(" → ")})` : "";
  const hints: Partial<Record<OrderAction, string>> = {
    open: "주문서까지만 갑니다 — 결제는 사람이 누릅니다",
    submit: hasPin
      ? `결제하기 → 간편결제 비밀번호${finish}까지 누릅니다 — 사람 손 없이 결제됩니다`
      : "결제하기까지 누르고 인증 화면에서 멈춥니다 — 비밀번호는 사람이 넣습니다" +
        (steps.length ? `. 넣고 나면 마지막 확인(${steps.join(" → ")})은 원본이 눌러 줍니다` : ""),
  };
  const dflt = actionOf(seed);
  hints[""] = `씨앗 설정(${dflt}) — ${hints[dflt]}`;
  return hints;
}

export const naver: SiteAdapter = {
  id: "naver",
  // 원본은 첫 Ctrl+C 에 감시를 끊고, 구매 창이 열려 있으면 사람이 닫을 때까지 기다린다.
  // Playwright 브라우저는 프로세스와 같이 죽으므로 여기서 죽이면 결제하던 창이 닫힌다.
  stopGraceMs: null,

  rate: {
    perMin(task, s) {
      // 지금 구매·재고만은 한 번 보고 끝난다. 계속 두드리는 것은 감시 모드뿐이다.
      if (task.mode === "buy" || task.mode === "status") return 0;
      return 60 / intervalOf(readJson(s.seed) ?? {}, task);
    },
    // writeMonitorConfig 가 적는 간격과 같은 셈 (정수 초로 올림, 2초 바닥).
    monitorPerMin: (def) => 60 / Math.max(Math.ceil(def.checkIntervalMs / 1000), MIN_INTERVAL_SECONDS),
    ...NAVER_RATE,
  },

  defaults(aio) {
    const root = resolve(aio, "..", "naver", "ts");
    return { root, seed: join(resolve(root, ".."), CONFIG) };
  },

  info(s, common) {
    const entry = entryOf(s);
    const seed = readJson(s.seed) ?? {};
    const webhook = webhookOf(seed, s, common);
    const pin = pinOf(seed);
    const steps = finishStepsOf(seed);
    const problems: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];
    if (!existsSync(entry)) problems.push(`원본이 없습니다 (${entry}).`);
    if (!hasTsx(s)) problems.push("tsx 가 없습니다 — naver/ts 에서 npm install 이 필요합니다 ('설치' 를 누르세요).");
    // 로그인 세션은 태스크마다 고른 프로필에 있다 — 없으면 TaskManager 가 그 태스크를 띄우지 않는다.
    if (!webhook.url) warnings.push("디스코드 웹훅이 없습니다 — 지켜보기·한 번만은 원본이 거절합니다 (드라이런·재고만·지금 구매는 됩니다).");
    if (!existsSync(s.seed)) notes.push("씨앗 설정이 없어 원본 기본값으로 돕니다.");
    notes.push(`씨앗 감시 간격 ${intervalOf(seed)}초 — 네이버 태스크를 같이 돌리면 요청이 더해집니다 (권장 ${NAVER_RATE.warn}회/분, 거부 ${NAVER_RATE.hard}회/분).`);
    if (pin) notes.push("원본 설정에 콘솔용 간편결제 비밀번호가 있습니다 — 원본을 직접 돌릴 때만 씁니다 (태스크는 프로필의 결제 비밀번호).");
    if (steps.length) {
      notes.push(`비밀번호 뒤 마지막 확인(${steps.join(" → ")})은 원본이 누릅니다 — 사람이 누르게 하려면 씨앗 설정의 buy.finish_steps 를 [] 로.`);
    }
    return {
      site: "naver", entry, entryExists: existsSync(entry), seed: s.seed, seedExists: existsSync(s.seed),
      pin: { digits: pin.length, fromEnv: pinSource(seed).fromEnv, effect: pinEffectOf(seed) },
      problems, warnings, notes, actionHints: actionHints(seed, false), actionHintsWithPin: actionHints(seed, true),
      defaultAction: actionOf(seed), timing: timingOf(seed), webhook: webhook.info,
      prepare: hasTsx(s) ? null : "설치 (npm install)",
    };
  },

  webhookUrl: (s, common) => webhookOf(readJson(s.seed) ?? {}, s, common).url,

  launch(task: TaskDef, home, s, common, profileDir, pin) {
    // 원본은 조회도 로그인한 브라우저로 한다 (Node fetch 는 429). 세션 없이는 어느 모드도 못 돈다.
    if (!profileDir) throw new Error("네이버 태스크는 로그인 프로필이 있어야 합니다.");
    mkdirSync(home, { recursive: true });
    const config = join(home, CONFIG);
    const state = join(home, STATE);

    // 씨앗을 베끼고 **감시 대상과 살 대상을 이 태스크의 상품 하나로** 바꾼다. 카테고리 감시는
    // 태스크 몫이 아니라 뺀다. 비밀번호는 비워 둔다 (환경변수로 간다).
    // 스토어 검색이면 상품·살 대상을 비우고 searches 에 그 검색 하나를 적는다 — 원본이 걸린 상품을 살 대상으로 넣는다
    // (원본 search.ts). 씨앗의 searches 는 늘 뺀다 (태스크는 제 것 하나만).
    const seed = readJson(s.seed) ?? {};
    const url = task.url.trim();
    const search = isNaverSearch(url);
    const timing = timingFields(task, seed);
    const one = { ea: task.ea || 1, option: task.option, max_price: task.max_price || 0 };
    const cfg = {
      ...seed,
      ...timing.top,
      ...(common.webhook ? { discord_webhook_url: common.webhook } : {}),
      products: search ? [] : [url],
      categories: [],
      searches: search ? [{ url, ...one } satisfies NaverSearchEntry] : [],
      buy: {
        ...objectAt(seed, "buy"),
        ...timing.buy,
        pg_password: "",
        targets: search ? [] : [{ url, ...one, label: task.label }],
      },
    };
    writeFileSync(config, JSON.stringify(cfg, null, 2) + "\n", "utf-8");

    const files = ["--config", config, "--state", state];
    let args: string[];
    switch (task.mode) {
      case "watch": args = ["--watch", ...files]; break;
      case "once": args = ["--once", ...files]; break;
      // 원본의 --dry-run 은 혼자 쓰면 조회만 한다. 롯데 판처럼 "감시하되 사지 않는다" 가 되게 --watch 를 붙인다.
      case "dry-run": args = ["--watch", "--dry-run", ...files]; break;
      case "status": args = [...files]; break; // 옵션 없이 부르면 설정의 상품을 한 번 조회하고 끝난다
      case "buy": args = ["--buy", url, ...files]; break;
      case "drop": throw new Error("네이버 원본에는 드랍 모드(--drop)가 없습니다 — 모드를 지켜보기로 바꾸세요.");
    }
    if (task.action) args.push("--action", task.action);

    const base = baseOf(s);
    return {
      entry: entryOf(s),
      tsxFrom: s.root,
      args,
      // 공통 웹훅은 환경변수로도 넘긴다 — 원본이 환경변수를 설정 파일보다 먼저 본다.
      // 비밀번호는 프로필 것, 없으면 빈 값 — 원본은 환경변수를 설정보다 먼저 보고, 태스크 설정의 buy.pg_password 는 비었다.
      env: { [PIN_ENV]: pin, ...(common.webhook ? { [WEBHOOK_ENV]: common.webhook } : {}) },
      redirects: [
        [join(base, LOG), join(home, LOG)],
        [join(base, PG_DUMP), join(home, PG_DUMP)],
        sessionRedirect(s, profileDir),
      ],
    };
  },

  // 원본 watch.ts 는 확인할 때마다 상품마다 "이름 — 품절 (재고 0)" 을 찍는다. 단계는 order.ts 의 말들
  // ("…창에서 직접 해주세요/넣어주세요", "구매 창 N개가 열려 있습니다", "⭐ 결제 완료", "⭐ 마지막 확인까지 눌렀습니다").
  // 원본 watch.ts 가 확인마다 찍는 "포켓몬 카드 게임 MEGA 확장팩 「인페르노X」 — 판매중지 (재고 0개)" (모니터 로그에서
  // 본 그대로 — 앞에 시각·[INFO] 가 붙는 판도 받는다). 이름에 " — " 가 들어 있어도 마지막 것 앞까지가 이름이다.
  // 네이버는 바깥에서 따로 읽지 않는다 — 요청률 합을 세는 사이트라 이름 하나 때문에 두드리지 않는다.
  productNameLine: /^(?:\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[INFO\] )?(.+?) — [^—]+ \(재고 [^)]*\)$/,
  progress: {
    // 스토어 검색 태스크는 상품 줄이 없다 — 원본 search.ts 가 바퀴마다 찍는 검색 줄로 센다.
    round: / — .+ \(재고 [^)]*\)$|검색 — \d+개 중 /,
    buying: /구매 가능, 구매하기를 누릅니다/,
    checkout: /직접 (?:해|넣어)주세요|구매 창 \d+개가 열려 있습니다|간편결제 비밀번호까지 넣었습니다/,
    paid: /⭐ (?:결제 완료|마지막 확인까지 눌렀습니다)/,
  },

  writeMonitorConfig,

  monitorLaunch(def, home, s, profileDir) {
    // 원본은 조회도 로그인한 브라우저로 한다 (Node fetch 는 429). 세션 없이는 감시도 못 한다.
    if (!profileDir) throw new Error("네이버 모니터는 로그인 프로필이 있어야 합니다.");
    const config = writeMonitorConfig(def, home, s);
    const base = baseOf(s);
    return {
      entry: entryOf(s),
      tsxFrom: s.root,
      // --watch --dry-run: 감시하되 디스코드로 안 보내고(웹훅이 없어도 된다) 상태 파일도 안 쓰고, buy.targets 의 구매
      // 판단을 통과하면 "[dry-run] 여기서 구매하기를 눌렀을 것입니다" 만 찍는다.
      args: ["--watch", "--dry-run", "--config", config, "--state", join(home, STATE)],
      // 비밀번호·웹훅 환경변수는 비운다 — 사용자 환경변수가 새어 들지 않게 (dry-run 이라 쓰지도 않는다).
      env: { [PIN_ENV]: "", [WEBHOOK_ENV]: "" },
      redirects: [
        [join(base, LOG), join(home, LOG)],
        [join(base, PG_DUMP), join(home, PG_DUMP)],
        sessionRedirect(s, profileDir),
      ],
    };
  },

  // 원본 order.ts 의 doBuy 가 dry-run 일 때만 찍는 줄 · watch.ts 가 확인마다 찍는 "이름 — 품절 (재고 0)".
  monitorSignal: {
    found: /\[dry-run\] 여기서 구매하기를 눌렀을 것입니다 — (\S+)/,
    stock: / — (\S+ \(재고 [^)]*\))$/,
  },

  resetState(home) {
    // 원본 --reset 과 같이 산 기록(_buy)만 지운다. 나머지는 재입고를 알아보는 기준선이다.
    const path = join(home, STATE);
    const state = readJson(path);
    if (!state) return;
    delete state["_buy"];
    writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
  },

  prepare(s) {
    return hasTsx(s) ? null : { label: "설치", cmd: "npm", args: ["install"], cwd: s.root };
  },

  session: {
    loginUrl: LOGIN_URL,
    store: sessionIn,
    check: { url: LOGIN_CHECK_URL, detection: { type: "cookie", value: "NID_AUT · NID_SES" } },
    has: (dir) => hasSession(sessionIn(dir)),
    expiry(dir) {
      // 신분은 NID_AUT 가 진다 (원본 cmdWhoami 가 만료를 적는 쿠키). 0 이하면 브라우저를 닫을 때까지다.
      const aut = sessionCookies(sessionIn(dir)).find((c) => c.name === "NID_AUT");
      const at = Number(aut?.expires);
      return Number.isFinite(at) && at > 0 ? new Date(at * 1000).toISOString() : null;
    },
    whoami: (s, dir) => ({ entry: entryOf(s), tsxFrom: s.root, args: ["--whoami"], env: {}, redirects: [sessionRedirect(s, dir)] }),
    adopt(s, dir) {
      const legacy = join(baseOf(s), SESSION);
      if (!hasSession(legacy)) return false;
      mkdirSync(dir, { recursive: true });
      copyFileSync(legacy, sessionIn(dir));
      return true;
    },
    judge(code, out) {
      if (code === 0 && out.includes("세션이 살아 있습니다")) return { status: "logged_in", note: "원본이 확인했습니다" };
      if (out.includes("로그인 세션이 없습니다") || out.includes("쿠키가 없습니다")) {
        return { status: "logged_out", note: "로그인 세션이 없습니다" };
      }
      if (out.includes("세션이 끊겼습니다")) return { status: "expired", note: "세션 파일은 있지만 로그인이 끊겼습니다" };
      return { status: "error", note: lastLine(out) || `원본이 ${code} 로 끝났습니다` };
    },
    // 원본 fetcher.ts 의 LoginRequired 문구들.
    deadLine: /로그인 세션이 없습니다|세션이 만료됐습니다|세션 파일을 읽지 못했습니다|다시 로그인하세요/,
    pin: {
      read: (s) => pinSource(readJson(s.seed) ?? {}),
      // 원본 --pin <숫자> · --pin clear: 설정 파일의 buy.pg_password 만 고쳐 쓴다 (다른 칸은 그대로 — config.ts editBuy).
      save: (s, digits) => ({
        entry: entryOf(s), tsxFrom: s.root, args: ["--pin", digits, "--config", s.seed], env: {}, redirects: [],
      }),
      clear: (s) => ({
        kind: "legacy",
        launch: { entry: entryOf(s), tsxFrom: s.root, args: ["--pin", "clear", "--config", s.seed], env: {}, redirects: [] },
      }),
      effect: (s) => pinEffectOf(readJson(s.seed) ?? {}),
    },
    // 원본 --login: Playwright 창을 띄워 사람이 로그인하면 NID_AUT·NID_SES 를 보고 세션 파일에 적는다 (5분).
    // 적는 자리(storageState 의 path)를 워커가 프로필 폴더로 돌린다. 원본은 원래 자리에 적었다고 말한다.
    login: {
      kind: "legacy",
      launch: (s, dir) => ({ entry: entryOf(s), tsxFrom: s.root, args: ["--login"], env: {}, redirects: [sessionRedirect(s, dir)] }),
    },
  },
};
