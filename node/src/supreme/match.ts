/**
 * 상품 스냅샷 · diff · 필터 · variant 고르기. 순수 함수만 — 드라이버도 파일도 모른다.
 * (감시 루프와 구매 결정이 같은 답을 내게 한 곳에 둔다.)
 */
import type { Product, Variant } from "./site.js";

export interface MonitorRule {
  include: string[];
  exclude: string[];
  colors: string[];
  sizes: string[];
  categories: string[];
  maxPrice: number;
  onlyAvailable: boolean;
  detectRestock: boolean;
  detectNewVariant: boolean;
  silentFirstScan: boolean;
}

export interface BuyRule {
  quantity: number;
  sizePriority: string[];
  ignoreSizeIfSingleVariant: boolean;
  /** 원하는 사이즈가 없을 때 **다른 사이즈로 대체할지**. 기본 false — 엉뚱한 사이즈를 사지 않는다. */
  sizeFallback: boolean;
}

export type EventKind = "new-product" | "new-variant" | "restock";

export interface DropEvent {
  kind: EventKind;
  product: Product;
  variant: Variant | null;
  at: number;
}

export interface Snapshot {
  at: number;
  byHandle: Map<string, { product: Product; variants: Map<string, Variant> }>;
}

const lower = (s: string): string => s.toLowerCase();
const hasAny = (hay: string, needles: string[]): boolean => {
  const t = lower(hay);
  return needles.some((n) => t.includes(lower(n)));
};

/** 낱말로 쪼갠다 — 악센트·® 를 떼고 글자·숫자만 ("GORE-TEX N-2B" → gore tex n 2b, "Appliqué" → applique). */
export function wordsOf(s: string): string[] {
  return lower(String(s || ""))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9가-힣]+/)
    .filter(Boolean);
}

/**
 * 키워드가 이름에 **낱말로** 들어 있나 — 키워드의 낱말마다 이름의 어떤 낱말의 **앞부분**이어야 한다.
 * "sweat" → Sweatshirt 는 되고, "red" → Predator · "tan" → Stand 는 안 된다
 * (2026-10-12 실사이트 225개로 확인: 글자 일부로 찾았더니 +red 가 Predator Camo 9개, +tan 이 Stand Collar 재킷에 걸렸다).
 */
export function hasKeyword(hay: string, needle: string): boolean {
  const have = wordsOf(hay);
  const want = wordsOf(needle);
  return want.length > 0 && want.every((w) => have.some((h) => h.startsWith(w)));
}

/** 색이 맞나 — 색 이름과 **낱말 단위로** 견준다 ("grey" → Heather Grey 는 맞고, "red" → Predator Camo 는 아니다). */
export function colorMatches(color: string, want: string): boolean {
  const have = wordsOf(color);
  const w = wordsOf(want);
  return w.length > 0 && w.every((x) => have.includes(x));
}

/** 색이 **정확히** 같나 ("Black" = black, "Washed Black" ≠ black) — 여럿 걸리면 이것을 먼저 산다. */
export function colorExact(color: string, want: string): boolean {
  const a = wordsOf(color).join(" ");
  return !!a && a === wordsOf(want).join(" ");
}

/**
 * 상품의 색 — products-json 의 color(withPageColor 가 넣는다), 없으면 이름 끝의 " - 색"
 * (목록 카드 alt 가 "이름 - 색" 꼴이다). 색이 variant 로 갈리는 상품은 "" (variant 가 고른다).
 */
export function productColor(product: Product): string {
  if (product.color?.trim()) return product.color.trim();
  if (product.variants.some((v) => v.color.trim())) return "";
  const at = product.title.lastIndexOf(" - ");
  return at > 0 ? product.title.slice(at + 3).trim() : "";
}

export function buildSnapshot(products: Product[], at = Date.now()): Snapshot {
  const byHandle = new Map<string, { product: Product; variants: Map<string, Variant> }>();
  for (const product of products) {
    if (!product.handle) continue;
    const variants = new Map<string, Variant>();
    for (const variant of product.variants) variants.set(variant.id, variant);
    byHandle.set(product.handle, { product, variants });
  }
  return { at, byHandle };
}

