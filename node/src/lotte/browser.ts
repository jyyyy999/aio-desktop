/**
 * 롯데온 상품 페이지를 크롬으로 열어 **결제창까지** 데려다 놓는다.
 *
 *   새 크롬 → 쿠키 주입 → 상품 페이지 → [옵션] → [수량] → 바로 구매하기
 *   → 주문서 도착 확인 → [필수 동의] → 결제하기 → PG 결제창이 떴는지 확인 → 멈춤
 *
 * **여기가 끝이다.** 결제창 안에서는 아무것도 누르지 않는다 — 카드 인증도, 간편결제
 * 비밀번호도, 앱 승인도 사람이 한다. bnkr 판은 결제창에서 몇 개를 더 눌러 QR 을 폰으로
 * 보내지만, 이 판은 창을 띄우는 데까지만 간다.
 *
 * 글자로 눌러야 할 것을 찾는 방법(FIND_TEXT_JS)·누르는 방법(press)·화면이 달라졌는지
 * 재는 방법(reacted)·프레임을 타는 방법(descend·framePaths)은 **bnkr 판 것을 빌려 쓴다.**
 * 그 조각들은 결제창에서 여러 번 틀려 가며 다듬은 것이라, 사이트마다 다시 쓰는 것보다
 * 빌려 쓰는 편이 낫다. 네이버 판이 같은 것을 하고 있다.
 *
 * ---
 * **어디까지 눈으로 확인했는가.** 로그인은 사람이 하는 것이라 이 프로그램을 만들면서
 * 계정으로 들어가 본 적이 없다. 그래서 확인한 자리와 그렇지 않은 자리를 갈라 적어 둔다.
 *
 *   확인함    상품 페이지를 여는 것부터 구매 버튼을 누르는 것까지. 게스트로 한 번 돌려 봤다 —
 *             크롬 3.2초에 페이지가 서고, 수량이 3개로 올라갔고, 눌린 것은
 *             button.hasBgColor.bgColorRed.sizeLarge.alignLeft "바로 구매하기" 였고
 *             (장바구니도 선물하기도 아니다), 그다음 로그인으로 튕긴 것을 아래 코드가
 *             SESSION_DEAD 로 알아봤다. 주문서의 주소 모양은 사이트 스크립트에서 읽었다.
 *   못 봄     주문서 화면, 필수 동의 항목, 결제하기 버튼, 결제창.
 *             로그인은 사람이 하는 것이라 계정으로 들어가 볼 수 없었다.
 *
 * 못 본 자리는 글자로 찾는다 — 글자는 사이트가 바꿔도 사람이 읽고 고칠 수 있다.
 * 처음 한 번은 `--dump-pay` 로 무엇이 있었는지 받아 적고, 그걸 보고 아래 표를 고치면 된다.
 *
 * 봇 탐지를 속이는 옵션(navigator.webdriver 감추기 따위)은 쓰지 않는다. 자동화로 여는
 * 것을 숨길 이유가 없다 — 로그인도 결제도 사람이 한 것이다.
 */
import { writeFileSync } from "node:fs";
import { By, type WebDriver, type WebElement } from "selenium-webdriver";
import {
  alertText, BrowserError, Chrome, descend, FIND_TEXT_JS, framePaths, makeDriver, press,
  reacted, settled,
} from "../browser.js";
import { log } from "../log.js";
import { sleep } from "../util.js";
import { IN_STOCK, SOLDOUT, type Stage, type Status } from "./config.js";
import { LOGIN_PATH } from "./http.js";

export { BrowserError, Chrome };

const COOKIE_DOMAIN = ".lotteon.com";
const HOST_MARK = "lotteon.com";

export const SESSION_DEAD = "로그인 세션이 끊겼습니다";

/**
 * 주문서에 도착했다는 증거. 사이트 스크립트에 박힌 경로를 읽어 온 것이다.
 *
 *   /p/order/orderSheet/one/orders/…    주문서-배송
 *   /p/order/orderSheet/one/payments    주문서-결제정보
 *   /p/order/orderSheet/orders          주문서-결제정보 (선물/명절)
 *
 * 앞의 /p 는 PC·/m 은 모바일이라 뒤쪽만 본다.
 */
const ORDER_MARK = "/order/orderSheet";

// 주문서 화면에 있을 글자들. **못 본 화면이다** — 하나라도 걸리면 도착으로 본다.
const ORDER_TEXTS = ["주문서", "결제수단", "주문상품", "배송지", "최종 결제금액"];

// 상품 페이지의 구매 버튼. 확인한 것이다 — 글자 사이에 **띄어쓰기가 있다**.
//
//   <button class="hasBgColor bgColorRed sizeLarge alignLeft">바로 구매하기</button>
//
// 같은 버튼이 두 벌 있다(본문 하나, 아래 붙어 다니는 막대 하나). 어느 쪽이든 같다.
const BUY_TEXTS = ["바로 구매하기", "바로구매", "구매하기"];

// **누르면 안 되는 것들.** 같은 줄에 나란히 있다.
//   장바구니 담기  담기고 주문서는 안 열린다
//   선물하기      받는 사람을 묻는 다른 흐름으로 샌다
// 글자가 "구매" 를 품지 않아 BUY_TEXTS 로는 안 걸리지만, 적어 두는 편이 낫다.

// 옵션을 펼치는 자리. 옵션 상품에서만 쓴다.
const OPTION_OPENERS = ["옵션 선택", "옵션선택", "선택하세요", "필수 옵션"];

