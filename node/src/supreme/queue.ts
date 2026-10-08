/**
 * 드랍 대기열(queue) — 슈프림은 드랍 때 `/checkout` 앞에 줄을 세운다.
 *
 * 봇들이 쓰는 방식(preload):
 *   1. 드랍 **전에** 아무 상품(미끼)을 담고 /checkout 으로 가서 **큐를 미리 태운다** → 주문창에 들어가 대기
 *   2. 드랍 시각이 되면 장바구니를 **원하는 상품으로 바꾸고** 결제한다
 * 이미 통과한 큐(체크아웃 세션)는 그대로 살아 있어서, 두 번째 진입은 줄을 서지 않는다.
 *
 * 여기서 하는 일
 *   · 지금 대기열 안인가 · 주문창이 떴나
 *   · 몇 번째인가 · 예상 몇 초인가 (여러 사이트 문구를 다 알아본다 — Suprem·Shopify·Queue-it)
 *   · 그걸 **집의 줄 모양**으로 찍는다. 데스크톱이 이 줄을 읽어 태스크 창에 "앞 273명 · 예상 12초"를 띄운다:
 *         대기열 내 앞 273명 · 줄 281명 · 예상 12초
 *     (어댑터의 progress.queue 정규식과 글자까지 같아야 한다 — src/main/sites/supreme.ts)
 */
import { log, sayOk, sayStar, tick } from "./log.js";
import { isCheckpointUrl } from "./checkpoint.js";

export interface QueueInfo {
  /** 대기열 페이지다 */
  inQueue: boolean;
  /** 주문창이 실제로 떴다 (대기열을 통과했다는 뜻) */
  formReady: boolean;
  ahead: number | null;
  total: number | null;
  /** 예상 남은 초 */
  eta: number | null;
  /** 대기열 토큰 쿠키 이름들 (있으면 자리를 잡고 있다) */
  cookies: string[];
  url: string;
  title: string;
  text: string;
}

/** 대기열 페이지라고 볼 문구들 (영·한·일) */
const QUEUE_MARKERS = [
  "in line", "you are in line", "you're in line", "waiting room", "queue",
  "estimated wait", "wait time", "people in front", "in front of you", "your position",
  "checkout is busy", "traffic", "hold your place", "do not refresh", "don't refresh",
  "대기", "차례", "잠시만 기다", "예상 대기", "앞에", "줄을 서",
  "順番", "待機",
];

/** 대기열 토큰 쿠키 후보 (Shopify 큐 · Queue-it · Global-e) */
const QUEUE_COOKIE_HINTS = ["queue", "queueit", "queue-it", "waiting", "checkout_queue", "sp_shop"];

