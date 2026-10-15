/**
 * 체크아웃 자동 입력 — **페이지 쪽 스크립트**만. 드라이버는 이 스크립트를 프레임마다 돌린다.
 *
 * Shopify 체크아웃은 프레임이 갈려 있다.
 *   배송·이메일  본문 프레임
 *   카드 번호/만료/CVC  card-fields-* iframe 안  → 같은 스크립트를 그 프레임에서 다시 돌린다
 * 그래서 "무엇을 채울지"(entries)와 "어느 셀렉터에 넣을지"(표)만 다르고 실행 코드는 하나다.
 *
 * 값은 React 가 지키는 칸에 들어가므로 value 대입이 아니라 **원시 setter + input/change 이벤트**로 넣는다.
 * (그냥 대입하면 화면에는 보이지만 프레임워크 상태는 비어 있어 주문이 거절된다.)
 */

/** 논리 이름 → 후보 셀렉터 (위에서부터 먼저 보이는 것) */
export const FIELD_SELECTORS: Record<string, string[]> = {
  email: ['input[name="email"]', "#email", "#checkout_email", 'input[type="email"]', 'input[autocomplete="email"]'],
  firstName: ['input[name="firstName"]', "#checkout_shipping_address_first_name", 'input[autocomplete="given-name"]', "#TextField-firstName"],
  lastName: ['input[name="lastName"]', "#checkout_shipping_address_last_name", 'input[autocomplete="family-name"]', "#TextField-lastName"],
  company: ['input[name="company"]', "#checkout_shipping_address_company", 'input[autocomplete="organization"]'],
  address1: ['input[name="address1"]', "#checkout_shipping_address_address1", 'input[autocomplete="address-line1"]', "#TextField-address1"],
  address2: ['input[name="address2"]', "#checkout_shipping_address_address2", 'input[autocomplete="address-line2"]', "#TextField-address2"],
  city: ['input[name="city"]', "#checkout_shipping_address_city", 'input[autocomplete="address-level2"]', "#TextField-city"],
  state: ["select[name=\"zone\"]", 'select[autocomplete="address-level1"]', "#checkout_shipping_address_province", 'input[autocomplete="address-level1"]', 'select[name="province"]'],
  zip: ['input[name="postalCode"]', "#checkout_shipping_address_zip", 'input[autocomplete="postal-code"]', "#TextField-postalCode", 'input[name="zip"]'],
  phone: ['input[name="phone"]', "#checkout_shipping_address_phone", 'input[autocomplete="tel"]', 'input[type="tel"]'],
  country: ["select[name=\"countryCode\"]", 'select[autocomplete="country"]', "#checkout_shipping_address_country", 'select[name="country"]'],
  /* 카드 — card-fields-* iframe 안에서 찾는다 */
  cardNumber: ["#number", 'input[name="number"]', 'input[autocomplete="cc-number"]', 'input[inputmode="numeric"][autocomplete*="cc-number"]'],
  cardExpiry: ["#expiry", 'input[name="expiry"]', 'input[autocomplete="cc-exp"]'],
  cardCvv: ["#verification_value", "#cvv", 'input[name="verification_value"]', 'input[autocomplete="csc"]', 'input[autocomplete="cc-csc"]'],
  cardName: ["#name", 'input[name="name"]', 'input[autocomplete="cc-name"]'],
  /* 슈프림 주문창(Global-e)에만 있는 칸 — 2026-10-08 실제 주문창에서 확인 */
  dateOfBirth: ["#PaymentAdditionalField-Cards-PersonalCardDateOfBirth", 'input[id*="DateOfBirth" i]', 'input[name*="dateOfBirth" i]'],
  cardPinFirstTwo: ["#PaymentAdditionalField-Cards-PersonalCardPinCodeFirstTwoDigits", 'input[id*="PinCode" i]', 'input[name*="pinCode" i]'],
  // 주문창의 "additional information" — 한국 배송이면 개인통관고유부호를 요구한다.
  personalCustomsCode: [
    "#CheckoutAdditionalField-PersonalCustomsCode",
    'input[id*="Customs" i]',
    'input[name*="customs" i]',
    'input[id*="Clearance" i]',
    'input[autocomplete*="customs" i]',
  ],
  saveShippingInformation: ["#save_shipping_information", 'input[name="save_shipping_information"]'],
};

