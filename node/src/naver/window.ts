/**
 * 크롬 창 하나를 띄워 두고 그 안에서 지켜보다, 열리면 그 자리에서 산다.
 *
 * 캡차 벽이 있는 스마트스토어 상품을 위해 만든 길이다. HTTP 로는 상품 페이지를 받을 수
 * 없으니, 사람이 캡차를 푼 **그 창**을 그대로 쓴다. 새 창을 띄우면 방금 푼 것을 처음부터
 * 다시 풀어야 한다.
 *
 * 한 번에 한 상품만 본다. 창마다 상품 하나이고, 여러 창을 동시에 돌리면 어느 창에서
 * 캡차가 떴는지 사람이 알기 어렵다.
 */
import { log, sayOk, sayStar, sayStep, tick } from "../log.js";
import { UI } from "../ui.js";
import { nowStamp, sleep, wait } from "../util.js";
import {
  cookieOf, entryOf, IN_STOCK, reloadConfig, run, saveState, SOLDOUT, STATUS_LABEL,
  type Config, type State, type TargetEntry,
} from "./config.js";
import {
  CAPTCHA_SAID as HTTP_CAPTCHA_SAID, hasLoginCookie, loginAlive, newSession, PUSHED_BACK,
  sayPushedHowto,
  SiteError, type Session,
} from "./http.js";
import { notifyBlocked, notifyCaptcha, notifyOpened, notifySession } from "./notify.js";
import { arrivalLine, OPEN_BROWSERS, sayArrived, watchUntilPaid } from "./order.js";
import { fetchStock, findProduct, pageState, readStock, type StockInfo } from "./product.js";
import { blockingReason, sayNowHint, SessionDead, stockText } from "./watch.js";
import { targetsOf, type Target } from "./targets.js";
import {
  atCaptcha, BrowserError, buyHere, CAPTCHA_SAID, Chrome, domStatus, landed, openPage, reopen,
  screenNote, SESSION_DEAD, stateOf, waitProduct, windowGone,
} from "./browser.js";

/** 사람이 크롬 창을 닫았다. 더 볼 창이 없으니 여기서 끝이다. */
export class WindowClosed extends Error {
  constructor() {
    super("크롬 창이 닫혔습니다. 감시를 멈춥니다.");
  }
}

// 사람에게 캡차를 다시 알리는 간격. 매 바퀴 알리면 디스코드가 도배된다.
const CAPTCHA_REMIND_SECONDS = 600;
// 벽 앞에서 이만큼 기다렸으면 페이지를 다시 받아 본다. 벽은 저절로 걷히기도 한다 —
// 같은 상품이 몇 분 사이에 캡차였다가 그냥 열리는 것을 봤다. 사람이 푸는 것만 기다리면
// 걷힌 뒤에도 계속 서 있게 된다. 대신 짧게 잡지 않는다. 사람이 문제를 푸는 중에 다시
// 받으면 그 답이 날아간다.
const WALL_RETRY_SECONDS = 180;
// 창을 통째로 다시 받는 감시라 한 바퀴가 무겁다. HTTP 쪽(15초)보다 성기게 돈다.
// **HTTP 가 되는 동안에는 이 값을 쓰지 않는다** — 그때는 창을 세워 두고 HTTP 로 본다.
const BROWSER_INTERVAL = 30;
const BROWSER_FLOOR = 10;
// 세워 둔 페이지를 다시 받는 주기. 조회는 HTTP 가 하므로 이건 "창을 싱싱하게 두는" 값이다.
// 낡은 페이지에서 구매하기를 누르면 사이트가 다시 받으라고 할 수 있어서 둔다.
const PARK_REFRESH_SECONDS = 300;

