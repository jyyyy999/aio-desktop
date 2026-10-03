/**
 * 감시 루프. naver_buy.py 의 watch()/handle_target 과 같은 판단을 한다.
 *
 *   감시(초 단위) → 구매 가능 감지 → 바로구매 클릭 → 디스코드 알림 + 주문서 → [사람] 결제
 *
 * 결제 확정은 사람이 누른다. 로그인도 자동화하지 않는다(캡차·기기 등록).
 */
import { log, sayOk, sayStar, sayStep, tick } from "../log.js";
import { UI } from "../ui.js";
import { comma, nowStamp, sleep, wait } from "../util.js";
import {
  CONFIG_PATH, cookieOf, entryOf, IN_STOCK, Quit, reloadConfig, run, saveState, SOLDOUT,
  type Config, type State, type TargetEntry,
} from "./config.js";
import {
  CAPTCHA_SAID, hasLoginCookie, loginAlive, needsBrowser, PUSHED_BACK, sayHowto, sayPushedHowto,
  SiteError, type Session,
} from "./http.js";
import { notifyBlocked, notifyOpened, notifySession } from "./notify.js";
import { arrivalLine, doBuy } from "./order.js";
import { fetchStock, type StockInfo } from "./product.js";
import { targetsOf, type Target } from "./targets.js";
import { basename } from "node:path";

/** 세션이 끊겼다. 다시 두드려 봐야 소용없으므로 위에서 프로그램을 접는다. */
export class SessionDead extends Error {
  constructor() {
    super("로그인 세션이 끊겼습니다. --cookie 로 다시 넣어주세요.");
  }
}

/** 벽(캡차·429)을 만났다고 이미 일러 준 상품. 같은 말을 매 바퀴 하지 않으려고 센다. */
const SAID_WALL = new Set<string>();
/** "지금 사려면" 을 이미 일러 준 상품. 같은 이유로 센다. */
const SAID_NOW = new Set<string>();
/** 이미 샀다고 일러 준 상품. 같은 이유로 센다. */
const SAID_DONE = new Set<string>();

/**
 * 기다리는 이유와, 지금 사는 방법을 한 번만 일러 준다.
 *
 * 기본값(buy_on_restock_only)은 **품절 → 구매가능 으로 바뀔 때만** 산다. 지금 팔고 있는
 * 물건을 두고 가만히 있는 것이 정상 동작인데, 화면만 보면 "안 사고 뭐 하나" 로 보인다.
 * 무엇을 기다리는지와 지금 사는 방법을 같이 적어 준다.
 */
export function sayNowHint(target: Target): void {
  if (SAID_NOW.has(target.key)) return;
  SAID_NOW.add(target.key);
  sayStep(`재입고를 기다리는 중입니다. 지금 사려면:  node dist/naver/index.js --buy ${target.url}`);
  log.info(`   지금 팔고 있는 것도 사려면 ${basename(CONFIG_PATH)} 의 ` +
    "buy_on_restock_only 를 false 로 두세요.");
}

/** 사이트가 삐끗하면 다음 주기까지 기다리지 않고 바로 다시 묻는다. */
export async function retrying<T>(cfg: Config, what: string, call: () => Promise<T>): Promise<T> {
  const attempts = Math.max(1, Number(cfg.max_attempts || 1));
  const delay = cfg.retry_delay_seconds ?? 2;

  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof SiteError) || attempt >= attempts) throw e;
      // 벽은 고장이 아니다. 다시 두드려 봐야 같은 답이 오고, 그 사이 시간만 버린다.
      if (needsBrowser(e.message)) throw e;
      log.warn(`${what} 실패 (${attempt}/${attempts}): ${e.message}`);
      if (delay) await sleep(delay * 1000);
    }
  }
}

/** 사기 전에 멈춰야 할 이유가 있는가. → 사유 (없으면 null) */
export function blockingReason(cfg: Config, target: Target, info: StockInfo): string | null {
  const limit = target.max_price || cfg.max_price || 0;
  const price = info.price;
  if (limit && price && price > limit) {
    return `가격이 상한을 넘습니다 — ${comma(price)}원 > ${comma(limit)}원`;
  }
  if (target.ea > 1 && info.stock >= 0 && info.stock < target.ea) {
    return `재고가 모자랍니다 — ${info.stock}개 < ${target.ea}개`;
  }
  return null;
}