/** 주문창의 동의 체크박스 (id 로 박혀 있다). 전부 자동으로 켠다. */
export const AGREEMENT_BOXES: Record<string, string[]> = {
  age14: ["custom-checkbox-0"],
  globale_tos: ["custom-checkbox-1"],
  privacy: ["custom-checkbox-2", "custom-checkbox-3"],
  third_party: ["custom-checkbox-4"],
  supreme_tos: ["accept-tos"],
};

/** 결제 수단 라디오 (Shopify 카드 필드) */
export const CARD_METHOD_SELECTORS = ["#basic-creditCards", 'input[name="basic"][id*="creditCards" i]', 'input[type="radio"][name="basic"]'];

export const CONTINUE_SELECTORS = [
  "#continue_button",
  'button[type="submit"][name="button"][value="Continue to shipping"]',
  'button[type="submit"][name="button"][value="Continue to payment"]',
  '[data-testid="continue-button"]',
  'form button[type="submit"]:not(#checkout-pay-button)',
];

export const PAY_SELECTORS = [
  "#checkout-pay-button",
  '[data-testid="pay-button"]',
  'button[type="submit"][name="button"][value*="Pay" i]',
  'button[type="submit"][name="button"][value*="Complete" i]',
];

export const SHIPPING_RATE_SELECTORS = [
  'input[name="shipping_method"]',
  '[data-testid="shipping-method"] input[type="radio"]',
  'input[type="radio"][name*="rate" i]',
];

export const BILLING_SAME_SELECTORS = [
  'input[name="billingSameAsShipping"]',
  "#billing-is-same-as-shipping",
  'input[type="checkbox"][name*="same" i]',
];

/**
 * 도/시 이름 별칭 — 주문창은 **영어 라벨**(Seoul · Gyeonggi · North Chungcheong)과 **ISO 코드**(KR-11 · KR-41)를 쓴다.
 * 사람은 "경기도" 나 "Gyeonggi-do" 라고 적는다. 이걸 못 맞추면 예전에는 **두 번째 옵션(엉뚱한 도)** 을
 * 골라 버려서 주소 검증에서 막혔다 (2026-10-08: 인천으로 고정돼 오류).
 */
export const PROVINCE_ALIASES: Record<string, string> = {
  서울: "seoul", 서울특별시: "seoul", 부산: "busan", 부산광역시: "busan",
  인천: "incheon", 인천광역시: "incheon", 대구: "daegu", 대구광역시: "daegu",
  대전: "daejeon", 대전광역시: "daejeon", 광주: "gwangju", 광주광역시: "gwangju",
  울산: "ulsan", 울산광역시: "ulsan", 세종: "sejong", 세종특별자치시: "sejong",
  경기: "gyeonggi", 경기도: "gyeonggi", 강원: "gangwon", 강원도: "gangwon", 강원특별자치도: "gangwon",
  충북: "northchungcheong", 충청북도: "northchungcheong", 충남: "southchungcheong", 충청남도: "southchungcheong",
  전북: "northjeolla", 전라북도: "northjeolla", 전남: "southjeolla", 전라남도: "southjeolla",
  경북: "northgyeongsang", 경상북도: "northgyeongsang", 경남: "southgyeongsang", 경상남도: "southgyeongsang",
  제주: "jeju", 제주도: "jeju", 제주특별자치도: "jeju",
  gyeonggido: "gyeonggi", seoulsi: "seoul", busansi: "busan", incheonsi: "incheon",
  daegusi: "daegu", daejeonsi: "daejeon", gwangjusi: "gwangju", ulsansi: "ulsan",
  northchungcheongdo: "northchungcheong", southchungcheongdo: "southchungcheong",
  northjeollado: "northjeolla", southjeollado: "southjeolla",
  northgyeongsangdo: "northgyeongsang", southgyeongsangdo: "southgyeongsang", jejudosi: "jeju",
};