/**
 * 떠 있는 창에서 재고를 읽는다. → [재고, 어디서 읽었는지]
 *
 * 세 가지를 차례로 해본다. 앞의 것이 더 많이 알려 주고, 뒤의 것이 더 잘 버틴다.
 *
 *   1. window.__PRELOADED_STATE__      수량·가격·이름까지 안다
 *   2. 페이지 안의 상태 JSON           같은 값을 HTML 에서 긁는다 (1이 비어 있을 때)
 *   3. 화면의 구매 버튼                 있다/없다만 안다. 이름도 수량도 모른다
 *
 * 3까지 내려오면 재고 수량을 -1 로 둔다. `ea`·`max_price` 로 막는 판단은 값을 모르면
 * 할 수 없는데, **모르는 것을 0으로 적으면 "재고 부족" 이라고 잘못 막는다.**
 */
export async function stockInWindow(
  box: Chrome, target: Target,
): Promise<[StockInfo, string]> {
  await waitProduct(box);
  const state = await stateOf(box);
  if (state) {
    try {
      return [readStock(findProduct(state, target.key), target.option), "window.__PRELOADED_STATE__"];
    } catch (e) {
      if (!(e instanceof SiteError)) throw e;
      log.debug(`창의 상태 JSON 에서 상품을 못 찾았습니다: ${e.message}`);
    }
  }

  try {
    const [, fromHtml] = pageState(await box.driver.getPageSource());
    return [readStock(findProduct(fromHtml, target.key), target.option), "페이지 안의 상태 JSON"];
  } catch (e) {
    // getPageSource 를 가져오는 것 자체가 터지는 경우도 삼킨다.
    log.debug(`페이지에서 상태 JSON 을 못 읽었습니다: ${(e as Error).message}`);
  }

  const status = await domStatus(box);
  if (status) {
    return [
      { stock: -1, status, name: "", price: 0, raw_status: "", option: null },
      "화면(구매 버튼)",
    ];
  }

  // 무엇이 떠 있었는지 같이 적는다. 이 한 줄이 없으면 캡차인지, 막는 화면인지,
  // 페이지가 바뀐 것인지 알 길이 없다.
  throw new SiteError("재고를 읽지 못했습니다 — 상태 JSON 도 구매 버튼도 못 찾았습니다 " +
    `(${await screenNote(box)})`);
}

/**
 * 캡차 앞에 섰다. 사람이 풀거나, 벽이 걷힐 때까지 기다린다.
 *
 * **대신 풀지 않는다.** 캡차는 사람이 있는지 묻는 것이다. 다만 사람만 기다리지도 않는다 —
 * 이 벽은 상시가 아니라 간헐적이라, 3분마다 페이지를 다시 받아 본다. 사람이 풀면 3초
 * 안에 알아채고 이어간다.
 */
export async function waitForHuman(
  cfg: Config, box: Chrome, target: Target, timeout = 20,
): Promise<void> {
  let toldAt: number | null = null;
  let triedAt = Date.now();

  for (;;) {
    if (await windowGone(box)) throw new WindowClosed();
    if (!(await atCaptcha(box))) {
      sayOk("캡차가 풀렸습니다 — 감시를 이어갑니다");
      return;
    }

    const now = Date.now();
    if (toldAt === null || now - toldAt >= CAPTCHA_REMIND_SECONDS * 1000) {
      log.warn("네이버가 캡차를 세웠습니다 — 크롬 창에서 풀어 주세요 (대신 풀지 않습니다)");
      log.info(`   화면: ${await screenNote(box)}`);
      log.info(`   그냥 두셔도 됩니다 — ${Math.floor(WALL_RETRY_SECONDS / 60)}분마다 다시 받아 봅니다. ` +
        "이 벽은 걷혔다 섰다 합니다.");
      if (await notifyCaptcha(cfg, target)) sayStar("디스코드로 알렸습니다");
      toldAt = now;
    }

    if (now - triedAt >= WALL_RETRY_SECONDS * 1000) {
      triedAt = now;
      sayStep("벽이 그대로입니다 — 페이지를 다시 받아 봅니다");
      await reopen(box, target.url, timeout);
      continue;
    }

    tick("캡차를 기다리는 중 — 사람이 풀어도 되고, 그냥 두셔도 됩니다");
    await sleep(3000);
  }
}

