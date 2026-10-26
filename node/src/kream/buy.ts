/**
 * 브랜드배송 상품 사기 — 상품 페이지의 "구매하기" 부터 주문 완료까지.
 *
 *   상품 페이지 ─ 구매하기 ─▶ 옵션 고르기(사이즈·ONE SIZE) ─▶ 주문서(결제 화면) ─ 결제 수단·동의 ─▶ 결제하기 ─▶ 비밀번호 ─▶ 완료
 *
 * 화면 글자로 찾아 누른다 (KREAM 은 화면을 서버가 내려 주는 틀로 그려 class 이름이 자주 바뀐다). 못 찾으면 그 자리의
 * 화면·HTML 을 kream-shots/ 에 담고 창을 사람에게 넘긴다 — 사람이 마저 하면 된다.
 *
 * 2026-10-25 에 로그인한 크롬으로 주문서까지 확인했다 (상품 1087725 · ONE SIZE):
 *   · 누르기는 **진짜 마우스 클릭**으로, **페이지가 살아난 뒤에** 해야 한다 — 스크립트 el.click() · 하이드레이션 전 클릭은
 *     구매하기를 눌러도 아무 일이 없었다
 *   · 구매하기 → 옵션 창(.layer-option-picker: "ONE SIZE 48,000" · "구매가 48,000원 · 장바구니 담기 · 구매하기")
 *     → 옵션 · 창 안의 구매하기 → 주문서 /buy/<상품>?size=<옵션키>&type=buy&checkout_id=…&category=brand (약 3초)
 *   · 주문서: 배송 주소 · 쿠폰 · 포인트 · 결제 방법(KREAM Pay 충전결제 · 계좌 간편결제 · 카드 간편결제 · 일반 결제) ·
 *     체크박스 없음 · 아래 버튼 "51,000원 · 결제하기"
 * **결제하기 뒤(비밀번호 자판·완료 화면)는 아직 보지 못했다.** 어긋나면 담긴 화면을 보고 여기 글자를 고친다.
 */
import { LINES } from "./lines.js";
import { notifyHuman } from "./notify.js";
import { log, sayOk, sayStar, sayStep, tick } from "./log.js";
import type { WebElement } from "selenium-webdriver";
import type { KreamBrowser } from "./browser.js";
import { enterPin } from "./pin.js";
import { SHOT_DIR, clearPending, pinOf, writePending, type KreamConfig, type OrderAction, type Target } from "./config.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type BuyResult =
  | { kind: "paid"; orderNo: string; total: number }
  | { kind: "stopped"; total: number }
  | { kind: "failed"; reason: string; sessionDead?: boolean }
  /** 지금은 못 사지만 감시를 이어 가면 되는 것 — 고른 옵션이 품절 (상품 페이지는 다른 사이즈 재고로 "판매 중" 이다). */
  | { kind: "retry"; reason: string };

const isWaitRoom = (url: string): boolean => /^https?:\/\/wait\.kream\.co\.kr/i.test(url);
const isLogin = (url: string): boolean => /kream\.co\.kr\/login/i.test(url);
const isProductPage = (url: string): boolean => /kream\.co\.kr\/products\/\d+/i.test(url);

/** 주문서 주소 — 앱의 경로 /buy · /buy/:id (2026-10-25 라우터에서 읽음). 완료(/buy/complete · /buy/:id/result)는 뺀다. */
const isCheckoutUrl = (url: string): boolean =>
  /kream\.co\.kr\/buy(\/|\?|$)/i.test(url) && !/\/buy\/complete|\/buy\/[^/?]+\/result/i.test(url);
/**
 * 결제사 승인 주소의 결과 — `…/kp/payment/approve?…&resultCode=COMPLETED`.
 * **COMPLETED 만 성공이다.** FAILED·CLOSED 는 실패다 (2026-10-25 실제 기록에서 둘 다 봤다).
 */
function approveResult(url: string): "paid" | "failed" | null {
  if (!/\/kp\/payment\/approve/i.test(url)) return null;
  const code = /resultCode=([A-Za-z]+)/.exec(url)?.[1]?.toUpperCase();
  if (!code) return null;
  return code === "COMPLETED" ? "paid" : "failed";
}
/** 완료 주소 — /buy/complete · /buy/:id/result · 결제사 완료 (/…/complete/web). 승인 주소는 approveResult 가 본다. */
const isCompleteUrl = (url: string): boolean =>
  /\/buy\/complete|\/buy\/[^/?]+\/result|\/complete\/web/i.test(url);

