/**
 * 재고·가격·이름을 읽는다.
 *
 * **재고는 상품 API 로 본다. ld+json 은 믿지 않는다.** (2026-09-18)
 *
 * 처음에는 상품 페이지 <head> 의 schema.org Product(ld+json)를 봤다. 그런데 이게
 * **품절인 상품에도 InStock 이라고 적혀 나온다.** 실제로 그렇게 두 번 헛걸음했다:
 *
 *   LM8800286278528  ld+json InStock  / API SOUT(품절)·STP(판매중지)
 *                    → 크롬에서 구매하기를 눌러도 #toGoPurchase 로만 가고 주문서가 안 열림
 *   LM8800286279990  ld+json InStock  / API SOUT(실재고 0 에 의한 일시품절)·STP
 *                    → 화면은 "현재 판매 중인 상품이 아닙니다", 구매 버튼 자체가 없음
 *
 * 화면이 쓰는 것은 아래 API 다. 상품 페이지가 뜨면서 이걸 불러 버튼을 그린다.
 * 쿠키 없이 되고, 0.3초·22KB 로 상품 페이지 한 장과 값이 비슷하다 (재 봤다).
 *
 *   GET https://pbf.lotteon.com/product/v2/detail/search/base/sitm/{sitmNo}
 *       ?sitmNo={sitmNo}&isNotContainOptMapping=true
 *
 *   data.basicInfo.sitmSlStatCd   단품 판매상태. SALE 판매중 / SOUT 품절
 *   data.basicInfo.spdSlStatCd    상품 판매상태. SALE 판매중 / STP 판매중지
 *   data.basicInfo.pdNm           이름
 *   data.priceInfo.slPrc          판매가 (immdDcAplyTotAmt 가 즉시할인)
 *   data.dlvInfo.dvRsvDvsCd       RSV_DV(예약배송)면 예약주문기간 안이어야 산다 — notSaleWhy
 *
 * ld+json 쪽 함수(ldBlocks·findProduct·readStock)는 --probe 가 대조용으로 쓰려고 남겨 둔다.
 */
import { IN_STOCK, SOLDOUT, type Status } from "./config.js";
import { getPage, SiteError, type Session } from "./http.js";

const STOCK_API = "https://pbf.lotteon.com/product/v2/detail/search/base/sitm";
// 판매중이라는 표시. 이것 말고는 전부 못 사는 것으로 본다 — SOUT·STP 말고도 판매대기·
// 판매종료 따위가 있을 텐데, 어느 것이든 구매 버튼이 없기는 마찬가지다.
const ON_SALE = "SALE";

// <head> 에 여러 개가 들어 있다(BreadcrumbList·Organization…). 전부 훑어 Product 를 고른다.
const LD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// 재고가 있다는 표시. **InStock 만 확인했다.** 나머지는 schema.org 가 정한 이름들이라
// 함께 받아 두지만, 롯데온이 어느 것을 쓰는지는 품절인 상품을 볼 때 알게 된다.
const IN_STOCK_MARKS = ["InStock", "InStoreOnly", "LimitedAvailability", "PreOrder", "PreSale", "BackOrder"];
const SOLDOUT_MARKS = ["OutOfStock", "SoldOut", "Discontinued"];

export interface StockInfo {
  status: Status;
  name: string;
  price: number;
  /** ld+json 에 적혀 있던 그대로. 왜 그렇게 판정했는지 사람이 볼 재료다. */
  raw_status: string;
  sku: string;
  /**
   * 아직 안 열렸으면 열리는 시각 (한국 시각 YYYYMMDDHHmmss). 모르거나 이미 열렸으면 "".
   * 이걸 보고 크롬을 미리 띄워 대기열에 세운다 (warm.ts).
   */
  opens_at?: string;
}

type Node = Record<string, unknown>;

/** ld+json 덩어리들을 다 꺼내 편다. 배열로 싸 놓는 곳이 있어 한 겹 벗긴다. */
export function ldBlocks(html: string): Node[] {
  const out: Node[] = [];
  for (const found of html.matchAll(LD_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(found[1]!.trim());
    } catch {
      // 한 덩어리가 깨졌다고 나머지를 버릴 이유는 없다.
      continue;
    }
    for (const one of Array.isArray(parsed) ? parsed : [parsed]) {
      if (one && typeof one === "object") out.push(one as Node);
    }
  }
  return out;
}

