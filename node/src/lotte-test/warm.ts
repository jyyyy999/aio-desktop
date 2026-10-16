/**
 * 크롬 띄워 두기 — 상품마다 크롬 창 하나를 상품 페이지에 세워 둔다. (2026-10-03)
 *
 * 예전에는 API 가 "구매 가능" 이라 한 **뒤에** 크롬을 띄웠다. 크롬이 뜨고 쿠키를 심고 상품
 * 페이지를 받기까지 3~4초다 (메가브레이브 10:00:00 → 10:00:04 누름). 이제는 감시를 켤 때 창을
 * 띄워 두고, 열리면 **그 창에서 새로 고침만 하고 바로 누른다** (browser.ts 의 buyIn).
 *
 * **열리는 시각을 아는 상품은 그 전에 대기열에 세운다.** MEGA 30th 예약판매(10:00)는 10시 전부터
 * 대기열(TRACER, tracer.ts)이 서 있었다. 그날 산 사람들은 10시 전에 줄을 뚫어 놓고 상품
 * 페이지에서 10시에 새로 고쳤다 (사용자가 들은 말) — 통과한 자리가 새로 고침에도 남는다.
 *
 * **고침 (2026-10-17):** 남기는 남되 ~30초뿐이다 (10-10 실측). 그래서 기본은 queue_timing "late" — 열리기
 * 30초 안쪽 통과를 노리고(queue_pass_lead_seconds), 기다릴 어림은 실측 속도(queue_drain_per_second)로 센다.
 * 켤 때 이미 대기열이 서 있으면 상품 페이지를 미리 받지 않는다 (launchUnlessQueued). 아래 3 의 셈은 "early" 것이다.
 *
 *   1. 감시가 API 에서 열리는 시각을 읽는다 (product.ts 의 opens_at — 예약주문기간·판매 시작).
 *   2. 열리기 warm_window_minutes 분 전부터 상품 페이지를 HTTP 로 받아 대기열 길이를 본다.
 *      쿠키 없이 받는다 — 읽기만 하고 줄에 서지는 않는다 (줄에 서는 것은 화면 스크립트가
 *      wcCookie 로 inputQueue.do 를 부를 때다).
 *   3. 기다릴 어림 = session_time_out ÷ limitCnt × 대기 인원 (화면 스크립트와 같은 셈).
 *      "열리기 warm_lead_seconds 초 전에 통과" 가 되도록 줄 설 때를 잡는다:
 *          줄 설 때 = 열리는 시각 − 어림 − warm_lead_seconds
 *   4. 그때 대기열이 서 있으면 띄워 둔 창에서 상품 페이지를 새로 받아 줄을 선다. 띄워 둔
 *      창이 아직 없으면 그때 띄운다. 대기열이 없으면 창을 그대로 둔다 — 대기열이 없을 때 받은
 *      페이지에는 줄 선 자리(wcCookie)가 없어서, 열린 뒤 새로 고칠 때 대기열이 서 있으면 맨
 *      뒤로 간다. 그래서 대기열이 **서 있을 때** 미리 서 두는 것이다.
 *   5. 열린 것을 API 가 보면 doBuy 가 창을 넘겨받는다. 아직 줄에 있으면 그 자리에서 마저
 *      기다리고, 통과해 "판매중 아님" 페이지에 서 있으면 그 창에서만 새로 받는다.
 *   6. 사지 못하고 끝나면 doBuy 가 창을 돌려준다 (giveBack) — 다음 재입고도 그 창으로 간다.
 *
 * 창은 상품마다 **하나**다. 창을 여러 개 띄워 줄을 여러 번 서는 일은 하지 않는다.
 *
 * 끝날 때(멈춤·다 삼) **상품 페이지·대기 화면에 서 있는 창만** 닫는다 (closeIdle). 크롬은
 * detach 로 띄워서 그냥 두면 태스크를 다시 켤 때마다 창이 쌓인다. 주문서·결제창까지 간 창은
 * 사람이 마저 해야 하니 남긴다.
 */
import { log, sayStep } from "../log.js";
import { sleep } from "../util.js";
import { openPage, reopen, SESSION_DEAD, windowGone, type Chrome } from "./browser.js";
import { cookieOf, type Config } from "./config.js";
import { getPage, newSession } from "./http.js";
import { kstMs } from "./product.js";
import { productUrl, type Target } from "./targets.js";
import { gateOf, waitTracer, type Gate, type TracerState } from "./tracer.js";

