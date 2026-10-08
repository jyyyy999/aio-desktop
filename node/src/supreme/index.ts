/**
 * 슈프림(shop.supreme.com — 2025년에 supreme.com 에서 옮겨 간 Shopify 스토어) 감시 + 자동구매.
 *
 *   npm run supreme                        감시하며 사기 (설정의 targets)
 *   npm run supreme -- --watch             같음 (명시)
 *   npm run supreme -- --once              한 바퀴만
 *   npm run supreme -- --watch --dry-run   계속 감시하되 사지 않는다 (모니터가 쓰는 모드)
 *   npm run supreme -- --dry-run           한 바퀴만 보고 사지 않는다
 *   npm run supreme -- --buy <주소|handle>  지금 바로 담고 결제까지
 *   npm run supreme -- --status            한 번 조회하고 끝 (재고만)
 *   npm run supreme -- --whoami            세션이 살아 있나
 *   npm run supreme -- --cookie            쿠키를 붙여넣어 저장 (표준입력)
 *   npm run supreme -- --reset             산 기록 지우기
 *
 * 사람이 하는 일은 **캡차와 카드사 인증(3DS)** 뿐이다. 캡차는 자동으로 풀지 않는다 —
 * 캡차가 뜨면 **캡차만 보이는 창**을 띄워 사람에게 넘기고, 풀릴 때까지 기다린다.
 * (자세한 것은 captcha.ts 머리 주석 참조)
 *
 * 크롬은 화면 밖에서 돈다 — 사람 눈에 안 보이지만 진짜 창이다. 캡차 차례가 되면 그때
 * 캡차 전용 창 하나만 화면 안으로 올라온다.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UI } from "../ui.js";
import { sleep } from "../util.js";
import { log, sayOk, sayStar, sayStep, tick, useSupremeLog, watchLog } from "./log.js";
import {
  BASE, CHROME_PROFILE, CONFIG_PATH, LOG_PATH, STATE_PATH,
  cookieOf, ensureDirs, loadConfig, loadState, nextDropTime, run, saveConfig, saveState, secretsOf, webhookOf,
  type State, type SupremeConfig, type Target,
} from "./config.js";
import { LINES } from "./lines.js";
import { describe, describeKeywords, describeOption, parseHandle, parseKeywordSpec, parseOptionSpec, pickVariant, sizeEquals, type BuyRule, type DropEvent, type MonitorRule } from "./match.js";
import { formatQueueLine, peekQueue, waitThroughQueue } from "./queue.js";
import { Shop, type Product, type Variant } from "./site.js";
import { SupremeBrowser, BrowserError } from "./browser.js";
import { addToCart, runCheckout, type BuyOptions, type Profile as CheckoutProfile } from "./checkout.js";
import { notifyBlocked, notifyCaptcha, notifyFound, notifyPaid } from "./notify.js";
import { watchLoop, type WatchOptions } from "./watch.js";

const HELP = `슈프림(shop.supreme.com) 재고 감시 + 자동구매

  npm run supreme [옵션]

  --watch              감시하며 삽니다 (기본)
  --once               한 바퀴만 확인하고 끝냅니다
  --dry-run            사지 않습니다 (--watch 와 같이 쓰면 계속 감시만 합니다)
  --buy <주소|handle>   기다리지 않고 지금 담아 결제까지 갑니다
  --ea <수량>           --buy 의 수량 (기본 1)
  --drop                드랍(큐 태우기) — 미끼를 담아 큐를 태우고 주문창에서 기다렸다가 바꿔 담고 결제
  --preload <주소>       --drop 에서 큐를 태울 미끼 상품 (설정 drop.preload_url 보다 먼저)
  --drop-at HH:MM:SS    드랍 시각 (설정 drop.drop_at 보다 먼저)
  --swap-to <주소>       드랍 때 바꿔 담을 상품 (설정 drop.swap_to_url · targets 보다 먼저)
  --queue-check         지금 대기열인지 · 몇 번째인지 · 예상 몇 초인지 보고 끝냅니다
  --keys "<사양>"        링크 없이 키워드로 삽니다 — 예: --keys "+box +logo -jacket"
                         #카테고리 로 좁힐 수 있습니다 — 예: --keys "#jackets +box" (훨씬 빠름)
  --size <옵션>          --keys 로 찾은 상품에서 고를 사이즈 (예: Large)
  --status             한 번 조회하고 끝냅니다 (쿠키 없이도 됩니다)
  --whoami             저장된 세션이 살아 있나 봅니다
  --cookie [값]         세션 쿠키를 설정에 적습니다 (값이 없으면 표준입력, '-' 도 표준입력)
  --reset              산 기록을 지웁니다 (다시 사려면 필요합니다)
  -h, --help           이 도움말

  설정:  ${CONFIG_PATH}
  로그:  ${LOG_PATH}

  캡차는 사람이 풉니다 — 캡차가 뜨면 캡차만 보이는 창을 띄웁니다.

환경변수
  SUPREME_HOME     설정·상태·로그·크롬 프로필의 집 (태스크마다 다르다)
  SUPREME_COOKIE   세션 쿠키 한 줄 (설정보다 먼저 본다)
  SUPREME_WEBHOOK  디스코드 웹훅 (설정보다 먼저 본다)`;

interface Args {
  watch: boolean;
  once: boolean;
  dryRun: boolean;
  buy: string | null;
  ea: number;
  status: boolean;
  whoami: boolean;
  reset: boolean;
  help: boolean;
  cookie: string | null;
  /** 키워드로 사기 (링크 없이) */
  keys: string | null;
  size: string | null;
  /** 드랍(큐 태우기) */
  drop: boolean;
  preload: string | null;
  dropAt: string | null;
  swapTo: string | null;
  queueCheck: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    watch: false, once: false, dryRun: false, buy: null, ea: 1,
    status: false, whoami: false, reset: false, help: false, cookie: null,
    keys: null, size: null,
    drop: false, preload: null, dropAt: null, swapTo: null, queueCheck: false,
  };
  const isFlag = (v: string | undefined) => v !== undefined && v.startsWith("--");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--watch": args.watch = true; break;
      case "--once": args.once = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--status": case "--stock": args.status = true; break;
      case "--whoami": args.whoami = true; break;
      case "--reset": args.reset = true; break;
      case "--drop": args.drop = true; break;
      case "--queue-check": args.queueCheck = true; break;
      case "-h": case "--help": args.help = true; break;
      case "--buy": args.buy = argv[++i] ?? null; break;
      case "--ea": args.ea = Math.max(1, Number(argv[++i] ?? 1) || 1); break;
      case "--preload": args.preload = argv[++i] ?? null; break;
      case "--drop-at": args.dropAt = argv[++i] ?? null; break;
      case "--swap-to": args.swapTo = argv[++i] ?? null; break;
      case "--keys": case "--keywords": args.keys = argv[++i] ?? null; break;
      case "--size": case "--option": args.size = argv[++i] ?? null; break;
      // 값 없이 써도 되는 옵션. 뒤에 오는 것이 옵션이면 값이 없는 것이다.
      case "--cookie": args.cookie = isFlag(argv[i + 1]) || argv[i + 1] === undefined ? "" : argv[++i]!; break;
      default:
        if (arg.includes("=") && arg.split("=").length > 2) {
          throw new Error(
            `쿠키를 명령줄에 붙여넣은 것 같습니다 (셸이 ${JSON.stringify(arg.slice(0, 30))} … 로 쪼갰습니다).\n` +
            "Cookie 줄을 복사한 뒤 값 없이 부르세요:  npm run supreme -- --cookie",
          );
        }
        throw new Error(`모르는 인자입니다: ${arg}\n\n${HELP}`);
    }
  }
  return args;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

