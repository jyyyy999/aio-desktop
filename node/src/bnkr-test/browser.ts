/**
 * 주문서를 크롬으로 열어 준다. bnkr_browser.py 를 그대로 옮긴 것이다.
 *
 * **테스트 판(src/bnkr-test/)이다.** 본판(src/browser.ts)과 다른 것은 기본 결제수단
 * 하나뿐이다 — 카카오페이 자리에 네이버페이가 들어가 있다.
 *
 * 주소를 기본 브라우저에 던지고 끝내면, 정말 열렸는지·로그인이 풀려 장바구니로 튕겼는지
 * 알 방법이 없다. 담기까지 성공해 놓고 주문서가 비어 있는 걸 사람이 화면을 볼 때까지
 * 모르는 게 제일 나쁘다.
 *
 *   새 크롬(임시 프로파일) → 쿠키 주입(CDP) → order.do?direct=1 → 확인 → 창 유지
 *
 * 주문서까지 왔으면 남은 클릭도 대신 눌러 줄 수 있다(order_action).
 *
 *   open    주문서를 열고 멈춘다
 *   agree   필수 동의 2개를 체크하고 멈춘다
 *   submit  결제하기까지 눌러 PG 결제창을 띄운다
 *
 * **어느 쪽이든 결제는 하지 않는다.** 결제하기는 PG 결제창을 띄울 뿐이고, 카드 인증·
 * 앱 확인은 거기서 사람이 한다. 단, 설정에 pg_password 를 적어 두면 네이버페이의
 * 간편결제 비밀번호 자판은 대신 눌러 준다 — 자판은 매 결제마다 숫자 위치가 바뀌므로
 * 화면의 자판을 읽어 차례로 누른다.
 *
 * 창 안에서 도는 자바스크립트는 파이썬 판의 것을 글자 그대로 가져왔다. 그 조각들이
 * 왜 그렇게 생겼는지는 하나하나 데어 가며 알아낸 것이라, 옮기면서 손대지 않았다.
 *
 * 봇 탐지를 속이는 옵션(navigator.webdriver 감추기 따위)은 쓰지 않는다. 자동화로 여는
 * 것을 숨길 이유가 없다 — 로그인도 결제도 사람이 한 것이다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { Builder, By, type WebDriver, type WebElement } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { hint, looksLike } from "./queue.js";
import { log } from "./log.js";
import { sleep } from "./util.js";
import { NPAY_CLICKS, type PgStep } from "./config.js";

export const SITE = "https://www.bnkrmall.co.kr";
const HOST = new URL(SITE).host;
const COOKIE_DOMAIN = ".bnkrmall.co.kr";

// 주문서가 그려졌다는 증거. 필수 동의 체크박스는 주문서에만 있다.
const ORDER_MARK = "orderAgree1";
// 주문 상품 정보 동의 · 결제대행서비스 개인정보 동의. 둘 다 필수다.
const AGREE_BOXES = ["orderAgree1", "orderAgree2"];
export const ACTIONS = ["open", "agree", "submit"] as const;
export type Action = (typeof ACTIONS)[number];
export type Stage = "opened" | "agreed" | "submitted";

// PG 결제창에서 눌러 볼 것들. 순서대로 누른다.
//
// **테스트 판이라 네이버페이로 간다.** 본판은 여기에 카카오페이를 적어 뒀다. 설정
// (pg_clicks)이 비어 있을 때만 쓰이는 자리지만, 그 한 번이 하필 결제창이 떠 있는
// 순간이므로 본판과 다른 곳을 가리키게 둔다. 아래 주석들에 카카오페이 이야기가 남아
// 있는데, 그건 이 코드가 왜 이렇게 생겼는지에 대한 기록이라 손대지 않았다.
const PG_CLICKS: PgStep[] = NPAY_CLICKS;

// 체크박스를 label 로 덮어 꾸며 놓은 사이트라 셀레니움의 click() 은 "가려져 있다" 며
// 거절한다. 북마클릿과 같은 방법으로 DOM 쪽 click() 을 부른다 — checked 만 바꾸면
// 화면에 반영되지 않고 붙어 있는 핸들러도 안 돈다.
const AGREE_JS = `
var missing = [];
arguments[0].forEach(function (id) {
  var box = document.getElementById(id);
  if (!box) { missing.push(id); return; }
  if (!box.checked) box.click();
  if (!box.checked) {
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (!box.checked) missing.push(id);
});
return missing;
`;

// 화면에 보이는가.
//
// offsetParent 로 보면 안 된다. position:fixed 인 요소는 **보이는데도 null** 이다.
// 결제창처럼 띄워 놓은 레이아웃에서 흔한 경우라, 멀쩡한 버튼을 숨은 것으로 오판한다.
const VISIBLE_JS = `
function visible(el) {
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
}
// 화면에 보이는 글자. **눈에 보이는 것이 먼저다.**
//
// title 을 앞에 뒀다가 크게 틀렸다. 이 결제창의 다음 버튼이
//   <div class="summary-action"><a class="go-next-step" title="새창열림">다음</a></div>
// 인데, title 을 먼저 보면 저 <a> 는 "새창열림" 이 된다. title 은 툴팁이지 표시 글자가
// 아니다. 글자가 없을 때만 value·alt·title 로 물러선다.
function label(el) {
  var text = (el.textContent || "").trim();
  if (text) return text;
  return (el.value || el.alt || el.getAttribute("title") || "").trim();
}

// 화면 상태를 한 줄로 잰다. 누른 게 먹혔는지 보는 자다.
//
// 글자 수만 재면 안 된다. 이 결제창에서 "동의합니다" 를 누르면 체크가 들어가고 "다음"
// 버튼이 살아나는데, **글자는 한 자도 안 변한다.** 그걸 못 눌린 것으로 보고 다시 누르면
// 체크가 도로 풀린다. 체크 상태와 버튼의 활성·클래스까지 함께 재야 한다.
function sig() {
  var out = [location.href, (document.body.innerText || "").length,
             document.querySelectorAll("*").length];
  var fields = document.querySelectorAll("input, select, textarea"), a = "";
  for (var i = 0; i < fields.length; i++) {
    a += (fields[i].checked ? "1" : "0") + (fields[i].disabled ? "1" : "0") +
         String(fields[i].value || "").length + ",";
  }
  var acts = document.querySelectorAll("button, a"), b = "";
  for (var j = 0; j < acts.length; j++) {
    b += (acts[j].disabled ? "1" : "0") + String(acts[j].className || "") + ";";
  }
  return out.join("~") + "~" + a + "~" + b;
}
`;

// 글자로 눌러야 할 것을 찾는다. 결제창은 버튼이 button 이 아닐 때가 많다 —
// label·div·span·a 에 핸들러를 붙여 놓는다. 그래서 태그를 가리지 않고 뒤진다.
// 네이버 판(naver/browser.ts)도 이걸 그대로 쓴다. 파이썬 쪽에서 naver_browser 가
// bnkr_browser 의 것을 빌려 쓰는 것과 같다 — 이 조각은 결제창에서 여러 번 틀려 가며
// 다듬은 것이라, 사이트마다 다시 쓰는 것보다 빌려 쓰는 편이 낫다.
export const FIND_TEXT_JS = VISIBLE_JS + `
var want = arguments[0];

// 글자를 쥔 것은 껍데기 span 일 때가 많고, 핸들러는 조상 a·label 에 붙어 있다.
// jQuery 로 붙인 핸들러는 el.onclick 에 안 잡히므로 그 쪽 장부도 들춰 본다.
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

// 이 글자를 눌렀을 때 실제로 닿는 자리. 없으면 null.
//
// **위로 올라가되 끝없이 올라가지는 않는다.** 글자가 훨씬 많아지는 조상은 그 글자의
// 버튼이 아니라 그것을 품은 딴 것이다. 실제로 "결제" 를 찾다가 단계 목록(ol.steps)까지
// 올라가 그걸 눌렀고, 그 목록은 누르면 앞 단계로 되돌아가는 물건이었다.
var CLIMB_LIMIT = want.length + 30;

function resolve(el) {
  if (handles(el)) return el;
  for (var up = el.parentElement; up && up !== document.body; up = up.parentElement) {
    if (label(up).length > CLIMB_LIMIT) break;
    if (handles(up)) return up;
  }
  // 위에 없으면 아래를 본다. 누를 것이 그 안에 하나만 들어 있는 경우다.
  var inner = Array.prototype.slice.call(el.querySelectorAll("a, button, input")).filter(visible);
  return inner.length === 1 ? inner[0] : null;
}

var hits = [];
Array.prototype.slice.call(document.querySelectorAll("*")).forEach(function (el) {
  if (!visible(el)) return;
  var text = label(el);
  if (text.indexOf(want) === -1) return;
  // 조상까지 다 걸리므로, 같은 글자를 품은 자식이 없는 것만 남긴다(제일 안쪽).
  var deeper = Array.prototype.slice.call(el.querySelectorAll("*")).some(function (kid) {
    return visible(kid) && label(kid).indexOf(want) !== -1;
  });
  if (deeper) return;
  hits.push({ el: el, text: text, target: resolve(el) });
});
if (!hits.length) return false;

// **문서 순서로 첫 번째를 집으면 안 된다.** 약관 본문에 "다음과 같이 구별됩니다" 처럼
// 그 글자가 박혀 있고, 그런 문단이 버튼보다 앞에 온다. "결제" 는 더 흔해서 더 위험하다.
// 그래서 고른다 — 누를 수 있는 것 먼저, 글자가 정확히 맞는 것 먼저, 짧은 것 먼저.
hits.sort(function (a, b) {
  if (!!a.target !== !!b.target) return a.target ? -1 : 1;
  var ax = a.text === want, bx = b.text === want;
  if (ax !== bx) return ax ? -1 : 1;
  return a.text.length - b.text.length;
});

var best = hits[0];
var el = best.el, target = best.target || el;

// label 이 가리키는 체크박스가 있으면 그쪽이 진짜다. for 로 묶은 것도, 품고 있는 것도 본다.
var box = null;
if (target.tagName === "LABEL") {
  if (target.htmlFor) box = document.getElementById(target.htmlFor);
  if (!box) box = target.querySelector('input[type="checkbox"], input[type="radio"]');
  if (box) target = box;
}

// 그 글자가 통째로 이름인 것만 인정한다. 이름이라기엔 너무 긴 것은 본문이지 버튼이 아니다.
// 체크박스에 붙은 라벨은 예외다 — 동의 항목은 문장으로 적어 두는 곳이 많다.
if (best.text !== want && !(best.target && best.text.length <= want.length + 10) && !box) {
  return false;
}

// 아직 못 누를 상태면 누른 척하지 않는다. 부른 쪽이 다시 시도한다.
// 이 결제창은 속성이 아니라 클래스로 잠근다 — $('.go-next-step').addClass('disabled').
if (target.disabled || target.getAttribute("aria-disabled") === "true" ||
    (target.classList && target.classList.contains("disabled"))) return false;

// 무엇을 눌렀는지 남겨 둔다. 엉뚱한 것을 눌러 놓고 "눌렀다" 고 적는 일이 있었다.
function describe(el) {
  var cls = el.className && el.className.baseVal === undefined ? String(el.className).trim() : "";
  return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
         (cls ? "." + cls.split(/\\s+/).join(".") : "") +
         ' "' + label(el).slice(0, 30) + '"';
}

// 이미 체크돼 있으면 다시 누르지 않는다. 누르면 도로 풀린다.
if ((target.type === "checkbox" || target.type === "radio") && target.checked) {
  return ["already", null, "", describe(target)];
}

// 여기서 누르지 않는다. 누르는 일은 셀레니움에게 넘긴다 — 자바스크립트로 부른 click 은
// isTrusted 가 false 라, 창을 여는 버튼이면 크롬이 막는다. 찾아 주기만 한다.
return ["found", target, sig(), describe(target)];
`;

// 글자를 넣을 칸을 찾는다. 누를 것과 달리 칸은 제 이름을 안 갖고 있다 — 무엇을 받는
// 칸인지는 옆에 적힌 안내나 placeholder 가 말해 준다. 그래서 그 주변까지 보고 고른다.
const FIND_FIELD_JS = VISIBLE_JS + `
var raw = (arguments[0] || "").trim();
var want = raw.toLowerCase();

// **칸은 "보이는가" 로 고르지 않는다.** 접어 둔 칸이 있다 — 카카오페이 카톡결제가
// 그렇다. 화면에서 자리를 차지하는 것은 라벨뿐이고 input 은 크기가 0 인 채 옆에 있다가,
// 누르면 그때 펼쳐진다. 보이는 것만 세면 이런 칸은 영영 못 찾는다.
function present(el) {
  var s = window.getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden";
}

// 그 칸을 열어 주는 것. 접힌 칸은 제 라벨이나 감싼 상자를 눌러야 펼쳐진다.
function opener(el) {
  if (el.id) {
    var lab = null;
    try { lab = document.querySelector('label[for="' + el.id + '"]'); } catch (e) {}
    if (lab && visible(lab)) return lab;
  }
  var box = el.parentElement;
  while (box && box !== document.body && !visible(box)) box = box.parentElement;
  return box && box !== document.body && visible(box) ? box : null;
}

// #id 나 .class 로 적었으면 그것으로 곧장 집는다. 화면 글자로 더듬는 것은 그 칸이
// 무엇인지 모를 때 쓰는 방법이다.
if (raw.charAt(0) === "#" || raw.charAt(0) === ".") {
  var picked = null;
  try { picked = document.querySelector(raw); } catch (e) { picked = null; }
  if (!picked || !present(picked)) return false;
  return [picked, opener(picked), picked.tagName.toLowerCase() + raw];
}

// 사람이 적어 넣는 칸만 센다. 감춰 둔 것, 잠긴 것, 버튼 노릇 하는 것은 뺀다.
var SKIP = ["hidden", "checkbox", "radio", "button", "submit", "reset", "image", "file", "range"];
var fields = Array.prototype.slice.call(document.querySelectorAll("input, textarea"))
  .filter(function (el) {
    if (el.disabled) return false;
    if (SKIP.indexOf((el.type || "text").toLowerCase()) !== -1) return false;
    return present(el);
  });
if (!fields.length) return false;

function near(el) {
  var out = "";
  try {
    for (var i = 0; el.labels && i < el.labels.length; i++) out += el.labels[i].textContent || "";
  } catch (e) {}
  return out;
}

function score(el) {
  var own = [el.placeholder, el.getAttribute("aria-label"), el.name, el.id,
             el.getAttribute("title")].join(" ").toLowerCase();
  if (own.indexOf(want) !== -1) return 3;
  if (near(el).toLowerCase().indexOf(want) !== -1) return 2;
  var box = el.closest ? el.closest("div, li, td, fieldset, form") : null;
  if (box && (box.textContent || "").toLowerCase().indexOf(want) !== -1) return 1;
  return 0;
}

var hit = null;
if (!want) {
  // 이름을 안 줬으면 칸이 하나뿐일 때만 인정한다. 엉뚱한 칸에 번호를 적어 넣는 것은
  // 아무것도 안 하느니만 못하다.
  if (fields.length !== 1) return false;
  hit = fields[0];
} else {
  var best = 0;
  fields.forEach(function (el) {
    var s = score(el);
    if (s > best) { best = s; hit = el; }
  });
  if (!best) return false;
}

// 무엇에 적어 넣는지 남긴다. **값은 남기지 않는다** — 로그에도 덤프에도 갈 것이다.
var mark = hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") +
           (hit.name ? "[" + hit.name + "]" : "") +
           (hit.placeholder ? ' "' + hit.placeholder.slice(0, 30) + '"' : "");
return [hit, opener(hit), mark];
`;

// 못 찾았을 때 그 화면에 어떤 칸이 있었는지. 결제창은 다시 띄우기 어려우니, 한 번
// 실패했을 때 다음에 무엇으로 찾아야 할지까지 챙겨 둔다.
const FIELD_LIST_JS = VISIBLE_JS + `
return Array.prototype.slice.call(document.querySelectorAll("input, textarea"))
  .filter(function (el) {
    var s = window.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden";
  })
  .slice(0, 12)
  .map(function (el) {
    return [el.tagName.toLowerCase(), el.type || "text",
            el.id ? "#" + el.id : "", el.name ? "[" + el.name + "]" : "",
            el.placeholder ? '"' + el.placeholder.slice(0, 24) + '"' : "",
            el.readOnly ? "readonly" : "", el.disabled ? "disabled" : ""]
      .filter(function (bit) { return bit; }).join(" ");
  });
`;

// 리액트로 만든 창에서 값을 넣는 법. 요즘 결제창이 그렇다.
//
// el.value = … 로 박아 넣으면 화면에는 보이는데 리액트 쪽 장부에는 안 들어간다. 그러면
// 다음을 눌렀을 때 "번호를 입력해 주세요" 가 뜬다 — 눈에는 번호가 적혀 있는 채로.
const SET_VALUE_JS = `
var el = arguments[0], value = arguments[1];
var proto = el.tagName === "TEXTAREA"
  ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
setter.call(el, value);
el.dispatchEvent(new Event("input", { bubbles: true }));
el.dispatchEvent(new Event("change", { bubbles: true }));
return el.value;
`;

// 추측이 아니라 이게 필요하다. 결제창은 매번 띄워 볼 수 있는 화면이 아니다.
const DUMP_JS = VISIBLE_JS + `
return Array.prototype.slice.call(
    document.querySelectorAll("a, button, input, label, span, div, li, td"))
  .filter(function (el) {
    if (!visible(el)) return false;
    var text = label(el);
    if (!text || text.length > 40) return false;
    return !Array.prototype.slice.call(el.querySelectorAll("*")).some(function (kid) {
      return visible(kid) && label(kid) === text;
    });
  })
  .slice(0, 120)
  .map(function (el) {
    var r = el.getBoundingClientRect();
    // 입력칸에 적힌 값은 남기지 않는다. 주문서에는 이름·전화번호·주소가 들어 있다.
    var text = el.tagName === "INPUT" || el.tagName === "TEXTAREA"
      ? "(" + (el.type || "text") + ", " + String(el.value || "").length + "자)"
      : label(el);
    return [el.tagName.toLowerCase(),
            el.id ? "#" + el.id : "",
            el.className && el.className.baseVal === undefined ? "." + String(el.className).trim().split(/\\s+/).join(".") : "",
            Math.round(r.left) + "," + Math.round(r.top),
            JSON.stringify(text)].join(" ");
  });
`;

// 숨은 버튼이 여러 벌 렌더돼 있는 사이트다. 화면에 실제로 보이는 것만 고른다.
const SUBMIT_JS = `
var button = Array.prototype.slice.call(document.querySelectorAll("button, a"))
  .filter(function (el) {
    return /결제하기/.test(el.textContent || "") && el.offsetParent !== null;
  })[0];
if (!button) return false;
button.click();
return true;
`;

// 간편결제 비밀번호 자판. **매 결제마다 숫자 위치가 바뀐다.** 그리고 네이버페이 자판의
// 숫자는 글자가 아니라 **한 장의 스프라이트 그림**으로 그려져 있다 — 2026-08-24 의
// 네이버페이 창(bnkr-test-pg-dump.txt)이 그랬다. 키의 span 이 스프라이트를
// background-position 으로 잘라 보여 준다. 그래서
//
//   1. 스프라이트를 읽는다 (키 span 의 background-image — 전부 같은 그림이다)
//   2. 각 키가 보여 주는 조각을 잘라 12×16 그물로 축소한다
//   3. 그 자리의 숫자를 **글꼴 투표**로 맞춘다 (classify 참고)
//
// 자판 숫자는 매 결제마다 조금씩 다르게 그려져서, 고정 본보기 하나로는 0 과 9 같은
// 데서 틀릴 수 있었다 (2026-08-25 에 실제로 9 를 0 으로 읽은 판이 있었다). 그래서
// 브라우저에서 0-9 를 여러 굵은 글꼴로 직접 그려 견주고, 2026-08-24 자판에서 받아
// 적은 본보기(TEMPLATES, 1/4/8/2/9/6/7/3/5/0 순서)와 함께 점수를 합산한다.
const KEYPAD_JS = VISIBLE_JS + `
var CW = 12, CH = 16;
var ORDER = "1482967350";
var TEMPLATES = [
  "A/D/P//P8PwPAPAPAPAPAPAPAPAPAPAP",  // 1
  "A8A8B8BsDMHMGMOMcMYM4M////AMAMAM",  // 4
  "DwP8PecOcGcGOOH4P8eO4H4H4HcPP+H4",  // 8
  "HwP8f+4H4HAHAOAOAcA4DwHgPAeA////",  // 2
  "GAfAfg5wwwwwwxxxfxfxOwAwwwZgfgPA",  // 9
  "DwH8P+cHYA4A78/++P8H4H4HcHOPP+H4",  // 6
  "//////AHAOAOAcA4A4BwBwDgDAHAHAOA",  // 7
  "DwH8f+cPYHAGAOD8D8APAHAH4HcPP+H8",  // 3
  "f+f+f+cA4A4A78/+8HAHAH4H4HcPf+H4",  // 5
  "Hgf4/84ewOwPgPgPgHgHwPwOwO4c/8Pw",  // 0
];
var B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function tplBits() {
  var out = [];
  for (var i = 0; i < TEMPLATES.length; i++) {
    var s = TEMPLATES[i], bits = [];
    for (var j = 0; j < s.length; j++) {
      var v = B64CHARS.indexOf(s[j]);
      for (var k = 5; k >= 0; k--) bits.push((v >> k) & 1);
    }
    out.push(bits);
  }
  return out;
}
var TPL = tplBits();

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

function findConfirm(root) {
  var confirm = null;
  var all = root ? root.querySelectorAll("*") : document.querySelectorAll("*");
  Array.prototype.slice.call(all).forEach(function (el) {
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

// --- 자판 그릇을 찾는다. 2026-08-24 자판은 id="keyboard" 다. ---
var keyboard = document.getElementById("keyboard");
if (!keyboard) {
  var tbl = document.querySelector("table.SecureKeyboard_keyboard, .SecureKeyboard_keyboard");
  if (tbl) keyboard = tbl.parentElement;
}
// 그릇이 아직 없으면 (결제창이 막 그려질 때) 자판이 아니다. 부른 쪽이 다시 읽는다.
if (!keyboard) return false;

// --- 스프라이트 자판. 키의 span 이 스프라이트 한 조각을 보여 준다. ---
var spans = Array.prototype.slice.call(keyboard.querySelectorAll("span"))
  .filter(function (s) {
    var bg = s.style && s.style.backgroundImage;
    return bg && bg.indexOf("data:image") !== -1;
  });
if (spans.length < 9) return false;

// 스프라이트는 매번 갈아끼워질 수 있으니(자리 바뀜) 주소로 기억해 뒀다가, 바뀌면
// 다시 읽는다. 같은 그림을 키마다 새로 디코드하지 않는다.
var CACHE = window.__npaySpriteCache || (window.__npaySpriteCache = {});
var spriteUrl = spans[0].style.backgroundImage.replace(/^url\\(["']?/, "").replace(/["']?\\)$/, "");
var img = CACHE[spriteUrl];
if (!img) {
  img = new Image();
  img.src = spriteUrl;
  var t0 = Date.now();
  while (!img.complete && Date.now() - t0 < 2000) { /* 데이터 URL 은 곧 끝난다 */ }
  if (!img.complete || !img.width) return false;
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

