/**
 * Shopify 스토어프론트 접근. Supreme 은 2025년에 supreme.com → shop.supreme.com (Shopify) 로 옮겼다.
 *
 * 셀렉터를 뒤지는 대신 Shopify 표준 엔드포인트를 **페이지 안에서** 부른다. 같은 오리진·같은 쿠키로
 * 부르므로 봇 차단을 새로 자극하지 않고, 테마가 바뀌어도 깨지지 않는다.
 *
 *   목록   GET  /collections/<c>/products.json?limit=250   (1순위)
 *          GET  /collections/<c>                          (폴백, HTML)
 *   해석   GET  /products/<handle>.js
 *   담기   POST /cart/add.js      { items: [{ id, quantity }] }
 *   확인   GET  /cart.js
 *
 * 드라이버에 기대지 않게, 페이지에서 JS 를 돌리는 함수 하나만 받는다 (PageRunner).
 */

export type PageRunner = (script: string) => Promise<unknown>;

export interface Variant {
  id: string;
  title: string;
  size: string;
  color: string;
  options: string[];
  available: boolean;
  price: number;
  sku: string;
}

export interface Product {
  id: string;
  handle: string;
  title: string;
  url: string;
  type: string;
  vendor: string;
  tags: string;
  publishedAt: string;
  image: string;
  options: string[];
  variants: Variant[];
  available: boolean;
  priceMin: number;
  priceMax: number;
  /** HTML 폴백으로만 알게 된 상품 — variant 정보가 없다 (살 때 /products/<handle>.js 로 해석). */
  partial?: boolean;
  /** 상품의 색 (슈프림은 색마다 상품이 따로 — products-json 의 color · 상품 페이지 h2) */
  color?: string;
}

export interface ListResult {
  /** page-json = 컬렉션 페이지의 products-json (슈프림의 빠른 길) */
  mode: "page-json" | "json" | "html" | "none";
  status: number;
  products: Product[];
  hero: string;
  note: string;
}

const SIZE_OPTION_RE = /size|サイズ|尺寸|사이즈/i;
const COLOR_OPTION_RE = /colou?r|カラー|색상|색/i;

const str = (v: unknown): string => (v == null ? "" : String(v).trim());
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

interface RawVariant {
  id?: unknown;
  title?: unknown;
  option1?: unknown;
  option2?: unknown;
  option3?: unknown;
  options?: unknown;
  available?: unknown;
  price?: unknown;
  sku?: unknown;
}
interface RawProduct {
  id?: unknown;
  handle?: unknown;
  title?: unknown;
  product_type?: unknown;
  type?: unknown;
  vendor?: unknown;
  tags?: unknown;
  published_at?: unknown;
  images?: unknown;
  image?: unknown;
  options?: unknown;
  variants?: unknown;
}

function optionNames(raw: RawProduct | null): string[] {
  const list = raw && Array.isArray(raw.options) ? (raw.options as unknown[]) : [];
  return list.map((o) => (typeof o === "string" ? o : str((o as { name?: unknown } | null)?.name)));
}

function variantValues(v: RawVariant): string[] {
  if (Array.isArray(v.options)) return (v.options as unknown[]).map(str);
  return [v.option1, v.option2, v.option3].map(str).filter((s) => s.length > 0);
}

function attrsOf(v: RawVariant, names: string[]): { size: string; color: string } {
  const values = variantValues(v);
  const sizeAt = names.findIndex((n) => SIZE_OPTION_RE.test(n));
  const colorAt = names.findIndex((n) => COLOR_OPTION_RE.test(n));
  let size = sizeAt >= 0 ? values[sizeAt] ?? "" : "";
  let color = colorAt >= 0 ? values[colorAt] ?? "" : "";

  if (!size || !color) {
    // /products/<handle>.js 는 옵션 **이름**은 주면서 값을 안 주는 판이 있다. 그때는 제목의
    // 같은 자리로 알아낸다 — "Black / Medium" 이고 옵션이 ["Color","Size"] 면 Medium 이 사이즈다.
    const raw = str(v.title).split("/").map((p) => p.trim());
    const parts = raw.filter(Boolean);
    if (names.length && raw.length === names.length) {
      if (!size && sizeAt >= 0) size = raw[sizeAt] ?? "";
      if (!color && colorAt >= 0) color = raw[colorAt] ?? "";
    }
    if (!size) {
      const guess = parts.find((p) => /^(xx?s|s|m|l|xl|xxl|xxxl|\d{2}(?:\.\d)?|one size)$/i.test(p));
      if (guess && guess !== color) size = guess;
    }
    if (!color) {
      const guess = parts.find((p) => p !== size && /^[a-z][a-z\s-]{2,}$/i.test(p));
      if (guess) color = guess;
    }
  }
  return { size, color };
}

