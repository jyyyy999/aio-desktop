/**
 * 자동구매 — 장바구니 담기부터 **결제 버튼 클릭까지**. 사람이 할 일은 캡차와 3DS 뿐이다.
 *
 * 순서 (Shopify 체크아웃)
 *   1. 장바구니 담기 (POST /cart/add.js — 셀렉터 없이)
 *   2. /checkout 으로
 *   3. 배송 정보 입력 (본문 프레임)
 *   4. **캡차가 있으면 사람에게 창을 넘긴다** (여기서 멈춰 기다린다)
 *   5. 결제 단계로 → 배송 방법 → 카드 입력(card-fields-* iframe 들)
 *   6. 캡차 한 번 더 확인 → 결제 버튼 클릭
 *   7. 주문 완료 확인. 3DS·추가 인증이 뜨면 창을 넘기고 기다린다.
 *
 * 어느 단계든 한 번 실패하면 창을 사람에게 보여 주고 멈춘다 — 조용히 엉뚱한 주문을 넣지 않는다.
 */
import { type CaptchaOptions, clearCaptchaIfAny, type CaptchaWindowHost } from "./captcha-window.js";
import { log } from "./log.js";
import {
  agreementsScript,
  billingSameScript,
  chooseCardMethodScript,
  chooseShippingScript,
  clickContinueScript,
  clickPayScript,
  fillScript,
  orderDoneScript,
  saveInfoScript,
  stageScript,
  threeDsScript,
} from "./checkout-fill.js";
import type { Shop } from "./site.js";

/** 체크아웃을 돌리는 데 필요한 창·프레임 조작. browser.ts 가 구현한다. */
export interface CheckoutHost extends CaptchaWindowHost {
  /** 같은 프로필로 새 페이지로 간다 (체크아웃은 보이는 창에서 한다). */
  goto(url: string): Promise<void>;
  /** 본문 프레임에서 스크립트를 돌린다 (CaptchaWindowHost.run 과 같은 것). */
  run(script: string): Promise<unknown>;
  /** 지금 페이지의 iframe 목록 — name/title 과 그 안에서 스크립트를 돌리는 함수. */
  frames(): Promise<{ name: string; run(script: string): Promise<unknown> }[]>;
  /** 현재 주소. */
  url(): Promise<string>;
  /** 지금 보고 있는 창을 사람에게 보여 준다 (실패했을 때). */
  showToHuman(note: string): Promise<void>;
  /** 창을 조용히 되돌린다. */
  background(): Promise<void>;
  /** 실패 화면을 파일로 남긴다 (없으면 넘어간다). */
  screenshot(path: string): Promise<string>;
}

export interface Profile {
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  card: { number: string; expiry: string; cvv: string; holder: string };
  billingSameAsShipping: boolean;
  /* ── 슈프림 주문창(Global-e)에만 있는 것들. 비면 그 칸은 건너뛴다 ── */
  /** YYYY-MM-DD — 한국 카드 결제가 요구한다 */
  dateOfBirth?: string;
  /** 카드 PIN 앞 2자리 */
  cardPinFirstTwo?: string;
  /** 개인통관고유부호 (P + 12자리) — 주문창의 "additional information" */
  personalCustomsCode?: string;
  saveShippingInformation?: boolean;
  /** 동의 체크박스 (기본: 전부 켠다) */
  agree?: { age14?: boolean; globale_tos?: boolean; privacy?: boolean; third_party?: boolean; supreme_tos?: boolean };
}

export interface BuyOptions {
  quantity: number;
  /** 카드 정보까지 채우고 결제 버튼을 누를지 */
  clickPay: boolean;
  fillPayment: boolean;
  /** 결제 버튼을 누르기 전 잠깐 (실수 방지) */
  payDelayMs: number;
  /** 3DS·추가 인증을 사람에게 넘길지 */
  threeDsHandoff: boolean;
  /** 단계 하나를 기다리는 최대 시간 */
  stepTimeoutMs: number;
  /** 캡차 대기 시간 */
  captchaTimeoutMs: number;
  /** 실패하면 창을 사람에게 보여 주고 멈출지 */
  handoffOnFailure: boolean;
  /** 배송 방법 선호 */
  shippingPrefer: "first" | "cheapest";
}