interface Warm {
  /** 띄운 창. 띄우는 중이면 null. */
  box: Chrome | null;
  /** 창이 서면 풀린다 → null (상품 페이지에 섰다·대기열 통과) / 사유. */
  ready: Promise<string | null>;
  /** 줄 서기를 계획해 둔 열리는 시각 (epoch ms). 같은 시각을 두 번 계획하지 않는다. */
  planned: number | null;
  /** 켤 때 대기열이 서 있어서 상품 페이지를 미리 받지 않았다 (queue_timing "late"). 창은 planner 가 띄운다. */
  deferred?: boolean;
}

/** "late" 인가 (기본). "early" 는 예전 방식 — warm_lead_seconds 전 통과를 노린다. */
const lateTiming = (cfg: Config): boolean => (cfg.queue_timing ?? "late") !== "early";

/** 통과한 자리의 수명(초) — 대기 화면의 session_time_out. 못 읽으면 10-10 에 본 값. */
const PASS_SECONDS = 30;

const WARM = new Map<string, Warm>();
/** 상품마다 열리는 시각. 넘겨받은 뒤에도 남겨 둔다 — 열리는 순간 둘레에서 조회를 빠르게 한다. */
const OPENINGS = new Map<string, number>();

const NO_GATE: Gate = { waiting: false, count: 0, limit: 0, session: 0, eta: 0 };

/** epoch ms → 10:00:00 */
const clock = (ms: number): string =>
  new Date(ms + 9 * 3600_000).toISOString().slice(11, 19);

const secs = (ms: number): number => Math.round(ms / 1000);

/** 띄워 두는가. 재고만 보는 판(dry-run·모니터)과 크롬을 안 쓰는 설정은 띄우지 않는다. */
function wanted(cfg: Config, dryRun: boolean): boolean {
  return !dryRun && cfg.open_browser !== false && cfg.warm_browser !== false;
}

/**
 * 이 상품의 창을 챙긴다. 감시가 바퀴마다 부른다 — 할 일이 없으면 그냥 간다.
 *
 *   창이 없으면 띄운다 (뒤에서 — 감시는 기다리지 않는다).
 *   opensAt(product.ts 의 opens_at, 한국 시각 YYYYMMDDHHmmss)이 있고 warm_window_minutes 안이면
 *   그 전에 대기열에 서도록 계획한다.
 */
export function planWarm(cfg: Config, target: Target, opensAt: string, dryRun: boolean): void {
  const at = opensAt ? kstMs(opensAt) : NaN;
  if (Number.isFinite(at)) OPENINGS.set(target.key, at);
  if (!wanted(cfg, dryRun)) return;

  let w = WARM.get(target.key);
  if (!w) {
    const why = "크롬을 띄워 상품 페이지에 세워 둡니다 — 열리면 새로 고침만 하고 바로 누릅니다";
    w = lateTiming(cfg) && Number.isFinite(at) && at > Date.now()
      ? launchUnlessQueued(cfg, target, why)
      : launch(cfg, target, why);
    WARM.set(target.key, w);
  }

  if (!Number.isFinite(at) || w.planned === at) return;
  const left = at - Date.now();
  if (left <= 0 || left > (cfg.warm_window_minutes ?? 30) * 60_000) return;
  w.planned = at;
  const mine = w;
  void planner(cfg, target, mine, at).catch((e) => {
    log.warn(`[${target.key}] 대기열 미리 서기가 멈췄습니다 — ${(e as Error).message}`);
  });
}

/** 창을 띄워 상품 페이지에 세운다. 대기 화면이면 그 줄에 선다. */
function launch(
  cfg: Config, target: Target, why: string,
  budget = cfg.queue_wait_seconds ?? 300, opensAt: number | null = null, passSeconds = PASS_SECONDS,
): Warm {
  const w: Warm = { box: null, ready: Promise.resolve(null), planned: null };
  sayStep(`[${target.key}] ${why}`);
  w.ready = openPage(target.url, cookieOf(cfg), {
    headless: cfg.browser_headless, timeout: cfg.browser_timeout_seconds ?? 20,
  }).then(async ([box, reason]) => {
    w.box = box;
    if (reason) {
      log.warn(`[${target.key}] 띄운 크롬이 상품 페이지에 못 섰습니다 — ${reason}`);
      return reason;
    }
    return stand(target.key, box, budget, opensAt, passSeconds);
  }).catch((e) => {
    log.warn(`[${target.key}] 크롬을 띄우지 못했습니다 — ${(e as Error).message}`);
    return (e as Error).message;
  });
  return w;
}

