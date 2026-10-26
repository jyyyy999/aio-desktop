/**
 * 세션 하나. 쿠키 항아리를 직접 든다.
 *
 * 파이썬 쪽은 curl_cffi 의 Session 이 쿠키를 알아서 이고 다녔지만, Node 의 fetch 는
 * 그런 것이 없다. **여기서 제일 중요한 것은 사이트가 새로 내주는 MEMBER_TOKEN 을
 * 받아 쓰는 일이다.** 그 토큰은 요청마다 새로 발급되고 60분 뒤 만료라, 받아 쓰기만
 * 하면 도는 동안 세션이 안 끊긴다. 안 받아 쓰면 붙여넣은 값이 한 시간짜리 시한부다.
 *
 * 파이썬 쪽에는 같은 이름이 도메인만 달리해 둘 남는 문제가 있어 낡은 쪽을 골라 버리는
 * 코드(drop_stale_cookies)가 따로 있다. 여기 항아리는 이름 하나에 값 하나뿐이라 그 일이
 * 저절로 된다 — 사이트가 새로 내주면 그 자리에서 덮인다.
 *
 * TLS 지문까지 흉내내지는 않는다. 그건 curl_cffi 몫이고, 이 사이트는 거기까지 보지 않는다.
 */
import { hint, looksLike, QueueWait } from "./queue.js";

export class SiteError extends Error {}

/** 넘겨주기를 이만큼까지 따라간다 (fetch 의 기본값과 같다). */
const MAX_HOPS = 20;

export class Session {
  private jar = new Map<string, string>();
  /** 대기열을 볼지 말지. 조회 함수마다 설정을 실어 나르는 것보다 세션이 지고 다니는 편이 낫다. */
  queueWatch = true;
  queueMarkers: string[] | null = null;

  constructor(raw = "") {
    this.absorbRaw(raw);
  }

  absorbRaw(raw: string): void {
    for (const part of (raw || "").split(";")) {
      const at = part.indexOf("=");
      if (at <= 0) continue;
      const name = part.slice(0, at).trim();
      if (name) this.jar.set(name, part.slice(at + 1).trim());
    }
  }

  /**
   * 지금 이 세션이 실제로 들고 있는 쿠키.
   *
   * 주문서를 열 때는 설정 파일의 쿠키가 아니라 **이걸** 넘겨야 한다. 담기에 성공하면
   * 사이트가 그 장바구니를 가리키는 쿠키(ORDCART)를 새로 내려주는데, 그건 이 세션의
   * 항아리에만 있다. 설정 문자열을 넘기면 크롬은 담기 전 세션을 그대로 재현하게 되고,
   * 주문서는 "구매 가능한 상품이 없습니다" 라고 정확히 맞는 답을 한다.
   */
  get cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get names(): string[] {
    return [...this.jar.keys()];
  }

  value(name: string): string | undefined {
    return this.jar.get(name);
  }