function firstImage(raw: RawProduct | null): string {
  const imgs = raw && Array.isArray(raw.images) ? (raw.images as unknown[]) : [];
  const one = raw && Array.isArray(raw.image) ? (raw.image as unknown[])[0] : raw?.image;
  const pick = imgs[0] ?? one;
  if (!pick) return "";
  if (typeof pick === "string") return pick;
  const obj = pick as { src?: unknown; url?: unknown };
  return str(obj.src ?? obj.url);
}

/** products.json · product-…-json 은 값을 **최소 단위**(센트/전)로 준다 — 화면 단위로 되돌린다. */
export const MINOR_UNITS = 100;

/** products.json 의 product → 표준 모양 */
export function normalizeProduct(raw: RawProduct, priceDivisor = MINOR_UNITS): Product {
  const names = optionNames(raw);
  const list = Array.isArray(raw.variants) ? (raw.variants as RawVariant[]) : [];
  const variants: Variant[] = list.map((v) => {
    const attrs = attrsOf(v, names);
    const available = v.available !== false;
    return {
      id: str(v.id),
      title: str(v.title),
      size: attrs.size,
      color: attrs.color,
      options: variantValues(v),
      available,
      price: num(v.price) / (priceDivisor || 1),
      sku: str(v.sku),
    };
  });
  const inStock = variants.filter((v) => v.available);
  const pool = (inStock.length ? inStock : variants).map((v) => v.price).filter((p) => p > 0);
  return {
    id: str(raw.id),
    handle: str(raw.handle),
    title: str(raw.title),
    url: `/products/${str(raw.handle)}`,
    type: str(raw.product_type ?? raw.type),
    vendor: str(raw.vendor),
    tags: Array.isArray(raw.tags) ? (raw.tags as unknown[]).map(str).join(", ") : str(raw.tags),
    publishedAt: str(raw.published_at),
    image: firstImage(raw),
    options: names,
    variants,
    available: variants.some((v) => v.available),
    priceMin: pool.length ? Math.min(...pool) : 0,
    priceMax: pool.length ? Math.max(...pool) : 0,
  };
}

/**
 * 페이지에서 읽은 색을 이름에 붙인다 — "이름 - 색" (목록 카드의 alt 와 같은 모양).
 * 색 옵션이 있는 상품(색이 variant 로 갈리는 상품)에는 붙이지 않는다 — 그건 variant 가 고른다.
 */
export function withPageColor(product: Product, color: string): Product {
  const c = color.trim();
  if (!c || product.options.some((o) => COLOR_OPTION_RE.test(o))) return product;
  // 색은 따로도 적어 둔다 — 색 조건은 이름이 아니라 이 칸과 견준다 (match.ts productColor).
  if (product.title.toLowerCase().endsWith(` - ${c.toLowerCase()}`)) return { ...product, color: c };
  return { ...product, color: c, title: `${product.title} - ${c}`, tags: [product.tags, c].filter(Boolean).join(", ") };
}

/** HTML 폴백이 돌려준 카드 한 장 → 표준 모양 (variant 없음) */
export interface HtmlCard {
  handle: string;
  title: string;
  url: string;
  soldOut: boolean;
  image: string;
  price: number;
  /** 카드에 적힌 글 전체 — 색·수식어가 여기에만 있는 판이 있다 (매칭 재료로 쓴다). */
  text?: string;
}

export function normalizeCard(card: HtmlCard): Product {
  return {
    id: "",
    handle: card.handle,
    title: card.title || card.handle,
    url: card.url || `/products/${card.handle}`,
    type: "",
    vendor: "",
    // 키워드·색 매칭은 title + type + tags 로 한다 — 카드 글을 여기 넣어 수식어까지 걸리게 한다.
    tags: card.text ? card.text.slice(0, 300) : "",
    publishedAt: "",
    image: card.image,
    options: [],
    variants: [],
    available: card.soldOut !== true,
    priceMin: num(card.price),
    priceMax: num(card.price),
    partial: true,
  };
}

/** /collections/<c>/products.json — 실패해도 던지지 않고 status 로 알린다 (봇 차단 403 이 흔하다). */
export function listScript(collection: string): string {
  const path = `/collections/${collection}/products.json?limit=250`;
  return `(async () => {
  try {
    const res = await fetch(${JSON.stringify(path)}, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (!res.ok) return { mode: "json", status: res.status, products: [], hero: location.href, note: "HTTP " + res.status };
    const data = await res.json();
    const products = data && Array.isArray(data.products) ? data.products : [];
    return { mode: "json", status: res.status, products, hero: location.href, note: products.length + "개" };
  } catch (e) {
    return { mode: "json", status: 0, products: [], hero: location.href, note: String((e && e.message) || e) };
  }
})()`;
}

