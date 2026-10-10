/**
 * 슈프림 시험. 진짜 스토어를 두드리지 않는다.
 *
 *   node dist/supreme/selftest.js            순수 로직만
 *   node dist/supreme/selftest.js --browser  모의 상점(mock-shop)을 띄워 크롬으로 왕복한다
 *
 * --browser 는 **진짜 크롬**을 띄운다: 목록 → 담기 → 체크아웃 → 가짜 hCaptcha(사람이 클릭하는
 * 척) → 결제 버튼 → 주문 완료까지. 캡차 창까지 여는 유일한 시험이다.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, nextDropTime } from "./config.js";
import { formatQueueLine, looksLikeQueue, parseQueue, queueScript, waitThroughQueue } from "./queue.js";
import { isCheckpointUrl, passCheckpoint, submitCheckpointScript } from "./checkpoint.js";
import { LINES, LINE_PATTERNS } from "./lines.js";
import { buildSnapshot, decide, describeKeywords, describeOption, diff, isKeywordSpec, matchProduct, needsFullName, parseHandle, parseKeywordSpec, parseOptionSpec, pickVariant, sizeEquals, withFullName, type BuyRule, type MonitorRule } from "./match.js";
import { agreementsScript, chooseCardMethodScript, clickContinueScript, fillScript, saveInfoScript, stageScript } from "./checkout-fill.js";
import { focusScript, probeScript, tokenScript, unionRect, needsHuman, unfocusScript, type CaptchaProbe } from "./captcha.js";
import { normalizeCard, normalizeProduct } from "./site.js";
import { Shop } from "./site.js";
import { SupremeBrowser } from "./browser.js";
import { addToCart, runCheckout, type Profile } from "./checkout.js";
import { watchLoop } from "./watch.js";
import { startMockShop } from "./mock-shop.js";

let passed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const rule = (over: Partial<MonitorRule> = {}): MonitorRule => ({
  include: [], exclude: [], colors: [], sizes: [], categories: [], maxPrice: 0,
  onlyAvailable: true, detectRestock: true, detectNewVariant: true, silentFirstScan: true, ...over,
});
const buyRule = (over: Partial<BuyRule> = {}): BuyRule => ({
  quantity: 1, sizePriority: ["Large", "Medium"], ignoreSizeIfSingleVariant: true, sizeFallback: false, ...over,
});

const RAW = {
  id: 9001,
  handle: "box-logo-tee",
  title: "Box Logo Tee",
  product_type: "T-Shirts",
  vendor: "Supreme",
  tags: "tee, box logo",
  published_at: "2026-01-01T00:00:00-05:00",
  images: [{ src: "/img/tee.png" }],
  options: ["Color", "Size"],
  variants: [
    { id: 50011, title: "Black / Medium", option1: "Black", option2: "Medium", available: true, price: 4800 },
    { id: 50012, title: "Black / Large", option1: "Black", option2: "Large", available: false, price: 4800 },
    { id: 50013, title: "White / Large", option1: "White", option2: "Large", available: true, price: 4800 },
  ],
};

function pureTests(): void {
  console.log("\n== 상품 해석 ==");
  const product = normalizeProduct(RAW);
  ok("handle·제목·가격", product.handle === "box-logo-tee" && product.priceMin === 48, `${product.handle} ${product.priceMin}`);
  ok("variant 3개", product.variants.length === 3);
  const large = product.variants.find((v) => v.id === "50012");
  ok("옵션에서 색·사이즈를 뽑는다", large?.color === "Black" && large?.size === "Large", `${large?.color}/${large?.size}`);
  ok("품절 표시", large?.available === false);
  ok("상품은 재고 있음", product.available === true);

  console.log("\n== 발견(diff) ==");
  const snap = buildSnapshot([product]);
  const first = diff(null, [product], rule());
  ok("첫 바퀴는 조용하다", first.events.length === 0 && first.first);
  const second = diff(snap, [product], rule());
  ok("같은 목록이면 아무 일도 없다", second.events.length === 0);
  const restocked = { ...product, variants: product.variants.map((v) => (v.id === "50012" ? { ...v, available: true } : v)) };
  const restock = diff(snap, [restocked], rule());
  ok("재입고를 잡는다", restock.events.length === 1 && restock.events[0]?.kind === "restock", restock.events.map((e) => e.kind).join(",") || "없음");
  const newProduct = diff(snap, [product, normalizeProduct({ ...RAW, id: 9002, handle: "camp-cap", title: "Camp Cap" })], rule());
  ok("새 상품을 잡는다", newProduct.events.some((e) => e.kind === "new-product"));

  console.log("\n== 필터 · 고르기 ==");
  ok("제외 키워드", matchProduct(product, rule({ exclude: ["box logo"] })).ok === false);
  ok("포함 키워드 불일치", matchProduct(product, rule({ include: ["cap"] })).ok === false);
  ok("상한가 초과", matchProduct(product, rule({ maxPrice: 10 })).ok === false, `priceMin=${product.priceMin}`);
  const picked = pickVariant(product, buyRule(), rule());
  ok("사이즈 우선순위(Large)", picked.variant?.size === "Large", picked.reason);
  ok("품절 variant 는 안 고른다", picked.variant?.available === true);
  const noStock = pickVariant({ ...product, variants: product.variants.map((v) => ({ ...v, available: false })) }, buyRule(), rule());
  ok("전부 품절이면 안 산다", noStock.variant === null, noStock.reason);
  const onlyBlack = pickVariant(product, buyRule(), rule({ colors: ["Black"] }));
  ok("색상 조건", onlyBlack.variant?.color === "Black", `${onlyBlack.variant?.color}`);
  const decision = decide({ kind: "new-product", product, variant: picked.variant, at: Date.now() }, rule(), buyRule());
  ok("구매 결정", decision.buy === true, decision.reason);
  ok("handle 뽑기", parseHandle("https://shop.supreme.com/products/box-logo-tee?x=1") === "box-logo-tee");
  ok("handle 만 줘도 뽑기", parseHandle("camp-cap") === "camp-cap");

  console.log("\n== 사이즈 이름 맞추기 (2026-10-08 에 L 을 두고 Small 을 담은 자리) ==");
  ok("L = Large", sizeEquals("L", "Large"));
  ok("l = large", sizeEquals("l", "large"));
  ok("XL = XLarge", sizeEquals("XL", "XLarge"));
  ok("XXL = XXLarge", sizeEquals("XXL", "XXLarge"));
  ok("M = medium", sizeEquals("M", "medium"));
  ok("L ≠ XL", sizeEquals("L", "XL") === false);
  ok("270 ≠ 280", sizeEquals("270", "280") === false);
  ok("L 로 Large 를 고른다", pickVariant(product, buyRule({ sizePriority: ["L"] }), rule()).variant?.size === "Large");
  const noLarge = {
    ...product,
    variants: product.variants.map((v) => ({ ...v, available: true, size: v.size === "Large" ? "Small" : v.size })),
  };
  ok("대체 금지(기본)면 안 산다", pickVariant(noLarge, buyRule({ sizePriority: ["Large"] }), rule()).variant === null);
  const fallback = pickVariant(noLarge, buyRule({ sizePriority: ["Large"], sizeFallback: true }), rule());
  ok("대체 허용이면 다른 사이즈로 산다", fallback.variant !== null, fallback.reason);

  console.log("\n== 키워드 사양 (링크 없이 사기) ==");
  const kw1 = parseKeywordSpec("+box +logo -jacket");
  ok("+ 는 포함, - 는 제외", kw1.include.join(",") === "box,logo" && kw1.exclude.join(",") === "jacket", JSON.stringify(kw1));
  const kw2 = parseKeywordSpec('+"box logo" -hoodie');
  ok("따옴표로 묶은 말", kw2.include.join(",") === "box logo" && kw2.exclude.join(",") === "hoodie", JSON.stringify(kw2));
  const kw3 = parseKeywordSpec("box logo");
  ok("부호가 없으면 전부 포함", kw3.include.join(",") === "box,logo" && kw3.exclude.length === 0, JSON.stringify(kw3));
  ok("주소는 키워드가 아니다", isKeywordSpec("https://shop.supreme.com/products/box-logo-tee") === false);
  ok("부호 없으면 키워드가 아니다(주소 오타와 구분)", isKeywordSpec("shop.supreme.com/products/x") === false);
  ok("+ 로 시작하면 키워드다", isKeywordSpec("+box") === true);
  ok("- 만 있어도 키워드다", isKeywordSpec("-jacket") === true);
  ok("키워드 사양 읽기", describeKeywords(kw1) === "+box +logo -jacket", describeKeywords(kw1));
  const kw4 = parseKeywordSpec("+gore, +tex, +n-2b");
  ok("쉼표로 이어 적어도 갈라 준다", kw4.include.join(",") === "gore,tex,n-2b", JSON.stringify(kw4));
  const kw5 = parseKeywordSpec("+box, -jacket; +logo");
  ok("쉼표·쌍반점·가운뎃점 구분", kw5.include.join(",") === "box,logo" && kw5.exclude.join(",") === "jacket", JSON.stringify(kw5));
  // 2026-10-08 실제로 넣은 사양이 실제 상품명에 걸리는지 (이게 안 걸려서 "지금 구매" 가 아무것도 안 했다).
  const kwReal = parseKeywordSpec("+gore, +tex, +n-2b");
  const realProduct = { ...product, title: "GORE-TEX N-2B Jacket - Red", type: "Jackets", tags: "" };
  const realMatch = matchProduct(realProduct, rule({ include: kwReal.include, exclude: kwReal.exclude }));
  ok("실제 상품명(GORE-TEX N-2B Jacket)에 걸린다", realMatch.ok === true, `${JSON.stringify(kwReal)} → ${realMatch.reason}`);

  console.log("\n== 옵션: 색상 / 사이즈 나누기 ==");
  const opt1 = parseOptionSpec("Predator Camo / Large");
  ok("색 / 사이즈 로 가른다", opt1.color === "Predator Camo" && opt1.size === "Large", JSON.stringify(opt1));
  const opt2 = parseOptionSpec("small");
  ok("사이즈만 적으면 색은 빈 값", opt2.color === "" && opt2.size === "small", JSON.stringify(opt2));
  ok("되돌려 한 줄로", describeOption(opt1) === "Predator Camo / Large");
  // 색은 상품 이름에 있으므로 포함 키워드로 넣으면 걸린다 (사이즈는 variant 에서 고른다).
  const colorMatch = matchProduct(
    { ...product, title: "GORE-TEX N-2B Jacket - Predator Camo" },
    rule({ include: [...kwReal.include, opt1.color] }),
  );
  ok("색까지 걸러진다", colorMatch.ok === true, colorMatch.reason);
  const wrongColor = matchProduct(
    { ...product, title: "GORE-TEX N-2B Jacket - Black" },
    rule({ include: [...kwReal.include, opt1.color] }),
  );
  ok("다른 색은 안 걸린다", wrongColor.ok === false, wrongColor.reason);
  const kwMatch = { ...product, title: "Box Logo Hooded Sweatshirt", type: "Sweatshirts", tags: "" };
  ok("키워드가 걸린다", matchProduct(kwMatch, rule({ include: kw1.include, exclude: kw1.exclude })).ok === true);
  ok("제외어가 있으면 안 산다", matchProduct({ ...kwMatch, title: "Box Logo Jacket" }, rule({ include: kw1.include, exclude: kw1.exclude })).ok === false);

  console.log("\n== 대기열 (드랍 때 큐) ==");
  const q1 = parseQueue("You are in line. There are 273 people in front of you. Estimated wait time: about 12 seconds");
  ok("영어 대기열 — 앞 인원", q1.ahead === 273, JSON.stringify(q1));
  ok("영어 대기열 — 예상 초", q1.eta === 12, JSON.stringify(q1));
  const q2 = parseQueue("Your position: 1,204 — estimated waiting time 3 minutes");
  ok("쉼표 자릿수", q2.ahead === 1204, JSON.stringify(q2));
  ok("분 → 초 로 바꾼다", q2.eta === 180, JSON.stringify(q2));
  const q3 = parseQueue("대기열 내 앞 273명 · 줄 281명 · 예상 45초");
  ok("한국어 대기열 줄", q3.ahead === 273 && q3.total === 281 && q3.eta === 45, JSON.stringify(q3));
  ok("대기열 문구 알아보기", looksLikeQueue("You are in line to check out") && !looksLikeQueue("Box Logo Tee $48"));
  const qline = formatQueueLine({ ahead: 273, total: 281, eta: 12 });
  ok("집의 줄 모양 그대로", qline === "대기열 내 앞 273명 · 줄 281명 · 예상 12초", qline);
  ok("어댑터 progress.queue 가 앞 인원을 읽는다", /대기열 내 앞 ([\d,]+)명(?: · 줄 ([\d,]+)명)?(?: · 예상 (\d+)초)?/.exec(qline)?.[1] === "273");
  ok("앞 인원만 있어도 줄을 만든다", formatQueueLine({ ahead: 12, total: null, eta: null }) === "대기열 내 앞 12명");
  ok("queueScript 가 진짜 주문창을 알아본다(그림자 칸 제외)", queueScript().includes('input[name="email"]:not([id^="autofill_"])'));
  const base = new Date(2026, 9, 8, 9, 0, 0).getTime();
  const later = nextDropTime("09:30", 30, base);
  ok("드랍 시각 — 오늘", later !== null && new Date(later).getHours() === 9 && new Date(later).getMinutes() === 30, String(later));
  ok("방금 지난 드랍은 지금 시작", nextDropTime("08:50", 30, base) === base);
  ok("한참 지난 드랍은 내일", (nextDropTime("05:00", 30, base) ?? 0) >= base + 20 * 3600_000 - 1_000, String(nextDropTime("05:00", 30, base)));
  ok("잘못된 시각은 null", nextDropTime("9시", 30, base) === null);

  console.log("\n== 로그 줄 ↔ 어댑터 정규식 ==");
  const foundLine = LINES.foundDry("https://shop.supreme.com/products/box-logo-tee");
  const foundMatch = LINE_PATTERNS.foundDry.exec(foundLine);
  ok("monitorSignal.found 가 상품 주소를 뽑는다", foundMatch?.[1] === "https://shop.supreme.com/products/box-logo-tee", foundLine);
  ok("progress.round", LINE_PATTERNS.round.test(LINES.round(3, 42, 2)));
  ok("progress.countdown", LINE_PATTERNS.countdown.test(LINES.countdown(3)));
  ok("progress.buying", LINE_PATTERNS.buying.test(LINES.buying("Box Logo Tee · Black/Large")));
  ok("progress.checkout", LINE_PATTERNS.checkout.test(LINES.checkout("결제 단계")));
  const paidLine = LINES.paid("MOCK-123456");
  ok("progress.paid + 주문번호", LINE_PATTERNS.paid.exec(paidLine)?.[1] === "MOCK-123456", paidLine);
  ok("sessionDead", LINE_PATTERNS.sessionDead.test(LINES.sessionDead("테스트")));
  ok("blocked", LINE_PATTERNS.blocked.test(LINES.blocked("테스트")));

  console.log("\n== 캡차 ==");
  ok("unionRect 가 둘을 감싼다", JSON.stringify(unionRect([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }])) === JSON.stringify({ x: 0, y: 0, w: 30, h: 15 }));
  ok("unionRect 빈 목록", unionRect([]) === null);
  const probe: CaptchaProbe = {
    present: true, kind: "hcaptcha", frames: [], rect: null, token: "", solved: false,
    viewport: { w: 800, h: 600, dpr: 1 }, url: "https://shop.supreme.com/checkout", scriptOnly: false,
  };
  ok("사람이 필요하다고 본다", needsHuman(probe).needed === true);
  ok("토큰이 있으면 안 부른다", needsHuman({ ...probe, token: "x".repeat(30), solved: true }).needed === false);
  ok("캡차 없으면 안 부른다", needsHuman({ ...probe, present: false }).needed === false);
  ok("probeScript 가 토큰 칸을 본다", probeScript().includes("h-captcha-response"));
  ok("focusScript 가 hcaptcha 를 찾는다", focusScript("hide").includes("hcaptcha.com"));
  ok("다시 걸 때는 사람의 스크롤을 되돌리지 않는다(첫 번과 다르게 본다)", focusScript("hide", "x", true) !== focusScript("hide", "x", false));
  ok("체크포인트 주소를 알아본다", isCheckpointUrl("https://shop.supreme.com/checkpoint?return_to=https%3A%2F%2Fshop.supreme.com%2Fcheckout"));
  ok("체크아웃·상품 주소는 체크포인트가 아니다", !isCheckpointUrl("https://shop.supreme.com/checkout") && !isCheckpointUrl("https://shop.supreme.com/products/checkpoint-tee"));
  ok("체크포인트는 토큰이 든 폼의 버튼을 누른다", submitCheckpointScript().includes("h-captcha-response") && submitCheckpointScript().includes("requestSubmit"));
  ok("unfocusScript 가 되돌린다", unfocusScript().includes("data-aio-hidden"));

  console.log("\n== 체크아웃 스크립트 ==");
  const fill = fillScript({ email: "a@b.com", address1: "1-2-3", cardNumber: "4242" });
  ok("칸 이름을 넣는다", fill.includes('"email":"a@b.com"') && fill.includes('input[name=\\"email\\"]'));
  ok("원시 setter 를 쓴다 (React 대응)", fill.includes("getOwnPropertyDescriptor"));
  ok("그림자 입력칸(autofill_)을 피한다", fill.includes('startsWith("autofill_")'));
  ok("계속 버튼", clickContinueScript().includes("continue_button"));
  ok("단계 스크립트", stageScript().includes("cardFrames"));
  const agree = agreementsScript({ age14: true, globale_tos: true, privacy: true, third_party: true, supreme_tos: true });
  ok("동의 체크박스(14세·Global-e·개인정보·제3자·Supreme)", ["custom-checkbox-0", "custom-checkbox-1", "custom-checkbox-2", "custom-checkbox-3", "custom-checkbox-4", "accept-tos"].every((id) => agree.includes(id)), "동의 id 누락");
  ok("생년월일·카드 PIN 칸", fillScript({ dateOfBirth: "1990-01-01", cardPinFirstTwo: "12" }).includes("PersonalCardDateOfBirth") && fillScript({}).includes("PersonalCardPinCodeFirstTwoDigits"));
  ok("카드 수단 라디오", chooseCardMethodScript().includes("basic-creditCards"));
  ok("다음에 저장", saveInfoScript(true).includes("save_shipping_information"));
  void buildSnapshot;
}

async function browserTests(): Promise<void> {
  console.log("\n== 모의 상점 왕복 (진짜 크롬) ==");
  const mock = await startMockShop();
  const profile = join(BASE, "chrome-profile-selftest");
  mkdirSync(profile, { recursive: true });
  let browser: SupremeBrowser | null = null;
  try {
    browser = await SupremeBrowser.launch({
      profileDir: profile, headless: true, offscreen: false,
      captchaWidth: 0, captchaHeight: 0, origin: mock.origin, cookie: "",
    });
    const shop = new Shop((script) => browser!.run(script));

    await browser.goto(`${mock.origin}/collections/all`);
    const list = await shop.list("all");
    ok("Shopify 목록(products.json)", list.mode === "json" && list.products.length === 2, `${list.mode} ${list.products.length} ${list.note}`);
    const tee = list.products.find((p) => p.handle === "box-logo-tee");
    ok("재고 있는 상품", tee?.available === true);
    ok("품절 상품", list.products.find((p) => p.handle === "camp-cap")?.available === false);

    const resolved = await shop.resolve("box-logo-tee");
    ok("products/<handle>.js 로 해석", resolved?.variants.length === 3, `${resolved?.variants.length}`);

    const added = await addToCart(shop, "box-logo-tee", "50011", 1, browser);
    ok("장바구니 담기(cart/add.js)", added.ok, added.reason);
    const cart = await shop.cart();
    ok("장바구니 수량", cart.count === 1, `${cart.count}`);

    await browser.goto(`${mock.origin}/checkout`);
    const filled = (await browser.run(
      fillScript({ email: "buyer@example.com", firstName: "Gil", lastName: "Hong", address1: "1-2-3 Teheran-ro", city: "Seoul", zip: "06134", phone: "01012345678", country: "KR" }),
    )) as { filled?: Record<string, string>; missing?: string[] };
    ok("배송 정보 입력", Object.keys(filled.filled ?? {}).length >= 6, `입력 ${Object.keys(filled.filled ?? {}).length} · 못 찾음 ${(filled.missing ?? []).join(",")}`);

    // 값이 하나도 없으면 "못 찾음" 이 아니라 "채울 것이 없었다" 고 말해야 한다 (2026-10-08 의 그 줄).
    const emptyReport = (await browser.run(fillScript({ email: "", address1: "" }))) as { empty?: boolean; fields?: number } | null;
    ok("빈 값이면 '채울 것이 없었다' 고 말한다", emptyReport?.empty === true && emptyReport?.fields === 0, JSON.stringify(emptyReport));

    const cap = (await browser.run(probeScript())) as CaptchaProbe;
    ok("가짜 hCaptcha 를 알아본다", cap.present === true && cap.kind === "hcaptcha", `${cap.kind} ${cap.solved}`);
    ok("아직 안 풀렸다", cap.solved === false);

    const focused = (await browser.run(focusScript("hide"))) as { ok?: boolean; hidden?: number };
    ok("캡차만 남기는 집중 모드", focused.ok === true && (focused.hidden ?? 0) > 0, `숨김 ${focused.hidden}`);
    await browser.run(unfocusScript());

    // 사람이 캡차를 클릭하는 척 — iframe 안에서 체크하면 postMessage 로 토큰이 부모에 들어간다.
    const frames = await browser.frames();
    const frame = frames.find((f) => /hcaptcha/i.test(f.name));
    ok("캡차 iframe 을 찾는다", !!frame, frames.map((f) => f.name).slice(0, 5).join(" | "));
    if (frame) await frame.run("(() => { const cb = document.getElementById('cb'); if (cb) cb.click(); return !!cb; })()");
    await new Promise((r) => setTimeout(r, 900));
    const token = String((await browser.run(tokenScript())) ?? "");
    ok("사람이 풀면 토큰이 폼에 들어온다", token.length > 20, `${token.slice(0, 20)}…`);
    const solved = (await browser.run(probeScript())) as CaptchaProbe;
    ok("풀린 것으로 본다", solved.solved === true);

    // 사람이 캡차 창을 닫아 버려도 태스크가 죽지 않는다 — 원래 창으로 돌아가 그 창을 화면에 띄운다.
    await browser.showCaptchaWindow({ width: 0, height: 0, onTop: false, title: "hCaptcha" });
    ok("캡차 전용 창이 열린다", await browser.activeIsCaptchaWindow());
    await (browser as unknown as { driver: { close(): Promise<void> } }).driver.close(); // 사람이 창을 닫은 척
    let survived = false;
    try {
      survived = (await browser.run("(() => 1 + 1)()")) === 2;
    } catch {
      survived = false;
    }
    ok("캡차 창을 닫아도 원래 창으로 돌아가 이어 간다", survived && !(await browser.activeIsCaptchaWindow()));

    // 결제까지. 캡차는 페이지가 다시 실리면서 초기화되므로, **사람이 풀어 주는 척**을 심어 둔다.
    //   새 문서마다 심는다 (Page.addScriptToEvaluateOnNewDocument) — 캡차 전용 창이 새로 열려도 따라간다.
    //   목의 캡차 iframe 은 같은 오리진이라 부모가 그 안을 만질 수 있다 (진짜 hCaptcha 는 cross-origin 이라
    //   이 방법이 통하지 않는다 — 진짜에서는 사람이 창에서 직접 누른다).
    const planted = await browser.addNewDocumentScript(`
      setInterval(() => {
        const f = document.querySelector('iframe[src*="hcaptcha"]');
        const cb = f && f.contentDocument ? f.contentDocument.getElementById('cb') : null;
        if (cb && !cb.checked) cb.click();
      }, 400);
    `);
    ok("사람 흉내를 새 문서마다 심는다", planted === true);

    // 캡차 전용 창은 **새 타깃**이라 위에서 심은 스크립트가 따라가지 않는다. 그래서 시험에서는
    // 드라이버로 사람을 흉내 낸다 — 캡차 창이 뜨면 그 창의 체크박스를 누른다.
    // (진짜에서는 사람이 창에서 직접 누른다. solveCaptcha 는 토큰만 들여다본다.)
    let solving = true;
    const human = (async () => {
      while (solving) {
        await new Promise((r) => setTimeout(r, 600));
        try {
          const list = await browser!.frames();
          const cap = list.find((f) => /hcaptcha/i.test(f.name));
          if (!cap) continue;
          await cap.run("(() => { const cb = document.getElementById('cb'); if (cb && !cb.checked) cb.click(); return true; })()");
        } catch {
          // 창이 바뀌는 중일 수 있다 — 다음 바퀴에 다시 본다.
        }
      }
    })();

    const profileForCheckout: Profile = {
      email: "buyer@example.com", firstName: "Gil", lastName: "Hong", company: "",
      address1: "1-2-3 Teheran-ro", address2: "", city: "Seoul", state: "", zip: "06134",
      country: "KR", phone: "01012345678",
      card: { number: "4242424242424242", expiry: "12/30", cvv: "123", holder: "GIL HONG" },
      billingSameAsShipping: true,
    };
    const result = await runCheckout(browser, shop, profileForCheckout, mock.origin, {
      clickPay: true, fillPayment: true, threeDsHandoff: false, handoffOnFailure: false,
      stepTimeoutMs: 30_000, captchaTimeoutMs: 30_000, shippingPrefer: "first", payDelayMs: 0,
    });
    solving = false;
    await human;
    for (const step of result.steps) console.log(`     · ${step.ok ? "✔" : "✖"} ${step.step}: ${step.reason}`);
    ok("결제 버튼까지 갔다", result.ok === true && result.stage === "paid", `${result.stage} ${result.reason} ${result.orderNo}`);

    console.log(`\n  (모의 상점이 받은 요청 ${mock.hits.length}건: ${[...new Set(mock.hits)].join(", ")})`);
  } finally {
    await browser?.quit();
    await mock.close();
  }
}

/** 사람 흉내 — 캡차 창이 뜨면 그 창의 체크박스를 누른다 (진짜에서는 사람이 창에서 직접 누른다). */
function fakeHuman(browser: SupremeBrowser): { stop(): Promise<void> } {
  let solving = true;
  const loop = (async () => {
    while (solving) {
      await new Promise((r) => setTimeout(r, 600));
      try {
        const cap = (await browser.frames()).find((f) => /hcaptcha/i.test(f.name));
        if (cap) await cap.run("(() => { const cb = document.getElementById('cb'); if (cb && !cb.checked) cb.click(); return true; })()");
      } catch {
        // 창이 바뀌는 중일 수 있다 — 다음 바퀴에 다시 본다.
      }
    }
  })();
  return {
    async stop() {
      solving = false;
      await loop;
    },
  };
}

