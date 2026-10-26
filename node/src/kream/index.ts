/**
 * KREAM(kream.co.kr) **브랜드배송(공식 브랜드 샵)** 상품 감시 + 자동구매.
 *
 *   npm run kream                         감시하며 사기 (설정의 targets)
 *   npm run kream -- --once               한 바퀴만
 *   npm run kream -- --watch --dry-run    계속 감시하되 사지 않는다 (모니터가 쓰는 모드)
 *   npm run kream -- --buy <주소|번호>     지금 바로 사기
 *   npm run kream -- --status             한 번 조회하고 끝 (쿠키 없이)
 *   npm run kream -- --whoami             로그인이 살아 있나
 *   npm run kream -- --cookie             쿠키를 붙여넣어 저장 (표준입력)
 *   npm run kream -- --reset              산 기록 지우기
 *
 * 브랜드배송 상품은 정가에 재고를 파는 상품이다 (리셀 입찰이 아니다) — "일시 품절" 이 "구매하기" 로 바뀌는 순간을 본다.
 * 감시는 로그인된 크롬이 상품 페이지를 다시 읽어 한다. 그래서 재고가 보이면 같은 창에서 곧바로 구매하기를 누른다.
 * 대기열(wait.kream.co.kr)이 걸리면 줄을 서서 기다린다.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UI } from "../ui.js";
import { wait } from "../util.js";
import { KreamBrowser, BrowserError } from "./browser.js";
import { ensureLoggedIn, loginWithPassword, saveCookieBack } from "./auth.js";
import { buyFromProductPage, waitThroughQueue } from "./buy.js";
import {
  ACTIONS, BASE, CHROME_PROFILE, CONFIG_PATH, ORIGIN, clearPending, cookieOf, credentialsOf, ensureDirs, loadConfig, loadState, pinOf, readPending, run, saveConfig, saveState,
  type KreamConfig, type OrderAction, type State, type Target,
} from "./config.js";
import { LINES } from "./lines.js";
import { log, sayOk, sayStar, sayStep, useKreamLog } from "./log.js";
import { notifyFailed, notifyFound, notifyHuman, notifyPaid } from "./notify.js";
import { fetchProductHtml, parseProduct, productIdOf, productUrlOf, type ProductView } from "./site.js";

const HELP = `KREAM 브랜드배송 재고 감시 + 자동구매

  npm run kream [옵션]

  --watch              감시하며 삽니다 (기본)
  --once               한 바퀴만 확인하고 끝냅니다
  --dry-run            사지 않습니다 (--watch 와 같이 쓰면 계속 감시만 합니다)
  --buy <주소|번호>     기다리지 않고 지금 삽니다
  --ea <수량>           --buy 의 수량 (기본 1)
  --option <옵션>        --buy 에서 고를 옵션 (예: 270, ONE SIZE)
  --action <open|submit> 어디까지 — open 주문서까지 · submit 결제하기까지 (비밀번호가 있으면 자판까지) · 기본: 설정의 order_action
  --status             한 번 조회하고 끝냅니다 (쿠키 없이도 됩니다)
  --whoami             저장된 로그인이 살아 있나 봅니다
  --cookie [값]         로그인 쿠키를 저장합니다 (값을 안 주면 표준입력에서 읽습니다)
  --reset              산 기록을 지웁니다
  --pin <6자리|clear>   콘솔용 KREAM 간편결제 비밀번호를 설정 파일에 적거나 지웁니다
  --login              크롬 창을 띄워 사람이 로그인하면 쿠키를 KREAM_HOME/kream-cookie.txt 에 적습니다 (5분)`;

interface Args {
  watch: boolean;
  once: boolean;
  dryRun: boolean;
  buy: string | null;
  ea: number;
  option: string | null;
  action: OrderAction | null;
  status: boolean;
  whoami: boolean;
  reset: boolean;
  cookie: string | null;
  pin: string | null;
  login: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    watch: false, once: false, dryRun: false, buy: null, ea: 1, option: null, action: null,
    status: false, whoami: false, reset: false, cookie: null, pin: null, login: false, help: false,
  };
  const isFlag = (v: string | undefined) => v !== undefined && v.startsWith("--");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--watch": args.watch = true; break;
      case "--once": args.once = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--status": args.status = true; break;
      case "--whoami": args.whoami = true; break;
      case "--reset": args.reset = true; break;
      case "--login": args.login = true; break;
      case "-h": case "--help": args.help = true; break;
      case "--buy": args.buy = argv[++i] ?? null; break;
      case "--ea": args.ea = Math.max(1, Number(argv[++i] ?? 1) || 1); break;
      case "--option": case "--size": args.option = argv[++i] ?? null; break;
      case "--action": {
        const value = argv[++i] ?? "";
        if (!(ACTIONS as readonly string[]).includes(value)) throw new Error(`--action 은 ${ACTIONS.join(" · ")} 중 하나입니다 (받은 것: ${value})`);
        args.action = value as OrderAction;
        break;
      }
      case "--pin": args.pin = argv[++i] ?? ""; break;
      case "--cookie": args.cookie = isFlag(argv[i + 1]) || argv[i + 1] === undefined ? "" : argv[++i]!; break;
      default:
        throw new Error(`모르는 인자입니다: ${arg}\n\n${HELP}`);
    }
  }
  return args;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/** 지금 쓰는 크롬 — 멈출 때(Ctrl+C) 사람이 쓸 창이 아니면 닫는다. */
