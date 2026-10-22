/**
 * 발매정보의 규칙. 폼(화면)과 main(저장)이 같은 답을 내게 여기 둔다. 타입은 types.ts 에 있다.
 */
import type { ReleaseInput, ReleaseMethod } from "./types.js";

export const RELEASE_METHODS: readonly ReleaseMethod[] = ["fcfs", "raffle", "draw", "reservation", "other"];

export const METHOD_LABEL: Record<ReleaseMethod, string> = {
  fcfs: "선착순",
  raffle: "응모·래플",
  draw: "드로우",
  reservation: "예약",
  other: "기타",
};

/** http · https 주소만. 링크는 기본 브라우저로 열리므로 다른 스킴(file: · javascript: …)은 받지 않는다. */
export function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

/** 폼에서 온 것을 다듬는다 — 글은 자르고, 빈 링크 줄은 뺀다. */
export function tidyRelease(input: ReleaseInput): ReleaseInput {
  const text = (v: unknown) => String(v ?? "").trim();
  return {
    name: text(input.name),
    store: text(input.store),
    releaseAt: text(input.releaseAt),
    method: input.method,
    price: text(input.price),
    thumbnail: text(input.thumbnail),
    links: (Array.isArray(input.links) ? input.links : [])
      .map((l) => ({ label: text(l?.label), url: text(l?.url) }))
      .filter((l) => l.label || l.url),
    memo: text(input.memo),
  };
}

/** 저장할 수 없는 까닭. 괜찮으면 null. (다듬은 것을 넣는다) */
export function releaseProblem(r: ReleaseInput): string | null {
  if (!r.name) return "상품명을 넣으세요.";
  if (!r.store) return "브랜드·스토어를 넣으세요.";
  if (!r.releaseAt || Number.isNaN(new Date(r.releaseAt).getTime())) return "발매 일시를 넣으세요.";
  if (!RELEASE_METHODS.includes(r.method)) return "발매 방식을 고르세요.";
  if (r.thumbnail && !isHttpUrl(r.thumbnail)) return "썸네일 주소는 http:// 나 https:// 로 시작해야 합니다.";
  for (const [i, l] of r.links.entries()) {
    if (!l.url) return `링크 ${i + 1}: 주소를 넣으세요.`;
    if (!isHttpUrl(l.url)) return `링크 ${i + 1}: http:// 나 https:// 주소만 됩니다.`;
  }
  return null;
}
