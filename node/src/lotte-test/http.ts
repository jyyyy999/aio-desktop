/**
 * 상품 페이지를 받아 올 세션.
 *
 * **네이버와 달리 Node 로 그냥 된다.** 재 본 것이다 (2026-08-23, 같은 상품).
 *
 *   Node fetch  →  200 · 27,169바이트 · 192ms · ld+json 이 통째로 들어 있음
 *
 * 네이버는 TLS 지문을 봐서 Node 의 fetch 를 429 로 밀어냈고(그래서 거기서는 크롬 창이
 * 기본 길이다), 롯데온은 거기까지 보지 않는다. 그래서 여기서는 bnkr 쪽과 같이 **조회는
 * HTTP 로, 누르는 것만 크롬으로** 간다. 한 번에 0.2초짜리라 촘촘히 볼 수 있다.
 *
 * 쿠키 항아리를 두지 않는다. 빌려온 줄을 그대로 싣고, 만료되면 사람이 다시 넣는다 —
 * 받은 쿠키를 섞어 쓰면 무엇이 지금 신분인지 알기 어려워진다.
 */
import { log, tick } from "../log.js";
import { sleep } from "../util.js";

export class SiteError extends Error {}

export const SITE = "https://www.lotteon.com";
// 여기로 튕겼으면 빌려온 세션이 죽은 것이다. 게스트로 '바로 구매하기' 를 눌러 확인했다:
//   https://www.lotteon.com/p/member/login/common?rtnUrl=…
export const LOGIN_PATH = "/p/member/login";
// 로그인해야 볼 수 있는 자리. 살아 있는지 물어보는 데만 쓴다.
// 게스트로 HEAD 를 던지면 302 → /p/member/login/common 이 온다 (확인함).
const LOGIN_CHECK_URL = `${SITE}/p/order/mylotte/orderDeliveryList`;

const TOO_MANY = 429;
const BACKOFF = [3, 8, 20];

export class Session {
  constructor(public cookie = "") {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9",
    };
    if (this.cookie) headers["Cookie"] = this.cookie;
    return headers;
  }

  async get(url: string, timeout = 15): Promise<Response> {
    return fetch(url, {
      headers: this.headers(),
      redirect: "follow",
      signal: AbortSignal.timeout(timeout * 1000),
    });
  }

  /** 본문을 UTF-8 로 읽는다. 선언된 인코딩을 믿지 않는 것은 bnkr 판과 같은 이유다. */
  async body(res: Response): Promise<string> {
    return new TextDecoder("utf-8").decode(new Uint8Array(await res.arrayBuffer()));
  }
}

export function newSession(cookie = ""): Session {
  return new Session(cookie);
}

/**
 * 빌려온 줄에 신분을 지는 쿠키가 들어 있는가.
 *
 * **이름을 못 박지 않는다.** 롯데온이 무엇으로 신분을 지는지 우리가 확인한 적이 없고
 * (로그인은 사람이 브라우저에서 한다), 짐작으로 이름을 적어 두면 사이트가 바꿨을 때
 * 멀쩡한 쿠키를 "없다" 고 막는다. 살아 있는지는 loginAlive() 가 실제로 물어본다.
 */
export function looksLikeCookie(cookie: string): boolean {
  return (cookie || "").split(";").filter((p) => p.includes("=")).length >= 2;
}

/**
 * 빌려온 세션이 아직 살아 있는가. → true / false
 *
 * 로그인해야 볼 수 있는 자리에 HEAD 를 던지고 **따라가지 않는다.** 살아 있으면 200,
 * 끊겼으면 302 로 로그인 페이지를 가리킨다. 본문을 받지 않으니 한 번에 0바이트다.
 *
 * 확인에 실패한 것(그물이 끊겼다)과 로그아웃된 것은 다르다. 못 물어본 경우 SiteError 를
 * 내고, 부른 쪽이 그것 때문에 감시를 접지는 않게 한다.
 */
export async function loginAlive(s: Session): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(LOGIN_CHECK_URL, {
      method: "HEAD",
      headers: s.cookie ? { Cookie: s.cookie } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new SiteError(`로그인 상태를 물어보지 못했습니다: ${(e as Error).message}`);
  }

  if (res.status === 200) return true;

  const where = res.headers.get("location") || "";
  if ([301, 302, 303, 307, 308].includes(res.status) && where.includes(LOGIN_PATH)) return false;

  // 200 도 아니고 로그인 페이지로 보내는 것도 아니다. 우리가 모르는 답이라 판정하지 않는다.
  throw new SiteError(`로그인 확인이 ${res.status} 로 답했습니다 (${where.slice(0, 60) || "이동 없음"})`);
}

/**
 * 상품 페이지 한 장. 429 는 실패로 치지 않고 쉬었다 다시 묻는다.
 *
 * 롯데온에서 429 를 본 적은 없다. 그래도 두는 이유는, 촘촘히 두드리는 프로그램이라
 * 언젠가 만나면 그때가 하필 재고가 열리는 순간일 수 있어서다. 만나면 쉬고 다시 묻는다 —
 * 이걸 위로 올리면 감시 루프가 멀쩡한 상품을 조회 실패로 세고, 쉬어야 할 자리에서
 * 오히려 더 두드리게 된다.
 */
export async function getPage(s: Session, url: string): Promise<string> {
  let last = "";
  let pushed = false;

  for (const base of [...BACKOFF, 0]) {
    let res: Response;
    try {
      res = await s.get(url);
    } catch (e) {
      throw new SiteError(`페이지를 받지 못했습니다: ${(e as Error).message}`);
    }

    const text = await s.body(res);
    if (res.status === 200) {
      // 로그인 페이지를 200 으로 돌려주는 자리가 있다. 상품 페이지인 줄 알고 파싱하면
      // "상품을 못 찾았습니다" 가 나와서, 세션이 끊긴 것을 엉뚱하게 읽게 된다.
      if (new URL(res.url).pathname.includes(LOGIN_PATH)) {
        throw new SiteError("로그인 페이지로 넘어갔습니다 — 세션이 끊겼습니다");
      }
      return text;
    }

    last = `페이지가 ${res.status} 로 답했습니다`;
    pushed = res.status === TOO_MANY;
    if (!pushed || !base) break;

    // Retry-After 를 주면 그 말을 듣는다. 안 주면 우리가 정한 만큼 쉰다.
    const asked = Number(res.headers.get("retry-after") || 0);
    const pause = Math.max(base, Number.isFinite(asked) ? asked : 0);
    tick(`롯데온이 잠시 밀어냅니다 (429) · ${pause}초 쉽니다`);
    await sleep(pause * 1000);
  }

  if (pushed) {
    log.warn("쉬어 보고도 429 입니다. poll_interval_seconds 를 늘려 보세요.");
  }
  throw new SiteError(last);
}