/**
 * 앞 스냅샷과 견준다. 첫 바퀴(silentFirstScan)에는 아무것도 알리지 않는다 — 쏟아지는 알림 방지.
 */
export function diff(prev: Snapshot | null, products: Product[], rule: MonitorRule, now = Date.now()): { events: DropEvent[]; first: boolean } {
  const first = !prev || prev.at === 0;
  if (first && rule.silentFirstScan) return { events: [], first: true };
  const base = prev ?? buildSnapshot([], 0);
  const events: DropEvent[] = [];

  for (const product of products) {
    if (!product.handle) continue;
    const seen = base.byHandle.get(product.handle);

    if (!product.variants.length) {
      if (!seen && (!rule.onlyAvailable || product.available)) {
        events.push({ kind: "new-product", product, variant: null, at: now });
      }
      continue;
    }

    for (const variant of product.variants) {
      if (rule.onlyAvailable && !variant.available) continue;
      if (!seen) {
        events.push({ kind: "new-product", product, variant, at: now });
        continue;
      }
      const before = seen.variants.get(variant.id);
      if (!before) {
        if (rule.detectNewVariant) events.push({ kind: "new-variant", product, variant, at: now });
        continue;
      }
      if (rule.detectRestock && before.available === false && variant.available) {
        events.push({ kind: "restock", product, variant, at: now });
      }
    }
  }
  return { events, first: false };
}

/** 상품 단위 필터 (키워드·카테고리·상한가) */
export function matchProduct(product: Product, rule: MonitorRule): { ok: boolean; reason: string } {
  const title = `${product.title} ${product.type} ${product.tags}`;
  if (rule.exclude.length) {
    const hit = rule.exclude.find((k) => hasKeyword(title, k));
    if (hit) return { ok: false, reason: `제외 키워드(${hit})` };
  }
  // 포함은 **전부** 있어야 한다 — "+box +logo" 는 box 와 logo 가 둘 다 들어간 것이어야 한다.
  // (하나라도 있으면 통과로 두면 "+gore +tex" 가 gore 만 들어간 것도 담는다 — 2026-10-08 에 고쳤다.)
  const absent = rule.include.find((needle) => !hasKeyword(title, needle));
  if (absent) return { ok: false, reason: `포함 키워드 불일치(${absent} 없음)` };
  // 색은 **상품의 색**과 낱말로 견준다 (이름 전체의 글자 일부로 찾으면 red 가 Predator 에 걸린다).
  if (rule.colors.length) {
    const color = productColor(product);
    if (color && !rule.colors.some((c) => colorMatches(color, c))) return { ok: false, reason: `색상 불일치(${color})` };
  }
  if (rule.categories.length && !hasAny(`${product.type} ${product.tags}`, rule.categories)) {
    return { ok: false, reason: "카테고리 불일치" };
  }
  if (rule.maxPrice > 0 && product.priceMin > rule.maxPrice) {
    return { ok: false, reason: `상한가 초과(${product.priceMin} > ${rule.maxPrice})` };
  }
  return { ok: true, reason: "상품 필터 통과" };
}

/**
 * **이름 보완 후보인가** — 목록 카드가 늦게 그려져 이름에서 색이 빠져 오는 판이 있다
 * ("GORE-TEX N-2B Jacket - Predator Camo" 가 "GORE-TEX N-2B Jacket" 으로 온다 → `+camo` 가 빗나간다).
 * HTML 카드 상품 중 제외·카테고리·상한가는 통과하고, 포함 키워드가 **일부는 걸리고 일부만 빠진** 것만 후보다.
 * 하나도 안 걸린 상품까지 상품 페이지를 받으면 요청이 목록 크기만큼 늘어난다.
 */
export function needsFullName(product: Product, rule: MonitorRule): boolean {
  if (!product.partial || rule.include.length < 2) return false;
  const text = `${product.title} ${product.type} ${product.tags}`;
  const hits = rule.include.filter((needle) => hasKeyword(text, needle)).length;
  if (hits === 0 || hits === rule.include.length) return false;
  return matchProduct(product, { ...rule, include: [] }).ok;
}

