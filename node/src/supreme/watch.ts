/**
 * 감시 루프 — **사지 않고 계속 보는 것**(드라이런)과 **사는 것**이 같은 뼈대를 쓴다.
 *
 * 한 바퀴
 *   1. 컬렉션을 훑어 상품 목록을 얻는다 (Shopify JSON → 실패하면 HTML 폴백)
 *   2. 앞 스냅샷과 견주어 새 상품·새 variant·재입고를 뽑는다
 *   3. 규칙(키워드·색·사이즈·상한가)에 걸러 사람에게 알린다
 *   4. 살 것으로 정해졌으면 hooks.onEvents 가 구매 단계로 넘긴다 (드라이런이면 안 넘긴다)
 *
 * 요청 간격은 실패에 따라 물러난다 (backoff). 차단 화면(사람 확인)을 만나면 hooks.onBlocked 로
 * 창을 사람에게 넘기고, 사람이 통과할 때까지 기다린 뒤 이어서 본다 — 자동으로 뚫지 않는다.
 */
import { type DropEvent, type BuyRule, type MonitorRule, buildSnapshot, colorExact, decide, describe, diff, matchProduct, needsFullName, productColor, type Snapshot, withFullName } from "./match.js";
import { LINES } from "./lines.js";
import type { Product, Shop } from "./site.js";

