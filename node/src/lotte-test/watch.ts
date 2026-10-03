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
import { arrivalLine, doBuy, lostRace } from "./order.js";
import { fetchStock, type StockInfo } from "./product.js";
import { targetsOf, type Target } from "./targets.js";
import { msToOpening, nearOpening, planWarm } from "./warm.js";

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
 * 품절로 진 것이 이만큼 **잇달아** 나오면 그때는 쉰다.
 *
 * 품절로 진 판은 쉬지 않고 바로 다음 재입고를 본다. 그런데 API 는 판다고 하고 사이트는
 * 품절이라 하는 일이 계속되면(딜 재고를 안 봤을 때가 그랬다) 몇 초마다 크롬을 띄우는
 * 헛바퀴가 된다. 그걸 끊는 자리다. API 가 한 번이라도 품절이라 하면 셈을 새로 한다.
 */
const LOST_RACE_LIMIT = 3;

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
  log.info(`   지금 사려면:  node dist/lotte-test/index.js --buy ${target.url}`);
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
  sayStep(`재입고를 기다리는 중입니다. 지금 사려면:  node dist/lotte-test/index.js --buy ${target.url}`);
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
    // API 도 품절이라 한다 — 판정과 사이트가 맞아떨어진 것이니 진 셈을 새로 한다.
    delete entry.lost_races;
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
  const got = await doBuy(cfg, cookieOf(cfg), target, info.name);
  entry.opened = got.ok;
  entry.stage = got.stage;

  if (got.dead) {
    entry.blocked = got.reason ?? undefined;
    await notifySession(cfg);
    throw new SessionDead();
  }

  if (!got.ok && lostRace(got.reason)) {
    const lost = (entry.lost_races ?? 0) + 1;
    entry.lost_races = lost;
    entry.blocked = got.reason ?? undefined;
    if (lost < LOST_RACE_LIMIT) {
      // **쉬지 않는다.** 2026-09-18 14:08 에 여기서 30분을 쉬었다 — 딜 30개가 수십 초 만에
      // 팔린 판이라, 그 뒤 취소분이 풀렸어도 못 봤을 것이다. 품절로 적어 두면 API 가 다시
      // 판다고 하는 순간이 곧 "바뀌는 순간" 이 되어 바로 다시 간다.
      delete entry.last_try_at;
      entry.status = SOLDOUT;
      log.warn(`[${key}] 한발 늦었습니다 — ${got.reason}`);
      log.info(`   쉬지 않고 다음 재입고를 봅니다 (잇달아 진 것 ${lost}/${LOST_RACE_LIMIT})`);
      await notifyBlocked(cfg, target, `한발 늦었습니다 — ${got.reason}`);
      return { bought: false, note: `${name} — 한발 늦음, 다시 봅니다` };
    }
    log.warn(`[${key}] ${lost}번 잇달아 품절로 막혔습니다 — API 판정이 사이트와 어긋나는 것 같아 쉽니다`);
    delete entry.lost_races;
  }

  if (!got.ok) {
    entry.blocked = got.reason ?? undefined;
    log.warn(`[${key}] 주문서를 못 열었습니다 — ${got.reason}`);
    await notifyBlocked(cfg, target, `주문서를 못 열었습니다 — ${got.reason}`);
    return { bought: false, note: `${name} — 주문서를 못 열었습니다` };
  }

  counters.bought += 1;
  delete entry.lost_races;
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

/** 상품마다 마지막으로 적은 판정 근거. */
const LAST_WHY = new Map<string, string>();

/**
 * 판정 근거(단품·상품 상태, 딜 남은 수)가 바뀔 때마다 한 줄 적는다.
 *
 * 2026-09-26 MEGA 30th 드랍은 10:00:00 에 열렸는데 우리가 "구매 가능" 을 본 것은 10:01:15
 * 였다. 그 75초 동안 API 가 무엇이라 했는지 남은 것이 없어서, 늦게 연 것이 API 인지 우리
 * 인지 가릴 수 없었다. 품절→구매가능 같은 **바뀜**만 적으면 거기서 끊긴다 — 근거를 적는다.
 * 드랍 중에는 딜 남은 수가 바뀔 때마다 한 줄이 된다. 그게 곧 소진 속도다.
 */
function sayWhyChanged(target: Target, info: StockInfo): void {
  const why = `${STATUS_LABEL[info.status]} ← ${info.raw_status}`;
  if (LAST_WHY.get(target.key) === why) return;
  LAST_WHY.set(target.key, why);
  log.info(`[${target.key}] 판정 ${why}`);
}

/** 드랍 모드에서도 이 밑으로는 안 내린다(초). 0 을 적어도 헛돌지 않게 하는 바닥이다. */
const DROP_FLOOR = 0.5;

interface Pace {
  drop: boolean;
  interval: number;
  jitter: number;
  /** 이번 바퀴에 쓸 설정. 드랍 모드면 쉬는 시간을 걷어 낸 사본이다. */
  cfg: Config;
}

