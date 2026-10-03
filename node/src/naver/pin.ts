/**
 * 네이버페이 간편결제 비밀번호 자판을 읽어 누른다. **bnkr-test/browser.ts 에서 베껴 왔다.**
 *
 * 그쪽은 반다이남코몰에서 네이버페이로 결제하면서 이 자판을 만났고(2026-08-24~25),
 * 여러 번 틀려 가며 여섯 자리를 다 넣는 데까지 갔다(bnkr-test-buy.log 2026-08-25 00:34).
 * 뜬 창은 pay.naver.com/authentication/pw/check 였다. 네이버 스토어에서 네이버페이로
 * 결제할 때도 같은 인증 화면이 뜰 것으로 보고 그대로 가져온다 — **네이버 스토어 쪽에서는
 * 아직 못 봤다.** 처음 한 판은 --dump-pay 로 받아 적어 두는 것이 좋다.
 *
 * 들이지 않고 베낀 이유: bnkr-test/browser.ts 는 제 log·config 를 들인다. 들이는 순간
 * 그쪽 모듈이 서면서 로그가 섞인다. 자판 읽기(KEYPAD_JS)·누르기(enterPin)만 떼어 온다.
 * 고칠 일이 생기면 **양쪽을 같이 고친다.**
 *
 * **비밀번호 값은 어디에도 적지 않는다.** 로그에는 자릿수만 남는다. 틀리면 재시도하지
 * 않는다 — 몇 번 틀리면 결제가 잠기니까, 사람이 보게 남기고 물러난다.
 */
import type { WebDriver, WebElement } from "selenium-webdriver";
import { descend, framePaths, press, type Chrome, type Pressed } from "../browser.js";
import { log } from "../log.js";
import { sleep } from "../util.js";

// 화면에 보이는가. (bnkr-test 의 VISIBLE_JS 그대로 — KEYPAD_JS 의 findConfirm 이 쓴다)
// offsetParent 로 보면 안 된다. position:fixed 인 요소는 보이는데도 null 이다.
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
export const KEYPAD_JS = VISIBLE_JS + `
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

/** 결제창에서 할 일을 사람이 읽을 이름으로. 이건 자판 입력 자리다. */
export const PIN_LABEL = "간편결제 비밀번호";

/** 자판 읽기의 결과. [상태, [숫자, 키, x, y], 확인 키, 디버그] — 키의 화면 좌표도 함께. */
type KeypadHit = ["found" | "odd", [string, WebElement, number, number][], WebElement | null, string];

// 인증 화면의 주소에 붙는 자국. 이 프레임·창을 먼저 뒤진다 — 밑에 깔린 주문서에도
// "확인" 같은 글자가 있어서 위에서부터 훑으면 엉뚱한 데를 볼 수 있다.
const AUTH_MARK = "/authentication/";

/** 인증 화면 쪽 프레임을 먼저 뒤지게 줄을 세운다. */
async function foreignFirst(driver: WebDriver, paths: number[][]): Promise<number[][]> {
  const scored: [number[], boolean][] = [];
  for (const path of paths) {
    let foreign = false;
    try {
      if ((await descend(driver, path)) !== null) {
        const here = await driver.executeScript<string>("return location.href");
        foreign = here.includes(AUTH_MARK) || !here.includes("orders.pay.naver.com");
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

/**
 * 인증 화면이 새 창으로 떴으면 그리로 옮긴다. **기다리지 않는다.** → 옮겼으면 true
 *
 * 창이 여럿이면 주소에 /authentication/ 이 붙은 창을 고른다. 없으면 가장 나중 창이다.
 * 네이버 판은 주문서도 새 창일 수 있어서(arrived 참고) "처음 창이 아닌 것" 만으로는
 * 모자라다.
 */
async function hopWindow(chromeBox: Chrome): Promise<boolean> {
  const driver = chromeBox.driver;
  try {
    const handles = await driver.getAllWindowHandles();
    const current = await driver.getWindowHandle().catch(() => "");
    let target: string | null = null;
    for (const handle of handles) {
      await driver.switchTo().window(handle);
      if ((await driver.getCurrentUrl()).includes(AUTH_MARK)) target = handle;
    }
    if (!target) {
      const others = handles.filter((h) => h !== chromeBox.mainWindow);
      target = others.length ? others[others.length - 1]! : current;
    }
    await driver.switchTo().window(target || current);
    return target !== current;
  } catch {
    return false;
  }
}

/** 지금 어느 창·프레임에든 비밀번호 자판이 떠 있는가. 결제하기 뒤 신호로 쓴다. */
export async function keypadUp(chromeBox: Chrome): Promise<boolean> {
  const driver = chromeBox.driver;
  let handles: string[];
  try {
    handles = await driver.getAllWindowHandles();
  } catch {
    return false;
  }
  for (const handle of handles) {
    try {
      await driver.switchTo().window(handle);
    } catch {
      continue;
    }
    const got = await tryFrames<KeypadHit | null>(
      driver, () => driver.executeScript(KEYPAD_JS), { foreign: true });
    if (got) return true;
  }
  return false;
}


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
