/**
 * 네이버 상품 페이지를 크롬으로 열어 구매하기까지 누른다. naver_browser.py 를 옮긴 것이다.
 *
 * bnkr 쪽은 담기를 HTTP 로 끝내고 주문서만 열면 됐지만, 네이버는 바로구매를 HTTP 로
 * 어떻게 부르는지 모른다. 주문서 생성에 네이버페이 쪽 토큰이 오가는 일이라, 모르는 채로
 * 요청을 지어내는 것보다 **사람이 하는 대로** 하는 편이 정확하다.
 *
 *   새 크롬 → 쿠키 주입 → 상품 페이지 → [옵션] → 구매하기
 *   → 구매 레이어([수량] → 바로구매) → 주문서에 도착했는지 확인 → 창 유지
 *
 * 창을 띄워 두고 **그 안에서 지켜보는** 길도 여기 있다(--watch-browser). 캡차 벽이 있는
 * 스마트스토어 상품 때문이다 — 사람이 그 창에서 캡차를 풀고, 자동화는 같은 창에서
 * 이어간다. 그래서 openBuy 를 openPage(열기) + buyHere(누르기) 로 갈라 두었다.
 * 새 창을 띄우면 방금 푼 캡차를 처음부터 다시 풀어야 한다.
 *
 * 글자로 눌러야 할 것을 찾는 방법(FIND_TEXT_JS)·누르는 방법(press)·화면이 달라졌는지
 * 재는 방법(reacted)은 **bnkr 판 것을 그대로 빌려 쓴다.** 그 조각들은 결제창에서 여러 번
 * 틀려 가며 다듬은 것이라, 사이트마다 다시 쓰는 것보다 빌려 쓰는 편이 낫다.
 *
 * 봇 탐지를 속이는 옵션(navigator.webdriver 감추기 따위)은 쓰지 않는다. 자동화로 여는
 * 것을 숨길 이유가 없다 — 로그인도 결제도 사람이 한 것이다.
 */
import { writeFileSync } from "node:fs";
import { By, type WebDriver, type WebElement } from "selenium-webdriver";
import {
  alertText, BrowserError, Chrome, descend, FIND_TEXT_JS, framePaths, makeDriver, press, reacted,
  settled,
} from "../browser.js";
import { parseCookie } from "../http.js";
import { log } from "../log.js";
import { sleep } from "../util.js";
import { IN_STOCK, SOLDOUT, type Status } from "./config.js";
import { KEYPAD_JS } from "./pin.js";

export { BrowserError, Chrome };

const COOKIE_DOMAIN = ".naver.com";

// 여기로 튕겼으면 빌려온 세션이 죽은 것이다. 다시 눌러 봐야 같다.
const LOGIN_HOST = "nid.naver.com";
export const SESSION_DEAD = "로그인 세션이 끊겼습니다";

// 주문서에 도착했다는 증거. 실제로 도착한 곳은 이랬다.
//   https://orders.pay.naver.com/ordersheet/seller/eff61f5d-…
// 호스트가 orders(복수) 다. pay.naver.com 만 봐도 걸리지만, 본 것을 그대로 적어 둔다.
const ORDER_HOSTS = ["orders.pay.naver.com", "pay.naver.com"];

// 그 화면에 있던 글자들. "주문서" 나 "주문결제" 는 **없다** — 실제로는 슬래시가 낀
// "주문/결제" 다. 처음에 슬래시 없는 쪽으로 적어 놨다가 도착을 못 알아봤다.
const ORDER_MARKS = ["주문/결제", "주문상품", "배송지", "결제수단"];

// 상품 페이지의 구매 버튼. 이걸 누르면 **주문서로 바로 가지 않고 레이어가 뜬다.**
const BUY_TEXTS = ["구매하기", "바로구매", "바로 구매"];

// 그 레이어. 수량도 여기서 정한다 — 본문이 아니라 이 안이다.
// **장바구니를 누르면 안 된다.** 담기고 주문서는 안 열린다.
const LAYER_MARKS = ["상품 구매 옵션", "수량 선택"];
const LAYER_CONFIRM = ["바로구매", "바로 구매", "구매하기"];

// 옵션을 펼치는 자리. 옵션 상품에서만 쓴다.
const OPTION_OPENERS = ["옵션 선택", "옵션선택", "선택하세요"];

/**
 * 캡차 벽. 창을 띄운 크롬에서도 온다 — headless 만의 일이 아니다.
 *
 * 이걸 안 보면 증상이 "구매 버튼을 못 찾았습니다" 로 나온다. 버튼을 못 찾은 게 아니라
 * 애초에 상품 페이지가 아니다. 캡차는 사람이 푸는 것이라, 알아보고 그렇게 말하고 만다.
 */
const CAPTCHA_MARKS = ['title="captcha"', "wtm_captcha", "ncpt.naver.com"];
export const CAPTCHA_SAID =
  "네이버가 캡차를 세웠습니다 — 뜬 크롬 창에서 직접 풀어 주세요 " +
  "(스마트스토어 상품 페이지는 대개 이렇습니다)";

// 상품 페이지가 섰다는 **긍정 신호**. 캡차 페이지에는 이 값이 없다(확인함: null).
const PRODUCT_READY_JS = "return !!window.__PRELOADED_STATE__;";

const BODY_TEXT_JS = "return document.body.innerText || ''";

type Pressed = "ok" | "quiet" | "none";
/** FIND_TEXT_JS 가 돌려주는 것. 못 찾으면 false 다. */
type Hit = [string, WebElement | null, string, string];

