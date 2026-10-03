/**
 * 상품 페이지에서 재고를 읽는다.
 *
 *   GET https://brand.naver.com/<채널>/products/<상품번호>
 *
 * 돌아오는 HTML 안에 화면 상태가 통째로 들어 있다.
 *
 *   <script>window.__PRELOADED_STATE__={ … }</script>
 *
 * **이건 JSON 이 아니라 자바스크립트 객체 리터럴이다.** 값 자리에 undefined 가 박혀
 * 있다(상품 한 장에 67개). 그냥 JSON.parse 에 넣으면 거절당한다. carveJson() 참고.
 *
 * 최상위 키가 121개인데 그중 상품을 볼 자리는 정해져 있지 않다. 그래서 이름으로 찾지
 * 않고 **번호가 맞고 값이 실제로 든 덩어리**를 찾는다. findProduct() 참고.
 */
import { log } from "../log.js";
import { getPage, SiteError, type Session } from "./http.js";
import { IN_STOCK, SOLDOUT, type Status } from "./config.js";
import type { Target } from "./targets.js";

// 상태 JSON 이 붙어 있는 자리. 이름은 몇 가지를 함께 본다 — 네이버가 페이지마다 다른
// 이름을 쓰는 것을 여러 번 봤다는 이야기가 있어서, 하나만 걸고 있지 않는다.
export const STATE_VARS = [
  "__PRELOADED_STATE__", "__PRELOADED_STATE", "__INITIAL_STATE__", "__NEXT_DATA__",
];

// JSON 안에서 찾을 것들. 앞에 있는 이름부터 본다.
//
// 주소의 12714734588 은 **id(채널상품번호)** 다. productNo 는 그것과 다른 번호(원상품번호)라
// 둘을 다 봐야 한다. 상품 하나가 두 개의 번호를 가지고, 주소에 실리는 쪽이 id 다.
export const KEY_ID = ["id", "channelProductNo", "productNo", "productId"];
export const KEY_STOCK = ["stockQuantity", "stock"];
export const KEY_STATUS = ["productStatusType", "channelProductStatusType", "saleStatus", "statusType"];
export const KEY_NAME = ["name", "productName"];
export const KEY_PRICE = ["discountedSalePrice", "salePrice", "price"];
export const KEY_OPTIONS = ["optionCombinations", "optionCombinationGroups"];

// 팔고 있다고 볼 값들. 여기 없는 값이 나오면 재고 수량만 보고 판단하되, 무슨 값이
// 왔는지 한 번은 로그에 적는다 — 모르는 값을 조용히 넘기면 그게 제일 나쁘다.
const ON_SALE = new Set(["SALE", "ONSALE", "ON_SALE", "SALE_ING"]);
const OFF_SALE = new Set([
  "OUTOFSTOCK", "OUT_OF_STOCK", "SOLDOUT", "SOLD_OUT", "SUSPENSION",
  "CLOSE", "CLOSED", "PROHIBITION", "DELETE", "WAIT",
]);

/** 자바스크립트 리터럴에는 있고 JSON 에는 없는 값들. 문자열 밖에서 만난 것만 메운다. */
const JS_HOLES: [string, string][] = [["undefined", "null"], ["NaN", "null"]];

const LETTER_RE = /\p{L}/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

/**
 * window.<name>={ … } 를 떼어내 값으로 만든다. 없으면 null.
 *
 * 두 가지를 한 번에 한다. 둘 다 한 글자씩 훑으면서 하는 일이라 같이 돈다.
 *
 * **하나. 정규식으로 끊지 않는다.** 이 덩어리 안에는 상품 설명 HTML 이 문자열로 들어
 * 있어서 </script> 도 } 도 그 안에 얼마든지 나온다. 짝을 세지 않으면 반 토막이 난다.
 *
 * **둘. 이건 JSON 이 아니라 자바스크립트 객체 리터럴이다.** 값 자리에 undefined 가
 * 그대로 박혀 있다. JSON.parse 는 그걸 모르니 null 로 바꿔 준다. 문자열 밖에서 만난
 * 것만 바꾼다 — 상품 설명에 그 글자가 들어 있다고 남의 글을 고쳐 놓으면 안 된다.
 */
