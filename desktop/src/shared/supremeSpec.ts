/**
 * 슈프림 화면용 — 키워드 사양(`#카테고리 +a -b`)과 "색 / 사이즈" 옵션을 화면에서 다룬다.
 * 규칙은 원본(node/src/supreme/match.ts 의 parseKeywordSpec · parseOptionSpec)과 같다 — 화면이 쓴 값을 원본이 그대로 읽는다.
 */

/** shop.supreme.com 의 컬렉션 (2026-10-08 실제 메뉴). `#jackets` 처럼 적으면 그 컬렉션만 훑어 훨씬 빠르다. */
export const SUPREME_CATEGORIES: { id: string; label: string }[] = [
  { id: "new", label: "new (신상)" },
  { id: "jackets", label: "jackets" },
  { id: "shirts", label: "shirts" },
  { id: "tops-sweaters", label: "tops/sweaters" },
  { id: "sweatshirts", label: "sweatshirts" },
  { id: "pants", label: "pants" },
  { id: "shorts", label: "shorts" },
  { id: "hats", label: "hats" },
  { id: "bags", label: "bags" },
  { id: "accessories", label: "accessories" },
  { id: "shoes", label: "shoes (신발)" },
  { id: "skate", label: "skate" },
];

/**
 * 사이즈 버튼 — **사이트가 쓰는 글자 그대로** 저장한다 (2026-10-17 실제 상품 기준: 옷 "Small"·"XLarge", 신발 "US 6"·"US 6.5").
 * 신발에 "6" 이라고 적어서 "US 6" 을 못 산 일이 있어 손으로 적지 않고 고르게 했다.
 */
export const SUPREME_SIZE_GROUPS: { id: "tops" | "pants" | "shoes" | "os"; label: string; sizes: string[] }[] = [
  { id: "tops", label: "옷", sizes: ["Small", "Medium", "Large", "XLarge", "XXLarge"] },
  { id: "pants", label: "바지 (허리)", sizes: ["28", "30", "32", "34", "36", "38"] },
  {
    id: "shoes", label: "신발 (US)",
    sizes: ["4", "4.5", "5", "5.5", "6", "6.5", "7", "7.5", "8", "8.5", "9", "9.5", "10", "10.5", "11", "11.5", "12", "12.5", "13", "14"].map((n) => `US ${n}`),
  },
  { id: "os", label: "원사이즈", sizes: ["OS"] },
];

/** 버튼에 보일 짧은 이름 — "XLarge" → "XL", "US 6.5" → "6.5". */
export const shortSupremeSize = (size: string): string =>
  ({ Small: "S", Medium: "M", Large: "L", XLarge: "XL", XXLarge: "XXL" } as Record<string, string>)[size] ?? size.replace(/^US\s*/, "");

/** 지금 사이즈·카테고리로 처음 펼칠 묶음 — 고른 사이즈가 든 묶음, 없으면 카테고리(#shoes → 신발). */
export function supremeSizeGroupOf(size: string, category: string): (typeof SUPREME_SIZE_GROUPS)[number]["id"] {
  const hit = SUPREME_SIZE_GROUPS.find((g) => g.sizes.includes(size));
  if (hit) return hit.id;
  if (/^us\s*\d/i.test(size) || category === "shoes") return "shoes";
  if (category === "pants") return "pants";
  if (category === "hats" || category === "bags" || category === "accessories" || category === "skate") return "os";
  return "tops";
}

/** 상품 주소인가 (키워드 사양이 아니라). */
export const isSupremeProductUrl = (spec: string): boolean => /\/products\/[A-Za-z0-9_-]+/.test(spec.trim());

const tokens = (spec: string): string[] => spec.replace(/[,、;，]/g, " ").split(/\s+/).filter(Boolean);
const cleanCategory = (raw: string): string => raw.slice(1).replace(/[.,、;，]+$/g, "").trim();

/** 키워드 사양에서 `#카테고리` 들. */
export function supremeCategories(spec: string): string[] {
  if (isSupremeProductUrl(spec)) return [];
  return tokens(spec).filter((t) => t.startsWith("#")).map(cleanCategory).filter(Boolean);
}

/** `#카테고리` 를 뺀 키워드만 (`+gore +tex -black`). */
export function supremeKeywords(spec: string): string {
  if (isSupremeProductUrl(spec)) return "";
  return spec.trim().split(/\s+/).filter((t) => t && !t.startsWith("#")).join(" ");
}

/** 키워드 사양의 카테고리를 바꾼다 — 있던 `#…` 를 지우고 맨 앞에 하나 둔다 (빈 값이면 전체). */
export function withSupremeCategory(spec: string, category: string): string {
  return [category ? `#${category}` : "", supremeKeywords(spec)].filter(Boolean).join(" ");
}

/** 키워드가 하나라도 있나 (`#카테고리` 만으로는 원본이 사지 않는다 — 아무거나 살 수 있어서). */
export function hasSupremeKeyword(spec: string): boolean {
  return tokens(supremeKeywords(spec)).some((t) => t.replace(/^[+-]/, "").replace(/^["']|["']$/g, "").length > 0);
}

/** "Predator Camo / Large" → 색·사이즈. 빗금이 없으면 사이즈만 (원본 parseOptionSpec 과 같다). */
export function splitSupremeOption(option: string): { color: string; size: string } {
  const text = String(option || "").trim();
  if (!text) return { color: "", size: "" };
  const at = text.lastIndexOf("/");
  if (at < 0) return { color: "", size: text };
  return { color: text.slice(0, at).trim(), size: text.slice(at + 1).trim() };
}

/** 표·태스크 창에 보일 한 줄 — "색 Predator Camo · 사이즈 Large". */
export function describeSupremeOption(option: string): string {
  const { color, size } = splitSupremeOption(option);
  return [color && `색 ${color}`, size && `사이즈 ${size}`].filter(Boolean).join(" · ");
}

/** 카테고리를 한 줄로 — 없으면 전체. */
export function describeSupremeCategories(spec: string): string {
  const cats = supremeCategories(spec);
  return cats.length ? cats.map((c) => `#${c}`).join(" ") : "전체";
}

/** 색·사이즈 → 한 칸. 색이 없으면 사이즈만 적는다 (빗금이 없으면 원본이 사이즈로 읽는다). */
export function joinSupremeOption(color: string, size: string): string {
  const c = color.replace(/\//g, " ").trim();
  const s = size.replace(/\//g, " ").trim();
  return c ? `${c} / ${s}` : s;
}