/** 앞 인원 */
const AHEAD_PATTERNS: RegExp[] = [
  /(\d[\d,]*)\s*(?:people|users|customers|shoppers)\s*(?:are\s*)?(?:in\s*front|ahead)/i,
  /(?:people|users|customers|shoppers)\s*(?:in\s*front|ahead)\s*(?:of\s*you)?\s*[:#]?\s*(\d[\d,]*)/i,
  /(?:position|your\s+number|place\s+in\s+line)\s*[:#]?\s*(\d[\d,]*)/i,
  /앞에\s*(\d[\d,]*)\s*명/,
  /앞\s*(\d[\d,]*)\s*명/,
  /(\d[\d,]*)\s*명\s*(?:이\s*)?앞/,
  /대기\s*(?:순번|번호)\s*[:#]?\s*(\d[\d,]*)/,
];

/** 줄 전체 인원 */
const TOTAL_PATTERNS: RegExp[] = [
  /(?:total|out\s+of)\s*[:#]?\s*(\d[\d,]*)/i,
  /(\d[\d,]*)\s*(?:people|users|customers)\s*(?:in\s*(?:the\s*)?(?:line|queue))/i,
  /줄\s*(\d[\d,]*)\s*명/,
  /전체\s*(\d[\d,]*)\s*명/,
];

/** 예상 남은 시간 → 초. 두 번째 값은 **숫자 묶음의 번호**다 (단위는 그다음 묶음). */
const ETA_PATTERNS: [RegExp, number][] = [
  [/(?:estimated\s*wait(?:ing)?\s*time|wait(?:ing)?\s*time|estimated\s*time)\s*[:]?\s*(?:about|approx(?:imately)?|~)?\s*(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i, 1],
  [/(?:about|approx(?:imately)?|~)?\s*(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\s*(?:left|remaining|to\s*go|until)/i, 1],
  [/(?:예상\s*(?:대기\s*)?(?:시간)?|남은\s*시간)\s*[:]?\s*(\d+)\s*(초|분|시간)/, 1],
  [/(\d+)\s*(초|분|시간)\s*(?:남|뒤|후)/, 1],
];

const UNIT_SECONDS: Record<string, number> = {
  second: 1, seconds: 1, sec: 1, secs: 1, 초: 1,
  minute: 60, minutes: 60, min: 60, mins: 60, 분: 60,
  hour: 3600, hours: 3600, hr: 3600, hrs: 3600, 시간: 3600,
};

const toNumber = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const n = Number(raw.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const firstMatch = (text: string, patterns: RegExp[], group: number): number | null => {
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const value = toNumber(m[group]);
    if (value !== null) return value;
  }
  return null;
};

/** 페이지 글에서 앞 인원·줄 전체·예상 초를 뽑는다 (순수 함수 — 시험에서 문구별로 확인한다). */
export function parseQueue(text: string): { ahead: number | null; total: number | null; eta: number | null } {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  let eta: number | null = null;
  for (const [re, group] of ETA_PATTERNS) {
    const m = re.exec(flat);
    if (!m) continue;
    const value = toNumber(m[group]);
    const unit = (m[group + 1] ?? "").toLowerCase();
    if (value === null) continue;
    eta = value * (UNIT_SECONDS[unit] ?? 1);
    break;
  }
  return {
    ahead: firstMatch(flat, AHEAD_PATTERNS, 1),
    total: firstMatch(flat, TOTAL_PATTERNS, 1),
    eta,
  };
}

/** 대기열 페이지인가 (문구로) */
export function looksLikeQueue(text: string): boolean {
  const flat = String(text || "").toLowerCase();
  return QUEUE_MARKERS.some((mark) => flat.includes(mark.toLowerCase()));
}

/**
 * **집의 줄 모양**으로 만든다. 데스크톱의 progress.queue 정규식이 이걸 읽는다:
 *     대기열 내 앞 273명 · 줄 281명 · 예상 12초
 */
export function formatQueueLine(info: Pick<QueueInfo, "ahead" | "total" | "eta">): string {
  const parts = [`대기열 내 앞 ${info.ahead === null ? "?" : info.ahead.toLocaleString("en-US")}명`];
  if (info.total !== null) parts.push(`줄 ${info.total.toLocaleString("en-US")}명`);
  if (info.eta !== null) parts.push(`예상 ${info.eta}초`);
  return parts.join(" · ");
}

/** 지금 페이지가 대기열인가 · 주문창인가 · 몇 번째인가. */
export function queueScript(): string {
  const markers = JSON.stringify(QUEUE_MARKERS);
  const hints = JSON.stringify(QUEUE_COOKIE_HINTS);
  return `(() => {
  const text = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 4000);
  const lower = text.toLowerCase();
  const markers = ${markers};
  const inQueue = markers.some((m) => lower.includes(String(m).toLowerCase()));
  const has = (sel) => { try { return !!document.querySelector(sel); } catch (e) { return false; } };
  // 주문창이 떴나 — 슈프림 주문창의 진짜 칸들(그림자 autofill_ 은 빼고).
  const formReady = has('input[name="email"]:not([id^="autofill_"])')
    || has('input[name="address1"]:not([id^="autofill_"])')
    || has('#checkout-pay-button');
  const jar = document.cookie || "";
  const cookies = jar.split(";").map((p) => p.split("=")[0].trim()).filter(Boolean)
    .filter((name) => ${hints}.some((h) => name.toLowerCase().includes(h)));
  return { inQueue, formReady, cookies, url: location.href, title: document.title, text: text.slice(0, 600) };
})()`;
}

function asQueueInfo(value: unknown): QueueInfo | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<QueueInfo> & { inQueue?: boolean; formReady?: boolean };
  if (typeof raw.formReady !== "boolean") return null;
  const parsed = parseQueue(String(raw.text ?? ""));
  return {
    inQueue: raw.inQueue === true || looksLikeQueue(String(raw.text ?? "")),
    formReady: raw.formReady,
    ahead: parsed.ahead,
    total: parsed.total,
    eta: parsed.eta,
    cookies: Array.isArray(raw.cookies) ? raw.cookies.map(String) : [],
    url: String(raw.url ?? ""),
    title: String(raw.title ?? ""),
    text: String(raw.text ?? ""),
  };
}

export interface QueueHost {
  run(script: string): Promise<unknown>;
  goto(url: string): Promise<void>;
  url(): Promise<string>;
  sleep(ms: number): Promise<void>;
  cancelled(): boolean;
}

export interface QueueOptions {
  /** 대기열에 서 있는 주소 (보통 /checkout) */
  url: string;
  /** 이만큼 기다려도 못 들어가면 실패로 돌려준다 */
  timeoutMs: number;
  /** 문구가 안 바뀌고 멈춰 있으면 페이지를 다시 받아 보는 간격 (0 = 안 함) */
  reloadEveryMs: number;
  /** 한 번 보고 끝 (대기열 상태 점검용) */
  once?: boolean;
  /**
   * **체크포인트(/checkpoint — hCaptcha)** 를 만났을 때 — 사람에게 넘겨 풀고 통과했으면 true.
   * 없으면 체크포인트에서는 주소를 다시 열지 않고 기다리기만 한다 (다시 열면 캡차가 처음부터 다시 그려진다).
   */
  onCheckpoint?: () => Promise<boolean>;
}

export const DEFAULT_QUEUE_OPTIONS: QueueOptions = { url: "/checkout", timeoutMs: 30 * 60_000, reloadEveryMs: 60_000 };

export interface QueueOutcome {
  ok: boolean;
  waitedMs: number;
  reason: string;
  info: QueueInfo | null;
  /** 대기열 줄을 몇 번 찍었나 */
  rounds: number;
}

/**
 * 대기열을 통과할 때까지 기다린다 (대기열이 없으면 곧바로 통과).
 * 남은 시간·앞 인원은 제자리 줄(tick)로 계속 찍고, 5초에 한 번은 로그에도 남긴다.
 */
export async function waitThroughQueue(host: QueueHost, options: Partial<QueueOptions> = {}): Promise<QueueOutcome> {
  const opts: QueueOptions = { ...DEFAULT_QUEUE_OPTIONS, ...options };
  const started = Date.now();
  let rounds = 0;
  let lastNote = 0;
  let lastReload = Date.now();
  let info: QueueInfo | null = null;
  let sawQueue = false;

  while (Date.now() - started < opts.timeoutMs) {
    if (host.cancelled()) return { ok: false, waitedMs: Date.now() - started, reason: "사람이 멈췄습니다", info, rounds };

    info = asQueueInfo(await host.run(queueScript()));

    if (info?.formReady) {
      if (sawQueue) sayOk(`대기열을 통과했습니다 (${Math.round((Date.now() - started) / 1000)}초) — 주문창이 떴습니다`);
      if (info.cookies.length) log.debug(`대기열 쿠키: ${info.cookies.join(", ")}`);
      return { ok: true, waitedMs: Date.now() - started, reason: sawQueue ? "대기열 통과" : "대기열 없음", info, rounds };
    }

    const atCheckpoint = isCheckpointUrl(info?.url);
    if (opts.once) {
      const reason = info?.inQueue ? formatQueueLine(info) : atCheckpoint ? "체크포인트(hCaptcha) 화면입니다" : "대기열도 주문창도 아닙니다";
      return { ok: false, waitedMs: Date.now() - started, reason, info, rounds };
    }

    if (atCheckpoint) {
      // 체크포인트 — 사람이 캡차를 푼다. **주소를 다시 열지 않는다** (8초마다 다시 열어 캡차를 날리던 자리).
      if (opts.onCheckpoint) {
        if (!(await opts.onCheckpoint())) {
          return { ok: false, waitedMs: Date.now() - started, reason: "체크포인트(사람 확인)를 넘지 못했습니다", info, rounds };
        }
      }
      lastReload = Date.now();
      await host.sleep(1000);
      continue;
    }

    if (info?.inQueue) {
      if (!sawQueue) {
        sawQueue = true;
        sayStar("대기열에 섰습니다 — 줄이 풀리면 자동으로 들어갑니다 (창을 닫지 마세요)");
        if (info.cookies.length) log.info(`   대기열 쿠키: ${info.cookies.join(", ")}`);
      }
      const line = formatQueueLine(info);
      tick(line);
      rounds++;
      if (Date.now() - lastNote > 5000) {
        lastNote = Date.now();
        log.info(line);
      }
      // 예상 시간도 앞 인원도 안 읽히면 페이지가 멈춘 것일 수 있다 — 가끔 다시 받아 본다.
      if (opts.reloadEveryMs > 0 && info.ahead === null && info.eta === null && Date.now() - lastReload > opts.reloadEveryMs) {
        lastReload = Date.now();
        log.info("대기열 문구가 멈춰 있어 페이지를 다시 받아 봅니다");
        await host.goto(opts.url);
      }
    } else if (Date.now() - lastReload > 8000) {
      // 대기열도 주문창도 아니다 — 아직 그려지는 중이거나, 다른 화면(차단·오류)이다.
      lastReload = Date.now();
      await host.goto(opts.url);
    }

    await host.sleep(1000);
  }

  return {
    ok: false,
    waitedMs: Date.now() - started,
    reason: `대기열에서 ${Math.round(opts.timeoutMs / 60000)}분을 넘겼습니다 (${info ? formatQueueLine(info) : "상태를 못 읽었습니다"})`,
    info,
    rounds,
  };
}

/** 지금 대기열 상태만 한 번 본다 (드랍 전에 문구·쿠키를 확인할 때 쓴다). */
export async function peekQueue(host: QueueHost, url: string): Promise<QueueOutcome> {
  await host.goto(url);
  return waitThroughQueue(host, { url, once: true, timeoutMs: 15_000 });
}