/**
 * /collections/<c> HTML 폴백. 상품 카드에서 handle·품절 여부·그림을 긁는다.
 *
 * **기다리면서 긁는다.** Supreme 의 /collections/all 은 /pages/shop 으로 넘어가고 목록도
 * 자바스크립트로 그려진다 — 넘어가는 중에 한 번 긁으면 0개가 나온다 (2026-10-08 에 그랬다).
 */
export function listHtmlScript(collection: string): string {
  const path = `/collections/${collection}`;
  return `(async () => {
  const PRODUCT = /\\/products\\/([A-Za-z0-9_-]+)/;
  const collect = () => {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href*="/products/"]')) {
      const m = PRODUCT.exec(a.getAttribute("href") || "");
      if (!m || !m[1]) continue;
      const handle = m[1];
      if (seen.has(handle)) continue;
      const card = a.closest("li, article, .product, .grid__item, div") || a;
      const img = card.querySelector("img");
      const cardText = ((card.textContent || "") + " " + (a.getAttribute("title") || "")).replace(/\\s+/g, " ").trim();
      // 이름은 **alt·title 중 가장 긴 것**을 쓴다 (alt 가 보통 전체 이름이다).
      // 카드 글은 이름으로 쓰지 않는다 — "new" 배지·가격이 섞인다. 매칭 재료(tags)로만 넘긴다.
      const names = [img && img.getAttribute("alt"), a.getAttribute("title")].map((s) => String(s || "").trim()).filter(Boolean);
      const bestTitle = names.reduce((best, one) => (one.length > best.length ? one : best), names[0] || handle);
      const soldOut = /sold\\s*out|품절|完売|売り切れ/i.test(cardText) || !!card.querySelector('[class*="sold" i], [disabled][class*="add" i]');
      const src = img ? (img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("srcset") || "") : "";
      const priceText = (card.textContent || "").match(/[\\d][\\d.,]{1,}/);
      seen.set(handle, {
        handle,
        title: bestTitle.slice(0, 200),
        url: "/products/" + handle,
        soldOut,
        image: src.split(" ")[0] || "",
        price: priceText ? Number(priceText[0].replace(/[^\\d.]/g, "")) || 0 : 0,
        // 카드 글 전체도 넘긴다 — 색·수식어가 카드 글에만 있는 판이 있다 (매칭 재료로 쓴다).
        text: cardText.slice(0, 300),
      });
    }
    return [...seen.values()];
  };
  // 목록은 **한 번에 다 그려지지 않는다.** 그리드가 여러 개이고 스크롤하면 더 불러온다.
  //   실측(2026-10-08): 첫 화면만 긁으면 36개, 끝까지 모으면 209개 — 그래서 +leather 상품을 못 봤다.
  // 스크롤해 가며 **개수가 멈출 때까지** 모은다 (0.6초 동안 안 늘면 끝 — 빠르게 사려고 2026-10-10 에 줄였다.
  // 이름이 반쪽으로 온 카드는 감시의 색 보완이 상품 페이지 이름으로 메운다).
  // **여러 번 훑어 합친다.** 이미지·색이 늦게 붙는 카드가 있어서, 한 번만 긁으면
  // "Leather Appliqué Hooded Work Jacket"(색 없음) 처럼 이름이 반쪽으로 온다 (2026-10-08 실측).
  // 같은 handle 은 **더 긴 이름·더 많은 글**을 남기고, 품절은 한 번이라도 아니면 아니라고 본다.
  const merged = new Map();
  const merge = (cards) => {
    for (const card of cards) {
      const prev = merged.get(card.handle);
      if (!prev) { merged.set(card.handle, card); continue; }
      if (String(card.title || "").length > String(prev.title || "").length) prev.title = card.title;
      if (String(card.text || "").length > String(prev.text || "").length) prev.text = card.text;
      if (card.image && !prev.image) prev.image = card.image;
      if (!card.soldOut) prev.soldOut = false;
    }
    return [...merged.values()];
  };
  const deadline = Date.now() + 25000;
  const sumLen = (list) => list.reduce((n, c) => n + String(c.title || "").length + String(c.text || "").length, 0);
  let cards = merge(collect());
  // 이름 길이의 합이 자라는 동안은 아직 색·이미지가 붙는 중이다 — 개수만 보면 처음부터 209라
  // "멈췄다" 고 잘못 판단한다 (2026-10-08: 그래서 - Realtree Camo 를 못 찾았다).
  let best = sumLen(cards);
  let stableSince = Date.now();
  let wrapped = false;
  let scrollY = 0;
  while (Date.now() < deadline) {
    try {
      const height = document.body.scrollHeight;
      const step = Math.max(400, Math.round(window.innerHeight * 1.5));
      if (scrollY >= height - step) {
        wrapped = true;
        scrollY = 0;
      } else {
        scrollY += step;
      }
      window.scrollTo(0, scrollY);
    } catch (e) {
      wrapped = true; // 스크롤을 못 하면 한 바퀴 돈 것으로 보고 멈춘다
    }
    await new Promise((r) => setTimeout(r, 200));
    cards = merge(collect());
    const now = sumLen(cards);
    if (now !== best) {
      best = now;
      stableSince = Date.now();
    } else if (cards.length > 0 && wrapped && Date.now() - stableSince > 600) {
      break;
    }
  }
  return { mode: "html", status: 200, products: cards, hero: location.href, note: location.pathname + " · " + document.title.slice(0, 60) };
})()`;
}