/**
 * 수량 스피너. 확인한 것이다.
 *
 *   <div class="spinnerBox">
 *     <button class="minus disabled" aria-label="수량 감소">-</button>
 *     <div class="number"><input id="topQuantitySpinner" role="spinbutton"
 *          aria-valuemin="1" aria-valuemax="5" aria-valuenow="1"></div>
 *     <button class="plus" aria-label="수량 증가">+</button>
 *   </div>
 *
 * **aria-valuemax 가 그 상품의 1인당 한도다.** 위 상품은 5였다. 그래서 수량을 올리기
 * 전에 한도를 먼저 읽는다 — 한도를 넘겨 누르면 사이트가 alert 로 막고, 그 alert 를
 * 닫지 않으면 이후 조작이 전부 막힌다.
 *
 * 칸에 값을 박아 넣지 않고 + 를 누른다. 스피너는 눌러야 도는 물건이라, 값만 바꾸면
 * 화면에는 보여도 사이트가 든 수량은 그대로일 수 있다.
 */
const SPINNER_JS = `
var box = document.querySelector('.spinnerBox');
var field = document.getElementById('topQuantitySpinner') ||
            document.getElementById('sideQuantitySpinner') ||
            document.querySelector('[role="spinbutton"]');
if (!field) return null;
if (!box) box = field.closest('.spinnerBox') || field.parentElement.parentElement;
var plus = box && (box.querySelector('button.plus') ||
                   box.querySelector('[aria-label="수량 증가"]'));
return [Number(field.value || field.getAttribute('aria-valuenow') || 1),
        Number(field.getAttribute('aria-valuemax') || 0),
        plus || null];
`;

type Pressed = "ok" | "quiet" | "none";
/** FIND_TEXT_JS 가 돌려주는 것. 못 찾으면 false 다. */
type Hit = [string, WebElement | null, string, string];

const BODY_TEXT_JS = "return document.body.innerText || ''";

async function bodyText(driver: WebDriver): Promise<string> {
  try {
    return (await driver.executeScript<string>(BODY_TEXT_JS)) || "";
  } catch {
    return "";
  }
}

async function whereAmI(driver: WebDriver): Promise<string> {
  try {
    return (await driver.getCurrentUrl()) || "";
  } catch {
    return "";
  }
}

/** 로그인 페이지로 튕겼는가. 게스트로 '바로 구매하기' 를 눌러 확인한 자리다. */
function atLogin(url: string): boolean {
  return url.includes(LOGIN_PATH);
}

/** 지금 주문서에 서 있는가. */
async function onOrder(driver: WebDriver): Promise<boolean> {
  return (await whereAmI(driver)).includes(ORDER_MARK);
}

export const WINDOW_GONE = "크롬 창이 사라졌습니다";

/**
 * 주문서에서 뭔가 누르기 전에 서 있는 자리를 확인한다. → 사유 (주문서면 null)
 *
 * **창이 사라진 것과 주문서가 아닌 것을 갈라 말한다.** 창이 없으면 주소를 못 읽고,
 * 그러면 "주문서가 아니다" 로 보인다 — 실제로 그렇게 나온 적이 있다. 사람이 그 줄을
 * 읽고 주문서 화면을 의심하러 가는데, 정작 문제는 창이 없어진 것이었다.
 */
export const KICKED_OUT = "주문서에서 밀려났습니다";

/**
 * 주문서에 들어갔다가 **밀려났는가.** → 지금 주소 (밀려나지 않았으면 null)
 *
 * 들어갈 때는 재고가 있었는데 주문서가 뜨는 사이 딜이 소진되면, 사이트가 장바구니
 * (/p/order/cart)로 돌려보낸다. 2026-09-19 에 테스트 판에서 그렇게 됐는데 "결제수단을
 * 못 찾았다" 로 적히고 "여기까지 데려왔다" 며 감시를 멈췄다 — 산 것이 하나도 없는데.
 * 창이 사라진 것은 여기 넣지 않는다. 그건 사람이 닫았을 수도 있다.
 */
export async function leftOrder(box: Chrome): Promise<string | null> {
  try {
    if (await windowGone(box)) return null;
    return (await onOrder(box.driver)) ? null : await whereAmI(box.driver);
  } catch {
    return null;
  }
}

async function standingOnOrder(box: Chrome): Promise<string | null> {
  if (await windowGone(box)) return WINDOW_GONE;
  if (!(await onOrder(box.driver))) return "주문서가 아닙니다";
  return null;
}

/**
 * 빌려온 쿠키를 크롬에 심는다. → 심은 개수
 *
 * CDP 로 한 번에 심는다. 도메인은 .lotteon.com 하나면 된다 — 상품도 주문서도 전부
 * 그 아래다.
 */