export const DEFAULT_BUY_OPTIONS: BuyOptions = {
  quantity: 1,
  clickPay: true,
  fillPayment: true,
  payDelayMs: 0,
  threeDsHandoff: true,
  stepTimeoutMs: 45_000,
  captchaTimeoutMs: 180_000,
  handoffOnFailure: true,
  shippingPrefer: "cheapest",
};

export interface StepResult {
  ok: boolean;
  step: string;
  reason: string;
  detail?: unknown;
}

export interface CheckoutResult {
  ok: boolean;
  stage: "cart" | "shipping" | "payment" | "paid" | "handed-off" | "failed";
  orderNo: string;
  reason: string;
  steps: StepResult[];
  screenshot: string;
}

const str = (v: unknown): string => (v == null ? "" : String(v));

interface StageReport {
  url?: string;
  present?: Record<string, boolean>;
  cardFrames?: string[];
  continueLabel?: string;
  continueDisabled?: boolean;
  payLabel?: string;
  shippingRates?: number;
  errors?: string[];
}

/** 조건이 될 때까지 페이지를 들여다본다. */
async function waitFor(
  host: CheckoutHost,
  script: string,
  ok: (value: unknown) => boolean,
  opts: { timeoutMs: number; intervalMs: number; note: string },
): Promise<unknown> {
  const started = Date.now();
  let last: unknown = null;
  let lastNote = 0;
  while (Date.now() - started < opts.timeoutMs) {
    if (host.cancelled()) return null;
    last = await host.run(script);
    if (ok(last)) return last;
    if (Date.now() - lastNote > 10_000) {
      lastNote = Date.now();
      host.note(`${opts.note} 기다리는 중… ${Math.round((Date.now() - started) / 1000)}초`);
    }
    await host.sleep(opts.intervalMs);
  }
  return last;
}

function shippingValues(profile: Profile): Record<string, string> {
  return {
    email: profile.email,
    firstName: profile.firstName,
    lastName: profile.lastName,
    company: profile.company,
    address1: profile.address1,
    address2: profile.address2,
    city: profile.city,
    state: profile.state,
    zip: profile.zip,
    phone: profile.phone,
    country: profile.country,
  };
}