/**
 * 읽은 재고를 보고 판단해, 열려 있으면 그 창에서 산다. → 샀으면 true
 *
 * 판단하는 자리는 handleTarget 과 같다(품절 → 구매가능 으로 바뀔 때만, 상한가, 수량).
 * 누르는 자리만 새 창이 아니라 **떠 있는 창**이다.
 */
export async function buyFromWindow(
  cfg: Config, entry: TargetEntry, box: Chrome, target: Target, info: StockInfo, where: string,
): Promise<boolean> {
  const key = target.key;
  if (entry.done) {
    // 이미 산 것이다. handleTarget 과 같은 자리에서 같은 이유로 멈춘다 —
    // 기록을 지우려면 --reset 이다.
    tick(`${target.label || entry.name || key} — 이미 샀습니다 (지우려면 --reset)`);
    return false;
  }

  const name = target.label || info.name || key;
  entry.name = name;
  entry.stock = info.stock;

  const was = entry.status;
  entry.status = info.status;

  if (info.status === SOLDOUT) {
    if (was === IN_STOCK) log.info(`[${key}] ${name} — 품절로 바뀌었습니다`);
    else tick(`${name} — 품절 (${where})`);
    return false;
  }

  if (cfg.buy_on_restock_only && was !== SOLDOUT) {
    if (was === undefined) {
      log.info(`[${key}] ${name} — 이미 판매 중입니다. 품절됐다가 다시 열릴 때 삽니다`);
    } else {
      tick(`${name} — 계속 판매 중 (기다립니다)`);
    }
    sayNowHint(target);
    return false;
  }

  sayOk(`[${key}] ${name} — 재고 ${stockText(info)}, 구매하기를 누릅니다 (×${target.ea})`);
  entry.last_try_at = nowStamp();

  const reason = blockingReason(cfg, target, info);
  if (reason) {
    log.warn(`[${key}] 사지 않습니다 — ${reason}`);
    entry.blocked = reason;
    await notifyBlocked(cfg, target, reason);
    return false;
  }
  delete entry.blocked;

  if (run.dryRun) {
    sayStep(`[dry-run] 여기서 구매하기를 눌렀을 것입니다 — ${target.url}`);
    return true;
  }

  const [ok, why] = await buyHere(box, {
    option: target.option, ea: target.ea, timeout: cfg.browser_timeout_seconds ?? 20,
  });
  entry.opened = ok;
  if (!ok) {
    entry.blocked = why ?? undefined;
    if (why === SESSION_DEAD) {
      await notifySession(cfg);
      throw new SessionDead();
    }
    log.warn(`[${key}] 주문서를 못 열었습니다 — ${why}`);
    await notifyBlocked(cfg, target, `주문서를 못 열었습니다 — ${why}`);
    return false;
  }

  const stage = await sayArrived(cfg, box);
  entry.opened_at = nowStamp();
  entry.stage = stage;
  entry.done = !!cfg.stop_after_success;
  if (await notifyOpened(cfg, target, info, stage)) sayStar("디스코드로 알렸습니다 — 결제해 주세요");
  if (stage === "submitted") await watchUntilPaid(cfg, box, target, name);
  return true;
}

export interface Reading {
  info: StockInfo;
  /** 어디서 읽었나. 창에서 읽었으면 다음 바퀴에 페이지를 다시 받아야 한다. */
  where: string;
}

export interface FastRead {
  reading: Reading | null;
  /** HTTP 는 여기서 끝이다. 다음 바퀴부터 묻지도 말라는 뜻. */
  httpDead: boolean;
}

