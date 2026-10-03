/**
 * 롯데온 상품 페이지를 크롬으로 열어 **결제창까지** 데려다 놓는다.
 *
 *   새 크롬 → 쿠키 주입 → 상품 페이지 → [옵션] → [수량] → 바로 구매하기
 *   → 주문서 도착 확인 → [필수 동의] → 결제하기 → PG 결제창이 떴는지 확인 → 멈춤
 *
 * **여기가 끝이다.** 결제창 안에서 사람이 하는 것(카드 인증·앱 승인 따위)은 그대로
 * 사람이 한다. 다만 **간편결제 비밀번호만은** pg_password 를 적어 두면 자판을 눌러 준다
 * (아래 enterPin) — 못 누르면 사람이 누르면 된다. bnkr 판은 결제창에서 몇 개를 더 눌러
 * QR 을 폰으로 보내지만, 이 판은 창을 띄우고 비밀번호까지 넣는 데까지 간다.
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
import { basename, join } from "node:path";
import { By, type WebDriver, type WebElement } from "selenium-webdriver";
import {
  alertText, BrowserError, Chrome, descend, FIND_TEXT_JS, framePaths, makeDriver, press,
  reacted, settled,
} from "../browser.js";
import { log } from "../log.js";
import { sleep } from "../util.js";
import { BASE, IN_STOCK, SOLDOUT, type Stage, type Status } from "./config.js";
import { LOGIN_PATH } from "./http.js";
import { readTracer, waitTracer } from "./tracer.js";

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
// 주문서가 바로구매 항목을 거절하면 돌려보내는 곳 (2026-09-19 에 받아 적음: /p/order/cart/type/01).
const CART_MARK = "/order/cart";

// 주문서 화면에 있을 글자들. **못 본 화면이다** — 하나라도 걸리면 도착으로 본다.
const ORDER_TEXTS = ["주문서", "결제수단", "주문상품", "배송지", "최종 결제금액"];

// 상품 페이지의 구매 버튼. 확인한 것이다 — 글자 사이에 **띄어쓰기가 있다**.
//
//   <button class="hasBgColor bgColorRed sizeLarge alignLeft">바로 구매하기</button>
//
// 같은 버튼이 두 벌 있다(본문 하나, 아래 붙어 다니는 막대 하나). 어느 쪽이든 같다.
//
// **주문서로 가는 버튼은 셋이다.** 사이트 스크립트의 버튼 표(main.*.js)를 옮긴다:
//
//   바로 구매하기   buyNow    ┐
//   예약 구매하기   reserve   ├ 셋 다 같은 흐름 — 바로구매용으로 담고 주문서로 간다
//   주문 신청하기   order     ┘
//   장바구니 담기·선물하기·상담 신청하기·재입고 알림 신청하기 — 누르면 안 된다
//
// 2026-09-26 10:00 포켓몬 MEGA 30th 드랍은 **예약배송 딜**이라 버튼이 "예약 구매하기" 였다.
// "바로 구매하기" 만 찾다가 두 판을 24초씩 날렸고, 세 번째 판에는 아래 건너뛰기 링크를 눌렀다.
const BUY_TEXTS = ["바로 구매하기", "예약 구매하기", "주문 신청하기", "바로구매"];

// **사지 못한다는 버튼.** 사이트가 구매 버튼 자리에 대신 그리는 것들이다 (같은 표).
// 이게 떠 있으면 주문서는 없다 — 기다리지 말고 그 글자를 사유로 올린다.
const STOP_TEXTS = [
  "현재 판매중인 상품이 아닙니다", "품절된 상품입니다", "판매종료된 상품입니다",
  "판매중지된 상품입니다", "재입고 알림 신청하기",
];
// 막힘 버튼이 이만큼 이어져야 믿는다(초). 페이지가 막 뜰 때 자료를 받기 전의 빈 상태를
// 막힘으로 그렸다가 곧 구매 버튼으로 바꿀 수 있어서다.
const STOP_HOLD = 3;

/**
 * 구매 버튼을 **한 번에** 훑는다. → ["go", 글자] / ["stop", 글자] / null (아직 없음)
 *
 * 예전에는 글자 하나씩 차례로 찾았다(clickAny). 글자마다 제 몫의 시간을 다 기다려서,
 * 버튼이 둘째 글자면 첫째 몫을 통째로 흘렸다. 여기서는 전부를 한 번에 본다.
 *
 * **"구매하기" 건너뛰기 링크는 빼고 본다.** 스크린리더용이다 (main.*.js):
 *
 *   <div id="skipNavPurchase"><a href="#toGoPurchase">구매하기</a></div>
 *
 * 누르면 스크롤만 하고 주소에 #toGoPurchase 가 붙는다. 2026-09-05 과 09-26 에 이걸 눌렀다.
 * 09-26 에는 치우는 코드가 있었는데도 눌렀다 — 치우는 코드가 링크가 그려지기 **전에**
 * 한 번 돌고 말았다. 그래서 치우지 않고, 볼 때마다 뺀다. 글자도 정확히 맞아야 한다.
 */
const BUY_BUTTON_SCAN_JS = `
var GO = arguments[0], STOP = arguments[1];
// 대기열(TRACER) 화면. 버튼은 차례가 온 뒤의 상품 페이지에 있다 (tracer.ts).
if (document.getElementById('tracer_domain')) return ['queue', '', null];
function seen(el) {
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
}
var stop = null;
var all = document.querySelectorAll('button, a, [role="button"]');
for (var i = 0; i < all.length; i++) {
  var el = all[i];
  if (el.closest('#skipNavPurchase')) continue;
  if ((el.getAttribute('href') || '').charAt(0) === '#') continue;
  if (!seen(el)) continue;
  var t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  if (GO.indexOf(t) >= 0 && el.disabled !== true) return ['go', t, el];
  if (STOP.indexOf(t) >= 0) stop = t;
}
if (stop) return ['stop', stop, null];
// 버튼조차 없는 안내 페이지. 판매중지 상품은 상품 페이지 대신 이것만 뜬다 (인페르노X 가 그랬다).
// 버튼 표의 문구와 띄어쓰기가 다르다 — "판매 중인".
var body = (document.body && document.body.innerText) || '';
if (body.length < 3000 && body.indexOf('현재 판매 중인 상품이 아닙니다') >= 0) {
  return ['stop', '현재 판매 중인 상품이 아닙니다', null];
}
return null;
`;

/** [종류, 글자, 누를 요소]. 요소를 바로 받아 누른다 — 글자로 다시 찾으면 딴 것이 걸릴 수 있다. */
type Scan = ["go" | "stop" | "queue", string, WebElement | null] | null;

/**
 * 구매 버튼이 뜰 때까지 기다린다. → ["go", 누를 글자] / ["stop", 막힘 글자] / ["queue"] / null (시간 다 됨)
 *
 * 대기 화면이면 곧장 돌려준다 — 거기서 기다리는 것은 부른 쪽이 waitTracer 로 한다.
 */
async function waitBuyButton(driver: WebDriver, timeout: number): Promise<Scan> {
  const deadline = Date.now() + timeout * 1000;
  let stopSince = 0;
  let last: Scan = null;
  while (Date.now() < deadline) {
    try {
      last = await driver.executeScript<Scan>(BUY_BUTTON_SCAN_JS, BUY_TEXTS, STOP_TEXTS);
    } catch {
      last = null;  // 대개 alert 다. 부른 쪽의 arrived 가 잡는다.
    }
    if (last?.[0] === "go" || last?.[0] === "queue") return last;
    if (last?.[0] === "stop") {
      stopSince ||= Date.now();
      if (Date.now() - stopSince >= STOP_HOLD * 1000) return last;
    } else {
      stopSince = 0;
    }
    await sleep(150);
  }
  return last?.[0] === "stop" ? last : null;
}

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
 * (/p/order/cart)로 돌려보낸다. 2026-09-19 에 그렇게 됐는데 "결제수단을 못 찾았다" 로
 * 적히고 "여기까지 데려왔다" 며 감시를 멈췄다 — 산 것이 하나도 없는데.
 * 창이 사라진 것은 여기 넣지 않는다. 그건 사람이 닫았을 수도 있다.
 */
export async function leftOrder(box: Chrome): Promise<string | null> {
  try {
    if (await windowGone(box)) return null;
    // alert 가 떠 있으면 주소를 못 읽는다(예외가 나서 "안 밀려났다" 로 읽혔다). 먼저 닫고,
    // 사이트가 그 뒤에 장바구니로 보내는지 잠깐 지켜본다. 문구는 훅이 이미 적어 뒀다.
    if (await alertText(box.driver)) {
      const until = Date.now() + 3000;
      while (Date.now() < until && (await onOrder(box.driver))) await sleep(200);
    }
    return (await onOrder(box.driver)) ? null : await whereAmI(box.driver);
  } catch {
    return null;
  }
}

/**
 * 밀려난 사유를 한 줄로. 사이트가 alert 로 남긴 말이 있으면 그것을 붙이고,
 * 거쳐 온 길(상품 → 주문서 → 알림 → 장바구니)은 로그에 따로 적는다.
 */
export async function kickedReason(box: Chrome, where: string): Promise<string> {
  const trail = await readTrail(box);
  if (trail.length) log.info(`   거쳐 온 길: ${trailLine(trail)}`);
  const said = lastSaid(trail);
  return `${KICKED_OUT} (현재: ${where})` + (said ? ` — 사이트: ${said}` : " — 사이트는 아무 말도 없었습니다");
}

async function standingOnOrder(box: Chrome): Promise<string | null> {
  if (await windowGone(box)) return WINDOW_GONE;
  if (!(await onOrder(box.driver))) return "주문서가 아닙니다";
  return null;
}

