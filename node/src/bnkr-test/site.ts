/**
 * 반다이남코코리아몰이 쓰는 것들. bnkr_buy.py 의 조회·담기 부분과 같은 엔드포인트다.
 *
 * 상품 페이지의 버튼을 뜯어 알아낸 것이고, 알아낸 사실 자체는 파이썬 쪽 주석에 적혀 있다.
 * 여기서는 그 사실을 다시 적지 않고 옮기기만 한다.
 *
 *   POST /order/cart_act_ajax.do   mode=ADD|DIRECT|GIFT & gno & cate & cea & isemps=F & ispickup=F
 *   POST /goods/goodsInfo_ajax.do  gno       → {"stock":59, "price":25000, …}  113바이트
 *   POST /member/member_login_check_ajax.do  → {"authmemberno":…, "cartSize":…}
 *   GET  /goods/detail.do?gno=…    담기에 필요한 cate·goodsName·freeGift* 가 숨은 값에 있다
 */
import { parse, type HTMLElement } from "node-html-parser";
import { Session, SiteError } from "./http.js";
import { toInt } from "./util.js";
import type { Mode, State } from "./config.js";

export const SITE = "https://www.bnkrmall.co.kr";
export const DETAIL_URL = `${SITE}/goods/detail.do`;
export const GOODS_INFO_URL = `${SITE}/goods/goodsInfo_ajax.do`;
export const CART_ACT_URL = `${SITE}/order/cart_act_ajax.do`;
export const LOGIN_CHECK_URL = `${SITE}/member/member_login_check_ajax.do`;
export const CART_URL = `${SITE}/order/cart.do`;

/** mode 별로 담긴 뒤에 열어야 할 곳. 사이트의 actCart() 가 이동하는 주소 그대로다. */
export const LANDING: Record<Mode, string> = {
  ADD: CART_URL,
  DIRECT: `${SITE}/order/order.do?direct=1`,
  GIFT: `${SITE}/order/gift_cart.do?direct=1`,
};
export const MODE_LABEL: Record<Mode, string> = {
  ADD: "장바구니에 담음", DIRECT: "바로구매로 담음", GIFT: "선물하기로 담음",
};
export const LANDING_LABEL: Record<Mode, string> = {
  ADD: "결제하러 가기", DIRECT: "주문서 열기", GIFT: "선물 주문서 열기",
};

/** 크롬에서 어디까지 눌렀는지. 결제 확정은 어느 쪽이든 사람이 한다. */
export const STAGE_LABEL: Record<string, string> = {
  opened: "크롬에 띄웠습니다. 필수 동의 2개와 결제하기는 직접 눌러주세요.",
  agreed: "필수 동의 2개를 체크했습니다. 결제하기는 직접 눌러주세요.",
  submitted: "결제하기까지 눌렀습니다. 결제창에서 마무리해 주세요.",
};

export const IN_STOCK = "instock";
export const SOLDOUT = "soldout";
export type Status = typeof IN_STOCK | typeof SOLDOUT;
export const STATUS_LABEL: Record<string, string> = { [IN_STOCK]: "구매 가능", [SOLDOUT]: "품절" };

const GNO_RE = /(\d{4,})/;
const DETAIL_STATE_RE = /class="type basic\s+([A-Za-z]+)"/;
const GOODS_KIND_RE = /var\s+goodsKind\s*=\s*'(\d+)'/;

export interface Stock { stock: number; price: number; event_discount: number }

export interface Goods {
  gno: string;
  cate: string;
  name: string;
  price: number;
  event_discount: number;
  freegift_no: number;
  freegift_stock: number;
  goods_kind: string;
  has_option: boolean;
  status: Status | null;
  /** 파이썬 판이 상태 파일에 적어 두는 이름 그대로다. 초 단위 유닉스 시각. */
  fetched_at?: number;
}

/** gno 만 적어도 되고, 상품 URL 을 통째로 붙여넣어도 된다. */
export function parseGno(value: unknown): string | null {
  return GNO_RE.exec(String(value ?? ""))?.[1] ?? null;
}

export function goodsUrl(gno: string): string {
  return `${DETAIL_URL}?gno=${gno}`;
}

/** get_text(" ", strip=True) 와 같은 것. 요소 사이를 한 칸 띄워 이어 붙인다. */
export function textOf(node: HTMLElement | null | undefined): string | null {
  if (!node) return null;
  const bits: string[] = [];
  const walk = (n: { nodeType: number; rawText?: string; childNodes: unknown[] }) => {
    if (n.nodeType === 3) {
      const t = (n.rawText ?? "").replace(/\s+/g, " ").trim();
      if (t) bits.push(t);
      return;
    }
    for (const kid of n.childNodes) walk(kid as never);
  };
  walk(node as never);
  return bits.join(" ") || null;
}