/**
 * Shopify 체크포인트 — 장바구니에서 체크아웃으로 넘어갈 때 `/checkpoint?return_to=…` 로 돌려 hCaptcha 를 끼운다.
 * 사람이 캡차를 풀면 버튼은 대신 눌러 체크아웃으로 이어 가야 한다 (2026-10-08 실사이트가 이렇다).
 */
async function checkpointTests(): Promise<void> {
  console.log("\n== 체크포인트 (장바구니 → /checkpoint → 체크아웃) ==");
  const profile = join(BASE, "chrome-profile-selftest");
  mkdirSync(profile, { recursive: true });
  const shops = [await startMockShop({ checkpoint: true }), await startMockShop({ checkpoint: true })];
  let browser: SupremeBrowser | null = null;
  try {
    // 1) 일반 구매 — runCheckout 이 체크포인트를 넘고 결제까지 간다.
    const mock = shops[0]!;
    browser = await SupremeBrowser.launch({
      profileDir: profile, headless: true, offscreen: false,
      captchaWidth: 0, captchaHeight: 0, origin: mock.origin, cookie: "",
    });
    const shop = new Shop((script) => browser!.run(script));
    await browser.goto(`${mock.origin}/collections/all`);
    const added = await addToCart(shop, "box-logo-tee", "50011", 1, browser);
    ok("담기", added.ok, added.reason);
    const human = fakeHuman(browser);
    const result = await runCheckout(browser, shop, {
      email: "buyer@example.com", firstName: "Gil", lastName: "Hong", company: "",
      address1: "1-2-3 Teheran-ro", address2: "", city: "Seoul", state: "", zip: "06134",
      country: "KR", phone: "01012345678",
      card: { number: "4242424242424242", expiry: "12/30", cvv: "123", holder: "GIL HONG" },
      billingSameAsShipping: true,
    }, mock.origin, {
      clickPay: true, fillPayment: true, threeDsHandoff: false, handoffOnFailure: false,
      stepTimeoutMs: 30_000, captchaTimeoutMs: 30_000, shippingPrefer: "first", payDelayMs: 0,
    });
    await human.stop();
    for (const step of result.steps) console.log(`     · ${step.ok ? "✔" : "✖"} ${step.step}: ${step.reason}`);
    const cp = result.steps.find((s) => s.step === "checkpoint");
    ok("체크포인트를 알아보고 사람에게 넘긴다", cp?.ok === true, cp ? cp.reason : "체크포인트 단계 없음");
    ok("풀고 나면 버튼을 대신 눌러 제출한다", mock.hits.includes("POST /checkpoint"), [...new Set(mock.hits)].join(", "));
    ok("체크포인트를 넘어 결제까지 갔다", result.ok === true && result.stage === "paid", `${result.stage} ${result.reason}`);
    await browser.quit();
    browser = null;

    // 2) 드랍(큐) 길 — 체크포인트에서 주소를 다시 열지 않고(캡차가 날아간다) 사람에게 넘긴다.
    const mock2 = shops[1]!;
    browser = await SupremeBrowser.launch({
      profileDir: profile, headless: true, offscreen: false,
      captchaWidth: 0, captchaHeight: 0, origin: mock2.origin, cookie: "",
    });
    const b = browser;
    await b.goto(`${mock2.origin}/checkout`);
    ok("/checkout 이 체크포인트로 돌려진다", isCheckpointUrl(await b.url()), await b.url());
    const human2 = fakeHuman(b);
    const queued = await waitThroughQueue(b, {
      url: `${mock2.origin}/checkout`, timeoutMs: 40_000, reloadEveryMs: 0,
      onCheckpoint: async () => (await passCheckpoint(b, { captcha: { timeoutMs: 30_000 } })).ok,
    });
    await human2.stop();
    ok("큐 길에서도 체크포인트를 넘어 주문창에 들어간다", queued.ok && queued.info?.formReady === true, queued.reason);
    const reloads = mock2.hits.filter((h) => h === "GET /checkpoint").length;
    ok("체크포인트에서 주소를 다시 열지 않는다(캡차가 날아가지 않게)", reloads <= 2, `GET /checkpoint ${reloads}번`);
  } finally {
    await browser?.quit();
    for (const one of shops) await one.close();
  }
}