async function inject(box: Chrome, cookie: string): Promise<number> {
  const jar: Record<string, string> = {};
  for (const part of (cookie || "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (name) jar[name] = part.slice(at + 1).trim();
  }
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
      // 값에 따옴표가 든 추적 쿠키는 거절당할 수 있다. 신분을 지는 것만 들어가면 된다.
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
 * 옵션 목록은 대개 꾸며 놓은 목록이라 먼저 펼치고 글자로 고른다. 이미 펼쳐져 있으면
 * 펼치는 단계는 그냥 지나간다.
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
 * **실패해도 위에서 멈추지 않는다.** 못 올리면 1개로 주문서에 가는데, 그건 덜 사는
 * 쪽이라 되돌리기 쉽다. 주문서에서 사람이 보고 고치면 된다.
 */
async function setQuantity(driver: WebDriver, ea: number): Promise<string | null> {
  let got: [number, number, WebElement | null] | null;
  try {
    got = await driver.executeScript<[number, number, WebElement | null] | null>(SPINNER_JS);
  } catch (e) {
    return `수량 스피너를 못 찾았습니다 (${(e as Error).message}) — 1개로 갑니다`;
  }
  if (!got) return "수량 스피너를 못 찾았습니다 — 1개로 갑니다";

  const [now, max, plus] = got;
  // 한도를 넘겨 누르면 사이트가 alert 로 막는다. 그 alert 를 닫지 않으면 이후 조작이
  // 전부 막히므로, 애초에 한도까지만 누른다.
  const want = max > 0 ? Math.min(ea, max) : ea;
  if (want < ea) log.warn(`이 상품은 1인당 ${max}개까지입니다 — ${want}개로 갑니다`);
  if (want <= now) return null;
  if (!plus) return `수량을 올릴 버튼(+)이 없습니다 — ${now}개로 갑니다`;

  for (let at = now; at < want; at++) {
    if (!(await press(driver, plus))) return `수량을 ${want}개로 못 올렸습니다 — ${at}개로 갑니다`;
    const alert = await alertText(driver);
    if (alert) return `수량을 올리다 사이트가 알렸습니다 — ${alert}`;
    await sleep(200);
  }

  // 정말 올라갔는지 본다. 눌렸는데 안 도는 스피너를 "됐다" 고 적고 넘어가지 않는다.
  const after = await driver.executeScript<[number, number, WebElement | null] | null>(SPINNER_JS);
  const stuck = after ? after[0] : 0;
  if (stuck !== want) return `수량이 ${stuck}개에 머물렀습니다 (${want}개를 바랐습니다)`;
  log.debug(`수량을 ${want}개로 올렸습니다.`);
  return null;
}

/**
 * 주문서에 도착했는가. → [도착했는가, 사유]
 *
 * 새 창으로 열릴 수도 있어 창 목록도 함께 본다. 주소만 보고 판단하지 않는 이유는
 * bnkr 판과 같다 — 껍데기만 그려 놓고 내용이 빈 경우가 있다.
 */
async function arrived(box: Chrome, timeout: number): Promise<[boolean, string | null]> {
  const driver = box.driver;
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    const alert = await alertText(driver);
    if (alert) {
      // 옵션 미선택·재고 부족·한도 초과는 전부 alert 로 온다.
      return [false, `사이트가 알렸습니다 — ${alert}`];
    }

    const others = (await driver.getAllWindowHandles()).filter((h) => h !== box.mainWindow);
    if (others.length) await driver.switchTo().window(others[others.length - 1]!);

    const url = await whereAmI(driver);
    if (atLogin(url)) return [false, SESSION_DEAD];
    if (url.includes(ORDER_MARK)) {
      await settled(driver, Math.min(5, timeout));
      const body = await bodyText(driver);
      if (ORDER_TEXTS.some((mark) => body.includes(mark))) return [true, null];
      // 주소는 주문서인데 아직 안 그려졌다. 잠깐 더 본다.
    }
    await sleep(400);
  }

  return [false, `구매하기를 눌렀지만 주문서로 넘어가지 않았습니다 (현재: ${await whereAmI(driver)})`];
}

/**
 * 지금 서 있는 곳이 멀쩡한 상품 페이지인가. → 사유 (멀쩡하면 null)
 */
export async function landed(box: Chrome, timeout = 20): Promise<string | null> {
  const driver = box.driver;
  const alert = await settled(driver, timeout);
  if (alert) return `상품 페이지에서 사이트가 알렸습니다 — ${alert}`;
  if (atLogin(await whereAmI(driver))) return SESSION_DEAD;
  return null;
}

/**
 * **이미 상품 페이지가 떠 있는 창**에서 바로 구매하기부터 주문서까지 누른다.
 *
 * → [주문서까지 갔는가, 사유]
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

  // 수량은 **누르기 전에** 정한다. 주문서에서 바꾸려면 다시 계산이 돌고, 그 사이에
  // 재고가 빠지면 아무것도 아닌 일이 된다.
  if (ea > 1) {
    const reason = await setQuantity(driver, ea);
    if (reason) log.warn(reason);
  }

  const [result, pressed] = await clickAny(driver, BUY_TEXTS, timeout);
  if (result === "none") return [false, `구매 버튼을 못 찾았습니다 (${BUY_TEXTS.join(" / ")})`];
  log.debug(`'${pressed}' 를 눌렀습니다.`);

  return arrived(box, timeout);
}

/**
 * 주문서의 **필수** 동의를 체크한다. → [체크한 것, 남은 것]
 *
 * 보이는 체크박스를 다 누르면 안 된다. 실제 주문서에 이런 것들이 있었다
 * (2026-08-23 에 받아 적음) — 둘 다 **건드리면 안 되는 것**이다.
 *
 *   input[checkbox]#safeNumber_0  label "안심번호 사용"
 *   input[checkbox]#defaultPay    label "이 결제수단을 다음에도 사용"
 *
 * 그래서 조건을 좁혔다 — 아직 안 켜져 있고, 옆에 적힌 글에 아래 말 중 하나가 있고,
 * "선택"·"광고"·"마케팅"·"수신"·"혜택" 이 없는 것만 누른다.
 *
 *   "필수"        흔한 표시
 *   "결제에 동의"  롯데온이 쓰는 말. 받아 적어 보니 **"필수" 가 안 붙어 있었다** —
 *                 label "위 내용을 확인하였으며 결제에 동의합니다."
 *                 "필수" 만 보게 해 뒀다가 이걸 놓쳤다.
 *
 * 조건에 걸리는 것이 하나도 없으면 아무것도 안 한 것이다. 그건 실패가 아니다 —
 * 위 문구가 체크박스가 아니라 그냥 안내문일 수도 있다(그렇게 보인다). 눌러야 하는
 * 것이었다면 사이트가 결제하기에서 alert 로 막고, 그게 사유로 올라온다.
 */
const AGREE_JS = `
function seen(el) {
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
}

// 그 체크박스가 무엇에 대한 동의인지 말해 주는 글. label 이 먼저고, 없으면 감싼 줄이다.
function about(box) {
  var text = "";
  if (box.id) {
    var tag = document.querySelector('label[for="' + box.id + '"]');
    if (tag) text = tag.textContent || "";
  }
  if (!text) {
    var wrap = box.closest("label, li, tr, dd, div");
    if (wrap) text = wrap.textContent || "";
  }
  return text.replace(/\\s+/g, " ").trim().slice(0, 80);
}

var ticked = [], left = [];
Array.prototype.slice.call(document.querySelectorAll('input[type="checkbox"]'))
  .forEach(function (box) {
    // 화면에 안 보이는 체크박스는 label 로 덮어 꾸며 놓은 것일 수 있다. 그건 label 이
    // 보이는지로 가린다 — 진짜로 숨겨 둔 것(hidden)은 우리가 건드릴 것이 아니다.
    var tag = box.id ? document.querySelector('label[for="' + box.id + '"]') : null;
    if (!seen(box) && !(tag && seen(tag))) return;

    var text = about(box);
    if (text.indexOf("필수") === -1 && text.indexOf("결제에 동의") === -1) return;
    if (/선택|광고|마케팅|수신|혜택/.test(text)) return;
    if (box.checked) return;

    // 꾸며 놓은 체크박스는 label 을 눌러야 핸들러가 돈다. 둘 다 해 본다.
    if (tag) tag.click();
    if (!box.checked) box.click();
    if (!box.checked) {
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    (box.checked ? ticked : left).push(text);
  });
return [ticked, left];
`;

export async function agreeHere(box: Chrome): Promise<string | null> {
  const driver = box.driver;
  const away = await standingOnOrder(box);
  if (away) return `${away} — 동의를 건드리지 않았습니다`;

  let got: [string[], string[]];
  try {
    got = await driver.executeScript<[string[], string[]]>(AGREE_JS);
  } catch (e) {
    return `동의 항목을 보다 오류: ${(e as Error).message}`;
  }

  const alert = await alertText(driver);
  if (alert) return `동의를 체크하는데 사이트가 알렸습니다 — ${alert}`;

  const [ticked, left] = got;
  if (ticked.length) log.info(`필수 동의 ${ticked.length}개를 체크했습니다: ${ticked.join(" / ")}`);
  else log.debug("체크할 필수 동의를 못 찾았습니다 (없거나 이미 되어 있습니다).");

  if (left.length) return `동의 항목을 체크하지 못했습니다 (${left.join(" / ")})`;
  return null;
}

/**
 * 주문서의 결제 버튼. **못 본 화면이라 글자로 찾는다.**
 *
 * 금액이 함께 박혀 있을 것으로 본다("22,500원 결제하기" 같은 꼴). bnkr 판에서 네이버페이
 * 버튼이 금액 롤러 때문에 글자가 수십 자였고, 글자가 정확히 같은 것을 찾는 FIND_TEXT_JS
 * 로는 세 번 못 찾았다. 같은 실수를 되풀이하지 않으려고 여기서도 **품고 있는지**로 찾는다.
 *
 * 짧은 것을 먼저 고른다. 약관 본문에 같은 글자가 박혀 있어도 그건 button·a 가 아니라
 * 여기까지 오지 않는다.
 */
const PAY_TEXTS = ["결제하기", "결제 하기"];
const PAY_FIND_JS = `
var wants = arguments[0];

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
  if (el.getAttribute("aria-disabled") === "true") return;
  if (el.classList && el.classList.contains("disabled")) return;
  var text = ((el.textContent || "") + " " + (el.value || "")).replace(/\\s+/g, " ").trim();
  for (var i = 0; i < wants.length; i++) {
    if (text.indexOf(wants[i]) !== -1) { hits.push({ el: el, text: text }); return; }
  }
});

if (!hits.length) return null;
hits.sort(function (a, b) { return a.text.length - b.text.length; });
return [hits[0].el, hits[0].text.slice(0, 40), hits.length];
`;

export interface PayButton {
  element: WebElement | null;
  label: string;
  count: number;
}

/**
 * 주문서에서 결제 버튼을 **찾기만** 한다.
 *
 * 누르는 것은 부른 쪽이 한다. 이 버튼만은 "찾았는지" 를 누르지 않고 확인할 수 있어야
 * 해서 갈라 뒀다 — 눌러 보고 확인하는 것이 곧 결제창을 띄우는 일이기 때문이다.
 */
export async function findPay(driver: WebDriver): Promise<PayButton> {
  const empty: PayButton = { element: null, label: "", count: 0 };
  let got: [WebElement, string, number] | null = null;
  try {
    got = await driver.executeScript<[WebElement, string, number] | null>(PAY_FIND_JS, PAY_TEXTS);
  } catch (e) {
    log.debug(`결제 버튼을 찾는 중 오류: ${(e as Error).message}`);
    return empty;
  }
  if (!got) return empty;
  return { element: got[0], label: got[1], count: Number(got[2]) };
}

/** 지금 창의 맨 위 문서에 iframe 이 몇 개인가. 결제창이 얹히면 이게 늘어난다. */
async function frameCount(driver: WebDriver): Promise<number> {
  try {
    await driver.switchTo().defaultContent();
    return (await driver.findElements(By.css("iframe"))).length;
  } catch {
    return 0;
  }
}

/**
 * 결제수단 고르기.
 *
 * **처음에 틀렸다. 주문서를 받아 적고 나서 고쳤다.**
 *
 * `L.PAY` 라는 이름을 사이트 자바스크립트의 결제수단 표(PY_MNS_CD)에서 읽고 그 글자를
 * 찾게 해 뒀는데, 정작 주문서에는 그런 버튼이 없었다. 그 표는 **결제가 끝난 뒤 무엇으로
 * 냈는지 적는 이름**이지 고르는 화면의 이름이 아니었다. 실제 화면은 탭 아홉 개다
 * (2026-08-23, /p/order/orderSheet/one/payments 에서 받아 적음).
 *
 *   button.tab  간편결제 · 신용카드 · 충전결제 · 퀵계좌이체 ·
 *               카카오페이(그때 켜져 있던 것) · 네이버페이 · 토스페이 · 삼성페이 · 온누리상품권
 *
 * **L.PAY 는 "간편결제" 탭 안에 있다.** 카카오·네이버·토스·삼성이 각자 탭을 갖고 있고
 * 롯데 것만 제 이름 대신 "간편결제" 로 앉아 있다 — 표의 11(L.PAY신용카드)·20(L.PAY계좌)
 * 이 그것이다.
 *
 * 그래서 두 가지를 한다. 탭을 누르고, **그 안에 정말 L.PAY 가 떴는지 확인한다**
 * (pay_method_mark). 탭 이름만 믿고 넘어가면 "간편결제" 가 딴 것을 가리키게 바뀌었을 때
 * 조용히 엉뚱한 수단으로 결제창을 띄운다.
 */
/**
 * 간편결제 안의 **카드 고르기**. → 사유 (골랐으면 null)
 *
 * 받아 적어 보니 간편결제 탭 안은 이렇게 생겼다 (2026-08-23).
 *
 *   input[radio]#lpayCard   label "L.PAY 카드"
 *   input[radio]#lpayBank   label "L.PAY 계좌"
 *   label.payItemLabel "카드선택"
 *   input[search]#lpayCardSelect.vs__search        ← 여기서 등록해 둔 카드를 고른다
 *   button.darkBlue "+카드 추가"
 *   label.payItemLabel "할부선택"
 *   input[search]#selectLCard2.vs__search
 *
 * `vs__` 는 vue-select 다. 목록은 눌러야 열리고, 열린 뒤에만 DOM 에 있다. 그래서
 * 글자로 찾는 보통 방법으로는 안 잡힌다 — 열고, 뭐가 있는지 읽고, 고른다.
 *
 * **어느 카드인지 안 적어 뒀으면, 등록된 것이 하나일 때만 그것을 고른다.** 여러 개인데
 * 말 안 해 줬으면 고르지 않고 목록을 적어 준다 — 남의 카드를 우리가 정할 일이 아니다.
 */
const CARD_OPEN_JS = `
var field = document.getElementById(arguments[0]);
if (!field) return null;
field.scrollIntoView({ block: "center" });
field.click();
field.focus();
return true;
`;

// 열린 목록. vue-select 의 것을 먼저 보고, 아니면 흔한 자리들로 물러선다.
const CARD_LIST_JS = `
var field = document.getElementById(arguments[0]);
if (!field) return [];
var box = field.closest(".v-select, .vs__dropdown-toggle, .vs--open") || document;
var found = box.querySelectorAll(".vs__dropdown-option");
if (!found.length) found = document.querySelectorAll(".vs__dropdown-option");
if (!found.length) found = document.querySelectorAll('[role="option"], .vs__dropdown-menu li');
return Array.prototype.slice.call(found).map(function (el) {
  return (el.textContent || "").replace(/\s+/g, " ").trim();
});
`;

const CARD_PICK_JS = `
var want = arguments[1];
var field = document.getElementById(arguments[0]);
var found = document.querySelectorAll(".vs__dropdown-option");
if (!found.length) found = document.querySelectorAll('[role="option"], .vs__dropdown-menu li');
var list = Array.prototype.slice.call(found);
var hit = null;
for (var i = 0; i < list.length; i++) {
  var text = (list[i].textContent || "").replace(/\s+/g, " ").trim();
  if (want ? text.indexOf(want) !== -1 : true) { hit = list[i]; break; }
}
if (!hit) return null;
var text = (hit.textContent || "").replace(/\s+/g, " ").trim();
hit.click();
if (field) field.blur();
return text;
`;

/** 카드 고르는 칸의 id. 할부칸(selectLCard2)과 헷갈리지 않게 못 박아 둔다. */
const CARD_FIELD = "lpayCardSelect";

export async function pickCard(box: Chrome, want: string, timeout = 20): Promise<string | null> {
  const driver = box.driver;

  let opened: boolean | null;
  try {
    opened = await driver.executeScript<boolean | null>(CARD_OPEN_JS, CARD_FIELD);
  } catch (e) {
    return `카드 고르는 칸을 열지 못했습니다 — ${(e as Error).message}`;
  }
  // 칸이 없으면 이 화면에 카드를 고를 일이 없는 것이다(계좌를 골랐거나 화면이 바뀌었거나).
  if (!opened) {
    log.debug(`카드 고르는 칸(#${CARD_FIELD})이 없습니다. 건너뜁니다.`);
    return null;
  }

  // 목록이 그려질 때까지 잠깐 본다. 열자마자 비어 있을 수 있다.
  let cards: string[] = [];
  const deadline = Date.now() + Math.min(timeout, 6) * 1000;
  while (Date.now() < deadline) {
    cards = (await driver.executeScript<string[]>(CARD_LIST_JS, CARD_FIELD)) || [];
    if (cards.length) break;
    await sleep(200);
  }

  if (!cards.length) return "등록된 카드 목록을 못 읽었습니다 (칸은 열렸습니다)";
  log.info(`등록된 카드 ${cards.length}개: ${cards.join(" / ")}`);

  if (!want && cards.length > 1) {
    return `카드가 ${cards.length}개입니다 — 어느 것인지 pay_card 에 적어주세요 (${cards.join(" / ")})`;
  }

  let picked: string | null;
  try {
    picked = await driver.executeScript<string | null>(CARD_PICK_JS, CARD_FIELD, want);
  } catch (e) {
    return `카드를 고르다 오류: ${(e as Error).message}`;
  }
  if (!picked) return `'${want}' 인 카드가 목록에 없습니다 (${cards.join(" / ")})`;

  const alert = await alertText(driver);
  if (alert) return `카드를 고르다 사이트가 알렸습니다 — ${alert}`;

  log.info(`카드로 '${picked}' 를 골랐습니다.`);
  await sleep(400);
  return null;
}

export const PAY_METHOD_MISSING = "결제수단을 못 골랐습니다";

/**
 * 설정에 적힌 결제수단을 차례로 고른다. → 사유 (다 골랐으면 null)
 *
 *   ["L.PAY|L.pay|엘페이"]   한 단계. 셋 중 눌리는 것을 누른다
 *   []                       아무것도 안 한다 — 화면에 이미 골라져 있는 것으로 간다
 *
 * **못 고르면 사유를 올린다.** 부른 쪽은 그때 결제하기를 누르지 않는다 — 엉뚱한
 * 결제수단으로 결제창을 띄우면 사람은 그것을 물리고 처음부터 다시 해야 한다.
 */
export async function pickPayMethod(
  box: Chrome, steps: string[], mark = "", timeout = 20,
): Promise<string | null> {
  const driver = box.driver;
  if (!steps.length) {
    log.debug("결제수단은 건드리지 않습니다 (pay_method 가 비어 있습니다).");
    return null;
  }
  const away = await standingOnOrder(box);
  if (away) return `${away} — 결제수단을 건드리지 않았습니다`;

  for (const step of steps) {
    const wants = step.split("|").map((one) => one.trim()).filter(Boolean);
    if (!wants.length) continue;

    const [result, pressed] = await clickAny(driver, wants, timeout);
    if (result === "none") {
      // 못 찾은 것이 탭 이름 탓인지, 그사이 주문서에서 쫓겨난 탓인지 먼저 가린다.
      // 쫓겨난 것을 "결제수단 이름을 고치라" 고 적으면 사람이 엉뚱한 데를 고친다.
      const alert = await alertText(driver);
      if (alert) return `결제수단을 찾는 사이 사이트가 알렸습니다 — ${alert}`;
      const where = await leftOrder(box);
      if (where) return `${KICKED_OUT} (현재: ${where}) — 그사이 품절됐을 수 있습니다`;
      return `${PAY_METHOD_MISSING} (${wants.join(" / ")} 를 화면에서 못 찾았습니다)`;
    }
    log.info(`결제수단으로 '${pressed}' 를 골랐습니다.`);

    const alert = await alertText(driver);
    if (alert) return `결제수단을 고르다 사이트가 알렸습니다 — ${alert}`;
    await sleep(500);
  }

  // 눌렀다고 그것이 맞는 것이라는 보장은 없다. 눌린 뒤에 무엇이 떴는지로 확인한다.
  if (!mark) return null;
  const marks = mark.split("|").map((one) => one.trim()).filter(Boolean);
  const body = await bodyText(driver);
  if (marks.some((one) => body.includes(one))) {
    log.debug(`고른 결제수단 화면에 '${marks.find((one) => body.includes(one))}' 가 보입니다.`);
    return null;
  }
  return `${PAY_METHOD_MISSING} — 눌렀지만 화면에 ${marks.join(" / ")} 가 안 보입니다 ` +
    "(등록된 수단이 아니거나 탭 이름이 바뀌었습니다)";
}

export const PG_OPENED = "결제창이 떴습니다 — 결제는 직접 해주세요";
/** 눌렀지만 사이트가 막았다. **이건 결제창까지 간 것이 아니다.** */
export const PG_BLOCKED = "결제창이 뜨기 전에 사이트가 막았습니다";
export const PG_UNSEEN = "결제하기는 눌렀지만 결제창 신호를 못 봤습니다 — 크롬 창을 봐주세요";

/**
 * 주문서에서 결제하기를 눌러 **PG 결제창을 띄우고 멈춘다.** → [눌렀나, 무슨 일이 있었나]
 *
 * 결제창이 떴다는 신호는 셋 중 하나다 — 새 창, 새로 얹힌 iframe, 아니면 alert(막힘).
 * bnkr 판에서 새 창만 기다리다 20초를 그냥 버린 적이 있다. 그 사이트의 결제창은 새 창이
 * 아니라 iframe 으로 얹혔고, 오지 않을 신호를 꽉 채워 기다렸던 것이다. 롯데온이 어느
 * 쪽인지는 못 봤으므로 **셋 다 본다.**
 *
 * **주문서가 아니면 아무것도 하지 않는다.** 엉뚱한 화면에서 "결제하기" 를 찾아 누르는
 * 것이 제일 나쁜 경우라, 누르기 전에 서 있는 자리부터 확인한다.
 */
export async function payHere(box: Chrome, timeout = 20): Promise<[boolean, string]> {
  const driver = box.driver;
  const away = await standingOnOrder(box);
  if (away) return [false, `${away} — 누르지 않았습니다`];

  const { element, label, count } = await findPay(driver);
  if (!element) return [false, `결제 버튼을 못 찾았습니다 (${PAY_TEXTS.join(" / ")})`];
  log.debug(`결제 버튼을 찾았습니다 — ${JSON.stringify(label)} (후보 ${count}개)`);

  // 창이 사라졌을 수 있다(사람이 닫거나 크롬이 죽거나). 여기서 그냥 터지면 이 판이
  // 통째로 끝나고, 정작 남겨야 할 받아적기도 못 한다.
  let before: Set<string>;
  try {
    before = new Set(await driver.getAllWindowHandles());
  } catch (e) {
    return [false, `크롬 창이 사라졌습니다 — ${(e as Error).message}`];
  }
  const frames = await frameCount(driver);

  if (!(await press(driver, element))) return [false, "결제 버튼을 누르지 못했습니다"];

  const deadline = Date.now() + Math.min(timeout, 10) * 1000;
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
    if (now.some((h) => !before.has(h))) {
      log.debug("결제창이 새 창으로 떴습니다.");
      return [true, PG_OPENED];
    }
    if ((await frameCount(driver)) > frames) {
      log.debug("결제창이 이 창에 얹혔습니다.");
      return [true, PG_OPENED];
    }
    await sleep(200);
  }

  // 신호를 못 봤다고 실패는 아니다. 창은 떠 있고, 사람이 보면 안다.
  return [true, PG_UNSEEN];
}