let current: KreamBrowser | null = null;

async function openBrowser(cfg: KreamConfig, needLogin: boolean): Promise<KreamBrowser> {
  const cookie = cookieOf(cfg);
  // 쿠키가 없어도 자동 로그인 정보가 있으면 띄운다 — 크롬에서 로그인한다 (ensureLoggedIn).
  if (needLogin && !cookie && !credentialsOf()) throw new Error(LINES.sessionDead("세션 쿠키가 없습니다 — 데스크톱 프로필에서 로그인하세요"));
  current = await KreamBrowser.launch({ profileDir: CHROME_PROFILE, offscreen: cfg.offscreen, cookie, origin: ORIGIN });
  return current;
}

function targetFor(cfg: KreamConfig, url: string, ea: number, option: string | null): Target {
  const known = cfg.targets.find((t) => productIdOf(t.url) === productIdOf(url));
  return {
    url,
    option: option ?? known?.option ?? "",
    ea: Math.max(1, ea || known?.ea || 1),
    max_price: known?.max_price ?? 0,
    label: known?.label ?? "",
  };
}

const priceText = (n: number): string => (n ? `${n.toLocaleString("en-US")}원` : "가격 미표기");

/** 크롬에 띄운 상품 페이지를 읽는다. 대기열이면 줄을 선 뒤에 읽는다. → 못 읽으면 null */
async function readInBrowser(browser: KreamBrowser, id: string, reload: boolean): Promise<ProductView | null> {
  const url = productUrlOf(id);
  if (reload && (await browser.url()).startsWith(url)) await browser.reload();
  else await browser.goto(url);
  await waitThroughQueue(browser);
  return parseProduct(id, await browser.html());
}

/** 산 결과를 상태·알림에 남긴다. → 이번 판을 끝낼지 */
async function settle(
  cfg: KreamConfig, state: State, id: string, name: string, url: string,
  result: Awaited<ReturnType<typeof buyFromProductPage>>,
): Promise<"paid" | "stop" | "dead" | "continue"> {
  if (result.kind === "retry") return "continue";
  if (result.kind === "paid") {
    state._buy[id] = { at: new Date().toISOString(), order_no: result.orderNo, what: name };
    saveState(state);
    await notifyPaid(cfg, name, url, result.orderNo, result.total);
    return "paid";
  }
  if (result.kind === "stopped") {
    await notifyHuman(cfg, name, url, "주문서까지 왔습니다 — 창에서 확인하고 결제해 주세요");
    return "stop";
  }
  await notifyFailed(cfg, name, url, result.reason);
  if (result.sessionDead) {
    log.error(LINES.sessionDead(result.reason));
    return "dead";
  }
  return "stop";
}

