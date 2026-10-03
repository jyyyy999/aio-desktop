/** 살 상품. 설정에 적힌 것을 알아보고, 다시 적어 넣을 형태로 돌려준다. */
import type { Config, TargetSpec } from "./config.js";

// 상품 주소. 브랜드스토어와 스마트스토어는 호스트만 다르고 뒤는 같다.
export const PRODUCT_RE = /(?:brand|smartstore)\.naver\.com\/([^/?#]+)\/products\/(\d+)/;
const DIGITS_RE = /^\d+$/;

export interface Target {
  /** 주소에 실리는 번호(채널상품번호). 상태 파일의 열쇠이기도 하다. */
  key: string;
  channel: string;
  host: string;
  url: string;
  ea: number;
  /** 옵션 상품이면 무엇을 고를지. 화면에 보이는 글자의 일부면 된다. */
  option: string;
  max_price: number;
  label: string;
}

/** 상품 주소에서 [채널, 상품번호] 를 뽑는다. 번호만 줘도 받는다. */
export function parseUrl(value: unknown): [string | null, string] {
  const text = String(value ?? "").trim();
  const found = PRODUCT_RE.exec(text);
  if (found) return [found[1]!, found[2]!];
  // 채널을 모르면 주소를 만들 수 없다. 번호만 주는 것은 --add 에서 막는다.
  if (DIGITS_RE.test(text)) return [null, text];
  throw new Error(
    `상품 주소를 알아보지 못했습니다: ${text}\n` +
    "  예) https://brand.naver.com/pokemon/products/12714734588",
  );
}

export function productUrl(channel: string, productNo: string, host = "brand.naver.com"): string {
  return `https://${host}/${channel}/products/${productNo}`;
}

/** 주소에서 호스트만. 스킴이 빠져 있어도 받는다. */
function hostOf(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host || "brand.naver.com";
  } catch {
    return "brand.naver.com";
  }
}

export function parseTarget(entry: unknown): Target {
  const spec: TargetSpec = typeof entry === "string" ? { url: entry } : (entry as TargetSpec) ?? {};
  const url = spec.url || "";
  const [channel, productNo] = parseUrl(url);
  if (!channel) throw new Error(`채널을 알 수 없습니다. 상품 주소를 통째로 넣어주세요: ${url}`);

  const host = hostOf(url);
  return {
    key: productNo,
    channel,
    host,
    url: productUrl(channel, productNo, host),
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
 * 주소만 주고 감시할 수 있어야 한다 — 캡차에 막히는 상품을 targets 에 넣어 두면
 * HTTP 감시가 매 바퀴 실패로 센다. 그렇다고 설정에 적어 둔 옵션·수량·상한가를
 * 주소로 부른다는 이유로 잃어버리면 그것도 사고다.
 */
export function targetFor(cfg: Config, url: string): Target {
  if (!url) {
    const entries = cfg.targets ?? [];
    if (!entries.length) throw new Error("감시할 상품 주소를 주세요 (또는 --add 로 넣어주세요).");
    return parseTarget(entries[0]);
  }

  const key = parseTarget(url).key;
  for (const entry of cfg.targets ?? []) {
    const known = parseTarget(entry);
    if (known.key === key) return known;
  }
  return parseTarget(url);
}