/**
 * 결제창에 무엇이 보였는지 프레임마다 받아 적는다. → 적었으면 true
 *
 * **이 판을 만들 때 결제창을 못 봤다.** 그래서 이 파일이 있다 — 처음 한 번 여기까지
 * 가 본 사람이 이걸로 받아 적으면, 결제 버튼을 어떻게 찾을지 추측이 아니라 본 것으로
 * 고칠 수 있다. 결제창은 아무 때나 띄워 볼 수 있는 화면이 아니다.
 *
 * 사람 정보(이름·연락처·주소·카드번호)는 적지 않는다. 사람이 적는 칸의 값은 가리고,
 * 라디오·체크박스의 value 는 남긴다 — 그건 화면이 무엇을 고를 수 있는지 말해 주는 표다.
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
  return (el.value || el.alt || el.getAttribute("title") || "").trim();
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

export async function dumpPayment(box: Chrome, path: string): Promise<boolean> {
  const driver = box.driver;
  const lines: string[] = [`# 롯데온 결제창 받아적기 — ${new Date().toISOString()}`];
  const html: string[] = [];

  // 결제창이 새 창으로 떴으면 그리로 옮겨서 적는다. 얹힌 것이면 지금 창의 프레임에 있다.
  const others = (await driver.getAllWindowHandles()).filter((h) => h !== box.mainWindow);
  if (others.length) await driver.switchTo().window(others[others.length - 1]!);

  for (const frame of await framePaths(driver, 2)) {
    const at = frame.length ? JSON.stringify(frame) : "top";
    let where: string;
    let found: string[];
    try {
      if ((await descend(driver, frame)) === null) continue;
      where = await driver.executeScript<string>("return location.href");
      found = await driver.executeScript<string[]>(DUMP_JS);
    } catch (e) {
      lines.push(`\n[frame ${at}] 읽지 못함: ${(e as Error).message}`);
      continue;
    }
    lines.push(`\n[frame ${at}] ${where}  (${found.length}개)`);
    lines.push(...found.map((item) => `  ${item}`));

    // 남의 집(PG) 쪽은 마크업까지 남긴다. 요약만으로는 왜 안 눌렸는지 모를 때가 있다.
    if (!where.includes(HOST_MARK)) {
      try {
        const body = await driver.executeScript<string>("return document.body.outerHTML");
        if (body) html.push(`\n\n===== [frame ${at}] ${where} =====\n${body.slice(0, 200000)}`);
      } catch {
        // 못 긁어도 위의 요약은 남는다.
      }
    }
  }

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
 * 주문서에 도착한 뒤, 시킨 데까지 마저 누른다. → [어디까지 갔나, 사유]
 *
 * 사유가 붙어도 창은 떠 있다. 못 누른 것은 사람이 누르면 된다.
 */