/* ── 설정 → 규칙 ───────────────────────────────────────────── */

function monitorRule(cfg: SupremeConfig): MonitorRule {
  return {
    include: cfg.include_keywords,
    exclude: cfg.exclude_keywords,
    colors: cfg.colors,
    sizes: cfg.sizes,
    categories: [],
    maxPrice: cfg.max_price,
    onlyAvailable: cfg.monitor_only_available,
    detectRestock: cfg.detect_restock,
    detectNewVariant: cfg.detect_new_variant,
    silentFirstScan: cfg.silent_first_scan,
  };
}

function buyRule(cfg: SupremeConfig, ea = 0): BuyRule {
  return {
    quantity: ea > 0 ? ea : cfg.buy.quantity,
    sizePriority: cfg.buy.size_priority,
    ignoreSizeIfSingleVariant: cfg.buy.ignore_size_if_single_variant,
    sizeFallback: cfg.buy.size_fallback,
  };
}

/**
 * 살 준비가 됐나 — **담기 전에** 본다.
 *
 * 2026-10-08: 배송 정보가 통째로 비어 있는 채로 돌아서, 장바구니에 담고 주문서까지 간 뒤에야
 * "0칸 입력" 으로 멈췄다. 사람이 보기 전에는 아무도 그 사실을 몰랐다. 그래서 먼저 본다.
 * → 빠진 칸 목록 (빈 목록이면 살 수 있다)
 */
function missingProfileFields(cfg: SupremeConfig, needPay: boolean): string[] {
  const p = cfg.profile;
  const wanted: [string, string, string][] = [
    ["email", p.email, "이메일"],
    ["first_name", p.first_name, "이름"],
    ["last_name", p.last_name, "성"],
    ["address1", p.address1, "주소"],
    ["city", p.city, "도시"],
    ["zip", p.zip, "우편번호"],
    ["phone", p.phone, "전화번호"],
  ];
  const missing = wanted.filter(([, value]) => !String(value || "").trim()).map(([key, , label]) => `profile.${key} (${label})`);
  if (needPay) {
    // 카드 정보는 환경변수로 와도 된다 (대시보드가 암호화해 보관하다가 실행할 때만 넘긴다).
    const secret = secretsOf(cfg);
    if (!secret.card_number) missing.push("카드 번호 (profile.card_number 또는 SUPREME_CARD_NUMBER)");
    if (!secret.card_expiry) missing.push("카드 만료 (profile.card_expiry 또는 SUPREME_CARD_EXPIRY)");
    if (!secret.card_cvv) missing.push("카드 CVC (profile.card_cvv 또는 SUPREME_CARD_CVV)");
    if (!secret.card_holder) missing.push("카드 소유자명 (profile.card_holder 또는 SUPREME_CARD_HOLDER)");
  }
  return missing;
}

/**
 * 없어도 담기는 하지만, 없으면 **사람이 그 칸만** 채워야 하는 것들.
 * 한국(Global-e) 카드 결제는 생년월일·카드 PIN 앞 2자리를 요구한다 — 막지는 않고 경고한다.
 */
function optionalGaps(cfg: SupremeConfig): string[] {
  if (!cfg.buy.click_pay) return [];
  const secret = secretsOf(cfg);
  const gaps: string[] = [];
  if (!secret.date_of_birth) gaps.push("생년월일 (profile.date_of_birth / SUPREME_DOB)");
  if (!secret.card_pin_first_two) gaps.push("카드 PIN 앞 2자리 (profile.card_pin_first_two / SUPREME_CARD_PIN2)");
  return gaps;
}

/** 못 살 이유를 사람에게 자세히 알리고 멈춘다. */
function refuseToBuy(cfg: SupremeConfig, missing: string[]): never {
  log.error("배송 정보가 비어 있어 주문서를 채울 수 없습니다 — 담지 않았습니다.");
  log.error(`   이 태스크의 설정: ${CONFIG_PATH}`);
  log.error("   대시보드로 돌린다면 **씨앗 설정**을 채워야 합니다 — 태스크는 띄울 때 그걸 베낍니다:");
  log.error("     (대시보드) 설정 창의 슈프림 '원본 폴더' 옆 씨앗 설정  ·  (손으로) aio/node/supreme_config.json");
  for (const one of missing) log.error(`   · ${one}`);
  if (cfg.buy.click_pay) log.error("   결제까지 가려면 카드 정보도 있어야 합니다 (없으면 buy.click_pay 를 false 로).");
  process.exit(1);
}

function watchOptions(cfg: SupremeConfig, dryRun: boolean, maxBuys: number, maxRounds = 0): WatchOptions {
  return {
    origin: cfg.origin,
    collections: cfg.collections,
    intervalMs: cfg.check_interval_ms,
    jitterMs: cfg.jitter_ms,
    maxBackoffMs: 30_000,
    maxRetries: cfg.max_retries,
    retryDelayMs: cfg.retry_delay_ms,
    durationMs: cfg.monitor_duration_ms,
    maxRounds,
    dryRun,
    stopOnFound: cfg.buy.stop_after_success,
    maxBuys,
  };
}