/** 아직 쉬는 중인가. → 남은 분 (아니면 null) */
export function onCooldown(entry: TargetEntry, now: Date, minutes: number): number | null {
  if (!minutes) return null;
  const last = entry.last_try_at;
  if (!last) return null;
  const at = new Date(last).getTime();
  if (Number.isNaN(at)) return null;
  const elapsed = now.getTime() - at;
  if (elapsed >= minutes * 60_000) return null;
  return Math.floor((minutes * 60_000 - elapsed) / 60_000) + 1;
}

/** 화면에 적을 재고 수량. 수량을 안 내주는 상품은 "있음" 이다. */
export function stockText(info: StockInfo): string {
  return info.stock >= 0 ? `${info.stock}개` : "있음";
}

interface Counters { bought: number }

/** 상품 하나를 확인하고, 열려 있으면 산다. → 샀으면 true */
async function handleTarget(
  cfg: Config, s: Session, state: State, target: Target, counters: Counters,
): Promise<boolean> {
  const key = target.key;
  const entry = entryOf(state, key);
  const now = new Date();

  // **말없이 건너뛰지 않는다.** 화면에는 "지켜보는 중" 만 뜨는데 정작 이 상품은 보고
  // 있지도 않으면, 사람은 고장인 줄 안다 (2026-09-18 에 한 번 사고 나서 그랬다).
  if (entry.done) {
    if (!SAID_DONE.has(key)) {
      SAID_DONE.add(key);
      log.warn(`[${key}] ${entry.name || key} — 이미 샀습니다 (${entry.opened_at ?? "?"}). ` +
        "이 상품은 보지 않습니다. 다시 보려면 --reset");
    }
    return false;
  }
  const left = onCooldown(entry, now, cfg.cooldown_minutes);
  if (left) {
    if (!SAID_DONE.has(key)) {
      SAID_DONE.add(key);
      log.warn(`[${key}] ${entry.name || key} — 쉬는 중입니다. ${left}분 뒤에 다시 봅니다 ` +
        `(마지막 시도 ${entry.last_try_at}). 안 쉬게 하려면 cooldown_minutes 를 0 으로`);
    }
    return false;
  }

  const info = await retrying(cfg, `[${key}] 재고 조회`, () => fetchStock(s, target));
  const name = target.label || info.name || key;
  entry.name = name;
  entry.stock = info.stock;

  const was = entry.status;
  entry.status = info.status;

  if (info.status === SOLDOUT) {
    if (was === IN_STOCK) log.info(`[${key}] ${name} — 품절로 바뀌었습니다`);
    else tick(`${name} — 품절`);
    return false;
  }

  // 품절 → 구매가능 으로 **바뀌는 순간**에만 산다.
  //
  // 처음 본 것도 사지 않는다. 감시를 켤 때 이미 팔고 있던 물건은 노리던 것이 아니고,
  // 설정을 잘못 써 놓고 실행했을 때 곧장 주문서까지 가버리는 사고도 여기서 막힌다.
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
  entry.last_try_at = nowStamp(now);

  const reason = blockingReason(cfg, target, info);
  if (reason) {
    log.warn(`[${key}] 사지 않습니다 — ${reason}`);
    entry.blocked = reason;
    await notifyBlocked(cfg, target, reason);
    return false;
  }

  delete entry.blocked;
  const got = await doBuy(cfg, cookieOf(cfg), target, info);
  entry.opened = got.ok;

  if (got.dead) {
    // 세션이 끊겼으면 재고가 열려도 살 수 없다. 조용히 계속 도는 것보다 알리고 멈춘다.
    entry.blocked = got.reason ?? undefined;
    await notifySession(cfg);
    throw new SessionDead();
  }

  if (!got.ok) {
    entry.blocked = got.reason ?? undefined;
    log.warn(`[${key}] 주문서를 못 열었습니다 — ${got.reason}`);
    await notifyBlocked(cfg, target, `주문서를 못 열었습니다 — ${got.reason}`);
    return false;
  }

  counters.bought += 1;
  entry.opened_at = nowStamp(now);
  entry.stage = got.stage;
  entry.done = !!cfg.stop_after_success;
  if (await notifyOpened(cfg, target, info, got.stage)) sayStar("디스코드로 알렸습니다 — 결제해 주세요");
  return true;
}

/**
 * 설정의 targets 가 바뀌었다. 새 목록을 돌려준다 — 못 읽으면 예전 목록 그대로.
 *
 * 무엇이 빠지고 무엇이 들어왔는지 적는다. 조용히 바꾸면 사람은 지금 무엇을 보고 있는지
 * 모른다. 새로 들어온 상품은 "처음 본 것" 부터 시작한다 — 상태에 적힌 게 없으니
 * buy_on_restock_only 면 품절을 한 번 거친 뒤에 산다.
 */