/**
 * 재고를 **싼 것부터** 본다. HTTP 한 번이 0.13초이고 창을 다시 받는 것은 1초가 넘는다.
 *
 * HTTP 가 막히는 길은 둘이고, 둘 다 창에서 읽는 쪽으로 물러선다(그때는 이미 창이 그
 * 페이지에 서 있다).
 *
 *   캡차 벽    상품마다 다르고 걷혔다 섰다 한다 → 다음 바퀴에 HTTP 를 다시 해본다
 *   429(지문)  이 판(Node)에서는 영영 안 열린다 → **HTTP 를 아예 접는다**
 *
 * 뒤엣것을 접지 않으면 매 바퀴 backoff(3+8+20초)를 꼬박 치르고서야 창을 본다. 재고가
 * 열리는 순간이 하필 그 31초 안에 들어가면 그 판은 끝이다.
 */
export async function readStockFast(
  s: Session | null, box: Chrome, target: Target,
): Promise<FastRead> {
  let httpDead = false;

  if (s !== null) {
    try {
      return { reading: { info: await fetchStock(s, target), where: "HTTP" }, httpDead };
    } catch (e) {
      if (!(e instanceof SiteError)) throw e;
      if (e.message === PUSHED_BACK) {
        log.warn(`[${target.key}] ${e.message} — 이제부터 창에서만 읽습니다`);
        sayPushedHowto();
        httpDead = true;
      } else if (e.message === HTTP_CAPTCHA_SAID) {
        log.debug("HTTP 가 캡차에 막혔습니다 — 창에서 읽습니다.");
      } else {
        log.error(`[${target.key}] ${e.message}`);
        return { reading: null, httpDead };
      }
    }
  }

  try {
    const [info, where] = await stockInWindow(box, target);
    return { reading: { info, where }, httpDead };
  } catch (e) {
    if (!(e instanceof SiteError)) throw e;
    log.error(`[${target.key}] ${e.message}`);
    return { reading: null, httpDead };
  }
}

/**
 * 로그인이 살아 있는지 묻는다. 끊겼으면 디스코드로 알리고 SessionDead 로 멈춘다.
 *
 * 못 물어본 것(그물이 끊겼거나 모르는 답)과 로그아웃된 것은 다르다. 못 물어봤으면
 * 한 줄 적고 감시를 이어 간다 — 그걸로 하루 감시를 접으면 그게 더 큰 손해다.
 */
async function checkLogin(cfg: Config, who: Session, first = false): Promise<void> {
  let alive: boolean;
  try {
    alive = await loginAlive(who);
  } catch (e) {
    if (!(e instanceof SiteError)) throw e;
    log.warn(`로그인 확인 실패 (계속 진행): ${e.message}`);
    return;
  }
  if (alive) {
    log.debug("로그인 확인 — 살아 있습니다.");
    return;
  }
  if (first) {
    throw new Error("빌려온 세션이 이미 끊겼습니다. 브라우저에서 다시 복사해 --cookie 로 넣어주세요.");
  }
  await notifySession(cfg);
  throw new SessionDead();
}

/**
 * 설정의 targets 에서 창이 따라갈 상품. → 없으면(비었거나 못 읽으면) null
 *
 * 창 하나는 한 상품만 본다. 여럿이 적혀 있으면 첫 번째를 보고 그렇다고 말한다.
 */
function nextTarget(cfg: Config, now: Target): Target | null {
  let all: Target[];
  try {
    all = targetsOf(cfg);
  } catch (e) {
    log.warn(`   targets 를 읽지 못했습니다 — 보던 상품을 계속 봅니다 (${(e as Error).message.split("\n")[0]})`);
    return null;
  }
  if (!all.length) {
    log.warn(`   targets 가 비었습니다 — 보던 상품 [${now.key}] 을 계속 봅니다`);
    return null;
  }
  if (all.length > 1) log.info(`   창에서는 한 상품만 봅니다 — 첫 번째 [${all[0]!.key}] 를 봅니다`);
  return all[0]!;
}