/** 주문서인가 — 주문서 주소이거나, 상품 페이지를 벗어났고 결제하기 버튼이 보인다. */
async function onCheckout(browser: KreamBrowser): Promise<boolean> {
  const url = await browser.url();
  if (isCheckoutUrl(url)) return true;
  if (isProductPage(url) || isWaitRoom(url) || isLogin(url)) return false;
  return /결제하기/.test(await browser.text());
}

/**
 * 옵션 고르기 창. 상품 페이지의 구매하기를 누르면 아래에서 올라오는 시트다 (2026-10-25 스타일시트에서 읽음):
 *   .layer-option-picker  >  .layer_bottom_sheet--open  >  .select_list  >  .select_item (옵션 하나 — "ONE SIZE" · "270" …)
 * 상품 페이지에는 리뷰마다 "ONE SIZE" 글자가 있어서, 옵션은 반드시 이 창 안에서만 찾는다.
 */
const PICKER = ".layer-option-picker";

/** 옵션 창이 열려 있나. */
async function pickerOpen(browser: KreamBrowser): Promise<boolean> {
  return browser.run<boolean>(`
    return [...document.querySelectorAll("${PICKER}, .layer_bottom_sheet--open")].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    });
  `);
}

/**
 * 열린 옵션 창에서 옵션을 고른다. want 가 있으면 첫 줄이 그 글자인 것(대소문자·띄어쓰기 무시), 없으면 옵션이 하나뿐일 때만.
 * 막힌(품절) 옵션은 고르지 않는다. → 고른 옵션의 첫 줄 · 못 고른 까닭
 */
async function pickOption(browser: KreamBrowser, want: string): Promise<{ picked: string | null; why: string }> {
  const found = await browser.run<{ el: WebElement | null; picked: string | null; why: string }>(`
    const want = String(arguments[0] || "").replace(/\\s+/g, "").toLowerCase();
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const roots = [...document.querySelectorAll("${PICKER}, .layer_bottom_sheet--open")].filter(visible);
    const items = [...new Set(roots.flatMap((r) => [...r.querySelectorAll(".select_item, [role=radio], [role=option]")]))].filter(visible);
    if (!items.length) return { el: null, picked: null, why: "옵션 창에 옵션이 없습니다" };
    const first = (el) => String(el.innerText || "").split("\\n").map((s) => s.trim()).filter(Boolean)[0] || "";
    const off = (el) => !!el.closest("[disabled],[aria-disabled='true']") || /disabled|sold|inactive|dimmed/i.test(String(el.className || ""));
    let pick = null;
    if (want) pick = items.find((el) => first(el).replace(/\\s+/g, "").toLowerCase() === want) || null;
    else if (items.length === 1) pick = items[0];
    if (!pick) return { el: null, picked: null, why: want ? "옵션 창에 그 옵션이 없습니다 — 있는 것: " + items.map(first).join(", ") : "옵션이 여럿입니다 — 태스크에 옵션을 적어 주세요: " + items.map(first).join(", ") };
    if (off(pick)) return { el: null, picked: null, why: first(pick) + " 은 품절입니다" };
    const target = pick.querySelector("button, a, [role=button], input") || pick;
    target.scrollIntoView({ block: "center" });
    return { el: target, picked: first(pick), why: "" };
  `, want);
  // 누르는 것은 진짜 마우스 클릭으로 (browser.press).
  if (!found.el) return { picked: null, why: found.why };
  return (await browser.press(found.el)) ? { picked: found.picked, why: "" } : { picked: null, why: "옵션을 누르지 못했습니다" };
}

/** 옵션 창 안의 확인 버튼 — 바로 구매·구매하기·"48,000원 구매하기" 따위. 장바구니 담기는 누르지 않는다. */
const PICKER_CONFIRM = "^(바로\\s*구매(하기)?|즉시\\s*구매(하기)?|구매하기|구매\\s*계속|주문하기|다음|확인|선택\\s*완료|[\\d,]+\\s*원\\s*(·\\s*)?(바로\\s*)?(구매|주문)(하기)?)$";