export interface WatchLog {
  note(text: string): void;
  ok(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  step(text: string): void;
  /** 제자리에서 고쳐 쓰는 줄 (다음 확인까지 남은 초) */
  tick(text: string): void;
}

export interface WatchOptions {
  /** 스토어프론트 오리진 — 발견 줄에 붙일 절대 주소를 만들 때 쓴다 */
  origin: string;
  collections: string[];
  /** 기본 확인 간격 */
  intervalMs: number;
  /** 간격에 더할 랜덤 (고정 주기 완화) */
  jitterMs: number;
  /** 실패가 이어질 때 늘릴 최대 간격 */
  maxBackoffMs: number;
  /** 확인 실패를 이만큼 연달아 하면 멈춘다 (0 = 끝없이) */
  maxRetries: number;
  /** 실패한 뒤 쉬는 시간 */
  retryDelayMs: number;
  /** 0 이면 사람이 멈출 때까지 */
  durationMs: number;
  /** 이만큼만 확인하고 끝낸다 (0 = 끝없이). --once 가 1 을 쓴다 */
  maxRounds: number;
  /** 사지 않고 발견만 (원본의 dry-run) */
  dryRun: boolean;
  /** 하나 발견하면 멈춘다 */
  stopOnFound: boolean;
  /** 이만큼 사면 멈춘다 */
  maxBuys: number;
}

export const DEFAULT_WATCH_OPTIONS: WatchOptions = {
  origin: "https://shop.supreme.com",
  collections: ["all"],
  intervalMs: 2500,
  jitterMs: 400,
  maxBackoffMs: 30_000,
  maxRetries: 0,
  retryDelayMs: 5000,
  durationMs: 0,
  maxRounds: 0,
  dryRun: false,
  stopOnFound: false,
  maxBuys: 1,
};

export interface WatchHooks {
  /** 살 것으로 정해진 것들. 드라이런에서는 부르지 않는다 (부르는 쪽이 판단해도 된다). */
  onEvents(events: DropEvent[], decisions: { event: DropEvent; decision: ReturnType<typeof decide> }[]): Promise<void>;
  /** 사람 확인 화면(봇 차단)을 만났다 — 창을 사람에게 보여 주고 통과를 기다린다. */
  onBlocked?(state: { url: string; text: string }): Promise<void>;
  /** 바퀴 하나가 끝났다 (상태 파일·통계용) */
  onRound?(info: { round: number; products: number; events: number; ms: number }): void;
}

export interface WatchState {
  round: number;
  products: number;
  events: number;
  buys: number;
  startedAt: number;
  lastError: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function withJitter(base: number, jitter: number): number {
  if (jitter <= 0) return base;
  return Math.max(500, base + Math.round((Math.random() * 2 - 1) * jitter));
}

/** 컬렉션 여러 개를 훑어 handle 기준으로 합친다 (같은 상품이 여러 컬렉션에 있어도 한 번). */
export async function scan(
  shop: Shop,
  collections: string[],
  log: WatchLog,
): Promise<{ products: Product[]; note: string; blocked: { url: string; text: string } | null }> {
  const byHandle = new Map<string, Product>();
  const notes: string[] = [];
  let blocked: { url: string; text: string } | null = null;

  for (const collection of collections) {
    const before = byHandle.size;
    const list = await shop.list(collection);
    for (const product of list.products) byHandle.set(product.handle, product);
    notes.push(`${collection}: ${list.mode} ${list.products.length}개${list.note ? ` (${list.note})` : ""}`);
    if (list.mode === "none") {
      const state = await shop.pageState();
      if (state.blocked || state.challenge) {
        blocked = { url: state.url, text: state.text };
        log.warn(LINES.blocked(state.text.slice(0, 100)));
      }
    }
    if (before === byHandle.size && list.products.length === 0) {
      log.warn(`컬렉션 ${collection} 에서 상품을 하나도 못 얻었습니다`);
    }
  }
  return { products: [...byHandle.values()], note: notes.join(" · "), blocked };
}

export interface WatchRun {
  state: WatchState;
  ok: boolean;
  reason: string;
}

/**
 * 감시 한 판. durationMs 가 0 이면 shouldStop 이 설 때까지 돈다.
 * @param shouldStop 사람이 멈추라고 했나 (Ctrl+C·대시보드 STOP)
 */
export async function watchLoop(
  shop: Shop,
  rule: MonitorRule,
  buy: BuyRule,
  options: Partial<WatchOptions>,
  hooks: WatchHooks,
  log: WatchLog,
  shouldStop: () => boolean,
): Promise<WatchRun> {
  const opts: WatchOptions = { ...DEFAULT_WATCH_OPTIONS, ...options };
  const state: WatchState = { round: 0, products: 0, events: 0, buys: 0, startedAt: Date.now(), lastError: "" };
  let snapshot: Snapshot | null = null;
  let interval = opts.intervalMs;
  let consecutiveErrors = 0;
  const toldSoldOut = new Set<string>();

  log.step(`감시를 시작합니다 — 컬렉션 ${opts.collections.join(", ")} · 간격 ${opts.intervalMs}ms${opts.dryRun ? " · 드라이런(사지 않습니다)" : ""}`);

  while (!shouldStop()) {
    if (opts.durationMs > 0 && Date.now() - state.startedAt > opts.durationMs) {
      log.note(LINES.stopped(`감시 시간(${Math.round(opts.durationMs / 60000)}분)이 끝났습니다`));
      return { state, ok: true, reason: "감시 시간 종료" };
    }
    // --once: 한 바퀴만 보고 끝낸다.
    if (opts.maxRounds > 0 && state.round >= opts.maxRounds) {
      log.note(LINES.stopped(`${opts.maxRounds}바퀴만 보고 끝냅니다`));
      return { state, ok: true, reason: `${opts.maxRounds}바퀴` };
    }

    const roundStarted = Date.now();
    state.round++;

    let products: Product[] = [];
    try {
      const scanned = await scan(shop, opts.collections, log);
      products = scanned.products;
      if (scanned.blocked && hooks.onBlocked) {
        // 사람이 통과할 때까지 기다린다 (자동으로 뚫지 않는다).
        await hooks.onBlocked(scanned.blocked);
        continue;
      }
      consecutiveErrors = 0;
      interval = opts.intervalMs;
    } catch (err) {
      consecutiveErrors++;
      state.lastError = err instanceof Error ? err.message : String(err);
      interval = Math.max(opts.retryDelayMs, Math.min(opts.maxBackoffMs, Math.round(opts.intervalMs * Math.pow(1.6, consecutiveErrors))));
      log.warn(`확인 실패(${consecutiveErrors}번째): ${state.lastError} — ${Math.round(interval / 1000)}초 뒤에 다시 봅니다`);
      if (opts.maxRetries > 0 && consecutiveErrors >= opts.maxRetries) {
        log.error(LINES.failed("확인", `${consecutiveErrors}번 연달아 실패했습니다 — ${state.lastError}`));
        return { state, ok: false, reason: `확인 ${consecutiveErrors}회 연속 실패` };
      }
      await sleep(interval);
      continue;
    }

    state.products = products.length;
    const { events, first } = diff(snapshot, products, rule);
    snapshot = buildSnapshot(products);

    if (first) {
      const inStock = products.filter((p) => p.available).length;
      log.note(`첫 확인 — 상품 ${products.length}개(재고 있음 ${inStock}개)를 기억했습니다. 다음부터 새 것·재입고만 알립니다`);
    }

    const ms = Date.now() - roundStarted;
    log.note(LINES.round(state.round, products.length, Math.max(1, Math.round(ms / 1000))));

    const alive: { event: DropEvent; decision: ReturnType<typeof decide> }[] = [];
    // **한 바퀴에 상품 하나는 한 번만 판정한다.** products-json 은 재고가 사이즈마다 따로라 같은 상품의 이벤트가
    // 사이즈 수만큼 온다(실측: 발견 줄 5번 · "사지 않음" 줄이 상품×사이즈). 사이즈는 decide 가 상품 전체에서 고른다.
    // 사이즈 조건(variant 단계)에서만 떨어진 것은 다른 사이즈 이벤트로 다시 본다.
    const judged = new Set<string>();
    // 색을 적었으면 **색이 정확히 같은 상품을 먼저** 본다 — "black" 에 Black 과 Washed Black 이 둘 다 걸리면
    // 걸리는 대로 바로 사니까, 순서가 곧 무엇을 사느냐다 (2026-10-12).
    const exact = (e: DropEvent): number => (rule.colors.some((c) => colorExact(productColor(e.product), c)) ? 1 : 0);
    const ordered = rule.colors.length ? [...events].sort((a, b) => exact(b) - exact(a)) : events;
    // 같은 상품에 **정확히 그 색**이 따로 있으면(품절이어도) 비슷한 색으로는 사지 않는다 —
    // Black 이 품절이고 Washed Black 만 남았다고 Washed Black 을 담지 않게 (2026-10-12 실사이트 225개 확인).
    const baseOf = (p: Product): string => {
      const c = productColor(p);
      return c && p.title.endsWith(` - ${c}`) ? p.title.slice(0, -(c.length + 3)) : p.title;
    };
    const exactBases = new Set(
      rule.colors.length ? products.filter((p) => rule.colors.some((c) => colorExact(productColor(p), c))).map(baseOf) : [],
    );
    for (const event of ordered) {
      if (judged.has(event.product.handle)) continue;
      if (rule.colors.length && !exact(event) && exactBases.has(baseOf(event.product))) {
        judged.add(event.product.handle);
        log.note(`${describe(event.product, event.variant)} · 사지 않음: 색상 불일치(${productColor(event.product)} — 정확히 ${rule.colors.join("/")} 인 상품이 따로 있습니다)`);
        continue;
      }
      let product = event.product;

      // 1) **variant 를 해석하기 전에 키워드·가격으로 거른다.**
      //    HTML 폴백(Supreme 의 실제 경로)에서는 상품마다 variant 가 없어서, 순서를 바꾸지 않으면
      //    조건에 안 맞는 상품 페이지까지 전부 받아야 한다 (36개 = 7초, 2026-10-08).
      const pre = matchProduct(product, rule);
      if (!pre.ok) {
        judged.add(event.product.handle);
        if (!needsFullName(product, rule)) {
          log.note(`${describe(product, event.variant)} · 사지 않음: ${pre.reason}`);
          continue;
        }
        // 1-1) **색 보완** — 목록 카드에 색이 빠져 오는 판이 있다 (카드가 늦게 그려진다, 2026-10-08).
        //      키워드가 일부 걸린 후보만 상품 페이지 JSON 의 이름으로 다시 본다 (요청은 후보 수만큼만 는다).
        const resolved = await shop.resolve(product.handle);
        const full = resolved ? withFullName(product, resolved) : null;
        const again = full ? matchProduct(full, rule) : null;
        if (!full || !again?.ok) {
          const why = again ? again.reason : `${pre.reason} · 상품 페이지 해석 실패(${shop.lastResolveNote})`;
          log.note(`${describe(full ?? product, event.variant)} · 사지 않음: ${why} (상품 페이지 이름으로도 확인)`);
          continue;
        }
        log.note(`${product.title} · 이름 보완 → ${full.title}`);
        product = full;
      }

      // 2) 살 만한 것만 variant 를 해석한다 (없으면 /products/<handle>.js → 막히면 상품 페이지 JSON).
      //    **목록에서 읽은 이름을 버리지 않는다** — 상품 JSON 의 title 에는 색이 없어서, 덮어쓰면 목록 카드(alt)로
      //    걸었던 +black 이 "black 없음" 으로 떨어졌다 (2026-10-10 드랍에서 Black 을 놓친 원인).
      if (!event.variant && !product.variants.length) {
        const resolved = await shop.resolve(product.handle);
        if (resolved) product = withFullName(product, resolved);
      }
      const here: DropEvent = { ...event, product };
      const decision = decide(here, rule, buy);
      if (decision.stage !== "variant") judged.add(event.product.handle);
      const what = describe(product, decision.variant);
      const kindLine =
        event.kind === "restock"
          ? LINES.restock(what)
          : event.kind === "new-variant"
            ? LINES.newVariant(what)
            : LINES.newProduct(what);

      if (!decision.buy) {
        log.note(`${kindLine} · 사지 않음: ${decision.reason}`);
        continue;
      }
      state.events++;
      if (opts.dryRun) {
        // 모니터의 발견 줄 — 첫 묶음이 상품 주소여야 한다 (어댑터 monitorSignal.found).
        log.ok(LINES.foundDry(`${opts.origin}${product.url}`));
        alive.push({ event: here, decision });
        continue;
      }

      // 3) **잡으면 바로 산다.** 남은 상품을 끝까지 판정한 뒤에 사면(후보마다 상품 페이지를 받을 수 있다)
      //    그만큼 늦게 담는다 — 드랍에서는 그 몇 초에 품절이 난다 (2026-10-10 요청).
      log.ok(LINES.found(what));
      await hooks.onEvents([here], [{ event: here, decision }]);
      state.buys++;
      if (opts.stopOnFound || state.buys >= opts.maxBuys || shouldStop()) {
        hooks.onRound?.({ round: state.round, products: state.products, events: state.events, ms });
        log.note(LINES.stopped(`구매를 ${state.buys}번 시도해 멈췄습니다`));
        return { state, ok: true, reason: `구매 ${state.buys}회` };
      }
    }

    // 키워드에는 맞는데 **전 사이즈 품절**인 상품은 diff 가 이벤트를 안 내서 로그에 한 줄도 안 남는다 —
    // "Fuck You Zip Up Hooded Sweatshirt" 가 셋 다 품절이라 "안 잡힌다"로 보였다 (2026-10-15). 상품마다 한 번만 알린다.
    if (rule.onlyAvailable && (!first || !rule.silentFirstScan)) {
      for (const p of products) {
        if (p.available || toldSoldOut.has(p.handle) || !matchProduct(p, rule).ok) continue;
        toldSoldOut.add(p.handle);
        const next = opts.maxRounds === 1 ? "지켜보기로 두면 재입고될 때 삽니다" : "재입고되면 바로 봅니다";
        log.note(`${LINES.stockOut(describe(p, null))} · 키워드에 맞지만 전 사이즈 품절 — ${next}`);
      }
    }

    if (alive.length) {
      hooks.onRound?.({ round: state.round, products: state.products, events: state.events, ms });
      if (opts.stopOnFound) {
        log.note(LINES.stopped("드라이런에서 발견해 멈췄습니다"));
        return { state, ok: true, reason: "발견(드라이런)" };
      }
    }
    hooks.onRound?.({ round: state.round, products: state.products, events: state.events, ms });

    // 다음 확인까지 남은 초를 제자리에서 보여 준다 (대시보드의 카운트다운이 이 줄을 읽는다).
    const wait = withJitter(interval, opts.jitterMs);
    log.tick(LINES.countdown(Math.round(wait / 1000)));
    await sleep(wait);
  }

  log.note(LINES.stopped("사람이 멈추라고 했습니다"));
  return { state, ok: true, reason: "사용자 중지" };
}

/** 한 번만 보고 끝 (--status · --once) */
export async function watchOnce(
  shop: Shop,
  rule: MonitorRule,
  buy: BuyRule,
  options: Partial<WatchOptions>,
  log: WatchLog,
): Promise<{ products: Product[]; events: DropEvent[]; bought: number }> {
  const opts: WatchOptions = { ...DEFAULT_WATCH_OPTIONS, ...options };
  const scanned = await scan(shop, opts.collections, log);
  const { events } = diff(null, scanned.products, { ...rule, silentFirstScan: false });
  const bought: DropEvent[] = [];
  for (const event of events) {
    const decision = decide(event, rule, buy);
    const what = describe(event.product, event.variant);
    if (decision.buy) {
      log.ok(LINES.found(what));
      bought.push(event);
    } else {
      log.note(`${LINES.stockIn(what)} · 사지 않음: ${decision.reason}`);
    }
  }
  const inStock = scanned.products.filter((p) => p.available);
  log.note(`재고 있음 ${inStock.length} / 전체 ${scanned.products.length} (${scanned.note})`);
  return { products: scanned.products, events, bought: bought.length };
}
