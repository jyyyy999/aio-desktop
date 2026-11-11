/**
 * 구매하기 — 상품 페이지의 "구매하기" 버튼이 하는 일을 API 로 그대로 한다.
 *
 * 버튼이 하는 일 (사이트 번들의 handleClickPurchase 에서 읽었다, 2026-11-11):
 *
 *   1. POST /v2/carts/<상품번호>   {count, sizeId, answer?}   장바구니에 담는다
 *   2. GET  /v2/carts                                        담긴 것 가운데 이 상품·사이즈의 cartId 를 찾는다
 *   3. POST /v2/orders             [cartId, …]               주문을 만든다 → 사이트는 /order (주문서) 로 넘어간다
 *
 * 창에서 버튼을 찾아 누르는 것보다 빠르고(요청 셋), 화면이 바뀌어도 안 깨진다. 결제(아임포트·KCP)는 하지 않는다 —
 * 주문서를 크롬으로 열어 사람에게 넘긴다 (다른 사이트의 order_action "open" 과 같은 데까지).
 *
 * 장바구니 응답은 실제로 봤다 (2026-11-11): {carts: [{cartId(글자), count, product: {id}, size: {id}}], deliveryPrice}.
 *
 * 발매 전이면 발매 시각까지 기다렸다가 누른다. 기다리는 동안 토큰을 살려 두고, 시각이 되면 몇 초 동안 거듭 누른다 —
 * PC 시계와 서버 시계가 조금 어긋나도, 열리는 순간 서버가 잠깐 거절해도 놓치지 않게.
 */
import { log, sayOk, sayStar, sayStep } from "../log.js";
import { UI } from "../ui.js";
import { comma, priceText, sleep, wait } from "../util.js";
import { Busy, fetchSizes, fetchSnapshot, FetchFailed, notYetOpen, pageUrl, Rejected, type Product, type SizeStock } from "./api.js";
import { openOrder, submitOrder, WarmChrome } from "./browser.js";
import { ORDER_URL, run } from "./config.js";
import { LINES } from "./lines.js";
import { authed, keepFresh, NotLoggedIn, type Session } from "./session.js";

export interface BuyRequest {
  id: string;
  /** 고를 사이즈 — 앞에서부터 재고 있는 첫 것. 비면 사이즈가 하나뿐인 상품만 된다. */
  sizes: string[];
  ea: number;
  /** 상품에 문제가 붙어 있을 때의 답. */
  answer: string;
  /** 주문서를 크롬으로 열까. 끄면 주문만 만들고 주소를 찍는다. */
  open: boolean;
  /** 어디까지 갈까 — 주문서만(open) / 결제하기·비밀번호까지(submit). */
  action: "open" | "submit";
  /** 결제 비밀번호 (프로필 것 · 환경변수). 6자리. 없으면 결제하기까지만 누르고 창을 넘긴다. */
  pin: string;
  /** 지켜보기 — 품절이면 끝내지 않고 intervalSec 마다 다시 본다. 드라이런과 같이 쓰면 사지 않고 계속 본다 (모니터). */
  waitStock: boolean;
  intervalSec: number;
  /** 한 번만 — 발매 전이면 기다리지 않고 끝낸다. */
  once: boolean;
  /** 이 가격을 넘으면 사지 않는다. 0 이면 상한 없음. */
  maxPrice: number;
}

export type BuyResult =
  | { kind: "ordered"; opened: boolean }
  | { kind: "dry" }
  | { kind: "failed"; step: string; reason: string };

/** 발매 시각보다 이만큼 먼저 누르기 시작한다 (PC 시계가 조금 늦을 때를 대비). */
const LEAD_MS = 300;
/** 발매 시각에 맞춰 기다렸을 때, 거절당해도 이만큼은 거듭 누른다. */
const OPEN_WINDOW_MS = 15_000;
const RETRY_GAP_MS = 350;
/** 서버가 몰려서 쳐낼 때(429·307) 처음 쳐낸 때부터 이만큼은 거듭 누른다. */
const BUSY_WINDOW_MS = 60_000;

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** 살 사이즈를 고른다. 재고 있는 것만, 적어 준 순서대로. → 고른 것, 못 고르면 까닭 */
export function pickSize(sizes: SizeStock[], wanted: string[]): { size: SizeStock } | { why: string; soldOut: boolean } {
  const all = sizes.map((s) => s.name).join(", ");
  if (!sizes.length) return { why: "사이즈가 없습니다", soldOut: false };
  if (!wanted.length) {
    if (sizes.length > 1) return { why: `사이즈를 골라 주세요 (--size) — ${all}`, soldOut: false };
    return sizes[0]!.inStock ? { size: sizes[0]! } : { why: `${sizes[0]!.name} 품절`, soldOut: true };
  }
  const known = wanted.map((w) => sizes.find((s) => same(s.name, w))).filter((s): s is SizeStock => !!s);
  if (!known.length) return { why: `그런 사이즈가 없습니다 (${wanted.join(", ")}) — ${all}`, soldOut: false };
  const hit = known.find((s) => s.inStock);
  return hit ? { size: hit } : { why: `${known.map((s) => s.name).join(", ")} 품절`, soldOut: true };
}