/** 캡차 벽 앞에서 사람을 기다렸다가, 상품 페이지를 다시 세운다. → 사유 (멀쩡하면 null) */
async function pastTheWall(
  cfg: Config, box: Chrome, target: Target, timeout: number,
): Promise<string | null> {
  await waitForHuman(cfg, box, target, timeout);
  // 캡차를 풀면 대개 상품 페이지로 넘겨 준다. 넘어가 있으면 굳이 다시 받지 않고 화면이
  // 서기만 기다린다 — 다시 받는 것은 벽을 다시 부르는 일이라 공짜가 아니다. 아직 벽에
  // 서 있으면 그때 다시 받는다.
  const here = (await box.driver.getCurrentUrl().catch(() => "")) || "";
  return here.includes(target.key) ? landed(box, timeout) : reopen(box, target.url, timeout);
}

/**
 * 창 하나로 한 상품을 지켜본다.
 *
 * followConfig 가 참이면 **설정의 첫 상품을 따라간다** — 켜 놓은 채로 targets 의 주소를
 * 바꾸면 같은 창을 새 상품 페이지로 옮겨 이어서 본다. 명령줄에 주소를 직접 준
 * (--watch-browser URL) 경우에는 그 주소가 사람의 뜻이라 따라가지 않는다.
 */
