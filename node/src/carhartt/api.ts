/**
 * 칼하트윕 코리아(carhartt-wip.co.kr) 상품·재고를 공개 API 에서 받아 온다.
 *
 * 페이지를 뜯지 않는다. 상품 페이지(/products/<번호>)는 Next.js 가 그리는 화면이고(약 130KB), 거기 박힌
 * 데이터에는 사이즈마다 품절 여부(isSoldOut)만 있다. 그 화면이 부르는 원본이 여기 있다 — 열쇠도 로그인도
 * 필요 없고, **사이즈마다 남은 수량(availableStock)** 까지 준다 (2026-11-11 에 재 봤다):
 *
 *   GET https://msa.carhartt-wip.co.kr/v2/products/343826/sizes?sourceSite=CARHARTT   → 161B
 *     {"code":"SUCCESS","payload":[{"id":1795582,"sizeName":"OS","availableStock":147,"inStock":true,…}]}
 *   GET https://msa.carhartt-wip.co.kr/v2/products/343826?sourceSite=CARHARTT         → 이름·가격·발매 시각
 *
 * sourceSite 를 빼면 "상품을 찾을 수 없습니다" (400) 가 온다 — 같은 서버를 웍스아웃 계열 몰이 같이 쓴다.
 *
 * 앞단은 CloudFront 고 **약 5초** 캐싱한다 (2026-11-12 에 0.5초 간격으로 재 봤다 — Age 가 0→4 로 오르다 4.8초마다
 * Miss). 그래서 주소를 그대로 두드리면 1초마다 봐도 최대 5초 묵은 재고를 받는다. 캐시 열쇠에 쿼리가 들어가서
 * (`&_=<시각>` 을 붙이면 매번 Miss, 원본이 40ms 쯤에 답한다) **감시용 사이즈 조회는 쿼리를 붙여 원본을 직접 본다** —
 * fetchSizes 의 fresh. 발매 순간에 5초 묵은 "품절" 을 받고 헛돌지 않게 하려는 것이 첫째다.
 */

const API = "https://msa.carhartt-wip.co.kr/v2";
const SITE = "https://www.carhartt-wip.co.kr";
const SOURCE = "CARHARTT";
// 사람 흉내를 내려는 것이 아니라, 빈 UA 로 오는 것을 막아 두는 앞단이 흔해서다.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** 조회가 안 된 것 (끊김·5xx). 다시 두드리면 될 수 있는 것과, 번호가 틀린 것을 가르려고 따로 둔다. */
export class FetchFailed extends Error {}

export interface SizeStock {
  id: number;
  name: string;
  /** 남은 수량. 서버가 안 주면 null (그때는 inStock 만 믿는다). */
  stock: number | null;
  inStock: boolean;
}

export interface Product {
  id: string;
  name: string;
  koreanName: string;
  color: string;
  code: string;
  price: number;
  /** 발매 시각 (한국 시간). 없으면 이미 파는 상품이다. */
  availableFrom: Date | null;
  /** 한 사람이 살 수 있는 수량. 0 이면 제한 없음. */
  perUser: number;
  membersOnly: boolean;
  appOnly: boolean;
  offlineOnly: boolean;
  /** 살 때 답해야 하는 문제 (래플·한정 상품에 가끔 붙는다). 없으면 "". */
  question: string;
}

export interface Snapshot {
  product: Product;
  sizes: SizeStock[];
  fetchedAt: Date;
}

/** 주소를 통째로 적어도 번호만 뽑아 쓴다. 번호가 아니면 "". */
export function productIdOf(text: string): string {
  const raw = String(text || "").trim();
  if (/^\d+$/.test(raw)) return raw;
  return /\/products\/(\d+)/.exec(raw)?.[1] ?? "";
}

export const pageUrl = (id: string): string => `${SITE}/products/${id}`;

interface Envelope {
  code?: string;
  payload?: unknown;
  message?: string | null;
}

/** 서버가 거절한 것 (4xx). 번호가 틀렸거나, 로그인이 없거나, 아직 못 사는 상품이다. status 로 가른다. */
export class Rejected extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * 서버가 몰려서 지금은 안 받는다는 것. 이 사이트에는 **대기열(순번)이 없다** — 몰리면 그냥 쳐낸다 (2026-11-11 번들):
 *   · 429 → 화면에 "현재 접속이 몰려 잠시 이용이 불가합니다" (사이트는 0.5초 간격으로 다섯 번 다시 부른다)
 *   · 307 → 브라우저를 /error ("접속량이 많아 서비스가 지연되고 있습니다") 로 보낸다
 * 줄을 서는 것이 아니라 다시 두드리면 들어가는 것이라, 부르는 쪽이 조금 쉬었다가 거듭 부른다.
 */
export class Busy extends FetchFailed {}

export interface CallOptions {
  method?: "GET" | "POST" | "PUT";
  /** JSON 으로 보낼 것. */
  body?: unknown;
  /** 로그인 토큰 (Bearer 뒤에 올 것만). */
  token?: string;
  /** 사이트가 같이 보내는 기기 표지 (X-Device-Id). 로그인·갱신에 쓴다. */
  deviceId?: string;
  /** sourceSite=CARHARTT 를 붙일까. 상품 조회는 없으면 "찾을 수 없습니다" 가 온다. */
  source?: boolean;
  /** 앞단 캐시(약 5초)를 건너뛴다 — 쿼리에 시각을 붙인다. source 와 같이만 쓴다. */
  fresh?: boolean;
}