/**
 * 목록 카드에 상품 페이지 JSON(Shop.resolve)의 이름을 덧댄다 — 긴 쪽을 이름으로, 나머지는 매칭 재료(tags)로.
 * variant 의 색은 **색이 하나뿐일 때만** 넣는다 (여러 색이면 넣지 않는다 — 넣으면 다른 색 variant 를 담을 수 있다).
 */
export function withFullName(listed: Product, resolved: Product): Product {
  const colors = [...new Set(resolved.variants.map((v) => v.color.trim()).filter(Boolean))];
  const title = resolved.title.length >= listed.title.length ? resolved.title : listed.title;
  const other = title === resolved.title ? listed.title : resolved.title;
  const tags = [resolved.tags, listed.tags, other === title ? "" : other, colors.length === 1 ? colors[0]! : ""].filter(Boolean).join(", ");
  return { ...resolved, handle: resolved.handle || listed.handle, title, url: listed.url || resolved.url, tags };
}

/**
 * 사이즈 이름 맞추기. 사람은 "L" 이라고 적고 사이트는 "Large" 라고 쓴다 —
 * 2026-10-08 에 이걸 못 맞춰서 **원하는 L 을 두고 Small 을 담았다.**
 */
const SIZE_ALIASES: Record<string, string> = {
  small: "s", medium: "m", large: "l",
  xlarge: "xl", xxlarge: "xxl", xxxlarge: "xxxl",
  "x-large": "xl", "xx-large": "xxl", "xxx-large": "xxxl",
  // 숫자 표기 — "2XL" 은 사이트가 "XXL" 로 쓸 때가 있다 (반대로도 마찬가지).
  "2xs": "xxs", "2xl": "xxl", "3xl": "xxxl",
  onesize: "os", os: "os", free: "os",
};

export function normalizeSize(value: string): string {
  // 신발은 사이트가 "US 6" 라고 쓴다 — 사람이 "6" 이라고 적어도 맞게 "US" 를 뗀다 (2026-10-17 에 "6"·"7" 을 적고 못 샀다).
  const raw = lower(value).replace(/\s+/g, "").replace(/^us(?=\d)/, "");
  if (!raw) return "";
  if (SIZE_ALIASES[raw]) return SIZE_ALIASES[raw]!;
  return raw
    .replace(/xxxlarge/g, "xxxl")
    .replace(/xxlarge/g, "xxl")
    .replace(/xlarge/g, "xl")
    .replace(/large/g, "l")
    .replace(/medium/g, "m")
    .replace(/small/g, "s")
    .replace(/[^a-z0-9.]/g, "");
}

export const sizeEquals = (a: string, b: string): boolean => {
  const x = normalizeSize(a);
  const y = normalizeSize(b);
  return !!x && !!y && x === y;
};

/**
 * 색 조건에 맞는 variant 인가. **variant 에 색이 없으면 통과** — 슈프림은 색마다 상품이 따로라 variant 옵션이
 * 사이즈뿐이고, 색은 상품 이름(포함 키워드)에서 이미 걸렀다. 막으면 색을 적은 태스크가 아무것도 못 산다.
 */
const colorOk = (v: Variant, rule: MonitorRule): boolean =>
  !rule.colors.length || !v.color.trim() || rule.colors.some((c) => colorMatches(v.color, c));

/** variant 단위 필터 (색상·사이즈) */
export function matchVariant(variant: Variant | null, rule: MonitorRule): { ok: boolean; reason: string } {
  if (!variant) return { ok: true, reason: "variant 없음" };
  if (!colorOk(variant, rule)) {
    return { ok: false, reason: `색상 불일치(${variant.color || "?"})` };
  }
  if (rule.sizes.length && !rule.sizes.some((s) => sizeEquals(variant.size, s))) {
    return { ok: false, reason: `사이즈 불일치(${variant.size || "?"})` };
  }
  return { ok: true, reason: "variant 필터 통과" };
}