/**
 * 이번 바퀴의 걸음. 드랍 모드면 빠르게, 아니면 설정대로.
 *
 * 드랍 모드에서 걷어 내는 것:
 *   조회 간격·흔들림   drop_interval_seconds·drop_jitter_seconds 로
 *   다시 해보기 전 쉼  retry_delay_seconds → 0 (조회도, 크롬으로 사는 것도)
 *   실패 뒤 쉬는 시간  cooldown_minutes → 0 — 드랍 중에 30분 쉬면 그 드랍은 끝이다
 */
function paceOf(cfg: Config, normal = false): Pace {
  if (!normal && run.drop) {
    return {
      drop: true,
      interval: Math.max(DROP_FLOOR, Number(cfg.drop_interval_seconds ?? 1)),
      jitter: Math.max(0, Number(cfg.drop_jitter_seconds ?? 0.2)),
      cfg: { ...cfg, retry_delay_seconds: 0, cooldown_minutes: 0 },
    };
  }
  const floor = cfg.min_interval_seconds ?? 5;
  return {
    drop: false,
    interval: Math.max(floor, cfg.poll_interval_seconds ?? 15),
    jitter: cfg.poll_jitter_seconds ?? 4,
    cfg,
  };
}

export async function watch(cfg: Config, s: Session, state: State, once: boolean): Promise<void> {
  let entries = targetsOf(cfg);
  if (!entries.length) {
    throw new Error(`${basename(CONFIG_PATH)} 의 targets 가 비어 있습니다. --add 로 상품을 넣어주세요.`);
  }
  let known = JSON.stringify(cfg.targets ?? []);

  const usual = paceOf(cfg, true);
  const pace = paceOf(cfg);
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

  UI.banner("LOTTE ON · 테스트", [
    who,
    pace.drop
      ? `감시 ${entries.length}개 · 드랍 모드 ${pace.interval}초 주기 (±${pace.jitter}) · 최대 ${limit}개`
      : `감시 ${entries.length}개 · ${usual.interval}초 주기 (±${usual.jitter}) · 최대 ${limit}개`,
    ...(pace.drop ? ["드랍 모드: 다시 해보기 전 쉼 0초 · 실패해도 쉬지 않습니다"] : []),
    cfg.buy_on_restock_only ? "품절 → 구매가능 으로 바뀔 때만 삽니다" : "재고가 있으면 바로 삽니다",
    arrivalLine(cfg),
    "테스트 판 · lotteon_test_* 에 적습니다 (본판은 안 건드립니다)",
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

    const readings = await readAll(pace.cfg, s, entries);
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
      sayWhyChanged(target, reading.info);
      // 크롬 창을 상품 페이지에 띄워 둔다. 열리는 시각을 알면 그 전에 대기열에도 세운다.
      // 뒤에서 따로 돈다 (warm.ts). 한 번만 보고 끝나는 판·이미 산 것은 띄우지 않는다.
      if (!once && !entryOf(state, target.key).done) {
        planWarm(pace.cfg, target, reading.info.opens_at ?? "", run.dryRun);
      }
      try {
        notes.push((await handleTarget(pace.cfg, state, target, reading.info, counters)).note);
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
    // 드랍 모드라도 조회가 실패한 바퀴 뒤에는 평소 걸음으로 한 번 쉰다. 봇 차단에 걸려
    // 실패하는 것이면, 1초마다 더 두드리는 것은 차단을 굳히는 일이다.
    const failed = readings.some((one) => "error" in one);
    let step = pace.drop && failed ? usual : pace;
    if (pace.drop && failed) log.warn(`드랍 모드지만 조회가 실패해 이번만 ${usual.interval}초 쉽니다`);
    // 열리는 시각을 아는 상품은 그 둘레(1분 전 ~ 2분 뒤)만 드랍 걸음으로 본다 — 평소 걸음(15초)이면
    // 열린 것을 최대 15초 늦게 안다. 열리는 순간이 걸음 안에 들면 그 순간에 맞춰 깬다.
    if (!failed && nearOpening()) {
      let interval = Math.min(step.interval, Math.max(DROP_FLOOR, Number(cfg.drop_interval_seconds ?? 1)));
      const until = msToOpening();
      if (until !== null && until / 1000 < interval) interval = Math.max(0.05, until / 1000 + 0.05);
      step = { ...step, interval, jitter: 0 };
    }
    await wait(step.interval + Math.random() * step.jitter, watching(notes), () => {
      // **--link 로 정한 상품은 파일을 따라가지 않는다.** 따라가면 메모리의 대상(링크한 것)과
      // 파일의 대상이 달라 "설정이 바뀌었다" 로 읽고, 0.25초 만에 파일의 상품으로 바꿔쳤다
      // (2026-09-26 — 로켓단을 링크했는데 잔망루피를 사러 갔다. dry-run 이라 다행이었다).
      if (run.linked) return false;
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