/**
 * API 를 한 번 부르고 payload 를 돌려준다. 봉투는 언제나 {code, payload, message} 다.
 *   · 4xx → Rejected (다시 두드려 봐야 같은 답이다)
 *   · 끊김·5xx·JSON 아님 → FetchFailed (다시 두드리면 될 수 있다)
 */
export async function call(path: string, options: CallOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = {
    "User-Agent": UA, Accept: "application/json", "X-Store": SOURCE, Origin: SITE, Referer: `${SITE}/`,
  };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  if (options.deviceId) headers["X-Device-Id"] = options.deviceId;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    const query = options.source ? `?sourceSite=${SOURCE}${options.fresh ? `&_=${Date.now()}` : ""}` : "";
    res = await fetch(`${API}/${path}${query}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      // 307 을 따라가면 /error 의 HTML 을 받게 된다 — 따라가지 않고 "몰렸다" 로 읽는다.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new FetchFailed(`조회 중 오류: ${(e as Error).message}`);
  }
  if (res.status === 429 || (res.status >= 300 && res.status < 400)) {
    throw new Busy(`접속이 몰려 서버가 받지 않습니다 (${res.status})`);
  }
  const text = await res.text();
  let body: Envelope;
  try {
    body = JSON.parse(text) as Envelope;
  } catch {
    if (res.status >= 400 && res.status < 500) throw new Rejected(res.status, `거절됐습니다 (${res.status})`);
    throw new FetchFailed(`받은 것이 JSON 이 아닙니다 (${res.status}): ${text.slice(0, 120)}`);
  }
  // 없는 번호는 400 + BAD_REQUEST 로 온다. 다시 두드려 봐야 소용없다.
  if (res.status >= 400 && res.status < 500) throw new Rejected(res.status, body.message || `거절됐습니다 (${res.status})`);
  if (!res.ok) throw new FetchFailed(`조회 실패 (${res.status}): ${body.message ?? body.code ?? ""}`);
  // 200 인데 code 가 SUCCESS 가 아닌 판 — 서버가 말로 거절한 것이다.
  if (body.code !== "SUCCESS") throw new Rejected(res.status, body.message || String(body.code ?? "거절됐습니다"));
  return body.payload;
}

const get = (path: string, fresh = false): Promise<unknown> => call(path, { source: true, fresh });

const num = (v: unknown, blank = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : blank);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * 사이즈마다 남은 수량. 감시가 도는 동안은 이것만 부른다 (161B).
 * @param fresh 앞단 캐시를 건너뛸까 (기본 그렇다 — "지금 구매" 의 첫 판단도 이것으로 한다).
 */
export async function fetchSizes(id: string, fresh = true): Promise<SizeStock[]> {
  const payload = await get(`products/${id}/sizes`, fresh);
  if (!Array.isArray(payload)) throw new FetchFailed("사이즈 목록이 배열이 아닙니다 — API 모양이 바뀌었을 수 있습니다.");
  return (payload as Record<string, unknown>[])
    .slice()
    .sort((a, b) => num(a["sort"]) - num(b["sort"]))
    .map((s) => {
      const stock = typeof s["availableStock"] === "number" ? s["availableStock"] : null;
      return {
        id: num(s["id"]),
        name: str(s["sizeName"]) || str(s["sizeCode"]) || String(s["id"] ?? "?"),
        stock,
        // inStock 을 안 주는 판이 오면 수량으로 판단한다.
        inStock: typeof s["inStock"] === "boolean" ? s["inStock"] : (stock ?? 0) > 0,
      };
    });
}

export async function fetchProduct(id: string): Promise<Product> {
  const p = (await get(`products/${id}`)) as Record<string, unknown> | null;
  if (!p || typeof p !== "object") throw new FetchFailed("상품 정보가 비어 있습니다.");
  // "2026-11-12T11:00" — 시간대가 안 붙어 온다. 한국 몰이라 한국 시간이다.
  const from = str(p["availableFrom"]);
  const at = from ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(from) ? from : `${from}+09:00`) : null;
  return {
    id,
    name: str(p["productName"]),
    koreanName: str(p["productKoreanName"]),
    color: str(p["colorName"]),
    code: str(p["productCode"]),
    price: num(p["currentPrice"]),
    availableFrom: at && !Number.isNaN(at.getTime()) ? at : null,
    perUser: num(p["availableStockUser"]),
    membersOnly: p["isOnlyForUser"] === true,
    appOnly: p["isOnlyApp"] === true,
    offlineOnly: p["onlyOffline"] === true,
    question: typeof p["question"] === "string" ? p["question"].trim() : p["question"] ? JSON.stringify(p["question"]) : "",
  };
}

export async function fetchSnapshot(id: string): Promise<Snapshot> {
  const [product, sizes] = await Promise.all([fetchProduct(id), fetchSizes(id)]);
  return { product, sizes, fetchedAt: new Date() };
}

/** 남은 수량의 합. 수량을 안 주는 사이즈는 0 으로 센다. */
export const totalStock = (sizes: SizeStock[]): number => sizes.reduce((sum, s) => sum + (s.stock ?? 0), 0);

export const anyInStock = (sizes: SizeStock[]): boolean => sizes.some((s) => s.inStock);

/** 아직 발매 전인가. 재고가 잡혀 있어도 이 시각 전에는 못 산다. */
export const notYetOpen = (p: Product, at: Date = new Date()): boolean =>
  p.availableFrom !== null && p.availableFrom.getTime() > at.getTime();
