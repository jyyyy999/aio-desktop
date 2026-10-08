/**
 * ?먮룞援щℓ ???λ컮援щ땲 ?닿린遺??**寃곗젣 踰꾪듉 ?대┃源뚯?**. ?щ엺?????쇱? 罹≪감? 3DS 肉먯씠??
 *
 * ?쒖꽌 (Shopify 泥댄겕?꾩썐)
 *   1. ?λ컮援щ땲 ?닿린 (POST /cart/add.js ????됲꽣 ?놁씠)
 *   2. /checkout ?쇰줈
 *   3. 諛곗넚 ?뺣낫 ?낅젰 (蹂몃Ц ?꾨젅??
 *   4. **罹≪감媛 ?덉쑝硫??щ엺?먭쾶 李쎌쓣 ?섍릿??* (?ш린??硫덉떠 湲곕떎由곕떎)
 *   5. 寃곗젣 ?④퀎濡???諛곗넚 諛⑸쾿 ??移대뱶 ?낅젰(card-fields-* iframe ??
 *   6. 罹≪감 ??踰????뺤씤 ??寃곗젣 踰꾪듉 ?대┃
 *   7. 二쇰Ц ?꾨즺 ?뺤씤. 3DS쨌異붽? ?몄쬆???⑤㈃ 李쎌쓣 ?섍린怨?湲곕떎由곕떎.
 *
 * ?대뒓 ?④퀎????踰??ㅽ뙣?섎㈃ 李쎌쓣 ?щ엺?먭쾶 蹂댁뿬 二쇨퀬 硫덉텣????議곗슜???由?二쇰Ц???ｌ? ?딅뒗??
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

/** 泥댄겕?꾩썐???뚮━?????꾩슂??李승룻봽?덉엫 議곗옉. browser.ts 媛 援ы쁽?쒕떎. */
export interface CheckoutHost extends CaptchaWindowHost {
  /** 媛숈? ?꾨줈?꾨줈 ???섏씠吏濡?媛꾨떎 (泥댄겕?꾩썐? 蹂댁씠??李쎌뿉???쒕떎). */
  goto(url: string): Promise<void>;
  /** 蹂몃Ц ?꾨젅?꾩뿉???ㅽ겕由쏀듃瑜??뚮┛??(CaptchaWindowHost.run 怨?媛숈? 寃?. */
  run(script: string): Promise<unknown>;
  /** 吏湲??섏씠吏??iframe 紐⑸줉 ??name/title 怨?洹??덉뿉???ㅽ겕由쏀듃瑜??뚮━???⑥닔. */
  frames(): Promise<{ name: string; run(script: string): Promise<unknown> }[]>;
  /** ?꾩옱 二쇱냼. */
  url(): Promise<string>;
  /** 吏湲?蹂닿퀬 ?덈뒗 李쎌쓣 ?щ엺?먭쾶 蹂댁뿬 以??(?ㅽ뙣?덉쓣 ??. */
  showToHuman(note: string): Promise<void>;
  /** 李쎌쓣 議곗슜???섎룎由곕떎. */
  background(): Promise<void>;
  /** ?ㅽ뙣 ?붾㈃???뚯씪濡??④릿??(?놁쑝硫??섏뼱媛꾨떎). */
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
  /* ?? ?덊봽由?二쇰Ц李?Global-e)?먮쭔 ?덈뒗 寃껊뱾. 鍮꾨㈃ 洹?移몄? 嫄대꼫?대떎 ?? */
  /** YYYY-MM-DD ???쒓뎅 移대뱶 寃곗젣媛 ?붽뎄?쒕떎 */
  dateOfBirth?: string;
  /** 移대뱶 PIN ??2?먮━ */
  cardPinFirstTwo?: string;
  /** 媛쒖씤?듦?怨좎쑀遺??(P + 12?먮━) ??二쇰Ц李쎌쓽 "additional information" */
  personalCustomsCode?: string;
  saveShippingInformation?: boolean;
  /** ?숈쓽 泥댄겕諛뺤뒪 (湲곕낯: ?꾨? 耳좊떎) */
  agree?: { age14?: boolean; globale_tos?: boolean; privacy?: boolean; third_party?: boolean; supreme_tos?: boolean };
}