/**
 * "late" 에서 감시를 켤 때. 상품 페이지를 받기 전에 쿠키 없이 대기열을 본다 — 서 있으면 **받지 않는다.**
 * 받는 순간 그 창이 줄에 서고, 지금 서면 열리기 훨씬 전에 통과해 30초 뒤 자리를 잃는다. 창은 planner 가
 * 줄 설 때에 띄운다. 대기열이 없으면 예전처럼 바로 띄워 둔다 (대기열 없이 받은 페이지에는 줄 선 자리가 없다).
 */
function launchUnlessQueued(cfg: Config, target: Target, why: string): Warm {
  const w: Warm = { box: null, ready: Promise.resolve(null), planned: null };
  w.ready = (async () => {
    let gate = NO_GATE;
    try {
      gate = gateOf(await getPage(newSession(""), productUrl(target.key, target.sitmNo)));
    } catch (e) {
      log.debug(`[${target.key}] 켤 때 대기열을 못 봤습니다 (그냥 띄웁니다): ${(e as Error).message}`);
    }
    if (gate.waiting) {
      w.deferred = true;
      log.info(`[${target.key}] 벌써 대기열 ${gate.count.toLocaleString()}명이 서 있습니다 — 지금 서면 너무 일찍 통과하므로 ` +
        "상품 페이지를 미리 받지 않습니다. 줄 설 때에 크롬을 띄웁니다");
      return null;
    }
    const inner = launch(cfg, target, why);
    const got = await inner.ready;
    w.box = inner.box;
    return got;
  })();
  return w;
}

/**
 * 대기 화면이면 줄을 선다 (대기 화면이 아니면 곧장 null). 감시가 상태 줄을 쓰고 있으니
 * 줄 서기는 로그에만 남긴다 — **5초마다 내 순번 한 줄.** 그날 줄이 실제로 얼마나 빨리 빠졌는지
 * (queue_drain_per_second 를 고칠 재료) 가 여기서 나온다.
 */
function stand(
  key: string, box: Chrome, budget: number, opensAt: number | null, passSeconds = PASS_SECONDS,
): Promise<string | null> {
  let first: { at: number; ahead: number } | null = null;
  let loggedAt = 0;
  const watch = (s: TracerState) => {
    const now = Date.now();
    if (!first) first = { at: now, ahead: s.ahead };
    if (now - loggedAt < 5_000) return;
    loggedAt = now;
    log.info(`[${key}] 줄 기록 ${clock(now)} · 내 앞 ${s.ahead.toLocaleString()}명` +
      (s.total ? ` · 줄 ${s.total.toLocaleString()}명` : "") +
      (opensAt ? ` · 열리기까지 ${secs(opensAt - now)}초` : ""));
  };
  return waitTracer(box.driver, budget, () => undefined, watch).then((why) => {
    if (why) {
      log.warn(`[${key}] ${why}`);
      return why;
    }
    const now = Date.now();
    const waited = first ? (now - first.at) / 1000 : 0;
    const rate = first && waited > 0 ? first.ahead / waited : 0;
    if (first) {
      log.info(`[${key}] 줄에서 ${Math.round(waited)}초 · 앞 ${first.ahead.toLocaleString()}명에서 ${clock(now)} 통과 · ` +
        `평균 ${rate.toFixed(2)}명/초`);
    }
    if (opensAt) {
      const gap = secs(opensAt - now);
      if (first && gap > passSeconds) {
        log.warn(`[${key}] 너무 일찍 통과했습니다 — 열리기 ${gap}초 전 (통과한 자리는 ~${passSeconds}초). ` +
          "열린 뒤 새로 고치면 다시 줄에 설 수 있습니다. " +
          `다음에는 queue_drain_per_second 를 올립니다 (이번 평균 ${rate.toFixed(2)}명/초)`);
      } else {
        log.info(gap > 0
          ? `[${key}] 열리기 ${gap}초 전에 상품 페이지에 섰습니다 — 열리면 이 창에서 새로 고쳐 삽니다`
          : `[${key}] 열린 뒤 ${-gap}초에 상품 페이지에 섰습니다`);
      }
    }
    return null;
  });
}