const SELECTORS = JSON.stringify(FIELD_SELECTORS);
const CONTINUE = JSON.stringify(CONTINUE_SELECTORS);
const PAY = JSON.stringify(PAY_SELECTORS);
const RATES = JSON.stringify(SHIPPING_RATE_SELECTORS);
const BILLING = JSON.stringify(BILLING_SAME_SELECTORS);

/** 여러 프레임에서 공통으로 쓰는 도구 (pick/setValue/selectValue/click). */
const HELPERS = `
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity || "1") > 0.05;
  };
  const pick = (list) => {
    for (const sel of list) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      // 주문창에는 이름이 같은 **그림자 입력칸**(id 가 autofill_…)이 같이 있다. 진짜를 먼저 고른다.
      const usable = nodes.filter((el) => visible(el) && !el.disabled && el.getAttribute("aria-hidden") !== "true");
      const hit = usable.find((el) => !(el.id || "").startsWith("autofill_")) || usable[0];
      if (hit) return { el: hit, sel };
    }
    return null;
  };
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    el.focus();
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  };
  const selectValue = (el, value) => {
    // 도/시는 **영어 라벨 + ISO 코드**다. 별칭까지 맞춰 보고, 못 맞추면 **아무것도 고르지 않는다**
    // (예전에는 두 번째 옵션을 골라서 인천이 잡혔다 — 2026-10-08).
    const aliases = ${JSON.stringify(PROVINCE_ALIASES)};
    const flat = (s) => String(s == null ? "" : s).toLowerCase().replace(/[\\s._\\-()]/g, "");
    const want = flat(value);
    if (!want) return null;
    const wanted = [want, aliases[want] || ""].filter(Boolean);
    const opts = [...el.options].filter((o) => String(o.value || "").trim() !== "");
    const norm = opts.map((o) => ({ o, v: flat(o.value), t: flat(o.textContent) }));
    const hit =
      norm.find((x) => wanted.includes(x.v)) ||
      norm.find((x) => wanted.includes(x.t)) ||
      norm.find((x) => wanted.some((w) => x.t.includes(w) || w.includes(x.t))) ||
      norm.find((x) => wanted.some((w) => x.v.includes(w) || w.includes(x.v)));
    if (!hit) return null;
    setValue(el, hit.o.value);
    return { value: hit.o.value, text: (hit.o.textContent || "").trim() };
  };
  const clickIt = (el) => {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") ? (window.PointerEvent || MouseEvent) : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, opts)); } catch (e) { el.click(); return; }
    }
  };
  /**
   * **글(라벨)로 칸을 찾는다.** 주문창이 "additional information" 처럼 id 를 알 수 없는 칸을
   * 넣을 때 쓴다 (entries 의 열쇠를 "label:정규식" 으로 주면 이 길로 온다).
   */
  const pickByLabel = (pattern) => {
    let re;
    try { re = new RegExp(pattern, "i"); } catch (e) { return null; }
    const describe = (el) => {
      const label = el.labels && el.labels[0] ? el.labels[0].textContent : "";
      const wrap = el.closest("label, .field, [data-testid], .input-wrapper");
      return [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), el.id,
        label, wrap ? wrap.textContent : ""].filter(Boolean).join(" ");
    };
    for (const el of document.querySelectorAll("input, textarea, select")) {
      if (!visible(el) || el.disabled) continue;
      if ((el.id || "").startsWith("autofill_")) continue;
      if (re.test(describe(el))) return { el, sel: "label~/" + pattern + "/" };
    }
    return null;
  };
`;

/**
 * 지금 프레임에서 채울 수 있는 것을 채운다.
 * @param entries 논리 이름 → 값 (예: { email, firstName, address1, cardNumber })
 * @param overwrite 이미 값이 있는 칸도 덮어쓸지
 */
