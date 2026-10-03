/**
 * 상품 페이지를 받아 올 세션.
 *
 * **Referer 를 붙이지 않는다.** 붙이면 네이버가 429 로 답한다 — 파이썬 판에서 확인한
 * 것이다. 브라우저 흉내를 더 잘 내려고 붙였던 것인데 정확히 반대로 갔다. 어느 쪽이
 * 사람처럼 보이는지를 우리가 정하려 들지 않는다 — 되는 쪽을 확인해서 그대로 쓴다.
 *
 * 파이썬 쪽은 curl_cffi 가 TLS 지문까지 크롬인 척하지만 Node 의 fetch 에는 그런 것이
 * 없다. 헤더는 같게 보내고 지문은 Node 것 그대로다.
 *
 * 쿠키 항아리를 두지 않는 것도 파이썬 판과 같다. 네이버는 요청마다 NID_SES 를 새로
 * 내주는데, 그것을 받아 쓰면 빌려온 줄과 우리가 받은 것이 뒤섞여 무엇이 지금 신분인지
 * 알기 어려워진다. 빌려온 줄을 그대로 싣고, 만료되면 사람이 다시 넣는다.
 */
import { log, sayOk, sayStep } from "../log.js";
import { cookieOf, loadConfig } from "./config.js";

export class SiteError extends Error {}

// 여기로 튕겼으면 빌려온 세션이 죽은 것이다.
export const LOGIN_HOST = "nid.naver.com";
// 로그인해야 볼 수 있는 자리. 살아 있는지 물어보는 데만 쓴다 (loginAlive).
const LOGIN_CHECK_URL = "https://nid.naver.com/user2/help/myInfoV2?lang=ko_KR";

const TOO_MANY = 429;

/**
 * 캡차 벽. 스마트스토어 **상품 상세 페이지**에서 확인했다 (파이썬 판 주석 참고).
 *
 * 583바이트짜리 답의 정체는 <head title="captcha"> 에 ncpt.naver.com 의 wtm_captcha_v2.js
 * 하나가 걸린 페이지다. 429 와 달리 쉬었다 다시 묻는다고 열리는 벽이 아니다 —
 * **사람이 풀라고 세운 것**이라, 여기서는 그렇게 알리고 물러난다.
 */
const CAPTCHA_CODE = 490;
const CAPTCHA_MARKS = ['title="captcha"', "wtm_captcha", "ncpt.naver.com"];
export const CAPTCHA_SAID =
  "네이버가 캡차를 세웠습니다 — 자동으로 열 수 있는 페이지가 아닙니다 " +
  "(스마트스토어 상품 페이지는 대개 이렇습니다)";

/** 벽 앞에서 사람이 할 수 있는 일. 캡차는 **티켓을 쿠키로 준다.** */
export const CAPTCHA_TICKET = "X-Wtm-Cpt-Tk";
const CAPTCHA_HOWTO = [
  "쿠키를 새로 뽑아 넣어보세요. 벽은 쿠키 없는 요청에만 서고, 싱싱한 로그인 세션은 통과합니다:",
  "  1) 크롬에서 네이버에 로그인한 채로 F12 → Network → 아무 요청의 Cookie: 줄을 통째로 복사",
  "  2) npm run naver:cookie      (클립보드에서 가져갑니다)",
  "  그래도 막히면 크롬에서 그 상품 페이지의 캡차를 직접 푼 뒤 같은 방법으로 다시 넣거나,",
  "  node dist/naver/index.js --watch-browser <URL> 로 창에서 보세요.",
];

/** 벽을 만난 사람에게 갈 길을 알려 준다. */
export function sayHowto(): void {
  for (const line of CAPTCHA_HOWTO) log.info(line);
}

/**
 * 네이버가 Node 의 요청을 밀어낸다. **이건 잦기의 문제가 아니다.**
 *
 * 확인한 것이다 (2026-08-23, 같은 주소·같은 시각).
 *
 *   python naver_buy.py --probe        200 · 179,999바이트
 *   Node fetch (헤더 다섯 벌을 바꿔 가며)  429 · 23,585바이트
 *   Node http2 (맨몸 · 크롬 헤더)        429 · 23,585바이트
 *   curl.exe                           429 · 23,585바이트
 *
 * 헤더로는 안 갈린다 — UA 를 빼도, sec-fetch 를 한 벌 붙여도, HTTP/2 로 물어도 같다.
 * 갈리는 것은 **TLS 지문**이다. 파이썬 쪽은 curl_cffi 가 크롬의 ClientHello 를 그대로
 * 흉내내지만(impersonate="chrome"), Node 의 fetch 에는 그런 것이 없다.
 *
 * 그래서 여기서는 지문을 속이려 들지 않는다. 대신 **크롬 창을 쓰는 길**로 안내한다 —
 * 진짜 크롬이니 지문도 진짜다. 그 길은 이미 있다(--watch-browser).
 */
export const PUSHED_BACK =
  "네이버가 밀어냅니다 (429) — Node 의 fetch 로는 상품 페이지를 받을 수 없습니다";

const PUSHED_HOWTO = [
  "헤더 문제가 아니라 TLS 지문입니다. 파이썬 판은 크롬인 척(curl_cffi)해서 통과하지만,",
  "Node 의 fetch 에는 그런 것이 없습니다. **크롬 창을 쓰는 길로 가세요** — 진짜 크롬이니",
  "지문도 진짜입니다:",
  "  node dist/naver/index.js --watch-browser <URL>",
  "재고를 한 번만 보려는 것이면 파이썬 판이 아직 가장 빠릅니다:  python naver_buy.py --status",
];

export function sayPushedHowto(): void {
  for (const line of PUSHED_HOWTO) log.info(line);
}