async function runWatch(cfg: KreamConfig, state: State, args: Args): Promise<void> {
  const dryRun = args.dryRun || !cfg.buy.enabled;
  const targets = cfg.targets.filter((t) => productIdOf(t.url));
  if (!targets.length) throw new Error(`살 상품이 없습니다 — ${CONFIG_PATH} 의 targets 에 상품 주소를 적어 주세요`);
  for (const t of cfg.targets) if (!productIdOf(t.url)) log.warn(`KREAM 상품 주소가 아니라 건너뜁니다: ${t.url}`);

  const action = args.action ?? cfg.order_action;
  const intervalMs = Math.max(cfg.check_interval_ms, cfg.min_interval_ms);
  const pin = pinOf(cfg);
  UI.banner("KREAM · 브랜드배송", [
    `상품 ${targets.length}개 · 확인 간격 ${intervalMs / 1000}초`,
    dryRun ? "사지 않습니다 (감시만)"
      : action === "open" ? "주문서까지 갑니다 (결제는 사람이)"
      : pin ? `결제하기 → 구매조건 동의 → 결제 비밀번호(${pin.length}자리)까지 눌러 결제합니다`
      : "결제하기까지 누릅니다 — 비밀번호는 창에서 사람이 넣습니다",
    cfg.buy_on_restock_only ? "품절 → 판매로 바뀌는 순간에만 삽니다" : "판매 중이면 바로 삽니다",
  ]);

  const browser = await openBrowser(cfg, !dryRun);
  const names = new Map<string, string>();
  /** 드라이런에서 이미 알린 상품 — 다시 품절이 되면 지운다 (판매가 이어지는 동안 같은 발견을 되풀이하지 않게) */
  const announced = new Set<string>();
  let buys = 0;
  let round = 0;
  /** 마지막으로 로그인을 확인한 때 — 사지 않는 모드는 묻지 않는다. 사는 모드는 처음과 그 뒤 LOGIN_RECHECK_MS 마다. */
  let loginCheckedAt = dryRun ? Infinity : 0;
  try {
    for (;;) {
      round++;
      const started = Date.now();
      for (const target of targets) {
        const id = productIdOf(target.url)!;
        const url = productUrlOf(id);
        let view: ProductView | null = null;
        for (let attempt = 0; attempt <= cfg.max_retries && !view; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, cfg.retry_delay_ms));
          try {
            view = await readInBrowser(browser, id, round > 1 || attempt > 0);
          } catch (e) {
            log.debug(`상품 페이지를 못 읽었습니다: ${String((e as Error).message || e)}`);
          }
        }
        if (!view) {
          log.warn(LINES.failed("확인", `상품 페이지를 못 읽었습니다 — ${url}`));
          continue;
        }
        // 재고가 풀린 순간에 로그인부터 하느라 늦지 않게, 감시하는 동안 미리 살려 둔다.
        if (Date.now() - loginCheckedAt > LOGIN_RECHECK_MS) {
          if (!(await ensureLoggedIn(browser))) {
            process.exitCode = 1;
            return;
          }
          // 살아 있는 쿠키를 프로필에 다시 적는다 — 이 크롬이 토큰을 갱신했으면(접근 토큰은 2시간) 프로필도 새 것을 갖게.
          await saveCookieBack(browser);
          loginCheckedAt = Date.now();
        }
        if (!names.has(id)) {
          names.set(id, view.name);
          log.info(LINES.product(view.name, priceText(view.price)));
          if (!view.brand) log.warn("브랜드배송 상품이 아닌 것 같습니다 — 리셀(입찰) 상품은 옵션·주문서가 달라 못 살 수 있습니다");
        }
        const name = target.label || view.name;
        const prev = state.last[id]?.in_stock;
        state.last[id] = { in_stock: view.inStock, price: view.price, at: new Date().toISOString() };
        if (!view.inStock) {
          announced.delete(id);
          log.info(LINES.stockOut(`${name} (${view.button || "구매 불가"})`));
          continue;
        }
        log.info(LINES.stockIn(`${name} · ${priceText(view.price)}`));
        if (prev === false) sayOk(LINES.restock(name));
        if (cfg.buy_on_restock_only && prev !== false) {
          if (round === 1) log.info("켰을 때 이미 판매 중입니다 — 재입고 순간에만 사도록 되어 있어 기다립니다 (buy_on_restock_only)");
          continue;
        }
        if (target.max_price > 0 && view.price > target.max_price) {
          log.warn(`가격 ${priceText(view.price)}이 상한가 ${priceText(target.max_price)}보다 커서 사지 않습니다`);
          continue;
        }
        if (dryRun) {
          if (!announced.has(id)) {
            announced.add(id);
            log.info(LINES.foundDry(url));
          }
          continue;
        }
        const bought = state._buy[id];
        if (bought && cfg.buy.stop_after_success) {
          log.info(LINES.paidState(bought.order_no, bought.what));
          continue;
        }
        await notifyFound(cfg, name, url, view.price);
        const result = await buyFromProductPage(browser, cfg, { ...target, url }, url, action);
        const next = await settle(cfg, state, id, name, url, result);
        if (next === "continue") continue;
        if (next === "dead") {
          // 사는 도중에 로그인이 풀렸다 — 다시 로그인되면 다음 바퀴에 또 본다.
          if (await ensureLoggedIn(browser)) {
            loginCheckedAt = Date.now();
            continue;
          }
          process.exitCode = 1;
          return;
        }
        if (next === "stop") return; // 창을 사람에게 넘겼다 — 다시 읽으면 사람이 하던 화면이 날아간다
        buys++;
        if (cfg.buy.stop_after_success || buys >= cfg.buy.max_buys_per_run) {
          sayOk(`${buys}번 샀습니다 — 끝냅니다`);
          return;
        }
      }
      saveState(state);
      log.info(LINES.round(round, targets.length, Math.round((Date.now() - started) / 1000)));
      if (args.once) return;
      const jitter = intervalMs * (0.9 + Math.random() * 0.2);
      await wait(jitter / 1000, "감시 중");
    }
  } finally {
    saveState(state);
    await browser.quit();
    current = null;
  }
}