function checkoutProfile(cfg: SupremeConfig): CheckoutProfile {
  const p = cfg.profile;
  const secret = secretsOf(cfg);
  return {
    email: p.email, firstName: p.first_name, lastName: p.last_name, company: p.company,
    address1: p.address1, address2: p.address2, city: p.city, state: p.state, zip: p.zip,
    country: p.country, phone: p.phone,
    card: { number: secret.card_number, expiry: secret.card_expiry, cvv: secret.card_cvv, holder: secret.card_holder },
    billingSameAsShipping: p.billing_same_as_shipping,
    // 슈프림 주문창(Global-e)에만 있는 것들
    dateOfBirth: secret.date_of_birth,
    cardPinFirstTwo: secret.card_pin_first_two,
    personalCustomsCode: secret.personal_customs_code,
    saveShippingInformation: p.save_shipping_information,
    agree: {
      age14: p.agree_age14,
      globale_tos: p.agree_globale_tos,
      privacy: p.agree_privacy,
      third_party: p.agree_third_party,
      supreme_tos: p.agree_supreme_tos,
    },
  };
}

function buyOptions(cfg: SupremeConfig): BuyOptions {
  return {
    quantity: cfg.buy.quantity,
    clickPay: cfg.buy.click_pay,
    fillPayment: cfg.buy.fill_payment,
    payDelayMs: cfg.buy.pay_delay_ms,
    threeDsHandoff: cfg.buy.three_ds_handoff,
    stepTimeoutMs: 45_000,
    captchaTimeoutMs: cfg.captcha.timeout_ms,
    handoffOnFailure: cfg.buy.handoff_on_failure,
    shippingPrefer: cfg.buy.shipping_prefer,
  };
}

/** 설정에서 이 주소(handle)에 해당하는 대상 한 줄. 없으면 주소만으로 만든다. */
function targetFor(cfg: SupremeConfig, url: string, ea = 0): Target {
  const handle = parseHandle(url);
  const found = cfg.targets.find((t) => parseHandle(t.url) === handle);
  if (found) return { ...found, ea: ea > 0 ? ea : found.ea || 1 };
  return { url: url.trim(), option: "", ea: ea > 0 ? ea : cfg.buy.quantity, max_price: cfg.max_price, label: handle };
}

/* ── 브라우저 ─────────────────────────────────────────────── */

async function openBrowser(cfg: SupremeConfig): Promise<SupremeBrowser> {
  ensureDirs();
  const browser = await SupremeBrowser.launch({
    profileDir: CHROME_PROFILE,
    headless: cfg.browser.headless,
    offscreen: cfg.browser.offscreen,
    captchaWidth: 0,
    captchaHeight: 0,
    origin: cfg.origin,
    cookie: cookieOf(cfg),
  });
  // 캡차 창이 뜨면 폰으로도 알린다 (사람이 자리를 비웠을 수 있다).
  browser.onCaptchaWindow = () => {
    sayStar(LINES.captchaWindow(cfg.captcha.mode === "hide" ? "캡차만 보이는 창" : "캡차 강조 창"));
    void notifyCaptcha(cfg, cfg.targets[0] ?? null);
  };
  return browser;
}

/** 페이지가 홈(스토어프론트 오리진)에 있게 한다 — 페이지 안 fetch 는 같은 오리진에서만 뜻이 있다. */
async function shopOf(browser: SupremeBrowser, cfg: SupremeConfig): Promise<Shop> {
  return new Shop(
    async (script: string) => {
      const here = await browser.url();
      if (!here.startsWith(cfg.origin)) await browser.goto(cfg.origin);
      return browser.run(script);
    },
    // 컬렉션 주소로 **먼저 이동**한다 — 홈을 긁으면 신상품 36개만 보인다 (2026-10-08).
    { goto: (url: string) => browser.goto(url), origin: cfg.origin },
  );
}

/* ── 감시 ─────────────────────────────────────────────────── */

/** 살 것 하나를 끝까지 (담기 → 체크아웃 → 결제). */
async function buyProduct(
  browser: SupremeBrowser, shop: Shop, cfg: SupremeConfig, state: State,
  product: Product, variant: Variant, target: Target, quantity: number,
): Promise<boolean> {
  // 담기 **전에** 살 수 있는 상태인지 본다 (2026-10-08: 빈 배송정보로 담아 놓고 주문서에서 멈췄다).
  const missing = missingProfileFields(cfg, cfg.buy.click_pay);
  if (missing.length) {
    log.error(`배송 정보가 비어 있어 담지 않습니다 — ${missing.join(", ")}`);
    log.error(`   채울 곳: ${CONFIG_PATH} (대시보드로 돌린다면 씨앗 설정)`);
    return false;
  }

  const what = describe(product, variant);
  sayOk(LINES.buying(what));

  const added = await addToCart(shop, product.handle, variant.id, quantity, browser);
  if (!added.ok) {
    log.error(LINES.failed("장바구니", added.reason));
    return false;
  }
  const cart = await shop.cart();
  sayOk(LINES.carted(cart.count, what));
  void notifyFound(cfg, target, `${what} · ${added.reason}`, product.image);

  sayStep(LINES.checkout("체크아웃으로 갑니다"));
  // **바로 포기하지 않는다.** 한 판이 실패하면 장바구니를 다시 확인하고 처음부터 다시 해 본다
  // (사람이 캡차를 풀어 주는 사이 화면이 바뀌거나, 결제 화면이 늦게 그려지는 일이 흔하다).
  const attempts = Math.max(1, cfg.buy.retry_attempts);
  let result: Awaited<ReturnType<typeof runCheckout>> | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    result = await runCheckout(browser, shop, checkoutProfile(cfg), cfg.origin, buyOptions(cfg), async (orderNo) => {
      state._buy.push({ at: new Date().toISOString(), url: `${cfg.origin}${product.url}`, order_no: orderNo, what });
      saveState(state);
      sayStar(LINES.paid(orderNo));
      await notifyPaid(cfg, orderNo, what, cart.total);
    });
    if (result.ok || result.stage === "handed-off") break;
    if (attempt < attempts) {
      log.warn(`구매 실패(${attempt}/${attempts}) — ${result.stage}: ${result.reason}`);
      log.warn(`   ${Math.round(cfg.buy.retry_delay_ms / 1000)}초 뒤 처음부터 다시 시도합니다`);
      await browser.sleep(cfg.buy.retry_delay_ms);
      const cartNow = await shop.cart();
      if (cartNow.count <= 0) {
        log.warn("장바구니가 비었습니다 — 다시 담고 시도합니다");
        const again = await addToCart(shop, product.handle, variant.id, quantity, browser);
        if (!again.ok) log.error(`다시 담지 못했습니다: ${again.reason}`);
      }
      await browser.goto(`${cfg.origin}/checkout`);
    }
  }
  if (!result) return false;

  for (const step of result.steps) log.info(`   ${step.ok ? "✔" : "✖"} ${step.step}: ${step.reason}`);
  if (!result.ok) {
    if (result.screenshot) log.info(`   화면: ${result.screenshot}`);
    log.error(LINES.failed("구매", `${result.stage} — ${result.reason}`));
    if (result.stage === "handed-off") sayStar("창을 사람에게 넘겼습니다 — 창에서 이어서 끝내 주세요");
    return false;
  }
  await browser.closeCaptchaWindow();
  return true;
}