/** 이 실패는 다시 두드려 봐야 소용없고, 사람에게 다른 길을 알려 줘야 하는 것인가. */
export function needsBrowser(message: string): boolean {
  return message === CAPTCHA_SAID || message === PUSHED_BACK;
}

/** 받아 온 것이 상품 페이지가 아니라 캡차 벽인가. */
export function isCaptcha(text: string): boolean {
  const head = (text || "").slice(0, 2000);
  return CAPTCHA_MARKS.some((mark) => head.includes(mark));
}

export class Session {
  constructor(public cookie = "") {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      // curl_cffi 의 impersonate="chrome" 이 붙여 주던 것들. **Referer 는 없다.**
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

/** 빌려온 줄에 신분을 지는 쿠키가 들어 있는가. 살아 있는지는 loginAlive() 가 본다. */
export function hasLoginCookie(cookie: string): boolean {
  const names = new Set(
    (cookie || "").split(";").filter((p) => p.includes("=")).map((p) => p.split("=")[0]!.trim()),
  );
  return names.has("NID_AUT") && names.has("NID_SES");
}

/**
 * 빌려온 세션이 아직 살아 있는가. → true / false
 *
 * 로그인해야 볼 수 있는 자리에 HEAD 를 던지고 **따라가지 않는다.** 살아 있으면 200,
 * 끊겼으면 302 로 로그인 페이지를 가리킨다. 본문을 받지 않으니 한 번에 0바이트다 —
 * 같은 자리에 GET 을 하면 130KB 를 받는다. 몇 분마다 물어볼 것이라 그 차이가 쌓인다.
 *
 * 확인에 실패한 것(그물이 끊겼다)과 로그아웃된 것은 다르다. 여기서는 못 물어본 경우
 * SiteError 를 내고, 부른 쪽이 그것 때문에 감시를 접지는 않게 한다.
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
  if ([301, 302, 303, 307, 308].includes(res.status) && where.includes(LOGIN_HOST)) return false;

  // 200 도 아니고 로그인 페이지로 보내는 것도 아니다. 우리가 모르는 답이라 판정하지 않는다.
  throw new SiteError(`로그인 확인이 ${res.status} 로 답했습니다 (${where.slice(0, 60) || "이동 없음"})`);
}

/**
 * 캡차 벽 앞에서, 쿠키를 실어 한 번 더 물어본다. → html (그래도 막히면 SiteError)
 *
 * 조회 명령(--status·--probe)은 평소 쿠키를 싣지 않는다. 공개 페이지라 필요가 없어서다.
 * 그런데 이 벽 뒤에서는 쿠키가 필요할 수 있다 — **캡차 티켓이 쿠키로 실리기 때문**이다.
 * 사람이 자기 크롬에서 풀어 둔 것을 빌려 왔다면 그 줄에 들어 있다.
 *
 * 이미 쿠키를 싣고도 막혔으면 다시 해봐야 같다. 그때는 그대로 알린다.
 */
async function onWall(s: Session, url: string): Promise<string> {
  if (s.cookie) throw new SiteError(CAPTCHA_SAID);

  let cookie = "";
  try {
    cookie = cookieOf(loadConfig());
  } catch {
    cookie = "";
  }
  if (!cookie) throw new SiteError(CAPTCHA_SAID);

  sayStep("쿠키 없이 막혔습니다 — 쿠키를 실어 한 번 더 물어봅니다");
  const helper = newSession(cookie);
  let res: Response;
  try {
    res = await helper.get(url);
  } catch (e) {
    throw new SiteError(`쿠키를 실어 다시 묻다 실패했습니다: ${(e as Error).message}`);
  }

  const text = await helper.body(res);
  if (res.status === 200 && !isCaptcha(text)) {
    const hasTicket = cookie.toLowerCase().includes(CAPTCHA_TICKET.toLowerCase());
    sayOk(`쿠키를 실으니 열렸습니다${hasTicket ? " (캡차 티켓이 들어 있습니다)" : ""}`);
    return text;
  }

  throw new SiteError(CAPTCHA_SAID);
}

/**
 * 상품 페이지 한 장.
 *
 * **429 에 쉬어 보지 않는다.** 예전에는 처음 한 번 3+8+20초를 쉬어 보고 나서야 PUSHED_BACK
 * 으로 올렸다. 그런데 Node 의 429 는 잦기가 아니라 TLS 지문 문제라(위 PUSHED_BACK 참고)
 * 쉬어서 열린 적이 한 번도 없다 (2026-08-23 · 09-18 매번 31초 뒤 그대로 429). 그 31초 동안
 * 화면에는 "쉽니다" 만 떠 있어서, 사람은 멈춘 줄 알고 꺼 버렸다 (2026-09-18 23:39).
 * 이제 429 를 받으면 곧장 PUSHED_BACK 을 올리고, 부른 쪽이 크롬 창으로 넘어간다.
 */
export async function getPage(s: Session, url: string): Promise<string> {
  let res: Response;
  try {
    res = await s.get(url);
  } catch (e) {
    throw new SiteError(`페이지를 받지 못했습니다: ${(e as Error).message}`);
  }

  const text = await s.body(res);
  if (res.status === 200) {
    if (isCaptcha(text)) return onWall(s, url);
    return text;
  }
  if (res.status === CAPTCHA_CODE || isCaptcha(text)) return onWall(s, url);
  // "429" 만 적어 두면 사람은 주기를 늘리러 가고, 그건 이 벽에 아무 소용이 없다.
  if (res.status === TOO_MANY) throw new SiteError(PUSHED_BACK);
  throw new SiteError(`페이지가 ${res.status} 로 답했습니다`);
}