async function cmdBuy(cfg: KreamConfig, state: State, args: Args): Promise<void> {
  const id = productIdOf(args.buy ?? "");
  if (!id) throw new Error(`KREAM 상품 주소나 상품번호가 아닙니다: ${args.buy}`);
  const url = productUrlOf(id);
  const target = targetFor(cfg, url, args.ea, args.option);
  const action = args.action ?? cfg.order_action;
  const browser = await openBrowser(cfg, !args.dryRun);
  try {
    const view = await readInBrowser(browser, id, false);
    if (!view) throw new Error(LINES.failed("확인", `상품 페이지를 못 읽었습니다 — ${url}`));
    log.info(LINES.product(view.name, priceText(view.price)));
    if (!args.dryRun && !(await ensureLoggedIn(browser))) {
      process.exitCode = 1;
      return;
    }
    if (!view.inStock) {
      log.error(LINES.stockOut(`${view.name} (${view.button || "구매 불가"})`));
      process.exitCode = 1;
      return;
    }
    log.info(LINES.stockIn(`${view.name} · ${priceText(view.price)}`));
    if (args.dryRun) {
      log.info(LINES.foundDry(url));
      return;
    }
    const name = target.label || view.name;
    const result = await buyFromProductPage(browser, cfg, target, url, action);
    const next = await settle(cfg, state, id, name, url, result);
    if (result.kind === "failed" || result.kind === "retry") process.exitCode = 1;
  } finally {
    await browser.quit();
    current = null;
  }
}

/**
 * 재고만 — 먼저 크롬 없이 바로 받아 본다 (1~2초). KREAM 은 브라우저가 아닌 요청에 가끔 내용 없는 500 을 주거나 10초 붙든다
 * (2026-10-26 23:41 "상품 페이지 HTTP 500") — 그러면 화면 밖 크롬으로 한 번 더 읽는다. 크롬은 처음 필요할 때 한 번만 띄운다.
 */