async function runWatch(cfg: SupremeConfig, state: State, args: Args): Promise<void> {
  const dryRun = args.dryRun;
  const browser = await openBrowser(cfg);
  const shop = await shopOf(browser, cfg);
  const rule = monitorRule(cfg);
  const buy = buyRule(cfg);
  const options = watchOptions(cfg, dryRun, cfg.buy.max_buys_per_run);
  let stop = false;
  let bought = 0;

  UI.banner("SUPREME · shop.supreme.com", [
    dryRun ? "[dry-run] 사지 않고 봅니다" : "재고가 열리면 담아서 결제까지 갑니다",
    `확인 간격 ${cfg.check_interval_ms / 1000}초 · 컬렉션 ${cfg.collections.join(", ")}`,
    cfg.browser.offscreen ? "크롬은 화면 밖에서 돕니다 — 진행 상황은 여기 콘솔에 나옵니다" : "크롬 창이 보입니다",
    "캡차가 뜨면 캡차만 보이는 창을 띄웁니다 — 사람이 풀면 이어서 진행합니다",
    webhookOf(cfg) ? "알림: 디스코드" : "알림 없음 (웹훅이 없습니다)",
    dryRun && !cookieOf(cfg) ? "쿠키 없이 공개 목록만 봅니다" : null,
  ].filter((line): line is string => !!line));

  try {
    const hooks = {
      async onEvents(
        _events: DropEvent[],
        decided: { event: DropEvent; decision: { variant: Variant | null; reason: string } }[],
      ) {
        // **decision.variant 를 쓴다.** event.variant 는 슈프림(HTML 폴백)에서 늘 null 이다 —
        // 그걸 보고 "variant 정보가 없다" 며 조용히 넘어간 것이 구매가 안 되던 원인이었다 (2026-10-08).
        for (const { event, decision } of decided) {
          if (stop || bought >= cfg.buy.max_buys_per_run) return;
          const variant = decision.variant;
          if (!variant) {
            log.warn(`사이즈를 못 골라 담지 않습니다 — ${decision.reason}`);
            continue;
          }
          const target = targetFor(cfg, event.product.url, buy.quantity > 0 ? buy.quantity : 0);
          if (target.max_price > 0 && event.product.priceMin > target.max_price) {
            log.info(`상한가(${target.max_price})를 넘어 담지 않습니다 — ${describe(event.product, variant)}`);
            continue;
          }
          const ok = await buyProduct(browser, shop, cfg, state, event.product, variant, target, buy.quantity);
          if (ok) {
            bought++;
            if (cfg.buy.stop_after_success) {
              stop = true;
              log.info("샀습니다 — stop_after_success 이므로 멈춥니다");
              return;
            }
          } else if (cfg.buy.handoff_on_failure) {
            // 실패했으면 사람이 창에서 볼 수 있게 남겨 두고 이번 판은 접는다.
            log.warn("이번 판은 접습니다 — 창을 확인해 주세요");
            stop = cfg.buy.stop_after_success;
            return;
          }
        }
      },
      async onBlocked(state2: { url: string; text: string }) {
        sayStar(LINES.blocked(state2.text.slice(0, 80)));
        await notifyBlocked(cfg, state2.text.slice(0, 200));
        // 창을 사람에게 보여 주고, 사람이 통과하면 이어서 본다.
        await browser.showToHuman("사람 확인(봇 차단) 화면입니다 — 창에서 통과해 주세요");
        const waited = Date.now();
        while (Date.now() - waited < 300_000) {
          if (stop || browser.cancelled()) return;
          await sleep(3000);
          const now = await shop.pageState();
          if (!now.blocked && !now.challenge) {
            sayOk("사람 확인을 통과했습니다 — 감시를 이어갑니다");
            await browser.background();
            return;
          }
        }
        log.warn("사람 확인을 통과하지 못했습니다 — 이어서 봅니다");
      },
      onRound(info: { round: number; products: number; events: number }) {
        state.rounds = info.round;
        state.last_check_at = new Date().toISOString();
        saveState(state);
      },
    };

    const result = await watchLoop(shop, rule, buy, options, hooks, watchLog(), () => stop || browser.cancelled());
    if (!result.ok) {
      log.error(LINES.failed("감시", result.reason));
      process.exitCode = 1;
    }
  } finally {
    saveState(state);
    await browser.quit();
  }
}

