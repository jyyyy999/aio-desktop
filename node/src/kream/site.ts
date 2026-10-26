/**
 * KREAM 상품 페이지 읽기.
 *
 * 상품 페이지는 서버가 그려서(Nuxt SSR) 보낸다 — 로그인 없이도 재고가 HTML 에 들어 있다. 2026-10-25 에 브랜드배송
 * 상품 둘(1066904 품절 · 1087725 판매 중)로 확인했다.
 *
 *   ld+json(Product).offers.availability   https://schema.org/InStock · OutOfStock — **판매 전에도 InStock 이다** (1151820)
 *   __NUXT_DATA__ 의 아래 버튼(button_medium)  판매 중이면 "구매하기", 품절이면 "일시 품절", 판매 전이면
 *                                          "10월 27일(화) 11:00 판매 예정" (막힌 것은 status.enabled = false)
 *   "product_type":"product_brand"          브랜드배송(공식 브랜드 샵) 상품. 리셀(판매 입찰) 상품에는 없다
 *
 * 둘 다 보고, 어긋나면 **품절로 본다** (잘못 사는 쪽보다 한 바퀴 늦는 쪽이 낫다).
 *
 * 같은 HTML 을 크롬이 받은 것(getPageSource)에도 그대로 쓴다 — 감시는 로그인된 크롬이 상품 페이지를 다시 읽어 한다.
 */
import { ORIGIN } from "./config.js";

/** 상품 주소 → 상품번호. 숫자만 적어도 받는다. */
export function productIdOf(url: string): string | null {
  const text = String(url || "").trim();
  if (/^\d{3,}$/.test(text)) return text;
  return /kream\.co\.kr\/products\/(\d+)/.exec(text)?.[1] ?? null;
}

export function productUrlOf(id: string): string {
  return `${ORIGIN}/products/${id}`;
}

export interface ProductView {
  id: string;
  name: string;
  price: number;
  /** 살 수 있나 (ld+json 과 아래 버튼이 둘 다 그렇다고 할 때만) */
  inStock: boolean;
  /** 아래 버튼의 글자 (구매하기 · 일시 품절 · …). 못 찾으면 "" */
  button: string;
  /** 브랜드배송 상품인가 */
  brand: boolean;
}

/**
 * 구매 버튼 자리의 글자 — 이 글자를 단 버튼만 구매 버튼으로 본다 (다른 버튼: 더보기·스타일 올리기 따위).
 * 판매 전에는 "10월 27일(화) 11:00 판매 예정" 처럼 날짜가 붙는다 (2026-10-26, 상품 1151820).
 */
const PURCHASE_TEXT = /구매하기|품절|판매\s*(예정|종료)|오픈\s*예정|발매\s*예정|응모|마감/;

const ENTITY: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };
/** HTML 엔티티 — 이름 붙은 흔한 것과 숫자 코드(&#x2F; · &#47;). 서버가 "K/DA" 를 "K&#x2F;DA" 로 보낸다 (1151820). */
const unescape = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|quot|#39|lt|gt);/g, (m) => ENTITY[m] ?? m);

type Node = Record<string, unknown>;

/**
 * Nuxt 의 __NUXT_DATA__ 는 납작한 배열이다 — 객체의 값이 다른 칸의 번호다. 버튼 마디(display_type 이 button…)를 모두 찾아
 * 그 안의 글자(text)와 눌리나(status.enabled)를 읽고, 구매 버튼 자리의 글자를 단 것만 돌려준다.
 *
 * 예전에는 정해 둔 글자 목록에서 위로 올라가 버튼을 찾았는데, 목록에 없는 "10월 27일(화) 11:00 판매 예정" 을 놓쳐 버튼이
 * 없는 줄 알고 ld+json(판매 전에도 InStock)만 믿었다 — 판매 전 상품을 "재고 있음" 으로 봤다 (2026-10-26).
 * → 찾은 구매 버튼들 [글자, 눌리나]
 */