async function cmdStatus(cfg: KreamConfig, args: Args): Promise<void> {
  const urls = args.buy ? [args.buy] : cfg.targets.map((t) => t.url);
  if (!urls.length) throw new Error(`볼 상품이 없습니다 — ${CONFIG_PATH} 의 targets 에 상품 주소를 적어 주세요`);
  let browser: KreamBrowser | null = null;
  /** 바로 받기가 한 번 막히면 이번 판의 나머지는 처음부터 크롬으로 — 지금 KREAM 이 이 요청을 붙들고 있다는 뜻이다. */
  let direct = true;
  try {
    for (const raw of urls) {
      const id = productIdOf(raw);
      if (!id) {
        log.warn(`KREAM 상품 주소가 아닙니다: ${raw}`);
        continue;
      }
      let view: ProductView | null = null;
      if (direct) {
        try {
          view = parseProduct(id, await fetchProductHtml(id));
          if (!view) log.info(`바로 받은 것이 상품 페이지가 아닙니다 — 크롬으로 다시 읽습니다 (${productUrlOf(id)})`);
        } catch (e) {
          log.info(`바로 받지 못했습니다 (${(e as Error).message}) — 크롬으로 다시 읽습니다`);
          direct = false;
        }
      }
      if (!view) {
        try {
          // 재고는 로그인 없이 보인다 — 쿠키는 심지 않는다.
          browser ??= current = await KreamBrowser.launch({ profileDir: CHROME_PROFILE, offscreen: true, cookie: "", origin: ORIGIN });
          view = await readInBrowser(browser, id, false);
        } catch (e) {
          log.warn(LINES.failed("확인", `크롬으로도 못 읽었습니다 (${String((e as Error).message || e).split("\n")[0]}) — ${productUrlOf(id)}`));
          continue;
        }
      }
      if (!view) {
        log.warn(LINES.failed("확인", `상품 페이지가 아닙니다 — ${productUrlOf(id)}`));
        continue;
      }
      log.info(LINES.product(view.name, priceText(view.price)));
      log.info(view.inStock ? LINES.stockIn(`${view.name} · ${priceText(view.price)}`) : LINES.stockOut(`${view.name} (${view.button || "구매 불가"})`));
    }
  } finally {
    if (browser) {
      await browser.quit();
      current = null;
    }
  }
}

async function cmdWhoami(cfg: KreamConfig): Promise<void> {
  const cookie = cookieOf(cfg);
  if (!cookie) {
    log.error("세션 쿠키가 없습니다 — 데스크톱 프로필에서 로그인하세요");
    process.exitCode = 1;
    return;
  }
  // 크롬으로 묻는다 — Node 에서 /my 를 직접 부르면 KREAM 이 10초 붙들다 끊는다 (2026-10-25: 멀쩡한 쿠키로도 시간 초과).
  // 태스크와 같은 방식(쿠키를 심은 화면 밖 크롬)이라, 태스크에서 이 쿠키가 먹는지까지 같이 확인된다.
  const browser = await KreamBrowser.launch({ profileDir: CHROME_PROFILE, offscreen: true, cookie, origin: ORIGIN });
  current = browser;
  let alive: boolean | null;
  try {
    await browser.goto(`${ORIGIN}/my`);
    // 로그인하지 않았으면 서버가 /login 으로 보낸다. 마이페이지에 머물면 살아 있다.
    alive = /kream\.co\.kr\/login/.test(await browser.url()) ? false : /kream\.co\.kr\/my/.test(await browser.url()) ? true : await browser.loggedIn();
    // 살아 있으면 지금 쿠키를 프로필에 다시 적는다 (KREAM_COOKIE_FILE 이 있을 때 — 데스크톱의 확인이 넘겨 준다).
    if (alive === true) await saveCookieBack(browser);
  } finally {
    await browser.quit();
    current = null;
  }
  if (alive === true) sayOk("로그인됨 — 마이페이지가 열립니다");
  else if (alive === false) {
    log.error("로그인되어 있지 않습니다 — 쿠키는 있지만 마이페이지가 로그인 화면으로 보냅니다");
    process.exitCode = 1;
  } else {
    log.error("로그인을 판정하지 못했습니다 — KREAM 이 예상 밖의 응답을 했습니다");
    process.exitCode = 2;
  }
}