/** ld+json 에서 Product 를 고른다. 상품번호를 주면 그것과 맞는 것을 먼저 본다. */
export function findProduct(html: string, key = ""): Node {
  const products = ldBlocks(html).filter((one) => String(one["@type"] ?? "") === "Product");
  if (!products.length) {
    throw new SiteError("상품 페이지에서 ld+json(Product) 을 못 찾았습니다 — --probe 로 봐주세요");
  }
  if (key) {
    const exact = products.find((one) => String(one["sku"] ?? one["mpn"] ?? "") === key);
    if (exact) return exact;
  }
  return products[0]!;
}

/** offers 는 하나일 수도 목록일 수도 있다(옵션 상품). 값이 있는 첫 번째를 쓴다. */
function offerOf(product: Node): Node | null {
  const raw = product["offers"];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const one of list) {
    if (one && typeof one === "object") return one as Node;
  }
  return null;
}

/**
 * 재고를 판정한다. → "instock" / "soldout" (모르겠으면 SiteError)
 *
 * **모르는 것을 품절로 넘기지 않는다.** 품절로 치면 재고가 열린 걸 놓치고, 구매가능으로
 * 치면 없는 버튼을 누르러 간다. 둘 다 조용히 틀리는 쪽이라, 모르면 모른다고 말한다.
 */
function statusOf(availability: string): Status {
  const tail = availability.split("/").pop() ?? "";
  if (IN_STOCK_MARKS.includes(tail)) return IN_STOCK;
  if (SOLDOUT_MARKS.includes(tail)) return SOLDOUT;
  throw new SiteError(
    `재고 표시를 못 알아봤습니다: ${availability || "(비어 있음)"} — product.ts 의 표에 넣어주세요`,
  );
}

export function readStock(product: Node): StockInfo {
  const offer = offerOf(product);
  if (!offer) throw new SiteError("상품에 offers 가 없습니다 — --probe 로 봐주세요");

  const availability = String(offer["availability"] ?? "");
  return {
    status: statusOf(availability),
    name: String(product["name"] ?? ""),
    price: Number(offer["price"] ?? 0) || 0,
    raw_status: availability,
    sku: String(product["sku"] ?? product["mpn"] ?? ""),
  };
}

/** 이 상품의 단품 번호. 주소에 없으면 첫 단품(_001)으로 본다 — 단일상품은 늘 그것이다. */
function sitmOf(target: { key: string; sitmNo?: string }): string {
  return target.sitmNo || `${target.key}_001`;
}

/**
 * 상품 API 에서 재고까지. 조회 루프가 부르는 자리다.
 *
 * **API 가 안 되면 ld+json 으로 물러서지 않는다.** 그쪽은 품절도 InStock 이라 하므로,
 * 물러서는 순간 없는 버튼을 누르러 크롬을 띄우고 쿨다운에 걸린다. 모르면 모른다고 한다.
 */
export async function fetchStock(
  s: Session, target: { url: string; key: string; sitmNo?: string },
): Promise<StockInfo> {
  const sitm = sitmOf(target);
  const url = `${STOCK_API}/${encodeURIComponent(sitm)}` +
    `?sitmNo=${encodeURIComponent(sitm)}&isNotContainOptMapping=true`;

  let body: Node;
  try {
    body = JSON.parse(await getPage(s, url)) as Node;
  } catch (e) {
    if (e instanceof SiteError) throw new SiteError(`상품 API: ${e.message}`);
    throw new SiteError(`상품 API 의 답을 못 읽었습니다: ${(e as Error).message}`);
  }
  return readApiStock(body, target.key);
}