/**
 * 대기열(wait.kream.co.kr)에 있으면 빠질 때까지 줄을 선다. 새로 고치지 않는다 — 자리를 잃는다.
 * → 기다린 초 (대기열이 아니었으면 0)
 */
export async function waitThroughQueue(browser: KreamBrowser): Promise<number> {
  if (!isWaitRoom(await browser.url())) return 0;
  const started = Date.now();
  let shown: number | null | undefined;
  let lastLog = 0;
  log.info(LINES.queue(null));
  while (isWaitRoom(await browser.url())) {
    const text = await browser.text();
    const m = /(?:내\s*앞|앞에|대기\s*인원|대기자)\D{0,12}([\d,]+)\s*명/.exec(text);
    const ahead = m?.[1] ? Number(m[1].replace(/,/g, "")) : null;
    if (ahead !== shown && Date.now() - lastLog > 3000) {
      log.info(LINES.queue(ahead));
      shown = ahead;
      lastLog = Date.now();
    }
    await sleep(1000);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  sayOk(LINES.queueDone(seconds));
  return seconds;
}

/** 주문서의 최종 금액. 못 읽으면 0. */
async function totalOf(browser: KreamBrowser): Promise<number> {
  const text = await browser.text();
  const m = /(?:최종\s*(?:결제\s*)?금액|총\s*결제\s*금액|결제\s*금액)\D{0,20}?([\d,]{3,})\s*원/.exec(text)
    ?? /([\d,]{3,})\s*원\s*(?:·\s*)?결제하기/.exec(text);
  return m?.[1] ? Number(m[1].replace(/,/g, "")) : 0;
}

/** 필수 동의를 켠다 — "전체 동의" 가 있으면 그것, 없으면 동의 글자가 붙은 꺼진 체크를 하나씩. → 켠 개수 */
async function agreeAll(browser: KreamBrowser): Promise<number> {
  const all = await browser.clickText({ pattern: "^(전체\\s*동의|모두\\s*동의|약관\\s*전체\\s*동의|위 내용을 모두 확인했습니다.*)$" });
  if (all) return 1;
  const labels = await browser.run<WebElement[]>(`
    const out = [];
    for (const box of document.querySelectorAll("input[type=checkbox]")) {
      if (box.checked || box.disabled) continue;
      const holder = box.closest("label,li,div") || box.parentElement;
      const text = String(holder ? holder.innerText : "");
      if (!/동의|확인했습니다|확인하였습니다/.test(text)) continue;
      const label = box.closest("label") || (box.id && document.querySelector('label[for="' + box.id + '"]')) || box;
      out.push(label);
    }
    return out;
  `);
  let n = 0;
  for (const label of labels) if (await browser.press(label)) n++;
  return n;
}

/** 결제하기 버튼 글자 — "51,000원 · 결제하기" (주문서·동의 창 둘 다). */
const PAY_BUTTON = "^([\\d,]+\\s*원\\s*(·\\s*)?)?결제하기$";
/** 결제하기 뒤에 뜨는 동의 창의 제목. */
const AGREE_TITLE = /구매\s*조건\s*확인|거래\s*진행\s*동의/;
/** agreeLayer 가 동의 창에 다는 표시. */
const AGREE_LAYER = "[data-aio-agree]";

/**
 * 결제하기를 누르면 뜨는 "구매조건 확인 및 거래진행 동의" 창 (2026-10-25, 사람이 보내 준 화면):
 *
 *     구매조건 확인 및 거래진행 동의                 ✕
 *     ✓ [필수] 개인정보 제3자 제공 동의        보기
 *     [ 51,000원 · 결제하기 ]   ← 필수를 다 켜기 전에는 회색(막힘)
 *
 * 밑줄 글자("개인정보 제3자 제공")와 "보기" 는 약관을 여는 링크라 누르지 않는다 — 줄 왼쪽의 체크(또는 체크박스·줄 자체)를
 * 누른다. 창이 안 뜨면(이미 동의했던 계정) "none". 이 창의 속 구조는 아직 못 봤다 — 못 켜면 "stuck" 으로 사람에게 넘긴다.
 */
async function agreeLayer(browser: KreamBrowser): Promise<"none" | "done" | "stuck"> {
  // 창이 뜰 때까지 잠깐 — 안 뜨면 바로 결제(비밀번호)로 간 것이다.
  const appear = Date.now() + 3000;
  while (!AGREE_TITLE.test(await browser.text())) {
    if (Date.now() >= appear) return "none";
    await sleep(200);
  }
  // 체크는 누를 때마다 켜졌다 꺼졌다 한다 — 그래서 자리마다 **한 번만** 누르고 결제하기가 풀리기를 기다린다.
  //   0번째: 체크박스·체크 아이콘   1번째: (그래도 막혀 있으면) 줄 자체
  for (let round = 0; round < 2; round++) {
    {
      // 창에 표시를 달고, 아직 안 켠 [필수] 줄의 체크를 찾는다. 줄마다 하나씩, 링크(a · 밑줄 · "보기")는 빼고.
      const checks = await browser.run<WebElement[]>(`
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const title = [...document.querySelectorAll("*")].find((el) => el.children.length === 0 && /구매\\s*조건\\s*확인|거래\\s*진행\\s*동의/.test(el.textContent || "") && vis(el));
        let layer = title;
        while (layer && layer.parentElement && !/결제하기/.test(layer.innerText || "")) layer = layer.parentElement;
        if (!layer) return [];
        // 결제하기를 이 창 안에서만 찾게 표시해 둔다 (뒤의 주문서에도 같은 버튼이 있다).
        layer.setAttribute("data-aio-agree", "1");
        const out = [];
        const rows = [...layer.querySelectorAll("li, label, div, [role=checkbox]")].filter((el) => vis(el) && /^\\s*\\[필수\\]/.test(el.innerText || "") && /동의/.test(el.innerText || ""));
        // 가장 바깥 줄만 (안쪽 마디가 같은 글자로 또 걸린다) — 체크 아이콘이 줄 왼쪽에 형제로 있을 수 있어 바깥 것을 쓴다.
        const outer = rows.filter((r) => !rows.some((o) => o !== r && o.contains(r) && o !== layer && (o.innerText || "").trim() === (r.innerText || "").trim()));
        for (const row of outer.length ? outer : rows) {
          const box = row.querySelector("input[type=checkbox]");
          if (box) { if (!box.checked) out.push(box.closest("label") || box); continue; }
          const aria = row.matches("[role=checkbox]") ? row : row.querySelector("[role=checkbox]");
          if (aria) { if (aria.getAttribute("aria-checked") !== "true") out.push(aria); continue; }
          if (arguments[0] === 1) { out.push(row); continue; }
          // 체크 아이콘 — 링크가 아닌 첫 svg/img/button
          const icon = [...row.querySelectorAll("button, svg, img, i, [class*=check]")].find((el) => vis(el) && !el.closest("a") && !/보기/.test(el.innerText || ""));
          out.push(icon ? (icon.closest("button, [role=button], label") || icon) : row);
        }
        return out;
      `, round);
      // "전체 동의" 가 있으면 그것 하나로 — 없으면 줄마다
      const all = round === 0 ? await browser.clickText({ pattern: "^(전체\\s*동의|모두\\s*동의|전체\\s*선택)(하기)?$", within: AGREE_LAYER }) : null;
      if (!all) for (const el of checks) await browser.press(el);
    }
    // 창 안의 결제하기가 풀리면 누르고 끝 — FIND_BY_TEXT 는 막힌 버튼을 건너뛰므로 풀릴 때까지 기다리는 셈이다.
    const pay = await browser.clickTextWithin({ pattern: PAY_BUTTON, within: AGREE_LAYER, last: true }, 2500);
    if (pay) {
      for (let i = 0; i < 10 && AGREE_TITLE.test(await browser.text()); i++) await sleep(300);
      return AGREE_TITLE.test(await browser.text()) ? "stuck" : "done";
    }
  }
  return "stuck";
}

/** 수량을 늘린다 (+ 버튼). → 실제로 누른 수 */
async function raiseQuantity(browser: KreamBrowser, ea: number): Promise<number> {
  let pressed = 0;
  for (let i = 1; i < ea; i++) {
    const btn = await browser.run<WebElement | null>(`
      const btn = [...document.querySelectorAll("button,[role=button]")].find((b) => {
        const label = (b.getAttribute("aria-label") || "") + " " + (b.innerText || "").trim();
        return /수량\\s*(증가|추가|더하기|늘리기)|plus|increase/i.test(label) || (b.innerText || "").trim() === "+";
      });
      return btn && !btn.disabled ? btn : null;
    `);
    if (!btn || !(await browser.press(btn))) break;
    pressed++;
    await sleep(250);
  }
  return pressed;
}

type CompleteOutcome =
  | { kind: "paid"; orderNo: string }
  | { kind: "failed"; reason: string }
  | { kind: "timeout" };

/**
 * 주문 완료를 기다린다. 결제창이 새 창으로 뜨는 사이트가 있어 **모든 창**을 본다.
 * 승인 주소의 `resultCode` 가 COMPLETED 면 성공, 그 밖(FAILED·CLOSED)이면 실패다.
 */
async function waitComplete(browser: KreamBrowser, timeoutSeconds: number): Promise<CompleteOutcome> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const origin = await browser.currentWindow();
  while (Date.now() < deadline) {
    const handles = await browser.windowHandles();
    const order = [origin, ...handles.filter((h) => h !== origin)].filter((h, i, all) => h && all.indexOf(h) === i);
    for (const win of order) {
      if (!(await browser.useWindow(win))) continue;
      const url = await browser.url();
      const text = await browser.text();
      const approved = approveResult(url);
      if (approved === "failed") {
        const code = /resultCode=([A-Za-z]+)/.exec(url)?.[1] ?? "?";
        if (origin) await browser.useWindow(origin);
        return { kind: "failed", reason: `결제가 완료되지 않았습니다 (resultCode=${code})` };
      }
      if (approved === "paid" || isCompleteUrl(url) || /(구매|결제|주문)(가|이)?\s*완료(되었|됐|했)/.test(text)) {
        const no = /주문\s*번호\D{0,6}([A-Za-z0-9-]{6,})/.exec(text)?.[1];
        if (origin) await browser.useWindow(origin);
        return { kind: "paid", orderNo: no ?? "-" };
      }
    }
    if (origin) await browser.useWindow(origin);
    tick(`주문 완료를 기다립니다 · 남은 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}초`);
    await sleep(1000);
  }
  return { kind: "timeout" };
}

