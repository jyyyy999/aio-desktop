/**
 * KREAM(kream.co.kr) **브랜드배송(공식 브랜드 샵)** 어댑터.
 *
 * 원본은 집(aio/node)의 `src/kream/` 이다 — 롯데·반다이남코·슈프림과 같은 자리, 같은 빌드(`npm run build`).
 * 태스크마다 다른 것은 **홈(KREAM_HOME)** 하나뿐이다: 설정·상태·로그·크롬 프로필·실패 화면이 전부 그 안에 있다.
 *
 * 다른 사이트와 다른 점
 *   · 브랜드배송 상품은 정가에 재고를 판다 (리셀 입찰이 아니다). "일시 품절" → "구매하기" 로 바뀌는 순간을 본다.
 *   · 감시는 **로그인된 크롬**이 상품 페이지를 다시 읽어 한다 — 재고가 보이면 같은 창에서 곧바로 구매하기를 누른다.
 *     그래서 모니터·드라이런도 크롬을 띄운다 (로그인은 없어도 된다).
 *   · 대기열(wait.kream.co.kr)이 걸리면 원본이 줄을 서서 기다린다.
 *   · 로그인도 진짜 크롬으로 한다 (원본 --login). 매니저의 로그인 창(Electron)에는 KREAM 이 페이지 스크립트를 내주지 않는다.
 *   · 결제 비밀번호는 KREAM 간편결제 6자리. 프로필에 있으면 원본이 자판을 읽어 차례로 누르고(pin.ts), 자판을 못 읽거나
 *     눌러도 안 먹히면 **더 누르지 않고** 창을 사람에게 넘긴다 (틀린 비밀번호를 쌓으면 결제가 잠긴다).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommonSettings, MonitorDef, SiteInfo, SiteSettings, TaskDef, WebhookInfo } from "../../shared/types.js";
import {
  fetchText, htmlTitle, MONITOR_MAX_BUYS, objectAt, readJson, writeJsonAtomic,
  type Launch, type MonitorSignal, type PrepareCommand, type ProgressSignal, type SessionSpec, type SiteAdapter,
} from "./adapter.js";

const ORIGIN = "https://kream.co.kr";
const CONFIG = "kream_config.json";
const STATE = "kream_state.json";
const COOKIE = "kream-cookie.txt";
/** 원본 site.ts 의 loginAlive 와 같은 물음 — 로그인하지 않았으면 서버가 /login 으로 보낸다. */
export const KREAM_LOGIN_CHECK = "/my";

const entryOf = (s: SiteSettings) => join(s.root, "dist", "kream", "index.js");

const cookieIn = (dir: string): string => {
  try {
    return readFileSync(join(dir, COOKIE), "utf-8").trim();
  } catch {
    return "";
  }
};

const tailOf = (url: string): string => (url ? url.slice(-6) : "");

/** 상품 주소 → 원본이 받는 모양 (https://kream.co.kr/products/<번호>). 번호만 적어도 받는다. */
function productUrl(raw: string): string {
  const text = raw.trim();
  const id = /^\d{3,}$/.test(text) ? text : /kream\.co\.kr\/products\/(\d+)/.exec(text)?.[1];
  return id ? `${ORIGIN}/products/${id}` : text;
}

function webhookOf(s: SiteSettings, common: CommonSettings): { url: string; info: WebhookInfo } {
  const shared = (common.webhook || "").trim();
  if (shared) return { url: shared, info: { source: "shared", tail: tailOf(shared), from: "공통 설정" } };
  const seed = readJson(s.seed) ?? {};
  const own = typeof seed["discord_webhook_url"] === "string" ? String(seed["discord_webhook_url"]).trim() : "";
  if (own) return { url: own, info: { source: "seed", tail: tailOf(own), from: "씨앗 설정" } };
  return { url: "", info: { source: "none", tail: "", from: "" } };
}

/**
 * 태스크 폼의 간격·재시도 → 원본 설정 칸. `src/legacy/contract.ts` 가 이 이름들이 원본 설정(kream/config.ts)에 있는지 맞대 본다.
 */
export interface KreamTimingFields {
  check_interval_ms: number;
  max_retries: number;
  retry_delay_ms: number;
}