// 한 조각을 잘라 12×16 그물로 축소한다. 그림자는 남기지 않는다 — 잉크만 남은 부분을
// 감싸는 상자로 잘라서, 키와 본보기가 어느 쪽이 더 크든 같은 그물로 맞춘다.
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

// 본보기와 견준다. 작은 어긋남을 감당하도록 ±1칸 옮겨 가며 본다. 각 자리에서
// 같은 칸 비율을 재고, 그중 가장 좋은 값을 쓴다.
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

// **글꼴 투표로 숫자를 맞춘다.** 자판 숫자는 매 결제마다 조금씩 다르게 그려진다 —
// 고정 본보기(아래 TEMPLATES) 하나로는 0 과 9 같은 데서 틀릴 수 있다 (2026-08-25 에
// 실제로 9 를 0 으로 읽은 판이 있었다). 그래서 브라우저에서 0-9 를 여러 굵은
// 글꼴로 직접 그려 견주고, 본보기와 함께 그 결과를 점수로 합산한다. 여럿이
// 투표하므로 어느 세션이든 맞는다.
var FONT_VOTERS = ["Arial Black", "Arial", "Malgun Gothic", "Segoe UI", "Arial Rounded MT Bold"];
var REF_CACHE = window.__npayFontRefs || (window.__npayFontRefs = {});

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
  // 숫자만 남은 부분을 감싸 잘라 같은 그물로 만든다 (fingerprint 와 같은 방식).
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
  // 각 표(고정 본보기 + 글꼴들)가 가장 자신 있는 숫자를 고르고, 점수를 숫자별로
  // 합산한다. 가장 높은 숫자가 이 자리다.
  var totals = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  var tBest = -1, tV = -1, tSecond = -1;
  for (var t = 0; t < TPL.length; t++) {
    var v = compareBits(bits, TPL[t]);
    if (v > tV) { tSecond = tV; tV = v; tBest = t; }
    else if (v > tSecond) { tSecond = v; }
  }
  totals[Number(ORDER[tBest])] += tV;
  for (var f = 0; f < FONT_VOTERS.length; f++) {
    var name = FONT_VOTERS[f];
    var best = -1, bv = -1;
    for (var d = 0; d <= 9; d++) {
      var rb = refBits(name, String(d));
      if (!rb) continue;
      var v2 = compareBits(bits, rb);
      if (v2 > bv) { bv = v2; best = d; }
    }
    if (best >= 0) totals[best] += bv;
  }
  var win = 0;
  for (var d = 1; d <= 9; d++) if (totals[d] > totals[win]) win = d;
  var sorted = totals.slice().sort(function (a, b) { return b - a; });
  return { digit: String(win), score: sorted[0], next: sorted[1] };
}

