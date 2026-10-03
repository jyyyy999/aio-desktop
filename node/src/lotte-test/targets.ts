/**
 * 살 상품. 설정에 적힌 것을 알아보고, 다시 적어 넣을 형태로 돌려준다.
 *
 * 롯데온의 상품 주소는 이렇게 생겼다 (사람이 준 것을 그대로 옮긴다).
 *
 *   https://www.lotteon.com/p/product/LM4904810155652
 *     ?areaCode=RCM2019_P04&sitmNo=LM4904810155652_001&dp_infw_cd=PDD
 *
 *   LM4904810155652       상품번호. ld+json 의 sku 와 같다 (확인함)
 *   sitmNo=…_001          그 상품의 단품(옵션) 번호. 옵션 상품이면 여기가 갈린다
 *   areaCode·dp_infw_cd   어디서 눌러 들어왔는지. 우리와는 상관없다
 */
import type { Config, TargetSpec } from "./config.js";

// 상품 주소. 호스트도 길도 가리지 않는다 — m.lotteon.com 도, 모바일 쪽 /m/product/ 도
// 같은 물건을 가리킨다. 어느 쪽으로 받든 productUrl 이 /p/product/ 로 되돌려 놓는다.
export const PRODUCT_RE = /lotteon\.com\/[pm]\/product\/([A-Za-z0-9_-]+)/;
// 주소 없이 상품번호만 줘도 받는다. LM… · LO… 처럼 영문 두 자에 숫자가 붙는다.
const CODE_RE = /^[A-Za-z]{1,3}\d{6,}$/;
const SITM_RE = /[?&]sitmNo=([^&#]+)/;

export interface Target {
  /** 상품번호. 상태 파일의 열쇠이기도 하다. */
  key: string;
  /** 단품 번호(sitmNo). 준 그대로 붙여 준다 — 옵션 상품은 이게 있어야 그 옵션이 열린다. */
  sitmNo: string;
  url: string;
  ea: number;
  /** 옵션 상품이면 무엇을 고를지. 화면에 보이는 글자의 일부면 된다. */
  option: string;
  max_price: number;
  label: string;
}

/** 상품 주소에서 상품번호를 뽑는다. 번호만 줘도 받는다. */
export function parseUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  const found = PRODUCT_RE.exec(text);
  if (found) return found[1]!;
  if (CODE_RE.test(text)) return text;
  throw new Error(
    `상품 주소를 알아보지 못했습니다: ${text}\n` +
    "  예) https://www.lotteon.com/p/product/LM4904810155652?sitmNo=LM4904810155652_001",
  );
}

/**
 * 상품 주소를 만든다.
 *
 * **sitmNo 는 있으면 붙인다.** 옵션이 여럿인 상품은 이게 없으면 어느 단품인지 정해지지
 * 않아, 사람이 준 주소로 열었을 때와 다른 화면이 뜰 수 있다. 나머지 꼬리표
 * (areaCode·dp_infw_cd)는 광고 추적용이라 떼고 간다.
 */
export function productUrl(key: string, sitmNo = ""): string {
  const base = `https://www.lotteon.com/p/product/${key}`;
  return sitmNo ? `${base}?sitmNo=${encodeURIComponent(sitmNo)}` : base;
}

export function parseTarget(entry: unknown): Target {
  const spec: TargetSpec = typeof entry === "string" ? { url: entry } : (entry as TargetSpec) ?? {};
  const url = spec.url || "";
  const key = parseUrl(url);
  const sitmNo = SITM_RE.exec(url)?.[1] ?? "";

  return {
    key,
    sitmNo: decodeURIComponent(sitmNo),
    url: productUrl(key, decodeURIComponent(sitmNo)),
    ea: Math.max(1, Number(spec.ea ?? 1)),
    option: String(spec.option ?? "").trim(),
    max_price: Number(spec.max_price ?? 0),
    label: String(spec.label ?? ""),
  };
}

export function targetsOf(cfg: Config): Target[] {
  return (cfg.targets ?? []).map((entry) => parseTarget(entry));
}

/**
 * 주소 하나를 대상으로 만든다. 설정에 이미 있는 상품이면 거기 적어 둔 것을 쓴다.
 *
 * 설정에 적어 둔 옵션·수량·상한가를 "주소로 불렀다" 는 이유만으로 잃어버리면 사고다.
 */
export function targetFor(cfg: Config, url: string): Target {
  if (!url) {
    const entries = cfg.targets ?? [];
    if (!entries.length) throw new Error("살 상품 주소를 주세요 (또는 --add 로 넣어주세요).");
    return parseTarget(entries[0]);
  }

  const asked = parseTarget(url);
  for (const entry of cfg.targets ?? []) {
    const known = parseTarget(entry);
    // 상품번호가 같아도 단품이 다르면 다른 물건이다. 둘 다 같을 때만 설정 것을 쓴다.
    if (known.key === asked.key && (!asked.sitmNo || known.sitmNo === asked.sitmNo)) return known;
  }
  return asked;
}