/** 한 바퀴만 보고 끝 (--once · --dry-run 단독) */
async function runOnce(cfg: SupremeConfig, state: State, dryRun: boolean): Promise<void> {
  const browser = await openBrowser(cfg);
  const shop = await shopOf(browser, cfg);
  try {
    // **실행할 때마다 장바구니를 비운다** (지난 판의 미끼·실패한 담기가 남아 함께 결제되지 않게).
    if (cfg.buy.clear_cart_first) {
      const before = await shop.cart();
      if (before.count > 0) {
        const cleared = await shop.clearCart();
        if (cleared.ok) log.info(`장바구니를 비웠습니다 (${before.count}개 → 0개)`);
        else log.warn(`장바구니를 못 비웠습니다: ${cleared.reason}`);
      }
    }
    await watchLoop(
      shop,
      monitorRule(cfg),
      buyRule(cfg),
      watchOptions(cfg, dryRun, 1, 1),
      {
        async onEvents(
          _events: DropEvent[],
          decided: { event: DropEvent; decision: { variant: Variant | null; reason: string } }[],
        ) {
          for (const { event, decision } of decided) {
            const variant = decision.variant;
            if (!variant) {
              log.warn(`사이즈를 못 골라 담지 않습니다 — ${decision.reason}`);
              continue;
            }
            const target = targetFor(cfg, event.product.url, 0);
            await buyProduct(browser, shop, cfg, state, event.product, variant, target, cfg.buy.quantity);
            break; // 한 바퀴에서는 하나만
          }
        },
        async onBlocked(state2: { url: string; text: string }) {
          sayStar(LINES.blocked(state2.text.slice(0, 80)));
          await notifyBlocked(cfg, state2.text.slice(0, 200));
          await browser.showToHuman("사람 확인(봇 차단) 화면입니다 — 창에서 통과해 주세요");
        },
        onRound(info: { round: number }) {
          state.rounds = info.round;
          state.last_check_at = new Date().toISOString();
          if (!dryRun) saveState(state);
        },
      },
      watchLog(),
      () => browser.cancelled(),
    );
  } finally {
    if (!dryRun) saveState(state);
    await browser.quit();
  }
}

/* ── 한 번 부르고 끝나는 명령 ─────────────────────────────── */

async function cmdWhoami(cfg: SupremeConfig): Promise<void> {
  const cookie = cookieOf(cfg);
  if (!cookie) throw new Error("세션 쿠키가 없습니다. --cookie 로 세션 쿠키를 넣어주세요.");
  const browser = await openBrowser(cfg);
  try {
    await browser.goto(`${cfg.origin}/account`);
    const here = await browser.url();
    if (/\/account\/login|\/challenge|password/i.test(here)) {
      throw new Error("로그인되어 있지 않습니다. --cookie 로 쿠키를 다시 넣어주세요.");
    }
    const title = (await browser.run("return document.title")) as string;
    sayOk(`로그인됨 — ${title || here}`);
  } finally {
    await browser.quit();
  }
}

async function cmdStatus(cfg: SupremeConfig): Promise<void> {
  const browser = await openBrowser(cfg);
  try {
    const shop = await shopOf(browser, cfg);
    for (const collection of cfg.collections) {
      const list = await shop.list(collection);
      const inStock = list.products.filter((p) => p.available);
      log.info(`[${collection}] ${list.mode} · 상품 ${list.products.length}개 · 재고 있음 ${inStock.length}개 (${list.note})`);
      for (const product of inStock.slice(0, 40)) {
        const sizes = product.variants.filter((v) => v.available).map((v) => v.size || v.title).join(", ");
        log.info(`   ${product.title}${product.priceMin ? ` · ${product.priceMin}` : ""}${sizes ? ` · ${sizes}` : ""}`);
      }
      if (inStock.length > 40) log.info(`   … 그 밖에 ${inStock.length - 40}개`);
      if (list.mode === "none") {
        const state = await shop.pageState();
        log.warn(`목록을 못 얻었습니다 — ${state.blocked ? "사람 확인 화면" : state.title} ${state.text.slice(0, 100)}`);
        if (state.blocked || state.challenge) log.warn(LINES.blocked("사람 확인 화면 — 창에서 통과해 주세요"));
      }
    }
  } finally {
    await browser.quit();
  }
}

async function cmdCookie(cfg: SupremeConfig, value: string | null): Promise<void> {
  let cookie = (value ?? "").trim();
  if (!cookie || cookie === "-") cookie = (await readStdin()).trim();
  if (!cookie) throw new Error("쿠키가 비었습니다. Cookie 줄을 붙여넣고 표준입력을 닫아 주세요 (Ctrl+Z, Enter).");
  if (!/;/.test(cookie) && !/^[^=]+=[^=]+$/.test(cookie)) {
    log.warn("쿠키 한 줄 같지 않습니다 — 그대로 적습니다.");
  }
  writeFileSync(join(BASE, "supreme-cookie.txt"), `${cookie}\n`, "utf-8");
  const pieces = cookie.split(";").filter((p) => p.includes("=")).length;
  sayOk(`쿠키 ${pieces}개를 저장했습니다 (${join(BASE, "supreme-cookie.txt")}).`);
  const hasClearance = /cf_clearance=/.test(cookie);
  if (hasClearance) sayOk("cf_clearance 가 있습니다 — 사람 확인(Cloudflare)을 다시 하지 않아도 됩니다.");
  else log.warn("cf_clearance 가 없습니다 — 사람 확인이 다시 뜰 수 있습니다 (창에서 한 번 통과하면 이 쿠키가 생깁니다).");
}

function cmdReset(): void {
  const state = loadState();
  if (existsSync(STATE_PATH)) {
    const count = state._buy.length;
    state._buy = [];
    saveState(state);
    log.info(`산 기록 ${count}건을 지웠습니다.`);
  } else {
    log.info("지울 기록이 없습니다.");
  }
}

/** 이 시각까지 기다린다 — 남은 초를 제자리 줄로 계속 보여 준다. */
async function waitUntil(browser: SupremeBrowser, untilMs: number, label: string): Promise<void> {
  let lastLog = 0;
  while (Date.now() < untilMs) {
    if (browser.cancelled()) return;
    const left = Math.max(0, Math.round((untilMs - Date.now()) / 1000));
    tick(`${label} ${left}초`);
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      log.info(`${label} ${left}초`);
    }
    await sleep(1000);
  }
}

/**
 * **드랍(큐 태우기)** — 봇들이 쓰는 방식 그대로.
 *
 *   1. 드랍 lead 분 전에 **미끼 상품**을 담는다
 *   2. /checkout 로 가서 **큐를 태운다** (대기열이면 앞 인원·예상 시간을 계속 찍는다) → 주문창에 들어가 대기
 *   3. 드랍 시각까지 주문창을 붙들고 기다린다
 *   4. 드랍 시각에 장바구니를 **원하는 상품으로 교체**한다 (미끼 비우고 새로 담기)
 *   5. 다시 주문창으로 (이미 통과한 큐라 곧바로) → 배송·카드·동의 → 결제
 */