/**
 * 감시용 한 방. 113바이트, 상세 페이지 없이 지금 재고와 지금 가격을 준다.
 * 사이트도 담기 직전에 이걸 한 번 부른다(가격 재확인).
 */
export async function fetchStock(s: Session, gno: string): Promise<Stock> {
  const res = await s.request(GOODS_INFO_URL, { method: "POST", form: { gno } });
  const data = await s.json<{
    result?: { code?: number; msg?: string };
    price?: number; eventDiscountPrice?: number; stock?: number;
  }>(res, `재고 조회(${gno})`);
  if (data.result?.code) {
    throw new SiteError(`재고 조회(${gno}) 거절: ${data.result.msg || "사유 없음"}`);
  }
  return {
    stock: Number(data.stock ?? 0),
    price: Number(data.price ?? 0),
    event_discount: Number(data.eventDiscountPrice ?? 0),
  };
}

export interface LoginInfo { no: number; name: string; level: string; cart_size: number }

export async function loginInfo(s: Session): Promise<LoginInfo> {
  const res = await s.request(LOGIN_CHECK_URL, { method: "POST", form: {} });
  const data = await s.json<Record<string, unknown>>(res, "로그인 확인");
  return {
    no: Number(data["authmemberno"] ?? 0),
    // 이름은 URL 인코딩된 채로 온다 (%EC%95%88…)
    name: decodeURIComponent(String(data["authmembername"] ?? "")),
    level: String(data["authmemberlevelname"] ?? ""),
    cart_size: Number(data["cartSize"] ?? 0),
  };
}

/**
 * 담기에 필요한 값들. 상품마다 한 번만 받아서 캐시한다.
 * cate·goodsName·freeGift* 는 잘 바뀌지 않는다. 매 주기에 160KB 를 받을 이유가 없다.
 */
export async function fetchGoods(s: Session, gno: string): Promise<Goods> {
  const html = await s.html(`${DETAIL_URL}?gno=${gno}`, `상품 ${gno}`);
  const root = parse(html);

  const form = root.querySelector('form[name="Frm"]');
  if (!form) throw new SiteError(`상품 ${gno}: 주문 폼(form[name=Frm])이 없습니다`);
  const fields = new Map<string, string>();
  for (const input of form.querySelectorAll("input[name]")) {
    const name = input.getAttribute("name");
    if (name) fields.set(name, input.getAttribute("value") ?? "");
  }

  const state = DETAIL_STATE_RE.exec(html)?.[1];
  const goodsKind = GOODS_KIND_RE.exec(html)?.[1] ?? "";
  // 옵션 상품: 옵션마다 재고가 따로라 상품 단위로 담으면 엉뚱한 걸 사게 된다.
  //
  // 옵션 판정에 문자열 검색을 쓰면 안 된다 — 페이지 스크립트 본문에 늘
  // select[name=xoption] 을 고르는 줄이 들어 있어 옵션 없는 상품도 걸린다. 트리에서 센다.
  //
  // goodsKind 로 판정하지 않는다. '200' 인데 옵션 칸이 없는 상품이 있다 (2026-10-07, gno 9794205
  // S.H.피규아트 — 폼에 xoption 이 없고, 사이트가 담을 때 보내는 값도 일반 상품과 같다). 사이트
  // 스크립트는 xoption 칸을 읽기만 하고 만들지 않으니, 옵션이 있으면 그 칸이 폼에 박혀 온다.
  const hasOption = form.querySelectorAll('select[name="xoption"]').length > 0;

  return {
    gno,
    cate: fields.get("cate") ?? "",
    name: fields.get("goodsName") || `상품 ${gno}`,
    price: toInt(fields.get("price")) ?? 0,
    event_discount: toInt(fields.get("eventDiscountPrice")) ?? 0,
    freegift_no: toInt(fields.get("freeGiftGoodsNo")) ?? 0,
    freegift_stock: toInt(fields.get("freeGiftStock")) ?? 0,
    goods_kind: goodsKind,
    has_option: hasOption,
    // 재고는 구매 버튼 묶음의 컨테이너 클래스 한 자리다.
    status: state === "default" ? IN_STOCK : state === "soldOut" ? SOLDOUT : null,
  };
}