export interface BuyOptions {
  quantity: number;
  /** 移대뱶 ?뺣낫源뚯? 梨꾩슦怨?寃곗젣 踰꾪듉???꾨Ⅴ??*/
  clickPay: boolean;
  fillPayment: boolean;
  /** 寃곗젣 踰꾪듉???꾨Ⅴ湲????좉퉸 (?ㅼ닔 諛⑹?) */
  payDelayMs: number;
  /** 3DS쨌異붽? ?몄쬆???щ엺?먭쾶 ?섍만吏 */
  threeDsHandoff: boolean;
  /** ?④퀎 ?섎굹瑜?湲곕떎由щ뒗 理쒕? ?쒓컙 */
  stepTimeoutMs: number;
  /** 罹≪감 ?湲??쒓컙 */
  captchaTimeoutMs: number;
  /** ?ㅽ뙣?섎㈃ 李쎌쓣 ?щ엺?먭쾶 蹂댁뿬 二쇨퀬 硫덉텧吏 */
  handoffOnFailure: boolean;
  /** 諛곗넚 諛⑸쾿 ?좏샇 */
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

/** 議곌굔?????뚭퉴吏 ?섏씠吏瑜??ㅼ뿬?ㅻ낯?? */
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
      host.note(`${opts.note} 湲곕떎由щ뒗 以묅?${Math.round((Date.now() - started) / 1000)}珥?`);
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

/** ?λ컮援щ땲???대뒗??????됲꽣 ?놁씠 Shopify ?붾뱶?ъ씤?몃줈. */
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
    // variant 媛 ?≪븯?????덈떎 (?쒕엻 以?variant ?ъ깮??. ?곹뭹???ㅼ떆 ?댁꽍????踰???
    host.note(`?닿린 ?ㅽ뙣(HTTP ${res.status} ${res.raw}) ???곹뭹???ㅼ떆 ?댁꽍?⑸땲??`);
    const product = await shop.resolve(handle);
    const retry = product?.variants.find((v) => v.available);
    if (retry && retry.id !== variantId) {
      const again = await shop.addToCart(retry.id, quantity);
      if (again.ok) return { ok: true, step: "cart", reason: `?ы빐?앺븳 variant(${retry.title})濡??댁쓬` };
      return { ok: false, step: "cart", reason: `?닿린 ?ㅽ뙣(HTTP ${again.status} ${again.raw})` };
    }
    return { ok: false, step: "cart", reason: `?닿린 ?ㅽ뙣(HTTP ${res.status} ${res.raw})` };
  }
  const after = await shop.cart();
  if (after.count <= before.count) {
    return { ok: false, step: "cart", reason: `?닿릿 寃?媛숈? ?딆뒿?덈떎 (?λ컮援щ땲 ${before.count} ??${after.count})` };
  }
  return { ok: true, step: "cart", reason: `?λ컮援щ땲 ${before.count} ??${after.count} (${after.items.map((i) => `${i.title} x${i.quantity}`).join(", ")})` };
}