/** 열리기 전에 대기열에 서도록 때를 잡는다. */
async function planner(cfg: Config, target: Target, w: Warm, opensAt: number): Promise<void> {
  const key = target.key;
  const late = lateTiming(cfg);
  const lead = Math.max(0, late ? cfg.queue_pass_lead_seconds ?? 10 : cfg.warm_lead_seconds ?? 60) * 1000;
  const rate = Math.max(0.05, cfg.queue_drain_per_second ?? 1);
  // "late" 는 화면 스크립트의 셈(limitCnt ÷ session_time_out — 10-10 에는 6.7명/초)을 버리고 실측 속도로 센다.
  // 줄 설 때 창을 새로 받거나 띄우는 몇 초도 뺀다.
  const waitOf = (g: Gate): number => (late ? (g.waiting ? Math.round(g.count / rate) : 0) : g.eta);
  const settle = late ? 3_000 : 0;
  // 쿠키 없이 본다. 대기 화면은 상품 페이지 주소에 그대로 온다.
  const s = newSession("");
  const peekUrl = productUrl(key, target.sitmNo);
  const mine = () => WARM.get(key) === w;

  sayStep(`[${key}] ${clock(opensAt)} 에 열립니다 — 대기열을 살피다가 ` +
    `열리기 ${secs(lead)}초 전에 통과하도록 줄을 섭니다` +
    (late ? ` (늦게 통과 노리기 · 줄 ${rate}명/초로 셈)` : ""));

  let gate = NO_GATE;
  let saidAt = 0;
  let saidWaiting: boolean | null = null;
  let launchAt = opensAt - lead;
  for (;;) {
    // doBuy 가 창을 넘겨 갔다 (API 가 어림보다 일찍 열었다). 그쪽이 마저 한다.
    if (!mine()) return;
    try {
      gate = gateOf(await getPage(s, peekUrl));
    } catch (e) {
      log.warn(`[${key}] 대기열을 못 봤습니다 (지난 값으로 셈합니다): ${(e as Error).message}`);
    }

    const now = Date.now();
    const wait = waitOf(gate);
    launchAt = opensAt - wait * 1000 - lead - settle;
    // 대기열이 서거나 풀릴 때, 그리고 30초마다 한 줄. 다음 드랍에서 줄이 언제부터 얼마나 길었는지 볼 재료다.
    if (gate.waiting !== saidWaiting || now - saidAt >= 30_000) {
      log.info(`[${key}] 열리기 ${secs(opensAt - now)}초 전 · ` +
        (gate.waiting
          ? `대기열 ${gate.count.toLocaleString()}명 (자리 ${gate.limit} · ${gate.session}초) · 어림 ${wait}초`
          : "대기열 없음") +
        ` · 줄 설 때 ${clock(launchAt)}`);
      saidAt = now;
      saidWaiting = gate.waiting;
    }
    if (now >= opensAt) {
      log.info(`[${key}] 열릴 때까지 대기열이 안 섰습니다 — 띄워 둔 창에서 새로 고쳐 삽니다`);
      return;
    }
    // 켤 때 대기열이 서 있어 창을 안 띄웠는데 그 줄이 풀렸다. 열리기 전에 창은 세워 둔다 — 열리는 순간
    // 크롬 뜨는 3~4초를 쓰지 않으려고. 대기열이 없을 때 받은 페이지라 줄 선 자리도 없다.
    if (w.deferred && !gate.waiting && opensAt - now <= 30_000) {
      await w.ready;
      if (!mine()) return;
      const fresh = launch(cfg, target, `열리기 ${secs(opensAt - now)}초 전 · 대기열이 풀렸습니다 — 크롬을 띄워 둡니다`);
      fresh.planned = opensAt;
      WARM.set(key, fresh);
      return;
    }
    // 줄 설 때가 됐고 대기열이 서 있으면 선다. 대기열이 없으면 열릴 때까지 계속 본다 — 열리기
    // 직전에야 줄이 설 수 있고, 그때 안 서 있으면 열린 뒤 새로 고칠 때 맨 뒤로 간다.
    if (now >= launchAt && gate.waiting) break;

    // 때가 가까울수록 자주 본다. 줄은 열리기 직전에 빨리 길어진다.
    const until = Math.max(0, launchAt - now);
    await sleep(until > 120_000 ? Math.min(until, 15_000) : until > 30_000 ? 5_000 : 2_000);
  }
  if (!mine()) return;

  const budget = Math.max(0, secs(opensAt - Date.now())) + (cfg.queue_wait_seconds ?? 300);
  const before = secs(opensAt - Date.now());
  // 띄워 두던 창이 아직 뜨는 중이면 기다린다.
  await w.ready;
  if (!mine()) return;
  const box = w.box && !(await windowGone(w.box)) ? w.box : null;

  const pass = gate.session || PASS_SECONDS;
  if (!box) {
    const fresh = launch(cfg, target, `열리기 ${before}초 전 — ` +
      (gate.waiting ? `대기열 ${gate.count.toLocaleString()}명 · 어림 ${waitOf(gate)}초. ` : "") +
      "크롬을 띄워 줄을 섭니다", budget, opensAt, pass);
    fresh.planned = opensAt;
    WARM.set(key, fresh);
    return;
  }
  // 이미 줄에 선 창이면 건드리지 않는다. 새로 받으면 그 자리를 버릴 수 있다. wcCookie 는 대기
  // 화면 스크립트만 만든다 — 있으면 이 창은 줄에 서 있거나 통과한 것이다 (tracer.ts).
  const inLine = await box.driver
    .executeScript<boolean>("return /(?:^|; )wcCookie=/.test(document.cookie)")
    .catch(() => false);
  if (inLine) {
    log.info(`[${key}] 열리기 ${before}초 전 · 띄워 둔 창이 이미 줄에 섰습니다 — 그대로 둡니다`);
    return;
  }
  sayStep(`[${key}] 열리기 ${before}초 전 — 대기열 ${gate.count.toLocaleString()}명 · 어림 ${waitOf(gate)}초. ` +
    "띄워 둔 창에서 상품 페이지를 새로 받아 줄을 섭니다");
  w.ready = reopen(box, target.url, cfg.browser_timeout_seconds ?? 20).then((reason) => {
    if (reason) {
      log.warn(`[${key}] 상품 페이지를 새로 받지 못했습니다 — ${reason}`);
      return reason;
    }
    return stand(key, box, budget, opensAt, pass);
  });
}