/**
 * 상품 고정 정보를 상태 파일에 캐시해 두고 재사용한다.
 *
 * maxAge 를 주면 그만큼 지난 캐시만 다시 받는다. 담기 직전에 매번 상세를 받으면 160KB 를
 * 기다리느라 0.5초를 버리는데, 그 0.5초가 하필 재고가 열린 직후다. 지켜보는 동안 미리
 * 새로 받아 두면 같은 신선도를 공짜로 얻는다.
 */
export async function goodsMeta(
  s: Session, state: State, gno: string,
  opts: { refresh?: boolean; maxAge?: number } = {},
): Promise<Goods> {
  const cache = (state.goods ??= {});
  const meta = cache[gno] as Goods | undefined;

  if (meta && !opts.refresh) {
    // maxAge 를 준 쪽은 신선도를 따진다. 안 준 쪽은 있으면 그냥 쓴다.
    if (opts.maxAge === undefined) return meta;
    if (Date.now() / 1000 - (meta.fetched_at ?? 0) < opts.maxAge) return meta;
  }

  const fresh = await fetchGoods(s, gno);
  fresh.fetched_at = Date.now() / 1000;
  cache[gno] = fresh as unknown as Record<string, unknown>;
  return fresh;
}

/**
 * 사이트의 actCart() 가 만드는 것과 같은 파라미터.
 * 택배 수령(ispickup=F)·일반가(isemps=F)로 고정한다. 매장 픽업이나 사원할인은 주문서에서 바꾼다.
 */
export function cartParams(goods: Goods, mode: string, ea: number): Record<string, string> {
  const params: Record<string, string> = {
    mode, gno: goods.gno, cate: goods.cate, cea: String(ea), isemps: "F",
  };
  // 사이트도 사은품 재고가 남아 있을 때만 붙인다.
  if ((goods.freegift_no ?? 0) > 0 && (goods.freegift_stock ?? 0) > 0) {
    params["freegiftgoodsno"] = String(goods.freegift_no);
  }
  params["ispickup"] = "F";
  return params;
}

/** → (성공 여부, 사이트가 준 사유) */
export async function postCart(
  s: Session, params: Record<string, string>,
): Promise<{ ok: boolean; reason: string }> {
  const res = await s.request(CART_ACT_URL, { method: "POST", form: params });
  const data = await s.json<{ result?: { code?: number; msg?: string } }>(res, "담기");
  const code = Number(data.result?.code ?? 0);
  return { ok: code === 0, reason: (data.result?.msg ?? "").trim() };
}

export interface CartItem {
  gno: string | null; name: string; series: string | null; ea: number; price: number | null;
}

/** 장바구니에 담긴 것들. 행마다 상품 링크가 있는 것만 센다. */
export async function cartItems(s: Session): Promise<CartItem[]> {
  const root = parse(await s.html(CART_URL, "장바구니"));
  const items: CartItem[] = [];
  for (const row of root.querySelectorAll(".order_list .row")) {
    const classes = row.classList;
    if (classes.contains("top") || classes.contains("item_none")) continue;
    const a = row.querySelector('a[href*="gno="]');
    if (!a) continue;
    // .col.info 를 통째로 읽으면 수량 위젯의 "빼기 1 더하기" 까지 딸려 온다.
    items.push({
      gno: parseGno(a.getAttribute("href") ?? ""),
      name: textOf(row.querySelector(".col.info .name")) || textOf(a) || "",
      series: textOf(row.querySelector(".col.info .series")),
      ea: toInt(textOf(row.querySelector(".amount .num"))) ?? 1,
      price: toInt(textOf(row.querySelector(".col.price"))),
    });
  }
  return items;
}

/**
 * 지금 세션이 든 MEMBER_TOKEN 이 몇 분 남았는가. → 분 (모르면 null)
 *
 * 이 토큰은 발급 뒤 한 시간이다. 사이트가 요청마다 새로 내주고 우리는 그것을 받아 쓰므로
 * 도는 동안은 만료가 계속 뒤로 밀린다 — **고 알려져 있다.** 정말 밀리는지는 보여야 안다.
 * 숫자가 60 근처에서 오르내리면 갱신되는 것이고, 계속 줄어들면 안 되는 것이다.
 */
export function tokenLeft(s: Session): number | null {
  const token = s.value("MEMBER_TOKEN");
  if (!token || token.split(".").length !== 3) return null;
  try {
    const body = token.split(".")[1]!;
    const json = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as { exp?: number };
    if (!json.exp) return null;
    return Math.floor((json.exp - Date.now() / 1000) / 60);
  } catch {
    return null;
  }
}