/**
 * 泥댄겕?꾩썐 ???? 罹≪감쨌3DS 留??щ엺???섍퀬 ?섎㉧吏???먮룞.
 * @param onPaid 寃곗젣 ?꾨즺濡?蹂댁씪 ??(二쇰Ц踰덊샇? ?④퍡) ???뚮┝쨌?곹깭 ??μ? 遺瑜대뒗 履쎌씠 ?쒕떎.
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

  // 0) 移댄듃 ?뺤씤 ??鍮꾩뼱 ?덉쑝硫?泥댄겕?꾩썐???ㅼ뼱媛??댁쑀媛 ?녿떎.
  const cart = await shop.cart();
  if (cart.count <= 0) return result(false, "cart", "?λ컮援щ땲媛 鍮꾩뼱 ?덉뒿?덈떎");

  // 1) 泥댄겕?꾩썐 ?섏씠吏
  host.note(`泥댄겕?꾩썐?쇰줈 媛묐땲??(?λ컮援щ땲 ${cart.count}媛?`);
  await host.goto(`${origin}/checkout`);
  const firstStage = (await waitFor(
    host,
    stageScript(),
    (v) => {
      const s = v as StageReport | null;
      return !!s?.present && (s.present["email"] === true || s.present["address1"] === true || (s.cardFrames?.length ?? 0) > 0);
    },
    { timeoutMs: buy.stepTimeoutMs, intervalMs: 400, note: "泥댄겕?꾩썐 ?붾㈃" },
  )) as StageReport | null;

  if (!firstStage?.present) {
    await host.showToHuman("泥댄겕?꾩썐 ?붾㈃??紐?李얠븯?듬땲??");
    return result(false, "failed", "泥댄겕?꾩썐 ?붾㈃??紐?李얠븯?듬땲??(?뚮쭏/李⑤떒 ?뺤씤 ?꾩슂)");
  }

  // ?대? 寃곗젣 ?④퀎濡??ㅼ뼱? ?덉쓣 ?섎룄 ?덈떎 (?λ컮援щ땲???닿릿 梨??댁뼱???섎뒗 寃쎌슦)
  const needsShipping = firstStage.present["address1"] === true || firstStage.present["email"] === true;

  // 2) 諛곗넚 ?뺣낫
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
      // 媛믪씠 ?섎굹???놁뿀??????됲꽣 臾몄젣媛 ?꾨땲???ㅼ젙 臾몄젣??
      steps.push({ ok: false, step: "shipping", reason: "?ㅼ젙??諛곗넚 ?뺣낫媛 鍮꾩뼱 ?덉뒿?덈떎 (profile)" });
      log.error("?ㅼ젙??諛곗넚 ?뺣낫媛 鍮꾩뼱 ?덉뒿?덈떎 ??二쇰Ц?쒕? 梨꾩슱 ???놁뒿?덈떎. ?댁? ?딄퀬 硫덉땅?덈떎.");
      log.error("   ?⑥븮 ?ㅼ젙(aio/node/supreme_config.json)??profile ??梨꾩슫 ???ㅼ떆 ?꾩슦?몄슂.");
      await host.showToHuman("諛곗넚 ?뺣낫媛 ?ㅼ젙???놁뒿?덈떎 ??梨꾩슫 ???ㅼ떆 ?ㅽ뻾??二쇱꽭??");
      return result(false, "failed", "?ㅼ젙??諛곗넚 ?뺣낫媛 鍮꾩뼱 ?덉뒿?덈떎");
    }
    steps.push({
      ok: n > 0,
      step: "shipping",
      reason: `${n}移??낅젰$${missing.length ? ` 쨌 紐?李얠쓬: ${missing.join(", ")}` : ""}${filled?.errors?.length ? ` 쨌 ?ㅻ쪟: ${filled.errors.join(" | ")}` : ""}`,
    });
    if (n === 0) {
      await host.showToHuman("諛곗넚 ?뺣낫 移몄쓣 紐?李얠븯?듬땲??");
      return result(false, "failed", "諛곗넚 ?뺣낫 移몄쓣 紐?李얠븯?듬땲????DOM ?먭? ?꾩슂");
    }
    host.note(`諛곗넚 ?뺣낫 ?낅젰: ${n}移?${missing.length ? ` (紐?李얠쓬 ${missing.join(", ")})` : ""}`);
  }

  // 3) 罹≪감 ??泥댄겕?꾩썐 ?쒖텧??留됯퀬 ?덉쑝硫??ш린???щ엺??遺瑜몃떎.
  const cleared = await clearCaptchaIfAny(host, captchaOpts);
  steps.push({ ok: cleared, step: "captcha", reason: cleared ? "罹≪감 ?듦낵" : "罹≪감瑜?紐???덉뒿?덈떎" });
  if (!cleared) {
    if (buy.handoffOnFailure) await host.showToHuman("罹≪감瑜??吏 紐삵뻽?듬땲??");
    return result(false, "handed-off", "罹≪감 誘명빐寃???李쎌쓣 ?щ엺?먭쾶 ?섍꼈?듬땲??");
  }
  // 罹≪감瑜??몃뒗 ?숈븞 ?붾㈃???ㅼ떆 洹몃젮議뚯쓣 ???덈떎.
  if (needsShipping) await host.run(fillScript(shippingValues(profile), true));

  // 4) 寃곗젣 ?④퀎濡???**??泥댄겕?꾩썐? ???붾㈃?????덈떎.**
  //    ?덊봽由?Global-e)? 二쇱냼쨌諛곗넚諛⑸쾿쨌移대뱶媛 媛숈? ?붾㈃???덈떎. 洹몃븣??"怨꾩냽" 踰꾪듉???꾩삁 ?녿떎
  //    (2026-10-08: 諛곗넚?뺣낫 8移맞룹벙李④퉴吏 ???먮뒗??"怨꾩냽 踰꾪듉 ?놁쓬" ?쇰줈 硫덉톬??.
  //    移대뱶移몄씠??諛곗넚諛⑸쾿???대? 蹂댁씠硫?怨꾩냽 踰꾪듉??李얠? ?딄퀬 洹몃?濡?移대뱶 ?④퀎濡?媛꾨떎.
  if (needsShipping) {
    const before = (await host.run(stageScript())) as StageReport | null;
    const onePage =
      (before?.cardFrames?.length ?? 0) > 0 || before?.present?.["cardNumber"] === true || (before?.shippingRates ?? 0) > 0;
    if (onePage) {
      steps.push({ ok: true, step: "continue", reason: "???붾㈃ 泥댄겕?꾩썐 ??怨꾩냽 踰꾪듉 ?놁씠 吏꾪뻾" });
      host.note("??泥댄겕?꾩썐? ???붾㈃?낅땲????怨꾩냽 踰꾪듉 ?놁씠 諛곗넚 諛⑸쾿쨌移대뱶濡??섏뼱媛묐땲??");
    }
    const clicked = onePage
      ? { ok: true, reason: "???붾㈃ 泥댄겕?꾩썐" }
      : ((await host.run(clickContinueScript())) as { ok?: boolean; reason?: string } | null);
    if (!clicked?.ok) {
      // **諛붾줈 硫덉텛吏 ?딅뒗??** 怨꾩냽 踰꾪듉???녾굅???좉꺼 ?덉쑝硫????붾㈃ 泥댄겕?꾩썐???꾩쭅 洹몃젮吏??以묒씪 ???덈떎
      // (2026-10-08: 諛곗넚 8移맞룹벙李④퉴吏 ?먮뒗??"怨꾩냽 踰꾪듉 ?놁쓬" ?쇰줈 利됱떆 ?ㅽ뙣?덈떎).
      // 諛곗넚 ?뺣낫瑜??ㅼ떆 梨꾩슦怨?媛믪씠 鍮꾩썙吏????덈떎) 寃곗젣 ?④퀎媛 ?⑤뒗吏 stepTimeoutMs ?숈븞 ?섑??댄빐 蹂몃떎.
      let stageNow = (await host.run(stageScript())) as StageReport | null;
      const readyNow = (s: StageReport | null): boolean =>
        !!s && ((s.cardFrames?.length ?? 0) > 0 || s.present?.["cardNumber"] === true || (s.shippingRates ?? 0) > 0);
      const deadline = Date.now() + buy.stepTimeoutMs;
      let tries = 0;
      let lastNote = 0;
      // **湲곕떎由щ뒗 ?숈븞 李쎌쓣 ?꾩슫??* ???щ엺???붾㈃??蹂닿퀬 吏곸젒 ?꾩?以????덇쾶 (2026-10-08 ?붿껌).
      await host.showToHuman("寃곗젣 ?붾㈃??湲곕떎由щ뒗 以묒엯?덈떎 ???꾩슂?섎㈃ 李쎌뿉??吏곸젒 ?뚮윭 二쇱꽭??");
      while (!readyNow(stageNow) && Date.now() < deadline && !host.cancelled()) {
        tries++;
        if ((stageNow?.continueLabel ?? "") !== "" && stageNow?.continueDisabled === false) {
          const again = (await host.run(clickContinueScript())) as { ok?: boolean; reason?: string } | null;
          if (again?.ok) log.info(`怨꾩냽 踰꾪듉???뚮??듬땲??(${tries}踰덉㎏ ?쒕룄)`);
        } else {
          await host.run(fillScript(shippingValues(profile), true));
        }
        if (Date.now() - lastNote > 5000) {
          lastNote = Date.now();
          host.note(`寃곗젣 ?④퀎瑜?湲곕떎由щ뒗 以묅??⑥? ${Math.round((deadline - Date.now()) / 1000)}珥?(怨꾩냽 踰꾪듉???꾩쭅 ?놁뒿?덈떎 쨌 ${tries}踰덉㎏)`);
        }
        await host.sleep(1500);
        stageNow = (await host.run(stageScript())) as StageReport | null;
      }
      if (!readyNow(stageNow)) {
        const errs = stageNow?.errors ?? [];
        steps.push({ ok: false, step: "continue", reason: `怨꾩냽 踰꾪듉 紐??꾨쫫(?ъ떆??${tries}??: ${clicked?.reason ?? "?"} ${errs.join(" | ")}` });
        if (buy.handoffOnFailure) await host.showToHuman("寃곗젣 ?④퀎濡??섏뼱媛吏 紐삵뻽?듬땲??");
        return result(false, "shipping", `寃곗젣 ?④퀎濡?紐?媛붿뒿?덈떎: ${clicked?.reason ?? ""} ${errs.join(" | ")}`);
      }
      steps.push({ ok: true, step: "continue", reason: `怨꾩냽 踰꾪듉 ?놁씠 寃곗젣 ?④퀎濡??ㅼ뼱媛붿뒿?덈떎 (?ъ떆??${tries}??` });
      host.note("怨꾩냽 踰꾪듉 ?놁씠 寃곗젣 ?④퀎濡??ㅼ뼱媛붿뒿?덈떎 ??諛곗넚 諛⑸쾿쨌移대뱶濡??섏뼱媛묐땲??");
    }
    const moved = (await waitFor(
      host,
      stageScript(),
      (v) => {
        const s = v as StageReport | null;
        if (!s) return false;
        return (s.cardFrames?.length ?? 0) > 0 || s.present?.["cardNumber"] === true || (s.shippingRates ?? 0) > 0;
      },
      { timeoutMs: buy.stepTimeoutMs, intervalMs: 500, note: "寃곗젣 ?붾㈃" },
    )) as StageReport | null;
    if (!moved) {
      await host.showToHuman("寃곗젣 ?붾㈃???⑥? ?딆븯?듬땲??");
      return result(false, "failed", "寃곗젣 ?붾㈃???⑥? ?딆븯?듬땲??");
    }
  }

  // 5) 諛곗넚 諛⑸쾿
  const rate = (await host.run(chooseShippingScript(buy.shippingPrefer))) as { ok?: boolean; text?: string; reason?: string } | null;
  steps.push({ ok: rate?.ok !== false, step: "shipping-method", reason: rate?.ok ? `諛곗넚 諛⑸쾿: ${rate.text ?? ""}` : `諛곗넚 諛⑸쾿 ?먮룞 ?좏깮 ????${rate?.reason ?? "?"})` });

  // 6) 罹≪감 ??踰???(寃곗젣 吏곸쟾???⑤뒗 寃쎌슦)
  const cleared2 = await clearCaptchaIfAny(host, captchaOpts);
  if (!cleared2) {
    if (buy.handoffOnFailure) await host.showToHuman("寃곗젣 吏곸쟾 罹≪감瑜??吏 紐삵뻽?듬땲??");
    return result(false, "handed-off", "寃곗젣 吏곸쟾 罹≪감 誘명빐寃?");
  }

  // 7) 移대뱶
  if (buy.fillPayment) {
    // ?덊봽由?Global-e)? 移대뱶 ?쇰뵒?ㅻ? 怨좊Ⅴ怨? ?숈쓽 泥댄겕諛뺤뒪瑜?耳쒖빞 寃곗젣 踰꾪듉???뚮┛??
    const method = (await host.run(chooseCardMethodScript())) as { ok?: boolean; id?: string; reason?: string } | null;
    if (method && method.ok === false) steps.push({ ok: false, step: "payment-method", reason: `移대뱶 ?좏깮 ?ㅽ뙣 (${method.reason ?? method.id ?? "?"})` });
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
      reason: `?숈쓽 ${agreements?.checked?.length ?? 0}移?泥댄겕${agreeMissing.length ? ` 쨌 紐?耳? ${agreeMissing.join(", ")}` : ""}`,
    });
    if (agreeMissing.length) log.warn(`?숈쓽 移몄쓣 ??耳쒖? 紐삵뻽?듬땲?? ${agreeMissing.join(", ")} ???щ엺???뺤씤?댁빞 ?????덉뒿?덈떎`);
    await host.run(saveInfoScript(profile.saveShippingInformation === true));

    const values = cardValues(profile.card);

    // ?앸뀈?붿씪쨌移대뱶 PIN ??2?먮━??iframe **諛?* 蹂몃Ц???덈떎 (?덊봽由?Global-e ?쒓뎅 移대뱶 寃곗젣).
    const extra: Record<string, string> = {};
    if (profile.dateOfBirth) extra["dateOfBirth"] = profile.dateOfBirth;
    if (profile.cardPinFirstTwo) extra["cardPinFirstTwo"] = profile.cardPinFirstTwo;
    if (profile.personalCustomsCode) {
      // id 瑜?紐⑤Ⅴ??移몄씠??**湲(?쇰꺼)濡쒕룄** 李얠븘蹂몃떎 ??"additional information" ?덉쓽 ?듦?遺??
      extra["personalCustomsCode"] = profile.personalCustomsCode;
      extra["label:customs|clearance|?듦?|personal\\s*code"] = profile.personalCustomsCode;
    }
    if (Object.keys(extra).length) {
      const r = (await host.run(fillScript(extra, true))) as { filled?: Record<string, string>; missing?: string[] } | null;
      const got = Object.keys(r?.filled ?? {});
      steps.push({
        ok: got.length > 0,
        step: "payment-extra",
        reason: got.length ? `異붽? 移? ${got.join(", ")}` : `異붽? 移몄쓣 紐?李얠쓬: ${(r?.missing ?? []).join(", ")}`,
      });
      if (!got.length) log.warn("?앸뀈?붿씪쨌移대뱶 PIN 移몄쓣 紐?李얠븯?듬땲??????李쎌뿉??吏곸젒 梨꾩썙 二쇱꽭??");
    }
    if (Object.keys(values).length === 0) {
      steps.push({ ok: false, step: "payment", reason: "移대뱶 ?뺣낫媛 ?ㅼ젙???놁뒿?덈떎" });
      if (buy.clickPay) {
        await host.showToHuman("移대뱶 ?뺣낫媛 ?놁뼱 寃곗젣瑜??꾨Ⅴ吏 ?딆븯?듬땲??");
        return result(false, "payment", "移대뱶 ?뺣낫 ?놁쓬");
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
        // 移대뱶 ?낅젰??iframe ???꾨땶 ?뚮쭏???덈떎 ??蹂몃Ц?먯꽌 ??踰???
        const report = (await host.run(fillScript(values, true))) as { filled?: Record<string, string> } | null;
        filledAny = Object.keys(report?.filled ?? {}).length;
        notes.push(`蹂몃Ц: ${Object.keys(report?.filled ?? {}).join(",")}`);
      }
      steps.push({ ok: filledAny > 0, step: "payment", reason: filledAny > 0 ? `移대뱶 ${filledAny}移??낅젰 (${notes.join(" / ")})` : "移대뱶 移몄쓣 紐?李얠븯?듬땲??" });
      if (filledAny === 0) {
        if (buy.handoffOnFailure) await host.showToHuman("移대뱶 ?낅젰 移몄쓣 紐?李얠븯?듬땲??");
        return result(false, "payment", "移대뱶 ?낅젰 移몄쓣 紐?李얠븯?듬땲????DOM ?먭? ?꾩슂");
      }
      host.note(`移대뱶 ?뺣낫 ?낅젰 ?꾨즺 (${notes.join(" / ")})`);
    }
  }

  // 8) 泥?뎄吏 = 諛곗넚吏
  await host.run(billingSameScript());

  // 9) 寃곗젣 踰꾪듉
  if (!buy.clickPay) {
    await host.showToHuman("寃곗젣 踰꾪듉? 吏곸젒 ?뚮윭 二쇱꽭??");
    return result(true, "payment", "寃곗젣 吏곸쟾?먯꽌 硫덉톬?듬땲??(?섎룞 寃곗젣)");
  }
  if (buy.payDelayMs > 0) await host.sleep(buy.payDelayMs);

  const paid = (await host.run(clickPayScript())) as { ok?: boolean; reason?: string } | null;
  steps.push({ ok: !!paid?.ok, step: "pay-click", reason: paid?.ok ? "寃곗젣 踰꾪듉 ?대┃" : `寃곗젣 踰꾪듉 紐??꾨쫫: ${paid?.reason ?? "?"}` });
  if (!paid?.ok) {
    if (buy.handoffOnFailure) await host.showToHuman(`寃곗젣 踰꾪듉???꾨Ⅴ吏 紐삵뻽?듬땲?? ${paid?.reason ?? ""}`);
    return result(false, "payment", `寃곗젣 踰꾪듉 紐??꾨쫫: ${paid?.reason ?? ""}`);
  }
  host.note("寃곗젣 踰꾪듉???뚮??듬땲????寃곌낵瑜?湲곕떎由쎈땲??");

  // 10) 寃곌낵: 二쇰Ц ?꾨즺 / 3DS / ?ㅽ뙣
  const started = Date.now();
  while (Date.now() - started < buy.stepTimeoutMs) {
    await host.sleep(700);
    if (host.cancelled()) return result(false, "failed", "?щ엺??硫덉톬?듬땲??");

    const done = (await host.run(orderDoneScript())) as { thanks?: boolean; orderNo?: string; url?: string } | null;
    if (done?.thanks) {
      const orderNo = str(done.orderNo) || "(二쇰Ц踰덊샇 紐??쎌쓬)";
      host.note(`寃곗젣 ?꾨즺 ??二쇰Ц ${orderNo}`);
      steps.push({ ok: true, step: "paid", reason: `二쇰Ц ?꾨즺 ${orderNo}` });
      await onPaid?.(orderNo);
      await host.background();
      return result(true, "paid", `二쇰Ц ?꾨즺 ${orderNo}`, orderNo);
    }

    const three = (await host.run(threeDsScript())) as { challenge?: boolean; text?: string } | null;
    if (three?.challenge) {
      host.note(`異붽? ?몄쬆(3DS)???꾩슂?⑸땲?? ${str(three.text).slice(0, 120)}`);
      if (buy.threeDsHandoff) {
        await host.showToHuman("移대뱶??異붽? ?몄쬆(3DS)???꾨즺??二쇱꽭??");
        const ok = await waitFor(host, orderDoneScript(), (v) => !!(v as { thanks?: boolean } | null)?.thanks, {
          timeoutMs: buy.captchaTimeoutMs,
          intervalMs: 1000,
          note: "異붽? ?몄쬆",
        });
        const finished = ok as { thanks?: boolean; orderNo?: string } | null;
        if (finished?.thanks) {
          const orderNo = str(finished.orderNo) || "(二쇰Ц踰덊샇 紐??쎌쓬)";
          steps.push({ ok: true, step: "paid", reason: `3DS ?꾨즺 쨌 二쇰Ц ${orderNo}` });
          await onPaid?.(orderNo);
          await host.background();
          return result(true, "paid", `3DS ?꾨즺 쨌 二쇰Ц ${orderNo}`, orderNo);
        }
        return result(false, "handed-off", "異붽? ?몄쬆???앸굹吏 ?딆븯?듬땲????李쎌뿉??吏곸젒 ?뺤씤??二쇱꽭??");
      }
      return result(false, "payment", "異붽? ?몄쬆(3DS)???꾩슂?⑸땲??");
    }

    const stage = (await host.run(stageScript())) as StageReport | null;
    if (stage?.errors?.length) {
      const text = stage.errors.join(" | ");
      steps.push({ ok: false, step: "payment-error", reason: text });
      host.note(`寃곗젣 ?붾㈃ ?ㅻ쪟: ${text}`);
      // 移대뱶 ?ㅻ쪟???щ엺??怨좎튌 ???덇쾶 李쎌쓣 ?섍릿??
      if (buy.handoffOnFailure) await host.showToHuman(`寃곗젣 ?ㅻ쪟: ${text}`);
      return result(false, "payment", `寃곗젣 ?ㅻ쪟: ${text}`);
    }
  }

  if (buy.handoffOnFailure) await host.showToHuman("寃곗젣 寃곌낵瑜??뺤씤?섏? 紐삵뻽?듬땲??");
  return result(false, "failed", "寃곗젣 寃곌낵瑜??뺤씤?섏? 紐삵뻽?듬땲????李쎌뿉??吏곸젒 ?뺤씤??二쇱꽭??");
}

/**
 * 罹≪감媛 ???덉쑝硫?**罹≪감留?蹂댁씠??李?*???꾩썙 ?щ엺???寃??쒕떎 (援щℓ? 臾닿??섍쾶 ?????덇쾶 ?곕줈 ??.
 * ?ㅼ젙 ?붾㈃??"罹≪감 李??쒗뿕" ?먮룄 ?대떎.
 */
export async function openCaptchaForHuman(host: CheckoutHost, timeoutMs = 300_000): Promise<boolean> {
  const probe = await host.run(
    `(() => { const f = [...document.querySelectorAll("iframe")].filter(el => /hcaptcha|turnstile|captcha|cloudflare/i.test((el.getAttribute("src")||"")+(el.getAttribute("title")||""))); return f.length > 0; })()`,
  );
  if (!probe) {
    host.note("???붾㈃?먮뒗 罹≪감媛 ?놁뒿?덈떎");
    return false;
  }
  return clearCaptchaIfAny(host, { timeoutMs, silent: false });
}