export function carveJson(html: string, name: string): unknown {
  const at = html.indexOf(name);
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;

  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let i = start;
  const end = html.length;

  while (i < end) {
    const ch = html[i]!;
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted) {
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(ch);
          try {
            return JSON.parse(out.join(""));
          } catch (e) {
            throw new SiteError(`${name} 을 찾았지만 JSON 으로 못 읽었습니다: ${(e as Error).message}`);
          }
        }
      } else if (LETTER_RE.test(ch)) {
        // 문자열 밖의 맨 이름. 값 자리에 올 수 있는 것은 몇 개뿐이다.
        const word = html.slice(i, i + 9);
        const hole = JS_HOLES.find(
          ([what]) => word.startsWith(what) && !ALNUM_RE.test(html[i + what.length] ?? ""),
        );
        if (hole) {
          out.push(hole[1]);
          i += hole[0].length;
        } else {
          out.push(ch);
          i += 1;
        }
        continue;
      }
    }
    out.push(ch);
    i += 1;
  }
  return null;
}

/** 상품 페이지에서 상태 JSON 을 꺼낸다. → [찾은 이름, 값] */
export function pageState(html: string): [string, unknown] {
  for (const name of STATE_VARS) {
    const found = carveJson(html, name);
    if (found !== null && found !== undefined) return [name, found];
  }
  throw new SiteError("상품 페이지에서 상태 JSON 을 못 찾았습니다 (--probe 로 확인해 주세요)");
}

export type Node = Record<string, unknown>;

/** 중첩된 객체·배열을 전부 훑는다. */
export function* walk(node: unknown): Generator<Node> {
  if (Array.isArray(node)) {
    for (const value of node) yield* walk(value);
  } else if (node !== null && typeof node === "object") {
    yield node as Node;
    for (const value of Object.values(node as Node)) yield* walk(value);
  }
}

export function firstKey(node: Node, names: string[]): unknown {
  for (const name of names) {
    if (name in node && node[name] !== null && node[name] !== undefined) return node[name];
  }
  return null;
}

/** 값이 실제로 들어 있는 칸의 수. 껍데기와 본문을 가르는 자다. */
function filled(node: Node): number {
  return Object.values(node).filter((v) => {
    if (v === null || v === undefined || v === "") return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as Node).length > 0;
    return true;
  }).length;
}

/**
 * 상태 JSON 에서 이 상품 덩어리를 찾는다.
 *
 * 경로를 박아 넣지 않는다. 번호가 우리 것과 같고 재고나 판매상태를 쥔 객체를 찾는다.
 *
 * **state["product"] 를 그냥 읽으면 안 된다.** 그 자리는 키가 90개나 되는 그럴듯한
 * 모양인데 속은 비어 있다 — 이름도 번호도 null 이고 stockQuantity 는 0 이다. 서버가
 * 그려 보내는 것은 껍데기뿐이고, 화면에 보이는 값은 브라우저가 나중에 채운다.
 * 그걸 믿었으면 재고가 있어도 영원히 "품절" 로 봤을 자리다.
 *
 * 실제로 값이 든 곳은 state["simpleProductForDetailPage"] 였지만, 그 이름도 박아 넣지
 * 않는다. 번호가 맞고 값이 실제로 들어 있는 덩어리를 고른다 — 채워진 값이 가장 많은
 * 것이 본문이고, 비어 있는 것이 껍데기다.
 */
