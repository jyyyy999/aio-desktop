/**
 * 슈프림(shop.supreme.com — Shopify) 어댑터.
 *
 * 원본은 집(aio/node)의 `src/supreme/` 이다 — 롯데·반다이남코와 같은 자리, 같은 빌드(`npm run build`).
 * 태스크마다 다른 것은 **홈(SUPREME_HOME)** 하나뿐이다: 설정·상태·로그·크롬 프로필이 전부 그 안에 있다.
 *
 * 다른 사이트와 다른 점
 *   · 로그인 없이도 살 수 있다 (게스트 체크아웃). 프로필을 골랐다면 그건 **사람 확인(Cloudflare)
 *     통과 쿠키(cf_clearance)** 를 물려주기 위한 것이다 — 로그인 계정이 아니다.
 *   · 결제 비밀번호(간편결제 PIN)가 없다. 결제는 카드 정보로 하고 카드사 인증(3DS)은 사람이 끝낸다.
 *   · **캡차(hCaptcha)는 사람이 푼다.** 원본이 캡차만 보이는 창을 띄우고 기다린다 — 대신 풀지 않는다.
 *     그래서 멈출 때 사람이 끝낼 때까지 기다린다 (stopGraceMs: null).
 *   · "어디까지" 는 없다(actions 가 비어 있다). 자동으로 어디까지 갈지는 설정의 `buy.click_pay` 가 정한다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommonSettings, MonitorDef, SiteInfo, SiteSettings, TaskDef, WebhookInfo } from "../../shared/types.js";
import { orderForLaunch } from "../supremeOrder.js";
import {
  fetchText, MONITOR_MAX_BUYS, objectAt, readJson, writeJsonAtomic, type JsonObject,
  type Launch, type MonitorSignal, type PrepareCommand, type ProgressSignal, type SessionSpec, type SiteAdapter,
} from "./adapter.js";

const ORIGIN = "https://shop.supreme.com";
const CONFIG = "supreme_config.json";
const STATE = "supreme_state.json";
const LOG = "supreme.log";
const COOKIE = "supreme-cookie.txt";
const COOKIE_ENV = "SUPREME_COOKIE";
const WEBHOOK_ENV = "SUPREME_WEBHOOK";

/** 원본 진입점 — 집의 다른 사이트와 같은 자리(dist/…)에 굽는다. */
const entryOf = (s: SiteSettings) => join(s.root, "dist", "supreme", "index.js");

/** 프로필 폴더의 쿠키 한 줄 (사람이 로그인 창에서 통과한 것). */
const cookieIn = (dir: string): string => {
  try {
    return readFileSync(join(dir, COOKIE), "utf-8").trim();
  } catch {
    return "";
  }
};

const tailOf = (url: string): string => (url ? url.slice(-6) : "");

/**
 * **키워드 사양** — 링크 없이 무엇을 살지 적는 방법. 원본(supreme/match.ts)과 같은 규칙이다.
 *
 *     +box +logo -jacket     box 와 logo 가 들어가고 jacket 은 아닌 것
 *     +"box logo"            띄어쓴 말은 따옴표로 묶는다
 *
 * 부호(+/-)가 하나도 없으면 키워드로 보지 않는다 — 주소를 잘못 적은 것과 구분해야 한다.
 * (원본의 match.ts 와 같은 규칙을 여기에도 적어 둔다 — 데스크톱은 원본 폴더를 들이지 않는다.)
 */