/** 원본 CLI 를 **따로 띄운다** — 임시 집(SUPREME_HOME)이라 진짜 설정·크롬 프로필을 건드리지 않는다. */
function runCli(args: string[], home: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const entry = fileURLToPath(new URL("./index.js", import.meta.url));
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, SUPREME_HOME: home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf-8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf-8")));
    const timer = setTimeout(() => {
      out += "\n(시험: 시간 초과로 끊었습니다)";
      child.kill();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, "") });
    });
  });
}

/**
 * **드랍 전체** — 미끼 담기 → /checkout → 체크포인트(캡차·버튼) → 대기열 → 주문창에서 드랍 시각까지 대기
 * → 장바구니 교체 → 다시 주문창 → 결제. 원본 CLI(--drop)를 그대로 띄워 끝까지 간다.
 * 사람 흉내는 넣을 수 없어(다른 프로세스의 크롬) 모의 캡차가 스스로 풀린다.
 */
async function dropTests(): Promise<void> {
  console.log("\n== 드랍 전체 (미끼 → 체크포인트 → 대기열 → 대기 → 교체 → 결제) ==");
  const mock = await startMockShop({ checkpoint: true, queueMs: 4000, autoSolveCaptcha: true });
  const home = mkdtempSync(join(tmpdir(), "supreme-drop-"));
  try {
    writeFileSync(join(home, "supreme_config.json"), JSON.stringify({
      origin: mock.origin,
      browser: { headless: true, offscreen: false },
      // 미끼는 첫 재고(Black/Medium 50011), 바꿔 담을 것은 Large → White/Large 50013 — 교체가 됐는지 장바구니로 안다.
      buy: { size_priority: ["Large"], retry_attempts: 1, retry_delay_ms: 500 },
      drop: { preload_lead_minutes: 1, queue_timeout_minutes: 2, late_grace_minutes: 1 },
      captcha: { timeout_ms: 30_000 },
      profile: {
        email: "buyer@example.com", first_name: "Gil", last_name: "Hong", address1: "1-2-3 Teheran-ro", city: "Seoul",
        state: "Seoul", zip: "06134", phone: "01012345678", country: "KR",
        card_number: "4242424242424242", card_expiry: "12/30", card_cvv: "123", card_holder: "GIL HONG",
      },
    }), "utf-8");
    // 드랍 시각은 25초 뒤 — 그 전에 미끼·체크포인트·대기열을 끝내고 주문창에서 기다려야 한다.
    const at = new Date(Date.now() + 25_000);
    const hhmmss = [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
    const product = `${mock.origin}/products/box-logo-tee`;
    const { code, out } = await runCli(["--drop", "--preload", product, "--swap-to", product, "--drop-at", hhmmss], home, 150_000);
    const tail = out.trim().split("\n").slice(-6).join(" / ");

    const hit = (h: string) => mock.hits.indexOf(h);
    const firstCheckout = hit("GET /checkout");
    ok("드랍이 끝까지 돈다(종료 코드 0)", code === 0, `코드 ${code} · ${tail}`);
    ok("미끼를 담고 주문창으로 간다", hit("POST /cart/add.js") >= 0 && firstCheckout > hit("POST /cart/add.js"), mock.hits.slice(0, 12).join(", "));
    ok("체크포인트를 풀고 버튼을 대신 눌러 넘는다", hit("POST /checkpoint") > firstCheckout && /체크포인트를 통과했습니다/.test(out), tail);
    ok("체크포인트에서 주소를 다시 열지 않는다", mock.hits.filter((h) => h === "GET /checkpoint").length <= 2, `GET /checkpoint ${mock.hits.filter((h) => h === "GET /checkpoint").length}번`);
    ok("체크포인트 다음 대기열에 서서 통과한다", hit("queue-page") > hit("POST /checkpoint") && /대기열을 통과했습니다/.test(out), tail);
    // 대기 중 줄은 제자리에서 고쳐 쓰는 줄이라 파이프로는 안 남는다 — 시각으로 본다: 교체가 드랍 시각(−2초)에 일어났나.
    const clock = (pattern: RegExp): number | null => {
      const line = out.split("\n").find((l) => pattern.test(l));
      const m = line ? /(\d{2}):(\d{2}):(\d{2})/.exec(line) : null;
      if (!m) return null;
      const d = new Date(at);
      d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
      return d.getTime();
    };
    const entered = clock(/주문창에 들어갔습니다/);
    const swapped = clock(/장바구니를 바꿉니다/);
    const dropMs = Math.floor(at.getTime() / 1000) * 1000;
    ok(
      "드랍 시각까지 주문창에서 기다렸다가 바꾼다",
      entered !== null && swapped !== null && entered < dropMs - 3000 && swapped >= dropMs - 3000 && swapped <= dropMs + 3000,
      `들어감 ${entered ? new Date(entered).toLocaleTimeString() : "?"} · 바꿈 ${swapped ? new Date(swapped).toLocaleTimeString() : "?"} · 드랍 ${hhmmss}`,
    );
    ok("드랍 시각에 미끼를 비운다", hit("POST /cart/clear.js") > hit("queue-page"), mock.hits.slice(-12).join(", "));
    ok("원하는 상품으로 바꿔 담았다(장바구니엔 그것만)", mock.cart.length === 1 && mock.cart[0]?.variantId === "50013", JSON.stringify(mock.cart));
    ok("바꿔 담은 뒤 결제까지 간다", hit("GET /thank_you") > hit("POST /cart/clear.js") && /주문 완료|결제 완료/.test(out), tail);
  } finally {
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * 색 보완 — 목록 카드에 색이 빠져 와도(카드가 늦게 그려진다) `+camo` 가 걸려야 한다.
 * 크롬 없이 가짜 Shop 으로 감시 한 바퀴를 돈다: 후보만 상품 페이지 이름으로 보완하고, 나머지는 요청하지 않는다.
 */
async function colorFillTests(): Promise<void> {
  console.log("\n== 색 보완 (목록 카드에 색이 빠져 온 판) ==");
  const card = (handle: string, title: string) =>
    normalizeCard({ handle, title, url: `/products/${handle}`, soldOut: false, image: "", price: 398 });
  const jacketPage = (handle: string, title: string) => ({
    id: handle, handle, title, product_type: "Jackets", options: ["Size"],
    variants: [{ id: `${handle}-l`, title: "Large", option1: "Large", available: true, price: 39800 }],
  });
  const pages: Record<string, Parameters<typeof normalizeProduct>[0]> = {
    "n2b-camo": jacketPage("n2b-camo", "GORE-TEX N-2B Jacket - Predator Camo"),
    "n2b-black": jacketPage("n2b-black", "GORE-TEX N-2B Jacket - Black"),
    "box-logo-tee": RAW,
  };
  const listed = [card("n2b-camo", "GORE-TEX N-2B Jacket"), card("n2b-black", "GORE-TEX N-2B Jacket"), card("box-logo-tee", "Box Logo Tee")];
  const resolvedHandles: string[] = [];
  const fakeShop = {
    lastResolveNote: "",
    async list() {
      return { mode: "html", status: 200, products: listed, hero: "", note: "" };
    },
    async pageState() {
      return { url: "", title: "", blocked: false, challenge: false, text: "" };
    },
    async resolve(handle: string) {
      resolvedHandles.push(handle);
      const raw = pages[handle];
      return raw ? normalizeProduct(raw) : null;
    },
  } as unknown as Shop;

  const camoRule = rule({ include: ["gore", "tex", "camo"], silentFirstScan: false });
  ok("일부 키워드가 걸린 카드는 보완 후보", needsFullName(listed[0]!, camoRule));
  ok("하나도 안 걸린 카드는 후보가 아니다(요청 안 함)", needsFullName(listed[2]!, camoRule) === false);
  ok("키워드 하나뿐이면 후보가 아니다(목록 전체를 받게 된다)", needsFullName(listed[0]!, rule({ include: ["camo"] })) === false);
  ok("JSON 으로 온 상품은 후보가 아니다", needsFullName({ ...listed[0]!, partial: false }, camoRule) === false);
  const multiColor = normalizeProduct(RAW);
  ok("여러 색이면 variant 색을 이름에 넣지 않는다", !/white/i.test(withFullName(card("box-logo-tee", "Box Logo Tee"), multiColor).tags));
  const oneColor = normalizeProduct({ ...RAW, variants: RAW.variants.filter((v) => v.option1 === "White") });
  ok("한 색이면 variant 색도 매칭 재료", /white/i.test(withFullName(card("box-logo-tee", "Box Logo Tee"), oneColor).tags));

  const lines: string[] = [];
  const capture = {
    note: (t: string) => lines.push(t),
    ok: (t: string) => lines.push(t),
    warn: (t: string) => lines.push(t),
    error: (t: string) => lines.push(t),
    step: (t: string) => lines.push(t),
    tick: (t: string) => lines.push(t),
  };
  await watchLoop(
    fakeShop,
    camoRule,
    buyRule(),
    { origin: "https://mock", collections: ["all"], dryRun: true, maxRounds: 1, intervalMs: 0, jitterMs: 0 },
    { async onEvents() { /* 드라이런에서는 안 부른다 */ } },
    capture,
    () => false,
  );
  const found = lines.filter((line) => line.includes("[dry-run]"));
  ok("색이 빠진 카드도 +camo 로 걸린다", found.length === 1 && found[0]!.includes("/products/n2b-camo"), found.join(" / ") || lines.join(" / "));
  ok("다른 색(Black)은 보완해도 안 걸린다", !found.some((line) => line.includes("n2b-black")));
  ok("요청은 후보 수만큼만", resolvedHandles.sort().join(",") === "n2b-black,n2b-camo", resolvedHandles.join(","));

  // 색을 적으면(--size "Predator Camo / Large") 원본이 colors 에도 넣는다. 슈프림 variant 는 사이즈뿐이라
  // 색이 비어 있다 — 그걸 "색상 불일치" 로 막으면 색을 적은 태스크는 영영 못 산다.
  const sizeOnly = normalizeProduct(pages["n2b-camo"]!);
  const withColor = rule({ include: ["gore", "camo"], colors: ["Predator Camo"] });
  const pickedCamo = pickVariant(sizeOnly, buyRule({ sizePriority: ["Large"] }), withColor);
  ok("사이즈뿐인 variant 는 색 조건으로 막지 않는다", pickedCamo.variant?.size === "Large", pickedCamo.reason);
  const colored = normalizeProduct(RAW);
  ok("색 옵션이 있으면 여전히 색으로 고른다", pickVariant(colored, buyRule(), rule({ colors: ["White"] })).variant?.color === "White");
}

/**
 * 잡으면 바로 산다 — 걸린 상품이 있으면 남은 상품을 끝까지 판정하지 않고 그 자리에서 구매로 넘긴다 (2026-10-10).
 */
async function buyFastTests(): Promise<void> {
  console.log("\n== 잡으면 바로 산다 ==");
  const card = (handle: string, title: string) =>
    normalizeCard({ handle, title, url: `/products/${handle}`, soldOut: false, image: "", price: 48 });
  const listed = [card("box-logo-tee", "Box Logo Tee"), card("box-logo-hood", "Box Logo Hooded Sweatshirt")];
  const order: string[] = [];
  const fakeShop = {
    lastResolveNote: "",
    async list() {
      return { mode: "html", status: 200, products: listed, hero: "", note: "" };
    },
    async pageState() {
      return { url: "", title: "", blocked: false, challenge: false, text: "" };
    },
    async resolve(handle: string) {
      order.push(`resolve:${handle}`);
      return normalizeProduct({ ...RAW, handle, title: handle });
    },
  } as unknown as Shop;
  const quiet = { note() {}, ok() {}, warn() {}, error() {}, step() {}, tick() {} };
  const run = await watchLoop(
    fakeShop,
    rule({ include: ["box"], silentFirstScan: false }),
    buyRule(),
    { origin: "https://mock", collections: ["all"], dryRun: false, maxRounds: 1, maxBuys: 1, intervalMs: 0, jitterMs: 0 },
    {
      async onEvents(events) {
        order.push(`buy:${events.map((e) => e.product.handle).join(",")}`);
      },
    },
    quiet,
    () => false,
  );
  ok("첫 상품을 잡자마자 산다", order[0] === "resolve:box-logo-tee" && order[1] === "buy:box-logo-tee", order.join(" → "));
  ok("산 뒤에는 남은 상품을 판정하지 않는다(페이지도 안 받는다)", !order.includes("resolve:box-logo-hood"), order.join(" → "));
  ok("한 번 사고 멈춘다", run.state.buys === 1, run.reason);
}

/**
 * HTML 폴백 상점 — 진짜 슈프림이 이 모양이다 (products.json 이 막혀 있다).
 * variant 가 없으므로 감시가 **발견**을 내려면 /products/<handle>.js 로 해석해야 한다.
 */
async function htmlFallbackTests(): Promise<void> {
  console.log("\n== HTML 폴백 상점 (진짜 슈프림과 같은 모양) ==");
  const mock = await startMockShop({ blockedProductsJson: true, blockedProductJson: true });
  const profile = join(BASE, "chrome-profile-selftest-html");
  mkdirSync(profile, { recursive: true });
  let browser: SupremeBrowser | null = null;
  try {
    browser = await SupremeBrowser.launch({
      profileDir: profile, headless: true, offscreen: false,
      captchaWidth: 0, captchaHeight: 0, origin: mock.origin, cookie: "",
    });
    const shop = new Shop((script) => browser!.run(script));
    await browser.goto(`${mock.origin}/collections/all`);

    const list = await shop.list("all");
    ok("products.json 이 막히면 HTML 로 온다", list.mode === "html" && list.products.length === 2, `${list.mode} ${list.products.length} ${list.note}`);
    ok("variant 정보가 없다", (list.products[0]?.variants.length ?? -1) === 0);

    // .js 도 막혀 있다 — 상품 페이지에 박힌 JSON 으로 해석해야 한다 (진짜 슈프림의 길).
    const byPage = await shop.resolve("box-logo-tee");
    ok("상품 페이지 JSON 으로 variant 를 얻는다", (byPage?.variants.length ?? 0) === 3, shop.lastResolveNote);
    ok("그 길을 기록한다", /상품 페이지 JSON/.test(shop.lastResolveNote), shop.lastResolveNote);
    ok("사이즈를 뽑아낸다", byPage?.variants.map((v) => v.size).join(",") === "Medium,Large,Large", byPage?.variants.map((v) => v.size).join(","));
    ok("가격은 화면 단위", byPage?.priceMin === 48, `${byPage?.priceMin}`);

    // 막힌 길(403)은 한 번만 묻는다 — 매 바퀴·매 상품마다 요청을 버리지 않게 (빠르게 사려고).
    await shop.list("all");
    await shop.resolve("box-logo-tee");
    const jsonAsks = mock.hits.filter((h) => h === "GET /collections/all/products.json").length;
    const jsAsks = mock.hits.filter((h) => h === "GET /products/box-logo-tee.js").length;
    ok("막힌 products.json 은 다시 묻지 않는다", jsonAsks === 1, `${jsonAsks}번`);
    ok("막힌 /products/<handle>.js 는 다시 묻지 않는다", jsAsks === 1, `${jsAsks}번`);

    // 감시 한 바퀴 — 발견 줄이 나와야 한다 (첫 바퀴부터 알리게 silentFirstScan 을 끈다).
    const lines: string[] = [];
    const capture = {
      note: (t: string) => lines.push(t),
      ok: (t: string) => lines.push(t),
      warn: (t: string) => lines.push(t),
      error: (t: string) => lines.push(t),
      step: (t: string) => lines.push(t),
      tick: (t: string) => lines.push(t),
    };
    const run = await watchLoop(
      shop,
      { include: [], exclude: [], colors: [], sizes: [], categories: [], maxPrice: 0, onlyAvailable: true, detectRestock: true, detectNewVariant: true, silentFirstScan: false },
      { quantity: 1, sizePriority: ["Large", "Medium"], ignoreSizeIfSingleVariant: true, sizeFallback: false },
      { origin: mock.origin, collections: ["all"], dryRun: true, maxRounds: 1 },
      { async onEvents() { /* 드라이런에서는 안 부른다 */ } },
      capture,
      () => false,
    );
    void run;
    const found = lines.find((line) => line.includes("[dry-run]"));
    ok("variant 를 해석해 발견 줄을 낸다", !!found && found.includes("/products/box-logo-tee"), found ?? lines.slice(-3).join(" / "));
    ok("회차 줄", lines.some((line) => /확인 \d+회 · 상품 \d+개/.test(line)));
    ok("카운트다운 줄", lines.some((line) => /다음 확인 \d+초/.test(line)));
  } finally {
    await browser?.quit();
    await mock.close();
  }
}

async function main(): Promise<void> {
  console.log("== 슈프림 시험 ==");
  pureTests();
  await colorFillTests();
  await buyFastTests();
  if (process.argv.includes("--browser")) {
    await browserTests();
    await htmlFallbackTests();
    await checkpointTests();
    await dropTests();
  } else console.log("\n(크롬 왕복 시험은 --browser 를 붙이면 돕니다)");

  console.log(`\n== 결과: ${passed}개 통과 · ${failures.length}개 실패 ==`);
  for (const one of failures) console.log(`   ✖ ${one}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(`시험이 터졌습니다: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
