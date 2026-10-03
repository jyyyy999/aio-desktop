/**
 * 감시 루프.
 *
 *   지켜보기(초 단위) → 구매 가능 감지 → 바로 구매하기 → 주문서 → 필수 동의
 *   → 결제하기 → **PG 결제창을 띄우고 멈춘다** → 디스코드 알림 → [사람] 결제
 *
 * 조회는 HTTP 로 한다. 롯데온은 Node 의 요청을 밀어내지 않는다(http.ts 참고) — 그래서
 * 네이버 판처럼 크롬 창을 세워 둘 필요가 없고, bnkr 판처럼 여러 개를 동시에 볼 수 있다.
 */
import { basename } from "node:path";
import { log, sayOk, sayStar, sayStep } from "../log.js";
import { UI } from "../ui.js";
import { comma, nowStamp, pool, priceText, sleep, wait } from "../util.js";
import {
  CONFIG_PATH, cookieOf, entryOf, IN_STOCK, loadConfig, run, saveState, SOLDOUT, STATUS_LABEL,
  type Config, type State, type TargetEntry,
} from "./config.js";
import { loginAlive, looksLikeCookie, SiteError, type Session } from "./http.js";
import { notifyBlocked, notifyOpened, notifySession } from "./notify.js";
import { arrivalLine, doBuy } from "./order.js";
import { fetchStock, type StockInfo } from "./product.js";
import { targetsOf, type Target } from "./targets.js";

/** 세션이 끊겼다. 다시 두드려 봐야 소용없으므로 위에서 프로그램을 접는다. */
export class SessionDead extends Error {
  constructor() {
    super("로그인 세션이 끊겼습니다. --cookie 로 다시 넣어주세요.");
  }
}

/** "지금 사려면" 을 이미 일러 준 상품. 같은 말을 매 바퀴 하지 않으려고 센다. */
const SAID_NOW = new Set<string>();
/** 쉬는 중이라고 이미 일러 준 상품. 같은 이유로 센다. */
const SAID_COOLDOWN = new Set<string>();

/**
 * 왜 아무것도 안 하는지 한 번은 크게 말한다.
 *
 * **조용히 건너뛰지 않는 것이 요점이다.** 쉬는 중인 상품을 말없이 넘기면 화면에는
 * "지켜보는 중" 만 뜨는데, 정작 그 상품은 보고 있지도 않다. 사람은 프로그램이 일하고
 * 있다고 믿고 기다린다 — 이 프로젝트에서 제일 나쁜 상태다.
 */
function sayCooldown(target: Target, entry: TargetEntry, left: number): void {
  if (SAID_COOLDOWN.has(target.key)) return;
  SAID_COOLDOWN.add(target.key);
  log.warn(`[${target.key}] ${entry.name || target.key} — 쉬는 중입니다. ` +
    `${left}분 뒤에 다시 봅니다 (마지막 시도 ${entry.last_try_at})`);
  log.info(`   지금 사려면:  node dist/lotte/index.js --buy ${target.url}`);
  log.info(`   쉬는 기록을 지우려면 --reset, 안 쉬게 하려면 ${basename(CONFIG_PATH)} 의 ` +
    "cooldown_minutes 를 0 으로 두세요.");
}

/**
 * 기다리는 이유와, 지금 사는 방법을 한 번만 일러 준다.
 *
 * 기본값(buy_on_restock_only)은 **품절 → 구매가능 으로 바뀔 때만** 산다. 지금 팔고 있는
 * 물건을 두고 가만히 있는 것이 정상 동작인데, 화면만 보면 "안 사고 뭐 하나" 로 보인다.
 */
export function sayNowHint(target: Target): void {
  if (SAID_NOW.has(target.key)) return;
  SAID_NOW.add(target.key);
  sayStep(`재입고를 기다리는 중입니다. 지금 사려면:  node dist/lotte/index.js --buy ${target.url}`);
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
      log.warn(`${what} 실패 (${attempt}/${attempts}): ${e.message}`);
      if (delay) await sleep(delay * 1000);
    }
  }
}