/** 태스크 폼의 한 줄 → 원본 설정의 대상 한 줄 (`Target`). */
export interface KreamTaskTarget {
  url: string;
  option: string;
  ea: number;
  max_price: number;
  label: string;
}

/** 모니터가 홈에 적는 칸 (writeMonitorConfig). */
export interface KreamMonitorFields {
  check_interval_ms: number;
  buy_on_restock_only: boolean;
  targets: KreamTaskTarget[];
}

function timingFields(task: TaskDef): Partial<KreamTimingFields> {
  const out: Partial<KreamTimingFields> = {};
  if (task.checkIntervalMs !== null) out.check_interval_ms = task.checkIntervalMs;
  if (task.maxRetries !== null) out.max_retries = task.maxRetries;
  if (task.retryDelayMs !== null) out.retry_delay_ms = task.retryDelayMs;
  return out;
}

const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function writeMonitorConfig(def: MonitorDef, home: string, s: SiteSettings): string {
  mkdirSync(home, { recursive: true });
  const seed = readJson(s.seed) ?? {};
  const fields: KreamMonitorFields = {
    check_interval_ms: def.checkIntervalMs,
    // 판매가 이어지는 동안 원본은 같은 상품을 한 번만 알린다 — 다시 품절이 되었다 풀리면 또 알린다.
    buy_on_restock_only: false,
    targets: [{ url: productUrl(def.productUrl), option: def.option, ea: Math.max(1, def.ea || 1), max_price: def.maxPrice || 0, label: def.name }],
  };
  const path = join(home, CONFIG);
  writeJsonAtomic(path, {
    ...seed,
    ...fields,
    buy: { ...objectAt(seed, "buy"), enabled: false, max_buys_per_run: MONITOR_MAX_BUYS, stop_after_success: false },
    // 비밀(쿠키·비밀번호)·웹훅은 적지 않는다 — 알림은 매니저가 보낸다.
    cookie: "",
    pg_password: "",
    discord_webhook_url: "",
  });
  return path;
}

/**
 * 프로필에 결제 비밀번호가 있을 때 / 없을 때 원본이 하는 일 (buy.ts 의 7단계 · pin.ts).
 * KREAM 의 비밀번호 화면은 2026-10-25 에 아직 못 봤다 — 자판 글자를 읽어 누르고, 못 읽으면 아무것도 누르지 않는다.
 */
function pinEffect(digits: number): string {
  return digits
    ? "결제하기·구매조건 동의를 누른 뒤 결제 비밀번호 자판까지 눌러 결제를 끝냅니다 (KREAM 간편결제 6자리) — 자판을 못 읽으면 누르지 않고 창을 사람에게 넘깁니다."
    : "결제하기·구매조건 동의까지 누르고, 비밀번호 창이 뜨면 창을 띄워 사람이 넣습니다 (프로필에 비밀번호를 넣으면 자판까지 누릅니다).";
}