/** 상품 API 의 답에서 재고를 판정한다. → 모르겠으면 SiteError */
export function readApiStock(body: Node, key = ""): StockInfo {
  const data = (body["data"] ?? null) as Node | null;
  const basic = (data?.["basicInfo"] ?? null) as Node | null;
  if (!basic) {
    throw new SiteError(`상품 API 가 상품 정보를 안 줬습니다 ` +
      `(${String(body["returnCode"] ?? "?")} ${String(body["message"] ?? "")})`.trim());
  }

  const sitm = String(basic["sitmSlStatCd"] ?? "");
  const spd = String(basic["spdSlStatCd"] ?? "");
  if (!sitm) throw new SiteError("상품 API 에 판매상태(sitmSlStatCd)가 없습니다 — --probe 로 봐주세요");

  // **한정 딜이 걸린 상품은 딜 재고가 따로 있다.** (2026-09-19)
  //
  //   LM8800286277736  단품 SALE · 상품 SALE · 창고 stkQty 9
  //                    딜 dealLmtQty 10 / dealOdQty 10 / dealStkQty 0
  //                    → 사이트는 "현재 품절로 구매가 어렵습니다" 로 막았다
  //
  // 판매상태만 보고 구매가능으로 읽어 크롬을 띄웠고, 주문서에 잠깐 들어갔다가 장바구니로
  // 쫓겨났다. 딜이 걸려 있으면(한도가 숫자) 남은 딜 재고가 있어야 산다.
  // 딜이 없는 상품은 이 칸들이 null 이라 걸리지 않는다 (잉어킹이 그랬다).
  const stock = (data?.["stckInfo"] ?? {}) as Node;
  const dealCap = Number(stock["dealLmtQty"]);
  const dealLeft = Number(stock["dealStkQty"]);
  const onDeal = stock["dealLmtQty"] != null && dealCap > 0 && stock["dealStkQty"] != null;
  const dealGone = onDeal && dealLeft <= 0;

  const blocked = notSaleWhy(data ?? {});

  // 단품도 상품도 판매중이어야 산다. 하나라도 아니면 화면에 구매 버튼이 없다.
  const selling = sitm === ON_SALE && (!spd || spd === ON_SALE) && !dealGone && !blocked;
  const why = [
    `단품 ${sitm}${basic["sitmSlStatCdNm"] ? `(${String(basic["sitmSlStatCdNm"])})` : ""}`,
    spd ? `상품 ${spd}${basic["spdSlStatCdNm"] ? `(${String(basic["spdSlStatCdNm"])})` : ""}` : "",
    onDeal ? `딜 ${dealLeft}/${dealCap} 남음` : "",
    basic["sitmSlStatRsnCdNm"] ? String(basic["sitmSlStatRsnCdNm"]) : "",
    blocked ? `화면은 판매중 아님: ${blocked}` : "",
  ].filter(Boolean).join(" · ");

  const price = (data?.["priceInfo"] ?? {}) as Node;
  const list = Number(price["slPrc"] ?? 0) || 0;
  const off = Number(price["immdDcAplyTotAmt"] ?? 0) || 0;

  return {
    status: selling ? IN_STOCK : SOLDOUT,
    name: String(basic["pdNm"] ?? basic["spdNm"] ?? ""),
    price: Math.max(0, list - off),
    raw_status: why,
    sku: String(basic["pdNo"] ?? basic["spdNo"] ?? key),
    opens_at: selling ? "" : opensAtOf(data ?? {}),
  };
}

/** 지금 한국 시각, YYYYMMDDHHmmss. 사이트 화면이 이 꼴의 문자열끼리 견준다. */
function kstNow(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().replace(/\D/g, "").slice(0, 14);
}

/** API 의 시각 칸 → YYYYMMDDHHmmss. 비었으면 "". */
function stamp(v: unknown): string {
  const digits = v == null ? "" : String(v).replace(/\D/g, "");
  return digits ? digits.padEnd(14, "0").slice(0, 14) : "";
}