export function isKeywordSpec(spec: string): boolean {
  const text = String(spec || "").trim();
  if (!text || /^https?:\/\//i.test(text) || /shop\.supreme\.com/i.test(text)) return false;
  return /(^|\s)[+#-]\S/.test(text);
}

export function parseKeywordSpec(spec: string): { include: string[]; exclude: string[]; collections: string[] } {
  // 쉼표·가운뎃점·쌍반점도 구분자로 본다 ("+gore, +tex, +n-2b" 처럼 적는 사람이 많다).
  const spaced = String(spec || "").replace(/[,、;，]/g, " ");
  const tokens = spaced.match(/[+-]?"[^"]*"|[+-]?'[^']*'|[+-]?\S+/g) ?? [];
  const include: string[] = [];
  const exclude: string[] = [];
  const collections: string[] = [];
  for (const raw of tokens) {
    // "#jackets" — 그 컬렉션만 훑는다 (검색을 좁혀 빠르게).
    if (raw.startsWith("#")) {
      const name = raw.slice(1).replace(/[.,、;，]+$/g, "").trim();
      if (name) collections.push(name);
      continue;
    }
    const sign = raw.startsWith("+") || raw.startsWith("-") ? raw[0]! : "";
    let word = (sign ? raw.slice(1) : raw).trim();
    if (word.length > 1 && ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'")))) {
      word = word.slice(1, -1).trim();
    }
    word = word.replace(/[.,、;，]+$/g, "").trim();
    if (!word) continue;
    (sign === "-" ? exclude : include).push(word);
  }
  return { include, exclude, collections };
}

/**
 * 알림이 가는 웹훅 (공통 → 씨앗 설정). 다른 사이트와 같은 순서다.
 * 모니터의 발견 알림도 이 주소로 간다 — 원본은 dry-run 이라 스스로 보내지 않는다.
 */
function webhookOf(s: SiteSettings, common: CommonSettings): { url: string; info: WebhookInfo } {
  const shared = (common.webhook || "").trim();
  if (shared) return { url: shared, info: { source: "shared", tail: tailOf(shared), from: "공통 설정" } };
  const seed = readJson(s.seed) ?? {};
  const own = typeof seed["discord_webhook_url"] === "string" ? String(seed["discord_webhook_url"]).trim() : "";
  if (own) return { url: own, info: { source: "seed", tail: tailOf(own), from: "씨앗 설정" } };
  return { url: "", info: { source: "none", tail: "", from: "" } };
}

/**
 * 데스크톱 태스크 폼의 간격·재시도 → 원본 설정 칸.
 * `src/legacy/contract.ts` 가 이 이름들이 원본 설정(supreme/config.ts)에 있는지 맞대 본다.
 */
export interface SupremeTimingFields {
  check_interval_ms: number | null;
  max_retries: number | null;
  retry_delay_ms: number | null;
  monitor_duration_ms: number | null;
}

/** 태스크 폼의 한 줄 → 원본 설정의 대상 한 줄 (`Target`). */
export interface SupremeTaskTarget {
  url: string;
  option: string;
  ea: number;
  max_price: number;
  label: string;
}

/** 모니터가 홈에 적는 칸 (writeMonitorConfig). */
export interface SupremeMonitorFields {
  check_interval_ms: number;
  targets: SupremeTaskTarget[];
  buy: {
    enabled: boolean;
    click_pay: boolean;
    max_buys_per_run: number;
    stop_after_success: boolean;
  };
}

function timingFields(task: TaskDef): Partial<SupremeTimingFields> {
  const out: Partial<SupremeTimingFields> = {};
  if (task.checkIntervalMs !== null) out.check_interval_ms = task.checkIntervalMs;
  if (task.maxRetries !== null) out.max_retries = task.maxRetries;
  if (task.retryDelayMs !== null) out.retry_delay_ms = task.retryDelayMs;
  if (task.monitorDurationMs > 0) out.monitor_duration_ms = task.monitorDurationMs;
  return out;
}

function targetOf(task: TaskDef): SupremeTaskTarget {
  return {
    url: task.url.trim(),
    option: task.option,
    ea: Math.max(1, task.ea || 1),
    max_price: task.max_price || 0,
    label: task.label,
  };
}

/** 모니터 홈에 원본 설정을 쓴다 — 대상은 이 상품 하나(또는 키워드 사양), 발견한 뒤에도 멈추지 않게. */
function writeMonitorConfig(def: MonitorDef, home: string, s: SiteSettings): string {
  mkdirSync(home, { recursive: true });
  const seed = readJson(s.seed) ?? {};
  const path = join(home, CONFIG);
  const base = {
    ...seed,
    check_interval_ms: def.checkIntervalMs,
    buy: {
      ...objectAt(seed, "buy"),
      enabled: true,
      // 모니터는 사지 않는다 — 발견만 알린다.
      click_pay: false,
      max_buys_per_run: MONITOR_MAX_BUYS,
      stop_after_success: false,
    },
    // 비밀(쿠키)·웹훅은 적지 않는다 — 알림은 매니저가 보낸다.
    cookie: "",
    discord_webhook_url: "",
  };
  if (isKeywordSpec(def.productUrl)) {
    // 키워드 모니터 — 조건에 걸리는 상품이 나오면 알린다 (발견 줄이 그 상품 주소를 준다).
    const spec = parseKeywordSpec(def.productUrl);
    writeJsonAtomic(path, { ...base, include_keywords: spec.include, exclude_keywords: spec.exclude, targets: [] });
    return path;
  }
  const target: SupremeTaskTarget = {
    url: def.productUrl.trim(),
    option: def.option,
    ea: Math.max(1, def.ea || 1),
    max_price: def.maxPrice || 0,
    label: def.name,
  };
  const fields: SupremeMonitorFields = {
    check_interval_ms: def.checkIntervalMs,
    targets: [target],
    buy: {
      enabled: true,
      // 모니터는 사지 않는다 — 발견만 알린다.
      click_pay: false,
      max_buys_per_run: MONITOR_MAX_BUYS,
      stop_after_success: false,
    },
  };
  writeJsonAtomic(path, {
    ...seed,
    ...fields,
    buy: { ...objectAt(seed, "buy"), ...fields.buy },
    cookie: "",
    discord_webhook_url: "",
  });
  return path;
}

/** 사람이 로그인(사람 확인 통과)했나 — 원본과 같은 물음으로. Shopify 는 /account 로 판정한다. */
async function loginAlive(cookie: string): Promise<boolean> {
  try {
    const res = await fetch(`${ORIGIN}/account`, {
      headers: { Cookie: cookie, accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    // 로그인하지 않았으면 /account/login 으로 보낸다 (3xx). 200 이면 로그인된 상태다.
    if (res.status >= 300 && res.status < 400) return false;
    if (res.status !== 200) return false;
    const body = await res.text();
    return !/customer\[password\]|account\/login/.test(body);
  } catch {
    return false;
  }
}

export const supreme: SiteAdapter = {
  id: "supreme",

  /**
   * 원본은 집(aio/node) 안에 있다 — 롯데·반다이남코와 같은 프로젝트, 같은 빌드.
   * 씨앗 설정은 그 옆에 둔다.
   */
  defaults(aio) {
    const root = join(aio, "node");
    return { root, seed: join(root, CONFIG) };
  },

  info(s, common) {
    const entry = entryOf(s);
    const seed = readJson(s.seed) ?? {};
    const webhook = webhookOf(s, common);
    const problems: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];

    if (!existsSync(entry)) problems.push(`원본 빌드가 없습니다 (${entry}) — '원본 빌드' 를 누르세요.`);
    if (!existsSync(s.seed)) notes.push("씨앗 설정이 없어 원본 기본값으로 돕니다 (자동구매·배송정보가 비어 있습니다).");
    if (!webhook.url) warnings.push("디스코드 웹훅이 없습니다 — 발견·결제 알림은 못 보냅니다 (감시와 구매는 됩니다).");
    if (!orderForLaunch().order.email) {
      warnings.push("슈프림 주문서 프로필이 비어 있습니다 — 왼쪽 '슈프림 주문서' 에서 배송 정보를 채워야 담습니다.");
    }

    const buy = objectAt(seed, "buy");
    const profile = objectAt(seed, "profile");
    if (!String(profile["email"] ?? "").trim()) {
      warnings.push("씨앗 설정의 profile.email 이 비어 있습니다 — 자동 체크아웃이 배송 정보에서 멈춥니다.");
    }
    if (buy["click_pay"] === false) notes.push("buy.click_pay 가 false 입니다 — 결제 버튼 앞에서 멈추고 사람이 누릅니다.");
    else notes.push("결제 버튼까지 자동으로 누릅니다 (카드사 인증 3DS 는 사람이 끝냅니다).");

    notes.push("캡차(hCaptcha)는 사람이 풉니다 — 원본이 캡차만 보이는 창을 띄우고 기다립니다.");
    notes.push("로그인 없이도 삽니다(게스트 체크아웃). 프로필을 고르면 사람 확인(Cloudflare) 통과 쿠키를 물려줍니다.");
    notes.push("감시·구매 중에 설정을 고쳐도 다시 시작해야 반영됩니다 (liveFields 가 비어 있습니다).");

    return {
      site: "supreme",
      entry,
      entryExists: existsSync(entry),
      seed: s.seed,
      seedExists: existsSync(s.seed),
      // 슈프림에는 간편결제 비밀번호가 없다 (카드 정보로 결제하고 3DS 는 사람이 끝낸다).
      pin: { digits: 0, fromEnv: null, effect: "해당 없음 — 결제는 카드 정보로 하고 카드사 인증은 사람이 끝냅니다." },
      problems,
      warnings,
      notes,
      actionHints: { open: "장바구니에 담기까지", agree: "—", submit: "결제 버튼까지 (완전 자동)" },
      actionHintsWithPin: { open: "장바구니에 담기까지", agree: "—", submit: "결제 버튼까지 (완전 자동)" },
      defaultAction: "submit",
      timing: {
        checkIntervalMs: 2500,
        minIntervalMs: 2500,
        wholeSeconds: false,
        maxRetries: 3,
        retryDelayMs: 5000,
        stopOnSuccess: true,
        maxBuys: 1,
        retryScope: "확인 실패 · 담기 실패",
        rateWarnPerMin: 60,
        drop: null,
      },
      webhook: webhook.info,
      prepare: "원본 빌드 (npm run build)",
    } satisfies SiteInfo;
  },

  webhookUrl(s, common) {
    return webhookOf(s, common).url;
  },

  launch(task, home, s, common, profileDir, _pin, _payProfileDir) {
    mkdirSync(home, { recursive: true });
    const seed = readJson(s.seed) ?? {};
    const webhook = webhookOf(s, common).url;
    const target = targetOf(task);

    // 씨앗을 베끼고 **대상과 이 태스크의 칸만** 바꾼다. 쿠키는 적지 않는다 (환경변수로 간다).
    //
    // 주문서 값은 대시보드의 **슈프림 주문서 프로필**(supreme-order.json)에서 온다 —
    // 비밀(카드·생년월일·PIN)은 여기에 적지 않고 환경변수로만 넘긴다.
    const { order, secrets } = orderForLaunch();
    const profileFields = {
      ...objectAt(seed, "profile"),
      email: order.email,
      first_name: order.first_name,
      last_name: order.last_name,
      address1: order.address1,
      address2: order.address2,
      city: order.city,
      state: order.province,
      zip: order.postal_code,
      country: order.country,
      phone: order.phone,
      // 주문창이 "배송지 = 카드 청구지" 로 못박혀 있다 (별도 청구지 칸이 없다).
      billing_same_as_shipping: true,
      /* 비밀 자리는 비워 둔다 — 실행할 때 환경변수로 들어간다 (원본 config.ts 의 secretsOf). */
      card_number: "",
      card_expiry: "",
      card_cvv: "",
      card_holder: "",
      date_of_birth: "",
      card_pin_first_two: "",
      save_shipping_information: order.save_shipping_information,
      agree_age14: order.agree_age14,
      agree_globale_tos: order.agree_globale_tos,
      agree_privacy: order.agree_privacy,
      agree_third_party: order.agree_third_party,
      agree_supreme_tos: order.agree_supreme_tos,
    };
    const cfg = {
      ...seed,
      ...timingFields(task),
      cookie: "",
      discord_webhook_url: webhook,
      profile: profileFields,
      targets: [target],
      buy: {
        ...objectAt(seed, "buy"),
        enabled: true,
        quantity: target.ea,
        // 태스크 폼에는 "어디까지" 가 없다 (sites.ts 의 actions 가 비어 있다). 씨앗 설정의
        // buy.click_pay 가 정한다 — 기본은 완전 자동.
        max_buys_per_run: Math.max(1, task.maxBuys || 1),
        stop_after_success: task.stopOnSuccess ?? true,
      },
    };
    writeFileSync(join(home, CONFIG), `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");

    let args: string[];
    if (isKeywordSpec(task.url)) {
      // **링크 없이 키워드로 사기** — 감시하다 걸리면 담아서 결제까지.
      // 설정에는 포함/제외 키워드만 넣고(대상 목록은 비운다), 인자로도 같은 사양을 넘긴다.
      const spec = parseKeywordSpec(task.url);
      // 옵션 칸은 "색 / 사이즈" 다 — 원본은 --size 로 통째 받아 가르지만, 설정의 size_priority 에는 사이즈만 넣는다.
      const size = String(task.option || "").trim();
      const sizeOnly = size.slice(size.lastIndexOf("/") + 1).trim();
      const keywordCfg = {
        ...cfg,
        include_keywords: spec.include,
        exclude_keywords: spec.exclude,
        // `#jackets` 로 좁혔으면 그 컬렉션만 훑는다 (전체 209개를 도는 것보다 훨씬 빠르다).
        ...(spec.collections.length ? { collections: spec.collections } : {}),
        targets: [],
        ...(sizeOnly
          ? {
              buy: {
                ...(cfg.buy as Record<string, unknown>),
                // 적은 사이즈만 — 씨앗의 우선순위를 뒤에 붙이면 그 사이즈가 없을 때 다른 사이즈를 산다.
                size_priority: [sizeOnly],
              },
            }
          : {}),
      };
      writeFileSync(join(home, CONFIG), `${JSON.stringify(keywordCfg, null, 2)}\n`, "utf-8");
      // **모드가 "지금 구매"·"한 번만" 이면 --once 를 붙인다** — 첫 바퀴부터 조건에 맞는 것을 담는다.
      // (--watch 만 주면 재입고·새 상품만 잡아서, 이미 목록에 있는 상품은 안 담긴다.)
      const immediate = task.mode === "buy" || task.mode === "once" || task.mode === "dry-run";
      args = ["--keys", task.url];
      if (task.mode === "status") args = ["--keys", task.url, "--status"];
      else if (immediate) args.push("--once");
      else args.push("--watch");
      if (task.mode === "dry-run") args.push("--dry-run");
      if (size) args.push("--size", size);
    } else {
      switch (task.mode) {
        case "watch": args = ["--watch"]; break;
        case "once": args = ["--once"]; break;
        // 원본의 --watch --dry-run 은 **계속 보되 사지 않는다** (모니터가 쓰는 모드).
        case "dry-run": args = ["--watch", "--dry-run"]; break;
        case "status": args = ["--status"]; break;
        case "buy": args = ["--buy", target.url, "--ea", String(target.ea)]; break;
        case "drop": {
          // **드랍** — 화면에서 정한 드랍 시각·미리 담기 분·바꿔 담을 상품을 그대로 넘긴다.
          // 미끼 상품은 씨앗 설정(설정 창의 슈프림 씨앗) drop.preload_url 에서 온다.
          const dropTime = String(task.dropSettings?.dropTime || "").trim();
          const lead = Math.max(0, Number(task.dropSettings?.preCheckMinutes ?? 2));
          const seedDrop = objectAt(seed, "drop");
          const preload = String(seedDrop["preload_url"] ?? "").trim();
          args = ["--drop"];
          if (dropTime) args.push("--drop-at", dropTime);
          if (preload) args.push("--preload", preload);
          args.push("--swap-to", task.url.trim());
          writeJsonAtomic(join(home, CONFIG), {
            ...cfg,
            drop: { ...seedDrop, drop_at: dropTime || seedDrop["drop_at"] || "", preload_lead_minutes: lead, preload_url: preload, swap_to_url: task.url.trim() },
          });
          break;
        }
      }
    }

    return {
      entry: entryOf(s),
      tsxFrom: null,
      args,
      env: {
        SUPREME_HOME: home,
        [COOKIE_ENV]: profileDir ? cookieIn(profileDir) : "",
        ...(webhook ? { [WEBHOOK_ENV]: webhook } : {}),
        /* 비밀은 파일에 적지 않고 여기로만 넘긴다 — 원본 config.ts 의 secretsOf 가 환경변수를 먼저 본다. */
        ...(secrets.card_number ? { SUPREME_CARD_NUMBER: secrets.card_number } : {}),
        ...(secrets.card_expiry ? { SUPREME_CARD_EXPIRY: secrets.card_expiry } : {}),
        ...(secrets.card_cvv ? { SUPREME_CARD_CVV: secrets.card_cvv } : {}),
        ...(secrets.card_holder ? { SUPREME_CARD_HOLDER: secrets.card_holder } : {}),
        ...(secrets.date_of_birth ? { SUPREME_DOB: secrets.date_of_birth } : {}),
        ...(secrets.card_pin_first_two ? { SUPREME_CARD_PIN2: secrets.card_pin_first_two } : {}),
        ...(secrets.personal_customs_code ? { SUPREME_CUSTOMS_CODE: secrets.personal_customs_code } : {}),
        // 제자리에서 고쳐 쓰는 줄("다음 확인 N초")을 원본이 찍는다 — 화면인 척해 준다.
        AIO_TTY: "1",
      },
      // 원본은 설정·상태·로그·크롬 프로필을 전부 SUPREME_HOME 안에서 찾는다. 돌릴 것이 없다.
      redirects: [],
    } satisfies Launch;
  },

  /** 산 기록만 지운다 (원본 --reset 과 같은 일). 나머지는 재입고를 알아보는 재료다. */
  resetState(home) {
    const path = join(home, STATE);
    const state = readJson(path);
    if (!state) return;
    delete state["_buy"];
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  },

  writeMonitorConfig,

  monitorLaunch(def, home, s, profileDir) {
    // 모니터 홈에 원본 설정을 쓴다 (대상 하나 · max_buys_per_run = 끝없이 · 사지 않음).
    writeMonitorConfig(def, home, s);
    return {
      entry: entryOf(s),
      tsxFrom: null,
      args: ["--watch", "--dry-run"],
      // 쿠키는 환경변수로만 (설정 파일에는 비운다). 웹훅은 비운다 — 알림은 매니저가 보낸다.
      env: {
        SUPREME_HOME: home,
        [COOKIE_ENV]: profileDir ? cookieIn(profileDir) : "",
        [WEBHOOK_ENV]: "",
        AIO_TTY: "1",
      },
      redirects: [],
    } satisfies Launch;
  },

  // 원본 watch.ts 의 줄들 (supreme/lines.ts 와 글자까지 같아야 한다).
  monitorSignal: {
    // LINES.foundDry — "…여기서 구매하기를 눌렀을 것입니다 — <상품 주소>"
    found: /\[dry-run\] 여기서 구매하기를 눌렀을 것입니다 — (\S+)/,
    // LINES.stockIn / stockOut
    stock: /(?:재고 있음|품절) — (.+?)(?: ·|$)/,
  } satisfies MonitorSignal,

  // 원본은 캡차·3DS 를 사람이 끝낼 때까지 창을 붙들고 있는다. 죽이면 결제하던 창이 같이 닫힌다.
  stopGraceMs: null,

  rate: {
    // Shopify 는 공개한 요청률 선이 없다. 여기 값은 우리가 정한 안전선이다 —
    // 간격 2.5초면 분당 24회라 warn(60) 아래다.
    perMin(task, s) {
      if (task.mode === "buy" || task.mode === "status") return 0;
      const seed = readJson(s.seed) ?? {};
      const ms = Number(seed["check_interval_ms"] ?? 2500);
      return 60_000 / Math.max(2500, Number.isFinite(ms) ? ms : 2500);
    },
    monitorPerMin: (def) => 60_000 / Math.max(2500, def.checkIntervalMs),
    warn: 60,
    hard: 120,
  },

  prepare(s): PrepareCommand {
    return { label: "원본 빌드", cmd: "npm", args: ["run", "build"], cwd: s.root };
  },

  session: {
    loginUrl: `${ORIGIN}/account/login`,
    // 로그인 창이 모은 쿠키를 프로필 폴더에 한 줄로 적는다. 태스크는 SUPREME_COOKIE 로 받는다.
    store: (dir) => join(dir, COOKIE),
    check: { url: `${ORIGIN}/account`, detection: { type: "url", value: "/account/login" } },
    has: (dir) => !!cookieIn(dir),
    // cf_clearance 는 만료를 알 수 없다 (Cloudflare 가 정한다). 물어봐서 안다.
    expiry: () => null,
    whoami(s, dir, scratch) {
      return {
        entry: entryOf(s),
        tsxFrom: null,
        args: ["--whoami"],
        // 원본은 켤 때 제 홈에 설정·로그를 만든다 — 빈 폴더를 홈으로 준다.
        env: { SUPREME_HOME: scratch, [COOKIE_ENV]: cookieIn(dir) },
        redirects: [],
      } satisfies Launch;
    },
    adopt() {
      // 옮겨 올 옛 로그인 파일이 없다.
      return false;
    },
    judge(code, out) {
      if (code === 0 && out.includes("로그인됨 — ")) return { status: "logged_in", note: "원본이 확인했습니다" };
      if (out.includes("세션 쿠키가 없습니다")) return { status: "logged_out", note: "저장된 쿠키가 없습니다" };
      if (out.includes("로그인되어 있지 않습니다")) return { status: "expired", note: "쿠키는 있지만 로그인이 끊겼습니다" };
      const last = out.trim().split("\n").pop() ?? "";
      return { status: "error", note: last || `원본이 ${code} 로 끝났습니다` };
    },
    // 원본 supreme/lines.ts 의 LINES.sessionDead
    deadLine: /로그인이 풀렸습니다 — |세션 쿠키가 없습니다|로그인되어 있지 않습니다/,
    pin: {
      // 슈프림은 간편결제 비밀번호를 쓰지 않는다.
      read: () => ({ pin: "", fromEnv: null }),
      save() {
        throw new Error("슈프림은 간편결제 비밀번호를 쓰지 않습니다 — 카드 정보는 씨앗 설정의 profile.card_* 에 있습니다.");
      },
      clear: () => ({ kind: "file", apply: () => undefined }),
      effect: () => "해당 없음 — 결제는 카드 정보로 하고 카드사 인증(3DS)은 사람이 끝냅니다.",
    },
    /**
     * 사람이 창에서 로그인/사람 확인을 통과하면 그 쿠키를 프로필 폴더에 적는다.
     *
     * isLoginPage 는 **캡차·비밀번호 화면을 로그인 페이지로 보지 않는다** — 그렇게 보면 창이
     * 사람의 통과를 영영 알아채지 못한다 (sessions.ts 의 ask 가 계속 건너뛴다).
     */
    login: {
      kind: "window",
      partition: (profileId) => `persist:login-supreme-${profileId}`,
      startUrl: `${ORIGIN}/account/login`,
      cookieUrl: `${ORIGIN}/`,
      isLoginPage: (url) => !/(^|\.)supreme\.com$/.test(hostOf(url)),
      alive: loginAlive,
      save(dir, cookie) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, COOKIE), `${cookie.trim()}\n`, "utf-8");
      },
    },
  } satisfies SessionSpec,

  // 원본 watch.ts · checkout.ts 의 줄들 (supreme/lines.ts).
  // 원본 site.ts 가 상품을 풀 때 쓰는 /products/<handle>.js 의 title. 키워드 태스크는 주소가 아니라 읽지 않는다.
  productName: async (url) => {
    const handle = /\/products\/([A-Za-z0-9_-]+)/.exec(url.trim())?.[1];
    if (!handle) return null;
    let origin = ORIGIN;
    try {
      origin = new URL(url.trim()).origin;
    } catch {
      // 주소가 아니면 기본 상점
    }
    const raw = JSON.parse(await fetchText(`${origin}/products/${handle}.js`)) as JsonObject;
    return String(raw["title"] ?? "").trim() || null;
  },
  progress: {
    // LINES.round — 회차를 여기서 센다
    round: /확인 (\d+)회 · 상품 (\d+)개 · (\d+)초 걸림/,
    // LINES.countdown — 제자리에서 고쳐 쓰는 줄
    countdown: /다음 확인 (\d+)초|드랍까지 (\d+)초|미끼 담기까지 (\d+)초/,
    // queue.ts 의 formatQueueLine — "대기열 내 앞 273명 · 줄 281명 · 예상 12초"
    //   묶음: 1 내 앞 인원 · 2 줄 전체(없을 수 있다) · 3 예상 남은 초(없을 수 있다)
    queue: /대기열 내 앞 ([\d,]+)명(?: · 줄 ([\d,]+)명)?(?: · 예상 (\d+)초)?/,
    queueDone: /대기열을 통과했습니다|주문창에 들어갔습니다/,
    // LINES.buying
    buying: /구매 시작 — |미끼를 담았습니다|바꿔 담았습니다/,
    // LINES.checkout
    checkout: /체크아웃 — |주문창 대기 중|큐를 태우러/,
    // LINES.paid
    paid: /결제 완료 — 주문 (.+)$/,
  } satisfies ProgressSignal,

  /**
   * 담기·결제가 시작되면 상태 파일이 다시 쓰인다 — 그때까지는 "구매 중" 이다.
   * 사람이 캡차를 풀거나 3DS 를 끝내는 동안 재시작하지 않게 한다.
   */
  busy: { start: /구매 시작 — |캡차 — 사람이 풀 차례입니다/, settledBy: STATE },
};

/** 주소에서 호스트만 (isLoginPage). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