/**
 * 사기 전에 멈춰야 할 이유가 있는가. → 사유 (없으면 null)
 *
 * **수량으로는 막지 못한다.** ld+json 은 "있다/없다" 만 말하고 몇 개인지는 안 알려 준다.
 * 재고보다 많이 담으려 하면 사이트가 alert 로 막고, 그건 browser.ts 가 사유로 올린다.
 */
export function blockingReason(cfg: Config, target: Target, info: StockInfo): string | null {
  const limit = target.max_price || cfg.max_price || 0;
  if (limit && info.price && info.price > limit) {
    return `가격이 상한을 넘습니다 — ${comma(info.price)}원 > ${comma(limit)}원`;
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

interface Counters { bought: number }

/** 이번 바퀴에 이 상품이 어떻게 됐나. note 는 기다리는 줄에 적어 사람에게 보여 준다. */
interface Handled { bought: boolean; note: string }

/**
 * 읽은 재고를 보고 판단해, 열려 있으면 산다. → 샀으면 true
 *
 * 조회는 위에서 미리 해 둔다(여럿을 동시에 보기 위해서다). 여기서는 판단과 누르기만
 * 한다 — 누르는 것은 어떤 경우에도 한 줄로 간다.
 */
async function handleTarget(
  cfg: Config, state: State, target: Target, info: StockInfo, counters: Counters,
): Promise<Handled> {
  const key = target.key;
  const entry = entryOf(state, key);
  const now = new Date();
  const shown = target.label || entry.name || key;

  // **여기서 조용히 돌아서지 않는다.** 아래 두 줄은 아무 말 없이 건너뛰던 자리였고,
  // 그래서 화면에 "지켜보는 중" 만 떠 있는 채로 아무것도 안 하는 일이 벌어졌다.
  if (entry.done) return { bought: false, note: `${shown} — 이미 샀습니다 (--reset 으로 지웁니다)` };
  const left = onCooldown(entry, now, cfg.cooldown_minutes);
  if (left) {
    sayCooldown(target, entry, left);
    return { bought: false, note: `${shown} — 쉬는 중 ${left}분` };
  }

  const name = target.label || info.name || key;
  entry.name = name;
  entry.price = info.price;

  const was = entry.status;
  entry.status = info.status;

  if (info.status === SOLDOUT) {
    if (was === IN_STOCK) log.info(`[${key}] ${name} — 품절로 바뀌었습니다`);
    return { bought: false, note: `${name} — 품절` };
  }

  // 품절 → 구매가능 으로 **바뀌는 순간**에만 산다.
  //
  // 처음 본 것도 사지 않는다. 감시를 켤 때 이미 팔고 있던 물건은 노리던 것이 아니고,
  // 설정을 잘못 써 놓고 실행했을 때 곧장 결제창까지 가버리는 사고도 여기서 막힌다.
  if (cfg.buy_on_restock_only && was !== SOLDOUT) {
    if (was === undefined) {
      log.info(`[${key}] ${name} — 이미 판매 중입니다. 품절됐다가 다시 열릴 때 삽니다`);
    }
    sayNowHint(target);
    return { bought: false, note: `${name} — 계속 판매 중 (재입고를 기다립니다)` };
  }

  sayOk(`[${key}] ${name} — 구매 가능, 바로 구매하기를 누릅니다 (×${target.ea})`);
  entry.last_try_at = nowStamp(now);

  const reason = blockingReason(cfg, target, info);
  if (reason) {
    log.warn(`[${key}] 사지 않습니다 — ${reason}`);
    entry.blocked = reason;
    await notifyBlocked(cfg, target, reason);
    return { bought: false, note: `${name} — 사지 않았습니다 (${reason})` };
  }

  delete entry.blocked;
  const got = await doBuy(cfg, cookieOf(cfg), target);
  entry.opened = got.ok;
  entry.stage = got.stage;

  if (got.dead) {
    entry.blocked = got.reason ?? undefined;
    await notifySession(cfg);
    throw new SessionDead();
  }

  if (!got.ok) {
    entry.blocked = got.reason ?? undefined;
    log.warn(`[${key}] 주문서를 못 열었습니다 — ${got.reason}`);
    await notifyBlocked(cfg, target, `주문서를 못 열었습니다 — ${got.reason}`);
    return { bought: false, note: `${name} — 주문서를 못 열었습니다` };
  }

  counters.bought += 1;
  entry.opened_at = nowStamp(now);
  entry.done = !!cfg.stop_after_success;
  if (await notifyOpened(cfg, target, info, got.stage)) sayStar("디스코드로 알렸습니다 — 결제해 주세요");
  return { bought: true, note: `${name} — 여기까지 데려왔습니다 (${got.stage})` };
}

/** 이번 바퀴에 볼 것들의 재고를 한꺼번에 읽는다. 터진 것은 결과에 실어 온다. */
type Reading = { info: StockInfo } | { error: SiteError };

async function readAll(cfg: Config, s: Session, entries: Target[]): Promise<Reading[]> {
  const hands = Math.max(1, Number(cfg.max_concurrency || 1));
  return pool(entries, hands, async (target) => {
    try {
      return { info: await retrying(cfg, `[${target.key}] 재고 조회`, () => fetchStock(s, target)) };
    } catch (e) {
      if (!(e instanceof SiteError)) throw e;
      return { error: e };
    }
  });
}

/**
 * 설정이 바뀌었으면 감시 목록을 갈아 끼운다. → 새 목록 (안 바뀌었으면 null)
 *
 * 기다리는 **도중에도** 본다. 상품을 하나 더 넣어 놓고 다음 주기까지 기다려야 한다면
 * 실시간 반영이라 할 수 없다.
 */
function reread(known: string): [string, Target[]] | null {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch {
    // 사람이 고치는 중이라 반쯤 쓰인 파일일 수 있다. 다음에 다시 본다.
    return null;
  }
  const now = JSON.stringify(cfg.targets ?? []);
  if (now === known) return null;
  try {
    return [now, targetsOf(cfg)];
  } catch (e) {
    log.warn(`바뀐 targets 를 못 읽었습니다 (그대로 갑니다): ${(e as Error).message}`);
    return null;
  }
}

export async function watch(cfg: Config, s: Session, state: State, once: boolean): Promise<void> {
  let entries = targetsOf(cfg);
  if (!entries.length) {
    throw new Error(`${basename(CONFIG_PATH)} 의 targets 가 비어 있습니다. --add 로 상품을 넣어주세요.`);
  }
  let known = JSON.stringify(cfg.targets ?? []);

  const floor = cfg.min_interval_seconds ?? 5;
  const interval = Math.max(floor, cfg.poll_interval_seconds ?? 15);
  const jitter = cfg.poll_jitter_seconds ?? 4;
  const limit = cfg.max_buys_per_run ?? 1;
  const counters: Counters = { bought: 0 };

  let checkedAt: number | null = null;
  let who: string;
  if (run.dryRun) {
    who = "[dry-run] 쿠키 없이 재고만 봅니다";
  } else {
    if (!looksLikeCookie(cookieOf(cfg))) {
      throw new Error("쿠키가 비어 있습니다. 브라우저에서 Cookie 줄을 복사해 --cookie 로 넣어주세요.");
    }
    if (!(await loginAlive(s))) {
      throw new Error("빌려온 세션이 이미 끊겼습니다. 브라우저에서 다시 복사해 --cookie 로 넣어주세요.");
    }
    who = "롯데온 세션을 빌려 왔습니다 — 로그인 확인됨";
    checkedAt = Date.now();
  }

  UI.banner("LOTTE ON", [
    who,
    `감시 ${entries.length}개 · ${interval}초 주기 (±${jitter}) · 최대 ${limit}개`,
    cfg.buy_on_restock_only ? "품절 → 구매가능 으로 바뀔 때만 삽니다" : "재고가 있으면 바로 삽니다",
    arrivalLine(cfg),
    "Node.js/TypeScript 판 · 로그인은 브라우저에서 빌려 온 세션입니다",
  ]);
  for (const target of entries) {
    const label = target.label || state.targets?.[target.key]?.name || "이름은 첫 조회에서";
    const option = target.option ? ` · 옵션 ${target.option}` : "";
    log.info(`[${target.key}] ${label} ×${target.ea}${option}`);
  }

  const checkEvery = cfg.session_check_minutes ?? 10;

  for (;;) {
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

    const readings = await readAll(cfg, s, entries);
    // 이번 바퀴에 무엇을 봤는지. 기다리는 줄에 그대로 적는다 — "지켜보는 중" 만 떠
    // 있으면 사람은 무엇을 지켜보는 중인지 알 수 없다.
    const notes: string[] = [];

    for (let at = 0; at < entries.length; at++) {
      const target = entries[at]!;
      const reading = readings[at]!;
      if ("error" in reading) {
        log.error(`[${target.key}] ${reading.error.message}`);
        notes.push(`${target.label || target.key} — 조회 실패`);
        continue;
      }
      try {
        notes.push((await handleTarget(cfg, state, target, reading.info, counters)).note);
      } catch (e) {
        // 세션이 끊긴 것은 위로 올린다 — 그건 계속 돌 이유가 없는 실패다.
        if (e instanceof SessionDead) throw e;
        // 나머지는 이 상품 하나의 일이다. **한 상품이 자빠졌다고 감시를 접지 않는다.**
        // 크롬 창이 사라져 셀레니움이 던지는 것(invalid session id)이 여기로 온다.
        // 다음 바퀴에는 창을 새로 띄우므로 다시 해볼 값어치가 있다.
        log.error(`[${target.key}] ${(e as Error).message}`);
        entryOf(state, target.key).blocked = (e as Error).message;
        notes.push(`${target.label || target.key} — 하다가 끊겼습니다`);
      } finally {
        saveState(state);
      }
      if (counters.bought >= limit) {
        sayStar(`${counters.bought}개를 여기까지 데려왔습니다. 감시를 멈춥니다`);
        return;
      }
    }

    if (once) return;

    // 기다리는 도중에도 설정을 본다. 상품을 더 넣으면 그 자리에서 목록이 갈린다.
    // 상자에 담아 넘긴다. 클로저 안에서 쓴 값을 타입스크립트가 못 따라와서다.
    const swap: { next: [string, Target[]] | null } = { next: null };
    await wait(interval + Math.random() * jitter, watching(notes), () => {
      swap.next = reread(known);
      return swap.next !== null;
    });
    if (swap.next) {
      [known, entries] = swap.next;
      sayStep(`설정이 바뀌었습니다 — 이제 ${entries.length}개를 봅니다`);
    }
  }
}

/**
 * 기다리는 동안 화면에 적을 한 줄. → "잉어킹 — 계속 판매 중 (재입고를 기다립니다)"
 *
 * 하나면 그 상품의 사정을 그대로 적고, 여럿이면 세어서 적는다. **"지켜보는 중" 만
 * 적지 않는다** — 그 줄은 아무것도 안 하고 있을 때와 잘 돌고 있을 때가 똑같이 보인다.
 */
function watching(notes: string[]): string {
  if (!notes.length) return "지켜보는 중";
  if (notes.length === 1) return notes[0]!;

  const count = (mark: string) => notes.filter((one) => one.includes(mark)).length;
  const parts = [
    ["품절", count("품절")],
    ["계속 판매 중", count("계속 판매 중")],
    ["쉬는 중", count("쉬는 중")],
    ["이미 샀습니다", count("이미 샀습니다")],
    ["조회 실패", count("조회 실패")],
  ] as const;
  const said = parts.filter(([, n]) => n > 0).map(([name, n]) => `${name} ${n}`);
  return `${notes.length}개 지켜보는 중 · ${said.join(" · ") || "확인함"}`;
}

/** --status 가 쓰는 한 줄. 감시와 같은 값을 같은 말로 적는다. */
export function statusLine(target: Target, info: StockInfo): string {
  return `[${target.key}] ${target.label || info.name} — ${STATUS_LABEL[info.status]} ` +
    `(${priceText(info.price)})`;
}