/**
 * 컬렉션 페이지 HTML 을 **fetch 만 해서** products-json 을 꺼낸다 (렌더링·스크롤 없음).
 * WebDriver 로 되돌려 받는 양을 줄이려고 쓰는 칸만 남긴다.
 * @param expectedOrigin 지금 페이지가 이 오리진이 아니면 noOrigin (다른 사이트를 fetch 하지 않게)
 */
export function pageProductsScript(collection: string, expectedOrigin = ""): string {
  const path = `/collections/${collection}`;
  return `(async () => {
  const expected = ${JSON.stringify(expectedOrigin)};
  if (!/^https?:$/.test(location.protocol) || (expected && location.origin !== expected)) return { ok: false, noOrigin: true };
  try {
    const res = await fetch(${JSON.stringify(path)} + "?_=" + Date.now(), { credentials: "same-origin", cache: "no-store" });
    const text = await res.text();
    const m = text.match(/<script[^>]*id="products-json"[^>]*>([\\s\\S]*?)<\\/script>/);
    if (!m) return { ok: res.ok, status: res.status, found: false };
    const data = JSON.parse(m[1]);
    const products = (data.products || []).map((p) => ({
      id: p.id, title: p.title, handle: p.handle, url: p.url, type: p.type || p.product_type || "",
      product_type: p.product_type || p.type || "", color: p.color || "", is_new: !!p.is_new, image: p.image || "",
      tags: p.style || "", options: p.options || [],
      variants: (p.variants || []).map((v) => ({
        id: v.id, title: v.title, option1: v.option1, option2: v.option2, option3: v.option3,
        options: v.options, available: v.available, price: v.price, sku: v.sku,
      })),
    }));
    return { ok: true, status: res.status, found: true, total: data.allProductsCount || products.length, products };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
})()`;
}

/** Node 에서 직접 받을 때 쓰는 브라우저 머리글 (기본 "node" 로 가면 막힐 수 있다). */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** products-json 의 상품을 쓰는 칸만 남긴다 (pageProductsScript 안의 것과 같은 모양). */
export function compactPageProducts(data: { products?: unknown[]; allProductsCount?: unknown }): {
  total: number;
  products: NonNullable<NonNullable<PageProductsResult>["products"]>;
} {
  const list = (Array.isArray(data.products) ? data.products : []) as Record<string, unknown>[];
  const products = list.map((p) => ({
    id: p["id"], title: p["title"], handle: p["handle"], url: p["url"],
    type: str(p["type"] ?? p["product_type"]), product_type: str(p["product_type"] ?? p["type"]),
    color: str(p["color"]), is_new: p["is_new"] === true, image: str(p["image"]), tags: str(p["style"]),
    options: Array.isArray(p["options"]) ? p["options"] : [],
    variants: (Array.isArray(p["variants"]) ? (p["variants"] as Record<string, unknown>[]) : []).map((v) => ({
      id: v["id"], title: v["title"], option1: v["option1"], option2: v["option2"], option3: v["option3"],
      options: v["options"], available: v["available"], price: v["price"], sku: v["sku"],
    })),
  }));
  return { total: num(data.allProductsCount) || products.length, products };
}

/**
 * **크롬 없이** Node 에서 컬렉션 HTML 을 받아 products-json 을 꺼낸다 (2026-10-10 실측: 200 · 223개 · 약 1.2초).
 * 크롬이 뜨는 동안 첫 바퀴를 미리 받아 두고, 감시도 크롬을 쓰지 않는다. 막히면(403·챌린지) 부르는 쪽이 크롬 안 fetch 로 간다.
 */