export async function finish(
  box: Chrome, action: "open" | "agree" | "submit", timeout: number,
  payMethod: string[] = [], payMark = "", payCard = "",
): Promise<[Stage, string | null]> {
  if (action === "open") return ["opened", null];

  const reason = await agreeHere(box);
  if (reason) return ["opened", reason];
  if (action === "agree") return ["agreed", null];

  // **결제수단을 못 골랐으면 결제하기를 누르지 않는다.** 여기서 그냥 지나가면 화면에
  // 미리 골라져 있던 것으로 결제창이 뜬다 — 사람은 그것을 물리고 처음부터 다시 해야
  // 하고, 하필 재고가 열린 순간에 그 시간을 쓴다. 주문서는 열려 있으니 사람이 고르면 된다.
  const missed = await pickPayMethod(box, payMethod, payMark, timeout);
  if (missed) return ["agreed", missed];

  // 간편결제는 수단을 고른 것으로 끝나지 않는다. 등록해 둔 카드를 하나 골라야 한다.
  // 안 고르고 결제하기를 누르면 사이트가 alert 로 막는다.
  if (payMethod.length) {
    const noCard = await pickCard(box, payCard, timeout);
    if (noCard) return ["agreed", `${PAY_METHOD_MISSING} — ${noCard}`];
  }

  const [pressed, note] = await payHere(box, timeout);
  if (!pressed) return ["agreed", note];

  // **누른 것과 결제창이 뜬 것은 다르다.**
  //
  // 여기서 크게 틀렸었다. 눌리기만 하면 무조건 "submitted" 로 적었는데, 사이트가
  // alert 로 막은 경우도 눌린 것이라 그리로 갔다. 그래서 아직 주문서에 서 있는 판을
  // "결제창까지 띄웠습니다" 라고 보고했고, 사이트가 뭐라고 막았는지는 그 줄에 묻혔다.
  //
  // 결제창까지 갔다고 말할 수 있는 것은 둘뿐이다 — 창을 봤거나(PG_OPENED),
  // 눌렀는데 신호를 못 본 것(PG_UNSEEN). 나머지는 못 간 것이다.
  if (note === PG_OPENED) return ["submitted", null];
  if (note === PG_UNSEEN) return ["submitted", PG_UNSEEN];
  return ["agreed", note];
}