async function runPreloadDrop(cfg: SupremeConfig, state: State, args: Args): Promise<void> {
  const drop = cfg.drop;
  const preloadUrl = (args.preload || drop.preload_url || "").trim();
  const swapUrl = (args.swapTo || drop.swap_to_url || cfg.targets[0]?.url || "").trim();
  const at = (args.dropAt || drop.drop_at || "").trim();
  if (!preloadUrl) throw new Error("미끼 상품이 없습니다 — --preload <주소> 또는 설정 drop.preload_url 을 채우세요.");
  if (!swapUrl) throw new Error("바꿔 담을 상품이 없습니다 — --swap-to <주소> 또는 설정 drop.swap_to_url·targets 를 채우세요.");
  const dropAt = nextDropTime(at, drop.late_grace_minutes);
  if (dropAt === null) throw new Error(`드랍 시각을 못 읽었습니다: ${JSON.stringify(at)} (HH:MM:SS 로 적어 주세요)`);

  const missing = missingProfileFields(cfg, cfg.buy.click_pay);
  if (missing.length) refuseToBuy(cfg, missing);
  const gaps = optionalGaps(cfg);
  if (gaps.length) log.warn(`이 칸들은 설정에 없어 창에서 직접 채워야 합니다: ${gaps.join(", ")}`);

  const checkoutUrl = `${cfg.origin}/checkout`;
  const queueOpts = {
    url: checkoutUrl,
    timeoutMs: Math.max(1, drop.queue_timeout_minutes) * 60_000,
    reloadEveryMs: 60_000,
  };

  UI.banner("SUPREME · 드랍 (큐 태우기)", [
    `드랍 ${new Date(dropAt).toLocaleString("ko-KR")} · 미끼 ${drop.preload_lead_minutes}분 전에 담습니다`,
    `미끼 ${preloadUrl}`,
    `바꿔 담을 상품 ${swapUrl}`,
    "큐를 미리 태워 주문창에 들어가 기다립니다 — 큐가 뜨면 앞 인원·예상 시간이 여기 나옵니다",
    "캡차가 뜨면 캡차만 보이는 창을 띄웁니다",
  ]);

  const browser = await openBrowser(cfg);
  const shop = await shopOf(browser, cfg);
  try {
    // **실행할 때마다 장바구니를 비운다.** 지난 판의 미끼·실패한 담기가 남아 있으면
    // 엉뚱한 것이 함께 결제된다 (2026-10-08 사용자 요청).
    if (cfg.buy.clear_cart_first) {
      const before = await shop.cart();
      if (before.count > 0) {
        const cleared = await shop.clearCart();
        if (cleared.ok) log.info(`장바구니를 비웠습니다 (${before.count}개 → 0개) — ${before.items.map((i) => i.title).join(", ").slice(0, 120)}`);
        else log.warn(`장바구니를 못 비웠습니다: ${cleared.reason}`);
      }
    }
    // 1) 미끼 담기
    const startAt = dropAt - Math.max(0, drop.preload_lead_minutes) * 60_000;
    if (startAt > Date.now()) {
      sayStep(`미끼는 ${drop.preload_lead_minutes}분 전에 담습니다 — ${Math.round((startAt - Date.now()) / 1000)}초 기다립니다`);
      await waitUntil(browser, startAt, "미끼 담기까지");
    }
    const pre = await shop.resolve(parseHandle(preloadUrl));
    const preVariant = pre?.variants.find((v) => v.available);
    if (!pre || !preVariant) throw new Error(`미끼 상품에서 살 수 있는 사이즈를 못 찾았습니다: ${preloadUrl} — ${shop.lastResolveNote}`);
    const added = await addToCart(shop, pre.handle, preVariant.id, 1, browser);
    if (!added.ok) throw new Error(`미끼를 담지 못했습니다 — ${added.reason}`);
    sayOk(`미끼를 담았습니다 — ${describe(pre, preVariant)}`);

    // 2) 큐 태우기
    sayStep("큐를 태우러 주문창으로 갑니다");
    await browser.goto(checkoutUrl);
    const passed = await waitThroughQueue(browser, queueOpts);
    if (!passed.ok) {
      log.error(LINES.failed("대기열", passed.reason));
      await notifyBlocked(cfg, `대기열을 통과하지 못했습니다: ${passed.reason}`);
      await browser.showToHuman("대기열을 통과하지 못했습니다 — 창에서 확인해 주세요");
      return;
    }
    sayStar("주문창에 들어갔습니다 — 드랍 시각까지 이 창을 붙들고 기다립니다 (닫지 마세요)");

    // 3) 드랍 시각까지 (주문창 유지). 그 사이에 대기열이 다시 뜨면 계속 태운다.
    while (Date.now() < dropAt - 2000) {
      if (browser.cancelled()) return;
      const left = Math.round((dropAt - Date.now()) / 1000);
      tick(`드랍까지 ${left}초`);
      if (left % 15 === 0) log.info(`드랍 ${new Date(dropAt).toLocaleTimeString("ko-KR")} 까지 ${left}초 — 주문창 대기 중`);
      const stage = (await shop.stage()) as { path?: string } | null;
      if (stage && /queue|waiting|line/i.test(String(stage.path ?? ""))) {
        log.info("대기열이 다시 떴습니다 — 계속 태웁니다");
        const again = await waitThroughQueue(browser, { ...queueOpts, timeoutMs: 10 * 60_000 });
        if (!again.ok) log.warn(`대기열 재진입 실패: ${again.reason}`);
      }
      await sleep(1000);
    }

    // 4) 장바구니 교체
    sayStep(`장바구니를 바꿉니다 — ${swapUrl}`);
    const cleared = await shop.clearCart();
    if (!cleared.ok) log.warn(`미끼를 못 비웠습니다 (${cleared.reason}) — 그대로 진행합니다`);
    else log.info(cleared.reason);
    const target = await shop.resolve(parseHandle(swapUrl));
    if (!target) throw new Error(`바꿔 담을 상품을 해석하지 못했습니다: ${swapUrl} — ${shop.lastResolveNote}`);
    const chosen = pickVariant(target, buyRule(cfg), monitorRule(cfg));
    if (!chosen.variant) {
      log.error(`바꿔 담을 사이즈를 못 골랐습니다 — ${chosen.reason}`);
      await browser.showToHuman("원하는 사이즈가 없습니다 — 창에서 직접 담아 주세요");
      return;
    }
    const swapped = await addToCart(shop, target.handle, chosen.variant.id, cfg.buy.quantity, browser);
    if (!swapped.ok) throw new Error(`바꿔 담지 못했습니다 — ${swapped.reason}`);
    sayOk(`바꿔 담았습니다 — ${describe(target, chosen.variant)}`);

    // 5) 다시 주문창 → 결제
    await browser.goto(checkoutUrl);
    const again = await waitThroughQueue(browser, { ...queueOpts, timeoutMs: 3 * 60_000, reloadEveryMs: 30_000 });
    if (!again.ok) log.warn(`다시 들어올 때 대기열이 떴습니다: ${again.reason}`);
    const result = await runCheckout(browser, shop, checkoutProfile(cfg), cfg.origin, buyOptions(cfg), async (orderNo) => {
      state._buy.push({ at: new Date().toISOString(), url: `${cfg.origin}${target.url}`, order_no: orderNo, what: describe(target, chosen.variant) });
      saveState(state);
      await notifyPaid(cfg, orderNo, describe(target, chosen.variant));
    });
    for (const step of result.steps) log.info(`   ${step.ok ? "✔" : "✖"} ${step.step}: ${step.reason}`);
    if (result.ok) {
      sayStar(LINES.paid(result.orderNo));
      await browser.closeCaptchaWindow();
    } else {
      log.error(LINES.failed("드랍 구매", `${result.stage} — ${result.reason}`));
    }
  } finally {
    saveState(state);
    await browser.quit();
  }
}