export async function fetchPageProducts(origin: string, collection: string, cookie = ""): Promise<PageProductsResult> {
  try {
    const res = await fetch(`${origin}/collections/${collection}?_=${Date.now()}`, {
      headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml", ...(cookie ? { cookie } : {}) },
    });
    const text = await res.text();
    const m = /<script[^>]*id="products-json"[^>]*>([\s\S]*?)<\/script>/.exec(text);
    if (!m?.[1]) return { ok: res.ok, status: res.status, found: false };
    const { total, products } = compactPageProducts(JSON.parse(m[1]) as { products?: unknown[]; allProductsCount?: unknown });
    return { ok: true, status: res.status, found: true, total, products };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 이 상품이 그 컬렉션(#카테고리)에 드나 — 상품의 type 과 컬렉션 이름을 글자만 남겨 견준다
 * ("tops-sweaters" = "tops/sweaters"). all 은 전부, new 는 is_new.
 */
export function inCollection(p: { type?: unknown; product_type?: unknown; is_new?: unknown }, collection: string): boolean {
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const c = norm(collection);
  if (!c || c === "all") return true;
  if (c === "new") return p.is_new === true;
  return norm(p.type) === c || norm(p.product_type) === c;
}

type PageProductsResult = {
  ok?: boolean;
  noOrigin?: boolean;
  found?: boolean;
  status?: number;
  total?: number;
  products?: (RawProduct & { color?: string; is_new?: boolean; type?: string })[];
  error?: string;
} | null;

/** 봇 차단·챌린지 화면인지 — 사람에게 창을 넘길지 판단한다. */
export function pageStateScript(): string {
  return `(() => {
  const body = (document.body ? document.body.innerText : "").slice(0, 400);
  const blocked = /access denied|you do not have permission|attention required|verify you are human|just a moment|checking your browser/i.test(body);
  const challenge = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha"], iframe[src*="captcha"]');
  return { url: location.href, title: document.title, blocked, challenge, text: body.replace(/\\s+/g, " ").slice(0, 200) };
})()`;
}

/** /products/<handle>.js — variant id 를 얻는다 (살 때). */
export function productScript(handle: string): string {
  const path = `/products/${handle}.js`;
  return `(async () => {
  try {
    const res = await fetch(${JSON.stringify(path)}, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, status: res.status, product: null };
    return { ok: true, status: res.status, product: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, product: null, error: String((e && e.message) || e) };
  }
})()`;
}

/**
 * 상품 **페이지**에서 variant 를 꺼낸다.
 *
 * Supreme 은 /products/<handle>.js 와 /products.json 을 403 으로 막는다 (2026-10-08 확인).
 * 대신 상품 페이지 HTML 은 200 으로 오고, 그 안에
 *   <script type="application/json" id="product-<handle>-json">{ … "variants":[…] }</script>
 * 가 통째로 박혀 있다 — 사이즈·재고·variant id 가 products.json 과 **같은 모양**으로 들어 있다.
 * 그래서 이 경로가 실제로 쓰는 길이다.
 */
/**
 * 상품 페이지의 **색 이름**. 슈프림은 색마다 상품이 따로인데 JSON 의 title 에도 옵션에도 색이 없다 —
 * 색은 페이지의 자바스크립트 없는 판(no-js-content)에 `<h1>이름</h1><h2>색</h2>` 로만 있다 (2026-10-10 실측:
 * "Fuck You Zip Up Hooded Sweatshirt" 의 JSON title 에 Black 이 없어 +black 이 빗나갔다).
 */
const NOJS_COLOR_RE = /class="no-js-content"[\s\S]*?<h1[^>]*>[\s\S]*?<\/h1>\s*<h2[^>]*>([\s\S]*?)<\/h2>/;

export function colorFromProductHtml(html: string): string {
  const m = NOJS_COLOR_RE.exec(html);
  return m?.[1] ? m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
}

export function productPageScript(handle: string): string {
  const path = `/products/${handle}`;
  const json = JSON.stringify(handle);
  return `(async () => {
  try {
    const res = await fetch(${JSON.stringify(path)}, { credentials: "same-origin" });
    if (!res.ok) return { ok: false, status: res.status, product: null };
    const text = await res.text();
    const cm = ${NOJS_COLOR_RE.toString()}.exec(text);
    const color = cm && cm[1] ? cm[1].replace(/<[^>]+>/g, "").replace(/\\s+/g, " ").trim().slice(0, 60) : "";
    const m = text.match(/<script[^>]*id="product-[^"]*-json"[^>]*>([\\s\\S]*?)<\\/script>/);
    if (!m || !m[1]) return { ok: false, status: res.status, product: null, reason: "product-…-json 스크립트 없음 (" + text.length + "바이트)" };
    try {
      return { ok: true, status: res.status, product: JSON.parse(m[1]), color };
    } catch (e) {
      return { ok: false, status: res.status, product: null, reason: "JSON 해석 실패: " + String((e && e.message) || e) };
    }
  } catch (e) {
    return { ok: false, status: 0, product: null, reason: String((e && e.message) || e) };
  }
})()`;
}

/** POST /cart/add.js */
export function addToCartScript(variantId: string, quantity: number): string {
  return `(async () => {
  try {
    const res = await fetch("/cart/add.js", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ items: [{ id: Number(${JSON.stringify(variantId)}), quantity: ${Math.max(1, Math.floor(quantity))} }] }),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, data, raw: res.ok ? "" : text.slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, data: null, raw: String((e && e.message) || e) };
  }
})()`;
}

/** POST /cart/clear.js — 장바구니를 비운다 (드랍 때 미끼를 치운다). */
export function cartClearScript(): string {
  return `(async () => {
  try {
    const res = await fetch("/cart/clear.js", { method: "POST", credentials: "same-origin", headers: { accept: "application/json" } });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
})()`;
}

/** POST /cart/change.js — 한 줄의 수량을 바꾼다 (0 이면 뺀다). key·id·line 중 아무거나. */
export function cartChangeScript(who: { key?: string; id?: string; line?: number }, quantity: number): string {
  const body: Record<string, unknown> = { quantity: Math.max(0, Math.floor(quantity)) };
  if (who.key) body["id"] = who.key; // Shopify change.js 는 id 자리에 line key 도 받는다
  else if (who.id) body["id"] = who.id;
  else if (typeof who.line === "number") body["line"] = who.line;
  return `(async () => {
  try {
    const res = await fetch("/cart/change.js", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(${JSON.stringify(body)}),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, count: data && typeof data.item_count === "number" ? data.item_count : null, raw: res.ok ? "" : text.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, count: null, raw: String((e && e.message) || e) };
  }
})()`;
}

/** GET /cart.js */
export function cartScript(): string {
  return `(async () => {
  try {
    const res = await fetch("/cart.js", { credentials: "same-origin", headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, status: res.status, cart: null };
    return { ok: true, status: res.status, cart: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, cart: null, error: String((e && e.message) || e) };
  }
})()`;
}

/** 자동구매 확인용 — 지금 페이지가 Shopify 체크아웃인가, 어느 단계인가. */
export function checkoutStageScript(): string {
  return `(() => {
  const path = location.pathname;
  const has = (s) => !!document.querySelector(s);
  const email = has('input[name="email"], #email, input[type="email"]');
  const ship = has('input[name="address1"], #checkout_shipping_address_address1, input[autocomplete="address-line1"]');
  const pay = has('#checkout-pay-button, [data-testid="pay-button"], input[name="number"]')
    || !!document.querySelector('iframe[name^="card-fields"], iframe[title*="card number" i]');
  const done = /thank_you|thank-you|order\\/completed/i.test(path);
  return { url: location.href, path, email, ship, pay, done, title: document.title };
})()`;
}

export interface DriverLike {
  run: PageRunner;
}

export class Shop {
  /** 마지막 resolve 가 어느 길로 갔나 (로그·점검용) */
  lastResolveNote = "";
  /**
   * 한 번 막힌(401·403) 길은 다시 묻지 않는다 — 슈프림은 products.json · /products/<handle>.js 가 늘 403 이라
   * 매 바퀴·매 상품마다 요청 하나씩을 버렸다 (빠르게 사려고 2026-10-10).
   */
  private listJsonBlocked = false;
  private productJsBlocked = false;

  /**
   * @param run 페이지에서 스크립트를 돌린다
   * @param nav 컬렉션 주소로 **먼저 이동**하는 길. 없으면 지금 페이지를 긁는다
   *            (홈페이지를 긁으면 신상품 36개만 보인다 — 2026-10-08 에 이것 때문에 상품을 못 찾았다)
   */
  constructor(
    private readonly run: PageRunner,
    private readonly nav?: { goto(url: string): Promise<void>; origin: string },
    /**
     * 빠른 길. direct = 목록을 크롬 없이 Node 에서 받는다. prefetch = 크롬이 뜨는 동안 미리 받아 둔 첫 바퀴.
     */
    private readonly fast: { direct?: boolean; cookie?: string; prefetch?: Promise<PageProductsResult> } = {},
  ) {
    this.prefetch = fast.prefetch ?? null;
  }

  /** 아직 안 쓴 미리 받은 첫 바퀴 */
  private prefetch: Promise<PageProductsResult> | null;
  /** Node 에서 받기가 연달아 실패한 수 — 2번이면 크롬 안 fetch 로만 간다 (막혔다). */
  private directFailures = 0;

  /** 컬렉션 페이지에 products-json 이 없는 스토어 — 다시 찾지 않는다. */
  private pageJsonMissing = false;
  /** 방금 받은 전체 목록 — 한 바퀴에 #카테고리가 여럿이어도 같은 880KB 를 여러 번 받지 않게 (1.5초만 쓴다). */
  private pageJsonCache: { at: number; got: PageProductsResult } | null = null;

  /**
   * **products-json 한 번으로 전체를 받는다** (2026-10-10 실측: 슈프림은 어느 /collections/<c> HTML 에도
   * `<script id="products-json">` 로 전 상품 223개 · 색 · 사이즈별 재고 · variant id 를 통째로 넣어 준다).
   * 페이지를 열지도, 스크롤하지도, 상품마다 페이지를 받지도 않는다 — fetch 한 번(약 0.6~1초).
   * 카테고리(#sweatshirts)는 상품의 type 으로 거른다. 없거나 못 거르면 null (예전 길로).
   */
  private async listFromPageJson(collection: string): Promise<ListResult | null> {
    const ask = async (): Promise<PageProductsResult> =>
      (await this.run(pageProductsScript(collection, this.nav?.origin ?? ""))) as PageProductsResult;
    const cached = this.pageJsonCache && Date.now() - this.pageJsonCache.at < 1500 ? this.pageJsonCache.got : null;
    let got = cached;
    let via = cached ? "방금 받음" : "크롬";
    if (!got && this.prefetch) {
      // 크롬이 뜨는 동안 Node 에서 미리 받아 둔 첫 바퀴.
      const early = await this.prefetch;
      this.prefetch = null;
      if (early?.ok && early.found) {
        got = early;
        via = "미리 받음";
      }
    }
    if (!got && this.fast.direct && this.nav && this.directFailures < 2) {
      const direct = await fetchPageProducts(this.nav.origin, collection, this.fast.cookie ?? "");
      if (direct?.ok && direct.found) {
        got = direct;
        via = "Node";
        this.directFailures = 0;
      } else {
        this.directFailures++;
      }
    }
    got ??= await ask();
    if (got?.noOrigin && this.nav) {
      // 아직 슈프림 주소가 아니다(빈 창) — 한 번만 컬렉션으로 가 둔다. 이후로는 그 자리에서 fetch 만 한다.
      try {
        await this.nav.goto(`${this.nav.origin}/collections/${collection}`);
      } catch {
        /* 못 가면 예전 길로 */
      }
      got = await ask();
    }
    if (!got?.ok) return null;
    if (!cached) this.pageJsonCache = { at: Date.now(), got };
    if (!got.found) {
      this.pageJsonMissing = true;
      return null;
    }
    const all = got.products ?? [];
    const picked = all.filter((p) => inCollection(p, collection));
    if (!picked.length) return null; // 모르는 컬렉션 이름 — 그 페이지를 직접 긁는 예전 길로
    const products = picked.map((p) => {
      const product = withPageColor(normalizeProduct(p), str(p.color));
      const extra = [p.is_new ? "new" : "", str(p.type ?? p.product_type)].filter(Boolean);
      return extra.length ? { ...product, tags: [product.tags, ...extra].filter(Boolean).join(", ") } : product;
    });
    return {
      mode: "page-json",
      status: num(got.status),
      products,
      hero: "",
      note: `products-json ${products.length}/${num(got.total) || all.length}개 (${via})`,
    };
  }

  async list(collection: string): Promise<ListResult> {
    if (!this.pageJsonMissing) {
      const fast = await this.listFromPageJson(collection);
      if (fast) return fast;
    }
    // **컬렉션 주소로 먼저 간다.** 지금 페이지(홈)를 긁으면 신상품 그리드만 보인다.
    if (this.nav) {
      try {
        await this.nav.goto(`${this.nav.origin}/collections/${collection}`);
      } catch {
        /* 못 가면 지금 페이지로 해 본다 */
      }
    }
    const json = this.listJsonBlocked
      ? null
      : ((await this.run(listScript(collection))) as {
          mode?: string;
          status?: number;
          products?: RawProduct[];
          hero?: string;
          note?: string;
        } | null);
    if (json && [401, 403].includes(num(json.status))) this.listJsonBlocked = true;
    if (json && Array.isArray(json.products) && json.products.length > 0) {
      return {
        mode: "json",
        status: num(json.status),
        products: json.products.map((p) => normalizeProduct(p)),
        hero: str(json.hero),
        note: str(json.note),
      };
    }
    const note = json ? `products.json ${num(json.status)} ${str(json.note)}` : this.listJsonBlocked ? "products.json 막힘(건너뜀)" : "products.json 응답 없음";
    const html = (await this.run(listHtmlScript(collection))) as {
      products?: HtmlCard[];
      hero?: string;
      note?: string;
    } | null;
    const cards = html && Array.isArray(html.products) ? html.products : [];
    return {
      mode: cards.length ? "html" : "none",
      status: cards.length ? 200 : num(json?.status),
      products: cards.map((c) => normalizeCard(c)),
      hero: str(html?.hero ?? json?.hero),
      note: cards.length ? `${str(html?.note)} · HTML 폴백` : `${note} · HTML 폴백 실패`,
    };
  }

  /**
   * variant 정보가 없는(HTML 폴백) 상품을 살 때 해석한다.
   *   1순위 /products/<handle>.js  (막히지 않은 스토어)
   *   2순위 상품 페이지에 박힌 product-…-json  (Supreme 의 실제 경로 — .js 는 403 이다)
   */
  async resolve(handle: string): Promise<Product | null> {
    const js = this.productJsBlocked
      ? null
      : ((await this.run(productScript(handle))) as { ok?: boolean; status?: number; product?: RawProduct } | null);
    if (js && [401, 403].includes(num(js.status))) this.productJsBlocked = true;
    if (js?.ok && js.product) {
      const product = normalizeProduct(js.product);
      if (!product.handle) product.handle = handle;
      this.lastResolveNote = `products/<handle>.js (HTTP ${num(js.status)})`;
      return product;
    }
    const page = (await this.run(productPageScript(handle))) as {
      ok?: boolean;
      status?: number;
      product?: RawProduct;
      color?: string;
      reason?: string;
    } | null;
    if (page?.ok && page.product) {
      const product = withPageColor(normalizeProduct(page.product), str(page.color));
      if (!product.handle) product.handle = handle;
      this.lastResolveNote = `상품 페이지 JSON (HTTP ${num(page.status)})`;
      return product;
    }
    this.lastResolveNote = `.js HTTP ${num(js?.status)} · 페이지 ${page?.reason ?? `HTTP ${num(page?.status)}`}`;
    return null;
  }

  async addToCart(variantId: string, quantity: number): Promise<{ ok: boolean; status: number; raw: string }> {
    const res = (await this.run(addToCartScript(variantId, quantity))) as {
      ok?: boolean;
      status?: number;
      raw?: string;
      data?: { message?: string; description?: string };
    } | null;
    return {
      ok: !!res?.ok,
      status: num(res?.status),
      raw: str(res?.raw || res?.data?.description || res?.data?.message),
    };
  }

  async cart(): Promise<{
    count: number;
    total: number;
    items: { key: string; id: string; line: number; title: string; quantity: number; variant: string }[];
  }> {
    const res = (await this.run(cartScript())) as {
      ok?: boolean;
      cart?: { item_count?: number; total_price?: number; items?: { key?: unknown; id?: unknown; product_title?: unknown; title?: unknown; quantity?: unknown; variant_title?: unknown }[] };
    } | null;
    const cart = res?.ok ? res.cart : null;
    const items = Array.isArray(cart?.items) ? cart.items : [];
    return {
      count: num(cart?.item_count),
      total: num(cart?.total_price),
      items: items.map((i, at) => ({
        key: str(i.key),
        id: String(num(i.id) || ""),
        line: at + 1,
        title: str(i.product_title ?? i.title),
        quantity: num(i.quantity),
        variant: str(i.variant_title),
      })),
    };
  }

  /** 장바구니를 비운다 — 드랍 때 미끼를 치우고 원하는 상품으로 바꾸기 위해. */
  async clearCart(): Promise<{ ok: boolean; reason: string }> {
    const res = (await this.run(cartClearScript())) as { ok?: boolean; status?: number; error?: string } | null;
    if (!res?.ok) return { ok: false, reason: `비우지 못했습니다 (HTTP ${num(res?.status)}${res?.error ? ` ${res.error}` : ""})` };
    const after = await this.cart();
    if (after.count > 0) return { ok: false, reason: `비운 뒤에도 ${after.count}개가 남아 있습니다` };
    return { ok: true, reason: "장바구니를 비웠습니다" };
  }

  /** 한 줄의 수량을 바꾼다 (0 이면 뺀다). */
  async changeCart(who: { key?: string; id?: string; line?: number }, quantity: number): Promise<{ ok: boolean; count: number; reason: string }> {
    const res = (await this.run(cartChangeScript(who, quantity))) as { ok?: boolean; status?: number; count?: number | null; raw?: string } | null;
    if (!res?.ok) return { ok: false, count: -1, reason: `바꾸지 못했습니다 (HTTP ${num(res?.status)}${res?.raw ? ` ${res.raw}` : ""})` };
    return { ok: true, count: res.count ?? -1, reason: `수량을 ${quantity} 로` };
  }

  async stage(): Promise<{ url: string; path: string; email: boolean; ship: boolean; pay: boolean; done: boolean; title: string }> {
    const res = (await this.run(checkoutStageScript())) as {
      url?: string;
      path?: string;
      email?: boolean;
      ship?: boolean;
      pay?: boolean;
      done?: boolean;
      title?: string;
    } | null;
    return {
      url: str(res?.url),
      path: str(res?.path),
      email: !!res?.email,
      ship: !!res?.ship,
      pay: !!res?.pay,
      done: !!res?.done,
      title: str(res?.title),
    };
  }

  async pageState(): Promise<{ url: string; title: string; blocked: boolean; challenge: boolean; text: string }> {
    const res = (await this.run(pageStateScript())) as {
      url?: string;
      title?: string;
      blocked?: boolean;
      challenge?: boolean;
      text?: string;
    } | null;
    return {
      url: str(res?.url),
      title: str(res?.title),
      blocked: !!res?.blocked,
      challenge: !!res?.challenge,
      text: str(res?.text),
    };
  }
}
