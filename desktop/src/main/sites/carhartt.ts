/**
 * 칼하트윕 코리아(carhartt-wip.co.kr) 어댑터.
 *
 * 원본은 집(aio/node)의 `src/carhartt/` 이다 — 롯데·KREAM 과 같은 자리, 같은 빌드(`npm run build`).
 *
 * 다른 사이트와 다른 점
 *   · **설정 파일이 거의 없다.** 원본은 무엇을 볼지·살지를 명령줄로 받는다 — 결제 비밀번호만 `carhartt_config.json` 에 둔다 (콘솔용).
 *   · 감시·담기·주문 생성이 전부 공개 API 다. 재고는 로그인 없이 사이즈마다 **수량**까지 보인다. 앞단(CloudFront)이
 *     약 5초 캐싱해서, 원본은 사이즈 조회에 쿼리를 붙여 캐시를 건너뛴다 — 그래서 0.5초까지 내려도 그만큼 빨라진다.
 *   · 구매 태스크는 **켤 때 크롬을 미리 띄워** 상품 페이지에 세워 둔다 (로그인 토큰 없이). 주문이 잡히면 그 탭에
 *     토큰을 심고 주문서를 연다. 주문까지 못 가고 끝나거나 멈추면 그 탭을 닫는다.
 *   · 로그인이 쿠키가 아니라 **토큰**이다 (프로필 폴더의 carhartt-session.json). 원본이 15분짜리 토큰을 스스로 갱신한다.
 *   · 구매는 상품 페이지의 "구매하기" 가 부르는 API 를 그대로 부른다 (담기 → 주문 생성). 결제는 하지 않는다 —
 *     주문서(/order)를 크롬으로 열고, "어디까지" 가 submit 이면 결제하기를 누른 뒤 **토스 브랜드페이 비밀번호 자판**까지
 *     누른다 (연결 창: connect.tosspayments.com). 비밀번호가 없으면 결제하기까지만 누르고 창을 사람에게 넘긴다.
 *   · 대기열이 없다. 몰리면 서버가 429·307 로 쳐내고, 원본이 한동안 거듭 누른다.
 *   · 발매 전 상품(availableFrom)은 원본이 발매 시각까지 기다렸다가 누른다 — 드랍 모드가 따로 없다.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CommonSettings, MonitorDef, ProductSizes, SiteInfo, SiteSettings, TaskDef, WebhookInfo } from "../../shared/types.js";
import {
  PAGE_UA, readJson,
  type Launch, type MonitorSignal, type PrepareCommand, type ProgressSignal, type SessionSpec, type SiteAdapter,
} from "./adapter.js";

const ORIGIN = "https://www.carhartt-wip.co.kr";
/** 원본 api.ts 의 API — 상품 이름을 읽을 때만 여기서 직접 부른다. */
const API = "https://msa.carhartt-wip.co.kr/v2";
/** 원본 config.ts 의 SESSION_PATH — 프로필 폴더 안의 로그인 토큰. */
const SESSION = "carhartt-session.json";
const DEFAULT_INTERVAL_MS = 5000;
/** 원본 index.ts 의 MIN_INTERVAL (0.5초). 분당 120회 — rate.hard 와 같다. 원본이 앞단 캐시를 건너뛰니 촘촘할수록 빨리 안다. */
const MIN_INTERVAL_MS = 500;

const entryOf = (s: SiteSettings) => join(s.root, "dist", "carhartt", "index.js");

const tailOf = (url: string): string => (url ? url.slice(-6) : "");

/** 상품 주소·번호 → 번호. 원본 api.ts 의 productIdOf 와 같은 규칙. */
function productId(raw: string): string {
  const text = raw.trim();
  return /^\d+$/.test(text) ? text : /\/products\/(\d+)/.exec(text)?.[1] ?? text;
}

const productUrl = (raw: string): string => `${ORIGIN}/products/${productId(raw)}`;