export function fillScript(entries: Record<string, string>, overwrite = false): string {
  return `(() => {
  const fields = ${SELECTORS};
  const entries = ${JSON.stringify(entries)};
  const overwrite = ${overwrite ? "true" : "false"};
  // 값이 하나도 없으면 "못 찾음" 이 아니라 **채울 것이 없었다** 고 말해야 한다
  // (2026-10-08: 빈 배송정보로 돌아 "0칸 입력 · 못 찾음 없음" 이라고만 나와 원인을 알 수 없었다).
  const hasValue = Object.values(entries).some((v) => v != null && String(v).length > 0);
${HELPERS}
  const filled = {};
  const selects = {};
  const missing = [];
  const skipped = [];
  const errors = [];

  for (const [key, raw] of Object.entries(entries)) {
    const value = raw == null ? "" : String(raw);
    if (!value) { continue; }
    const found = key.startsWith("label:") ? pickByLabel(key.slice(6)) : pick(fields[key] || []);
    if (!found) { missing.push(key); continue; }
    try {
      if (found.el instanceof HTMLSelectElement) {
        // **select 는 "이미 값이 있으면 건너뛴다" 를 적용하면 안 된다.** 기본 선택(첫 옵션)이 늘 들어 있어서
        // 영영 안 바뀐다 — 2026-10-08: 시/도가 Incheon 에 고정된 채 주소 검증에서 막혔다.
        const done = selectValue(found.el, value);
        if (done) { filled[key] = found.sel; selects[key] = done; }
        else {
          // 못 고르면 **고를 수 있는 것**을 로그에 남긴다 — 사람이 그 값으로 설정을 고치면 된다.
          const options = [...found.el.options].map((o) => (o.textContent || "").trim()).filter(Boolean).slice(0, 14).join(", ");
          missing.push(key);
          errors.push(key + ': "' + value + '" 를 못 골랐습니다 — 고를 수 있는 것: ' + options);
        }
        continue;
      }
      if (found.el.value && !overwrite) { skipped.push(key); continue; }
      setValue(found.el, value);
      filled[key] = found.sel;
    } catch (e) {
      errors.push(key + ": " + String((e && e.message) || e));
    }
  }
  return { frame: location.href, empty: !hasValue, filled, selects, missing, skipped, errors, fields: Object.keys(filled).length };
})()`;
}

/** 체크아웃 화면에서 지금 무엇이 있는지 (단계 판단·사람에게 넘길지 결정) */
export function stageScript(): string {
  return `(() => {
  const fields = ${SELECTORS};
${HELPERS}
  const present = {};
  for (const [key, list] of Object.entries(fields)) present[key] = !!pick(list);
  const frames = [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("name") || f.getAttribute("title") || f.getAttribute("src") || "").filter(Boolean);
  const cardFrames = frames.filter((n) => /card|payment|number|expiry/i.test(n));
  const continueBtn = pick(${CONTINUE});
  const payBtn = pick(${PAY});
  return {
    url: location.href,
    present,
    cardFrames,
    continueLabel: continueBtn ? (continueBtn.el.textContent || continueBtn.el.value || "").trim().slice(0, 60) : "",
    continueDisabled: continueBtn ? !!continueBtn.el.disabled : true,
    payLabel: payBtn ? (payBtn.el.textContent || payBtn.el.value || "").trim().slice(0, 60) : "",
    shippingRates: [...document.querySelectorAll(${JSON.stringify(SHIPPING_RATE_SELECTORS.join(","))})].length,
    errors: [...document.querySelectorAll('[role="alert"], .field__message--error, [data-testid*="error" i], .notice--error')]
      .map((el) => (el.textContent || "").trim()).filter(Boolean).slice(0, 6),
  };
})()`;
}