/**
 * 쿠키를 심은 새 크롬으로 상품 페이지를 연다. **누르지는 않는다.**
 *
 * → [창, 사유]  — 멀쩡한 상품 페이지면 사유가 null 이다.
 *
 * 크롬 자체를 못 띄우면 BrowserError 를 낸다.
 */
export async function openPage(
  url: string, cookie: string,
  opts: { headless?: boolean; timeout?: number; requireCookie?: boolean } = {},
): Promise<[Chrome, string | null]> {
  const timeout = opts.timeout ?? 20;

  const box = await makeDriver(opts.headless ?? false);
  try {
    const planted = await inject(box, cookie);
    if (!planted && (opts.requireCookie ?? true)) throw new BrowserError("심을 쿠키가 없습니다");
    log.debug(`크롬에 쿠키 ${planted}개를 심었습니다.`);

    await box.driver.get(url);
    // 결제창이 새 창으로 뜰 수 있다. 나중에 어느 것이 결제창인지 가리려면 지금 창을
    // 기억해 둬야 한다.
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
 * refresh() 가 아니라 get() 이다. 딴 데로 넘어가 있어도 같은 자리로 돌아온다 —
 * 감시는 늘 같은 자리에서 시작해야 읽는 값을 믿을 수 있다.
 */
export async function reopen(box: Chrome, url: string, timeout = 20): Promise<string | null> {
  try {
    await box.driver.get(url);
  } catch (e) {
    return `상품 페이지를 다시 받지 못했습니다: ${(e as Error).message}`;
  }
  return landed(box, timeout);
}

// 화면만 보고 판단할 때 쓰는 자국. 상품 페이지를 크롬으로 열어 센 것이다 —
// 구매 가능한 상품에는 눌리는 <button>바로 구매하기</button> 가 두 개 있었다.
// 품절인 상품은 못 봤으므로, 버튼이 없을 때 무엇이 뜨는지는 글자로 물러서서 본다.
const BUY_BUTTON_JS = `
return Array.prototype.slice.call(document.querySelectorAll('button, a[role="button"]'))
  .some(function (b) {
    var t = (b.innerText || '').replace(/\\s+/g, ' ').trim();
    var r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && b.disabled !== true && (${
  BUY_TEXTS.map((text) => `t === ${JSON.stringify(text)}`).join(" || ")});
  });
`;

const SOLDOUT_MARKS = ["품절", "일시품절", "재입고 알림", "판매종료"];

/**
 * 창에 뜬 화면만 보고 판단한다. → "instock" / "soldout" / null
 *
 * null 은 "모르겠다" 다. 품절로 넘겨 버리면 재고가 열린 걸 놓치고, 구매가능으로 넘겨
 * 버리면 없는 버튼을 누르러 간다. 모르는 것은 모른다고 하고 부른 쪽이 정한다.
 */
export async function domStatus(box: Chrome): Promise<Status | null> {
  const driver = box.driver;
  let body: string;
  try {
    if (await driver.executeScript<boolean>(BUY_BUTTON_JS)) return IN_STOCK;
    body = await bodyText(driver);
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

export interface Bought {
  chrome: Chrome;
  ok: boolean;
  reason: string | null;
}

/**
 * 쿠키를 심은 새 크롬으로 상품을 열어 바로 구매하기까지 누른다.
 *
 * 창을 돌려주는 것은 붙잡아 두기 위해서다. detach 라 노드가 끝나도 창은 남지만,
 * 부른 쪽이 quit() 할 수 있게 손잡이는 넘긴다.
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