/** 살 variant 고르기: 원하는 사이즈 우선순위 → 색상 조건 → 품절 제외 */
export function pickVariant(product: Product, buy: BuyRule, rule: MonitorRule): { variant: Variant | null; reason: string } {
  const all = product.variants;
  if (!all.length) return { variant: null, reason: "variant 정보 없음" };
  const inStock = all.filter((v) => v.available);
  if (!inStock.length) return { variant: null, reason: "전 사이즈 품절" };

  const pool = inStock.filter((v) => colorOk(v, rule));
  if (!pool.length) return { variant: null, reason: "색상 조건에 맞는 재고 없음" };
  if (all.length === 1) return { variant: pool[0] ?? null, reason: "단일 variant" };

  for (const want of buy.sizePriority) {
    const hit = pool.find((v) => sizeEquals(v.size, want) || sizeEquals(v.title, want));
    if (hit) return { variant: hit, reason: `사이즈 우선순위(${want})` };
  }
  for (const want of rule.sizes) {
    const hit = pool.find((v) => sizeEquals(v.size, want) || sizeEquals(v.title, want));
    if (hit) return { variant: hit, reason: `감시 사이즈(${want})` };
  }
  // (예전에는 여기서 "재고가 하나만 남았으면" 사이즈를 무시하고 그것을 샀다 — XL 을 적었는데 XL 이 품절이고
  //  Small 만 남자 Small 을 담았다, 2026-10-10. 원사이즈 상품은 위의 "단일 variant" 가 이미 받는다.)
  const sizes = pool.map((v) => v.size || v.title || "?").join(", ");
  // 대체를 허용했을 때만 다른 사이즈로 간다 — 기본은 **사지 않는다** (엉뚱한 사이즈를 결제하지 않게).
  if (buy.sizeFallback) return { variant: pool[0] ?? null, reason: `대체 허용 — ${pool[0]?.size || pool[0]?.title} 로 담습니다` };
  return { variant: null, reason: `원하는 사이즈 없음(재고: ${sizes})` };
}

export interface Decision {
  buy: boolean;
  stage: "product" | "variant" | "pick" | "ok";
  reason: string;
  variant: Variant | null;
}

export function decide(event: DropEvent, rule: MonitorRule, buy: BuyRule): Decision {
  const p = matchProduct(event.product, rule);
  if (!p.ok) return { buy: false, stage: "product", reason: p.reason, variant: null };
  const v = matchVariant(event.variant, rule);
  if (!v.ok) return { buy: false, stage: "variant", reason: v.reason, variant: null };
  const picked = pickVariant(event.product, buy, rule);
  if (!picked.variant) return { buy: false, stage: "pick", reason: picked.reason, variant: null };
  return { buy: true, stage: "ok", reason: picked.reason, variant: picked.variant };
}

/** 상품을 한 줄로 (로그·알림에 쓴다) */
export function describe(product: Product, variant: Variant | null): string {
  const price = product.priceMin > 0 ? ` · ${product.priceMin}` : "";
  const size = variant ? ` · ${[variant.color, variant.size].filter(Boolean).join("/") || variant.title}` : "";
  return `${product.title}${size}${price}`;
}

/**
 * 주소에서 handle 만 뽑는다. Shopify 는 숫자 id 가 아니라 handle 이다.
 *   https://shop.supreme.com/products/box-logo-tee?x=1  →  box-logo-tee
 *   /products/box-logo-tee                               →  box-logo-tee
 *   box-logo-tee                                         →  box-logo-tee
 */
export function parseHandle(url: string): string {
  const text = String(url || "").trim();
  const m = /\/products\/([A-Za-z0-9_-]+)/.exec(text);
  if (m?.[1]) return m[1];
  return text.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? text;
}

/** 두 대상이 같은 상품인가 (주소든 handle 이든). */
export function sameProduct(a: string, b: string): boolean {
  return parseHandle(a) === parseHandle(b);
}

/**
 * **키워드 사양** — 링크 없이 "무엇을 살지" 적는 방법.
 *
 *     +box +logo -jacket     box 와 logo 가 들어가고 jacket 은 아닌 것
 *     +"box logo"            띄어쓴 말은 따옴표로 묶는다
 *     box logo               부호가 없으면 **전부 포함**으로 본다 (부호를 요구하지 않는다)
 *
 * 부호가 하나도 없으면 키워드 사양으로 보지 않는다 — 주소를 잘못 적은 것과 구분해야 하기 때문이다
 * (그 판단은 isKeywordSpec 이 한다. 대시보드의 상품 주소 칸도 이걸로 거른다).
 */