/** 로그인 창이 기다리는 시간 (데스크톱 로그인 창·네이버 --login 과 같다). */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** 감시하는 동안 로그인을 다시 확인하는 간격. */
const LOGIN_RECHECK_MS = 10 * 60_000;

/**
 * 로그인하고 쿠키를 KREAM_HOME/kream-cookie.txt 에 적는다. 순서:
 *   1. 크롬 프로필(KREAM_HOME 안에 남는다)이 아직 로그인돼 있으면 쿠키만 새로 받는다 — 사람 손이 필요 없다
 *   2. 자동 로그인 정보(KREAM_LOGIN_EMAIL · KREAM_LOGIN_PASSWORD)가 있으면 화면 밖 크롬에서 넣고 로그인한다
 *   3. 그래도 안 되면(캡차·인증·틀린 비밀번호) 창을 화면에 띄워 사람이 마저 한다 (5분)
 *
 * 데스크톱의 로그인 창(Electron)으로는 KREAM 이 페이지의 스크립트·스타일(/_nuxt/…)을 내주지 않는다 — 파일마다 10초를
 * 붙들다 500 을 준다 (2026-10-25: 앱 창에서는 로그인 버튼이 아예 안 눌렸고, 같은 PC 의 크롬은 105개를 다 받았다).
 * 그래서 로그인도 태스크와 같은 진짜 크롬으로 한다.
 */
async function cmdLogin(): Promise<void> {
  mkdirSync(BASE, { recursive: true });
  const out = join(BASE, "kream-cookie.txt");
  const creds = credentialsOf();
  const browser = await KreamBrowser.launch({ profileDir: CHROME_PROFILE, offscreen: !!creds, cookie: "", origin: ORIGIN });
  current = browser;
  const save = async (how: string): Promise<boolean> => {
    const line = await browser.cookieLine();
    if (!line) return false;
    writeFileSync(out, `${line}\n`, "utf-8");
    sayOk(`로그인됨 — ${how} · 쿠키 ${line.split(";").length}개를 적었습니다 (${out})`);
    return true;
  };
  try {
    await browser.goto(`${ORIGIN}/login`);
    if ((await browser.loggedIn()) === true && (await save("크롬 프로필이 아직 로그인돼 있습니다"))) return;
    if (creds) {
      const outcome = await loginWithPassword(browser, creds.email, creds.password);
      if (outcome.kind === "ok" && (await save("저장된 이메일로 자동 로그인했습니다"))) return;
      if (outcome.kind === "wrong") log.error(`자동 로그인이 거절됐습니다 (${outcome.message}) — 창에서 직접 로그인하세요`);
      if (outcome.kind === "human") sayStar(`로그인 — 창에서 마저 해 주세요 (${outcome.why})`);
      await browser.showToHuman("로그인을 마저 해 주세요");
    }
    sayStep("크롬 창에서 직접 로그인하세요 — 로그인되면 저절로 닫힙니다");
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const url = await browser.url();
      if (!url) throw new Error("로그인 창이 닫혔습니다");
      // 로그인 페이지에 있는 동안은 묻지 않는다 (아직 로그인 전이다). 다른 사이트(본인 인증 따위)에 있을 때도.
      if (!/^https:\/\/(www\.)?kream\.co\.kr\//.test(url) || /\/login/.test(url)) continue;
      if ((await browser.loggedIn()) !== true) continue;
      if (await save("창에서 로그인했습니다")) return;
    }
    log.error(`${LOGIN_TIMEOUT_MS / 60_000}분 안에 로그인하지 않아 창을 닫습니다`);
    process.exitCode = 1;
  } finally {
    // 로그인 창은 남기지 않는다 (사람이 볼 차례였어도 끝났다).
    browser.keepAlive = false;
    await browser.quit();
    current = null;
  }
}