export function findProduct(state: unknown, productNo: string): Node {
  const want = String(productNo);
  const found: Node[] = [];

  for (const node of walk(state)) {
    const matches = KEY_ID.some(
      (key) => node[key] !== null && node[key] !== undefined && String(node[key]) === want,
    );
    if (!matches) continue;
    if (firstKey(node, KEY_STOCK) === null && firstKey(node, KEY_STATUS) === null) continue;
    found.push(node);
  }

  if (!found.length) {
    throw new SiteError(`상태 JSON 안에서 상품 ${want} 를 못 찾았습니다 (--probe 로 확인해 주세요)`);
  }
  // 같은 점수면 먼저 만난 것이 이긴다 (파이썬의 max 와 같다).
  return found.reduce((best, node) => (filled(node) > filled(best) ? node : best), found[0]!);
}

export interface StockInfo {
  /** 수량. 안 내주는 상품은 -1 이다 — **0 으로 적으면 "재고 부족" 이라고 잘못 막는다.** */
  stock: number;
  status: Status;
  name: string;
  price: number;
  raw_status: string;
  option: { text: string; stock: number } | null;
}

/**
 * 상품 덩어리에서 재고를 읽는다.
 *
 * 옵션 상품은 옵션마다 재고가 따로다. 상품 전체 재고만 보고 사면 정작 원하는 옵션은
 * 품절인 채로 주문서에 들어간다. option 을 준 경우 그 옵션의 재고를 본다.
 */
export function readStock(product: Node, optionText = ""): StockInfo {
  const name = String(firstKey(product, KEY_NAME) ?? "");
  const price = Number(firstKey(product, KEY_PRICE) ?? 0);
  const rawStatus = firstKey(product, KEY_STATUS);
  let stock = firstKey(product, KEY_STOCK) as number | null;

  let picked: StockInfo["option"] = null;
  const options = firstKey(product, KEY_OPTIONS);
  if (optionText && options) {
    for (const node of walk(options)) {
      if (firstKey(node, KEY_STOCK) === null) continue;
      const text = ["optionName1", "optionName2", "optionName3", "name", "id"]
        .map((k) => String(node[k] ?? ""))
        .join(" ");
      if (text.includes(optionText)) {
        picked = { text: text.trim(), stock: Number(firstKey(node, KEY_STOCK) ?? 0) };
        break;
      }
    }
    if (picked === null) throw new SiteError(`옵션 '${optionText}' 를 상품에서 못 찾았습니다`);
    stock = picked.stock;
  }

  let status: Status = SOLDOUT;
  if (rawStatus !== null && rawStatus !== undefined && OFF_SALE.has(String(rawStatus).toUpperCase())) {
    status = SOLDOUT;
  } else if (stock === null || stock === undefined) {
    // 재고 수량을 안 내주는 상품이 있다. 판매상태만 보고 판단한다.
    status = ON_SALE.has(String(rawStatus).toUpperCase()) ? IN_STOCK : SOLDOUT;
  } else if (Number(stock) > 0) {
    status = IN_STOCK;
  }

  return {
    stock: stock === null || stock === undefined ? -1 : Number(stock),
    status,
    name,
    price: Number(price || 0),
    raw_status: rawStatus === null || rawStatus === undefined ? "" : String(rawStatus),
    option: picked,
  };
}

/** 처음 보는 판매상태를 한 번씩만 적어 두려고 센다. */
const SEEN_STATUS = new Set<string>();

/** 모르는 판매상태 값은 한 번은 적어 둔다. 조용히 넘기면 나중에 왜 안 샀는지 모른다. */
export function noteStatus(info: StockInfo): void {
  const raw = info.raw_status.toUpperCase();
  if (!raw || ON_SALE.has(raw) || OFF_SALE.has(raw) || SEEN_STATUS.has(raw)) return;
  SEEN_STATUS.add(raw);
  log.warn(`처음 보는 판매상태 '${info.raw_status}' — 재고 수량만 보고 판단합니다`);
}

/** 상품 하나의 재고를 본다. */
export async function fetchStock(s: Session, target: Target): Promise<StockInfo> {
  const html = await getPage(s, target.url);
  const [, state] = pageState(html);
  const info = readStock(findProduct(state, target.key), target.option);
  noteStatus(info);
  return info;
}