/** 다음 단계로 (Continue to shipping / Continue to payment) */
export function clickContinueScript(): string {
  return `(() => {
${HELPERS}
  const found = pick(${CONTINUE});
  if (!found) return { ok: false, reason: "계속 버튼 없음" };
  if (found.el.disabled) return { ok: false, reason: "계속 버튼이 잠겨 있음" };
  clickIt(found.el);
  return { ok: true, sel: found.sel, label: (found.el.textContent || found.el.value || "").trim().slice(0, 60) };
})()`;
}

/** 배송 방법 고르기 (first = 첫 항목, cheapest = data-price 최소) */
export function chooseShippingScript(prefer: "first" | "cheapest" = "first"): string {
  return `(() => {
${HELPERS}
  let nodes = [];
  for (const sel of ${RATES}) {
    try { nodes = [...document.querySelectorAll(sel)].filter((el) => visible(el) && !el.disabled); } catch (e) { nodes = []; }
    if (nodes.length) break;
  }
  if (!nodes.length) return { ok: false, reason: "배송 방법 없음" };
  let target = nodes[0];
  if (${JSON.stringify(prefer)} === "cheapest") {
    target = nodes.reduce((best, el) => {
      const price = (el) => Number(String(el.getAttribute("data-price") || el.closest("[data-price]")?.getAttribute("data-price") || "Infinity"));
      return price(el) < price(best) ? el : best;
    }, nodes[0]);
  }
  const label = target.closest("label") || document.querySelector('label[for="' + target.id + '"]');
  clickIt(label || target);
  if (!target.checked) target.checked = true;
  target.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, checked: !!target.checked, id: target.id || "", text: ((label || target.parentElement || target).textContent || "").trim().slice(0, 80) };
})()`;
}

/** "청구지 = 배송지" 를 켜 둔다 (자동 결제에 필요) */
export function billingSameScript(): string {
  return `(() => {
${HELPERS}
  const found = pick(${BILLING});
  if (!found) return { ok: true, reason: "해당 없음" };
  if (!found.el.checked) { clickIt(found.el); if (!found.el.checked) found.el.checked = true; found.el.dispatchEvent(new Event("change", { bubbles: true })); }
  return { ok: true, checked: !!found.el.checked };
})()`;
}

/** 동의 체크박스 — 슈프림/Global-e 주문창은 결제 전에 이걸 전부 요구한다. */
export function agreementsScript(want: Record<string, boolean>): string {
  return `(() => {
  const boxes = ${JSON.stringify(AGREEMENT_BOXES)};
  const want = ${JSON.stringify(want)};
${HELPERS}
  const checked = [];
  const missing = [];
  for (const [key, ids] of Object.entries(boxes)) {
    if (want[key] === false) continue;
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) { missing.push(id); continue; }
      if (!el.checked) {
        // 라벨로 덮어 꾸민 사이트가 많아 DOM 쪽 click 을 먼저 부른다.
        const label = document.querySelector('label[for="' + id + '"]');
        clickIt(label || el);
        if (!el.checked) { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); }
      }
      if (el.checked) checked.push(id); else missing.push(id + "(못 켬)");
    }
  }
  return { checked, missing };
})()`;
}

/** 카드 결제 수단 라디오 고르기 */
export function chooseCardMethodScript(): string {
  return `(() => {
${HELPERS}
  const found = pick(${JSON.stringify(CARD_METHOD_SELECTORS)});
  if (!found) return { ok: true, reason: "카드 라디오 없음(이미 카드거나 다른 테마)" };
  if (!found.el.checked) {
    const label = found.el.closest("label") || document.querySelector('label[for="' + found.el.id + '"]');
    clickIt(label || found.el);
    if (!found.el.checked) { found.el.checked = true; found.el.dispatchEvent(new Event("change", { bubbles: true })); }
  }
  return { ok: !!found.el.checked, id: found.el.id || "" };
})()`;
}

/** 주문창의 "Save this information for next time" */
export function saveInfoScript(on: boolean): string {
  const want = on ? "true" : "false";
  return `(() => {
${HELPERS}
  const found = pick(${JSON.stringify(FIELD_SELECTORS["saveShippingInformation"] ?? [])});
  if (!found) return { ok: true, reason: "해당 없음" };
  if (!!found.el.checked !== ${want}) {
    clickIt(found.el);
    if (!!found.el.checked !== ${want}) { found.el.checked = ${want}; found.el.dispatchEvent(new Event("change", { bubbles: true })); }
  }
  return { ok: true, checked: !!found.el.checked };
})()`;
}