  /**
   * 사이트가 내려준 쿠키를 받아 넣는다. 이름이 같으면 새것이 이긴다. 빈 값(`MEMBER_TOKEN=` · `remember-me=""`)은
   * 지우라는 뜻이다 — 브라우저처럼 항아리에서 뺀다. 안 빼면 끊긴 로그인 쿠키를 계속 보내 같은 곳으로 끝없이 돌려보내진다.
   */
  private absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0] ?? "";
      const at = pair.indexOf("=");
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (!name) continue;
      if (value && value !== '""') this.jar.set(name, value);
      else this.jar.delete(name);
    }
  }

  async request(
    url: string,
    init: RequestInit & { form?: Record<string, string>; timeout?: number } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      // 크롬이 보내는 것과 같은 줄들.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      Referer: "https://www.bnkrmall.co.kr/",
      ...(init.headers as Record<string, string> | undefined),
    };
    let body = init.body;
    let method = init.method;
    if (init.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      headers["X-Requested-With"] = "XMLHttpRequest";
      body = new URLSearchParams(init.form).toString();
    }

    // **넘겨주기(리다이렉트)는 손으로 따라간다.** fetch 가 따라가게 두면 사이에 내려온 쿠키를 못 받고 처음 쿠키를 그대로
    // 다시 보낸다. 로그인이 끊기면 사이트는 로그인 쿠키를 지우면서 메인으로 넘기는데, 지운 것을 못 받으니 같은 넘기기가
    // 끝없이 돌다 "fetch failed" (redirect count exceeded) 로만 터졌다 (2026-10-23 드랍 직전). 브라우저처럼 매번 받아 넣는다.
    const signal = AbortSignal.timeout((init.timeout ?? 30) * 1000);
    let at = url;
    for (let hop = 0; ; hop++) {
      if (this.jar.size) headers["Cookie"] = this.cookie;
      else delete headers["Cookie"];
      const res = await fetch(at, { ...init, method, headers, body, redirect: "manual", signal });
      this.absorb(res);
      const next = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !next) return res;
      if (hop >= MAX_HOPS) {
        throw new SiteError(`넘겨주기가 ${MAX_HOPS}번 넘게 이어집니다 (${at}) — 로그인 세션이 끊겼을 수 있습니다`);
      }
      at = new URL(next, at).toString();
      // 301·302·303 은 GET 으로 바꿔 따라간다 (브라우저와 같다). 307·308 은 그대로.
      if (res.status !== 307 && res.status !== 308) {
        method = "GET";
        body = undefined;
        delete headers["Content-Type"];
      }
    }
  }

  /**
   * 대기열 화면이면 그 사실을 위로 올린다.
   *
   * 사이트가 주는 답이 우리가 아는 형식이 아닐 때, 그것이 고장인지 "기다리라" 인지는
   * 전혀 다른 일이다. 고장이면 다시 두드리는 게 맞고, 대기열이면 두드리는 게 최악이다.
   */
  private checkQueue(text: string, url: string): void {
    if (!this.queueWatch) return;
    // 대기열 화면은 작다. 큰 응답은 정상 페이지이므로 앞부분만 봐도 충분하다.
    const mark = looksLike(text.slice(0, 20000), url, this.queueMarkers);
    if (mark) throw new QueueWait(mark, hint(text));
  }

  /**
   * ajax 응답을 JSON 으로. **선언된 인코딩을 믿으면 안 된다.**
   *
   * 이 사이트는 text/plain;charset=ISO-8859-1 로 내려보내는데 실제 내용은 UTF-8 이다.
   * 그대로 디코딩하면 한글 사유가 전부 깨져서, 왜 거절당했는지 읽을 수가 없다.
   */
  async json<T>(res: Response, what: string): Promise<T> {
    const text = new TextDecoder("utf-8").decode(new Uint8Array(await res.arrayBuffer()));
    this.checkQueue(text, res.url);
    if (res.status !== 200) throw new SiteError(`${what}: HTTP ${res.status}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      // 세션이 죽으면 JSON 자리에 로그인 페이지가 온다.
      throw new SiteError(
        `${what}: JSON 이 아닌 응답 (${text.length.toLocaleString()}바이트). 세션이 풀렸을 수 있습니다.`,
      );
    }
  }

  async text(res: Response, what: string): Promise<string> {
    const text = new TextDecoder("utf-8").decode(new Uint8Array(await res.arrayBuffer()));
    this.checkQueue(text, res.url);
    if (res.status !== 200) throw new SiteError(`${what}: HTTP ${res.status}`);
    return text;
  }

  /** HTML 한 장. 형식까지 본다 — 세션이 풀리면 JSON 자리에 페이지가 오듯, 여기엔 딴것이 온다. */
  async html(url: string, what = "페이지"): Promise<string> {
    const res = await this.request(url, { headers: { Referer: "https://www.bnkrmall.co.kr/" } });
    const ctype = res.headers.get("content-type") || "";
    const text = await this.text(res, what);
    if (!ctype.includes("html")) {
      throw new SiteError(`${what}: HTTP ${res.status}, ${ctype || "알 수 없는 형식"}`);
    }
    return text;
  }
}

/**
 * 세션을 만들고 홈을 한 번 받아 쿠키를 얻는다.
 *
 * 빌려온 쿠키는 예열 뒤에 얹는다. 순서를 바꾸면 홈이 내려주는 세션 쿠키가 우리가
 * 붙여넣은 로그인 세션을 밀어낸다.
 */
export async function newSession(
  cookie = "",
  opts: { queueWatch?: boolean; queueMarkers?: string[] | null } = {},
): Promise<Session> {
  const s = new Session();
  s.queueWatch = opts.queueWatch ?? true;
  s.queueMarkers = opts.queueMarkers ?? null;
  try {
    await s.request("https://www.bnkrmall.co.kr/");
  } catch {
    // 홈 예열 실패. 계속 진행한다 — 빌려온 쿠키만으로도 대개 된다.
  }
  s.absorbRaw(cookie);
  return s;
}

export function parseCookie(raw: string): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of (raw || "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (name) jar[name] = part.slice(at + 1).trim();
  }
  return jar;
}