// 키마다 보여 주는 조각의 자리를 계산한다. background-position 이 스프라이트의
// 어느 조각을 보여 주는지, span 의 크기와 함께 읽는다. background-size 가 px 로
// 따로 있으면(스프라이트를 늘려 쓰는 자판) 그 배율로 되돌린다.
var table = [];
var debug = [];
spans.forEach(function (span) {
  var btn = resolve(span);
  if (!btn) return;
  var cs = getComputedStyle(span);
  var mPos = cs.backgroundPosition.split(/\\s+/);
  var px0 = parseFloat(mPos[0]), py0 = parseFloat(mPos[1]);
  var sw = span.offsetWidth || 0, sh = span.offsetHeight || 0;
  var sx = -px0, sy = -py0, fw = sw, fh = sh;
  if (isNaN(px0) || isNaN(py0) || !sw || !sh) {
    debug.push("pos=" + cs.backgroundPosition + " size=" + cs.backgroundSize);
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
  table.push([m.digit, btn, Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);
  debug.push(m.digit + "@" + Math.round(sx) + "," + Math.round(sy) + ":" +
    m.score.toFixed(2) + "/" + m.next.toFixed(2));
});

// 0-9 가 한 자씩 다 있어야 자판이다. 겹치거나 빠졌으면 자리를 잘못 읽은 것이다.
if (table.length !== 10) return ["odd", table, null, "keys=" + table.length + " " + debug.join(" ")];
var seenD = {};
table.forEach(function (e) { seenD[e[0]] = true; });
for (var d = 0; d < 10; d++) {
  if (!seenD[String(d)]) return ["odd", table, null, "missing " + d + " " + debug.join(" ")];
}

return ["found", table, findConfirm(keyboard), debug.join(" ")];
`;

// 비밀번호가 틀렸을 때 자판 화면이 내미는 말. 알아서 재시도하게 두면 결제가 잠길 수
// 있으므로, 이게 보이면 물러나 사람에게 맡긴다.
const PIN_ERROR_JS = `
return /비밀번호가 일치하지|비밀번호가 올바르지|비밀번호를 다시|간편비밀번호가 일치/.test(document.body.innerText || "");
`;

// 채워진 비밀번호 점 개수. [개수] 로 돌려준다(0도 "찾았다" 로 읽히게 배열로 감싼다).
// 누른 자리가 정말 먹혔는지 확인하는 데 쓴다. 점마다 이름이 다를 수 있으니
// "Password_dot" 로 시작하는 것을 세되 "Password_on" 이 붙은 것만 센다.
const DOTS_JS = `
var n = 0;
Array.prototype.slice.call(document.querySelectorAll('[class*="Password_dot"]')).forEach(function (el) {
  if ((el.className || "").indexOf("Password_on") !== -1) n++;
});
return [n];
`;

// 주문완료 화면에서 챙길 것. 화면을 그림으로 보내는 것만으로는 폰에서 주문번호를
// 옮겨 적기가 불편하다. 글자로도 보내 두면 나중에 주문내역과 맞춰 보기 쉽다.
const PAID_INFO_JS = `
var text = document.body.innerText || "";
var m = text.match(/주문번호\\s*([A-Za-z0-9][A-Za-z0-9-]{5,})/);
var order = m ? m[1] : "";

var name = "";
var link = document.querySelector('a[href*="gno="]');
if (link) name = (link.textContent || "").trim();

var img = "";
var pics = Array.prototype.slice.call(document.querySelectorAll("img"));
for (var i = 0; i < pics.length; i++) {
  var r = pics[i].getBoundingClientRect();
  var src = pics[i].currentSrc || pics[i].src || "";
  if (r.width >= 40 && r.height >= 40 && /goods|product|upload|item/i.test(src)) {
    img = src;
    break;
  }
}

if (!order && !name && !img) return false;
return [order, name.slice(0, 200), img];
`;

const RENDERED_JS = `
if (document.readyState === 'loading') return false;
if (!document.body) return false;
if ((document.body.innerText || '').trim().length >= 3) return true;
var all = document.querySelectorAll('img, canvas, svg, iframe');
for (var i = 0; i < all.length; i++) {
  var r = all[i].getBoundingClientRect();
  if (r.width > 40 && r.height > 40) return true;
}
return false;
`;

export class BrowserError extends Error {}

/** 대기열이라는 판정은 사유 앞머리로 알린다. 부른 쪽이 이걸 보고 "다시 열기" 를 멈춘다. */
const QUEUE_PREFIX = "대기열";

export function isQueue(reason: string | null | undefined): boolean {
  return !!reason && String(reason).startsWith(QUEUE_PREFIX);
}

/**
 * 크롬 창 하나. 결제창이 새 창으로 뜨므로 "처음 창" 이 무엇이었는지 기억해 둬야 한다.
 * 파이썬 판은 driver 에 속성을 붙여 뒀는데, 여기서는 감싸는 편이 낫다.
 */
export class Chrome {
  mainWindow: string | null = null;
  constructor(public driver: WebDriver) {}

  quit(): Promise<void> {
    return this.driver.quit().catch(() => undefined);
  }
}

export async function makeDriver(headless = false, profile: string | null = null, offscreen = false): Promise<Chrome> {
  const options = new chrome.Options();
  // 노드가 끝나도 창을 남긴다. 이게 없으면 크롬드라이버가 종료되면서 크롬을 같이 닫는다 —
  // --buy 처럼 한 번 열고 끝나는 명령에서는 주문서를 볼 새도 없다.
  options.detachDriver(true);
  // 광고·추적 스크립트까지 다 받을 때까지 기다리지 않는다. 우리가 기다리는 것은
  // 문서가 서는 시점이지 배너가 뜨는 시점이 아니다.
  options.setPageLoadStrategy("eager");
  // 팝업 차단을 끈다. 결제창은 창에서 창을 연다 — 앱없이결제(onLoadHandler6) 가 그렇다.
  // 크롬이 막으면 그 허용 버튼은 브라우저 UI 라 셀레니움으로 누를 수 없다. 애초에 안 막게 한다.
  options.addArguments("--disable-popup-blocking");
  options.setUserPreferences({ "profile.default_content_setting_values.popups": 1 });

  // 프로필을 한 곳에 고정한다. 안 주면 크롬은 띄울 때마다 빈 임시 프로필을 만든다 —
  // 그러면 사람이 미리 해 둔 것(네이버 로그인, 크롬이 기억하는 권한)이 하나도 안 남는다.
  if (profile) {
    mkdirSync(profile, { recursive: true });
    options.addArguments(`--user-data-dir=${profile}`);
  }

  // 창을 모니터 밖에 세운다. **headless 와는 다른 이야기다.**
  // headless 는 사이트가 알아본다. 화면 밖에 두면 진짜 크롬이 평소대로 그려지고 클릭도
  // 그대로 먹는데, 눈에만 안 보인다. 숨기는 것은 **내 모니터에서**이지 사이트에서가 아니다.
  if (offscreen && !headless) {
    options.addArguments("--window-position=-32000,-32000", "--window-size=1280,900");
  }
  if (headless) options.addArguments("--headless=new");

  try {
    const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
    return new Chrome(driver);
  } catch (e) {
    // 크롬이 없거나, 드라이버를 못 받았거나(오프라인), 버전이 안 맞을 때.
    const first = String((e as Error).message || e).trim().split("\n")[0] ?? "";
    throw new BrowserError(first);
  }
}

function parseCookie(raw: string): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of (raw || "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (name) jar[name] = part.slice(at + 1).trim();
  }
  return jar;
}

/**
 * 빌려온 쿠키를 크롬에 심는다. → 심은 개수
 *
 * CDP 로 한 번에 심는다. 하나씩 넣는 길은 그 도메인에 이미 들어가 있어야 해서, 홈을
 * 한 장 받고(무거운 페이지다) 서른 번을 왕복해야 했다. CDP 는 아직 아무 데도 안 갔어도
 * 도메인만 적어 주면 심어 주므로, 곧장 주문서로 갈 수 있다.
 */
async function inject(chromeBox: Chrome, cookie: string): Promise<number> {
  const jar = parseCookie(cookie);
  const names = Object.keys(jar);
  if (!names.length) return 0;

  const cookies = names.map((name) => ({
    name, value: jar[name]!, domain: COOKIE_DOMAIN, path: "/", secure: true,
  }));
  const driver = chromeBox.driver as WebDriver & {
    sendDevToolsCommand(cmd: string, params: object): Promise<void>;
  };
  try {
    await driver.sendDevToolsCommand("Network.enable", {});
    await driver.sendDevToolsCommand("Network.setCookies", { cookies });
    return cookies.length;
  } catch (e) {
    log.debug(`쿠키를 한 번에 심지 못했습니다 (${(e as Error).message}). 하나씩 넣습니다.`);
  }

  // 값에 따옴표나 중괄호가 든 쿠키(_fcOM 같은 추적 쿠키)는 거절당할 수 있다. 신분을
  // 지는 건 MEMBER_TOKEN 과 ASI 뿐이라 그런 건 빠져도 상관없다.
  let planted = 0;
  const rejected: string[] = [];
  for (const one of cookies) {
    try {
      await driver.sendDevToolsCommand("Network.setCookie", one);
      planted += 1;
    } catch {
      rejected.push(one.name);
    }
  }
  if (rejected.length) {
    log.debug(`크롬이 받지 않은 쿠키 ${rejected.length}개: ${rejected.join(", ")}`);
  }
  return planted;
}

/**
 * 떠 있는 alert 의 문구를 가져오고 닫는다. 없으면 null.
 *
 * 주문서는 막힐 때 alert 로 말한다("주문할 상품이 없습니다"). 이걸 안 닫으면 이후 모든
 * 조작이 막힌다.
 */
export async function alertText(driver: WebDriver): Promise<string | null> {
  try {
    const alert = driver.switchTo().alert();
    const text = ((await alert.getText()) || "").trim();
    await alert.accept();
    return text || "(내용 없는 알림)";
  } catch {
    return null;
  }
}

/**
 * 문서를 만질 수 있을 때까지 기다린다. → 도중에 뜬 alert 문구 (없으면 null)
 *
 * complete 까지 기다리지 않는다. 그건 광고·추적 스크립트까지 다 받은 시점이고, 우리가
 * 필요한 것은 DOM 이 서는 시점이다(interactive).
 */
export async function settled(driver: WebDriver, timeout: number): Promise<string | null> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const text = await alertText(driver);
    if (text) return text;
    try {
      const state = await driver.executeScript<string>("return document.readyState");
      if (state === "interactive" || state === "complete") return null;
    } catch {
      // 대개 alert 때문이다. 다음 바퀴에서 잡힌다.
    }
    await sleep(50);
  }
  return null;
}

/** 지금 화면이 대기열인가. → 사유 (아니면 null) */
async function queueReason(driver: WebDriver, url: string): Promise<string | null> {
  let body = "";
  try {
    body = await driver.executeScript<string>(
      "return (document.body.innerText || '').slice(0, 20000)");
  } catch {
    body = "";
  }
  const mark = looksLike(body, url);
  if (!mark) return null;
  const note = hint(body);
  return `${QUEUE_PREFIX}입니다 (${mark})` + (note ? ` · ${note}` : "") + ` — ${url}`;
}

/**
 * 가려던 화면에 정말 도착했는가. → [도착했는가, 아니라면 사유]
 *
 * 판정은 두 단계다. 먼저 주소가 그대로인지 본다 — 주문할 게 없거나 로그인이 풀리면
 * 사이트가 다른 곳으로 보내 버리기 때문에, 튕겼다는 사실만으로 실패가 확정된다.
 * 주소가 그대로여도 주문서는 한 겹 더 본다. 껍데기만 그려 놓고 내용이 빈 경우가 있어서다.
 */
async function verify(
  driver: WebDriver, wanted: string, timeout: number,
): Promise<[boolean, string | null]> {
  const alerted = await settled(driver, timeout);
  const path = new URL(wanted).pathname;
  const url = await driver.getCurrentUrl();

  if (new URL(url).pathname !== path) {
    if (url.toLowerCase().includes("login")) {
      return [false, "로그인 페이지로 넘어갔습니다. 쿠키가 만료된 것 같습니다"];
    }
    // 대기열이면 창을 닫고 다시 열면 안 된다. 순번을 버리는 짓이다.
    const waiting = await queueReason(driver, url);
    if (waiting) return [false, waiting];
    if (alerted) return [false, `사이트가 알렸습니다 — ${alerted}`];
    return [false, `다른 곳으로 넘어갔습니다 (${url})`];
  }

  // 주문서는 필수 동의 체크박스가 있어야 주문서다. 장바구니에는 그런 표지가 없어
  // 주소가 그대로면 도착한 것으로 본다(비어 있는 장바구니도 장바구니다).
  if (path.includes("/order/order.do")) {
    const drawn = await driver.executeScript<boolean>(
      "return !!document.getElementById(arguments[0])", ORDER_MARK);
    if (!drawn) {
      if (alerted) return [false, `사이트가 알렸습니다 — ${alerted}`];
      return [false, "주문서가 그려지지 않았습니다"];
    }
  }

  if (alerted) {
    // 도착은 했다. 안내성 알림(배송지 확인 같은 것)까지 실패로 볼 것은 없다.
    log.info(`사이트 알림: ${alerted}`);
  }
  return [true, null];
}

/** 필수 동의 2개를 체크한다. → 못 한 것이 있으면 사유 (다 됐으면 null) */
async function agree(driver: WebDriver): Promise<string | null> {
  const missing = await driver.executeScript<string[]>(AGREE_JS, AGREE_BOXES);
  const alerted = await alertText(driver);
  if (alerted) return `동의를 체크하는데 사이트가 알렸습니다 — ${alerted}`;
  if (missing && missing.length) return `동의 항목을 체크하지 못했습니다 (${missing.join(", ")})`;
  return null;
}

/**
 * 결제하기를 누른다. → 못 눌렀으면 사유 (눌렀으면 null)
 *
 * 누르면 PG 결제창이 새 창으로 뜬다. 거기서부터는 사람이 한다. 배송지나 결제수단이
 * 비어 있으면 사이트가 alert 로 막는데, 그건 결제창이 안 떴다는 뜻이라 사유로 올린다.
 */
async function submit(chromeBox: Chrome, timeout: number): Promise<string | null> {
  const driver = chromeBox.driver;
  const before = new Set(await driver.getAllWindowHandles());
  const frames = await frameCount(driver);

  if (!(await driver.executeScript<boolean>(SUBMIT_JS))) {
    return "결제하기 버튼을 찾지 못했습니다";
  }

  // 결제창이 떴다는 신호는 셋 중 하나다 — 새 창, 새로 얹힌 iframe, 아니면 alert(막힘).
  // 예전에는 새 창만 기다렸다. 이 사이트의 KSPay 는 iframe 으로 얹히므로 오지 않을
  // 신호를 timeout 만큼 꽉 채워 기다렸다. 20초를 그냥 버리던 자리다.
  const deadline = Date.now() + Math.min(timeout, 8) * 1000;
  while (Date.now() < deadline) {
    const alerted = await alertText(driver);
    if (alerted) return `결제창이 뜨기 전에 사이트가 막았습니다 — ${alerted}`;
    const now = await driver.getAllWindowHandles();
    if (now.some((h) => !before.has(h))) {
      log.debug("결제창이 새 창으로 떴습니다.");
      return null;
    }
    if ((await frameCount(driver)) > frames) {
      log.debug("결제창이 이 창에 얹혔습니다.");
      return null;
    }
    await sleep(200);
  }

  // 신호를 못 봤다고 실패는 아니다. 어차피 다음 단계에서 창을 뒤진다.
  log.debug("결제창 신호를 못 봤습니다. 그대로 진행합니다.");
  return null;
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
 * 기본 문서에서 path 를 따라 프레임을 타고 내려간다. → 그 자리의 iframe 수 (못 가면 null)
 *
 * 갈 때마다 기본 문서에서 다시 내려간다. 프레임을 옮기면 앞서 잡아 둔 요소 참조가
 * 무효가 되므로, 경로를 들고 다니며 매번 새로 찾는 편이 안전하다.
 */
export async function descend(driver: WebDriver, path: number[]): Promise<number | null> {
  await driver.switchTo().defaultContent();
  for (const index of path) {
    const frames = await driver.findElements(By.css("iframe"));
    if (index >= frames.length) return null;
    await driver.switchTo().frame(frames[index]!);
  }
  return (await driver.findElements(By.css("iframe"))).length;
}

/** 기본 문서부터 depth 층까지 내려갈 수 있는 프레임 경로를 모은다. */
export async function framePaths(driver: WebDriver, depth: number): Promise<number[][]> {
  const paths: number[][] = [[]];
  let frontier: number[][] = [[]];
  for (let level = 0; level < depth; level++) {
    const deeper: number[][] = [];
    for (const path of frontier) {
      let count: number | null;
      try {
        count = await descend(driver, path);
      } catch {
        continue;
      }
      if (count) {
        for (let i = 0; i < count; i++) deeper.push([...path, i]);
      }
    }
    if (!deeper.length) break;
    paths.push(...deeper);
    frontier = deeper;
  }
  return paths;
}

/**
 * 남의 집 프레임을 앞에 세운다.
 *
 * 결제창은 iframe 으로 얹히고, 그 아래에는 주문서가 그대로 살아 있다. 주문서에도
 * "동의합니다" 가 있어서(필수 동의 두 개가 그렇다) 위에서부터 훑으면 결제창 대신
 * 주문서를 누른다. 사이트 밖 주소를 가진 프레임을 먼저 본다.
 */
async function foreignFirst(driver: WebDriver, paths: number[][]): Promise<number[][]> {
  const scored: [number[], boolean][] = [];
  for (const path of paths) {
    let foreign = false;
    try {
      if ((await descend(driver, path)) !== null) {
        const here = await driver.executeScript<string>("return location.href");
        foreign = !here.includes(HOST);
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

/** 누른 뒤 화면이 달라졌는가. 누른 프레임에 그대로 선 채로 잰다. */
export async function reacted(driver: WebDriver, before: string, waitFor = 1.5): Promise<boolean> {
  const deadline = Date.now() + waitFor * 1000;
  while (Date.now() < deadline) {
    try {
      const now = await driver.executeScript<string>(VISIBLE_JS + "return sig()");
      if (now !== before) return true;
    } catch {
      // 프레임이 갈렸다는 뜻이니, 그것도 달라진 것이다.
      return true;
    }
    await sleep(200);
  }
  return false;
}

/**
 * 진짜 클릭을 먼저 해 본다. 거부당하면 자바스크립트로 누른다. → 눌렀으면 true
 *
 * 셀레니움의 click 은 브라우저에 실제 입력을 넣는다 — 크롬이 사람이 누른 것으로 본다.
 * 자바스크립트로 부른 click 은 isTrusted 가 false 라, **창을 여는 버튼이면 크롬이 막는다.**
 * 이 결제창의 다음 버튼은 title 이 "새창열림" 이다.
 *
 * 대신 진짜 클릭은 가려진 것을 거부한다 — 체크박스를 label 로 덮어 꾸며 놓은 경우가
 * 그렇다. 그때는 자바스크립트로 눌러야 한다. 그래서 둘 다 쓴다, 순서를 정해서.
 */
export async function press(driver: WebDriver, element: WebElement): Promise<boolean> {
  try {
    await driver.executeScript(
      "arguments[0].scrollIntoView({block: 'center', inline: 'center'})", element);
  } catch {
    // 못 굴려도 눌러는 본다.
  }

  try {
    await element.click();
    return true;
  } catch (e) {
    const first = String((e as Error).message).trim().split("\n")[0]?.slice(0, 80);
    log.debug(`진짜 클릭이 안 됩니다 (${first}). 자바스크립트로 누릅니다.`);
  }

  try {
    await driver.executeScript("arguments[0].click()", element);
    return true;
  } catch (e) {
    log.debug(`자바스크립트로도 못 눌렀습니다: ${(e as Error).message}`);
    return false;
  }
}

type Hit = [string, WebElement | null, string, string];
export type Pressed = "ok" | "quiet" | "none";

/**
 * 창 안에서 그 글자가 보이는 것을 눌러 본다.
 *
 *   "ok"    눌렀고 화면이 달라졌다
 *   "quiet" 누르기는 눌렀는데 화면이 그대로다
 *   "none"  그런 글자를 못 찾았다
 *
 * **눌렀다고 다 된 게 아니다.** 비활성 버튼에 click() 을 해도 예외는 안 난다. 이 결제창은
 * 앞 단계를 마쳐야 다음 버튼이 살아나므로, 눌러 보고 화면이 달라지는지까지 본다.
 *
 * "quiet" 을 "none" 과 같이 다루지 않는 것이 중요하다. 못 찾은 것과 눌렀는데 티가 안 난
 * 것은 고칠 방법이 다르다 — 앞은 글자를 바꿔야 하고, 뒤는 대개 그냥 먹힌 것이다.
 */
async function clickText(
  chromeBox: Chrome, want: string, timeout: number,
  opts: { foreign?: boolean; tries?: number } = {},
): Promise<Pressed> {
  const driver = chromeBox.driver;
  const tries = opts.tries ?? 3;
  const deadline = Date.now() + timeout * 1000;
  let attempts = 0;

  while (Date.now() < deadline && attempts < tries) {
    const got = await tryFrames<Hit>(
      driver, () => driver.executeScript<Hit>(FIND_TEXT_JS, want), { foreign: opts.foreign });
    if (got) {
      const [status, element, before, what] = got;
      if (status === "already") {
        log.debug(`'${want}' 는 이미 되어 있습니다 — ${what}`);
        return "ok";
      }

      attempts += 1;
      if (!element || !(await press(driver, element))) {
        await sleep(500);
        continue;
      }
      if (await reacted(driver, before)) {
        log.info(`결제창에서 '${want}' 를 눌렀습니다 — ${what}`);
        return "ok";
      }
      // 무엇을 눌렀는지 함께 남긴다. 엉뚱한 것을 누르고 있었던 적이 있다 —
      // 약관 본문의 "다음과 같이" 를 "다음" 버튼으로 알고 눌렀다.
      log.warn(`'${want}' 를 눌렀지만 화면이 그대로입니다 (${attempts}/${tries}) — ${what}`);
    } else {
      // 여기 없으면 다른 창에 있을 수 있다. **기다리지 않는 대신 계속 본다.**
      await hopWindow(chromeBox);
    }
    await sleep(500);
  }
  return attempts ? "quiet" : "none";
}

/**
 * 칸을 찾아 값을 넣는다. → "ok" / "quiet"(넣었는데 안 남았다) / "none"(칸이 없다)
 *
 * 사람이 치듯 진짜 키 입력을 먼저 넣는다. 자바스크립트로 값을 박아 넣는 것보다 이쪽이
 * 안전하다 — 화면이 무엇으로 만들어졌든 사람이 친 것과 같아진다.
 *
 * **값은 어디에도 적지 않는다.** 로그에는 어느 칸에 넣었는지만 남긴다.
 */
async function fillField(
  chromeBox: Chrome, want: string, value: string, timeout: number,
): Promise<Pressed> {
  const driver = chromeBox.driver;
  if (!value) {
    log.warn(`'${want || "입력칸"}' 칸에 넣을 값이 비어 있습니다. 건너뜁니다.`);
    return "none";
  }

  const deadline = Date.now() + timeout * 1000;
  let told = false;
  while (Date.now() < deadline) {
    const got = await tryFrames<[WebElement, WebElement | null, string]>(
      driver, () => driver.executeScript(FIND_FIELD_JS, want), { foreign: true });

    if (!got && !told) {
      // 첫 판에 못 찾으면 그 화면에 어떤 칸이 있었는지 한 번 적어 둔다. 기다리다
      // 실패하고 나서 "왜 못 찾았지" 를 다음 기회까지 미루지 않으려는 것이다.
      told = true;
      const seen = await tryFrames<string[]>(driver, () => driver.executeScript(FIELD_LIST_JS));
      let where = "?";
      let windows = 0;
      try {
        where = await driver.getCurrentUrl();
        windows = (await driver.getAllWindowHandles()).length;
      } catch {
        // 창이 닫혔다. 그것도 단서다.
      }
      log.info(`'${want || "입력칸"}' 칸을 아직 못 찾았습니다. 지금 화면의 칸: ` +
        (seen && seen.length ? seen.join(" / ") : "없음"));
      log.info(`  보고 있는 곳: ${where.slice(0, 120)} (창 ${windows}개, ` +
        `층 ${JSON.stringify(await framePaths(driver, 2))})`);
    }

    if (got) {
      const [element, opener, what] = got;

      // **칸을 먼저 연다.** 접어 둔 칸이 있다 — 카카오페이 카톡결제가 그렇다. 열지 않고
      // 키를 넣으면 어디에도 안 들어가고, 우리는 "넣었는데 비어 있다" 만 보게 된다.
      if (opener) {
        await press(driver, opener);
        await sleep(300);
      }

      // 그래도 포커스가 안 갔을 수 있다. 칸 자신에게도 한 번 청한다.
      try {
        await driver.executeScript("arguments[0].focus()", element);
      } catch {
        // 포커스는 못 줘도 넣어는 본다.
      }
      await sleep(200);

      try {
        // 비어 있으면 지우지 않는다. clear() 가 방금 잡은 포커스를 놓기도 한다.
        if (await element.getAttribute("value")) await element.clear();
        await element.sendKeys(value);
      } catch (e) {
        const first = String((e as Error).message).trim().split("\n")[0]?.slice(0, 80);
        log.debug(`직접 치지 못했습니다 (${first}). 자바스크립트로 넣습니다.`);
        try {
          await driver.executeScript(SET_VALUE_JS, element, value);
        } catch (e2) {
          log.debug(`자바스크립트로도 못 넣었습니다: ${(e2 as Error).message}`);
          return "quiet";
        }
      }

      // 정말 남았는지 본다. 자릿수를 세는 칸은 넣는 대로 다 안 받기도 하고, 리액트가
      // 되돌려 버리기도 한다. 눈으로 못 보니 여기서 확인해야 한다.
      let stuck = "";
      try {
        stuck = (await element.getAttribute("value")) || "";
      } catch {
        stuck = "";
      }
      if (!stuck) {
        log.warn(`'${want || "입력칸"}' 칸에 넣었지만 값이 남지 않았습니다 — ${what}`);
        return "quiet";
      }

      log.info(`결제창의 '${want || "입력칸"}' 칸을 채웠습니다 (${stuck.length}자) — ${what}`);
      return "ok";
    }

    // 이 창에 없으면 다른 창에 있을 수 있다. 누를 것을 찾을 때와 같은 이유다.
    await hopWindow(chromeBox);
    await sleep(500);
  }
  return "none";
}

interface Step { kind: "click" | "fill"; want: string; value: string; label: string }

/**
 * 설정에 적힌 것들을 편다.
 *
 *   "카톡결제"                              → 누른다
 *   {"fill": "휴대폰번호", "value": "010…"}  → 그 칸에 넣는다
 *
 * 한 목록에 섞어 두는 것은 순서 때문이다 — 누르고 넣고 또 누르는 흐름이라, 둘을 따로
 * 두면 순서가 사라진다.
 */
function steps(clicks: PgStep[] | null | undefined): Step[] {
  const out: Step[] = [];
  for (const item of clicks ?? []) {
    if (item && typeof item === "object") {
      const want = String(item.fill || item.label || "").trim();
      out.push({ kind: "fill", want, value: String(item.value || ""), label: `${want || "입력칸"} 입력` });
    } else {
      out.push({ kind: "click", want: String(item), value: "", label: String(item) });
    }
  }
  return out;
}

/** 화면에 보여 줄 이름들. 값은 빼고 무엇을 하는지만 남는다. */
export function stepLabels(clicks: PgStep[] | null | undefined): string[] {
  return steps(clicks).map((s) => s.label);
}

/**
 * 화면에 뭐라도 그려질 때까지 기다린다. → 그려졌으면 true
 *
 * 새로 열린 창은 잠깐 백지다. 그 순간에 찍으면 흰 사각형이 간다 — 실제로 QR 대신 빈
 * 이미지를 보낸 적이 있다.
 */
async function rendered(driver: WebDriver, timeout = 6): Promise<boolean> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    try {
      if (await driver.executeScript<boolean>(RENDERED_JS)) return true;
    } catch {
      // 창이 갈리는 중이다. 다음 바퀴에 다시 본다.
    }
    await sleep(200);
  }
  log.debug("화면이 그려지길 기다렸지만 비어 있습니다.");
  return false;
}

/**
 * 보고 있던 창이 닫혔으면 살아 있는 창으로 옮긴다. → 옮길 데가 있으면 true
 *
 * **결제창이 스스로 닫히는 수단이 있다.** 카카오페이 카톡결제가 그렇다 — 결제요청을
 * 누르면 그 창은 할 일을 마쳤다며 닫히고, 이야기는 주문서 창에서 이어진다. 없어진 창을
 * 붙들고 있으면 하필 사람에게 알려야 할 바로 그 순간에 전부 무너진다.
 */
export async function liveWindow(chromeBox: Chrome): Promise<boolean> {
  const driver = chromeBox.driver;
  try {
    await driver.getCurrentUrl();
    return true;
  } catch {
    // 창이 닫혔다. 아래에서 남은 창을 찾는다.
  }

  let handles: string[];
  try {
    handles = await driver.getAllWindowHandles();
  } catch {
    return false;
  }
  if (!handles.length) return false;

  const main = chromeBox.mainWindow;
  try {
    await driver.switchTo().window(main && handles.includes(main) ? main : handles[handles.length - 1]!);
  } catch {
    return false;
  }
  log.debug("보던 창이 닫혔습니다. 남은 창으로 옮깁니다.");
  return true;
}

/**
 * 결제창이 새 창으로 떴으면 그리로 옮긴다. → 옮겼으면 true
 *
 * **안 떴다고 돌아서면 안 된다.** 이 사이트의 KSPay 는 새 창이 아니라 주문서 위에
 * iframe 레이어로 얹힌다. 그때는 지금 창에 그대로 있는 것이고, 프레임을 뒤지면 나온다.
 */
async function paymentWindow(chromeBox: Chrome, timeout = 3): Promise<boolean> {
  const driver = chromeBox.driver;
  const main = chromeBox.mainWindow;
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const others = (await driver.getAllWindowHandles()).filter((h) => h !== main);
    if (others.length) {
      await driver.switchTo().window(others[others.length - 1]!);
      return true;
    }
    await sleep(300);
  }

  if (main && (await driver.getAllWindowHandles()).includes(main)) {
    await driver.switchTo().window(main);
  }
  return false;
}

/**
 * 새 창이 떴으면 그리로 옮긴다. **기다리지 않는다.** → 옮겼으면 true
 *
 * paymentWindow 와 하는 일은 같지만 잠을 자지 않는다. 클릭 하나 누를 때마다 창이
 * 갈렸는지 보려면 이쪽이어야 한다 — 없는 창을 0.6초씩 기다리면 여덟 번 누르는 동안
 * 5초가 그냥 사라진다.
 */
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

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /\b01[016-9][-\s]?\d{3,4}[-\s]?\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const INPUT_TAG_RE = /<input\b[^>]*>/gi;
const TYPE_RE = /\btype\s*=\s*["']?([\w-]+)/i;
const VALUE_RE = /(\bvalue\s*=\s*)(["'])([\s\S]*?)\2/gi;
// 사람이 적어 넣는 칸. 여기에 이름·연락처·주소가 들어간다. type 이 없으면 text 다.
const TYPED_INPUTS = new Set(["", "text", "email", "tel", "password", "number", "search", "url", "hidden"]);

/**
 * 사람이 적는 입력칸의 value 를 가린다.
 *
 * 라디오·체크박스의 value 는 남긴다. 그건 사람이 적은 값이 아니라 화면이 무엇을 고를 수
 * 있는지 말해 주는 표라, 나중에 결제수단을 고르게 할 때 볼 것이 여기 있다.
 */
function maskInputs(text: string): string {
  return text.replace(INPUT_TAG_RE, (tag) => {
    const kind = TYPE_RE.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!TYPED_INPUTS.has(kind)) return tag;
    return tag.replace(VALUE_RE, (_m, head: string, quote: string) => `${head}${quote}(가림)${quote}`);
  });
}

/**
 * 받아 적은 것에서 사람 정보를 지운다.
 *
 * 이 파일은 무엇이 왜 안 눌렸는지 보자고 남기는 것이지, 주문서에 적힌 이름·주소·연락처를
 * 보자는 게 아니다. 남 주고 물어볼 일도 생기는 파일이라 지워 두는 편이 낫다.
 */
function scrub(text: string): string {
  return maskInputs(text)
    .replace(EMAIL_RE, "(이메일)")
    .replace(PHONE_RE, "(휴대폰)")
    .replace(CARD_RE, "(긴숫자)");
}

/**
 * 결제창 스크립트에게 직접 물어본다. → ["식 → 답", …]
 *
 * 화면만 봐서는 왜 안 눌렸는지 모를 때가 있다. 핸들러가 안 붙은 것인지, 붙었는데 가드에
 * 걸린 것인지는 겉이 똑같다. 그럴 때 물어볼 곳은 그 창의 자바스크립트뿐이다.
 */
async function probePayment(driver: WebDriver, expressions: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const frame of await framePaths(driver, 2)) {
    let where: string;
    try {
      if ((await descend(driver, frame)) === null) continue;
      where = await driver.executeScript<string>("return location.href");
    } catch {
      continue;
    }
    if (where.includes(HOST)) continue;

    out.push(`\n[probe ${JSON.stringify(frame)}] ${where}`);
    for (const expr of expressions) {
      let answer: string;
      try {
        answer = await driver.executeScript<string>(
          "try { return String(" + expr + "); } catch (e) { return 'ERR: ' + e.message; }");
      } catch (e) {
        answer = `ERR: ${(e as Error).message}`;
      }
      out.push(`  ${expr}\n    → ${answer}`);
    }
  }
  await driver.switchTo().defaultContent().catch(() => undefined);
  return out;
}

/**
 * 결제창에 무엇이 보였는지 프레임별로 적어 둔다. → 적었으면 true
 *
 * 못 눌렀을 때 추측으로 셀렉터를 고치면 다음 기회에 또 틀린다. 결제창은 아무 때나 띄워
 * 볼 수 있는 화면이 아니라, 한 번 놓치면 다음 재고까지 기다려야 한다.
 */
export async function dumpPayment(
  driver: WebDriver, path: string, probes?: string[] | null,
): Promise<boolean> {
  const lines: string[] = [];
  const html: string[] = [];
  for (const frame of await framePaths(driver, 2)) {
    let where: string;
    let found: string[];
    try {
      if ((await descend(driver, frame)) === null) continue;
      where = await driver.executeScript<string>("return location.href");
      found = await driver.executeScript<string[]>(DUMP_JS);
    } catch (e) {
      lines.push(`\n[frame ${frame.length ? JSON.stringify(frame) : "top"}] 읽지 못함: ${(e as Error).message}`);
      continue;
    }
    lines.push(`\n[frame ${frame.length ? JSON.stringify(frame) : "top"}] ${where}  (${found.length}개)`);
    lines.push(...found.map((item) => `  ${item}`));

    // 결제창 쪽은 마크업까지 남긴다. 요약만으로는 왜 안 눌렸는지 알 수 없을 때가 있다.
    // 우리 사이트 쪽은 이미 아는 화면이라 뺀다.
    if (!where.includes(HOST)) {
      let body: string | null = null;
      try {
        body = await driver.executeScript<string>("return document.body.outerHTML");
      } catch {
        body = null;
      }
      if (body) {
        html.push(`\n\n===== [frame ${JSON.stringify(frame)}] ${where} =====\n${body.slice(0, 200000)}`);
      }
    }
  }

  await driver.switchTo().defaultContent().catch(() => undefined);
  if (probes && probes.length) {
    lines.push("", "", "===== 물어본 것 =====", ...(await probePayment(driver, probes)));
  }
  lines.push(...html);
  if (!lines.length) return false;
  try {
    writeFileSync(path, scrub(lines.join("\n")), "utf-8");
  } catch (e) {
    log.warn(`결제창 내용을 적지 못했습니다: ${(e as Error).message}`);
    return false;
  }
  return true;
}

/** 결제창에서 할 일을 사람이 읽을 이름으로. 이건 자판 입력 자리다. */
export const PIN_LABEL = "간편결제 비밀번호";

/** 자판 읽기의 결과. [상태, [숫자, 키, x, y], 확인 키, 디버그] — 키의 화면 좌표도 함께. */
type KeypadHit = ["found" | "odd", [string, WebElement, number, number][], WebElement | null, string];

/**
 * 간편결제 비밀번호 자판을 읽어 차례로 누른다. → "ok" / "quiet" / "none"
 *
 * 자판은 **매 결제마다 숫자 위치가 바뀐다.** 그래서 어디에 어떤 숫자가 있는지 화면에서
 * 읽은 표로만 누를 수 있다 — 고정된 좌표나 셀렉터로는 두 번째 결제부터 틀린다.
 *
 * **누를 자리마다 자판을 다시 읽고, 누를 때마다 점 개수로 확인한다.** 네이버페이
 * 자판은 누를 때마다 숫자 위치가 바뀔 수 있어서, 처음에 읽은 표를 여섯 자리 내내
 * 쓰면 갈린 화면의 키를 누르는 꼴이 된다 — 실제로 마지막 자리만 무시된 판이 있었다.
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
    log.warn(`간편결제 비밀번호가 ${digits.length}자리입니다. 네이버페이는 보통 6자리입니다.`);
  }

  // 한 키를 누르는 한 번의 시도. 참조로 누르고, 안 되면(자리가 갈려 참조가 죽었다)
  // 자판을 다시 읽어 새 참조로, 그것도 안 되면 **새로 읽은 좌표**로 누른다.
  // 좌표는 읽은 직후의 것이어야 한다 — 오래된 좌표는 갈린 화면의 다른 숫자를 가리킨다.
  // 실패하면 그 이유를 돌려준다(로그에 그대로 남긴다).
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
    for (const e of again[1]) fresh.set(e[0], e);
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

  const deadline = Date.now() + timeout * 1000;
  let typed = 0;
  let failed = false;
  while (Date.now() < deadline && typed < digits.length && !failed) {
    const ch = digits[typed]!;

    // **이 자리를 누른다 — 점이 실제로 하나 늘 때까지 되풀이한다.** 자판이 아직
    // 준비 안 됐거나(누르자마자는 핸들러가 안 붙어 있을 수 있다) 갈린 화면을
    // 눌렀을 수 있으니, 자판을 다시 읽고 몇 번이고 시도한다. 시간은 전체 예산
    // (timeout)이 한도를 짠다.
    let done = false;
    while (Date.now() < deadline && !done) {
      // 자판은 결제창이 새 창으로 떴을 수도 있다. 누를 것을 찾을 때와 같은 이유다.
      if (await hopWindow(chromeBox)) log.debug("자판을 찾아 새 창으로 옮겼습니다.");

      const got = await tryFrames<KeypadHit | null>(
        driver, () => driver.executeScript(KEYPAD_JS), { foreign: true });
      if (!got) {
        await sleep(400);
        continue;
      }
      const [status, table, confirm, info] = got;
      if (status !== "found") {
        log.warn(`자판을 읽었는데 숫자가 어긋납니다 (${info || "?"}). 화면을 확인해 주세요.`);
        return "none";
      }
      log.info(`자판(${typed + 1}번째 자리): ${info || ""}`);

      const byDigit = new Map<string, [string, WebElement, number, number]>();
      for (const entry of table) byDigit.set(entry[0], entry);
      const entry = byDigit.get(ch);
      if (!entry) {
        log.warn(`자판에 없는 숫자가 있습니다: ${ch}. 화면을 확인해 주세요.`);
        return "none";
      }

      const why = await pressOnce(entry);
      if (why) {
        log.warn(`'${ch}' 키를 누르지 못했습니다 — ${why}`);
      }
      if (await waitDots(chromeBox, typed + 1)) {
        done = true;
      } else {
        log.warn(`'${ch}' 를 눌렀는데 점이 안 늘었습니다. 다시 시도합니다.`);
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
  if (still && still[2]) {
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
  const left = await tryFrames<KeypadHit | null>(
    driver, () => driver.executeScript(KEYPAD_JS), { foreign: true });
  if (left) {
    log.warn("비밀번호를 눌렀는데 자판이 그대로입니다. 화면을 확인해 주세요.");
    return "quiet";
  }
  return "ok";
}

/**
 * 채워진 비밀번호 점 개수가 기대값이 될 때까지 기다린다. → 되면 true
 *
 * 누른 자리가 정말 먹혔는지는 눌러 보기 전에는 모른다 — 눌렀는데 점이 안 늘었다면
 * 그 키는 갈린 화면의 것이었다. 자판마다 점의 클래스 이름이 다를 수 있으니, 이름이
 * "Password_dot" 인 것을 세되 그중 "Password_on" 이 붙은 것만 센다. 리액트가 점을
 * 늦게 그릴 수 있으니 잠깐 동안 되풀이해서 본다.
 */
async function waitDots(chromeBox: Chrome, expect: number, timeoutMs = 1500): Promise<boolean> {
  const driver = chromeBox.driver;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const got = await tryFrames<number[] | null>(
        driver, () => driver.executeScript(DOTS_JS), { foreign: true });
      if (got && got[0] === expect) return true;
    } catch {
      // 창이 갈렸다. 다음 바퀴에 다시 본다.
    }
    await sleep(150);
  }
  return false;
}

/**
 * 화면 좌표로 누른다. → 눌렀으면 true
 *
 * 잡아 둔 키 참조가 갈린 화면 때문에 죽었을 때 쓰는 대체 길이다. 참조 없이
 * 좌표만으로 누르므로, 자리가 그대로면 죽은 참조와는 상관없이 눌린다.
 * 좌표는 키의 중심(보기 화면 기준)이다 — 자판이 이 창의 맨 위 문서에 있으므로
 * 보기 화면 좌표가 곧 페이지 좌표다.
 */
async function clickAt(driver: WebDriver, x: number, y: number): Promise<boolean> {
  try {
    await driver.actions({ async: true }).move({ x, y, duration: 0 }).click().perform();
    return true;
  } catch (e) {
    log.debug(`좌표 클릭이 안 됩니다 (${(e as Error).message})`);
    return false;
  }
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

export interface Capture {
  shot: Buffer | null;
  done: string[];
  quiet: string[];
  missed: string[];
}

/**
 * 결제창에서 정해진 것들을 누르고 화면을 찍는다.
 *
 * **어느 단계에서 멈췄든 화면은 찍어서 돌려준다.** 못 눌렀다고 빈손으로 오면 폰에서
 * 지금 무슨 화면인지 알 길이 없다. 실패한 화면이라도 보이는 편이 훨씬 낫다.
 *
 * 결제 확정은 하지 않는다. 카카오페이 QR 은 폰으로 찍어서 사람이 승인하는 것이고,
 * 여기서 하는 일은 그 화면을 폰까지 옮겨 주는 것뿐이다.
 */
export async function capturePayment(
  chromeBox: Chrome,
  opts: {
    clicks?: PgStep[] | null; timeout?: number; settle?: number; dumpPath?: string;
    probes?: string[] | null; pin?: string; finish?: PgStep[] | null;
  } = {},
): Promise<Capture> {
  const driver = chromeBox.driver;
  const clicks = opts.clicks ?? PG_CLICKS;
  const timeout = opts.timeout ?? 15;
  const settle = opts.settle ?? 3;

  // 새 창으로 떴으면 그리로, 아니면 지금 창에 얹힌 것이다. 어느 쪽이든 계속 간다.
  if (await hopWindow(chromeBox)) log.debug("결제창이 새 창으로 떴습니다.");
  else log.debug("새 창이 없습니다. 지금 창에 얹힌 것으로 보고 프레임을 뒤집니다.");

  const done: string[] = [];
  const quiet: string[] = [];
  const missed: string[] = [];

  const clickSteps = steps(clicks);
  for (const step of clickSteps) {
    // **누르는 도중에 창이 갈린다.** 신한 인증창이 그렇다 — 2단계에서 다음을 누르면
    // 거기서 새 창으로 열린다. 그 뒤에 누를 것은 새 창에 있는데, 시작할 때 한 번 본
    // 것으로는 알 수 없다. 그래서 누르기 전에 매번 본다. 기다리지는 않는다.
    if (await hopWindow(chromeBox)) log.debug(`새 창으로 옮겨 '${step.label}' 를 찾습니다.`);

    const result = step.kind === "fill"
      ? await fillField(chromeBox, step.want, step.value, timeout)
      : await clickText(chromeBox, step.want, timeout, { foreign: true });

    if (result === "ok") {
      done.push(step.label);
    } else if (result === "quiet") {
      // 눌리긴 했다. 화면에 티가 안 났을 뿐이라 대개는 먹힌 것이다.
      done.push(step.label);
      quiet.push(step.label);
    } else {
      missed.push(step.label);
      // 앞 단계를 못 눌렀으면 다음 것도 대개 안 나온다. 그래도 끝까지 시도한다 —
      // 창에 따라 순서가 다를 수 있고, 어차피 화면은 찍어서 보낸다.
    }
  }

  // 간편결제 비밀번호. pg_password 를 적어 뒀으면 자판을 읽어 차례로 누른다. 마지막
  // 클릭(결제하기)이 실패했으면 자판이 아예 없는 것이므로 시도하지 않는다.
  const pin = (opts.pin || "").replace(/\D/g, "");
  const lastLabel = clickSteps.length ? clickSteps[clickSteps.length - 1]!.label : "";
  if (pin && !missed.includes(lastLabel)) {
    const pinResult = await enterPin(chromeBox, pin, Math.min(timeout, 12));
    if (pinResult === "ok") {
      done.push(PIN_LABEL);
    } else if (pinResult === "quiet") {
      done.push(PIN_LABEL);
      quiet.push(PIN_LABEL);
    } else {
      missed.push(PIN_LABEL);
    }

    // 비밀번호를 넣고 나서 오는 **마지막 확인 화면**(동의 체크 + 결제)이 있으면
    // 찍기 전에 누른다. 찍기 + settle 이 끝날 때까지 기다렸다가 누르면, 화면이 이미
    // 닫혀 버린다 — 2026-08-25 에 여섯 자리를 넣고 9초 만에 창이 닫힌 판이 있었다.
    const finish = opts.finish ?? [];
    if (pinResult !== "none" && finish.length) {
      const leftSteps = [...finish];
      const finishDeadline = Date.now() + 8000;
      while (Date.now() < finishDeadline && leftSteps.length) {
        const left = await tryFinish(chromeBox, leftSteps);
        if (left.length === leftSteps.length) {
          // 아직 화면이 안 왔다. 잠깐 기다렸다 다시 본다.
          await sleep(500);
        }
        leftSteps.length = 0;
        leftSteps.push(...left);
      }
      if (leftSteps.length) {
        log.info(`확인 화면에서 남은 것: ${leftSteps.map((s) => String(s)).join(" · ")} ` +
          "(결제가 끝나기를 지켜보는 동안 계속 시도합니다)");
      }
    }
  }

  // 누르다가 그 창이 닫혔을 수 있다. 카카오페이 카톡결제가 그렇다. 남은 일(찍기·받아
  // 적기)은 주문서 창에서 마친다. 여기서 손을 놓으면 정작 알려야 할 순간에 아무것도 안 간다.
  if (!(await liveWindow(chromeBox))) {
    log.warn("결제창이 닫혔고 남은 창도 없습니다. 화면을 찍지 못합니다.");
    return { shot: null, done, quiet, missed };
  }

  // 누르다가 새 창이 떴을 수도 있다(결제창의 다음 버튼은 title 이 "새창열림" 이다).
  if (await paymentWindow(chromeBox, 3)) log.debug("누른 뒤 새 창이 떴습니다. 그쪽을 찍습니다.");

  // **백지를 찍지 않는다.** 그려지는 것을 보고 나서 settle 만큼 더 준다 — QR 은 문서가
  // 선 뒤에 그려진다.
  if (!(await rendered(driver, Math.max(6, settle * 2)))) {
    log.warn("찍으려는 화면이 비어 있습니다. 빈 그림이 갈 수 있습니다 " +
      "(pg_settle_seconds 를 올려 보세요)");
  }
  await sleep(settle * 1000);

  // **어긋난 것이 있을 때만 받아 적는다.** 이 일은 프레임마다 200KB 짜리 마크업을 긁어
  // 오느라 3초쯤 걸리는데, 그 3초는 화면을 폰으로 보내기 전에 붙는다. QR 은 시한이 있는
  // 물건이라 다 잘 눌린 판에서까지 값을 치를 이유가 없다.
  if (opts.dumpPath && (missed.length || quiet.length)) {
    if (await dumpPayment(driver, opts.dumpPath, opts.probes)) {
      log.info(`결제창 내용을 적어 뒀습니다: ${basename(opts.dumpPath)}`);
    }
  }

  await driver.switchTo().defaultContent().catch(() => undefined);
  let shot: Buffer | null = null;
  try {
    shot = Buffer.from(await driver.takeScreenshot(), "base64");
  } catch (e) {
    log.warn(`화면을 찍지 못했습니다: ${(e as Error).message}`);
  }
  return { shot, done, quiet, missed };
}

export interface PaidDetails { order_no: string; name: string; image: string }

/**
 * 주문완료 화면에서 주문번호·상품명·사진 주소를 읽는다.
 * 여기서 실패해도 결제는 이미 끝난 일이다. 알림이 조금 덜 친절해질 뿐이라 조용히 넘긴다.
 */
export async function paidDetails(chromeBox: Chrome): Promise<Partial<PaidDetails>> {
  const driver = chromeBox.driver;
  let got: [string, string, string] | null;
  try {
    got = await tryFrames<[string, string, string]>(
      driver, () => driver.executeScript(PAID_INFO_JS));
  } catch (e) {
    log.debug(`주문완료 화면을 읽지 못했습니다: ${(e as Error).message}`);
    return {};
  }
  if (!got) return {};
  const [order, name, image] = got;
  return { order_no: order || "", name: name || "", image: image || "" };
}

/**
 * 마지막 확인 화면에서 눌러야 할 것들. → 아직 못 누른 것들
 *
 * 카톡·앱으로 승인이 끝나면 결제창이 확인 화면을 한 번 더 내민다(동의 체크 + 결제).
 * 그건 pg_clicks 가 다 지나간 뒤에 오므로 그때는 누를 사람이 없다. 그래서 결제가
 * 끝나기를 지켜보는 동안 계속 두드려 본다 — 화면이 아직 안 왔으면 못 찾을 뿐이고,
 * 오면 그때 눌린다. 한 번 누른 것은 목록에서 빠지므로 두 번 누르지 않는다.
 */
async function tryFinish(chromeBox: Chrome, pending: PgStep[], timeout = 2): Promise<PgStep[]> {
  const driver = chromeBox.driver;
  let left = [...pending];
  let handles: string[];
  try {
    handles = [...(await driver.getAllWindowHandles())];
  } catch {
    return left;
  }

  const main = chromeBox.mainWindow;
  if (main && handles.includes(main)) {
    handles = [main, ...handles.filter((h) => h !== main)];
  }

  for (const handle of handles) {
    if (!left.length) break;
    try {
      await driver.switchTo().window(handle);
    } catch {
      continue;
    }

    // **순서대로만 나아간다.** 앞엣것을 못 찾았으면 그 화면이 아직 아니라는 뜻이므로
    // 뒤엣것도 건드리지 않는다. 이걸 안 지켰다가 사고가 났다 — 승인이 끝나기도 전에
    // "결제" 를 찾아 나서서 단계 목록을 누르고, 다 한 것으로 치고 목록에서 빼버렸다.
    while (left.length) {
      const step = steps([left[0]!])[0]!;
      const result = step.kind === "fill"
        ? await fillField(chromeBox, step.want, step.value, timeout)
        : await clickText(chromeBox, step.want, timeout, { foreign: true, tries: 1 });
      if (result === "none") break;
      left = left.slice(1);
      log.info(`확인 화면에서 '${step.label}' 를 처리했습니다`);
    }
  }
  return left;
}

/**
 * 결제가 끝났는지 창을 지켜본다. → 끝났으면 화면(png), 아니면 null
 *
 * **글자만 보면 안 된다.** 주문서 자신이 단계 표시줄에 "03 주문완료" 를 달고 있어서,
 * 결제를 시작하자마자 끝난 줄로 읽는다. 실제로 그렇게 오판해 결제창을 찍어 놓고
 * "결제 완료" 라고 보냈다.
 *
 * 그래서 주소를 먼저 본다. 주소에 걸리면 그것만으로 끝난 것이고, 글자로 판정하는 것은
 * **주문서를 떠났을 때만** 인정한다. 아직 주문서에 서 있으면 그 글자는 breadcrumb 이다.
 */
export async function waitPaid(
  chromeBox: Chrome, markers: string[], timeout: number,
  opts: {
    onTick?: (left: number) => void; notYet?: string; finish?: PgStep[] | null;
    dumpPath?: string;
  } = {},
): Promise<Buffer | null> {
  const driver = chromeBox.driver;
  const notYet = opts.notYet ?? "/order/order.do";
  let pending = [...(opts.finish ?? [])];
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    for (const handle of await driver.getAllWindowHandles()) {
      let where: string;
      let text: string;
      try {
        await driver.switchTo().window(handle);
        where = await driver.getCurrentUrl();
        text = await driver.executeScript<string>("return (document.body.innerText || '')");
      } catch {
        continue;
      }

      const byUrl = markers.some((m) => where.includes(m));
      const leftOrder = !(notYet && where.includes(notYet));
      const byText = leftOrder && markers.some((m) => text.includes(m));
      if (byUrl || byText) {
        log.debug(`결제 완료로 봅니다 (${byUrl ? "주소" : "화면 글자"}) — ${where}`);
        await rendered(driver, 5);
        try {
          return Buffer.from(await driver.takeScreenshot(), "base64");
        } catch {
          return Buffer.alloc(0);
        }
      }
    }

    // 비밀번호 뒤의 마지막 확인 화면(동의 체크 + 결제)이 오면 눌러 준다. 올 때까지
    // 계속 두드린다.
    if (pending.length && (await liveWindow(chromeBox))) {
      pending = await tryFinish(chromeBox, pending);
    }

    if (opts.onTick) opts.onTick(Math.floor((deadline - Date.now()) / 1000) + 1);
    await sleep(2000);
  }

  // 제때 못 봤다. 무엇이 떠 있는지 받아 적어 두면 다음에 고칠 근거가 된다.
  if (opts.dumpPath) {
    try {
      if (await dumpPayment(driver, opts.dumpPath)) {
        log.info(`결제 확인 화면 내용을 적어 뒀습니다: ${basename(opts.dumpPath)}`);
      }
    } catch {
      // 받아 적기까지 실패해도 기다림은 이미 끝난 일이다.
    }
  }
  return null;
}

/** 주문서에서 남은 클릭을 대신한다. → [어디까지 갔는가, 사유] */
async function finish(
  chromeBox: Chrome, action: Action, timeout: number,
): Promise<[Stage, string | null]> {
  const reason = await agree(chromeBox.driver);
  if (reason) return ["opened", reason];
  if (action !== "submit") return ["agreed", null];

  const why = await submit(chromeBox, timeout);
  if (why) return ["agreed", why];
  return ["submitted", null];
}

/**
 * 크롬을 미리 띄워 놓는다. → Chrome (못 띄우면 null)
 *
 * 크롬 프로세스가 서는 데 1.6초가 든다. 재고가 열린 뒤에 그걸 시작하면 그 시간이
 * 고스란히 늦는다. 지켜보는 동안은 어차피 놀고 있으니 그때 미리 세워 두고, 정작 필요할
 * 때는 주소만 넣는다. 쿠키는 쓸 때 새로 심는다 — 지켜보는 사이에 사이트가 토큰을
 * 몇 번이고 새로 발급하기 때문이다.
 */
export async function preheat(
  headless = false, profile: string | null = null, offscreen = false,
): Promise<Chrome | null> {
  try {
    const box = await makeDriver(headless, profile, offscreen);
    log.debug("크롬을 미리 띄워 뒀습니다.");
    return box;
  } catch (e) {
    log.debug(`미리 띄우기 실패 (${(e as Error).message}). 필요할 때 다시 해봅니다.`);
    return null;
  }
}

/**
 * 로그인 페이지를 열어 두고 사람이 로그인할 때까지 기다린다.
 *
 * **로그인은 사람이 한다.** 아이디도 비밀번호도 여기서 다루지 않는다. 우리가 하는 일은
 * 창을 알맞은 자리에 띄워 두고, 끝났는지 지켜보는 것뿐이다.
 *
 * 끝났는지는 주소로 본다. 로그인 페이지를 벗어나면 된 것이다 — 어느 사이트든 로그인에
 * 성공하면 그 주소에서 떠나기 때문에, 화면 구조를 알 필요가 없다.
 */
export async function waitLogin(
  chromeBox: Chrome, url: string, marker: string, timeout: number,
  onTick?: (left: number) => void,
): Promise<boolean> {
  const driver = chromeBox.driver;
  try {
    await driver.get(url);
  } catch (e) {
    log.warn(`로그인 페이지를 열지 못했습니다: ${(e as Error).message}`);
    return false;
  }

  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    if (!(await alive(chromeBox))) {
      log.warn("로그인 창이 닫혔습니다.");
      return false;
    }
    let here: string;
    try {
      here = await driver.getCurrentUrl();
    } catch {
      return false;
    }
    if (!here.includes(marker)) return true;
    if (onTick) onTick(Math.floor((deadline - Date.now()) / 1000));
    await sleep(1000);
  }
  return false;
}

/** 미리 띄워 둔 창이 아직 살아 있는가. 사람이 닫았을 수 있다. */
export async function alive(chromeBox: Chrome | null | undefined): Promise<boolean> {
  if (!chromeBox) return false;
  try {
    return (await chromeBox.driver.getAllWindowHandles()).length > 0;
  } catch {
    return false;
  }
}

export interface Opened {
  chrome: Chrome;
  ok: boolean;
  reason: string | null;
  stage: Stage;
}

/**
 * 쿠키를 심은 크롬으로 주문서를 연다.
 *
 * "어디까지" 는 opened / agreed / submitted 중 하나다. action 이 시킨 데까지 못 갔으면
 * ok 는 그대로 true 여도 사유가 붙는다 — 창은 이미 떠 있고, 못 누른 건 사람이 누르면 된다.
 *
 * 크롬 자체를 못 띄우면 BrowserError 를 낸다. 그 경우는 부른 쪽에서 기본 브라우저로
 * 여는 편이 낫다 — 주문서를 못 여는 것보다 확인을 못 하는 게 낫다.
 */
export async function openOrder(
  url: string, cookie: string,
  opts: {
    action?: Action; headless?: boolean; timeout?: number; chrome?: Chrome | null;
    profile?: string | null; offscreen?: boolean;
  } = {},
): Promise<Opened> {
  const action = opts.action ?? "open";
  const timeout = opts.timeout ?? 20;
  if (!ACTIONS.includes(action)) {
    throw new BrowserError(`order_action 은 ${ACTIONS.join(" / ")} 중 하나입니다: ${action}`);
  }

  // 미리 띄워 둔 창이 있으면 그걸 쓴다. 없거나 사람이 닫았으면 지금 띄운다.
  const box = (await alive(opts.chrome)) && opts.chrome
    ? opts.chrome
    : await makeDriver(opts.headless ?? false, opts.profile ?? null, opts.offscreen ?? false);

  try {
    // 홈을 거치지 않는다. CDP 로 심으면 아직 아무 데도 안 갔어도 되고, 그러면 손님용
    // 세션이 생길 일도 없어 지울 것도 없다. 곧장 주문서로 간다.
    const planted = await inject(box, cookie);
    if (!planted) throw new BrowserError("심을 쿠키가 없습니다");
    log.debug(`크롬에 쿠키 ${planted}개를 심었습니다.`);

    await box.driver.get(url);
    // 결제창은 새 창으로 뜬다. 나중에 어느 것이 결제창인지 가리려면 지금 창을 기억해 둔다.
    box.mainWindow = await box.driver.getWindowHandle();
    const [ok, reason] = await verify(box.driver, url, timeout);

    // 주문서에 도착했을 때만 손을 댄다. 장바구니(cart.do)에는 동의 항목도 결제하기도 없다.
    let stage: Stage = "opened";
    let why = reason;
    if (ok && action !== "open" && new URL(url).pathname.includes("/order/order.do")) {
      [stage, why] = await finish(box, action, timeout);
    }
    return { chrome: box, ok, reason: why, stage };
  } catch (e) {
    if (e instanceof BrowserError) {
      await box.quit();
      throw e;
    }
    // 창은 남긴다. 무엇이 떠 있는지 사람이 봐야 판단이 된다.
    return { chrome: box, ok: false, reason: `주문서를 확인하는 중 오류: ${(e as Error).message}`, stage: "opened" };
  }
}