export async function watchInBrowser(
  cfg: Config, state: State, target: Target, once = false, followConfig = false,
): Promise<void> {
  const { url, key } = target;
  // 설정을 고치면 바뀔 수 있다. 아래 루프는 이것만 본다.
  target = { ...target };
  let interval = 0;
  let httpInterval = 0;
  let jitter = 0;
  let timeout = 0;
  const pace = () => {
    interval = Math.max(BROWSER_FLOOR, cfg.browser_poll_interval_seconds ?? BROWSER_INTERVAL);
    // HTTP 로 볼 때는 성길 이유가 없다. 한 번에 0.13초짜리다.
    httpInterval = Math.max(cfg.min_interval_seconds ?? 5, cfg.poll_interval_seconds ?? 15);
    jitter = cfg.poll_jitter_seconds ?? 4;
    timeout = cfg.browser_timeout_seconds ?? 20;
  };
  pace();
  const cookie = run.dryRun ? "" : cookieOf(cfg);

  if (!run.dryRun && !hasLoginCookie(cookie)) {
    throw new Error("쿠키에 NID_AUT·NID_SES 가 없습니다. --cookie 로 넣어주세요.");
  }
  // 크롬을 띄우기 전에 한 번 묻는다. 이미 끊긴 쿠키로 창을 세워 봐야 소용없다.
  if (!run.dryRun) await checkLogin(cfg, newSession(cookie), true);

  UI.banner("NAVER · 크롬 창에서 감시", [
    run.dryRun ? "[dry-run] 사지 않고 봅니다" : "네이버 세션을 크롬에 심습니다",
    run.dryRun
      ? `${interval}초 주기 (±${jitter}) · 창에서 읽습니다`
      : `${httpInterval}초 주기 (±${jitter}) · 재고는 HTTP 로 보고 창은 세워 둡니다`,
    "창을 닫으면 멈춥니다",
    cfg.buy_on_restock_only ? "품절 → 구매가능 으로 바뀔 때만 삽니다" : "재고가 있으면 바로 삽니다",
    "캡차가 뜨면 사람을 부릅니다 — 대신 풀지 않습니다",
    arrivalLine(cfg),
  ]);
  log.info(`[${key}] ${target.label || "이름은 첫 조회에서"} ×${target.ea}` +
    (target.option ? ` · 옵션 ${target.option}` : ""));

  let box: Chrome;
  let reason: string | null;
  try {
    [box, reason] = await openPage(url, cookie, {
      headless: cfg.browser_headless, timeout, requireCookie: !run.dryRun,
    });
  } catch (e) {
    if (!(e instanceof BrowserError)) throw e;
    throw new Error(`크롬을 띄우지 못했습니다: ${e.message}`);
  }
  OPEN_BROWSERS.push(box);

  let entry = entryOf(state, key);

  // 재고는 HTTP 로 묻고, 창은 상품 페이지에 세워 둔다.
  //
  // 재 보니 이렇다 — HTTP 한 번 0.13초, 창을 새로 띄우는 값 3.7초(크롬 1.85 + 페이지
  // 0.81 + 버튼 잡히기 1.03). 창을 세워 두면 재고가 열린 순간 **누르는 것부터** 시작한다.
  // 창을 다시 받아 가며 보는 것은 캡차 벽에 막혔을 때의 뒷길로만 남긴다.
  let session: Session | null = run.dryRun ? null : newSession(cookie);
  // 로그인이 살아 있는지 묻는 데만 쓰는 세션. 재고 조회용(session)은 429 로 접히면 null 이
  // 되지만, 로그인 확인(nid.naver.com)은 429 에 막히지 않는다 — 그래서 따로 둔다.
  const whoSession: Session | null = run.dryRun ? null : newSession(cookie);
  let checkedAt = Date.now();
  let parkedAt = Date.now();
  // 방금 무엇으로 읽었나. 창에서 읽었으면 다음 바퀴에 페이지를 다시 받아야 한다 —
  // 세워 둔 창은 저절로 새로워지지 않는다.
  let readBy: string | null = null;

  for (;;) {
    if (await windowGone(box)) throw new WindowClosed();

    // **로그인이 살아 있는지 미리 묻는다.** 창 감시는 하루 종일 켜 두는 일이 많은데,
    // 예전에는 여기서 묻지 않아서 쿠키가 만료돼도 모르다가 재고가 열려 구매하기를 누르는
    // 순간에야 "세션 끊김" 으로 멈췄다. 그때는 이미 늦다. HTTP 감시와 같은 주기로 묻는다.
    const checkEvery = cfg.session_check_minutes ?? 10;
    if (whoSession && checkEvery && Date.now() - checkedAt >= checkEvery * 60_000) {
      checkedAt = Date.now();
      await checkLogin(cfg, whoSession);
    }

    if (reason === SESSION_DEAD) {
      await notifySession(cfg);
      throw new SessionDead();
    }
    if (reason === CAPTCHA_SAID) {
      reason = await pastTheWall(cfg, box, target, timeout);
      parkedAt = Date.now();
      continue;
    }
    if (reason) {
      log.warn(`[${target.key}] ${reason}`);
      readBy = null;
    } else {
      const { reading, httpDead } = await readStockFast(session, box, target);
      if (httpDead) session = null;
      readBy = reading ? reading.where : null;
      if (reading && (await buyFromWindow(cfg, entry, box, target, reading.info, reading.where))) {
        return;
      }
    }
    saveState(state);

    if (once) return;

    // HTTP 로 보고 있으면 창은 건드리지 않는다. 그동안 창은 상품 페이지에 서 있다.
    // **무엇으로 읽었는지로 정한다.** 세션이 살아 있다는 것만 보면, HTTP 가 막혀 창에서
    // 읽고 있는데도 창을 그대로 두게 된다 — 그러면 같은 낡은 페이지를 영원히 다시 읽는다.
    const byHttp = readBy === "HTTP";
    await wait(
      (byHttp ? httpInterval : interval) + Math.random() * jitter,
      byHttp ? "지켜보는 중 (창은 세워 둡니다)" : "크롬 창에서 지켜보는 중",
    );

    // 켜 놓은 채로 설정을 고칠 수 있다. 바뀌었으면 다음 바퀴부터 새 값으로 본다.
    const changed = reloadConfig(cfg);
    if (changed) {
      pace();
      if (changed.includes("order_action") || changed.includes("pg_password")) {
        log.info(`   이제부터: ${arrivalLine(cfg)}`);
      }
      if (changed.includes("cookie") && !run.dryRun) {
        if (session) session.cookie = cookieOf(cfg);
        if (whoSession) whoSession.cookie = cookieOf(cfg);
        log.warn("   쿠키가 바뀌었습니다. 이미 띄운 크롬 창에는 예전 쿠키가 심겨 있습니다 — " +
          "창에서 사려면 껐다 켜 주세요.");
      }
      if (changed.includes("targets")) {
        const next = followConfig ? nextTarget(cfg, target) : null;
        if (next && next.key !== target.key) {
          log.info(`   보는 상품을 바꿉니다: [${target.key}] → [${next.key}] ${next.url}`);
          target = next;
          entry = entryOf(state, target.key);
          if (entry.done) {
            log.warn(`   [${target.key}] 이미 산 기록이 있어 사지 않습니다 — 다시 사려면 --reset`);
          }
          reason = await reopen(box, target.url, timeout);
          parkedAt = Date.now();
          continue;
        }
        // 같은 상품이면 수량·옵션·상한가만 새로 받는다.
        if (next) target = next;
      }
    }

    if (!byHttp) {
      reason = await reopen(box, target.url, timeout);
      parkedAt = Date.now();
    } else if (Date.now() - parkedAt >= PARK_REFRESH_SECONDS * 1000) {
      // 오래 세워 둔 페이지로 누르면 사이트가 낡은 것으로 볼 수 있다. 조회와 상관없는
      // 자리에서 조용히 새로 받아 둔다.
      log.debug("세워 둔 페이지를 새로 받습니다.");
      reason = await reopen(box, target.url, timeout);
      parkedAt = Date.now();
    }
  }
}