/** 장바구니에서 이 상품·사이즈의 cartId 들. 사이트의 같은 함수(eQ)와 같은 거르기. */
function cartIdsOf(payload: unknown, productId: number, sizeId: number): string[] {
  const carts = (payload as { carts?: unknown } | null)?.carts;
  if (!Array.isArray(carts)) return [];
  return (carts as Record<string, unknown>[])
    .filter((c) => (c["product"] as { id?: unknown } | undefined)?.id === productId && (c["size"] as { id?: unknown } | undefined)?.id === sizeId)
    .map((c) => c["cartId"])
    // cartId 는 14자 글자다 (2026-11-11 실제 응답). 주문을 만들 때 받은 그대로 돌려보낸다.
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

const findInCart = async (session: Session, productId: number, sizeId: number): Promise<string[]> =>
  cartIdsOf(await authed(session, "carts"), productId, sizeId);

/** 구매하기 한 번 — 담고, cartId 를 찾고, 주문을 만든다. 안 되면 던진다 (Rejected · FetchFailed · NotLoggedIn). */
async function press(session: Session, req: BuyRequest, product: Product, size: SizeStock): Promise<void> {
  const productId = Number(product.id);
  // 이미 담겨 있으면 또 담지 않는다 — 1인 수량을 넘겨 주문이 막힌다 (사이트도 그때는 "장바구니를 확인해주세요" 를 띄운다).
  let cartIds = await findInCart(session, productId, size.id);
  if (!cartIds.length) {
    await authed(session, `carts/${productId}`, {
      method: "POST",
      body: { count: req.ea, sizeId: size.id, ...(product.question ? { answer: req.answer } : {}) },
    });
    cartIds = await findInCart(session, productId, size.id);
    if (!cartIds.length) throw new FetchFailed("담았는데 장바구니에서 찾지 못했습니다 — 응답 모양이 바뀌었을 수 있습니다.");
    log.info(LINES.checkout(`장바구니에 담았습니다 (${size.name} · ${req.ea}개)`));
  } else {
    log.info(LINES.checkout(`이미 장바구니에 있습니다 (${size.name}) — 그대로 주문합니다`));
  }
  await authed(session, "orders", { method: "POST", body: cartIds });
}

/**
 * 발매 시각까지 기다린다. 멀리 남았으면 느긋하게 세면서 토큰을 살려 두고, 마지막 몇 초는 촘촘히 잔다.
 * 사이즈 재고는 기다리는 동안 다시 받지 않는다 — 누르기 직전에 한 번 받는다.
 */
async function waitUntilOpen(session: Session, product: Product): Promise<void> {
  const openAt = product.availableFrom!.getTime() - LEAD_MS;
  for (;;) {
    const left = openAt - Date.now();
    if (left <= 0) return;
    if (left > 5000) {
      // 토큰은 15분짜리다. 열리는 순간에 갱신하느라 늦지 않게, 2분 안쪽으로 남으면 미리 바꿔 둔다.
      await keepFresh(session, 2 * 60_000);
      await wait(Math.min(30, (left - 4000) / 1000), `발매 대기 · ${comma(Math.ceil(left / 1000))}초 남음`);
    } else {
      await sleep(Math.min(left, 100));
    }
  }
}

/**
 * 구매하기. 주문서를 크롬으로 열 판이면(드라이런·--no-open 이 아니면) 살 수 있는 상품인지 본 **바로 뒤에** 크롬을
 * 미리 띄워 둔다 (browser.ts 의 WarmChrome) — 주문이 잡히면 그 탭에서 주문서를 연다. 주문까지 못 가고 끝나면 닫는다.
 */
export async function buy(session: Session, req: BuyRequest): Promise<BuyResult> {
  const warm = new WarmChrome(pageUrl(req.id));
  try {
    const result = await buyWith(session, req, warm);
    if (result.kind !== "ordered") await warm.release();
    return result;
  } catch (e) {
    await warm.release();
    throw e;
  }
}

async function buyWith(session: Session, req: BuyRequest, warm: WarmChrome): Promise<BuyResult> {
  const fail = (step: string, reason: string): BuyResult => {
    log.error(LINES.failed(step, reason));
    return { kind: "failed", step, reason };
  };

  const snap = await fetchSnapshot(req.id);
  const product = snap.product;
  const url = pageUrl(req.id);
  const name = [product.name, product.color].filter(Boolean).join(" · ");
  log.info(LINES.product(name, priceText(product.price)));

  // 사이트가 버튼을 누르기 전에 막는 것들 — 눌러 봐야 안 되므로 여기서 멈춘다.
  if (product.appOnly) return fail("상품 확인", "앱 전용 상품입니다 — 웹에서는 못 삽니다");
  if (product.offlineOnly) return fail("상품 확인", "오프라인 전용 판매 상품입니다");
  if (product.question && !req.answer) return fail("상품 확인", `문제의 정답이 필요합니다 (--answer) — ${product.question}`);
  if (product.perUser && req.ea > product.perUser) return fail("상품 확인", `1인 ${product.perUser}개까지 살 수 있습니다 (--ea ${req.ea})`);
  if (req.maxPrice && product.price > req.maxPrice) return fail("상품 확인", `가격 ${priceText(product.price)} 이 상한가 ${priceText(req.maxPrice)} 을 넘습니다`);

  // 주문서를 열 판이면 지금 크롬을 띄운다 — 기다리는 동안(발매 대기·감시) 크롬이 뜨고 번들이 올라온다.
  // "지금 구매" 도 아래 API 요청(담기·주문 생성)과 나란히 뜬다. 띄우는 것은 백그라운드라 누르기를 늦추지 않는다.
  const warmUp = (): void => {
    if (req.open && !run.dryRun) warm.start();
  };

  let waited = false;
  let round = 0;
  if (notYetOpen(product)) {
    // 발매 전에는 품절이어도 기다린다 (재고가 발매 직전에 풀리는 판이 있다). 사이즈 이름이 틀린 것만 지금 알린다.
    const early = pickSize(snap.sizes.map((s) => ({ ...s, inStock: true })), req.sizes);
    if ("why" in early) return fail("옵션 고르기", early.why);
    const when = product.availableFrom!.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    if (req.once) {
      log.info(LINES.stockOut(`${name} (발매 전 — ${when})`));
      return fail("상품 확인", `아직 발매 전입니다 — ${when} (한국 시간)`);
    }
    sayStep(`발매 전입니다 — ${when} (한국 시간) 에 누릅니다. PC 시계가 맞는지 확인해 두세요.`);
    if (run.dryRun && !req.waitStock) {
      sayOk(LINES.foundDry(url));
      return { kind: "dry" };
    }
    warmUp();
    log.info(LINES.stockOut(`${name} (발매 전 — ${when})`));
    // 지켜보기는 발매가 멀었으면 평소 간격으로 바퀴를 센다 (대시보드가 회차로 살아 있음을 본다). 가까워지면 시각에 맞춘다.
    while (req.waitStock && product.availableFrom!.getTime() - Date.now() > (req.intervalSec + 5) * 1000) {
      log.info(LINES.round(++round, 1, 0));
      if (session.refreshToken) await keepFresh(session, 2 * 60_000).catch(() => undefined);
      await wait(req.intervalSec, `발매 대기 · ${name} · ${when}`);
    }
    await waitUntilOpen(session, product);
    waited = true;
  } else {
    warmUp();
  }

  let deadline = Date.now() + (waited ? OPEN_WINDOW_MS : 0);
  let busySince = 0;
  let size: SizeStock | null = null;
  let lastWhy = "";
  let announced = false;
  for (let attempt = 1; ; attempt++) {
    round += 1;
    const started = Date.now();
    let why: string;
    let soldOut = false;
    try {
      // 재고는 누를 때마다 새로 받는다 (161B) — 발매 순간에 풀리는 재고를 봐야 한다.
      const picked = pickSize(attempt === 1 && !waited ? snap.sizes : await fetchSizes(req.id), req.sizes);
      if ("why" in picked) {
        why = picked.why;
        soldOut = picked.soldOut;
        // 고르려던 사이즈가 아예 없는 것은 기다려도 안 생긴다.
        if (!soldOut) return fail("옵션 고르기", why);
        announced = false;
        if (req.waitStock) log.info(LINES.stockOut(`${name} (${why})`));
      } else {
        size = picked.size;
        const stock = `${size.name}${size.stock !== null ? ` ${comma(size.stock)}개` : ""}`;
        if (req.waitStock) log.info(LINES.stockIn(`${name} · ${stock}`));
        if (run.dryRun) {
          // 판매가 이어지는 동안은 한 번만 알린다 — 다시 품절이 되었다 풀리면 또 알린다.
          if (!announced) sayOk(LINES.foundDry(url));
          announced = true;
          if (!req.waitStock) return { kind: "dry" };
          why = "";
        } else {
          log.info(LINES.buying(`${product.name} · ${req.ea}개`));
          log.info(LINES.option(stock));
          await press(session, req, product, size);
          break;
        }
      }
    } catch (e) {
      if (e instanceof NotLoggedIn) return fail("구매하기", LINES.sessionDead(e.message));
      if (!(e instanceof Rejected) && !(e instanceof FetchFailed)) throw e;
      // 로그인이 없다는 거절은 거듭 눌러도 같다.
      if (e instanceof Rejected && (e.status === 401 || e.status === 403)) return fail("구매하기", LINES.sessionDead(e.message));
      why = e.message;
      // 몰려서 쳐낸 것(429·307)은 대기열이 아니라 다시 두드리면 들어가는 것이다 — 발매를 기다린 것이 아니어도 한동안 거듭 누른다.
      if (e instanceof Busy && !busySince) {
        busySince = Date.now();
        deadline = Math.max(deadline, busySince + BUSY_WINDOW_MS);
      }
    }

    // 발매 직후·몰릴 때의 짧은 창 — 촘촘히 거듭 누른다.
    if (Date.now() < deadline) {
      if (why && why !== lastWhy) log.warn(`아직 안 됩니다 (${why}) — 거듭 누릅니다`);
      lastWhy = why;
      await sleep(RETRY_GAP_MS);
      continue;
    }
    // 지켜보기 — 품절(또는 드라이런의 판매 중)이면 간격을 두고 다시 본다. 그 밖의 실패는 지켜보기에서도 다음 바퀴에 다시 해 본다.
    if (req.waitStock) {
      if (why && !soldOut && why !== lastWhy) log.warn(`이번 바퀴는 못 했습니다 (${why}) — 다음 바퀴에 다시 합니다`);
      lastWhy = why;
      log.info(LINES.round(round, 1, Math.round((Date.now() - started) / 1000)));
      // 오래 지켜보는 동안 토큰이 죽지 않게 — 재고가 풀리는 순간에 갱신하느라 늦으면 안 된다.
      if (session.refreshToken) await keepFresh(session, 2 * 60_000).catch(() => undefined);
      await wait(req.intervalSec, `감시 중 · ${name}`);
      continue;
    }
    return fail(size ? "구매하기" : "옵션 고르기", why);
  }

  sayOk(LINES.checkout(`주문을 만들었습니다 — ${ORDER_URL}`));
  UI.status("");
  if (!req.open) {
    sayStar(`${LINES.stoppedAtOrder()} (로그인한 브라우저에서 ${ORDER_URL} 을 여세요)`);
    return { kind: "ordered", opened: false };
  }

  // --action submit: 결제하기를 누르고, 비밀번호가 있으면 토스 자판까지 눌러 결제를 요청한다.
  if (req.action === "submit") {
    let outcome: Awaited<ReturnType<typeof submitOrder>>;
    try {
      outcome = await submitOrder(session, req.pin, warm);
    } catch (e) {
      log.warn(`결제 화면을 열지 못했습니다: ${String((e as Error).message || e).split("\n")[0]}`);
      outcome = { kind: "waiting", why: "결제 화면을 열지 못했습니다 — 창에서 결제해 주세요" };
    }
    if (outcome.kind === "paid") {
      sayOk(LINES.paid(outcome.orderNumber));
      return { kind: "ordered", opened: true };
    }
    if (outcome.kind === "failed") return fail("결제", outcome.why);
    // 비밀번호가 없거나 자판을 못 읽었다 — 주문서·비밀번호 창은 열어 두고 사람에게 넘긴다.
    sayStar(LINES.pinWaiting(outcome.why));
    return { kind: "ordered", opened: true };
  }

  let opened = false;
  try {
    opened = await openOrder(session, warm);
  } catch (e) {
    log.warn(`크롬 창을 띄우지 못했습니다: ${String((e as Error).message || e).split("\n")[0]}`);
  }
  if (opened) sayStar(LINES.stoppedAtOrder());
  else sayStar(`주문은 만들어졌습니다 — 창이 주문서를 못 열었으니, 로그인한 브라우저에서 ${ORDER_URL} 을 직접 열어 결제해 주세요`);
  return { kind: "ordered", opened };
}