async function fail(browser: KreamBrowser, step: string, reason: string, sessionDead = false): Promise<BuyResult> {
  log.error(LINES.failed(step, reason));
  const base = await browser.dump(SHOT_DIR, step.replace(/\s+/g, "-"));
  log.info(LINES.dumped(base));
  await browser.showToHuman(`${step}에서 멈췄습니다 — 창에서 마저 해 주세요`);
  return { kind: "failed", reason, sessionDead };
}

/**
 * 상품 페이지에서 산다. 브라우저는 이미 그 상품 페이지에 있다(감시가 방금 읽었다) — 아니면 연다.
 */
export async function buyFromProductPage(
  browser: KreamBrowser, cfg: KreamConfig, target: Target, productUrl: string, action: OrderAction,
): Promise<BuyResult> {
  const what = target.label || productUrl;
  sayStep(LINES.buying(what));

  if (!isProductPage(await browser.url())) await browser.goto(productUrl);
  await waitThroughQueue(browser);

  // 1. 구매하기 — 페이지가 살아난 뒤에 누른다 (그 전에는 버튼이 아무 일도 안 한다)
  if (!(await browser.waitHydrated(10_000))) log.warn("페이지가 10초 안에 다 뜨지 않았습니다 — 그래도 누릅니다");
  const clicked = await browser.clickTextWithin({ exact: ["구매하기"], last: true }, 5000);
  if (!clicked) return fail(browser, "구매하기", "구매하기 버튼을 못 찾았습니다 (방금 품절됐거나 판매 전입니다)");
  await sleep(400);
  if (isLogin(await browser.url())) return fail(browser, "구매하기", "로그인 화면으로 갔습니다", true);
  await waitThroughQueue(browser);

  // 2·3. 옵션 창에서 옵션을 고르고 주문서(/buy)가 뜰 때까지.
  //   · 옵션은 열린 옵션 창 안에서만 고른다 (적은 옵션, 없으면 하나뿐일 때만)
  //   · 고른 뒤에도 창이 남아 있으면 창 안의 확인 버튼(바로 구매 따위)을 누른다 — 장바구니 담기는 누르지 않는다
  //   · 창이 안 열렸으면 상품 페이지의 구매하기를 다시 누른다 (2.5초마다까지)
  //   · 8초가 지나도 주문서가 아니면 그 화면을 담아 둔다 — 사람이 멈춰도 무엇이 떠 있었는지 남게
  const want = target.option.trim();
  let picked: string | null = null;
  let dumped = false;
  let lastBuyClick = Date.now();
  const started = Date.now();
  const deadline = started + 25_000;
  while (!(await onCheckout(browser))) {
    const url = await browser.url();
    if (isLogin(url)) return fail(browser, "주문서", "로그인 화면으로 갔습니다", true);
    if (isWaitRoom(url)) {
      await waitThroughQueue(browser);
      continue;
    }
    if (Date.now() >= deadline) {
      return fail(browser, "주문서", picked ? `옵션(${picked})을 골랐는데 주문서가 열리지 않았습니다` : "옵션 창이 열리지 않았습니다");
    }
    if (!dumped && Date.now() - started > 8000) {
      dumped = true;
      log.info(LINES.dumped(await browser.dump(SHOT_DIR, "주문서-대기")));
    }
    if (await pickerOpen(browser)) {
      if (!picked) {
        const r = await pickOption(browser, want);
        if (r.picked) {
          picked = r.picked;
          log.info(LINES.option(picked));
          await sleep(700);
        } else if (/품절/.test(r.why)) {
          // 상품 페이지는 다른 사이즈 재고로 "판매 중" 이었다 — 창을 넘기지 않고 감시로 돌아간다 (다음 바퀴가 페이지를 다시 연다).
          log.warn(LINES.failed("옵션", `${r.why} — 감시를 이어 갑니다`));
          return { kind: "retry", reason: r.why };
        } else if (Date.now() - started > 5000) {
          // 목록이 그려지는 동안은 다시 본다 — 그래도 없으면 그 까닭으로 접는다.
          return fail(browser, "옵션", r.why);
        } else {
          await sleep(300);
        }
        continue;
      }
      await browser.clickText({ pattern: PICKER_CONFIRM, within: `${PICKER}, .layer_bottom_sheet--open`, last: true });
      await sleep(900);
      continue;
    }
    if (picked) {
      // 옵션 창은 닫혔는데 아직 상품 페이지다 — 구매 전 확인 같은 창이 떴을 수 있다. 창 안에서만 누른다.
      await browser.clickText({ pattern: PICKER_CONFIRM, within: ".layer, .layer_container, [role=dialog]", last: true });
      await sleep(700);
      continue;
    }
    if (isProductPage(url) && Date.now() - lastBuyClick > 2500) {
      lastBuyClick = Date.now();
      await browser.clickText({ exact: ["구매하기"], last: true });
    }
    await sleep(300);
  }
  log.info(LINES.checkout(`결제 화면이 열렸습니다 (${new URL(await browser.url()).pathname})`));

  // 4. 수량 · 결제 수단 · 동의
  if (target.ea > 1) {
    const pressed = await raiseQuantity(browser, target.ea);
    if (pressed + 1 < target.ea) log.warn(`수량을 ${target.ea}개로 못 올렸습니다 (${pressed + 1}개) — 창에서 확인해 주세요`);
  }
  if (cfg.buy.payment_method) {
    const pay = await browser.clickTextWithin({ exact: [cfg.buy.payment_method] }, 3000);
    if (pay) log.info(LINES.checkout(`결제 수단 ${pay}`));
    else log.warn(`결제 수단 "${cfg.buy.payment_method}" 을 못 찾았습니다 — KREAM 이 골라 둔 것으로 갑니다`);
  }
  if (cfg.buy.agree_all) {
    const n = await agreeAll(browser);
    if (n) log.info(LINES.checkout(`필수 동의 ${n}개를 켰습니다`));
  }

  // 5. 상한가
  const total = await totalOf(browser);
  if (total) log.info(LINES.checkout(`최종 금액 ${total.toLocaleString("en-US")}원`));
  if (target.max_price > 0 && total > target.max_price) {
    return fail(browser, "상한가", `최종 금액 ${total.toLocaleString("en-US")}원이 상한가 ${target.max_price.toLocaleString("en-US")}원보다 큽니다`);
  }

  // 6. 어디까지
  if (action === "open") {
    sayStar(LINES.stoppedAtOrder());
    await browser.showToHuman("주문서까지 왔습니다");
    return { kind: "stopped", total };
  }
  // 주문서 아래 버튼은 "51,000원 · 결제하기" 다 (2026-10-25 확인).
  const pay = await browser.clickTextWithin({ pattern: PAY_BUTTON, last: true }, 5000);
  if (!pay) return fail(browser, "결제하기", "결제하기 버튼을 못 찾았거나 막혀 있습니다 (필수 동의·배송지를 확인해 주세요)");
  log.info(LINES.checkout(`${pay} 을 눌렀습니다`));

  // 6-1. 구매조건 동의 창 — 결제하기를 누르면 뜬다 (사람이 보내 준 화면, 2026-10-25). 필수 동의를 켜고 창 안의 결제하기를 다시 누른다.
  const agreed = await agreeLayer(browser);
  if (agreed === "stuck") return fail(browser, "구매조건 동의", "동의 창의 필수 항목을 켜지 못했거나 결제하기가 막혀 있습니다");
  if (agreed === "done") log.info(LINES.checkout("구매조건 동의를 켜고 결제하기를 눌렀습니다"));

  // 7. 비밀번호 — 프로필에 결제 비밀번호가 있으면 자판까지 눌러 결제를 끝낸다.
  //    없거나, 자판을 못 읽거나, 눌렀는데 안 먹히면 **더 누르지 않고** 창을 사람에게 넘긴다 (틀린 비밀번호를 쌓으면 잠긴다).
  const pin = pinOf(cfg);
  if (pin) {
    log.info(LINES.pinTrying(pin.length));
    const entered = await enterPin(browser, pin);
    if (entered === "ok") {
      sayOk(LINES.pinEntered());
      // 완료를 못 보고 중지되면 실제로는 결제됐을 수 있다 — 다음 실행이 겹쳐 사지 않게 표시를 남긴다.
      writePending(target.label || productUrl);
      const done = await waitComplete(browser, cfg.buy.complete_timeout_seconds);
      if (done.kind !== "paid") {
        return fail(browser, "주문 완료", done.kind === "failed" ? done.reason : `${cfg.buy.complete_timeout_seconds}초 안에 주문 완료 화면을 못 봤습니다`);
      }
      clearPending();
      sayStar(LINES.paid(done.orderNo));
      browser.keepAlive = false;
      return { kind: "paid", orderNo: done.orderNo, total };
    }
    log.warn(LINES.pinMissed(entered === "none" ? "자판을 못 찾았습니다" : "끝까지 누르지 못했습니다"));
  }
  sayStar(LINES.pinHandoff(pin ? "대신 누르지 못했습니다" : "프로필에 결제 비밀번호가 없습니다"));
  await browser.showToHuman("결제 비밀번호를 넣어 주세요");
  // 다음에 자판을 고칠 수 있게 그 화면을 담아 둔다 (비밀번호는 점으로만 보인다).
  log.info(LINES.dumped(await browser.dump(SHOT_DIR, "결제-비밀번호")));
  await notifyHuman(cfg, target.label || productUrl, productUrl, "결제 비밀번호 창이 떴습니다 — 창에서 직접 넣어 주세요");

  // 8. 완료
  const done = await waitComplete(browser, cfg.buy.complete_timeout_seconds);
  if (done.kind !== "paid") {
    return fail(browser, "주문 완료", done.kind === "failed" ? done.reason : `${cfg.buy.complete_timeout_seconds}초 안에 주문 완료 화면을 못 봤습니다`);
  }
  sayStar(LINES.paid(done.orderNo));
  clearPending();
  browser.keepAlive = false;
  return { kind: "paid", orderNo: done.orderNo, total };
}