export const kream: SiteAdapter = {
  id: "kream",

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
    const pin = String(seed["pg_password"] ?? "").replace(/\D/g, "");

    if (!existsSync(entry)) problems.push(`원본 빌드가 없습니다 (${entry}) — '원본 빌드' 를 누르세요.`);
    if (!existsSync(s.seed)) notes.push("씨앗 설정이 없어 원본 기본값으로 돕니다 (결제 수단은 KREAM 이 골라 둔 것).");
    if (!webhook.url) warnings.push("디스코드 웹훅이 없습니다 — 재고·결제 알림은 못 보냅니다 (감시와 구매는 됩니다).");
    if (pin) notes.push("씨앗 설정에 콘솔용 결제 비밀번호가 있습니다 — 원본을 직접 돌릴 때만 씁니다 (태스크는 프로필의 결제 비밀번호).");
    const method = String(objectAt(seed, "buy")["payment_method"] ?? "").trim();
    notes.push(method ? `결제 수단: ${method} (씨앗 설정 buy.payment_method)` : "결제 수단은 KREAM 이 골라 둔 것(마지막에 쓴 것)으로 갑니다 — 바꾸려면 씨앗 설정 buy.payment_method.");
    notes.push("감시는 로그인된 크롬이 상품 페이지를 다시 읽어 합니다 — 모니터·드라이런도 크롬을 띄웁니다.");
    notes.push("대기열(wait.kream.co.kr)이 걸리면 줄을 서서 기다립니다.");
    notes.push(pin
      ? "결제 비밀번호는 프로필의 것을 씁니다 — 원본이 자판을 읽어 차례로 누릅니다. 자판을 못 읽거나 안 먹히면 누르지 않고 그 화면을 kream-shots/ 에 담아 사람에게 넘깁니다."
      : "프로필에 결제 비밀번호를 넣으면 원본이 자판까지 눌러 결제를 끝냅니다 — 없으면 비밀번호 창에서 사람이 넣습니다.");
    notes.push("로그인한 뒤의 화면(옵션 창·주문서·자판)은 글자로 찾아 누릅니다 — 못 찾으면 kream-shots/ 에 화면을 담고 창을 넘깁니다.");

    return {
      site: "kream",
      entry,
      entryExists: existsSync(entry),
      seed: s.seed,
      seedExists: existsSync(s.seed),
      pin: { digits: pin.length, fromEnv: null, effect: pinEffect(pin.length) },
      problems,
      warnings,
      notes,
      actionHints: { open: "주문서까지 (결제는 사람이)", submit: "결제하기·동의까지 — 비밀번호는 창에서 사람이" },
      actionHintsWithPin: { open: "주문서까지 (결제는 사람이)", submit: "결제하기·동의·비밀번호까지 (프로필 비밀번호로 결제)" },
      defaultAction: seed["order_action"] === "open" ? "open" : "submit",
      timing: {
        checkIntervalMs: num(seed["check_interval_ms"], 5000),
        minIntervalMs: num(seed["min_interval_ms"], 3000),
        wholeSeconds: false,
        maxRetries: num(seed["max_retries"], 3),
        retryDelayMs: num(seed["retry_delay_ms"], 3000),
        stopOnSuccess: objectAt(seed, "buy")["stop_after_success"] !== false,
        maxBuys: num(objectAt(seed, "buy")["max_buys_per_run"], 1),
        retryScope: "상품 페이지 읽기",
        rateWarnPerMin: 20,
        drop: null,
      },
      webhook: webhook.info,
      prepare: "원본 빌드 (npm run build)",
    } satisfies SiteInfo;
  },

  webhookUrl(s, common) {
    return webhookOf(s, common).url;
  },

  launch(task, home, s, common, profileDir, pin) {
    mkdirSync(home, { recursive: true });
    const seed = readJson(s.seed) ?? {};
    const webhook = webhookOf(s, common).url;
    const target: KreamTaskTarget = {
      url: productUrl(task.url),
      option: task.option.trim(),
      ea: Math.max(1, task.ea || 1),
      max_price: task.max_price || 0,
      label: task.label,
    };
    // 씨앗을 베끼고 대상과 이 태스크의 칸만 바꾼다. 쿠키·비밀번호는 적지 않는다 (환경변수로 간다).
    writeFileSync(join(home, CONFIG), `${JSON.stringify({
      ...seed,
      ...timingFields(task),
      cookie: "",
      pg_password: "",
      discord_webhook_url: webhook,
      targets: [target],
      buy: {
        ...objectAt(seed, "buy"),
        enabled: true,
        max_buys_per_run: Math.max(1, task.maxBuys || 1),
        stop_after_success: task.stopOnSuccess ?? true,
      },
    }, null, 2)}\n`, "utf-8");

    let args: string[];
    switch (task.mode) {
      case "once": args = ["--once"]; break;
      case "dry-run": args = ["--watch", "--dry-run"]; break;
      case "status": args = ["--status"]; break;
      case "buy": args = ["--buy", target.url, "--ea", String(target.ea), ...(target.option ? ["--option", target.option] : [])]; break;
      default: args = ["--watch"];
    }
    if (task.action) args.push("--action", task.action);

    return {
      entry: entryOf(s),
      tsxFrom: null,
      args,
      env: {
        KREAM_HOME: home,
        KREAM_COOKIE: profileDir ? cookieIn(profileDir) : "",
        // 태스크가 다시 로그인하면 새 쿠키를 프로필에 적는다 — 다음에 띄우는 태스크도 새 쿠키로 뜬다 (원본 auth.ts).
        ...(profileDir ? { KREAM_COOKIE_FILE: join(profileDir, COOKIE) } : {}),
        // 빈 값도 언제나 적는다 — 콘솔용 비밀번호가 태스크로 새어 들지 않게 (adapter.ts 의 launch 설명).
        KREAM_PG_PASSWORD: pin,
        ...(webhook ? { KREAM_WEBHOOK: webhook } : {}),
        AIO_TTY: "1",
      },
      redirects: [],
    } satisfies Launch;
  },

  resetState(home) {
    const path = join(home, STATE);
    const state = readJson(path);
    if (state) {
      state["_buy"] = {};
      writeJsonAtomic(path, state);
    }
    // 결제 비밀번호까지 넣고 완료를 못 본 표시도 지운다 — 원본 --reset 과 같은 자리.
    try {
      rmSync(join(home, "kream-pending.json"), { force: true });
    } catch {
      /* 없으면 그만 */
    }
  },

  writeMonitorConfig,

  monitorLaunch(def, home, s, profileDir) {
    writeMonitorConfig(def, home, s);
    return {
      entry: entryOf(s),
      tsxFrom: null,
      args: ["--watch", "--dry-run"],
      env: {
        KREAM_HOME: home,
        KREAM_COOKIE: profileDir ? cookieIn(profileDir) : "",
        KREAM_PG_PASSWORD: "",
        KREAM_WEBHOOK: "",
        AIO_TTY: "1",
      },
      redirects: [],
    } satisfies Launch;
  },

  // 원본 kream/lines.ts 의 줄들
  monitorSignal: {
    // LINES.foundDry
    found: /\[dry-run\] 여기서 구매하기를 눌렀을 것입니다 — (\S+)/,
    // LINES.stockIn / stockOut
    stock: /(?:재고 있음|품절) — (.+?)(?: ·| \(|$)/,
  } satisfies MonitorSignal,

  // 사람이 비밀번호를 넣거나 주문서에서 결제하는 동안 창을 붙들고 있다. 죽이면 하던 창이 닫힌다.
  stopGraceMs: null,

  rate: {
    // KREAM 은 공개한 요청률 선이 없다. 상품 페이지가 무거워(약 800KB) 우리가 정한 안전선이다 — 간격 5초면 분당 12회.
    perMin(task, s) {
      if (task.mode === "buy" || task.mode === "status") return 0;
      const seed = readJson(s.seed) ?? {};
      const ms = task.checkIntervalMs ?? num(seed["check_interval_ms"], 5000);
      return 60_000 / Math.max(num(seed["min_interval_ms"], 3000), ms);
    },
    monitorPerMin: (def) => 60_000 / Math.max(3000, def.checkIntervalMs),
    warn: 20,
    hard: 40,
  },

  prepare(s): PrepareCommand {
    return { label: "원본 빌드", cmd: "npm", args: ["run", "build"], cwd: s.root };
  },

  session: {
    loginUrl: `${ORIGIN}/login`,
    store: (dir) => join(dir, COOKIE),
    check: { url: `${ORIGIN}${KREAM_LOGIN_CHECK}`, detection: { type: "url", value: "/login" } },
    has: (dir) => !!cookieIn(dir),
    expiry: () => null,
    whoami(s, dir, scratch) {
      return {
        entry: entryOf(s),
        tsxFrom: null,
        args: ["--whoami"],
        // 살아 있으면 원본이 지금 쿠키를 프로필에 다시 적는다 (토큰이 갱신됐으면 새 것으로).
        env: { KREAM_HOME: scratch, KREAM_COOKIE: cookieIn(dir), KREAM_COOKIE_FILE: join(dir, COOKIE) },
        redirects: [],
      } satisfies Launch;
    },
    adopt() {
      return false;
    },
    judge(code, out) {
      if (code === 0 && out.includes("로그인됨 — ")) return { status: "logged_in", note: "원본이 확인했습니다" };
      if (out.includes("세션 쿠키가 없습니다")) return { status: "logged_out", note: "저장된 쿠키가 없습니다" };
      if (out.includes("로그인되어 있지 않습니다")) return { status: "expired", note: "쿠키는 있지만 로그인이 끊겼습니다" };
      const last = out.trim().split("\n").pop() ?? "";
      return { status: "error", note: last || `원본이 ${code} 로 끝났습니다` };
    },
    // 원본 kream/lines.ts 의 LINES.sessionDead · cmdWhoami
    deadLine: /로그인이 풀렸습니다 — |세션 쿠키가 없습니다|로그인되어 있지 않습니다/,
    pin: {
      read(s) {
        const seed = readJson(s.seed) ?? {};
        return { pin: String(seed["pg_password"] ?? "").replace(/\D/g, ""), fromEnv: null };
      },
      save(s, digits) {
        // 원본 --pin 은 실행 옵션이 아니라 씨앗 설정에 적고 끝나는 명령이다.
        return {
          entry: entryOf(s), tsxFrom: null, args: ["--pin", digits],
          env: { KREAM_HOME: join(s.seed, "..") }, redirects: [],
        } satisfies Launch;
      },
      clear(s) {
        return {
          kind: "legacy",
          launch: { entry: entryOf(s), tsxFrom: null, args: ["--pin", "clear"], env: { KREAM_HOME: join(s.seed, "..") }, redirects: [] },
        };
      },
      effect: (s) => pinEffect(String((readJson(s.seed) ?? {})["pg_password"] ?? "").replace(/\D/g, "").length),
    },
    /**
     * 원본 --login: **진짜 크롬** 창을 띄워 사람이 로그인하면 쿠키를 프로필 폴더(KREAM_HOME)의 kream-cookie.txt 에 적는다.
     * 매니저의 로그인 창(Electron)은 쓰지 않는다 — KREAM 이 그 창에는 페이지 스크립트(/_nuxt/…)를 내주지 않아 로그인 버튼이
     * 안 눌린다 (2026-10-25). 크롬 프로필은 프로필 폴더에 남아 다시 로그인할 때 그대로 열린다.
     */
    login: {
      kind: "legacy",
      launch: (s, dir) => ({ entry: entryOf(s), tsxFrom: null, args: ["--login"], env: { KREAM_HOME: dir }, redirects: [] }),
    },
    // 원본 config.ts 의 credentialsOf — 있으면 --login 은 화면 밖에서 넣고, 태스크는 로그인이 풀리면 다시 로그인한다.
    credentials: { emailEnv: "KREAM_LOGIN_EMAIL", passwordEnv: "KREAM_LOGIN_PASSWORD" },
  } satisfies SessionSpec,

  // 상품 페이지의 <title> ("… 정품 안심 거래 | KREAM") — 원본 site.ts 와 같은 자리.
  productName: async (url) => {
    const title = htmlTitle(await fetchText(productUrl(url)));
    return title ? title.replace(/\s*(정품 안심 거래\s*)?\|\s*KREAM\s*$/, "").trim() || null : null;
  },
  // LINES.product
  productNameLine: /상품 — (.+?) · /,

  progress: {
    // LINES.round
    round: /확인 (\d+)회 · 상품 (\d+)개 · (\d+)초 걸림/,
    // util.ts 의 wait — "감시 중 · 다음 확인 N초"
    countdown: /다음 확인 (\d+)초/,
    // LINES.queue — 묶음: 1 내 앞 인원
    queue: /대기열 내 앞 ([\d,]+)명/,
    // LINES.queueDone
    queueDone: /대기열을 통과했습니다/,
    // LINES.buying
    buying: /구매 시작 — /,
    // LINES.checkout
    checkout: /주문서 — /,
    // LINES.paid
    paid: /결제 완료 — 주문 (.+)$/,
  } satisfies ProgressSignal,

  /** 구매하기를 누른 뒤 원본이 산 기록(상태 파일)을 다시 쓸 때까지는 "구매 중" — 그 사이에 재시작하지 않는다. */
  busy: { start: /구매 시작 — /, settledBy: STATE },
};