/** 20261003100000 → 10.03 10:00 */
const pretty = (s: string): string => `${s.slice(4, 6)}.${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;

/**
 * **판매상태가 SALE 이어도 화면이 막는 경우.** 막혔으면 그 까닭, 아니면 "". (2026-10-03)
 *
 *   LM8800286279990  단품 SALE · 상품 SALE · 창고 stkQty 999999999
 *                    dlvInfo.dvRsvDvsCd RSV_DV(예약배송) · rsvOdStrtDttm/rsvOdEndDttm null
 *                    → 화면은 "현재 판매중인 상품이 아닙니다", 구매 버튼 없음
 *
 * 판매상태만 보고 구매가능으로 읽어 크롬을 띄웠고, 버튼 자리의 그 문구에 막혀 "한발 늦었습니다"
 * 로 끝났다. 바퀴마다 그랬다.
 *
 * 아래는 상품 페이지 스크립트(static.lotteon.com/p/product/assets/js/main.*.js)의 isNotSale 을
 * 그대로 옮긴 것이다. 화면이 구매 버튼 자리에 "현재 판매중인 상품이 아닙니다" 를 그리는 조건이다.
 *   - 판매가가 없다 (0원 상품 GNRL_ZRWON 은 빼고)
 *   - 지금이 판매 기간(slStrtDttm ~ slEndDttm) 밖이다
 *   - 공동구매면 딜 기간(dlvInfo.dealStartDttm ~ dealEndDttm) 밖이다
 *   - 예약배송(RSV_DV)이면 예약주문기간(dlvInfo.rsvOdStrtDttm ~ rsvOdEndDttm)이 없거나 그 밖이다
 *
 * basicInfo.buyBtnInfo 는 보지 않는다 — 살 수 있는 상품도 늘 NONE "현재 판매중인 상품이 아닙니다"
 * disabled 로 온다 (재 봤다). 화면은 그 칸이 아니라 위 조건으로 버튼을 그린다.
 */
export function notSaleWhy(data: Node, now = kstNow()): string {
  const basic = (data["basicInfo"] ?? {}) as Node;
  const price = (data["priceInfo"] ?? {}) as Node;
  const dlv = (data["dlvInfo"] ?? {}) as Node;

  if ((price["slPrc"] == null || price["slPrc"] === "") && basic["pdTypCd"] !== "GNRL_ZRWON") return "판매가가 없습니다";

  const start = stamp(basic["slStrtDttm"]);
  const end = stamp(basic["slEndDttm"]);
  if (start && now < start) return `판매 시작 전 (${pretty(start)} 부터)`;
  if (end && now > end) return `판매 기간이 끝났습니다 (${pretty(end)} 까지)`;

  if (basic["jntPurPdYn"] === "Y") {
    const from = stamp(dlv["dealStartDttm"]);
    const to = stamp(dlv["dealEndDttm"]);
    if ((from && now < from) || (to && now > to)) return "공동구매 기간 밖";
    return "";
  }
  if (dlv["dvRsvDvsCd"] === "RSV_DV") {
    const from = stamp(dlv["rsvOdStrtDttm"]);
    const to = stamp(dlv["rsvOdEndDttm"]);
    if (from && to && now >= from && now <= to) return "";
    // 사람이 읽을 예약주문기간은 배송 안내 줄에 따로 적혀 온다: "예약주문기간 26.10.03 10:00 ~ 26.10.03 23:59"
    const list = Array.isArray(dlv["dvList"]) ? (dlv["dvList"] as Node[]) : [];
    const said = list.map((one) => String(one?.["odTxt"] ?? "")).find(Boolean);
    const span = from && to ? `${pretty(from)} ~ ${pretty(to)}` : said || "기간이 안 열렸습니다";
    return `예약배송 · 예약주문기간 아님 (${span})`;
  }
  return "";
}

/** "예약주문기간 26.10.03 10:00 ~ 26.10.03 23:59" 의 앞쪽 */
const OD_TEXT_RE = /(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})/;

/**
 * 아직 안 열린 판매가 **언제** 열리는가. → YYYYMMDDHHmmss (한국 시각) / "" (모름·이미 열림)
 *
 * notSaleWhy 가 막는 까닭 중 시각이 정해진 것 두 가지만 본다.
 *   - 판매 시작 전           basicInfo.slStrtDttm
 *   - 예약주문기간 시작 전    dlvInfo.rsvOdStrtDttm. **열리기 전에는 null 로 온다** (2026-10-03
 *                            MEGA 30th — 09:20 에 null, 10:00:00 에 열림). 그래서 배송 안내 줄의
 *                            "예약주문기간 26.10.03 10:00 ~ …" 을 읽는다.
 */
export function opensAtOf(data: Node, now = kstNow()): string {
  const basic = (data["basicInfo"] ?? {}) as Node;
  const dlv = (data["dlvInfo"] ?? {}) as Node;

  const start = stamp(basic["slStrtDttm"]);
  if (start && now < start) return start;

  if (dlv["dvRsvDvsCd"] === "RSV_DV") {
    const from = stamp(dlv["rsvOdStrtDttm"]);
    if (from) return now < from ? from : "";
    const list = Array.isArray(dlv["dvList"]) ? (dlv["dvList"] as Node[]) : [];
    for (const one of list) {
      const m = OD_TEXT_RE.exec(String(one?.["odTxt"] ?? ""));
      if (!m) continue;
      const at = `20${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}00`;
      return now < at ? at : "";
    }
  }
  return "";
}

/** YYYYMMDDHHmmss (한국 시각) → epoch ms */
export function kstMs(at: string): number {
  const iso = `${at.slice(0, 4)}-${at.slice(4, 6)}-${at.slice(6, 8)}T${at.slice(8, 10)}:${at.slice(10, 12)}:${at.slice(12, 14)}+09:00`;
  return new Date(iso).getTime();
}