/** 지금 대기열인지·몇 번째인지·예상 몇 초인지 한 번 보고 끝낸다 (드랍 전에 문구를 확인할 때). */
async function cmdQueueCheck(cfg: SupremeConfig): Promise<void> {
  const browser = await openBrowser(cfg);
  try {
    const outcome = await peekQueue(browser, `${cfg.origin}/checkout`);
    const info = outcome.info;
    log.info(`대기열: ${info?.inQueue ? "안에 있음" : "아님"} · 주문창: ${info?.formReady ? "떴음" : "아직"}`);
    log.info(formatQueueLine(info ?? { ahead: null, total: null, eta: null }));
    if (info?.cookies.length) log.info(`대기열 쿠키: ${info.cookies.join(", ")}`);
    log.info(`주소: ${info?.url ?? "?"} · 제목: ${info?.title ?? "?"}`);
    log.info(`본문: ${(info?.text ?? "(없음)").slice(0, 400)}`);
    if (!info?.inQueue && !info?.formReady) log.warn("대기열도 주문창도 아닙니다 — 차단 화면이거나 아직 그려지는 중일 수 있습니다");
  } finally {
    await browser.quit();
  }
}

/* ── 진입점 ───────────────────────────────────────────────── */

function bannerOf(cfg: SupremeConfig): void {
  UI.banner("SUPREME", [
    `상품 ${cfg.targets.length}개 · 확인 간격 ${cfg.check_interval_ms / 1000}초`,
    cfg.buy.enabled ? "자동구매 켜짐" : "자동구매 꺼짐 (감시만)",
    cfg.buy.click_pay ? "결제 버튼까지 누릅니다" : "결제 버튼 앞에서 멈춥니다",
    "캡차는 사람이 풉니다",
  ]);
}

