/** 담기. 그리고 담기 전에 한 번 더 따져 보는 것들. */
import { run, type Config } from "./config.js";
import { SiteError, type Session } from "./http.js";
import { log } from "./log.js";
import { cartParams, postCart, SOLDOUT, type Goods, type Stock } from "./site.js";
import type { Target } from "./targets.js";
import { comma, sleep } from "./util.js";

// "계정당 구매 수량이 1개로 제한된 상품입니다." 에서 그 숫자.
const QTY_LIMIT_RE = /수량이?\s*(\d+)\s*개/;

/**
 * 사이트가 "수량 제한" 이라고 거절했는가. → 허용 수량 (아니면 null)
 *
 * 이 사이트는 인기 상품에 계정당 개수를 건다. 거절 사유에 숫자가 적혀 있으니 그대로
 * 읽는다. 숫자를 못 찾으면 1개로 본다 — 제한이 걸렸다는 것은 확실하고, 1개는 어느
 * 제한에도 걸리지 않는다.
 */
export function quantityCap(reason: string): number | null {
  const text = String(reason || "");
  if (!text.includes("제한") || !text.includes("수량")) return null;
  const m = QTY_LIMIT_RE.exec(text);
  return m?.[1] ? Number(m[1]) : 1;
}

/**
 * 담는다. 실패하면 max_attempts 까지 다시 시도한다. → (성공 여부, 사유, 담은 수량)
 *
 * **수량 제한에 걸리면 낮춰서 곧장 다시 해본다.** 2개를 담으려다 "계정당 1개" 소리를
 * 듣고 물러서는 것은 2개도 1개도 못 사는 길이다. 서버가 몇 개까지 되는지 말해 주니 그
 * 수로 낮춰 곧장 다시 두드린다. 드랍에서는 이 한 번이 마지막 기회다.
 *
 * 낮추는 것은 재시도 횟수로 세지 않는다 — 같은 일을 다시 하는 게 아니라 다른 일이다.
 */
export async function doCart(
  cfg: Config, s: Session, goods: Goods, mode: string, ea: number,
): Promise<{ ok: boolean; reason: string; ea: number }> {
  const attempts = Math.max(1, Number(cfg.max_attempts || 1));
  const delay = cfg.retry_delay_seconds ?? 2;
  let reason = "";
  let lowered = false;
  let attempt = 0;

  while (attempt < attempts) {
    attempt += 1;
    const params = cartParams(goods, mode, ea);

    let ok: boolean;
    if (run.dryRun) {
      log.info(`[dry-run] 담기 생략: ${JSON.stringify(params)}`);
      ok = true;
      reason = "";
    } else {
      try {
        const got = await postCart(s, params);
        ok = got.ok;
        reason = got.reason;
      } catch (e) {
        if (!(e instanceof SiteError)) throw e;
        ok = false;
        reason = e.message;
      }
    }

    if (ok) {
      log.info(`담기 성공 (${attempt}/${attempts}) — ${goods.name} ×${ea} [${mode}]`);
      return { ok: true, reason: "", ea };
    }

    log.warn(`담기 실패 (${attempt}/${attempts}) — ${goods.name}: ${reason || "사유 없음"}`);

    const cap = quantityCap(reason);
    if (cap !== null && cap < ea && !lowered) {
      log.warn(`수량 제한입니다 — ${cap}개로 낮춰 곧장 다시 담습니다`);
      ea = cap;
      lowered = true;
      attempt -= 1;
      continue;
    }

    if (attempt < attempts && delay) await sleep(delay * 1000);
  }
  return { ok: false, reason: reason || "사유 없음", ea };
}

/**
 * 사이트가 한 번 삐끗했다고 한 바퀴를 통째로 버리지 않는다.
 *
 * 재고가 열리는 순간에 조회가 한 번 튕겼다고 다음 주기까지 기다리면 그 사이에 끝난다.
 * 바로 다시 물어보는 편이 낫다. 마지막까지 안 되면 예외를 그대로 올려 부른 쪽이 판단한다.
 */
export async function retrying<T>(cfg: Config, what: string, call: () => Promise<T>): Promise<T> {
  const attempts = Math.max(1, Number(cfg.max_attempts || 1));
  const delay = cfg.retry_delay_seconds ?? 2;

  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      // 대기열은 고장이 아니다. 다시 두드리면 안 되므로 그대로 위로 올린다.
      if (!(e instanceof SiteError) || attempt >= attempts) throw e;
      log.warn(`${what} 실패 (${attempt}/${attempts}) — ${e.message}`);
      if (delay) await sleep(delay * 1000);
    }
  }
}

/** 담기 전 마지막 관문. 담지 말아야 할 이유가 있으면 그것을 돌려준다. */
export function blockingReason(
  cfg: Config, target: Pick<Target, "max_price">, goods: Goods, stock: Stock,
): string | null {
  if (stock.stock <= 0) return "재고가 0으로 돌아갔습니다";
  // 감시는 재고 수량으로 하지만, 담기 직전에는 상품 페이지 판정도 함께 본다.
  // 재고가 남아 있어도 판매가 닫혀 있을 수 있다.
  if (goods.status === SOLDOUT) return "상품 페이지가 품절 상태입니다";
  if (goods.has_option && !cfg.allow_option_goods) {
    return "옵션 상품입니다 (옵션마다 재고가 달라 직접 골라야 합니다)";
  }
  const limit = target.max_price || cfg.max_price || 0;
  const price = stock.price - stock.event_discount;
  if (limit && price > limit) {
    return `가격이 상한을 넘었습니다 (${comma(price)}원 > ${comma(limit)}원)`;
  }
  return null;
}