function cardValues(card: Profile["card"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (card.number) out["cardNumber"] = card.number;
  if (card.expiry) out["cardExpiry"] = card.expiry;
  if (card.cvv) out["cardCvv"] = card.cvv;
  if (card.holder) out["cardName"] = card.holder;
  return out;
}

/** 장바구니에 담는다 — 셀렉터 없이 Shopify 엔드포인트로. */
export async function addToCart(
  shop: Shop,
  handle: string,
  variantId: string,
  quantity: number,
  host: Pick<CheckoutHost, "note">,
): Promise<StepResult> {
  const before = await shop.cart();
  const res = await shop.addToCart(variantId, quantity);
  if (!res.ok) {
    // variant 가 죽었을 수 있다 (드랍 중 variant 재생성). 상품을 다시 해석해 한 번 더.
    host.note(`담기 실패(HTTP ${res.status} ${res.raw}) — 상품을 다시 해석합니다`);
    const product = await shop.resolve(handle);
    const retry = product?.variants.find((v) => v.available);
    if (retry && retry.id !== variantId) {
      const again = await shop.addToCart(retry.id, quantity);
      if (again.ok) return { ok: true, step: "cart", reason: `재해석한 variant(${retry.title})로 담음` };
      return { ok: false, step: "cart", reason: `담기 실패(HTTP ${again.status} ${again.raw})` };
    }
    return { ok: false, step: "cart", reason: `담기 실패(HTTP ${res.status} ${res.raw})` };
  }
  const after = await shop.cart();
  if (after.count <= before.count) {
    return { ok: false, step: "cart", reason: `담긴 것 같지 않습니다 (장바구니 ${before.count} → ${after.count})` };
  }
  return { ok: true, step: "cart", reason: `장바구니 ${before.count} → ${after.count} (${after.items.map((i) => `${i.title} x${i.quantity}`).join(", ")})` };
}

/**
 * 체크아웃 한 판 — 캡차·3DS 만 사람이 하고 나머지는 자동.
 * @param onPaid 결제 완료로 보일 때 (주문번호와 함께) — 알림·상태 저장은 부르는 쪽이 한다.
 */
export async function runCheckout(
  host: CheckoutHost,
  shop: Shop,
  profile: Profile,
  origin: string,
  buyIn: Partial<BuyOptions> = {},
  onPaid?: (orderNo: string) => void | Promise<void>,
): Promise<CheckoutResult> {
  const buy: BuyOptions = { ...DEFAULT_BUY_OPTIONS, ...buyIn };
  const steps: StepResult[] = [];
  const captchaOpts: Partial<CaptchaOptions> = { timeoutMs: buy.captchaTimeoutMs };
  const result = (ok: boolean, stage: CheckoutResult["stage"], reason: string, orderNo = "", screenshot = ""): CheckoutResult => {
    steps.push({ ok, step: stage, reason });
    return { ok, stage, reason, orderNo, steps, screenshot };
  };

  // 0) 카트 확인 — 비어 있으면 체크아웃에 들어갈 이유가 없다.
  const cart = await shop.cart();
  if (cart.count <= 0) return result(false, "cart", "장바구니가 비어 있습니다");

  // 1) 체크아웃 페이지
  host.note(`체크아웃으로 갑니다 (장바구니 ${cart.count}개)`);
  await host.goto(`${origin}/checkout`);
  const firstStage = (await waitFor(
    host,
    stageScript(),
    (v) => {
      const s = v as StageReport | null;
      return !!s?.present && (s.present["email"] === true || s.present["address1"] === true || (s.cardFrames?.length ?? 0) > 0);
    },
    { timeoutMs: buy.stepTimeoutMs, intervalMs: 400, note: "체크아웃 화면" },
  )) as StageReport | null;

  if (!firstStage?.present) {
    await host.showToHuman("체크아웃 화면을 못 찾았습니다");
    return result(false, "failed", "체크아웃 화면을 못 찾았습니다 (테마/차단 확인 필요)");
  }

  // 이미 결제 단계로 들어와 있을 수도 있다 (장바구니에 담긴 채 이어서 하는 경우)
  const needsShipping = firstStage.present["address1"] === true || firstStage.present["email"] === true;

  // 2) 배송 정보
  if (needsShipping) {
    const filled = (await host.run(fillScript(shippingValues(profile), true))) as {
      filled?: Record<string, string>;
      missing?: string[];
      errors?: string[];
      empty?: boolean;
    } | null;
    const n = Object.keys(filled?.filled ?? {}).length;
    const missing = filled?.missing ?? [];
    if (filled?.empty) {
      // 값이 하나도 없었다 — 셀렉터 문제가 아니라 설정 문제다.
      steps.push({ ok: false, step: "shipping", reason: "설정의 배송 정보가 비어 있습니다 (profile)" });
      log.error("설정의 배송 정보가 비어 있습니다 — 주문서를 채울 수 없습니다. 돌지 않고 멈춥니다.");
      log.error("   → 설정(aio/node/supreme_config.json)의 profile 을 채운 뒤 다시 띄우세요.");
      await host.showToHuman("배송 정보가 설정에 없습니다 — 채운 뒤 다시 실행해 주세요");
      return result(false, "failed", "설정의 배송 정보가 비어 있습니다");
    }
    steps.push({
      ok: n > 0,
      step: "shipping",
      reason: `${n}칸 입력${missing.length ? ` · 못 찾음: ${missing.join(", ")}` : ""}${filled?.errors?.length ? ` · 오류: ${filled.errors.join(" | ")}` : ""}`,
    });
    if (n === 0) {
      await host.showToHuman("배송 정보 칸을 못 찾았습니다");
      return result(false, "failed", "배송 정보 칸을 못 찾았습니다 — DOM 점검 필요");
    }
    host.note(`배송 정보 입력: ${n}칸${missing.length ? ` (못 찾음 ${missing.join(", ")})` : ""}`);
  }

  // 3) 캡차 — 체크아웃 제출을 막고 있으면 여기서 사람을 부른다.
  const cleared = await clearCaptchaIfAny(host, captchaOpts);
  steps.push({ ok: cleared, step: "captcha", reason: cleared ? "캡차 통과" : "캡차를 못 풀었습니다" });
  if (!cleared) {
    if (buy.handoffOnFailure) await host.showToHuman("캡차를 풀지 못했습니다");
    return result(false, "handed-off", "캡차 미해결 — 창을 사람에게 넘겼습니다");
  }
  // 캡차를 푸는 동안 화면이 다시 그려졌을 수 있다.
  if (needsShipping) await host.run(fillScript(shippingValues(profile), true));

  // 4) 결제 단계로 — **이 체크아웃은 한 화면일 수 있다.**
  //    슈프림(Global-e)은 주소·배송방법·카드가 같은 화면에 있다. 그때는 "계속" 버튼이 아예 없다
  //    (2026-10-08: 배송정보 8칸·캡차까지 다 됐는데 "계속 버튼 없음" 으로 멈췄다).
  //    카드칸이나 배송방법이 이미 보이면 계속 버튼을 찾지 않고 그대로 카드 단계로 간다.
  if (needsShipping) {
    const before = (await host.run(stageScript())) as StageReport | null;
    const onePage =
      (before?.cardFrames?.length ?? 0) > 0 || before?.present?.["cardNumber"] === true || (before?.shippingRates ?? 0) > 0;
    if (onePage) {
      steps.push({ ok: true, step: "continue", reason: "한 화면 체크아웃 — 계속 버튼 없이 진행" });
      host.note("이 체크아웃은 한 화면입니다 — 계속 버튼 없이 배송 방법·카드로 넘어갑니다");
    }
    const clicked = onePage
      ? { ok: true, reason: "한 화면 체크아웃" }
      : ((await host.run(clickContinueScript())) as { ok?: boolean; reason?: string } | null);
    if (!clicked?.ok) {
      // **바로 멈추지 않는다.** 계속 버튼이 없거나 잠겨 있으면 한 화면 체크아웃이 아직 그려지는 중일 수 있다
      // (2026-10-08: 배송 8칸·캡차까지 됐는데 "계속 버튼 없음" 으로 즉시 실패했다).
      // 배송 정보를 다시 채우고(값이 비워질 수 있다) 결제 단계가 뜨는지 stepTimeoutMs 동안 되풀이해 본다.
      let stageNow = (await host.run(stageScript())) as StageReport | null;
      const readyNow = (s: StageReport | null): boolean =>
        !!s && ((s.cardFrames?.length ?? 0) > 0 || s.present?.["cardNumber"] === true || (s.shippingRates ?? 0) > 0);
      const deadline = Date.now() + buy.stepTimeoutMs;
      let tries = 0;
      let lastNote = 0;
      // **기다리는 동안 창을 띄운다** — 사람이 화면을 보고 직접 도와줄 수 있게 (2026-10-08 요청).
      await host.showToHuman("결제 화면을 기다리는 중입니다 — 필요하면 창에서 직접 눌러 주세요");
      while (!readyNow(stageNow) && Date.now() < deadline && !host.cancelled()) {
        tries++;
        if ((stageNow?.continueLabel ?? "") !== "" && stageNow?.continueDisabled === false) {
          const again = (await host.run(clickContinueScript())) as { ok?: boolean; reason?: string } | null;
          if (again?.ok) log.info(`계속 버튼을 눌렀습니다 (${tries}번째 시도)`);
        } else {
          await host.run(fillScript(shippingValues(profile), true));
        }
        if (Date.now() - lastNote > 5000) {
          lastNote = Date.now();
          host.note(`결제 단계를 기다리는 중… 남은 ${Math.round((deadline - Date.now()) / 1000)}초 (계속 버튼이 아직 없습니다 · ${tries}번째)`);
        }
        await host.sleep(1500);
        stageNow = (await host.run(stageScript())) as StageReport | null;
      }
      if (!readyNow(stageNow)) {
        const errs = stageNow?.errors ?? [];
        steps.push({ ok: false, step: "continue", reason: `계속 버튼 못 누름(재시도 ${tries}회): ${clicked?.reason ?? "?"} ${errs.join(" | ")}` });
        if (buy.handoffOnFailure) await host.showToHuman("결제 단계로 넘어가지 못했습니다");
        return result(false, "shipping", `결제 단계로 못 갔습니다: ${clicked?.reason ?? ""} ${errs.join(" | ")}`);
      }
      steps.push({ ok: true, step: "continue", reason: `계속 버튼 없이 결제 단계로 들어갔습니다 (재시도 ${tries}회)` });
      host.note("계속 버튼 없이 결제 단계로 들어갔습니다 — 배송 방법·카드로 넘어갑니다");
    }
    const moved = (await waitFor(
      host,
      stageScript(),
      (v) => {
        const s = v as StageReport | null;
        if (!s) return false;
        return (s.cardFrames?.length ?? 0) > 0 || s.present?.["cardNumber"] === true || (s.shippingRates ?? 0) > 0;
      },
      { timeoutMs: buy.stepTimeoutMs, intervalMs: 500, note: "결제 화면" },
    )) as StageReport | null;
    if (!moved) {
      await host.showToHuman("결제 화면이 뜨지 않았습니다");
      return result(false, "failed", "결제 화면이 뜨지 않았습니다");
    }
  }

  // 5) 배송 방법
  const rate = (await host.run(chooseShippingScript(buy.shippingPrefer))) as { ok?: boolean; text?: string; reason?: string } | null;
  steps.push({ ok: rate?.ok !== false, step: "shipping-method", reason: rate?.ok ? `배송 방법: ${rate.text ?? ""}` : `배송 방법 자동 선택 안 됨 (${rate?.reason ?? "?"})` });

  // 6) 캡차 한 번 더 (결제 직전에 뜨는 경우)
  const cleared2 = await clearCaptchaIfAny(host, captchaOpts);
  if (!cleared2) {
    if (buy.handoffOnFailure) await host.showToHuman("결제 직전 캡차를 풀지 못했습니다");
    return result(false, "handed-off", "결제 직전 캡차 미해결");
  }

  // 7) 카드
  if (buy.fillPayment) {
    // 슈프림(Global-e)은 카드 라디오를 고르고, 동의 체크박스를 켜야 결제 버튼이 풀린다.
    const method = (await host.run(chooseCardMethodScript())) as { ok?: boolean; id?: string; reason?: string } | null;
    if (method && method.ok === false) steps.push({ ok: false, step: "payment-method", reason: `카드 선택 실패 (${method.reason ?? method.id ?? "?"})` });
    const agreements = (await host.run(
      agreementsScript({
        age14: profile.agree?.age14 !== false,
        globale_tos: profile.agree?.globale_tos !== false,
        privacy: profile.agree?.privacy !== false,
        third_party: profile.agree?.third_party !== false,
        supreme_tos: profile.agree?.supreme_tos !== false,
      }),
    )) as { checked?: string[]; missing?: string[] } | null;
    const agreeMissing = agreements?.missing ?? [];
    steps.push({
      ok: agreeMissing.length === 0,
      step: "agree",
      reason: `동의 ${agreements?.checked?.length ?? 0}칸 체크${agreeMissing.length ? ` · 못 켬: ${agreeMissing.join(", ")}` : ""}`,
    });
    if (agreeMissing.length) log.warn(`동의 칸을 다 켜지 못했습니다: ${agreeMissing.join(", ")} — 사람이 확인해야 할 수 있습니다`);
    await host.run(saveInfoScript(profile.saveShippingInformation === true));

    const values = cardValues(profile.card);

    // 생년월일·카드 PIN 앞 2자리는 iframe **밖** 본문에 있다 (슈프림 Global-e 한국 카드 결제).
    const extra: Record<string, string> = {};
    if (profile.dateOfBirth) extra["dateOfBirth"] = profile.dateOfBirth;
    if (profile.cardPinFirstTwo) extra["cardPinFirstTwo"] = profile.cardPinFirstTwo;
    if (profile.personalCustomsCode) {
      // id 를 모르는 칸이라 **글(라벨)로도** 찾아본다 — "additional information" 안의 통관부호.
      extra["personalCustomsCode"] = profile.personalCustomsCode;
      extra["label:customs|clearance|통관|personal\\s*code"] = profile.personalCustomsCode;
    }
    if (Object.keys(extra).length) {
      const r = (await host.run(fillScript(extra, true))) as { filled?: Record<string, string>; missing?: string[] } | null;
      const got = Object.keys(r?.filled ?? {});
      steps.push({
        ok: got.length > 0,
        step: "payment-extra",
        reason: got.length ? `추가 칸: ${got.join(", ")}` : `추가 칸을 못 찾음: ${(r?.missing ?? []).join(", ")}`,
      });
      if (!got.length) log.warn("생년월일·카드 PIN 칸을 못 찾았습니다 — 창에서 직접 채워 주세요");
    }
    if (Object.keys(values).length === 0) {
      steps.push({ ok: false, step: "payment", reason: "카드 정보가 설정에 없습니다" });
      if (buy.clickPay) {
        await host.showToHuman("카드 정보가 없어 결제를 누르지 않았습니다");
        return result(false, "payment", "카드 정보 없음");
      }
    } else {
      const frames = await host.frames();
      const cardFrames = frames.filter((f) => /card|number|expiry|verification|payment/i.test(f.name));
      const targets = cardFrames.length ? cardFrames : frames;
      let filledAny = 0;
      const notes: string[] = [];
      for (const frame of targets) {
        const report = (await frame.run(fillScript(values, true))) as { filled?: Record<string, string>; missing?: string[] } | null;
        const n = Object.keys(report?.filled ?? {}).length;
        if (n > 0) {
          filledAny += n;
          notes.push(`${frame.name || "iframe"}: ${Object.keys(report?.filled ?? {}).join(",")}`);
        }
      }
      if (filledAny === 0) {
        // 카드 입력이 iframe 이 아닌 테마도 있다 — 본문에서 한 번 더.
        const report = (await host.run(fillScript(values, true))) as { filled?: Record<string, string> } | null;
        filledAny = Object.keys(report?.filled ?? {}).length;
        notes.push(`본문: ${Object.keys(report?.filled ?? {}).join(",")}`);
      }
      steps.push({ ok: filledAny > 0, step: "payment", reason: filledAny > 0 ? `카드 ${filledAny}칸 입력 (${notes.join(" / ")})` : "카드 칸을 못 찾았습니다" });
      if (filledAny === 0) {
        if (buy.handoffOnFailure) await host.showToHuman("카드 입력 칸을 못 찾았습니다");
        return result(false, "payment", "카드 입력 칸을 못 찾았습니다 — DOM 점검 필요");
      }
      host.note(`카드 정보 입력 완료 (${notes.join(" / ")})`);
    }
  }

  // 8) 청구지 = 배송지
  await host.run(billingSameScript());

  // 9) 결제 버튼
  if (!buy.clickPay) {
    await host.showToHuman("결제 버튼은 직접 눌러 주세요");
    return result(true, "payment", "결제 직전에서 멈췄습니다 (수동 결제)");
  }
  if (buy.payDelayMs > 0) await host.sleep(buy.payDelayMs);

  const paid = (await host.run(clickPayScript())) as { ok?: boolean; reason?: string } | null;
  steps.push({ ok: !!paid?.ok, step: "pay-click", reason: paid?.ok ? "결제 버튼 클릭" : `결제 버튼 못 누름: ${paid?.reason ?? "?"}` });
  if (!paid?.ok) {
    if (buy.handoffOnFailure) await host.showToHuman(`결제 버튼을 누르지 못했습니다: ${paid?.reason ?? ""}`);
    return result(false, "payment", `결제 버튼 못 누름: ${paid?.reason ?? ""}`);
  }
  host.note("결제 버튼을 눌렀습니다 — 결과를 기다립니다");

  // 10) 결과: 주문 완료 / 3DS / 실패
  const started = Date.now();
  while (Date.now() - started < buy.stepTimeoutMs) {
    await host.sleep(700);
    if (host.cancelled()) return result(false, "failed", "사람이 멈췄습니다");

    const done = (await host.run(orderDoneScript())) as { thanks?: boolean; orderNo?: string; url?: string } | null;
    if (done?.thanks) {
      const orderNo = str(done.orderNo) || "(주문번호 못 읽음)";
      host.note(`결제 완료 — 주문 ${orderNo}`);
      steps.push({ ok: true, step: "paid", reason: `주문 완료 ${orderNo}` });
      await onPaid?.(orderNo);
      await host.background();
      return result(true, "paid", `주문 완료 ${orderNo}`, orderNo);
    }

    const three = (await host.run(threeDsScript())) as { challenge?: boolean; text?: string } | null;
    if (three?.challenge) {
      host.note(`추가 인증(3DS)이 필요합니다: ${str(three.text).slice(0, 120)}`);
      if (buy.threeDsHandoff) {
        await host.showToHuman("카드사 추가 인증(3DS)을 완료해 주세요");
        const ok = await waitFor(host, orderDoneScript(), (v) => !!(v as { thanks?: boolean } | null)?.thanks, {
          timeoutMs: buy.captchaTimeoutMs,
          intervalMs: 1000,
          note: "추가 인증",
        });
        const finished = ok as { thanks?: boolean; orderNo?: string } | null;
        if (finished?.thanks) {
          const orderNo = str(finished.orderNo) || "(주문번호 못 읽음)";
          steps.push({ ok: true, step: "paid", reason: `3DS 완료 · 주문 ${orderNo}` });
          await onPaid?.(orderNo);
          await host.background();
          return result(true, "paid", `3DS 완료 · 주문 ${orderNo}`, orderNo);
        }
        return result(false, "handed-off", "추가 인증이 끝나지 않았습니다 — 창에서 직접 확인해 주세요");
      }
      return result(false, "payment", "추가 인증(3DS)이 필요합니다");
    }

    const stage = (await host.run(stageScript())) as StageReport | null;
    if (stage?.errors?.length) {
      const text = stage.errors.join(" | ");
      steps.push({ ok: false, step: "payment-error", reason: text });
      host.note(`결제 화면 오류: ${text}`);
      // 카드 오류는 사람이 고칠 수 있게 창을 넘긴다.
      if (buy.handoffOnFailure) await host.showToHuman(`결제 오류: ${text}`);
      return result(false, "payment", `결제 오류: ${text}`);
    }
  }

  if (buy.handoffOnFailure) await host.showToHuman("결제 결과를 확인하지 못했습니다");
  return result(false, "failed", "결제 결과를 확인하지 못했습니다 — 창에서 직접 확인해 주세요");
}

/**
 * 캡차가 떠 있으면 **캡차만 보이는 창**을 띄워 사람이 풀게 한다 (구매와 무관하게 쓸 수 있게 따로 둠).
 * 설정 화면의 "캡차 창 시험" 도 이것.
 */
export async function openCaptchaForHuman(host: CheckoutHost, timeoutMs = 300_000): Promise<boolean> {
  const probe = await host.run(
    `(() => { const f = [...document.querySelectorAll("iframe")].filter(el => /hcaptcha|turnstile|captcha|cloudflare/i.test((el.getAttribute("src")||"")+(el.getAttribute("title")||""))); return f.length > 0; })()`,
  );
  if (!probe) {
    host.note("이 화면에는 캡차가 없습니다");
    return false;
  }
  return clearCaptchaIfAny(host, { timeoutMs, silent: false });
}