/** 창에 상품 페이지가 서 있는가. 싸게 묻는다 — 값을 실어 오지 않고 있냐만 본다. */
async function productReady(driver: WebDriver): Promise<boolean> {
  try {
    return !!(await driver.executeScript<boolean>(PRODUCT_READY_JS));
  } catch {
    return false;
  }
}

/**
 * 상품 페이지의 상태 값이 설 때까지 조금 기다린다. → 섰으면 true
 *
 * settled() 는 문서가 다 받아졌는지만 본다. __PRELOADED_STATE__ 는 그 뒤에 서는 일이
 * 있어서, 창을 막 띄운 첫 바퀴에 "재고를 읽지 못했습니다" 가 한 번 나곤 했다
 * (2026-09-18, 창을 띄우고 2초 뒤). 기다려서 안 서면 그냥 돌려준다 — 부른 쪽이 화면으로 본다.
 */
export async function waitProduct(box: Chrome, seconds = 5): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await productReady(box.driver)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

async function bodyText(driver: WebDriver): Promise<string> {
  try {
    return (await driver.executeScript<string>(BODY_TEXT_JS)) || "";
  } catch {
    return "";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * 지금 서 있는 곳이 상품 페이지가 아니라 캡차 벽인가.
 *
 * 머리(head)의 자국만 보지 않는다. **자국이 있어도 상품이 서 있으면 캡차가 아니다.**
 * 캡차가 그 자리에서 풀리면서 head 의 wtm_captcha 스크립트만 남는 경우, 자국만 보면
 * 영원히 "아직 캡차" 라고 답한다 — 사람이 다 풀어 놓고도 기다리게 되는 자리다.
 */
async function atWall(driver: WebDriver): Promise<boolean> {
  let head: string;
  try {
    head = (await driver.executeScript<string>(
      "return (document.head && document.head.outerHTML || '').slice(0, 2000)")) || "";
  } catch {
    return false;
  }
  if (!CAPTCHA_MARKS.some((mark) => head.includes(mark))) return false;
  return !(await productReady(driver));
}

/** 지금 캡차 벽 앞에 서 있는가. (사람이 풀었는지 지켜볼 때 쓴다) */
export function atCaptcha(box: Chrome): Promise<boolean> {
  return atWall(box.driver);
}

/**
 * 빌려온 쿠키를 크롬에 심는다. → 심은 개수
 *
 * CDP 로 한 번에 심는다. 도메인은 .naver.com 하나면 된다 — 신분을 지는 NID_AUT·NID_SES
 * 가 거기 걸려 있고, 브랜드스토어도 페이도 전부 그 아래다.
 */
async function inject(box: Chrome, cookie: string): Promise<number> {
  const jar = parseCookie(cookie);
  const names = Object.keys(jar);
  if (!names.length) return 0;

  const cookies = names.map((name) => ({
    name, value: jar[name]!, domain: COOKIE_DOMAIN, path: "/", secure: true,
  }));
  const driver = box.driver as WebDriver & {
    sendDevToolsCommand(cmd: string, params: object): Promise<void>;
  };
  try {
    await driver.sendDevToolsCommand("Network.enable", {});
    await driver.sendDevToolsCommand("Network.setCookies", { cookies });
    return cookies.length;
  } catch (e) {
    log.debug(`쿠키를 한 번에 심지 못했습니다 (${(e as Error).message}). 하나씩 넣습니다.`);
  }

  let planted = 0;
  for (const one of cookies) {
    try {
      await driver.sendDevToolsCommand("Network.setCookie", one);
      planted += 1;
    } catch {
      // 값에 따옴표가 든 추적 쿠키는 거절당할 수 있다. 신분을 지는 둘만 들어가면 된다.
    }
  }
  return planted;
}

/**
 * 화면에 그 글자가 보이는 것을 눌러 본다.
 *
 *   "ok"    눌렀고 화면이 달라졌다
 *   "quiet" 눌렀는데 화면이 그대로다
 *   "none"  못 찾았다
 *
 * 프레임은 뒤지지 않는다 — 상품 페이지의 구매 버튼은 본문에 있다. 결제창처럼 iframe 에
 * 숨는 화면은 여기까지 오지 않는다.
 */
async function clickText(driver: WebDriver, want: string, timeout = 8, tries = 3): Promise<Pressed> {
  const deadline = Date.now() + timeout * 1000;
  let attempts = 0;

  while (Date.now() < deadline && attempts < tries) {
    let got: Hit | false = false;
    try {
      got = await driver.executeScript<Hit | false>(FIND_TEXT_JS, want);
    } catch (e) {
      log.debug(`'${want}' 를 찾는 중 오류: ${(e as Error).message}`);
    }

    if (got) {
      const [status, element, before, what] = got;
      if (status === "already") return "ok";
      attempts += 1;
      if (!element || !(await press(driver, element))) {
        await sleep(400);
        continue;
      }
      if (await reacted(driver, before)) {
        log.debug(`'${want}' 를 눌렀습니다 — ${what}`);
        return "ok";
      }
      log.debug(`'${want}' 를 눌렀지만 화면이 그대로입니다 (${attempts}/${tries}) — ${what}`);
    }
    await sleep(400);
  }
  return attempts ? "quiet" : "none";
}

/** 여러 글자 중 눌리는 것을 누른다. → [결과, 무엇을 눌렀나] */
async function clickAny(
  driver: WebDriver, wants: string[], timeout = 8,
): Promise<[Pressed, string | null]> {
  for (const want of wants) {
    const result = await clickText(driver, want, timeout / wants.length, 2);
    if (result === "ok" || result === "quiet") return [result, want];
  }
  return ["none", null];
}

/**
 * 옵션을 고른다. → 사유 (골랐으면 null)
 *
 * 옵션 목록은 select 가 아니라 꾸며 놓은 목록이라, 먼저 펼치고 글자로 고른다.
 * 이미 펼쳐져 있으면 펼치는 단계는 건너뛴다(못 찾아도 그냥 지나간다).
 */
async function pickOption(driver: WebDriver, option: string, timeout: number): Promise<string | null> {
  await clickAny(driver, OPTION_OPENERS, 3);
  await sleep(500);

  const result = await clickText(driver, option, timeout, 2);
  if (result === "none") return `옵션 '${option}' 을 화면에서 못 찾았습니다`;

  const alert = await alertText(driver);
  if (alert) return `옵션을 고르다 사이트가 알렸습니다 — ${alert}`;
  return null;
}

/**
 * 수량을 올린다. → 사유 (맞췄으면 null)
 *
 * 실패해도 위에서 멈추지 않는다. 못 올리면 1개로 주문서에 가는데, 그건 **덜 사는**
 * 쪽이라 되돌리기 쉽다. 네이버 주문서에서는 수량을 못 바꾸니 사람이 보고 판단하면 된다.
 */
async function setQuantity(driver: WebDriver, ea: number): Promise<string | null> {
  for (let i = 0; i < ea - 1; i++) {
    const [result] = await clickAny(driver, ["증가", "+", "수량증가"], 3);
    if (result === "none") return `수량을 ${ea}개로 못 올렸습니다 (1개로 갑니다)`;
    await sleep(200);
  }
  return null;
}

/** 지금 주문서에 서 있는가. */
async function onOrder(driver: WebDriver): Promise<boolean> {
  try {
    const host = hostOf(await driver.getCurrentUrl());
    return ORDER_HOSTS.some((mark) => host.includes(mark));
  } catch {
    return false;
  }
}

/** 구매 레이어가 떠 있는가. */
async function layerOpen(driver: WebDriver): Promise<boolean> {
  const body = await bodyText(driver);
  return LAYER_MARKS.some((mark) => body.includes(mark));
}

/**
 * 구매 레이어에서 바로구매까지 누른다. → 사유 (지나갔으면 null)
 *
 * 상품 페이지의 구매하기는 주문서로 곧장 가지 않고 이 레이어를 띄운다. 여기서 한 번 더
 * 눌러야 넘어간다. 수량도 여기서 정한다.
 *
 * **레이어가 안 떴으면 아무것도 하지 않는다.** 화면 구성에 따라 구매하기가 곧장 주문서로
 * 가는 경우도 봤다. 그때 이 안에서 또 무언가를 누르면 주문서에서 엉뚱한 것을 누르게 된다.
 */
async function throughLayer(driver: WebDriver, ea: number, timeout: number): Promise<string | null> {
  const deadline = Date.now() + Math.min(6, timeout) * 1000;
  let sawLayer = false;

  while (Date.now() < deadline) {
    if (await onOrder(driver)) return null;   // 레이어 없이 곧장 넘어갔다
    if (await layerOpen(driver)) {
      sawLayer = true;
      break;
    }
    await sleep(300);
  }
  // 레이어도 주문서도 아니다. 부른 쪽이 판단한다.
  if (!sawLayer) return null;

  if (ea > 1) {
    const reason = await setQuantity(driver, ea);
    if (reason) log.warn(reason);
  }

  const [result, pressed] = await clickAny(driver, LAYER_CONFIRM, timeout);
  if (result === "none") {
    return `구매 레이어에서 눌러야 할 것을 못 찾았습니다 (${LAYER_CONFIRM.join(" / ")})`;
  }
  log.debug(`구매 레이어에서 '${pressed}' 를 눌렀습니다.`);
  return null;
}

/**
 * 주문서에 도착했는가. → [도착했는가, 사유]
 *
 * 새 창으로 열릴 수도 있어 창 목록도 함께 본다. 주소만 보고 판단하지 않는 이유는
 * bnkr 쪽과 같다 — 껍데기만 그려 놓고 내용이 빈 경우가 있다.
 */
async function arrived(box: Chrome, timeout: number): Promise<[boolean, string | null]> {
  const driver = box.driver;
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    const alert = await alertText(driver);
    if (alert) {
      // 옵션 미선택·재고 부족·비회원 구매 불가는 전부 alert 로 온다.
      return [false, `사이트가 알렸습니다 — ${alert}`];
    }

    const others = (await driver.getAllWindowHandles()).filter((h) => h !== box.mainWindow);
    if (others.length) await driver.switchTo().window(others[others.length - 1]!);

    const url = (await driver.getCurrentUrl()) || "";
    const host = hostOf(url);
    if (host.includes(LOGIN_HOST)) return [false, SESSION_DEAD];
    if (ORDER_HOSTS.some((mark) => host.includes(mark))) {
      await settled(driver, Math.min(5, timeout));
      const body = await bodyText(driver);
      if (ORDER_MARKS.some((mark) => body.includes(mark))) return [true, null];
      // 페이로는 넘어왔는데 주문서가 아니다. 잠깐 더 본다.
    }
    await sleep(400);
  }

  const where = await driver.getCurrentUrl().catch(() => "");
  return [false, `구매하기를 눌렀지만 주문서로 넘어가지 않았습니다 (현재: ${where})`];
}

/**
 * 지금 서 있는 곳이 멀쩡한 상품 페이지인가. → 사유 (멀쩡하면 null)
 *
 * 페이지가 설 때까지 기다렸다가 본다. 사람이 캡차를 푼 직후에도 부른다 — 화면이
 * 상품 페이지로 바뀌는 데는 시간이 걸리고, 그 전에 재고를 읽으면 빈손이 나온다.
 */
export async function landed(box: Chrome, timeout = 20): Promise<string | null> {
  const driver = box.driver;
  const alert = await settled(driver, timeout);
  if (alert) return `상품 페이지에서 사이트가 알렸습니다 — ${alert}`;

  const url = (await driver.getCurrentUrl().catch(() => "")) || "";
  if (hostOf(url).includes(LOGIN_HOST)) return SESSION_DEAD;
  // 창은 남는다. 사람이 여기서 풀고 이어서 사면 된다.
  if (await atWall(driver)) return CAPTCHA_SAID;
  if (await atErrorPage(driver)) return ERROR_PAGE_SAID;
  return null;
}

// 상품 페이지 대신 오는 네이버의 오류 화면. 2026-09-18 에 몇 분 사이 여러 번 열었더니
// 이게 왔다 — 제목 "[에러] 에러페이지 - 시스템오류". 상태 JSON 도 구매 버튼도 없어서
// 예전에는 "재고를 읽지 못했습니다" 로만 나왔다. 캡차와 달리 사람이 풀 것이 없고,
// 잠시 뒤 다시 받으면 된다 — 감시 루프가 다음 바퀴에 다시 받는다.
const ERROR_PAGE_MARKS = ["에러페이지", "시스템오류"];
export const ERROR_PAGE_SAID = "네이버가 상품 페이지 대신 오류 화면(시스템오류)을 줍니다 — 잠시 뒤 다시 받습니다";

async function atErrorPage(driver: WebDriver): Promise<boolean> {
  if (await productReady(driver)) return false;
  const title = await driver.getTitle().catch(() => "");
  return ERROR_PAGE_MARKS.some((mark) => (title || "").includes(mark));
}

/**
 * **이미 상품 페이지가 떠 있는 창**에서 구매하기부터 주문서까지 누른다.
 *
 * → [주문서까지 갔는가, 사유]
 *
 * openBuy 는 창을 새로 띄우고 이걸 부른다. 감시 모드는 사람이 캡차를 푼 그 창을 그대로
 * 쓴다 — 새 창을 띄우면 방금 푼 캡차를 처음부터 다시 풀어야 한다.
 */
export async function buyHere(
  box: Chrome, opts: { option?: string; ea?: number; timeout?: number } = {},
): Promise<[boolean, string | null]> {
  const driver = box.driver;
  const option = opts.option ?? "";
  const ea = opts.ea ?? 1;
  const timeout = opts.timeout ?? 20;

  if (box.mainWindow === null) box.mainWindow = await driver.getWindowHandle();

  if (option) {
    const reason = await pickOption(driver, option, timeout);
    if (reason) return [false, reason];
  }

  const [result, pressed] = await clickAny(driver, BUY_TEXTS, timeout);
  if (result === "none") return [false, `구매 버튼을 못 찾았습니다 (${BUY_TEXTS.join(" / ")})`];
  log.debug(`'${pressed}' 를 눌렀습니다.`);

  // 구매하기 다음이 곧장 주문서가 아니다. 레이어가 뜨면 거기서 한 번 더 누른다.
  const reason = await throughLayer(driver, ea, timeout);
  if (reason) return [false, reason];

  return arrived(box, timeout);
}

// 결제하기를 누른 **다음** 화면. 여기서 멈춘다.
//
// 네이버페이는 결제 버튼 다음에 간편결제 인증을 세운다(비밀번호·생체). 그 자리는 사람의
// 것이다 — 비밀번호는 넣지 않는다. 누르고 나서 무엇이 떴는지만 읽고 손을 뗀다.
const AUTH_MARKS = ["비밀번호", "인증", "지문", "얼굴", "생체", "패턴"];

// 인증 없이 곧장 끝나 버린 경우. 간편결제 비밀번호가 꺼진 계정이면 그럴 수 있다.
// **그런 계정에서는 이 기능을 쓰면 안 된다**는 신호라, 조용히 넘기지 않고 크게 알린다.
const DONE_MARKS = ["결제가 완료", "주문이 완료", "결제완료", "구매가 완료"];
export const PAID_ANYWAY = "결제가 끝났습니다 — 인증 없이 넘어갔습니다";

// 결제하기를 누른 뒤의 결과. 롯데온 판과 같은 말을 쓴다.
export const PG_OPENED = "결제 인증 화면이 떴습니다 — 비밀번호는 직접 넣어주세요";
/** 눌렀지만 사이트가 막았다. **이건 결제창까지 간 것이 아니다.** */
export const PG_BLOCKED = "결제창이 뜨기 전에 사이트가 막았습니다";
export const PG_UNSEEN = "결제하기는 눌렀지만 결제 인증 화면 신호를 못 봤습니다 — 크롬 창을 봐주세요";

/** 지금 창의 맨 위 문서에 iframe 이 몇 개인가. 결제창이 얹히면 이게 늘어난다. */
async function frameCount(driver: WebDriver): Promise<number> {
  try {
    await driver.switchTo().defaultContent();
    return (await driver.findElements(By.css("iframe"))).length;
  } catch {
    return 0;
  }
}

/** 이 글자들 중 본문에 있는 것. 누르기 전과 견주려고 모아 둔다. */
function marksIn(body: string, marks: string[]): Set<string> {
  return new Set(marks.filter((mark) => body.includes(mark)));
}

// 주문서 맨 아래의 결제 버튼. 실제로 뜯어보니 이렇게 생겼다.
//
//   <button class="SubmitButton_button-pay__vMblX">  375x56
//       <span 금액 롤러>0 1 2 3 4 5 6 7 8 9 0 1 2 …</span> 13100원 결제하기
//
// **금액이 숫자 롤러다.** 0~9 가 도는 애니메이션이라 버튼 하나의 textContent 가 수십 자다.
// 그래서 글자가 정확히 같은 것을 찾는 FIND_TEXT_JS 로는 **못 찾는다**(실제로 세 번 못
// 찾았다). 찾는 조건은 두 가지다 — 누를 수 있는 것(button·a)이고, 그 안에 "결제하기" 가
// 있을 것.
const PAY_TEXT = "결제하기";
const PAY_CLASS = "button-pay";  // 클래스 뒤의 해시(__vMblX)는 배포마다 바뀐다. 앞쪽만 본다.

const PAY_FIND_JS = `
var want = arguments[0], cls = arguments[1];

function seen(el) {
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
}

var hits = [];
var all = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
Array.prototype.slice.call(all).forEach(function (el) {
  if (!seen(el) || el.disabled === true) return;
  var text = ((el.textContent || "") + " " + (el.value || "")).replace(/\\s+/g, " ").trim();
  if (text.indexOf(want) === -1) return;
  hits.push({ el: el, text: text,
              named: ((el.className || "") + "").indexOf(cls) !== -1 });
});

if (!hits.length) return null;
// 클래스로 이름 붙은 것 먼저, 그다음 글자가 짧은 것. 약관 안내에 같은 글자가 박혀
// 있어도 그건 button 이 아니라 여기까지 오지 않는다.
hits.sort(function (a, b) {
  if (a.named !== b.named) return a.named ? -1 : 1;
  return a.text.length - b.text.length;
});
var best = hits[0];
return [best.el, best.text.slice(-24), best.named, hits.length];
`;

export interface PayButton {
  element: WebElement | null;
  label: string;
  named: boolean;
  count: number;
}

/**
 * 주문서에서 결제 버튼을 **찾기만** 한다.
 *
 * 누르는 것은 부른 쪽이 한다. 이 버튼만은 "찾았는지" 를 누르지 않고 확인할 수 있어야
 * 해서 갈라 뒀다 — 눌러 보고 확인하는 것이 곧 결제를 시도하는 일이기 때문이다.
 */
export async function findPay(driver: WebDriver): Promise<PayButton> {
  const empty: PayButton = { element: null, label: "", named: false, count: 0 };
  let got: [WebElement, string, boolean, number] | null = null;
  try {
    got = await driver.executeScript<[WebElement, string, boolean, number] | null>(
      PAY_FIND_JS, PAY_TEXT, PAY_CLASS);
  } catch (e) {
    log.debug(`결제 버튼을 찾는 중 오류: ${(e as Error).message}`);
    return empty;
  }
  if (!got) return empty;
  const [element, label, named, count] = got;
  return { element, label, named: !!named, count: Number(count) };
}

/**
 * 주문서에서 결제하기를 눌러 **인증 앞까지** 간다. → [눌렀나, 무슨 일이 있었나]
 *
 * **비밀번호는 넣지 않는다.** 누르고 나서 화면이 무엇으로 바뀌었는지만 읽는다.
 *
 *   PG_OPENED    인증 화면이 떴다. 사람이 비밀번호를 넣으면 그때 결제된다
 *   PAID_ANYWAY  인증 없이 끝난 것이다. 이 계정에서는 이걸 켜면 안 된다
 *   PG_BLOCKED   사이트가 alert 로 막았다. 결제창까지 간 것이 아니다
 *   PG_UNSEEN    신호를 못 봤다. 사람이 화면을 봐야 한다
 *
 * **예전에는 주문서 본문 글자만 봤다.** 2026-08-20 submit 판에서 20초를 꼬박 기다리고
 * "눌렀습니다 — 화면을 확인해 주세요" 로 끝났다. 인증 화면은 주문서 본문이 아니라 새 창이나
 * iframe 에 뜨기 때문이다 — 롯데온 판·bnkr 판에서 배운 대로 **새 창·새 iframe·alert·본문
 * 글자를 다 본다.** 본문 글자는 누르기 전에 이미 있던 것은 세지 않는다(주문서 안내문에 섞인
 * "인증" 따위에 속지 않으려고).
 *
 * **주문서가 아니면 아무것도 하지 않는다.** 엉뚱한 화면에서 "결제하기" 를 찾아 누르는
 * 것이 제일 나쁜 경우라, 누르기 전에 서 있는 자리부터 확인한다.
 */
export async function payHere(box: Chrome, timeout = 20): Promise<[boolean, string]> {
  const driver = box.driver;
  if (!(await onOrder(driver))) return [false, "주문서가 아닙니다 — 누르지 않았습니다"];

  const { element, label, named, count } = await findPay(driver);
  if (!element) return [false, `결제 버튼을 못 찾았습니다 ('${PAY_TEXT}')`];
  log.debug(`결제 버튼을 찾았습니다 — ${JSON.stringify(label)} (클래스로 ${named} · 후보 ${count}개)`);

  // 창이 사라졌을 수 있다(사람이 닫거나 크롬이 죽거나). 여기서 그냥 터지면 이 판이
  // 통째로 끝나고, 정작 남겨야 할 받아적기도 못 한다.
  let before: Set<string>;
  let order: string;
  try {
    before = new Set(await driver.getAllWindowHandles());
    order = await driver.getWindowHandle();
  } catch (e) {
    return [false, `크롬 창이 사라졌습니다 — ${(e as Error).message}`];
  }
  const frames = await frameCount(driver);
  const firstBody = await bodyText(driver);
  const hadAuth = marksIn(firstBody, AUTH_MARKS);
  const hadDone = marksIn(firstBody, DONE_MARKS);

  log.debug("결제 버튼을 누릅니다.");
  if (!(await press(driver, element))) return [false, "결제 버튼을 누르지 못했습니다"];
  log.debug("결제 버튼을 눌렀습니다 — 결제 인증 화면 신호를 기다립니다.");

  const deadline = Date.now() + Math.min(timeout, 15) * 1000;
  while (Date.now() < deadline) {
    const alert = await alertText(driver);
    // 배송지나 결제수단이 비어 있으면 사이트가 alert 로 막는다. 결제창이 안 떴다는 뜻이다.
    if (alert) return [true, `${PG_BLOCKED} — ${alert}`];

    let now: string[];
    try {
      now = await driver.getAllWindowHandles();
    } catch (e) {
      return [true, `눌렀지만 크롬 창이 사라졌습니다 — ${(e as Error).message}`];
    }
    const fresh = now.filter((h) => !before.has(h));
    if (fresh.length) {
      log.debug("결제 인증 화면이 새 창으로 떴습니다.");
      await driver.switchTo().window(fresh[fresh.length - 1]!).catch(() => undefined);
      return [true, PG_OPENED];
    }
    // 주문서 창으로 돌아와서 본다. 누르는 사이 딴 창을 보고 있었을 수 있다.
    await driver.switchTo().window(order).catch(() => undefined);
    if ((await frameCount(driver)) > frames) {
      log.debug("결제 인증 화면이 이 창에 iframe 으로 얹혔습니다.");
      return [true, PG_OPENED];
    }

    const body = await bodyText(driver);
    if (DONE_MARKS.some((mark) => !hadDone.has(mark) && body.includes(mark))) {
      return [true, PAID_ANYWAY];
    }
    const auth = AUTH_MARKS.find((mark) => !hadAuth.has(mark) && body.includes(mark));
    if (auth) {
      log.debug(`결제 인증 화면이 이 페이지에 떴습니다 ('${auth}').`);
      return [true, PG_OPENED];
    }
    await sleep(300);
  }

  // 신호를 못 봤다고 실패는 아니다. 창은 떠 있고, 사람이 보면 안다.
  return [true, PG_UNSEEN];
}

/**
 * 결제하기를 누른 뒤 화면을 받아 적는다. → 적었으면 true
 *
 * **네이버페이 인증 화면을 아직 제대로 못 봤다.** 그래서 처음 한 번 여기까지 가 본 판이
 * 셀렉터를 고칠 유일한 재료다(롯데온 판의 --dump-pay 와 같은 것). 떠 있는 창을 **전부**,
 * 창마다 iframe 두 층까지 돌면서 눌릴 만한 것(button·a·input·label)을 적고, 주문서가
 * 아닌 곳은 마크업까지 남긴다.
 *
 * 사람 정보(이름·연락처·카드번호)는 적지 않는다. 사람이 적는 칸의 값은 가리고,
 * 이메일·휴대폰·긴 숫자는 글자에서도 가린다. 주문서 본문(배송지가 든 곳)은 마크업을
 * 남기지 않는다.
 */
const DUMP_JS = `
function seen(el) {
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
}
function label(el) {
  var text = (el.textContent || "").replace(/\\s+/g, " ").trim();
  if (text) return text;
  return (el.value || el.alt || el.getAttribute("title") || el.getAttribute("aria-label") || "").trim();
}
var out = [];
Array.prototype.slice.call(
  document.querySelectorAll('button, a, [role="button"], input, select, label')
).forEach(function (el) {
  if (!seen(el)) return;
  var kind = el.tagName.toLowerCase() + (el.type ? "[" + el.type + "]" : "");
  var cls = (el.className && el.className.baseVal === undefined) ? String(el.className).trim() : "";
  out.push(kind + (el.id ? "#" + el.id : "") + (cls ? "." + cls.split(/\\s+/).join(".") : "") +
           ' "' + label(el).slice(0, 60) + '"');
});
return out;
`;

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /\b01[016-9][-\s]?\d{3,4}[-\s]?\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const INPUT_TAG_RE = /<input\b[^>]*>/gi;
const TYPE_RE = /\btype\s*=\s*["']?([\w-]+)/i;
const VALUE_RE = /(\bvalue\s*=\s*)(["'])([\s\S]*?)\2/gi;
const TYPED_INPUTS = new Set(["", "text", "email", "tel", "password", "number", "search", "url", "hidden"]);

function scrub(text: string): string {
  return text
    .replace(INPUT_TAG_RE, (tag) => {
      const kind = TYPE_RE.exec(tag)?.[1]?.toLowerCase() ?? "";
      if (!TYPED_INPUTS.has(kind)) return tag;
      return tag.replace(VALUE_RE, (_m, head: string, quote: string) => `${head}${quote}(가림)${quote}`);
    })
    .replace(EMAIL_RE, "(이메일)")
    .replace(PHONE_RE, "(휴대폰)")
    .replace(CARD_RE, "(긴숫자)");
}

// 마크업을 남기지 않을 자리. 주문서에는 배송지·받는 사람이 글자로 박혀 있다.
const NO_HTML_MARK = "/ordersheet";

export async function dumpPayment(box: Chrome, path: string): Promise<boolean> {
  const driver = box.driver;
  const lines: string[] = [`# 네이버 결제하기 뒤 받아적기 — ${new Date().toISOString()}`];
  const html: string[] = [];

  let handles: string[];
  let standing = "";
  try {
    handles = await driver.getAllWindowHandles();
    standing = await driver.getWindowHandle().catch(() => "");
  } catch (e) {
    log.warn(`크롬 창이 없어 받아 적지 못했습니다: ${(e as Error).message}`);
    return false;
  }

  for (const [n, handle] of handles.entries()) {
    try {
      await driver.switchTo().window(handle);
    } catch {
      continue;
    }
    const tag = handle === box.mainWindow ? `창 ${n} (처음 연 창)` : `창 ${n}`;
    for (const frame of await framePaths(driver, 2).catch(() => [[]] as number[][])) {
      const at = frame.length ? JSON.stringify(frame) : "top";
      let where: string;
      let found: string[];
      try {
        if ((await descend(driver, frame)) === null) continue;
        where = await driver.executeScript<string>("return location.href");
        found = await driver.executeScript<string[]>(DUMP_JS);
      } catch (e) {
        lines.push(`\n[${tag} · frame ${at}] 읽지 못함: ${(e as Error).message}`);
        continue;
      }
      lines.push(`\n[${tag} · frame ${at}] ${where}  (${found.length}개)`);
      lines.push(...found.map((item) => `  ${item}`));

      // 비밀번호 자판을 여기서 읽을 수 있는가. pin.ts 가 무엇을 보는지 그대로 적는다 —
      // null 이면 자판으로 안 보이는 것, odd 면 읽었는데 숫자가 어긋난 것이다.
      try {
        const pad = await driver.executeScript<[string, unknown[], unknown, string] | null | false>(KEYPAD_JS);
        lines.push(pad
          ? `  [자판 읽기] ${pad[0]} — 키 ${pad[1]?.length ?? 0}개 · 확인 키 ${pad[2] ? "있음" : "없음"}`
          : "  [자판 읽기] 없음 — 자판으로 안 보입니다");
      } catch (e) {
        lines.push(`  [자판 읽기] 실패: ${(e as Error).message.split("\n")[0]}`);
      }

      if (!where.includes(NO_HTML_MARK)) {
        try {
          const body = await driver.executeScript<string>("return document.body.outerHTML");
          if (body) html.push(`\n\n===== [${tag} · frame ${at}] ${where} =====\n${body.slice(0, 200000)}`);
        } catch {
          // 못 긁어도 위의 요약은 남는다.
        }
      }
    }
  }

  // 받아 적기 전에 서 있던 창으로 돌려놓는다. 부른 쪽이 이어서 볼 것이 있을 수 있다.
  if (standing) await driver.switchTo().window(standing).catch(() => undefined);
  await driver.switchTo().defaultContent().catch(() => undefined);

  lines.push(...html);
  try {
    writeFileSync(path, scrub(lines.join("\n")), "utf-8");
  } catch (e) {
    log.warn(`결제창 내용을 적지 못했습니다: ${(e as Error).message}`);
    return false;
  }
  return true;
}

/**
 * 쿠키를 심은 새 크롬으로 상품 페이지를 연다. **누르지는 않는다.**
 *
 * → [창, 사유]  — 멀쩡한 상품 페이지면 사유가 null 이다.
 *
 * 사려면 로그인이 있어야 하니 쿠키가 없으면 BrowserError 다. 다만 재고만 보는
 * 자리(dry-run)에서는 공개 페이지라 쿠키가 필요 없어 requireCookie 를 끈다.
 *
 * 크롬 자체를 못 띄우면 BrowserError 를 낸다.
 */
export async function openPage(
  url: string, cookie: string,
  opts: { headless?: boolean; timeout?: number; requireCookie?: boolean } = {},
): Promise<[Chrome, string | null]> {
  const headless = opts.headless ?? false;
  const timeout = opts.timeout ?? 20;

  if (headless) {
    // 확인한 것이다. headless 로 열면 상품 페이지 대신 "현재 서비스 접속이 불가합니다"
    // 가 온다. 막지는 않는다 — 나중에 네이버가 달라질 수도 있으니 시험은 열어 둔다.
    log.warn("headless 로 열면 네이버가 막는 화면을 줍니다. browser_headless 를 꺼주세요.");
  }

  const box = await makeDriver(headless);
  try {
    const planted = await inject(box, cookie);
    if (!planted && (opts.requireCookie ?? true)) throw new BrowserError("심을 쿠키가 없습니다");
    log.debug(`크롬에 쿠키 ${planted}개를 심었습니다.`);

    await box.driver.get(url);
    box.mainWindow = await box.driver.getWindowHandle();
    return [box, await landed(box, timeout)];
  } catch (e) {
    if (e instanceof BrowserError) {
      await box.quit();
      throw e;
    }
    return [box, `상품 페이지를 여는 중 오류: ${(e as Error).message}`];
  }
}

/**
 * 떠 있는 창에서 상품 페이지를 다시 받는다. → 사유 (멀쩡하면 null)
 *
 * refresh() 가 아니라 get() 이다. 구매 레이어가 떠 있거나 딴 데로 넘어가 있어도 같은
 * 자리로 돌아온다 — 감시는 늘 같은 자리에서 시작해야 읽는 값을 믿을 수 있다.
 */
export async function reopen(box: Chrome, url: string, timeout = 20): Promise<string | null> {
  try {
    await box.driver.get(url);
  } catch (e) {
    return `상품 페이지를 다시 받지 못했습니다: ${(e as Error).message}`;
  }
  return landed(box, timeout);
}

/**
 * 창에 떠 있는 window.__PRELOADED_STATE__ 를 가져온다. → 값 (없으면 null)
 *
 * HTML 을 긁어 파싱하는 것보다 이쪽이 낫다. 브라우저가 이미 객체로 들고 있으니
 * `undefined` 를 메우거나 중괄호 짝을 세는 일이 없다(JSON.stringify 가 undefined 를
 * 알아서 뺀다). 확인한 상품 페이지에서 키가 121개였다.
 */
export async function stateOf(box: Chrome): Promise<unknown> {
  let raw: string | null;
  try {
    raw = await box.driver.executeScript<string | null>(
      "try { return JSON.stringify(window.__PRELOADED_STATE__) } catch (e) { return null }");
  } catch (e) {
    log.debug(`상태 JSON 을 창에서 가져오지 못했습니다: ${(e as Error).message}`);
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    log.debug(`창에서 가져온 상태 JSON 을 못 읽었습니다: ${(e as Error).message}`);
    return null;
  }
}

// 화면만 보고 판단할 때 쓰는 자국. 브랜드스토어 상품 두 장을 크롬으로 열어 센 것이다.
//
//   구매 가능 (재고 43)   본문에 '구매하기' 1번, '품절' 0번, 눌리는 <button>구매하기</button> 있음
//   품절     (재고 0)     본문에 '구매하기' 0번, '품절' 1번, '재입고' 1번, 구매 버튼 자체가 없음
//
// 품절이면 버튼이 비활성으로 남는 게 아니라 아예 사라진다. 그래서 버튼의 유무가 신호다.
const BUY_BUTTON_JS = `
return Array.from(document.querySelectorAll('button, a[role="button"]')).some(function (b) {
  var t = (b.innerText || '').trim();
  var r = b.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && b.disabled !== true && (${
  BUY_TEXTS.map((text) => `t === ${JSON.stringify(text)}`).join(" || ")});
});
`;

const SOLDOUT_MARKS = ["품절", "일시품절"];

/**
 * 상태 JSON 을 못 읽었을 때, 화면만 보고 판단한다. → "instock" / "soldout" / null
 *
 * null 은 "모르겠다" 다. 품절로 넘겨 버리면 재고가 열린 걸 놓치고, 구매가능으로 넘겨
 * 버리면 없는 버튼을 누르러 간다. 모르는 것은 모른다고 하고 부른 쪽이 정한다.
 */
export async function domStatus(box: Chrome): Promise<Status | null> {
  const driver = box.driver;
  let body: string;
  try {
    if (await driver.executeScript<boolean>(BUY_BUTTON_JS)) return IN_STOCK;
    body = (await driver.executeScript<string>(BODY_TEXT_JS)) || "";
  } catch (e) {
    log.debug(`화면을 읽지 못했습니다: ${(e as Error).message}`);
    return null;
  }
  if (SOLDOUT_MARKS.some((mark) => body.includes(mark))) return SOLDOUT;
  return null;
}

/** 사람이 크롬 창을 닫았는가. */
export async function windowGone(box: Chrome): Promise<boolean> {
  try {
    await box.driver.getCurrentUrl();
    return false;
  } catch {
    return true;
  }
}

/** 지금 창에 무엇이 떠 있는지 한 줄로. 왜 안 넘어가는지 사람이 판단할 재료다. */
export async function screenNote(box: Chrome): Promise<string> {
  let title: string;
  let body: string;
  try {
    title = ((await box.driver.getTitle()) || "").trim();
    body = (await box.driver.executeScript<string>(BODY_TEXT_JS)) || "";
  } catch (e) {
    return `읽지 못했습니다 (${(e as Error).message})`;
  }
  const first = body.split("\n").map((line) => line.trim()).find((line) => line) ?? "";
  return `제목 ${title || "(없음)"} · 본문 ${first.slice(0, 60) || "(비어 있음)"}`;
}

export interface Bought {
  chrome: Chrome;
  ok: boolean;
  reason: string | null;
}

/**
 * 쿠키를 심은 새 크롬으로 상품을 열어 구매하기까지 누른다.
 *
 * 창을 돌려주는 것은 붙잡아 두기 위해서다. detach 라 노드가 끝나도 창은 남지만,
 * 부른 쪽이 quit() 할 수 있게 손잡이는 넘긴다.
 *
 * 크롬 자체를 못 띄우면 BrowserError 를 낸다.
 */
export async function openBuy(
  url: string, cookie: string,
  opts: { option?: string; ea?: number; headless?: boolean; timeout?: number } = {},
): Promise<Bought> {
  const [box, reason] = await openPage(url, cookie, {
    headless: opts.headless, timeout: opts.timeout,
  });
  if (reason) return { chrome: box, ok: false, reason };

  try {
    const [ok, why] = await buyHere(box, {
      option: opts.option, ea: opts.ea, timeout: opts.timeout,
    });
    return { chrome: box, ok, reason: why };
  } catch (e) {
    // 창은 남긴다. 무엇이 떠 있는지 사람이 봐야 판단이 된다.
    return { chrome: box, ok: false, reason: `구매하기를 누르는 중 오류: ${(e as Error).message}` };
  }
}