/**
 * 크롬 창에서 상품을 열고, 그 창에서 재고를 읽고, 거기서 주문서까지 간다.
 *
 * 캡차 벽에 막히는 상품(스마트스토어)의 --buy 가 오는 자리다. HTTP 로는 재고를 물어볼
 * 수조차 없으니 **창 하나로 조회와 구매를 다 한다** — 조회용 창과 구매용 창을 따로 띄우면
 * 캡차를 두 번 풀어야 한다.
 *
 * --buy 는 "지금 바로" 라는 뜻이므로, 여기서는 품절→구매가능 으로 바뀔 때만 사는
 * 규칙(buy_on_restock_only)과 이미 샀다는 기록(done)을 적용하지 않는다. 사람이 직접 부른
 * 명령이고, 그 판단은 이미 사람이 한 것이다.
 */
export async function buyNowInBrowser(cfg: Config, state: State, target: Target): Promise<void> {
  const timeout = cfg.browser_timeout_seconds ?? 20;

  let box: Chrome;
  let reason: string | null;
  try {
    [box, reason] = await openPage(target.url, cookieOf(cfg), {
      headless: cfg.browser_headless, timeout,
    });
  } catch (e) {
    if (!(e instanceof BrowserError)) throw e;
    throw new Error(`크롬을 띄우지 못했습니다: ${e.message}`);
  }
  OPEN_BROWSERS.push(box);

  while (reason === CAPTCHA_SAID) {
    reason = await pastTheWall(cfg, box, target, timeout);
  }
  if (reason === SESSION_DEAD) {
    await notifySession(cfg);
    throw new SessionDead();
  }
  if (reason) throw new Error(reason);

  const [info, where] = await stockInWindow(box, target);
  log.info(`[${target.key}] ${info.name || target.url} — ${STATUS_LABEL[info.status]} (${where})`);
  if (info.status === SOLDOUT) throw new Error("품절입니다.");

  const entry = entryOf(state, target.key);
  delete entry.done;                                    // 사람이 지금 부른 명령이다
  const now = { ...cfg, buy_on_restock_only: false };   // 기다리지 않고 지금 산다
  await buyFromWindow(now, entry, box, target, info, where);
}