/** 최종 결제 버튼 */
export function clickPayScript(): string {
  return `(() => {
${HELPERS}
  const found = pick(${PAY});
  if (!found) return { ok: false, reason: "결제 버튼 없음" };
  if (found.el.disabled) return { ok: false, reason: "결제 버튼이 잠겨 있음(입력 누락 가능)" };
  clickIt(found.el);
  return { ok: true, sel: found.sel, label: (found.el.textContent || found.el.value || "").trim().slice(0, 60) };
})()`;
}

/** 결제가 끝났나 — 감사 페이지/주문번호 */
export function orderDoneScript(): string {
  return `(() => {
  const text = (document.body ? document.body.innerText : "").slice(0, 2000);
  const thanks = /thank you|order confirmed|주문이 완료|ご注文ありがとう/i.test(text);
  const orderNo = (text.match(/(?:order|주문)\\s*(?:number|번호|no\\.?)\\s*[:#]?\\s*([A-Z0-9][A-Z0-9-]{3,})/i) || [])[1] || "";
  return { url: location.href, path: location.pathname, thanks, orderNo, title: document.title };
})()`;
}

/** 3DS·추가 인증 화면인가 (사람이 해야 하는 것) */
export function threeDsScript(): string {
  return `(() => {
  const url = location.href;
  const text = (document.body ? document.body.innerText : "").slice(0, 800);
  const frames = [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("src") || "").join(" ");
  const challenge = /3ds|three-?ds|challenge|authentication|acs|otp|인증/i.test(url + " " + frames);
  const textHint = /(3d secure|authenticate|verify your payment|인증번호|추가 인증|ワンタイム)/i.test(text);
  return { url, challenge: challenge || textHint, text: text.replace(/\\s+/g, " ").slice(0, 240) };
})()`;
}

/**
 * DOM 점검 도구 — 테마가 바뀌었을 때 "무엇이 어디 있는지" 사람이 눈으로 확인한다.
 * 바깥(사이트)에서 실제로 쓰는 셀렉터가 지금 페이지에 몇 개 걸리는지 전부 센다.
 */
export function dumpScript(): string {
  return `(() => {
  const all = { ...${SELECTORS}, continue: ${CONTINUE}, pay: ${PAY}, shippingRate: ${RATES}, billingSame: ${BILLING} };
  const count = {};
  const sample = {};
  for (const [key, list] of Object.entries(all)) {
    count[key] = list.map((sel) => {
      let n = 0;
      try { n = document.querySelectorAll(sel).length; } catch (e) { n = -1; }
      return sel + " → " + n;
    });
    const hit = list.map((sel) => document.querySelector(sel)).find(Boolean);
    if (hit) {
      const r = hit.getBoundingClientRect();
      sample[key] = { tag: hit.tagName, type: hit.getAttribute("type") || "", name: hit.getAttribute("name") || "", id: hit.id || "", visible: r.width > 1 && r.height > 1, text: (hit.textContent || hit.value || "").trim().slice(0, 40) };
    }
  }
  return {
    url: location.href,
    title: document.title,
    counts: count,
    sample,
    forms: [...document.forms].map((f) => ({ action: f.getAttribute("action") || "", method: (f.getAttribute("method") || "get").toUpperCase(), inputs: f.elements.length })),
    frames: [...document.querySelectorAll("iframe")].map((f) => ({ name: f.getAttribute("name") || "", src: (f.getAttribute("src") || "").slice(0, 120), w: Math.round(f.getBoundingClientRect().width), h: Math.round(f.getBoundingClientRect().height) })),
    cart: document.querySelector("[data-cart-count], .cart-count, #cart-count")?.textContent?.trim() || "",
  };
})()`;
}
