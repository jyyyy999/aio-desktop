/**
 * 크롬 띄워 두기 — 상품마다 크롬 창 하나를 상품 페이지에 세워 둔다. (2026-10-03)
 *
 * 예전에는 API 가 "구매 가능" 이라 한 **뒤에** 크롬을 띄웠다. 크롬이 뜨고 쿠키를 심고 상품
 * 페이지를 받기까지 3~4초다 (메가브레이브 10:00:00 → 10:00:04 누름). 이제는 감시를 켤 때 창을
 * 띄워 두고, 열리면 **그 창에서 새로 고침만 하고 바로 누른다** (browser.ts 의 buyIn).
 *
 * **줄은 켤 때 한 번만 선다.** 감시를 켜면 창을 띄워 상품 페이지를 받고, 대기열(TRACER, tracer.ts)이
 * 서 있으면 그 자리에서 줄에 선다. 열리기 전에 대기열을 살피다 줄 설 때를 맞추는 일은 하지 않는다 —
 * 2026-10-21 에 걷어냈다. 2026-10-17 MEGA 30th 에서 셈(10-10 실측 속도표)이 빗나가 10:00 에 앞
 * 640명이 남았다. 줄 속도는 날마다 달라서(그날은 열리기 8분 전부터 0.5명/초) 맞출 길이 없었다.
 *
 *   1. 감시가 처음 이 상품을 볼 때 창을 띄운다. 대기 화면이면 차례가 올 때까지 그 창에서 기다린다
 *      (열리는 시각을 알면 열린 뒤 queue_wait_seconds 까지).
 *   2. 열린 것을 API 가 보면 doBuy 가 창을 넘겨받는다. 아직 줄에 있으면 그 자리에서 마저
 *      기다리고, 통과해 "판매중 아님" 페이지에 서 있으면 그 창에서만 새로 받는다.
 *   3. 사지 못하고 끝나면 doBuy 가 창을 돌려준다 (giveBack) — 다음 재입고도 그 창으로 간다.
 *
 * 열리는 시각(product.ts 의 opens_at)은 그 둘레에서 감시 걸음을 빠르게 하는 데만 쓴다 (nearOpening).
 *
 * 창은 상품마다 **하나**다. 창을 여러 개 띄워 줄을 여러 번 서는 일은 하지 않는다.
 *
 * 끝날 때(멈춤·다 삼) **상품 페이지·대기 화면에 서 있는 창만** 닫는다 (closeIdle). 크롬은
 * detach 로 띄워서 그냥 두면 태스크를 다시 켤 때마다 창이 쌓인다. 주문서·결제창까지 간 창은
 * 사람이 마저 해야 하니 남긴다.
 */
import { log, sayStep } from "../log.js";
import { sleep } from "../util.js";
import { openPage, SESSION_DEAD, type Chrome } from "./browser.js";
import { cookieOf, type Config } from "./config.js";
import { kstMs } from "./product.js";
import type { Target } from "./targets.js";
import { waitTracer } from "./tracer.js";

interface Warm {
  /** 띄운 창. 띄우는 중이면 null. */
  box: Chrome | null;
  /** 창이 서면 풀린다 → null (상품 페이지에 섰다·대기열 통과) / 사유. */
  ready: Promise<string | null>;
}

const WARM = new Map<string, Warm>();
/** 상품마다 열리는 시각. 넘겨받은 뒤에도 남겨 둔다 — 열리는 순간 둘레에서 조회를 빠르게 한다. */
const OPENINGS = new Map<string, number>();

const secs = (ms: number): number => Math.round(ms / 1000);

/** 띄워 두는가. 재고만 보는 판(dry-run·모니터)과 크롬을 안 쓰는 설정은 띄우지 않는다. */
function wanted(cfg: Config, dryRun: boolean): boolean {
  return !dryRun && cfg.open_browser !== false && cfg.warm_browser !== false;
}

/**
 * 이 상품의 창을 챙긴다. 감시가 바퀴마다 부른다 — 창이 이미 있으면 그냥 간다.
 *
 *   창이 없으면 띄운다 (뒤에서 — 감시는 기다리지 않는다). 대기 화면이면 그 줄에 선다.
 *   opensAt(product.ts 의 opens_at, 한국 시각 YYYYMMDDHHmmss)은 적어 두기만 한다 (nearOpening).
 */
export function planWarm(cfg: Config, target: Target, opensAt: string, dryRun: boolean): void {
  const at = opensAt ? kstMs(opensAt) : NaN;
  if (Number.isFinite(at)) OPENINGS.set(target.key, at);
  if (!wanted(cfg, dryRun) || WARM.has(target.key)) return;

  // 열리는 시각을 알면 열린 뒤 queue_wait_seconds 까지 줄에서 기다린다 — 일찍 켜 두면 열리기 한참
  // 전부터 줄에 서 있을 수 있어서, 기다리는 한도가 열리기 전에 끝나지 않게 한다.
  const wait = cfg.queue_wait_seconds ?? 300;
  const opens = Number.isFinite(at) && at > Date.now() ? at : null;
  const budget = opens ? secs(opens - Date.now()) + wait : wait;
  WARM.set(target.key, launch(cfg, target,
    "크롬을 띄워 상품 페이지에 세워 둡니다 — 대기열이 있으면 지금 줄을 서고, 열리면 새로 고침만 하고 바로 누릅니다",
    budget, opens));
}

/** 창을 띄워 상품 페이지에 세운다. 대기 화면이면 그 줄에 선다. */
function launch(
  cfg: Config, target: Target, why: string,
  budget = cfg.queue_wait_seconds ?? 300, opensAt: number | null = null,
): Warm {
  const w: Warm = { box: null, ready: Promise.resolve(null) };
  sayStep(`[${target.key}] ${why}`);
  w.ready = openPage(target.url, cookieOf(cfg), {
    headless: cfg.browser_headless, timeout: cfg.browser_timeout_seconds ?? 20,
  }).then(async ([box, reason]) => {
    w.box = box;
    if (reason) {
      log.warn(`[${target.key}] 띄운 크롬이 상품 페이지에 못 섰습니다 — ${reason}`);
      return reason;
    }
    return stand(target.key, box, budget, opensAt);
  }).catch((e) => {
    log.warn(`[${target.key}] 크롬을 띄우지 못했습니다 — ${(e as Error).message}`);
    return (e as Error).message;
  });
  return w;
}

/**
 * 대기 화면이면 줄을 선다 (대기 화면이 아니면 곧장 null). 감시가 상태 줄을 쓰고 있으니
 * 줄 서기는 로그에 10초마다 한 줄씩만 남긴다.
 */
function stand(key: string, box: Chrome, budget: number, opensAt: number | null): Promise<string | null> {
  let lineAt = 0;
  const say = (line: string) => {
    if (Date.now() - lineAt < 10_000) return;
    lineAt = Date.now();
    log.info(`[${key}] ${line}` + (opensAt ? ` · 열리기까지 ${secs(opensAt - Date.now())}초` : ""));
  };
  return waitTracer(box.driver, budget, say).then((why) => {
    if (why) {
      log.warn(`[${key}] ${why}`);
    } else if (opensAt) {
      const gap = secs(opensAt - Date.now());
      log.info(gap > 0
        ? `[${key}] 열리기 ${gap}초 전에 상품 페이지에 섰습니다 — 열리면 이 창에서 새로 고쳐 삽니다`
        : `[${key}] 열린 뒤 ${-gap}초에 상품 페이지에 섰습니다`);
    }
    return why;
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
  WARM.set(key, { box, ready: Promise.resolve(null) });
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