/**
 * **사이트가 한 말과 거쳐 간 페이지를 탭에 적어 두는 훅.** (2026-09-23)
 *
 * 포켓몬 드랍 때마다 바로 구매하기 → 빈 장바구니로 끝난다. 사이트 스크립트를 읽어 보니
 * 바로구매는 이렇게 간다 (main.*.js 의 addCartBuyNow):
 *
 *   ① POST pbf.lotteon.com/order/v3/carts/{cartDvsCd}/products/{spdNo}/singles/{sitmNo}
 *      — 장바구니에 **바로구매용(drtPurYn)** 으로 담는다. 일반 장바구니 탭에는 안 보인다
 *   ② 받은 cartSns 를 폼으로 retOrdSheetUrl(주문서)에 POST 한다
 *   ③ 주문서가 그 항목을 거절하면 장바구니(/p/order/cart/type/01)로 돌려보낸다
 *
 * ③에서 "일반(0)" 인 빈 장바구니가 뜨는 것은, 담긴 것이 바로구매용이라 거기 안 보여서다.
 * 거절 사유는 사이트가 alert() 로 띄우는데 — **셀레니움이 그 alert 를 저절로 닫는다**
 * (unhandledPromptBehavior 기본값 "dismiss and notify"). 그래서 우리 로그에는 "결제수단을
 * 못 찾았다" 만 남고 정작 사이트가 뭐라고 했는지는 없었다.
 *
 * 그래서 새 문서가 뜰 때마다 alert·confirm 을 감싸 문구를 sessionStorage 에 적는다.
 * 같은 탭·같은 출처(www.lotteon.com)면 페이지를 넘어가도 남으므로, 장바구니에 떨어진
 * 뒤에도 주문서가 마지막에 무슨 말을 했는지 읽을 수 있다. 원래 alert 는 그대로 부른다 —
 * 사이트의 흐름은 건드리지 않고 받아 적기만 한다.
 */
const TRAIL_KEY = "__aio_trail";
const TRAIL_JS = `
(function () {
  try {
    var KEY = ${JSON.stringify(TRAIL_KEY)};
    function note(kind, text) {
      try {
        var all = JSON.parse(sessionStorage.getItem(KEY) || "[]");
        all.push({ t: Date.now(), k: kind, m: String(text || "").slice(0, 300), u: location.pathname });
        sessionStorage.setItem(KEY, JSON.stringify(all.slice(-40)));
      } catch (e) {}
    }
    var realAlert = window.alert, realConfirm = window.confirm;
    window.alert = function (m) { note("alert", m); return realAlert.apply(this, arguments); };
    window.confirm = function (m) { note("confirm", m); return realConfirm.apply(this, arguments); };
    note("page", location.pathname);
  } catch (e) {}
})();
`;

/** 새 문서마다 훅을 건다. 못 걸어도 사는 데는 지장이 없으니 조용히 넘어간다. */
async function installTrail(box: Chrome): Promise<void> {
  const driver = box.driver as WebDriver & {
    sendDevToolsCommand(cmd: string, params: object): Promise<void>;
  };
  try {
    await driver.sendDevToolsCommand("Page.enable", {});
    await driver.sendDevToolsCommand("Page.addScriptToEvaluateOnNewDocument", { source: TRAIL_JS });
  } catch (e) {
    log.debug(`알림 받아적기 훅을 못 걸었습니다: ${(e as Error).message}`);
  }
}

interface TrailItem { t: number; k: string; m: string; u: string }

/** 탭에 적힌 것을 읽는다. 알림이 떠 있거나 창이 없으면 빈 목록이다. */
export async function readTrail(box: Chrome): Promise<TrailItem[]> {
  try {
    const raw = await box.driver.executeScript<string | null>(
      `return sessionStorage.getItem(${JSON.stringify(TRAIL_KEY)})`);
    return raw ? (JSON.parse(raw) as TrailItem[]) : [];
  } catch {
    return [];
  }
}

/** 사람이 읽을 한 줄로. "주문서 → 알림 '…' → 장바구니" */
export function trailLine(items: TrailItem[]): string {
  const short = (path: string) =>
    path.includes("/order/cart") ? "장바구니" :
    path.includes(ORDER_MARK) ? "주문서" :
    path.includes("/product/") ? "상품" : path;
  return items.map((one) => one.k === "page" ? short(one.u) : `${one.k} '${one.m}'`).join(" → ");
}

/** 사이트가 마지막으로 한 말 (alert·confirm). 없으면 null. */
export function lastSaid(items: TrailItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.k !== "page") return items[i]!.m;
  }
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
async function arrived(
  box: Chrome, timeout: number, queue: Queue = { wait: 300, clock: null },
): Promise<[boolean, string | null]> {
  const driver = box.driver;
  let deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    // 주문서로 가는 길에도 대기열이 설 수 있다 (아직 본 적은 없다). 기다린 만큼 시한을 미룬다.
    if (await readTracer(driver)) {
      const from = Date.now();
      const why = await waitTracer(driver, queue.wait);
      if (why) return [false, why];
      deadline += Date.now() - from;
      if (queue.clock) queue.clock.deadline += Date.now() - from;
      continue;
    }

    const alert = await alertText(driver);
    if (alert) {
      // 옵션 미선택·재고 부족·한도 초과는 전부 alert 로 온다.
      return [false, `사이트가 알렸습니다 — ${alert}`];
    }

    const others = (await driver.getAllWindowHandles()).filter((h) => h !== box.mainWindow);
    if (others.length) await driver.switchTo().window(others[others.length - 1]!);

    const url = await whereAmI(driver);
    if (atLogin(url)) return [false, SESSION_DEAD];
    // 주문서가 받자마자 거절하면 곧장 장바구니로 온다. 시간을 다 채워 기다릴 일이 아니다.
    if (url.includes(CART_MARK)) return [false, await kickedReason(box, url)];
    if (url.includes(ORDER_MARK)) {
      await settled(driver, Math.min(5, timeout));
      const body = await bodyText(driver);
      if (ORDER_TEXTS.some((mark) => body.includes(mark))) return [true, null];
      // 주소는 주문서인데 아직 안 그려졌다. 잠깐 더 본다.
    }
    await sleep(400);
  }

  return [false, `${NOT_ARRIVED} (현재: ${await whereAmI(driver)})`];
}

const NOT_ARRIVED = "구매하기를 눌렀지만 주문서로 넘어가지 않았습니다";

/**
 * 대기열에서 기다릴 시간과, 기다린 만큼 미뤄 줄 시한. 줄 서 있던 시간은 browser_timeout_seconds
 * 에 넣지 않는다 — 넣으면 20초 만에 "버튼을 못 찾았다" 가 되어 창을 닫는다 (2026-10-03).
 */
interface Queue {
  wait: number;
  clock: { deadline: number } | null;
}

/**
 * 누른 뒤 이만큼 제자리면 다시 누른다(초).
 *
 * 한 번 누르고 주문서를 browser_timeout_seconds(20초) 내내 기다리던 자리다. 2026-09-18
 * 14:07 에 딜 30개짜리 재입고를 잡고 눌렀는데 반응 없이 20초를 흘려보냈고, 두 번째 판에는
 * "재고가 모두 소진" 이었다. 크롬을 띄워 버튼이 보이기까지는 2.5초면 된다 (재 봤다) —
 * 20초는 전부 기다린 시간이었다. 버튼이 그려졌어도 사이트 스크립트가 아직 안 붙어 있으면
 * 눌러도 먹지 않는다. 그럴 때는 기다리지 말고 다시 누르는 편이 낫다.
 *
 * 두 번 눌러도 주문서가 두 장 생길 뿐 결제가 되지는 않는다 — 결제는 주문서 뒤의 일이다.
 */
const REPRESS_AFTER = 4;