async function main(): Promise<void> {
  useSupremeLog();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  ensureDirs();
  run.dryRun = args.dryRun;
  const cfg = loadConfig();
  if (!existsSync(CONFIG_PATH)) {
    saveConfig(cfg);
    log.info(`설정 파일을 만들었습니다: ${CONFIG_PATH}`);
  }
  const state = loadState();

  if (args.reset) return cmdReset();
  if (args.cookie !== null) return cmdCookie(cfg, args.cookie);
  if (args.whoami) return cmdWhoami(cfg);
  if (args.status) return cmdStatus(cfg);
  if (args.queueCheck) return cmdQueueCheck(cfg);

  // 키워드로 사기 (링크 없이) — 감시하다 걸리면 담아서 결제까지.
  if (args.keys) {
    const spec = parseKeywordSpec(args.keys);
    if (!spec.include.length && !spec.exclude.length) {
      throw new Error(`키워드를 못 읽었습니다: ${JSON.stringify(args.keys)} — 예: +box +logo -jacket`);
    }
    cfg.include_keywords = spec.include;
    cfg.exclude_keywords = spec.exclude;
    // `#jackets` 처럼 적었으면 **그 컬렉션만** 훑는다 — 209개를 다 보지 않아 훨씬 빠르다.
    if (spec.collections.length) cfg.collections = spec.collections;
    // 옵션 한 칸을 색/사이즈로 가른다 — 색은 상품 이름에 있으므로 **포함 키워드**로 넣어야 걸린다.
    const optionSpec = parseOptionSpec(args.size ?? "");
    if (optionSpec.color) {
      cfg.include_keywords = [...cfg.include_keywords, optionSpec.color];
      cfg.colors = [...cfg.colors, optionSpec.color];
    }
    if (optionSpec.size) cfg.buy.size_priority = [optionSpec.size, ...cfg.buy.size_priority];
    if (!args.dryRun) {
      const missing = missingProfileFields(cfg, cfg.buy.click_pay);
      if (missing.length) log.error(`배송 정보가 비어 있으면 담지 않습니다 — ${missing.join(", ")}`);
      const gaps = optionalGaps(cfg);
      if (gaps.length) log.warn(`이 칸들은 설정에 없어 창에서 직접 채워야 합니다: ${gaps.join(", ")}`);
    }
    sayStep(`키워드로 삽니다 — ${describeKeywords(spec)}${optionSpec.color || optionSpec.size ? ` · 옵션 ${describeOption(optionSpec)}` : ""}`);
    log.info(`훑을 컬렉션: ${cfg.collections.join(", ")}${spec.collections.length ? " (# 로 좁힘 — 빠릅니다)" : " (전체 — #카테고리 로 좁히면 훨씬 빠릅니다)"}`);
    // **--once 와 함께면 "지금" 이다.** 첫 확인을 조용히 넘기면(silent_first_scan) 이미 목록에 있는
    // 상품은 영영 안 잡힌다 — 지금 구매는 첫 바퀴부터 조건에 맞는 것을 담아야 한다 (2026-10-08).
    if (args.once || args.dryRun) {
      cfg.silent_first_scan = false;
      sayStep(args.dryRun ? "한 바퀴만 보고 담을 것만 알려 줍니다 (--dry-run)" : "지금 목록에서 조건에 맞는 것을 찾아 담습니다");
      await runOnce(cfg, state, args.dryRun || !cfg.buy.enabled);
      return;
    }
    UI.banner("SUPREME · 키워드 감시", [
      `포함 ${spec.include.join(", ") || "(없음)"} · 제외 ${spec.exclude.join(", ") || "(없음)"}`,
      `컬렉션 ${cfg.collections.join(", ")} · 확인 간격 ${cfg.check_interval_ms / 1000}초`,
      cfg.buy.click_pay ? "걸리면 담아서 결제 버튼까지 갑니다" : "걸리면 담고 결제 버튼 앞에서 멈춥니다",
      "캡차가 뜨면 캡차만 보이는 창을 띄웁니다",
    ]);
    await runWatch(cfg, state, { ...args, watch: true, buy: null, dryRun: args.dryRun || !cfg.buy.enabled });
    return;
  }

  // 드랍(큐 태우기) — 미끼를 담아 큐를 태우고, 드랍 시각에 바꿔 담고 결제한다.
  if (args.drop || (args.dropAt !== null && (args.preload !== null || cfg.drop.preload_url))) {
    return runPreloadDrop(cfg, state, args);
  }

  if (args.buy) {
    // 기다리지 않고 지금 (--buy). 수량은 --ea.
    const missing = missingProfileFields(cfg, cfg.buy.click_pay);
    if (missing.length) refuseToBuy(cfg, missing);
    const gaps = optionalGaps(cfg);
    if (gaps.length) log.warn(`이 칸들은 설정에 없어 창에서 직접 채워야 합니다: ${gaps.join(", ")}`);
    const browser = await openBrowser(cfg);
    try {
      const shop = await shopOf(browser, cfg);
      // 실행할 때마다 장바구니를 비운다 — 지난 판의 담긴 것이 함께 결제되지 않게.
      if (cfg.buy.clear_cart_first) {
        const before = await shop.cart();
        if (before.count > 0) {
          const cleared = await shop.clearCart();
          if (cleared.ok) log.info(`장바구니를 비웠습니다 (${before.count}개 → 0개)`);
          else log.warn(`장바구니를 못 비웠습니다: ${cleared.reason}`);
        }
      }
      const target = targetFor(cfg, args.buy, args.ea);
      const handle = parseHandle(args.buy);
      sayStep(`[${handle}] 지금 담습니다 (×${target.ea})`);
      const product = await shop.resolve(handle);
      if (!product) throw new Error(`상품을 해석하지 못했습니다: ${handle} — ${shop.lastResolveNote}`);
      const inStock = product.variants.filter((v) => v.available);
      if (!inStock.length) throw new Error(`[${handle}] 전 사이즈 품절입니다`);
      // 사이즈는 **별칭까지 맞춰** 고른다 (L = Large). 못 찾으면 다른 사이즈로 가지 않는다.
      // 옵션 칸은 "색 / 사이즈" 일 수 있다 — 사이즈만 견준다 (색은 상품 주소가 이미 정했다).
      const wantSize = parseOptionSpec(target.option).size;
      const wanted = wantSize
        ? inStock.find((v) => sizeEquals(v.size, wantSize) || sizeEquals(v.title, wantSize))
        : undefined;
      if (wantSize && !wanted && !cfg.buy.size_fallback) {
        throw new Error(
          `[${handle}] 원하는 사이즈(${wantSize})가 없습니다 — 재고: ${inStock.map((v) => v.size || v.title).join(", ")}\n` +
            "   엉뚱한 사이즈를 담지 않았습니다. 다른 사이즈도 괜찮으면 설정의 buy.size_fallback 을 true 로 두세요.",
        );
      }
      const variant = wanted ?? inStock[0]!;
      if (wantSize && !wanted) log.warn(`대체 허용(buy.size_fallback) — ${variant.size || variant.title} 로 담습니다`);
      await buyProduct(browser, shop, cfg, state, product, variant, target, target.ea);
      saveState(state);
    } finally {
      await browser.quit();
    }
    return;
  }

  bannerOf(cfg);

  // 살 모드인데 배송 정보가 비어 있으면 **미리 크게 알린다** — 감시는 하되 담지 않는다.
  if (!args.dryRun && cfg.buy.enabled) {
    const missing = missingProfileFields(cfg, cfg.buy.click_pay);
    if (missing.length) {
      log.error("배송 정보가 비어 있습니다 — 감시는 하되 담지는 않습니다.");
      log.error(`   채울 곳: ${CONFIG_PATH} (대시보드로 돌린다면 씨앗 설정 — 태스크는 띄울 때 베낍니다)`);
      for (const one of missing) log.error(`   · ${one}`);
    }
    const gaps = optionalGaps(cfg);
    if (gaps.length) log.warn(`이 칸들은 설정에 없어 창에서 직접 채워야 합니다: ${gaps.join(", ")}`);
  }

  if (args.once || (!args.watch && args.dryRun)) {
    await runOnce(cfg, state, args.dryRun || !cfg.buy.enabled);
    return;
  }

  // 감시 (--watch 가 없어도 기본이 감시다). dry-run 이면 사지 않는다.
  if (!cfg.buy.enabled && !args.dryRun) log.warn("설정의 buy.enabled 가 꺼져 있습니다 — 감시만 합니다 (담지 않습니다)");
  await runWatch(cfg, state, { ...args, dryRun: args.dryRun || !cfg.buy.enabled });
}

process.on("SIGINT", () => {
  log.info("종료합니다.");
  process.exit(0);
});

main()
  .then(() => {
    // 크롬은 남긴다(detach). 여기서 그냥 끝내면 크롬드라이버가 붙들고 있어 안 꺼진다.
    process.exit(process.exitCode ?? 0);
  })
  .catch((e: unknown) => {
    const message = e instanceof BrowserError ? `크롬을 띄우지 못했습니다: ${e.message}` : e instanceof Error ? e.message : String(e);
    log.error(message);
    process.exit(1);
  });