async function main(): Promise<void> {
  useKreamLog();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  // 로그인은 프로필 폴더를 집으로 받는다 — 설정·상태 파일을 만들지 않는다.
  if (args.login) return cmdLogin();
  ensureDirs();
  run.dryRun = args.dryRun;
  const cfg = loadConfig();
  if (!existsSync(CONFIG_PATH)) {
    saveConfig(cfg);
    log.info(`설정 파일을 만들었습니다: ${CONFIG_PATH}`);
  }
  const state = loadState();

  if (args.reset) {
    state._buy = {};
    saveState(state);
    clearPending();
    sayOk("산 기록과 겹쳐 사기 표시를 지웠습니다");
    return;
  }
  if (args.cookie !== null) {
    const value = (args.cookie || (await readStdin())).trim();
    if (!value) throw new Error("쿠키가 비어 있습니다");
    cfg.cookie = value;
    saveConfig(cfg);
    sayOk(`쿠키를 저장했습니다 (${value.split(";").length}개)`);
    return;
  }
  if (args.pin !== null) {
    // 설정 파일에 적고 끝나는 명령이다 (실행 옵션이 아니다) — 태스크는 KREAM_PG_PASSWORD 로 받는다.
    if (args.pin === "clear") {
      cfg.pg_password = "";
      saveConfig(cfg);
      sayOk("결제 비밀번호를 지웠습니다");
      return;
    }
    const digits = args.pin.replace(/\D/g, "");
    if (digits.length !== 6) throw new Error("결제 비밀번호는 숫자 6자리입니다");
    cfg.pg_password = digits;
    saveConfig(cfg);
    sayOk("결제 비밀번호를 적었습니다 (6자리)");
    return;
  }
  if (args.whoami) return cmdWhoami(cfg);
  if (args.status) return cmdStatus(cfg, args);
  // 사는 실행이면, 지난번에 결제 비밀번호까지 넣고 완료를 못 본 시도가 있는지 먼저 본다 — 겹쳐 사지 않게.
  if (!args.dryRun) {
    const pending = readPending();
    if (pending) {
      const age = Date.now() - Date.parse(pending.at);
      if (Number.isFinite(age) && age < 30 * 60_000) {
        log.error(`이전 실행에서 결제 비밀번호까지 넣었지만 완료를 확인하지 못했습니다 (${pending.at} · ${pending.what}).`);
        log.error("중복 구매를 막기 위해 멈춥니다 — KREAM 주문내역을 확인하고, 결제가 안 됐으면 --reset 으로 지운 뒤 다시 실행하세요.");
        process.exitCode = 1;
        return;
      }
      clearPending();
      log.warn("겹쳐 사기 표시가 30분을 넘겨 지웠습니다 — 지난 결제는 주문내역에서 확인하세요.");
    }
  }
  if (args.buy) {
    sayStep(`지금 삽니다 — ${args.buy}`);
    return cmdBuy(cfg, state, args);
  }
  // 감시 (--watch 가 없어도 기본이 감시다). --dry-run 만 주면 한 바퀴만 본다 (집의 다른 원본과 같다).
  return runWatch(cfg, state, { ...args, once: args.once || (args.dryRun && !args.watch) });
}

/** 끝내라는 신호 — 사람이 쓸 창이 아니면 크롬을 닫고 끝낸다 (안 닫으면 화면 밖 크롬이 쌓인다). */
function onStop(): void {
  log.info("종료합니다.");
  const b = current;
  if (b && !b.keepAlive) void b.quit().finally(() => process.exit(0));
  else process.exit(0);
}
// Ctrl+C 말고도 — 작업 관리자·kill 의 SIGTERM, 윈도 콘솔의 Ctrl+Break(SIGBREAK).
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(sig, onStop);

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(async (e: unknown) => {
    const message = e instanceof BrowserError ? `크롬을 띄우지 못했습니다: ${e.message}` : e instanceof Error ? e.message : String(e);
    log.error(message);
    if (current && !current.keepAlive) await current.quit();
    process.exit(1);
  });