/** 아직 상품 페이지에 서 있는가 — 누른 것이 안 먹은 자리. */
function stillOnProduct(url: string): boolean {
  return url.includes("/product/") && !url.includes(ORDER_MARK) && !atLogin(url);
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
  box: Chrome, opts: { option?: string; ea?: number; timeout?: number; queueWait?: number } = {},
): Promise<[boolean, string | null]> {
  const driver = box.driver;
  const option = opts.option ?? "";
  const ea = opts.ea ?? 1;
  const timeout = opts.timeout ?? 20;
  const queueWait = opts.queueWait ?? 300;

  if (box.mainWindow === null) box.mainWindow = await driver.getWindowHandle();

  // 대기열이면 먼저 줄을 선다. 옵션·수량·구매 버튼은 전부 차례가 온 뒤의 상품 페이지에 있다.
  const queued = await waitTracer(driver, queueWait);
  if (queued) return [false, queued];

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

  let found = await waitBuyButton(driver, timeout);
  // 넘어온 상품 페이지에서 다시 대기 화면이 뜰 수 있다. 몇 번까지는 다시 줄을 선다.
  for (let again = 0; found?.[0] === "queue" && again < 3; again++) {
    const why = await waitTracer(driver, queueWait);
    if (why) return [false, why];
    found = await waitBuyButton(driver, timeout);
  }
  if (!found || found[0] === "queue") return [false, `구매 버튼을 못 찾았습니다 (${BUY_TEXTS.join(" / ")})`];
  // 사이트가 사지 못한다는 버튼을 그렸다. 주문서는 없다 — 그 글자가 곧 사유다.
  if (found[0] === "stop") return [false, `사이트 버튼: ${found[1]}`];
  const pressed = found[1];
  if (!(await press(driver, found[2]!))) {
    return [false, `'${pressed}' 버튼을 누르지 못했습니다`];
  }
  log.info(`'${pressed}' 를 눌렀습니다.`);

  // 시한은 누른 때부터 센다. 줄 서 있던 시간은 넣지 않는다 (arrived 가 기다린 만큼 미룬다).
  const clock = { deadline: Date.now() + timeout * 1000 };
  // 제자리면 다시 누른다. 알림·로그인·주문서 같은 **다른 답**이 오면 그대로 올린다.
  for (let presses = 1; ; presses++) {
    const left = (clock.deadline - Date.now()) / 1000;
    const [ok, why] = await arrived(box, Math.max(1, Math.min(REPRESS_AFTER, left)), { wait: queueWait, clock });
    if (ok || !why?.startsWith(NOT_ARRIVED)) return [ok, why];
    if (Date.now() >= clock.deadline) return [false, `${why} — ${presses}번 눌렀습니다`];
    if (!stillOnProduct(await whereAmI(driver))) continue;

    log.info(`'${pressed}' 를 눌렀는데 ${REPRESS_AFTER}초째 제자리입니다 — 다시 누릅니다 (${presses + 1}번째)`);
    const again = await waitBuyButton(driver, 2);
    if (again?.[0] === "stop") return [false, `사이트 버튼: ${again[1]}`];
    // 대기 화면이면 누를 것이 없다. 다음 바퀴의 arrived 가 줄을 선다.
    if (again?.[0] === "queue") continue;
    if (!again) {
      // 버튼이 사라졌다. 대개 그사이 품절로 바뀐 것이다 — 화면이 무엇을 보여 주는지 붙인다.
      return [false, `구매 버튼이 사라졌습니다 — 그사이 품절됐을 수 있습니다 (현재: ${await whereAmI(driver)})`];
    }
    await press(driver, again[2]!);
  }
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
      if (where) return kickedReason(box, where);
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

// 결제하기를 눌렀더니 주문서 위에 비밀번호 자판 모달이 떴는가. 롯데온의 L.PAY 자판은
// 새 창도 iframe 도 아니고 이 페이지의 레이어라서 (2026-08-25 에 받아 적음 —
// button.btnCustom), 창/iframe 신호로는 안 잡힌다. 자판이 보이면 결제창이 열린 것이다.
const KEYPAD_UP_JS = `
var el = document.querySelector('.btnCustom, [class*="btnCustom"]');
if (!el) return false;
var r = el.getBoundingClientRect();
if (r.width <= 0 || r.height <= 0) return false;
var s = window.getComputedStyle(el);
return s.visibility !== "hidden" && s.display !== "none";
`;

/** 자판 모달(btnCustom)이 지금 떠 있는가. 결제 완료 판정에 쓴다 — 완료되면 모달이 닫힌다. */
export async function keypadModalUp(driver: WebDriver): Promise<boolean> {
  try {
    return await driver.executeScript<boolean>(KEYPAD_UP_JS);
  } catch {
    // 창이 사라졌다 — 떠 있지 않다고 본다.
    return false;
  }
}

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

  // 누르는 사이에 멈췄는지 로그로 알게 한다 — 결제하기를 누르고 결제창이 뜨는 데
  // (또는 크롬이 열리지 않아 click 이 막히는 데) 오래 걸리는 판이 있어서, 어느
  // 지점에 서 있는지 다음 실행에서 바로 보게 하려고 적는다.
  log.debug("결제 버튼을 누릅니다.");
  if (!(await press(driver, element))) return [false, "결제 버튼을 누르지 못했습니다"];
  log.debug("결제 버튼을 눌렀습니다 — 결제창 신호를 기다립니다.");

  const deadline = Date.now() + Math.min(timeout, 10) * 1000;
  while (Date.now() < deadline) {
    const alert = await alertText(driver);
    // 배송지나 결제수단이 비어 있으면 사이트가 alert 로 막는다. 결제창이 안 떴다는 뜻이다.
    if (alert) return [true, `${PG_BLOCKED} — ${alert}`];

    // 롯데온은 결제하기를 누르면 주문서 위에 **자판 모달**이 뜬다 — 새 창/iframe
    // 신호는 오지 않는다. 자판이 보이면 결제창이 열린 것이다. 이것 때문에 창/iframe
    // 신호만 기다리던 때는 자판이 떠 있는데도 10초를 그냥 보냈다.
    try {
      if (await driver.executeScript<boolean>(KEYPAD_UP_JS)) {
        log.debug("결제창(비밀번호 자판)이 떴습니다.");
        return [true, PG_OPENED];
      }
    } catch {
      // 창이 사라졌을 수 있다. 아래에서 본다.
    }

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

// --- 간편결제 비밀번호 자판. ---

/** 자판 읽기의 결과. [상태, [숫자, 키, x, y], 확인 키, 디버그] — 키의 화면 좌표도 함께. */
type KeypadHit = ["found" | "odd", [string, WebElement, number, number][] | null, WebElement | null, string];

/**
 * 롯데온 결제창의 비밀번호 자판. **구조를 아직 못 봤다** — 결제창을 띄워 본 적이
 * 없어서(lotteon-pg-dump.txt 는 로그인 화면이었다), 어느 쪽으로 생겼는지 모르는 채
 * 두 길을 모두 만들어 뒀다.
 *
 *   1. **글자 키.** 키가 숫자 글자(0-9)를 품고 있으면 그대로 읽는다. 값이 aria-label
 *      이나 data-value·data-num·data-key 같은 속성에 박혀 있는 키도 받는다 —
 *      그림으로 그려 놓고 값을 속성으로 나눠 주는 자판이 있다.
 *   2. **스프라이트 키.** 글자도 속성도 없고 키가 그림(background-image)으로만
 *      그려져 있으면, 그림을 잘라 **글꼴 투표**로 숫자를 맞춘다. 네이버페이 자판을
 *      읽은 bnkr 판(bnkr-test/browser.ts 의 KEYPAD_JS)의 방법을 빌린다 — 자판
 *      숫자는 대개 굵은 글꼴로 그린 것이므로, 브라우저에서 0-9 를 여러 굵은
 *      글꼴로 직접 그려 견주면 맞는다. bnkr 판의 고정 본보기는 네이버페이 것이라
 *      못 쓰고, 글꼴 투표만 쓴다.
 *
 * 어느 쪽이든 **0-9 가 한 자씩 다 있어야 자판이다.** 어긋나면 "odd" 로 돌려주고 본
 * 것을 로그에 남긴다 — 못 본 화면의 첫 판이 셀렉터를 고칠 재료다.
 */
export const KEYPAD_JS = `
function visible(el) {
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  // opacity:0 으로 숨겨 두는 자판도 있을 수 있어 레이아웃에 있으면 읽는다.
  // 누르는 쪽에서 막히면 다시 시도하면 된다.
  return s.visibility !== "hidden" && s.display !== "none";
}

function handles(el) {
  var tag = el.tagName;
  if (tag === "A" || tag === "BUTTON" || tag === "LABEL" || tag === "INPUT") return true;
  if (el.onclick || el.getAttribute("onclick") || el.getAttribute("href")) return true;
  try {
    var book = window.jQuery && window.jQuery._data(el, "events");
    if (book && book.click) return true;
  } catch (e) {}
  return false;
}

function resolve(el) {
  if (handles(el)) return el;
  for (var up = el.parentElement; up && up !== document.body; up = up.parentElement) {
    if (handles(up)) return up;
  }
  return null;
}

// 자판 그릇 안에서 "확인" 을 찾는다. 자식을 확인 글자로 갖는 것은 건너뛴다 —
// 그건 그릇이나 줄이다.
function findConfirm(root) {
  var confirm = null;
  Array.prototype.slice.call(root.querySelectorAll("*")).forEach(function (el) {
    if (confirm) return;
    if (!visible(el)) return;
    var text = (el.textContent || "").trim();
    if (text !== "확인") return;
    if (Array.prototype.slice.call(el.querySelectorAll("*")).some(function (kid) {
      return visible(kid) && (kid.textContent || "").trim() === "확인";
    })) return;
    confirm = resolve(el) || el;
  });
  return confirm;
}

// --- 키가 말하는 숫자. 글자 먼저, 그다음 속성. ---
function keyDigit(el) {
  var text = (el.textContent || "").replace(/\\s+/g, "").trim();
  if (/^[0-9]$/.test(text)) return text;
  var attr = ((el.getAttribute("aria-label") || el.getAttribute("data-value") ||
               el.getAttribute("data-num") || el.getAttribute("data-key") ||
               el.getAttribute("data-digit") || el.getAttribute("title") || "") +
              // 값이 박힌 입력칸(포인트 사용액 "0" 따위)이 숫자로 읽히는 것을 막는다.
              // 버튼형 input(value="1" 같은 키)만 값을 본다.
              (el.tagName === "INPUT" && /button|submit/.test(el.getAttribute("type") || "")
                ? " " + (el.value || "") : "")).trim();
  var m = /(^|[^0-9])([0-9])([^0-9]|$)/.exec(attr);
  return m ? m[2] : null;
}

// --- 키다운 정도. 2026-08-25 에 데었다 — 헤더 순위 목록의 숫자
// (<a><span>5</span>블라우스</a>)가 자판 키로 읽혀, 누르자 상품 검색 페이지로
// 나가버렸다. 자판 키는 누르면 딴 데로 가는 것이 아니다.
function keyish(btn) {
  var tag = btn.tagName;
  if (tag === "BUTTON") return 3;
  if (tag === "INPUT") {
    var kind = (btn.getAttribute("type") || "text").toLowerCase();
    return kind === "button" || kind === "submit" ? 2 : 0;
  }
  if (handles(btn)) return 1;
  return 0;
}

// --- 1) 글자/속성 키를 모은다. 같은 숫자를 말하는 후보가 여럿이면 키다운 쪽을
// 고른다 — 페이지 곳곳의 흩어진 숫자 글자(배지·순위 따위)는 키가 아니다.
//
// **링크(a)는 아예 후보에서 뺀다.** 누르면 딴 데로 가는 것이 키패드 키일 수 없다
// (순위 목록의 <span>5</span> → <a>5블라우스</a> 가 그랬다). 누를 수 없는 것도
// 후보에서 뺀다. 그래야 이 페이지에서 자판 키로 남는 것은 열 개의 btnCustom
// 버튼뿐이다 — 받아 적은 롯데온 자판(2026-08-25)이 바로 그 꼴이었다. ---
var byDigit = {};
var scanned = 0;
Array.prototype.slice.call(document.querySelectorAll(
  'button, a, [role="button"], input, span, div, li, td, label'
)).forEach(function (el) {
  if (!visible(el)) return;
  scanned++;
  var d = keyDigit(el);
  if (!d) return;
  var btn = resolve(el) || el;
  if (btn.tagName === "A") return;   // 링크는 키가 아니다
  if (keyish(btn) <= 0) return;      // 누를 수 없는 것은 키가 아니다
  var old = byDigit[d];
  if (!old || keyish(btn) > keyish(old.btn)) byDigit[d] = { el: el, btn: btn };
});

// --- 2) 자판 그릇을 고른다. ---
// 이름 붙은 그릇(keypad·keyboard·secure·pwd·pin…) 중 0-9 를 한 자씩 품은 것.
// 여러 개면 가장 안쪽 것(그릇을 품는 그릇)을 쓴다.
var bowls = [];
Array.prototype.slice.call(document.querySelectorAll(
  '[class*="keypad"],[class*="Keypad"],[class*="keyboard"],[class*="Keyboard"],' +
  '[class*="secure"],[class*="Secure"],[class*="numKey"],[class*="pwd"],[class*="Pwd"],' +
  '[class*="pin"],[id*="keypad"],[id*="Keypad"],[id*="keyboard"],[id*="numKey"]'
)).forEach(function (el) { if (visible(el) && bowls.indexOf(el) === -1) bowls.push(el); });

function digitCount(el) {
  var have = 0;
  for (var d2 = 0; d2 <= 9; d2++) {
    var cand = byDigit[String(d2)];
    if (cand && el.contains(cand.btn)) have++;
  }
  return have;
}
var bowl = null;
for (var i = 0; i < bowls.length; i++) {
  var b = bowls[i];
  if (digitCount(b) >= 10 && (!bowl || b.contains(bowl))) bowl = b;
}

// 이름이 없으면: 0-9 전부의 공통 조상 중 가장 깊은 것. 화면 대부분을 덮는 것은
// 흩어진 숫자 글자를 모은 것일 뿐이라 버린다.
if (!bowl) {
  var keys = [];
  for (var d3 = 0; d3 <= 9; d3++) {
    var rec = byDigit[String(d3)];
    if (rec) keys.push(rec.btn);
  }
  if (keys.length === 10) {
    // 열 개 키가 한곳에 모여 있어야 자판이다. 흩어져 있으면(화면을 가로질러) 그건
    // 페이지 여기저기의 숫자 버튼을 모은 것이다 — 2026-08-25 에 순위 목록 링크를
    // 키로 읽고 검색 페이지로 나간 적이 있다. 자판은 화면 양쪽을 다 덮지는 않는다
    // (창이 작아 자판이 길어도 한쪽은 여유가 있다 — 그건 버리지 않는다).
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (var ki = 0; ki < keys.length; ki++) {
      var kr = keys[ki].getBoundingClientRect();
      if (kr.left < minX) minX = kr.left;
      if (kr.top < minY) minY = kr.top;
      if (kr.right > maxX) maxX = kr.right;
      if (kr.bottom > maxY) maxY = kr.bottom;
    }
    var boxW = maxX - minX, boxH = maxY - minY;
    if (boxW > window.innerWidth * 0.85 && boxH > window.innerHeight * 0.85) {
      return ["odd", null, null,
        "키가 흩어져 있습니다 (" + Math.round(boxW) + "x" + Math.round(boxH) + "px)"];
    }
    var line = [];
    for (var up = keys[0].parentElement; up && up !== document.documentElement; up = up.parentElement) {
      line.push(up);
    }
    for (var j = 0; j < line.length; j++) {
      var el2 = line[j];
      var ok = true;
      for (var k = 1; k < keys.length; k++) {
        if (!el2.contains(keys[k])) { ok = false; break; }
      }
      if (ok) { bowl = el2; break; }
    }
    // 화면을 덮는 모달(전체 레이어)도 자판 그릇일 수 있다 — 받아 적은 롯데온 자판이
    // 주문서 위 전체 레이어에 떠 있었다 (2026-08-25, lotteon-test-pg-dump.txt).
    // 그래서 크기로 막지 않고, body 까지 올라간 것(흩어진 숫자 글자)만 버린다.
    if (bowl === document.body || bowl === document.documentElement) bowl = null;
  }
}

// --- 3) 키 표를 만든다. 0-9 가 한 자씩, 각각 화면 좌표와 함께. ---
var table = [];
var debug = [];
if (bowl) {
  for (var d4 = 0; d4 <= 9; d4++) {
    var rec2 = byDigit[String(d4)];
    if (!rec2 || !bowl.contains(rec2.btn)) { debug.push("missing " + d4); continue; }
    var r = rec2.btn.getBoundingClientRect();
    table.push([String(d4), rec2.btn, Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);
  }
  if (table.length === 10) {
    return ["found", table, findConfirm(bowl),
      debug.join(" ") || "bowl=" + (bowl.className || bowl.id || bowl.tagName) +
        " scanned=" + scanned + " at=" +
        table.map(function (e) { return e[0] + "@" + e[2] + "," + e[3]; }).join(" ")];
  }
}

// --- 4) 스프라이트 자판. 글자/속성 키가 없거나 열 개가 안 모였다. ---
// 그릇: data:image 배경의 span 을 아홉 개 이상 품는 가장 깊은 요소.
var spriteSpans = Array.prototype.slice.call(document.querySelectorAll("span"))
  .filter(function (s) {
    var bg = s.style && s.style.backgroundImage;
    return bg && bg.indexOf("data:image") !== -1 && visible(s);
  });
if (spriteSpans.length < 9) return null;
var ssLine = [];
for (var up2 = spriteSpans[0].parentElement; up2 && up2 !== document.documentElement; up2 = up2.parentElement) {
  ssLine.push(up2);
}
var spriteBowl = null;
for (var j2 = 0; j2 < ssLine.length; j2++) {
  var el3 = ssLine[j2];
  var ok2 = true;
  for (var k2 = 1; k2 < spriteSpans.length; k2++) {
    if (!el3.contains(spriteSpans[k2])) { ok2 = false; break; }
  }
  if (ok2) { spriteBowl = el3; break; }
}
if (!spriteBowl) return null;

// 스프라이트는 매번 갈아끼워질 수 있으니(자리 바뀜) 주소로 기억해 뒀다가, 바뀌면
// 다시 읽는다. 같은 그림을 키마다 새로 디코드하지 않는다.
var CACHE = window.__lotteSpriteCache || (window.__lotteSpriteCache = {});
var spriteUrl = spriteSpans[0].style.backgroundImage.replace(/^url\\(["']?/, "").replace(/["']?\\)$/, "");
var img = CACHE[spriteUrl];
if (!img) {
  img = new Image();
  img.src = spriteUrl;
  var t0 = Date.now();
  while (!img.complete && Date.now() - t0 < 2000) { /* 데이터 URL 은 곧 끝난다 */ }
  if (!img.complete || !img.width) return null;
  CACHE[spriteUrl] = img;
}

var canvas = document.createElement("canvas");
canvas.width = img.width; canvas.height = img.height;
var ctx = canvas.getContext("2d");
ctx.drawImage(img, 0, 0);
var px = ctx.getImageData(0, 0, img.width, img.height).data;
var W = img.width, H = img.height;
function ink(x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  return px[(y * W + x) * 4 + 3] > 100;
}

// 한 조각을 잘라 12×16 그물로 축소한다. 그림자는 남기지 않는다 — 잉크만 남은
// 부분을 감싸는 상자로 잘라서, 키와 본보기가 어느 쪽이 더 크든 같은 그물로 맞춘다.
var CW = 12, CH = 16;
function fingerprint(sx, sy, sw, sh) {
  var minX = sx + sw, minY = sy + sh, maxX = sx, maxY = sy, found = false;
  for (var y = sy; y < sy + sh; y++) for (var x = sx; x < sx + sw; x++) {
    if (ink(x, y)) {
      found = true;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!found) return null;
  var bits = [];
  for (var r = 0; r < CH; r++) {
    var y0c = minY + Math.floor((maxY - minY + 1) * r / CH);
    var y1c = minY + Math.floor((maxY - minY + 1) * (r + 1) / CH) - 1;
    for (var c = 0; c < CW; c++) {
      var x0c = minX + Math.floor((maxX - minX + 1) * c / CW);
      var x1c = minX + Math.floor((maxX - minX + 1) * (c + 1) / CW) - 1;
      var tot = 0, cnt = 0;
      for (var y = y0c; y <= y1c; y++) for (var x = x0c; x <= x1c; x++) { tot++; if (ink(x, y)) cnt++; }
      bits.push(tot > 0 && cnt / tot >= 0.35 ? 1 : 0);
    }
  }
  return bits;
}

// 본보기와 견준다. 작은 어긋남을 감당하도록 ±1칸 옮겨 가며 본다.
function compareBits(a, b) {
  var best = -1;
  for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
    var same = 0, tot = 0;
    for (var r = 0; r < CH; r++) for (var c = 0; c < CW; c++) {
      var rr = r + dy, cc = c + dx;
      if (rr < 0 || rr >= CH || cc < 0 || cc >= CW) continue;
      if (a[r * CW + c] === b[rr * CW + cc]) same++;
      tot++;
    }
    if (tot > 0) {
      var ratio = same / tot;
      if (ratio > best) best = ratio;
    }
  }
  return best;
}

// **글꼴 투표로 숫자를 맞춘다.** 자판 숫자는 매 결제마다 조금씩 다르게 그려진다.
// 브라우저에서 0-9 를 여러 굵은 글꼴로 직접 그려 견주고, 여럿이 투표하므로 어느
// 세션이든 맞는다.
var FONT_VOTERS = ["Arial Black", "Arial", "Malgun Gothic", "Segoe UI", "Arial Rounded MT Bold"];
var REF_CACHE = window.__lotteFontRefs || (window.__lotteFontRefs = {});

function refBits(name, ch) {
  var key = name + "/" + ch;
  if (REF_CACHE[key]) return REF_CACHE[key];
  var c = document.createElement("canvas");
  c.width = 96; c.height = 132;
  var x = c.getContext("2d");
  x.clearRect(0, 0, 96, 132);
  x.font = "600 58px " + name;
  x.textAlign = "center"; x.textBaseline = "middle";
  x.fillStyle = "#000";
  x.fillText(ch, 48, 68);
  var d = x.getImageData(0, 0, 96, 132).data;
  var a = [];
  for (var i = 0; i < 96 * 132; i++) a.push(d[i * 4 + 3]);
  var minX = 96, minY = 132, maxX = 0, maxY = 0, found = false;
  for (var y = 0; y < 132; y++) for (var xx = 0; xx < 96; xx++) {
    if (a[y * 96 + xx] > 100) {
      found = true;
      if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!found) { REF_CACHE[key] = null; return null; }
  var bits = [];
  for (var r = 0; r < CH; r++) {
    var y0c = minY + Math.floor((maxY - minY + 1) * r / CH);
    var y1c = minY + Math.floor((maxY - minY + 1) * (r + 1) / CH) - 1;
    for (var c2 = 0; c2 < CW; c2++) {
      var x0c = minX + Math.floor((maxX - minX + 1) * c2 / CW);
      var x1c = minX + Math.floor((maxX - minX + 1) * (c2 + 1) / CW) - 1;
      var tot = 0, cnt = 0;
      for (var y = y0c; y <= y1c; y++) for (var xx = x0c; xx <= x1c; xx++) { tot++; if (a[y * 96 + xx] > 100) cnt++; }
      bits.push(tot > 0 && cnt / tot >= 0.35 ? 1 : 0);
    }
  }
  REF_CACHE[key] = bits;
  return bits;
}

function classify(bits) {
  // 각 글꼴이 가장 자신 있는 숫자를 고르고, 점수를 숫자별로 합산한다.
  var totals = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (var f = 0; f < FONT_VOTERS.length; f++) {
    var name = FONT_VOTERS[f];
    var best = -1, bv = -1;
    for (var d5 = 0; d5 <= 9; d5++) {
      var rb = refBits(name, String(d5));
      if (!rb) continue;
      var v2 = compareBits(bits, rb);
      if (v2 > bv) { bv = v2; best = d5; }
    }
    if (best >= 0) totals[best] += bv;
  }
  var win = 0;
  for (var d6 = 1; d6 <= 9; d6++) if (totals[d6] > totals[win]) win = d6;
  var sorted = totals.slice().sort(function (a, b) { return b - a; });
  return { digit: String(win), score: sorted[0], next: sorted[1] };
}

// 키마다 보여 주는 조각의 자리를 계산한다. background-position 이 스프라이트의
// 어느 조각을 보여 주는지, span 의 크기와 함께 읽는다. background-size 가 px 로
// 따로 있으면(스프라이트를 늘려 쓰는 자판) 그 배율로 되돌린다.
var table2 = [];
var debug2 = [];
spriteSpans.forEach(function (span) {
  var btn = resolve(span);
  if (!btn) return;
  var cs = getComputedStyle(span);
  var mPos = cs.backgroundPosition.split(/\\s+/);
  var px0 = parseFloat(mPos[0]), py0 = parseFloat(mPos[1]);
  var sw = span.offsetWidth || 0, sh = span.offsetHeight || 0;
  var sx = -px0, sy = -py0, fw = sw, fh = sh;
  if (isNaN(px0) || isNaN(py0) || !sw || !sh) {
    debug2.push("pos=" + cs.backgroundPosition + " size=" + cs.backgroundSize);
    return;
  }
  var mSize = cs.backgroundSize.split(/\\s+/);
  var sxw = parseFloat(mSize[0]), syh = parseFloat(mSize[1]);
  if (!isNaN(sxw) && !isNaN(syh) && sxw > 0 && syh > 0) {
    sx = -px0 * (W / sxw); fw = sw * (W / sxw);
    sy = -py0 * (H / syh); fh = sh * (H / syh);
  }
  var bits = fingerprint(sx, sy, fw, fh);
  if (!bits) return;
  var m = classify(bits);
  // 키의 화면 좌표도 함께 돌려준다 — 잡아 둔 참조가 갈린 화면 때문에 죽으면
  // 좌표로 눌러야 하니까.
  var r = btn.getBoundingClientRect();
  table2.push([m.digit, btn, Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);
  debug2.push(m.digit + "@" + Math.round(sx) + "," + Math.round(sy) + ":" +
    m.score.toFixed(2) + "/" + m.next.toFixed(2));
});

// 0-9 가 한 자씩 다 있어야 자판이다. 겹치거나 빠졌으면 자리를 잘못 읽은 것이다.
if (table2.length !== 10) return ["odd", table2, null, "keys=" + table2.length + " " + debug2.join(" ")];
var seenD = {};
table2.forEach(function (e) { seenD[e[0]] = true; });
for (var d7 = 0; d7 < 10; d7++) {
  if (!seenD[String(d7)]) return ["odd", table2, null, "missing " + d7 + " " + debug2.join(" ")];
}

return ["found", table2, findConfirm(spriteBowl), debug2.join(" ")];
`;

// 비밀번호가 틀렸을 때 자판 화면이 내미는 말. 알아서 재시도하게 두면 결제가 잠길 수
// 있으므로, 이게 보이면 물러나 사람에게 맡긴다. "5회 잘못·재설정" 은 자판이 잠긴
// 것이다 — 무엇을 눌러도 안 받으니, 시작하자마자 보고 멈춰야 한다 (2026-08-25 에
// 시험하다 계정이 실제로 잠겼다).
const PIN_ERROR_JS = `
return /비밀번호가 일치하지|비밀번호가 올바르지|비밀번호를 다시|비밀번호가 틀렸|간편비밀번호가 일치|5회 잘못|재설정하세요/.test(document.body.innerText || "");
`;

// 자판 후보(숫자 글자 하나짜리 요소)가 왜 안 보이는지 보여 주는 판. 받아적기에
// 적어 두고, 이걸 보고 KEYPAD_JS 를 고친다.
const KEYPAD_PROBE_JS = `
var hits = [];
Array.prototype.slice.call(document.querySelectorAll(
  'button, a, [role="button"], input, span, div, li, td, label'
)).forEach(function (el) {
  var t = (el.textContent || "").replace(/\\s+/g, "").trim();
  if (!/^[0-9]$/.test(t)) return;
  var r = el.getBoundingClientRect();
  var s = window.getComputedStyle(el);
  hits.push(el.tagName + "." + String(el.className || "").slice(0, 50) +
    ' "' + t + '" ' + Math.round(r.width) + "x" + Math.round(r.height) +
    " disp=" + s.display + " vis=" + s.visibility + " op=" + s.opacity);
});
return "숫자 글자 하나짜리 " + hits.length + "개\\n  " + hits.slice(0, 30).join("\\n  ");
`;

// 비밀번호 점 자리가 어떻게 생겼는지 받아 적는 판. 채워진 점 확인이 왜 안 되는지
// 볼 때 쓴다 — 점이 어떤 클래스로 그려지고, 무엇이 "채워짐" 으로 읽히는지 보인다.
const DOTS_PROBE_JS = `
var out = [];
Array.prototype.slice.call(document.querySelectorAll('span, div, i, b, li, label, td')).forEach(function (el) {
  var cls = String(el.className || "");
  if (!/(^|[\\s_-])(dot|pwd|pass|pin|circle|num)([\\s_-]|$)/i.test(cls) &&
      cls.indexOf("apiPassword") === -1) return;
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  if (r.width > 80 || r.height > 80) return;
  var filled = /(^|[\\s_-])(on|fill|active|sel|check|focus|cur|dark|true)([\\s_-]|$)/i.test(cls);
  out.push(el.tagName + "." + cls.slice(0, 70) + " " + Math.round(r.width) + "x" + Math.round(r.height) +
    (filled ? " 채워짐" : ""));
});
return out.slice(0, 40).join("\\n") || "(점 자리로 보이는 것 없음)";
`;

/**
 * 채워진 비밀번호 점 개수. [개수, 점 자리가 있는가] 로 돌려준다.
 *
 * **롯데온 자판의 점은 받아 적은 화면(2026-08-25)에서 이 꼴이었다:**
 *
 *   <div class="apiPassword"><span class="on">*</span><span class="on">*</span><span>*</span>…</div>
 *
 * 채워진 것은 class "on" 이 붙는다. 이것이 가장 정확한 신호라 제일 먼저 본다.
 *
 * 여기서 크게 데었다 — 처음엔 페이지 전체에서 "점다운 이름" 과 채워진 칸을 찾게
 * 했는데, 그게 **포인트 사용 입력칸(`input[tel] "0"`)** 을 "점 1개" 로 읽어 버렸다.
 * 그래서 첫 입력이 거짓 성공하고, 두 번째부터는 "점이 안 늘었다" 고 헛돌면서 같은
 * 자리를 계속 눌러 잘못된 비밀번호가 쌓였다. 비밀번호 칸은 자판 그릇 안에서만 본다.
 */
const PROGRESS_JS = `
var lpFilled = document.querySelectorAll('.apiPassword span.on, [class*="apiPassword"] span.on').length;
if (lpFilled) return [lpFilled, 1];
var lpSeats = document.querySelectorAll('.apiPassword span, [class*="apiPassword"] span').length;
if (lpSeats) return [0, 1];

function visible(el) {
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
}
// 흔한 점 이름(dot·pwd·pass·circle)으로 물러선다.
var filled = 0, seats = 0;
Array.prototype.slice.call(document.querySelectorAll('span, div, i, b, li, label, td')).forEach(function (el) {
  if (!visible(el)) return;
  var r = el.getBoundingClientRect();
  if (r.width > 80 || r.height > 80) return;
  var cls = String(el.className || "");
  if (!/(^|[\\s_-])(dot|pwd|pass|pin|circle|num)([\\s_-]|$)/i.test(cls)) return;
  seats++;
  if (/(^|[\\s_-])(on|fill|active|sel|check|focus|cur|dark|true)([\\s_-]|$)/i.test(cls)) filled++;
});
if (filled) return [filled, 1];
// 비밀번호 칸은 **자판 그릇 안에서만** 본다 — 페이지의 포인트 입력칸("0")이 점으로
// 읽히는 것을 막는다 (2026-08-25 에 실제로 그랬다).
var keyBox = document.querySelector('.btnSection, .ownKeypadWrap, [class*="keypad"], [class*="Keypad"]');
var scope = keyBox || document;
var inputs = scope.querySelectorAll('input[type="password"], input[type="tel"], input[type="number"], input[type="text"]');
for (var i = 0; i < inputs.length; i++) {
  var v = (inputs[i].value || "").replace(/\\D/g, "");
  if (v) return [v.length, 1];
}
// 점 자리도 칸도 없으면 이 프레임에는 아무것도 없다는 뜻이다 — null 을 돌려줘
// 부른 쪽이 다음 프레임도 뒤지게 한다. (자리가 있는데 안 찬 것은 [0, 1] 로 다르다.)
return seats ? [0, 1] : null;
`;

/** 새 창이 떴으면 그리로 옮긴다. **기다리지 않는다.** → 옮겼으면 true */
async function hopWindow(chromeBox: Chrome): Promise<boolean> {
  const driver = chromeBox.driver;
  try {
    const handles = await driver.getAllWindowHandles();
    const main = chromeBox.mainWindow;
    const others = handles.filter((h) => h !== main);
    if (!others.length) return false;
    const target = others[others.length - 1]!;
    if ((await driver.getWindowHandle()) === target) return false;
    await driver.switchTo().window(target);
    return true;
  } catch {
    return false;
  }
}

/** 결제창 쪽(롯데온이 아닌 프레임)을 먼저 뒤지게 줄을 세운다. */
async function foreignFirst(driver: WebDriver, paths: number[][]): Promise<number[][]> {
  const scored: [number[], boolean][] = [];
  for (const path of paths) {
    let foreign = false;
    try {
      if ((await descend(driver, path)) !== null) {
        const here = await driver.executeScript<string>("return location.href");
        foreign = !here.includes(HOST_MARK);
      }
    } catch {
      foreign = false;
    }
    scored.push([path, foreign]);
  }
  return scored.sort((a, b) => Number(b[1]) - Number(a[1])).map(([path]) => path);
}

/**
 * 기본 문서와 iframe 을 차례로 뒤진다. attempt 가 참을 주면 거기서 멈춘다.
 * 결제창은 내용을 iframe 에 넣어 두는 일이 흔하다. 어느 층에 있는지는 모르니 다 본다.
 */
async function tryFrames<T>(
  driver: WebDriver, attempt: () => Promise<T>, opts: { depth?: number; foreign?: boolean } = {},
): Promise<T | null> {
  let paths = await framePaths(driver, opts.depth ?? 2);
  if (opts.foreign) paths = await foreignFirst(driver, paths);

  for (const path of paths) {
    try {
      if ((await descend(driver, path)) === null) continue;
      const got = await attempt();
      // 성공한 프레임에 그대로 서 있는다. 부른 쪽이 이어서 확인할 것이 있다.
      if (got) return got;
    } catch {
      continue;
    }
  }
  await driver.switchTo().defaultContent().catch(() => undefined);
  return null;
}

/** 참조로 누른다. → {ok, msg} — 실패했으면 이유까지. 디버그를 켜지 않아도 로그에 남긴다. */
async function pressResult(
  driver: WebDriver, element: WebElement,
): Promise<{ ok: boolean; msg: string }> {
  try {
    await driver.executeScript(
      "arguments[0].scrollIntoView({block: 'center', inline: 'center'})", element);
  } catch (e) {
    return { ok: false, msg: `scrollIntoView 실패: ${(e as Error).message}` };
  }
  try {
    await element.click();
    return { ok: true, msg: "" };
  } catch (e) {
    const first = String((e as Error).message).trim().split("\n")[0] ?? "";
    try {
      await driver.executeScript("arguments[0].click()", element);
      return { ok: true, msg: "" };
    } catch (e2) {
      return { ok: false, msg: `${first} / js클릭도 실패: ${(e2 as Error).message}` };
    }
  }
}

/**
 * 창을 키운다. 자판 모달은 화면 가운데 고정이라, 창이 작으면 아래 줄 키('0'·'확인')가
 * 화면 밖으로 잘려 **눌러도 안 먹는다** — 2026-08-25 에 '0' 이 그랬다. 참조 클릭이
 * "눌렸다" 만 하고 자리가 안 차는 판이 바로 이것이다. 화면을 넘기지 않게 키운다.
 */
async function widenWindow(driver: WebDriver): Promise<void> {
  try {
    const [availW, availH] = await driver.executeScript<[number, number]>(
      "return [window.screen.availWidth, window.screen.availHeight]");
    await driver.manage().window().setRect({
      width: Math.min(1280, availW || 1280),
      height: Math.min(900, availH || 900),
    });
  } catch {
    // 못 키워도 눌러 보는 것은 한다.
  }
}

/** 화면 좌표로 누른다. → 눌렀으면 true. 잡아 둔 키 참조가 죽었을 때 쓰는 대체 길이다. */
async function clickAt(driver: WebDriver, x: number, y: number): Promise<boolean> {
  try {
    await driver.actions({ async: true }).move({ x, y, duration: 0 }).click().perform();
    return true;
  } catch (e) {
    log.debug(`좌표 클릭이 안 됩니다 (${(e as Error).message})`);
    return false;
  }
}

// 누르려는 키가 왜 안 눌리는지 한 번에 보여 주는 판.
const PRESS_PROBE_JS = `
var el = arguments[0];
var r = el.getBoundingClientRect();
var s = window.getComputedStyle(el);
var top = null;
try {
  top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
} catch (e) {}
var topDesc = top ? top.tagName + "." + String(top.className || "").slice(0, 40) +
  ' "' + (top.textContent || "").trim().slice(0, 16) + '"' : "none";
return "rect=(" + Math.round(r.left) + "," + Math.round(r.top) + "," +
  Math.round(r.width) + "x" + Math.round(r.height) + ") display=" + s.display +
  " visibility=" + s.visibility + " pointer=" + s.pointerEvents +
  " disabled=" + el.disabled + " top=" + topDesc;
`;

/** 결제창에서 할 일을 사람이 읽을 이름으로. 이건 자판 입력 자리다. */
export const PIN_LABEL = "간편결제 비밀번호";

/** 채워진 점 개수가 기대값이 될 때까지 기다린다. → [됐나, 점 자리가 있었나] */
async function waitProgress(
  chromeBox: Chrome, expect: number, timeoutMs = 1500,
): Promise<[boolean, boolean]> {
  const driver = chromeBox.driver;
  const deadline = Date.now() + timeoutMs;
  let sawSignal = false;
  while (Date.now() < deadline) {
    try {
      const got = await tryFrames<number[] | null>(
        driver, () => driver.executeScript(PROGRESS_JS), { foreign: true });
      if (!got) continue;
      if (Number(got[1]) === 1) sawSignal = true;
      if (Number(got[0]) === expect) return [true, true];
    } catch {
      // 창이 갈렸다. 다음 바퀴에 다시 본다.
    }
    await sleep(150);
  }
  return [false, sawSignal];
}

/** 점 상태를 한 번만 읽는다. → [채워진 개수, 자리가 있는가] */
async function progressNow(driver: WebDriver): Promise<[number, boolean]> {
  const got = await tryFrames<number[] | null>(
    driver, () => driver.executeScript(PROGRESS_JS), { foreign: true });
  if (!got) return [0, false];
  return [Number(got[0]), Number(got[1]) === 1];
}

/**
 * 누르다 실패한 자판의 모습을 받아 적는다 — 점 자리, 지금 점 개수, 화면, 모달 HTML.
 * 무엇이 왜 안 먹는지 고치는 재료다. 한 자리에서 한 번만 부른다.
 */
async function diagnoseKeypad(driver: WebDriver): Promise<void> {
  const dots = await driver.executeScript<string>(DOTS_PROBE_JS).catch(() => "(판독 실패)");
  log.warn(`점 자리: ${dots}`);
  const [filled, hasSignal] = await progressNow(driver);
  log.warn(`점 개수(지금): 채워진 ${filled} · 자리 ${hasSignal ? "있음" : "없음"}`);
  try {
    const b64 = await driver.takeScreenshot();
    const path = join(BASE, "lotteon-test-keypad-shot.png");
    writeFileSync(path, Buffer.from(b64, "base64"));
    log.warn(`자판 화면을 남겼습니다: ${basename(path)}`);
  } catch (e) {
    log.warn(`자판 화면을 찍지 못했습니다 — ${(e as Error).message}`);
  }
  try {
    const html = await driver.executeScript<string>(`
var el = document.querySelector('.btnCustom, [class*="btnCustom"]');
var box = el ? (el.closest('[class*="pop"],[class*="layer"],[class*="modal"],[class*="Pop"],[class*="Layer"],[class*="Modal"]') || el.parentElement) : null;
return (box ? box.outerHTML : (document.body ? document.body.outerHTML : "")).slice(0, 60000);
`);
    const path = join(BASE, "lotteon-test-keypad-html.txt");
    writeFileSync(path, scrub(html || ""), "utf-8");
    log.warn(`모달 HTML 을 남겼습니다: ${basename(path)}`);
  } catch (e) {
    log.warn(`모달 HTML 을 남기지 못했습니다 — ${(e as Error).message}`);
  }
}

/**
 * 간편결제 비밀번호 자판을 읽어 차례로 누른다. → "ok" / "quiet" / "none"
 *
 * 자판은 **매 결제마다 숫자 위치가 바뀐다.** 그래서 어디에 어떤 숫자가 있는지 화면에서
 * 읽은 표로만 누를 수 있다 — 고정된 좌표나 셀렉터로는 두 번째 결제부터 틀린다.
 *
 * **누를 자리마다 자판을 다시 읽고, 누를 때마다 점 개수로 확인한다.** 자판은 누를
 * 때마다 숫자 위치가 바뀔 수 있어서, 처음에 읽은 표를 끝까지 쓰면 갈린 화면의 키를
 * 누르는 꼴이 된다 — 네이버페이 판에서 실제로 마지막 자리만 무시된 적이 있다.
 * 눌렀는데 점이 안 늘었거나(자리가 갈렸거나), 잡아 둔 키 참조가 죽었으면 자판을
 * 다시 읽고 **그 자리를 화면 좌표로도 눌러 본다.**
 *
 * **비밀번호 값은 어디에도 적지 않는다.** 로그에는 자릿수만 남는다. 틀린 비밀번호는
 * 알아서 재시도하지 않는다 — 몇 번을 틀리면 결제가 잠기니까, 사람이 보게 남기고 물러난다.
 */
export async function enterPin(
  chromeBox: Chrome, pin: string, timeout: number,
): Promise<Pressed> {
  const driver = chromeBox.driver;
  const digits = (pin || "").replace(/\D/g, "");
  if (!digits) {
    log.warn("간편결제 비밀번호가 비어 있습니다. 건너뜁니다.");
    return "none";
  }
  if (digits.length !== 6) {
    log.warn(`간편결제 비밀번호가 ${digits.length}자리입니다. 롯데온은 보통 6자리입니다.`);
  }

  // 자판이 화면 밖으로 잘리면 아래 줄 키를 눌러도 안 먹는다. 창부터 키운다.
  await widenWindow(driver);

  // 자판이 이미 잠겼는지 먼저 본다 — "5회 잘못 입력" 이면 무엇을 눌러도 안 받는다
  // (2026-08-25 에 시험하다 계정이 실제로 잠겼다). 재시도로 횟수만 태우지 않게
  // 시작하자마자 물러난다.
  const locked = await tryFrames<boolean>(
    driver, () => driver.executeScript(PIN_ERROR_JS), { foreign: true });
  if (locked) {
    log.warn("결제비밀번호가 잠겼습니다 (5회 잘못 입력) — 비밀번호를 재설정한 뒤 다시 시도해 주세요.");
    return "quiet";
  }

  // 처음 점 상태를 적어 둔다 — 시작부터 점이 차 있으면(장식 따위) 확인이 거짓일
  // 수 있다. 자판이 아직 없으면 0 으로 나온다.
  const [startDots] = await progressNow(driver);
  if (startDots > 0) {
    log.warn(`처음부터 점 ${startDots}개가 채워져 있습니다 — 점 확인이 거짓일 수 있습니다.`);
  }

  // 한 키를 누르는 한 번의 시도. 참조로 누르고, 안 되면(자리가 갈려 참조가 죽었다)
  // 자판을 다시 읽어 새 참조로, 그것도 안 되면 **새로 읽은 좌표**로 누른다.
  // 좌표는 읽은 직후의 것이어야 한다 — 오래된 좌표는 갈린 화면의 다른 숫자를 가리킨다.
  const pressOnce = async (entry: [string, WebElement, number, number]): Promise<string | null> => {
    const [digit, element] = entry;
    const r1 = await pressResult(driver, element);
    if (r1.ok) return null;
    log.warn(`'${digit}' 키를 참조로 못 눌렀습니다 — ${r1.msg}`);
    await sleep(250);
    const again = await tryFrames<KeypadHit | null>(
      driver, () => driver.executeScript(KEYPAD_JS), { foreign: true });
    if (!again || again[0] !== "found") return "자판을 다시 읽지 못했습니다";
    log.info(`자판(다시 읽음): ${again[3] || ""}`);
    const fresh = new Map<string, [string, WebElement, number, number]>();
    for (const e of again[1] ?? []) fresh.set(e[0], e);
    const e2 = fresh.get(digit);
    if (!e2) return "다시 읽은 자판에 그 숫자가 없습니다";
    const r2 = await pressResult(driver, e2[1]);
    if (r2.ok) return null;
    log.warn(`'${digit}' 키를 다시 읽은 참조로도 못 눌렀습니다 — ${r2.msg}`);
    if (e2[2] > 0 && e2[3] > 0) {
      const probe = await driver.executeScript<string>(PRESS_PROBE_JS, e2[1])
        .catch(() => "(판독 실패)");
      log.warn(`'${digit}' 키 상태: ${probe}`);
      log.warn(`'${digit}' 키를 좌표(${e2[2]},${e2[3]})로 눌러 봅니다.`);
      if (await clickAt(driver, e2[2], e2[3])) return null;
      return `좌표(${e2[2]},${e2[3]}) 클릭도 실패`;
    }
    return `좌표 없음 — ${r2.msg}`;
  };

  // **좌표로 눌러 본다** (진짜 입력). 참조 클릭이 "눌렸다" 만 하고 자리가 안 먹는
  // 판이 있어서(화면 밖으로 잘린 키 — 2026-08-25 의 '0'), 점이 안 늘면 다음 시도는
  // 이걸로 바꾼다. 위치만 맞으면 실제 입력이라 자판이 받는다.
  const pressAt = async (entry: [string, WebElement, number, number]): Promise<string | null> => {
    const [digit, element, x, y] = entry;
    if (x > 0 && y > 0) {
      if (await clickAt(driver, x, y)) return null;
      log.warn(`'${digit}' 키 좌표(${x},${y}) 클릭이 안 됩니다. 참조로 다시 누릅니다.`);
    }
    const r = await pressResult(driver, element);
    return r.ok ? null : r.msg;
  };

  const deadline = Date.now() + timeout * 1000;
  let typed = 0;
  let failed = false;
  let sawKeypad = false;  // 자판을 한 번이라도 읽었는가 (못 읽고 시간만 보낸 것과 가른다)
  let noSignal = false;  // 점도 칸도 없어 눌림만 믿고 가야 하는 판
  let keypadSeen = "";  // 마지막으로 적은 자판 배치
  while (Date.now() < deadline && typed < digits.length && !failed) {
    const ch = digits[typed]!;

    // **이 자리를 누른다 — 점이 실제로 하나 늘 때까지 되풀이한다.** 자판이 아직
    // 준비 안 됐거나(누르자마자는 핸들러가 안 붙어 있을 수 있다) 갈린 화면을
    // 눌렀을 수 있으니, 자판을 다시 읽고 몇 번이고 시도한다. 시간은 전체 예산
    // (timeout)이 한도를 짠다.
    let done = false;
    let dotFails = 0;  // 이 자리에서 점이 안 늘어난 횟수 — 좌표로 바꿔 누르는 기준
    while (Date.now() < deadline && !done) {
      // 자판은 결제창이 새 창으로 떴을 수도 있다. 누를 것을 찾을 때와 같은 이유다.
      if (await hopWindow(chromeBox)) {
        log.debug("자판을 찾아 새 창으로 옮겼습니다.");
        await widenWindow(driver);
      }

      const got = await tryFrames<KeypadHit | null>(
        driver, () => driver.executeScript(KEYPAD_JS), { foreign: true });
      if (!got) {
        await sleep(400);
        continue;
      }
      sawKeypad = true;
      const [status, table, , info] = got;
      if (status !== "found") {
        log.warn(`자판을 읽었는데 숫자가 어긋납니다 (${info || "?"}). 화면을 확인해 주세요.`);
        return "none";
      }
      // 배치가 바뀔 때만 적는다. 2026-09-23 에는 여섯 자리 내내 같은 배치를 여섯 줄로
      // 적었다 — 롯데온 자판은 누를 때마다 섞지 않는다. 섞이는 날이 오면 그때 줄이 늘어난다.
      if (info !== keypadSeen) {
        log.info(`자판(${typed + 1}번째 자리): ${info || ""}`);
        keypadSeen = info ?? "";
      } else {
        log.debug(`자판(${typed + 1}번째 자리): 배치 그대로`);
      }

      const byDigit = new Map<string, [string, WebElement, number, number]>();
      for (const entry of table ?? []) byDigit.set(entry[0], entry);
      const entry = byDigit.get(ch);
      if (!entry) {
        log.warn(`자판에 없는 숫자가 있습니다: ${ch}. 화면을 확인해 주세요.`);
        return "none";
      }

      const why = dotFails >= 1 ? await pressAt(entry) : await pressOnce(entry);
      if (why) log.warn(`'${ch}' 키를 누르지 못했습니다 — ${why}`);

      // 누른 자리가 정말 먹혔는지 점(또는 비밀번호 칸)으로 확인한다. 점 자리가
      // 아예 없으면(자동 진행이라든가) 눌림만 믿고 넘어간다.
      const [ok, hasSignal] = await waitProgress(chromeBox, typed + 1);
      if (ok) {
        done = true;
        // 자리가 갈리는 자판은 다음 읽기 전에 잠깐 쉰다 — 읽자마자 다시 읽으면
        // 아직 갈리기 전 화면일 수 있다.
        await sleep(300);
      } else if (!hasSignal) {
        if (!noSignal) {
          log.warn("점 자리(비밀번호 입력 표시)를 못 찾았습니다 — 눌림만 확인하고 넘어갑니다.");
          noSignal = true;
        }
        done = true;
      } else {
        dotFails += 1;
        log.warn(`'${ch}' 를 눌렀는데 점이 안 늘었습니다. 다시 시도합니다.`);
        if (dotFails === 1) {
          // 눌린 키가 왜 안 먹는지 한 번은 받아 적는다 — 키 상태, 점 자리, 화면, 모달 HTML.
          const probe = await driver.executeScript<string>(PRESS_PROBE_JS, entry[1])
            .catch(() => "(판독 실패)");
          log.warn(`'${ch}' 키 상태: ${probe}`);
          await diagnoseKeypad(driver);
        }
        await sleep(400);
      }
    }
    if (!done) {
      failed = true;
      break;
    }
    typed += 1;
  }

  if (failed) {
    // 자판을 한 번도 못 읽은 것과, 읽고 누르다 막힌 것은 다르게 말한다.
    if (!sawKeypad) {
      log.warn("간편결제 비밀번호 자판을 찾지 못했습니다. 화면을 확인해 주세요.");
      return "none";
    }
    log.warn(`자판 키를 누르지 못했습니다 — ${typed}/${digits.length}자리. 화면을 확인해 주세요.`);
    return "quiet";
  }
  if (typed < digits.length) {
    log.warn("간편결제 비밀번호 자판을 찾지 못했습니다. 화면을 확인해 주세요.");
    return "none";
  }
  log.info(`간편결제 비밀번호를 입력했습니다 (${digits.length}자리)`);

  // 다 눌렀는데 자판이 그대로면 확인 키가 따로 있는 화면이다. 있으면 눌러 준다.
  // 틀린 비밀번호는 여섯 번째 자리에서 이미 말해 줄 수 있으니, 확인을 누르기 전에 본다.
  await sleep(700);
  const wrongNow = await tryFrames<boolean>(
    driver, () => driver.executeScript(PIN_ERROR_JS), { foreign: true });
  if (wrongNow) {
    log.warn("간편결제 비밀번호가 틀린 것 같습니다 — 화면을 확인해 주세요.");
    return "quiet";
  }

  const still = await tryFrames<KeypadHit | null>(
    driver, () => driver.executeScript(KEYPAD_JS), { foreign: true });
  if (still && still[0] === "found" && still[2]) {
    log.debug("자판의 확인 키를 눌렀습니다.");
    await press(driver, still[2]);
    await sleep(800);
    // 확인을 눌러서야 틀린 게 드러나는 화면이 있다.
    const wrongAfter = await tryFrames<boolean>(
      driver, () => driver.executeScript(PIN_ERROR_JS), { foreign: true });
    if (wrongAfter) {
      log.warn("간편결제 비밀번호가 틀린 것 같습니다 — 화면을 확인해 주세요.");
      return "quiet";
    }
  }

  // 확인 키도 없는데 자판이 그대로면(자동 진행도, 확인 키도 없는 화면) 어긋난 것이다.
  // "found" 만 자판이 남아 있다는 뜻이다 — 흩어진 숫자 글자("odd")는 아니다.
  const left = await tryFrames<KeypadHit | null>(
    driver, () => driver.executeScript(KEYPAD_JS), { foreign: true });
  if (left && left[0] === "found") {
    log.warn("비밀번호를 눌렀는데 자판이 그대로입니다. 화면을 확인해 주세요.");
    return "quiet";
  }
  return "ok";
}

/**
 * 결제창이 떴다. pg_password 를 적어 뒀으면 비밀번호 자판을 읽어 눌러 준다. → 사유 (없으면 null)
 *
 * 자판이 없는 결제창(카드 인증 따위)에서는 아무것도 안 하고 조용히 지나간다. 못
 * 눌렀어도 창은 떠 있으므로 사람이 직접 누르면 된다 — 실패를 구매 실패로 만들지 않는다.
 */
async function pinTail(box: Chrome, pin: string, timeout: number): Promise<string | null> {
  const digits = (pin || "").replace(/\D/g, "");
  if (!digits) return null;

  log.info("결제창이 떴습니다 — 간편결제 비밀번호 자판을 찾아 누릅니다.");
  const result = await enterPin(box, digits, Math.min(timeout, 15));
  if (result === "ok") {
    log.info("간편결제 비밀번호까지 입력했습니다.");
    return null;
  }
  if (result === "quiet") {
    return "간편결제 비밀번호 자판을 눌렀지만 끝내지 못했습니다 — 화면을 봐주세요";
  }
  return "간편결제 비밀번호 자판을 찾지 못했습니다 — 화면을 봐주세요";
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

  // 창을 옮기기 전에 읽는다. 받아적기 훅은 처음 연 탭(상품 → 주문서)에 걸려 있다.
  const trail = await readTrail(box);
  if (trail.length) {
    lines.push("\n[사이트가 한 말·거쳐 간 길]");
    for (const one of trail) {
      lines.push(`  ${new Date(one.t).toISOString().slice(11, 23)}  ${one.k.padEnd(7)} ${one.u}` +
        (one.k === "page" ? "" : `  '${one.m}'`));
    }
  }

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

  // 자판 읽기가 왜 안 되는지 한 번에 보여 주는 판. KEYPAD_JS 가 무슨 답을 주는지
  // 프레임마다 적는다 — "found" 면 키 표가 섰고, "odd" 면 무엇이 어긋났는지,
  // null 이면 자판으로 안 보이는 것이다. 못 본 화면의 첫 판이 이걸로 고친다.
  lines.push("\n[자판 읽기]");
  for (const frame of await framePaths(driver, 2)) {
    const at = frame.length ? JSON.stringify(frame) : "top";
    try {
      if ((await descend(driver, frame)) === null) continue;
      const got = await driver.executeScript<KeypadHit | null>(KEYPAD_JS);
      if (!got) {
        lines.push(`  [frame ${at}] 없음 — 자판으로 안 보입니다`);
        // 왜 안 보이는지: 숫자 글자 하나짜리 요소가 몇 개나 있고, 보이는가.
        const probe = await driver.executeScript<string>(KEYPAD_PROBE_JS).catch(() => "(판독 실패)");
        lines.push(`  [frame ${at}] ${probe}`);
      } else {
        const [status, table, confirm, info] = got;
        lines.push(`  [frame ${at}] ${status} — 키 ${table?.length ?? 0}개 · ` +
          `확인 ${confirm ? "있음" : "없음"} · ${info || ""}`);
      }
      // 우리 집(주문서)이면 HTML 도 남긴다 — 자판은 주문서 위 레이어라, 누르다
      // 실패한 판의 모달 구조(점·키 배치)가 여기 있다. 사람 정보는 가린다.
      const where = await driver.executeScript<string>("return location.href").catch(() => "");
      if (where.includes(HOST_MARK)) {
        const body = await driver.executeScript<string>("return document.body.outerHTML").catch(() => "");
        if (body) html.push(`\n\n===== [frame ${at}] ${where} =====\n${body.slice(0, 200000)}`);
      }
    } catch (e) {
      lines.push(`  [frame ${at}] 읽지 못함: ${(e as Error).message}`);
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
  payMethod: string[] = [], payMark = "", payCard = "", pin = "",
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
  if (note === PG_OPENED || note === PG_UNSEEN) {
    // 결제창이 떴다. pg_password 를 적어 뒀으면 자판을 읽어 눌러 준다 — 못 누르면
    // 사유를 남기고 창은 그대로 둔다(사람이 누르면 된다).
    const pinNote = await pinTail(box, pin, timeout);
    if (note === PG_OPENED) return ["submitted", pinNote];
    // 새 창/iframe 신호를 못 봤어도 자판까지 눌렀으면 결제창이 열린 것이 확실하다 —
    // 롯데온의 자판은 주문서 위 레이어로 떠서, 결제창 신호는 어느 쪽도 안 온다.
    return ["submitted", pinNote ? `${PG_UNSEEN} — ${pinNote}` : null];
  }
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
    // 상품 페이지를 받기 **전에** 건다. 새 문서부터 먹는다.
    await installTrail(box);

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
  } catch (e) {
    // **사이트 alert 가 떠 있어도 여기로 온다.** 창은 멀쩡한데 "사라졌다" 로 읽어서,
    // 주문서에서 품절 알림을 받고 장바구니로 밀려난 판을 창이 닫힌 것으로 적었다
    // (2026-09-23 가짜 드랍 페이지로 재현). 셀레니움이 그 alert 를 닫으며 던지는 오류다.
    return (e as Error).name !== "UnexpectedAlertOpenError";
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
  opts: { option?: string; ea?: number; headless?: boolean; timeout?: number; queueWait?: number } = {},
): Promise<Bought> {
  const [box, reason] = await openPage(url, cookie, {
    headless: opts.headless, timeout: opts.timeout,
  });
  if (reason) return { chrome: box, ok: false, reason };

  try {
    const [ok, why] = await buyHere(box, {
      option: opts.option, ea: opts.ea, timeout: opts.timeout, queueWait: opts.queueWait,
    });
    return { chrome: box, ok, reason: why };
  } catch (e) {
    // 창은 남긴다. 무엇이 떠 있는지 사람이 봐야 판단이 된다.
    return { chrome: box, ok: false, reason: `구매하기를 누르는 중 오류: ${(e as Error).message}` };
  }
}

/**
 * **이미 떠 있는 창**에서 산다 — 미리 띄워 둔 창(warm.ts)이나, 한 번 실패한 창으로 다시 할 때.
 * → 산 결과 / null (창을 못 쓴다 — 부른 쪽이 새 크롬을 띄운다)
 *
 * 새 크롬을 띄우지 않는 이유는 대기열 순번이 그 창의 쿠키에 붙어 있어서다 (tracer.ts).
 * 화면에 구매 버튼이 벌써 있거나 대기 화면이면 새로 고치지 않는다 — 새로 고치면 또 줄이 설 수
 * 있다. 그 밖이면(열리기 전에 받은 "판매중 아님" 페이지·주문서에서 밀려난 자리) 그 창에서
 * 상품 페이지를 다시 받는다.
 */
export async function buyIn(
  box: Chrome, url: string,
  opts: { option?: string; ea?: number; timeout?: number; queueWait?: number } = {},
): Promise<Bought | null> {
  if (await windowGone(box)) return null;
  try {
    let now: Scan = null;
    try {
      now = await box.driver.executeScript<Scan>(BUY_BUTTON_SCAN_JS, BUY_TEXTS, STOP_TEXTS);
    } catch {
      now = null;  // alert 따위. 다시 받으면 치워진다.
    }
    if (now?.[0] !== "go" && now?.[0] !== "queue") {
      const reason = await reopen(box, url, opts.timeout ?? 20);
      if (reason === SESSION_DEAD) return { chrome: box, ok: false, reason };
      if (reason) {
        log.warn(`띄워 둔 창을 못 씁니다 — ${reason}`);
        return null;
      }
    }
    const [ok, why] = await buyHere(box, opts);
    return { chrome: box, ok, reason: why };
  } catch (e) {
    return { chrome: box, ok: false, reason: `구매하기를 누르는 중 오류: ${(e as Error).message}` };
  }
}
