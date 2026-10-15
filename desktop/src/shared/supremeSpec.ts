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
  { id: "skate", label: "skate" },
];

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