function buttonsOf(html: string): { text: string; enabled: boolean }[] {
  const m = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) return [];
  let arr: unknown[];
  try {
    arr = JSON.parse(m[1]) as unknown[];
  } catch {
    return [];
  }
  const at = (i: unknown): unknown => (typeof i === "number" ? arr[i] : undefined);
  /** 마디 아래(깊이 제한)의 첫 글자 — title_item → text_element → default_variation.text 따위. */
  const textUnder = (start: unknown): string => {
    const seen = new Set<number>();
    const walk = (ref: unknown, depth: number): string => {
      if (typeof ref !== "number" || depth > 8 || seen.has(ref)) return "";
      seen.add(ref);
      const v = arr[ref];
      if (Array.isArray(v)) {
        // ["Reactive", n] 같은 감싸개는 벗긴다
        if (typeof v[0] === "string" && /Reactive|Ref/.test(v[0])) return walk(v[1], depth + 1);
        for (const x of v) {
          const t = walk(x, depth + 1);
          if (t) return t;
        }
        return "";
      }
      if (!v || typeof v !== "object") return "";
      const own = at((v as Node)["text"]);
      if (typeof own === "string" && own.trim()) return own.trim();
      for (const key of ["title_item", "text_element", "default_variation", "variations", "items"]) {
        const t = walk((v as Node)[key], depth + 1);
        if (t) return t;
      }
      return "";
    };
    return walk(start, 0);
  };
  const out: { text: string; enabled: boolean }[] = [];
  for (const node of arr) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const type = at((node as Node)["display_type"]);
    if (typeof type !== "string" || !type.startsWith("button")) continue;
    const text = textUnder((node as Node)["title_item"]) || textUnder((node as Node)["text_element"]);
    if (!PURCHASE_TEXT.test(text)) continue;
    const status = at((node as Node)["status"]) as Node | undefined;
    const enabled = status && typeof status === "object" ? at(status["enabled"]) === true : false;
    out.push({ text, enabled });
  }
  return out;
}

function ldProduct(html: string): Node | null {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const value = JSON.parse(m[1] ?? "") as Node;
      if (value && value["@type"] === "Product") return value;
    } catch {
      /* 다음 것 */
    }
  }
  return null;
}

/** 상품 페이지 HTML → 재고·이름·가격. 상품 페이지가 아니면 null. */
export function parseProduct(id: string, html: string): ProductView | null {
  const ld = ldProduct(html);
  const buttons = buttonsOf(html);
  if (!ld && !buttons.length) return null;
  const offers = (ld?.["offers"] ?? {}) as Node;
  const availability = String(offers["availability"] ?? "");
  const price = Number(offers["price"] ?? 0) || 0;
  // 한글 이름은 <title> 에 있다 ("… 정품 안심 거래 | KREAM"). ld+json 의 name 은 영문이다.
  const title = unescape(/<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s*(정품 안심 거래\s*)?\|\s*KREAM\s*$/, "").trim();
  const name = title || String(ld?.["name"] ?? "").trim() || id;
  // 눌리는 "구매하기" 가 있어야 산다. ld+json 은 판매 전에도 InStock 이라 그것만으로는 사지 않는다 — 구매 버튼을 못 찾으면
  // 품절로 본다 (잘못 사러 가는 것보다 한 바퀴 늦는 쪽이 낫다).
  const main = buttons.find((b) => b.text === "구매하기" && b.enabled) ?? buttons[buttons.length - 1];
  const buttonSaysBuy = !!main && main.text === "구매하기" && main.enabled;
  const ldSaysBuy = availability ? /InStock|LimitedAvailability/i.test(availability) : true;
  return {
    id,
    name,
    price,
    inStock: ldSaysBuy && buttonSaysBuy,
    button: main?.text ?? "",
    brand: /"product_type\\?":\\?"product_brand/.test(html),
  };
}

/** 쿠키 없이 한 번 받는다 (--status · 이름 읽기). 막히면 그 까닭을 그대로 올린다 — 돌아가려 하지 않는다. */
/** 바로 받기를 기다리는 한도. 보통 1~2초면 온다 — KREAM 이 붙들 때는 10초를 끌다 500 을 주므로 일찍 접는다. */
const DIRECT_TIMEOUT_MS = 3000;

export async function fetchProductHtml(id: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(productUrlOf(id), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
      signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
    });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new Error(`${DIRECT_TIMEOUT_MS / 1000}초 안에 답이 없습니다`);
    throw e;
  }
  if (!res.ok) throw new Error(`상품 페이지 HTTP ${res.status}`);
  return res.text();
}