export function retarget(cfg: Config, state: State, before: Target[]): Target[] {
  let after: Target[];
  try {
    after = targetsOf(cfg);
  } catch (e) {
    log.warn(`targets 를 읽지 못했습니다 — 예전 목록으로 계속 봅니다 (${(e as Error).message.split("\n")[0]})`);
    return before;
  }
  const had = new Set(before.map((t) => t.key));
  const has = new Set(after.map((t) => t.key));
  for (const t of before) if (!has.has(t.key)) log.info(`   목록에서 빠졌습니다: [${t.key}] ${t.url}`);
  for (const t of after) {
    if (had.has(t.key)) continue;
    const known = state.targets?.[t.key];
    const option = t.option ? ` · 옵션 ${t.option}` : "";
    log.info(`   새로 봅니다: [${t.key}] ${t.label || known?.name || t.url} ×${t.ea}${option}` +
      (known?.done ? " — 이미 산 기록이 있어 건너뜁니다 (--reset)" : ""));
  }
  return after;
}

/**
 * HTTP 로는 한 바퀴를 통째로 못 봤다. 크롬 창으로 넘어가서 보라는 뜻이다.
 *
 * 여기서 창 감시(window.ts)를 곧장 부르지 않는 것은, 그쪽이 이 파일을 들이고 있어서다 —
 * 서로 들이면 어느 쪽이 먼저 서는지에 따라 값이 비는 자리가 생긴다. index.ts 가 받아서 넘긴다.
 */
export class NeedsWindow extends Error {
  constructor(public target: Target) {
    super("HTTP 로는 이 상품을 볼 수 없습니다 — 크롬 창에서 봅니다");
  }
}