/** 열리는 순간 둘레인가 (열리기 before 초 전 ~ 열린 뒤 after 초). 감시가 조회 걸음을 정할 때 본다. */
export function nearOpening(before = 60, after = 120): boolean {
  const now = Date.now();
  for (const at of OPENINGS.values()) {
    if (now >= at - before * 1000 && now <= at + after * 1000) return true;
  }
  return false;
}

/** 가장 가까운 앞으로의 열리는 시각까지 남은 ms (없으면 null). */
export function msToOpening(): number | null {
  const now = Date.now();
  let best: number | null = null;
  for (const at of OPENINGS.values()) {
    if (at > now && (best === null || at - now < best)) best = at - now;
  }
  return best;
}

/**
 * 띄워 둔 창을 넘겨받는다. → { 창, 서기 결과 } / null (띄운 것이 없다)
 *
 * 아직 뜨는 중이거나 줄에 서 있으면 그게 끝날 때까지 기다렸다가 돌려준다. 넘겨받은 창은 이제
 * doBuy 의 것이다 — 사지 못하면 giveBack 으로 돌려준다.
 */
export async function takeWarm(key: string): Promise<{ box: Chrome; why: string | null } | null> {
  const w = WARM.get(key);
  if (!w) return null;
  WARM.delete(key);
  const why = await w.ready;
  if (!w.box) return null;
  return { box: w.box, why };
}

/** 사지 못하고 끝난 창을 돌려받는다. 다음 재입고도 이 창으로 간다 (새 크롬을 띄우지 않는다). */
export function giveBack(key: string, box: Chrome, why: string | null = null): void {
  if (WARM.has(key) || why === SESSION_DEAD) return;
  WARM.set(key, { box, ready: Promise.resolve(null), planned: null });
}

/**
 * 끝날 때 쉬고 있는 창을 닫는다. 상품 페이지·대기 화면에 서 있는 것만 — 주문서·결제창까지 간
 * 창은 사람이 마저 해야 하니 남긴다. 창마다 2.5초까지만 기다린다 (멈춤 유예가 6초다).
 */
export async function closeIdle(): Promise<void> {
  const boxes = [...WARM.values()].map((w) => w.box).filter((box): box is Chrome => !!box);
  WARM.clear();
  await Promise.all(boxes.map(async (box) => {
    const url = await Promise.race([
      box.driver.getCurrentUrl().catch(() => ""),
      sleep(1000).then(() => ""),
    ]);
    // 어디 서 있는지 모르면(alert·죽은 창) 건드리지 않는다.
    if (!url.includes("/product/")) return;
    await Promise.race([box.quit(), sleep(2500)]);
  }));
}