export interface KeywordSpec {
  include: string[];
  exclude: string[];
  /**
   * **`#카테고리`** 로 적은 컬렉션들 — 그 컬렉션만 훑는다.
   *   `#jackets +box`  → jackets 컬렉션만 보고 box 가 들어간 것을 찾는다 (전체 209개를 안 훑어 훨씬 빠르다)
   */
  collections: string[];
}

/** 부호(+/-/#)가 하나라도 있으면 키워드 사양이다. 주소(http…)는 아니다. */
export function isKeywordSpec(spec: string): boolean {
  const text = String(spec || "").trim();
  if (!text || /^https?:\/\//i.test(text) || /shop\.supreme\.com/i.test(text)) return false;
  return /(^|\s)[+#-]\S/.test(text);
}

/** 키워드 사양 → 포함/제외 목록. 쉼표(,)·가운뎃점(、)·쌍반점(;)도 **구분자**로 본다. */
export function parseKeywordSpec(spec: string): KeywordSpec {
  // "+gore, +tex, +n-2b" 처럼 쉼표로 이어 적는 사람이 많다 (2026-10-08 실제로 이렇게 넣었다).
  // 쉼표를 글자로 남겨 두면 "gore," 를 찾느라 아무것도 안 걸린다 — 구분자로 갈라 준다.
  const spaced = String(spec || "").replace(/[,、;，]/g, " ");
  const tokens = spaced.match(/[+-]?"[^"]*"|[+-]?'[^']*'|[+-]?\S+/g) ?? [];
  const include: string[] = [];
  const exclude: string[] = [];
  const collections: string[] = [];
  for (const raw of tokens) {
    // "#jackets" — **그 컬렉션만** 훑는다 (검색을 좁혀 훨씬 빠르다).
    if (raw.startsWith("#")) {
      const name = raw.slice(1).replace(/[.,、;，]+$/g, "").trim();
      if (name) collections.push(name);
      continue;
    }
    const sign = raw.startsWith("+") || raw.startsWith("-") ? raw[0]! : "";
    let word = (sign ? raw.slice(1) : raw).trim();
    if (word.length > 1 && ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'")))) {
      word = word.slice(1, -1).trim();
    }
    word = word.replace(/[.,、;，]+$/g, "").trim();
    if (!word) continue;
    (sign === "-" ? exclude : include).push(word);
  }
  return { include, exclude, collections };
}

/** 키워드 사양을 사람이 읽는 한 줄로. */
export function describeKeywords(spec: KeywordSpec): string {
  const plus = spec.include.map((w) => `+${w}`).join(" ");
  const minus = spec.exclude.map((w) => `-${w}`).join(" ");
  const cats = spec.collections.map((c) => `#${c}`).join(" ");
  return [cats, plus, minus].filter(Boolean).join(" ") || "(빈 키워드)";
}

/**
 * 옵션 한 칸을 **색상 / 사이즈**로 가른다 (집의 관례 — 롯데도 "블랙 / 270" 으로 적는다).
 *
 *   "Predator Camo / Large"  → { color: "Predator Camo", size: "Large" }
 *   "Large"                  → { color: "",               size: "Large" }
 *   "Black / M"              → { color: "Black",          size: "M" }
 *
 * 슈프림은 **색이 상품 이름에 들어 있다**("GORE-TEX N-2B Jacket - Predator Camo"). 그래서 색을 적으면
 * 상품 이름에서 걸러야 하고(포함 키워드), 사이즈는 variant 에서 고른다 — 둘을 따로 다룬다.
 */
export function parseOptionSpec(value: string): { color: string; size: string } {
  const text = String(value || "").trim();
  if (!text) return { color: "", size: "" };
  const at = text.lastIndexOf("/");
  if (at < 0) return { color: "", size: text };
  return { color: text.slice(0, at).trim(), size: text.slice(at + 1).trim() };
}

/** 색·사이즈를 다시 한 줄로 (로그·알림용). */
export function describeOption(option: { color: string; size: string }): string {
  return [option.color, option.size].filter(Boolean).join(" / ") || "(옵션 없음)";
}