export async function watch(
  cfg: Config, s: Session, state: State, once: boolean,
): Promise<void> {
  let entries = targetsOf(cfg);
  if (!entries.length) {
    throw new Error(`${basename(CONFIG_PATH)} 의 targets 가 비어 있습니다. --add 로 상품을 넣어주세요.`);
  }

  let interval = 0;
  let jitter = 0;
  let limit = 0;
  const pace = () => {
    interval = Math.max(cfg.min_interval_seconds ?? 5, cfg.poll_interval_seconds ?? 15);
    jitter = cfg.poll_jitter_seconds ?? 4;
    limit = cfg.max_buys_per_run ?? 1;
  };
  pace();
  const counters: Counters = { bought: 0 };

  const cookie = cookieOf(cfg);
  let checkedAt: number | null = null;
  let who: string;
  if (run.dryRun) {
    who = "[dry-run] 쿠키 없이 재고만 봅니다";
  } else {
    if (!hasLoginCookie(cookie)) {
      throw new Error("쿠키에 NID_AUT·NID_SES 가 없습니다. --cookie 로 넣어주세요.");
    }
    if (!(await loginAlive(s))) {
      throw new Error("빌려온 세션이 이미 끊겼습니다. 브라우저에서 다시 복사해 --cookie 로 넣어주세요.");
    }
    who = "네이버 세션을 빌려 왔습니다 — 로그인 확인됨";
    checkedAt = Date.now();
  }

  UI.banner("NAVER", [
    who,
    `감시 ${entries.length}개 · ${interval}초 주기 (±${jitter}) · 최대 ${limit}개`,
    cfg.buy_on_restock_only ? "품절 → 구매가능 으로 바뀔 때만 삽니다" : "재고가 있으면 바로 삽니다",
    arrivalLine(cfg),
    "Node.js/TypeScript 판 · 결제 확정은 사람이 누릅니다",
  ]);
  for (const target of entries) {
    const known = state.targets?.[target.key]?.name;
    const label = target.label || known || "이름은 첫 조회에서";
    const option = target.option ? ` · 옵션 ${target.option}` : "";
    log.info(`[${target.key}] ${label} ×${target.ea}${option}`);
  }

  let first = true;
  for (;;) {
    // 켜 놓은 채로 설정을 고칠 수 있다. 바뀌었으면 이번 바퀴부터 새 값으로 본다.
    if (!first) {
      const changed = reloadConfig(cfg);
      if (changed) {
        pace();
        if (changed.includes("cookie") && !run.dryRun) s.cookie = cookieOf(cfg);
        if (changed.includes("targets")) entries = retarget(cfg, state, entries);
        if (changed.includes("order_action") || changed.includes("pg_password")) {
          log.info(`   이제부터: ${arrivalLine(cfg)}`);
        }
      }
    }
    first = false;
    const checkEvery = cfg.session_check_minutes ?? 10;

    // 세션이 끊긴 것을 재고가 열리는 순간에 알게 되면 이미 늦다. 미리 물어본다.
    if (checkedAt && checkEvery && Date.now() - checkedAt >= checkEvery * 60_000) {
      let alive: boolean;
      try {
        alive = await loginAlive(s);
      } catch (e) {
        if (!(e instanceof SiteError)) throw e;
        // 못 물어본 것과 로그아웃된 것은 다르다. 못 물어봤다고 감시를 접지 않는다.
        log.warn(`세션 확인 실패 (계속 진행): ${e.message}`);
        alive = true;
      }
      checkedAt = Date.now();
      if (!alive) {
        await notifySession(cfg);
        throw new SessionDead();
      }
    }

    // 이번 바퀴에 벽에 막힌 상품. 하나도 못 본 채로 한 바퀴가 끝나면 아래에서 접는다.
    const walled = new Set<string>();
    if (!entries.length) {
      // 목록을 비워 놓은 것이다. 접지 않고 다시 채워지기를 기다린다.
      await wait(interval, `${basename(CONFIG_PATH)} 의 targets 가 비어 있습니다 — 채우면 봅니다`);
      continue;
    }

    for (const target of entries) {
      try {
        await handleTarget(cfg, s, state, target, counters);
      } catch (e) {
        if (e instanceof SessionDead) throw e;
        if (!(e instanceof SiteError)) throw e;
        if (needsBrowser(e.message)) walled.add(target.key);
        log.error(`[${target.key}] ${e.message}`);
        // 벽은 다음 바퀴에도 그대로다. 갈 길을 한 번만 일러 준다 — 매 바퀴 적으면
        // 그게 로그를 덮어 정작 다른 실패가 안 보인다.
        // 상품이 하나면 아래에서 알아서 창으로 넘어가니 명령을 일러 줄 것이 없다.
        if (needsBrowser(e.message) && !SAID_WALL.has(target.key) && (entries.length > 1 || once)) {
          SAID_WALL.add(target.key);
          sayStep("이 상품은 크롬 창에서 봐야 합니다:  " +
            `node dist/naver/index.js --watch-browser ${target.url}`);
          if (e.message === CAPTCHA_SAID) sayHowto();
          if (e.message === PUSHED_BACK) sayPushedHowto();
        }
      } finally {
        saveState(state);
      }

      if (counters.bought >= limit) {
        sayStar(`${counters.bought}개를 샀습니다(주문서까지). 감시를 멈춥니다`);
        return;
      }
    }

    // **한 바퀴를 통째로 못 봤으면 계속 돌지 않는다.**
    //
    // Node 의 fetch 는 네이버의 TLS 지문 검사를 통과하지 못한다(http.ts 의 PUSHED_BACK).
    // 그러면 여기서 하는 일은 15초마다 같은 벽을 두드리는 것뿐이고, 화면에는 "지켜보는
    // 중" 이 떠 있어 사람은 지켜지고 있다고 믿는다. 그게 제일 나쁘다 — 재고가 열려도
    // 아무 일도 안 일어난다.
    //
    // 상품이 하나면 **사람을 부르지 않고 크롬 창으로 넘어간다.** 2026-08-23 에 이 자리에서
    // 다섯 번을 멈췄고, 매번 사람이 --watch-browser 를 다시 쳤다. 갈 길이 하나뿐이면
    // 묻지 않고 간다. 여럿이면 창 하나에 하나씩이라 무엇을 볼지 사람이 골라야 한다.
    if (walled.size === entries.length) {
      if (entries.length === 1 && !once) {
        log.warn(`[${entries[0]!.key}] HTTP 로는 못 봅니다 — 크롬 창을 띄워 거기서 이어서 봅니다`);
        throw new NeedsWindow(entries[0]!);
      }
      log.error(`감시 대상 ${entries.length}개를 모두 못 봤습니다. 이대로는 지켜볼 수 없어 멈춥니다.`);
      sayStep("크롬 창에서 지켜보세요 (한 번에 한 상품):  " +
        `node dist/naver/index.js --watch-browser ${entries[0]!.url}`);
      throw new Quit();
    }

    if (once) return;
    await wait(interval + Math.random() * jitter, "지켜보는 중");
  }
}