/** 웹훅은 공통 설정 것만 쓴다 — 원본은 알림을 보내지 않고, 씨앗 설정도 없다. */
function webhookOf(common: CommonSettings): { url: string; info: WebhookInfo } {
  const shared = (common.webhook || "").trim();
  if (shared) return { url: shared, info: { source: "shared", tail: tailOf(shared), from: "공통 설정" } };
  return { url: "", info: { source: "none", tail: "", from: "" } };
}

const intervalSeconds = (ms: number | null): string => String(Math.max(MIN_INTERVAL_MS, ms ?? DEFAULT_INTERVAL_MS) / 1000);

/** 대상 한 줄 → 원본 인자 (--buy <번호> --ea … --size … --max-price …). 옵션 칸은 사이즈다 — "270,275" 처럼 여럿도 된다. */
function targetArgs(url: string, option: string, ea: number, maxPrice: number): string[] {
  return [
    "--buy", productId(url),
    "--ea", String(Math.max(1, ea || 1)),
    ...(option.trim() ? ["--size", option.trim()] : []),
    ...(maxPrice > 0 ? ["--max-price", String(maxPrice)] : []),
  ];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 공개 API 를 한 번 부르고 payload 를 돌려준다 (원본 api.ts 의 call 과 같은 봉투 — {code, payload, message}). */
async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${API}/${path}?sourceSite=CARHARTT`, {
    headers: { "User-Agent": PAGE_UA, Accept: "application/json", "X-Store": "CARHARTT" },
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 429 || (res.status >= 300 && res.status < 400)) throw new Error("접속이 몰려 서버가 받지 않습니다 — 잠시 뒤 다시 해 보세요.");
  const body = (await res.json().catch(() => null)) as { code?: string; payload?: unknown; message?: string | null } | null;
  if (!res.ok || body?.code !== "SUCCESS") throw new Error(body?.message || `조회 실패 (${res.status})`);
  return body.payload;
}

/** "이름 · 색" (원본 LINES.product 와 같은 글자). */
function nameOf(product: unknown): string {
  const p = (product ?? {}) as Record<string, unknown>;
  const name = typeof p["productName"] === "string" ? p["productName"].trim() : "";
  const color = typeof p["colorName"] === "string" ? p["colorName"].trim() : "";
  return [name, color].filter(Boolean).join(" · ");
}

const PIN_EFFECT = (digits: number): string => digits
  ? "결제하기를 누른 뒤 토스 간편결제(브랜드페이) 비밀번호 자판 6자리까지 누릅니다 — 자판을 못 읽거나 안 먹히면 더 누르지 않고 창을 사람에게 넘깁니다. 토스가 그 뒤 확인 단계를 두면 그 창에 남깁니다."
  : "결제하기까지만 누르고 비밀번호 창을 띄워 사람이 넣습니다 (콘솔용·프로필 비밀번호를 넣으면 자판까지 누릅니다).";

/** 설정 파일의 콘솔용 비밀번호 (없으면 ""). */
const configPin = (s: SiteSettings): string => String((readJson(s.seed) ?? {})["pg_password"] ?? "").replace(/\D/g, "");

/** 매니저가 태스크를 띄울 때 넘기는 환경변수 — 파일보다 먼저다 (빈 값도 "있음" 이다). */
const envPinValue = (): string | undefined => process.env["CARHARTT_PG_PASSWORD"];
const envPin = (): string => String(envPinValue() ?? "").replace(/\D/g, "");
/** 콘솔용·환경변수 순서로 지금 쓰이는 비밀번호. */
const knownPin = (s: SiteSettings): string => (envPinValue() !== undefined ? envPin() : configPin(s));

export const carhartt: SiteAdapter = {
  id: "carhartt",

  defaults(aio) {
    const root = join(aio, "node");
    // 결제 비밀번호만 두는 파일 — 원본이 대상·간격은 명령줄로 받는다.
    return { root, seed: join(root, "carhartt_config.json") };
  },

  info(s, common) {
    const entry = entryOf(s);
    const webhook = webhookOf(common);
    const pin = knownPin(s);
    const fromEnv = envPinValue() !== undefined ? "CARHARTT_PG_PASSWORD" : null;
    const problems: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];

    if (!existsSync(entry)) problems.push(`원본 빌드가 없습니다 (${entry}) — '원본 빌드' 를 누르세요.`);
    if (!webhook.url) warnings.push("디스코드 웹훅이 없습니다 — 모니터의 재고 알림은 못 보냅니다 (감시와 구매는 됩니다).");
    notes.push("설정 파일에는 결제 비밀번호만 둡니다 — 원본은 대상·간격을 명령줄로 받습니다 (태스크·모니터 폼의 값이 그대로 갑니다).");
    notes.push("재고는 로그인 없이 공개 API 로 봅니다 — 사이즈마다 남은 수량까지 보입니다. 앞단 캐시(약 5초)를 건너뛰어 원본을 직접 봅니다 (최소 0.5초, 1초 안쪽은 요청률 경고).");
    notes.push("구매 태스크는 켤 때 크롬을 미리 띄워 상품 페이지에 세워 둡니다 — 주문이 잡히면 그 창에서 바로 주문서를 엽니다. 주문 없이 끝나거나 멈추면 그 창을 닫습니다. 모니터·드라이런·재고만은 띄우지 않습니다.");
    notes.push("구매는 담기 → 주문 생성까지 하고, 주문서를 크롬으로 엽니다. '어디까지' 가 주문서까지면 거기서 멈추고, 결제 단계까지면 결제하기를 눌러 토스 간편결제 비밀번호 자판까지 누릅니다.");
    notes.push("결제 수단은 로그인한 계정의 간편결제(토스 브랜드페이)여야 합니다 — 등록된 카드가 없거나 다른 수단을 골라 두면 주문서에서 멈춥니다.");
    notes.push("옵션 칸에는 사이즈를 적습니다 (270,275 처럼 여럿이면 앞에서부터 재고 있는 첫 것). 사이즈가 하나뿐인 상품은 비워 둡니다.");
    notes.push("발매 전 상품은 발매 시각까지 기다렸다가 누릅니다 — PC 시계가 맞아야 합니다.");
    notes.push("대기열이 없는 사이트입니다. 몰려서 서버가 쳐내면(429·307) 1분 동안 거듭 누릅니다.");

    return {
      site: "carhartt",
      entry,
      entryExists: existsSync(entry),
      seed: s.seed,
      seedExists: existsSync(s.seed),
      pin: { digits: pin.length, fromEnv, effect: PIN_EFFECT(pin.length) },
      problems,
      warnings,
      notes,
      actionHints: {
        open: "주문서까지 (결제는 사람이)",
        submit: "결제하기까지 — 비밀번호는 창에서 사람이",
      },
      actionHintsWithPin: {
        open: "주문서까지 (결제는 사람이)",
        submit: "결제하기·비밀번호까지 (프로필 비밀번호로 결제)",
      },
      defaultAction: "open",
      timing: {
        checkIntervalMs: DEFAULT_INTERVAL_MS,
        minIntervalMs: MIN_INTERVAL_MS,
        wholeSeconds: false,
        // 원본에 재시도 칸이 없다 — 지켜보기는 실패해도 다음 바퀴에 다시 한다.
        maxRetries: 0,
        retryDelayMs: 0,
        stopOnSuccess: true,
        maxBuys: 1,
        retryScope: "없음 (지켜보기는 다음 바퀴에 다시 합니다)",
        rateWarnPerMin: 60,
        drop: null,
      },
      webhook: webhook.info,
      prepare: "원본 빌드 (npm run build)",
    } satisfies SiteInfo;
  },

  webhookUrl(_s, common) {
    return webhookOf(common).url;
  },

  launch(task, home, s, _common, profileDir, pin) {
    mkdirSync(home, { recursive: true });
    const target = targetArgs(task.url, task.option, task.ea, task.max_price);
    const interval = ["--interval", intervalSeconds(task.checkIntervalMs)];

    let args: string[];
    switch (task.mode) {
      // 한 번만 — 발매 전이거나 품절이면 기다리지 않고 끝낸다.
      case "once": args = [...target, "--once"]; break;
      case "dry-run": args = [...target, "--watch", "--dry-run", ...interval]; break;
      // 재고만 — 한 번 조회하고 끝 (로그인 없이).
      case "status": args = [productId(task.url)]; break;
      // 지금 구매 — 품절이면 끝내지만, 발매 전이면 발매 시각까지 기다렸다가 누른다.
      case "buy": args = target; break;
      default: args = [...target, "--watch", ...interval];
    }
    // 결제 단계까지 — 재고만(status)에는 살 것이 없으니 붙이지 않는다.
    if (task.action === "submit" && task.mode !== "status") args.push("--action", "submit");

    return {
      entry: entryOf(s),
      tsxFrom: null,
      args,
      env: {
        // 로그·주문서·결제창용 크롬 프로필은 태스크 홈에, 로그인 토큰은 프로필 폴더에 — 원본이 갱신한 토큰을 그 파일에 다시 적는다.
        CARHARTT_HOME: home,
        ...(profileDir ? { CARHARTT_SESSION_FILE: join(profileDir, SESSION) } : {}),
        // 빈 값도 언제나 적는다 — 콘솔용 비밀번호가 태스크로 새어 들지 않게 (adapter.ts 의 launch 설명).
        CARHARTT_PG_PASSWORD: pin,
        AIO_TTY: "1",
      },
      redirects: [],
    } satisfies Launch;
  },

  resetState() {
    // 원본에 산 기록(상태 파일)이 없다.
  },

  writeMonitorConfig(_def, home) {
    // 원본에 설정 파일이 없다 — 대상은 monitorLaunch 가 인자로 넘긴다. 홈만 만들어 둔다.
    mkdirSync(home, { recursive: true });
    return home;
  },

  monitorLaunch(def, home, s, profileDir) {
    mkdirSync(home, { recursive: true });
    return {
      entry: entryOf(s),
      tsxFrom: null,
      // --watch --dry-run: 사지 않고 계속 본다. 판매가 이어지는 동안은 한 번만 알리고, 품절이 되었다 풀리면 또 알린다.
      args: [...targetArgs(def.productUrl, def.option, def.ea, def.maxPrice), "--watch", "--dry-run", "--interval", intervalSeconds(def.checkIntervalMs)],
      env: {
        CARHARTT_HOME: home,
        // 감시는 로그인이 필요 없다. 프로필이 있으면 살아 있는지만 같이 본다 (구매 전환에 쓸 것이라).
        ...(profileDir ? { CARHARTT_SESSION_FILE: join(profileDir, SESSION) } : {}),
        // 감시는 사지 않는다 — 콘솔용 비밀번호가 새어 들지 않게 빈 값을 적는다.
        CARHARTT_PG_PASSWORD: "",
        AIO_TTY: "1",
      },
      redirects: [],
    } satisfies Launch;
  },

  // 원본 carhartt/lines.ts 의 줄들
  monitorSignal: {
    // LINES.foundDry
    found: /\[dry-run\] 여기서 구매하기를 눌렀을 것입니다 — (\S+)/,
    // LINES.stockIn ("재고 있음 — 이름 · 색 · OS 58개") · stockOut ("품절 — 이름 · 색 (OS 품절)") — 묶음은 사이즈·수량 쪽
    stock: /(?:재고 있음 — .* · |품절 — .*\()([^()]+?)\)?$/,
  } satisfies MonitorSignal,

  // 주문서 창은 따로 뜬 크롬이라 원본이 끝나도 남는다. 멈출 때 원본은 안 쓴 미리 띄운 탭만 닫고(2초 안) 끝난다.
  stopGraceMs: 5000,

  rate: {
    // 사이즈 재고 API 는 161B 다. 원본이 앞단 캐시를 건너뛰므로 한 번이 원본 한 번이다. 공개한 요청률 선은 없어 우리가 정한 안전선이다.
    perMin(task) {
      if (task.mode === "buy" || task.mode === "status" || task.mode === "once") return 0;
      return 60_000 / Math.max(MIN_INTERVAL_MS, task.checkIntervalMs ?? DEFAULT_INTERVAL_MS);
    },
    monitorPerMin: (def) => 60_000 / Math.max(MIN_INTERVAL_MS, def.checkIntervalMs),
    warn: 60,
    hard: 120,
  },

  prepare(s): PrepareCommand {
    return { label: "원본 빌드", cmd: "npm", args: ["run", "build"], cwd: s.root };
  },

  session: {
    loginUrl: `${ORIGIN}/auth/login`,
    store: (dir) => join(dir, SESSION),
    // 로그인하지 않았으면 사이트가 /auth/login?returnUrl=… 로 보낸다.
    check: { url: `${ORIGIN}/my-page`, detection: { type: "url", value: "/auth/login" } },
    has: (dir) => existsSync(join(dir, SESSION)),
    // 접근 토큰은 15분짜리지만 원본이 갱신한다. 갱신 토큰이 언제 죽는지는 물어봐야 안다.
    expiry: () => null,
    whoami(s, dir, scratch) {
      return {
        entry: entryOf(s),
        tsxFrom: null,
        args: ["--whoami"],
        // 살아 있으면 원본이 갱신한 토큰을 프로필의 파일에 다시 적는다.
        env: { CARHARTT_HOME: scratch, CARHARTT_SESSION_FILE: join(dir, SESSION) },
        redirects: [],
      } satisfies Launch;
    },
    adopt() {
      return false;
    },
    judge(code, out) {
      // 원본 lines.ts 의 loggedIn · noSession · loggedOut
      if (code === 0 && out.includes("로그인됨 — ")) return { status: "logged_in", note: "원본이 확인했습니다" };
      if (out.includes("저장된 로그인이 없습니다")) return { status: "logged_out", note: "저장된 토큰이 없습니다" };
      if (out.includes("로그인되어 있지 않습니다")) return { status: "expired", note: "토큰은 있지만 로그인이 끊겼습니다" };
      const last = out.trim().split("\n").pop() ?? "";
      return { status: "error", note: last || `원본이 ${code} 로 끝났습니다` };
    },
    // LINES.sessionDead · noSession · loggedOut
    deadLine: /로그인이 풀렸습니다 — |저장된 로그인이 없습니다|로그인되어 있지 않습니다/,
    pin: {
      read(s) {
        return { pin: knownPin(s), fromEnv: envPinValue() !== undefined ? "CARHARTT_PG_PASSWORD" : null };
      },
      // 원본 --pin 은 실행 옵션이 아니라 설정 파일에 적고 끝나는 명령이다. CARHARTT_HOME 을 원본 폴더로 주어
      // s.seed(carhartt_config.json)에 적는다 — 태스크가 쓰는 태스크 홈이 아니다.
      save(s, digits) {
        return {
          entry: entryOf(s), tsxFrom: null, args: ["--pin", digits],
          env: { CARHARTT_HOME: s.root }, redirects: [],
        } satisfies Launch;
      },
      clear(s) {
        return {
          kind: "legacy",
          launch: { entry: entryOf(s), tsxFrom: null, args: ["--pin", "clear"], env: { CARHARTT_HOME: s.root }, redirects: [] },
        };
      },
      effect: (s) => PIN_EFFECT(knownPin(s).length),
    },
    /**
     * 원본 --login: 프로필에 이메일·비밀번호가 있으면(자동 로그인) 화면 없이 API 로 로그인하고, 없으면 **진짜 크롬** 창을 띄워
     * 사람이 로그인하면 토큰을 읽어 온다. 어느 쪽이든 토큰을 프로필 폴더(CARHARTT_HOME)의 carhartt-session.json 에 적는다.
     * 크롬 프로필도 프로필 폴더에 남아 다시 로그인할 때 그대로 열린다.
     */
    login: {
      kind: "legacy",
      launch: (s, dir) => ({ entry: entryOf(s), tsxFrom: null, args: ["--login"], env: { CARHARTT_HOME: dir }, redirects: [] }),
    },
    // 원본 config.ts 의 credentialsOf — 있으면 --login 은 화면 없이 하고, 태스크는 토큰이 죽었을 때 다시 로그인한다.
    credentials: { emailEnv: "CARHARTT_LOGIN_EMAIL", passwordEnv: "CARHARTT_LOGIN_PASSWORD" },
  } satisfies SessionSpec,

  // 원본이 쓰는 상품 API 의 productName · colorName (원본 LINES.product 와 같은 글자).
  productName: async (url) => {
    const id = productId(url);
    if (!/^\d+$/.test(id)) return null;
    try {
      return nameOf(await apiGet(`products/${id}`)) || null;
    } catch {
      return null;
    }
  },

  // 원본 api.ts 의 fetchSnapshot 과 같은 두 주소 — 상품 정보와 사이즈마다 남은 수량. 사이즈는 사이트가 주는 차례(sort)대로.
  productSizes: async (url) => {
    const id = productId(url);
    if (!/^\d+$/.test(id)) throw new Error("상품번호를 못 찾았습니다.");
    const [product, sizes] = await Promise.all([apiGet(`products/${id}`), apiGet(`products/${id}/sizes`)]);
    const p = (product ?? {}) as Record<string, unknown>;
    const from = typeof p["availableFrom"] === "string" ? p["availableFrom"].trim() : "";
    // "2026-11-12T11:00" — 시간대가 안 붙어 온다. 한국 몰이라 한국 시간이다 (원본과 같은 규칙).
    const at = from ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(from) ? from : `${from}+09:00`) : null;
    return {
      name: nameOf(product),
      price: num(p["currentPrice"]),
      availableFrom: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
      perUser: num(p["availableStockUser"]),
      sizes: (Array.isArray(sizes) ? (sizes as Record<string, unknown>[]) : [])
        .slice()
        .sort((a, b) => num(a["sort"]) - num(b["sort"]))
        .map((s) => {
          const stock = typeof s["availableStock"] === "number" ? s["availableStock"] : null;
          return {
            name: String(s["sizeName"] ?? s["sizeCode"] ?? "").trim(),
            stock,
            inStock: typeof s["inStock"] === "boolean" ? s["inStock"] : (stock ?? 0) > 0,
          };
        })
        .filter((s) => s.name),
    } satisfies ProductSizes;
  },
  // LINES.product — "상품 — 이름 · 색 · 63,000원" (가격 앞까지가 이름)
  productNameLine: /상품 — (.+) · [^·]+$/,

  progress: {
    // LINES.round
    round: /확인 (\d+)회 · 상품 (\d+)개 · (\d+)초 걸림/,
    // util.ts 의 wait — "감시 중 · … · 다음 확인 N초"
    countdown: /다음 확인 (\d+)초/,
    // LINES.buying
    buying: /구매 시작 — /,
    // LINES.checkout
    checkout: /주문서 — /,
    // 결제는 사람이 한다 — 원본은 이 줄을 찍지 않는다 (다른 사이트와 같은 모양만 맞춰 둔다).
    paid: /결제 완료 — 주문 (.+)$/,
  } satisfies ProgressSignal,
};
