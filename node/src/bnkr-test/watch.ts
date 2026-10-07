/**
 * 감시 루프. bnkr_buy.py 의 watch()/handle_target 과 같은 판단을 한다.
 *
 *   지켜보기 → 구매 가능 감지 → 장바구니 담기 → 디스코드 알림 + 주문서 열기 → [사람] 결제
 *
 * 결제 확정 버튼은 사람이 누른다. 로그인도 자동화하지 않는다(reCAPTCHA v3).
 */
import {
  configStamp, cookieOf, loadConfig, saveState, type Config, type State, type TargetEntry,
} from "./config.js";
import { newSession, Session, SiteError } from "./http.js";
import { QueueWait } from "./queue.js";
import { log, sayOk, sayStar, sayStep, tick } from "./log.js";
import { UI } from "./ui.js";
import { blockingReason, doCart, retrying } from "./cart.js";
import { notifyBlocked, notifyCarted, notifyFound, notifyQueue, notifySession } from "./notify.js";
import { openLanding, pgSteps, preheatBrowser } from "./landing.js";
import { listItems, parseWatch, watchKey, watchLabel, type Listed, type Watch } from "./list.js";
import {
  fetchStock, goodsMeta, IN_STOCK, LANDING_LABEL, loginInfo, SOLDOUT, tokenLeft,
  type Status, type Stock,
} from "./site.js";
import { activeTargets, parseTarget, targetsOf, type Target } from "./targets.js";
import { nowStamp, pool, priceText, wait } from "./util.js";
import type { DiscoverSpec } from "./config.js";

/**
 * 설정에 적힌 목록들 → (감시할 목록, 그 목록에서 담을 조건).
 * 목록을 읽고 훑는 방법은 재고 감시 쪽과 같다. 같은 것을 두 벌 짜면 사이트가 바뀔 때
 * 한 쪽만 고치게 된다.
 */
function discoveryWatches(cfg: Config): [Watch, DiscoverSpec][] {
  const out: [Watch, DiscoverSpec][] = [];
  for (const entry of cfg.discover ?? []) {
    const spec: DiscoverSpec = typeof entry === "object" && entry !== null ? entry : { url: String(entry) };
    const watch = parseWatch({ url: spec.url || spec.keyword || spec.sword || "", contains: spec.contains });
    if (!watch) {
      log.warn(`훑어볼 목록을 알아보지 못했습니다: ${JSON.stringify(entry)}`);
      continue;
    }
    out.push([watch, spec]);
  }
  return out;
}

/**
 * 목록을 훑어 새로 올라온 상품을 감시 대상에 넣는다. → 새로 넣은 것들
 *
 * 드랍 날짜만 알고 상품 주소는 모를 때 쓰는 길이다. 새 상품은 올라오기 전에 번호가
 * 없으니 미리 적어 둘 수가 없고, 목록에 올라오는 순간을 잡는 수밖에 없다.
 *
 * **처음 훑을 때 보이던 것들은 기준선이다.** 그때 보이는 것을 전부 새 상품으로 치면
 * 켜자마자 진열대에 있던 것을 사게 된다. 그 뒤에 나타난 것만 새것이다. 기준선은 상태
 * 파일에 남긴다 — 껐다 켜도 어제 있던 것이 오늘 새 상품이 되지 않는다.
 */
export async function discover(
  cfg: Config, s: Session, state: State, entries: Target[],
): Promise<Listed[]> {
  const known = new Set(entries.map((t) => t.gno));
  const baseline = (state.discovered ??= {});
  const added: Listed[] = [];

  // **받아 오는 일만 동시에 한다.** 목록 한 장이 150KB 라 곳이 여럿이면 순차로는
  // 곳당 55ms 가 그대로 쌓인다. 판단(기준선 비교·감시에 넣기)은 아래에서 순서대로 —
  // 그래야 로그가 적어 둔 순서대로 나오고, 같은 상품이 두 목록에 걸쳐 있어도 한 번만 든다.
  const watches = discoveryWatches(cfg);
  const fetched = await pool(watches, Math.max(1, Number(cfg.max_concurrency || 1)),
    async ([watch, spec]) => {
      try {
        return { watch, spec, items: await listItems(s, watch, spec), error: null as unknown };
      } catch (e) {
        return { watch, spec, items: [] as Listed[], error: e as unknown };
      }
    });

  for (const { watch, spec, items, error } of fetched) {
    if (error) {
      if (error instanceof QueueWait) throw error;
      log.warn(`목록을 훑지 못했습니다 (${watchLabel(watch)}): ${(error as Error).message}`);
      continue;
    }
    const key = watchKey(watch);

    const now: Record<string, string> = {};
    for (const item of items) now[item.gno] = item.status;
    const was = baseline[key];
    if (was === undefined) {
      baseline[key] = now;
      const out = Object.values(now).filter((st) => st === SOLDOUT).length;
      sayStep(`목록을 기준선으로 잡았습니다 — ${watchLabel(watch)} · ${items.length}개 (품절 ${out}) ` +
        "· 새로 올라오거나 품절이 풀리는 것을 노립니다");
      continue;
    }

    for (const item of items) {
      const before = was[item.gno];
      was[item.gno] = item.status;

      // 두 가지를 노린다. 어느 쪽이든 "이제 살 수 있게 된 것" 이다.
      //
      //   처음 보는 상품   — 오늘 올라온 것
      //   품절 → 구매가능  — 어제 올라와 오늘 열린 것
      //
      // 앞엣것만 보면 안 된다. 드랍 상품은 대개 하루 이틀 전에 등록만 해 두고 시간이
      // 되면 판매를 여는데, 그러면 켤 때 이미 목록에 있어서 새것이 아니다.
      let why: string;
      if (before === undefined) why = "새 상품이 올라왔습니다";
      else if (before === SOLDOUT && item.status === IN_STOCK) why = "품절이 풀렸습니다";
      else continue;

      if (known.has(item.gno)) continue;

      const target = parseTarget({
        gno: item.gno,
        ea: spec.ea ?? 1,
        mode: spec.mode ?? "DIRECT",
        max_price: spec.max_price ?? 0,
        label: item.name,
      });
      if (!target) continue;

      known.add(item.gno);
      entries.push(target);
      added.push(item);
      sayStar(`${why} — [${item.gno}] ${item.name} · ${priceText(item.price)}`);
      await notifyFound(cfg, item, target, why);
    }
  }
  return added;
}

/**
 * 대기열에 걸렸다. 두드리지 말고 자리를 지킨다.
 *
 * 여기서 하는 일은 **기다리는 것뿐**이다. 세션을 새로 만들지 않고(줄에서 나가는 짓),
 * 쿠키도 다시 심지 않고, 주기를 당기지도 않는다.
 */
async function holdForQueue(cfg: Config, waiting: QueueWait): Promise<void> {
  const seconds = Math.max(1, Number(cfg.queue_wait_seconds || 10));
  log.warn(`${waiting.message} — 자리를 지키며 기다립니다`);
  await notifyQueue(cfg, waiting.message);
  await wait(seconds, "대기열");
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

interface Counters { carted: number }

/**
 * 한 상품을 **보기만** 한다. → 담을 일이 생겼으면 그 사실, 아니면 null
 *
 * 담지 않는 이유는 이것이 여럿과 동시에 도는 자리이기 때문이다. 조회는 113바이트짜리라
 * 동시에 해도 되지만, 담기는 그렇지 않다 — 계정이 하나고 수량 제한도 계정당이라 여럿이
 * 동시에 두드릴 이유가 없고, 크롬은 한 창이 한 주문서를 연다. 그래서 여기서는 판단에
 * 필요한 것만 모아 오고, 실제로 담는 일은 부른 쪽이 한 줄로 세워서 한다.
 */
async function checkTarget(
  cfg: Config, s: Session, state: State, target: Target,
): Promise<Reading | null> {
  const gno = target.gno;
  const targets = (state.targets ??= {});
  const entry = (targets[gno] ??= {});
  const now = new Date();

  if (entry.done) return null;

  // 담기까지는 됐는데 주문서에서 어긋난 물건. 다시 담으면 두 개가 되므로 담지 않고,
  // 주문서 여는 것만 다시 해본다. 담긴 것은 이미 장바구니에 있다.
  if (entry.carted_at && !entry.landed) return { kind: "reopen", target, entry };

  if (onCooldown(entry, now, cfg.cooldown_minutes)) return null;

  const stock = await retrying(cfg, `[${gno}] 재고 조회`, () => fetchStock(s, gno));
  // 이름은 재고 조회로는 알 수 없다. 상품마다 한 번만 상세를 받아 캐시해 둔다.
  const meta = await goodsMeta(s, state, gno);
  const name = target.label || meta.name;
  entry.name = name;

  // 직전에 어땠는지 기억해 둔다. "바뀌는 순간" 을 알려면 이것이 있어야 한다.
  const was = entry.status;
  const status: Status = stock.stock > 0 ? IN_STOCK : SOLDOUT;
  entry.status = status;
  entry.stock = stock.stock;

  if (status === SOLDOUT) {
    if (was === IN_STOCK) log.info(`[${gno}] ${name} — 품절로 바뀌었습니다`);
    else tick(`${name} — 품절`);
    // 노는 시간에 상세를 새로 받아 둔다. 재고가 열린 뒤에 받으면 그만큼 늦는다.
    await goodsMeta(s, state, gno, { maxAge: cfg.meta_fresh_seconds ?? 60 });
    return null;
  }

  // 품절 → 구매가능 으로 **바뀌는 순간**에만 담는다.
  //
  // 처음 본 것도 담지 않는다. 감시를 켤 때 이미 팔고 있던 물건은 노리던 것이 아니고,
  // 설정을 잘못 써 놓고 실행했을 때 곧장 결제창까지 가버리는 사고도 여기서 막힌다.
  if (cfg.buy_on_restock_only && was !== SOLDOUT) {
    if (was === undefined) {
      log.info(`[${gno}] ${name} — 이미 판매 중입니다. 품절됐다가 다시 열릴 때 담습니다`);
    } else {
      tick(`${name} — 계속 판매 중 (기다립니다)`);
    }
    return null;
  }

  return { kind: "cart", target, entry, stock, name };
}

/** 보고 온 것 하나. 담을 것과 "담긴 것으로 주문서만 다시 열 것" 은 하는 일이 다르다. */
type Reading =
  | { kind: "reopen"; target: Target; entry: TargetEntry }
  | { kind: "cart"; target: Target; entry: TargetEntry; stock: Stock; name: string };

/**
 * 보고 온 것 하나를 처리한다. **여기는 늘 한 줄이다.** → 담았으면 true
 *
 * 담기·주문서·결제창은 동시에 돌리지 않는다. 같은 계정으로 같은 것을 두 번 담으면 두
 * 개가 되고, 크롬 프로필 하나는 크롬 하나만 쓴다.
 */
async function cartOne(
  cfg: Config, s: Session, state: State, reading: Reading, counters: Counters,
): Promise<boolean> {
  const { target, entry } = reading;
  const gno = target.gno;
  const now = new Date();

  if (reading.kind === "reopen") {
    sayStep(`[${gno}] ${entry.name || gno} — 담긴 것으로 ${LANDING_LABEL[target.mode]} 을(를) 다시 시도합니다`);
    if (await openLanding(cfg, target.mode, s, { gno, name: entry.name || gno })) {
      entry.landed = true;
      entry.done = !!cfg.stop_after_success;
    }
    return false;
  }

  const { stock, name } = reading;
  sayOk(`[${gno}] ${name} — 재고 ${stock.stock}개, 담습니다 (${target.mode} ×${target.ea})`);

  // 담기에 쓸 사은품·옵션 정보는 신선해야 한다. 다만 **지금** 받을 필요는 없다 —
  // 지켜보는 동안 이미 새로 받아 뒀으면 그걸 쓴다.
  //
  // **캐시가 "품절" 이라고 말하면 그건 낡은 것이다.** 방금 재고 조회가 아니라고 했으니
  // 둘 중 하나는 틀렸고, 틀린 쪽은 늘 캐시다. 그대로 쓰면 마지막 관문에서 우리 손으로
  // 막고, last_try_at 이 이미 찍혀 쿨다운까지 걸린다. 기다리던 그 판이 통째로 날아간다.
  const cached = (state.goods?.[gno] ?? {}) as { status?: string };
  const meta = await goodsMeta(s, state, gno, {
    refresh: cached.status === SOLDOUT,
    maxAge: cfg.meta_fresh_seconds ?? 60,
  });
  entry.last_try_at = nowStamp(now);

  const reason = blockingReason(cfg, target, meta, stock);
  if (reason) {
    log.warn(`[${gno}] 담지 않습니다 — ${reason}`);
    entry.blocked = reason;
    await notifyBlocked(cfg, { ...meta, name }, reason);
    return false;
  }

  const got = await doCart(cfg, s, meta, target.mode, target.ea);
  // 수량 제한에 걸려 낮춰 담았으면 그 수를 기억한다. 다음에 또 2개로 두드려 봐야 같은
  // 소리를 들을 뿐이고, 그 한 번이 재고가 열린 직후에 들어간다.
  if (got.ea !== target.ea) {
    log.info(`[${gno}] 수량을 ${got.ea}개로 맞췄습니다 (요청 ${target.ea}개)`);
    target.ea = got.ea;
  }
  if (!got.ok) {
    entry.blocked = got.reason;
    await notifyBlocked(cfg, { ...meta, name }, got.reason);
    return false;
  }

  delete entry.blocked;
  entry.carted_at = nowStamp(now);
  counters.carted += 1;

  await notifyCarted(cfg, { ...meta, name }, target.mode, got.ea, stock.price - stock.event_discount);

  // 담긴 것과 주문서까지 간 것은 다르다. 나눠서 적어 둬야 다음 바퀴에 무엇을 다시 해야
  // 할지 알 수 있다 — 담기를 또 하면 두 개가 되고, 주문서는 다시 열어도 그만이다.
  const landed = await openLanding(cfg, target.mode, s, { ...meta, name });
  entry.landed = landed;
  if (landed) entry.done = !!cfg.stop_after_success;
  else {
    log.warn(`[${gno}] 담기는 됐지만 ${LANDING_LABEL[target.mode]} 은(는) 못 끝냈습니다. ` +
      "다음 바퀴에 다시 해봅니다");
  }
  return true;
}

interface Sweep {
  /** 손댈 것이 생긴 것들. 넣은 순서 그대로다. */
  readings: Reading[];
  /** 조회하다 터진 것들. 대기열은 따로 가려낸다 — 그건 고장이 아니라 지시다. */
  errors: { target: Target; error: unknown }[];
  /** 탈 없이 본 개수. 하나라도 있으면 연속 실패는 끊긴 것이다. */
  ok: number;
}

/**
 * 감시 대상을 **동시에** 본다. 한 번에 max_concurrency 개까지.
 *
 * 순차로 돌면 감시 대상 하나마다 왕복 한 번이 순서대로 붙는다 — 50개면 한 바퀴에
 * 1.4초다. 재고 조회는 113바이트짜리 ajax 라 동시에 해도 사이트에 얹히는 무게가 같고,
 * 우리 쪽 파싱은 거의 없다. 여기가 동시성이 값어치를 하는 유일한 자리다.
 *
 * **담지는 않는다.** 무엇을 담아야 하는지만 모아서 돌려주고, 담는 것은 부른 쪽이 한
 * 줄로 한다. 한 아이피에서 동시에 두드리는 횟수이기도 하므로 값을 올린다고 계속
 * 빨라지지 않는다.
 */
async function sweep(
  cfg: Config, s: Session, state: State, entries: Target[],
): Promise<Sweep> {
  const limit = Math.max(1, Number(cfg.max_concurrency || 1));
  const got = await pool(entries, limit, async (target) => {
    try {
      return { target, reading: await checkTarget(cfg, s, state, target), error: null as unknown };
    } catch (error) {
      return { target, reading: null as Reading | null, error: error as unknown };
    }
  });

  const out: Sweep = { readings: [], errors: [], ok: 0 };
  for (const { target, reading, error } of got) {
    if (error) out.errors.push({ target, error });
    else {
      out.ok += 1;
      if (reading) out.readings.push(reading);
    }
  }
  return out;
}

/** 세션이 끊기면 담을 수 없다. 조용히 계속 도는 것보다 알리고 멈추는 게 낫다. */
export async function sessionAlive(cfg: Config, s: Session): Promise<boolean> {
  let info;
  try {
    info = await loginInfo(s);
  } catch (e) {
    if (!(e instanceof SiteError)) throw e;
    // 확인에 실패한 것과 로그아웃된 것은 다르다. 확인이 안 된다고 감시를 접지 않는다.
    log.warn(`세션 확인 실패 (계속 진행): ${e.message}`);
    return true;
  }

  if (info.no) {
    const left = tokenLeft(s);
    if (left === null) sayOk(`세션 확인됨 — ${info.name} 님`);
    else if (left < 15) {
      log.warn(`세션 확인됨 — 토큰이 ${left}분 남았습니다. 갱신이 안 되고 있는 것 같으니 ` +
        "쿠키를 다시 넣을 준비를 해주세요");
    } else sayOk(`세션 확인됨 — 토큰 ${left}분 남음`);
    return true;
  }

  log.error("로그인 세션이 끊겼습니다. 담기를 멈춥니다. --cookie 로 다시 넣어주세요");
  await notifySession(cfg);
  return false;
}

/**
 * 돌아가는 중에 설정이 바뀌면 갈아 끼운다. → [cfg, entries, session]
 *
 * 감시를 멈추고 다시 켜지 않아도 상품을 넣고 뺄 수 있게 한다. 재고를 기다리는 일은 본래
 * 오래 걸리는데, 그때마다 껐다 켜면 기다리던 시간이 날아간다.
 *
 * 파일을 고치는 도중에 읽을 수도 있다. 반쯤 쓰인 것을 붙들고 무너지느니 이번 바퀴는
 * 쓰던 설정으로 돌고 다음 바퀴에 다시 본다.
 */
export async function reloadConfig(
  cfg: Config, entries: Target[], s: Session, state: State,
): Promise<[Config, Target[], Session]> {
  let fresh: Config;
  try {
    fresh = loadConfig();
  } catch (e) {
    log.warn(`설정을 다시 읽지 못했습니다 (${(e as Error).message}). 쓰던 설정으로 계속합니다`);
    return [cfg, entries, s];
  }

  const freshEntries = activeTargets(fresh);
  if (!freshEntries.length && !targetsOf(fresh).length) {
    log.warn("바뀐 설정에 상품이 없습니다. 쓰던 목록을 지킵니다");
    return [cfg, entries, s];
  }

  const before = new Set(entries.map((t) => t.gno));
  const after = new Set(freshEntries.map((t) => t.gno));

  // 예전에 담았던 기록을 지우고 다시 지켜보게 한다.
  //
  // 설정에 새로 적어 넣거나 **고친** 것은 "이것을 지켜봐라" 는 지시다. 지난번에
  // 담았다는 이유로 그 지시를 조용히 무시하면, 상품을 바꿔 넣었는데 아무 일도 안
  // 일어나고 "담을 상품이 모두 끝났습니다" 로 꺼져 버린다. 사람이 방금 한 말이 더
  // 새롭다.
  const clearRecord = (gno: string): void => {
    const entry = state.targets?.[gno];
    if (entry && (entry.done || entry.carted_at)) {
      sayStep(`  [${gno}] 이전에 담았던 기록(${entry.carted_at || "시각 미상"})을 지우고 다시 지켜봅니다`);
      for (const key of ["done", "carted_at", "landed", "blocked", "last_try_at", "status"] as const) {
        delete entry[key];
      }
    }
  };

  let changed = false;
  for (const gno of [...after].filter((g) => !before.has(g)).sort()) {
    const label = freshEntries.find((t) => t.gno === gno)?.label;
    sayOk(`설정이 바뀌었습니다 — [${gno}] ${label || "새 상품"} 추가`);
    clearRecord(gno);
    changed = true;
  }

  // 같은 gno 여도 **옵션을 고쳤으면** 다시 지켜본다. 수량·주문 방식·가격 상한·이름을
  // 바꿔 놓고 담았던 기록에 가로막히면, 재고가 있어도 아무 일도 안 일어난다.
  const oldMap = new Map(entries.map((t) => [t.gno, t]));
  for (const fresh of freshEntries) {
    const old = oldMap.get(fresh.gno);
    if (!old) continue;
    if (old.ea !== fresh.ea || old.mode !== fresh.mode ||
        old.max_price !== fresh.max_price || old.label !== fresh.label) {
      sayOk(`설정이 바뀌었습니다 — [${fresh.gno}] 옵션을 고쳤습니다. 다시 지켜봅니다`);
      clearRecord(fresh.gno);
      changed = true;
    }
  }

  for (const gno of [...before].filter((g) => !after.has(g)).sort()) {
    sayStep(`설정이 바뀌었습니다 — [${gno}] ${state.targets?.[gno]?.name ?? ""} 뺌`);
    changed = true;
  }
  if (!changed) {
    log.info("설정이 바뀌었습니다 — 상품 목록은 그대로입니다");
  }

  // 쿠키가 바뀌었으면 세션을 새로 만든다. 돌아가는 중에 --cookie 로 넣을 수 있게 하려는
  // 것이다 — 한 시간마다 껐다 켜는 것이 이 스크립트의 가장 큰 불편이었다.
  if (cookieOf(fresh) !== cookieOf(cfg)) {
    sayOk("쿠키가 바뀌었습니다 — 세션을 새로 만듭니다");
    s = await newSession(cookieOf(fresh), {
      queueWatch: fresh.queue_watch, queueMarkers: fresh.queue_markers,
    });
  }

  return [fresh, freshEntries, s];
}

export async function watch(
  cfg: Config, s: Session, state: State, once: boolean, dryRun: boolean,
): Promise<void> {
  let entries = activeTargets(cfg);
  // discover 를 켜 두었으면 지금 비어 있어도 된다. 그게 이 기능의 요점이다 — 아직
  // 올라오지 않은 상품을 기다리는 중이라 적어 둘 번호가 없다.
  if (!entries.length && !(cfg.discover ?? []).length) {
    const total = targetsOf(cfg).length;
    throw new Error(
      total
        ? `All ${total} tasks are paused. Run "task resume <gno>" or add a discover entry.`
        : "bnkr_test_config.json 의 targets 가 비어 있습니다. " +
          "task add 로 상품을 넣거나 discover 에 훑을 목록을 적어주세요.",
    );
  }
  {
    const paused = targetsOf(cfg).length - entries.length;
    if (paused > 0) log.info(`${paused} paused task(s) skipped — see "task list"`);
  }

  // 지켜볼 것이 하나도 없으면 **크롬을 띄우기 전에** 끝낸다. 전에는 크롬을 띄우고 사전 로그인까지 한 뒤에야
  // 첫 바퀴에서 "모두 끝났습니다" 로 끝나서, 로그인된 창만 남고 멈춘 것처럼 보였다 (2026-10-07 — --buy 로 산
  // 기록이 남은 상품을 지켜보기로 켰다). 기록을 지우지는 않는다 — 산 것을 또 사게 된다.
  const pending = entries.filter((t) => !state.targets?.[t.gno]?.done);
  if (!pending.length && !(cfg.discover ?? []).length) {
    for (const t of entries) {
      const e = state.targets?.[t.gno];
      log.warn(`[${t.gno}] ${t.label || e?.name || ""} — 이미 담은 기록이 있습니다 (${e?.carted_at || "시각 미상"}). ` +
        "지켜볼 것이 없어 크롬을 띄우지 않고 끝냅니다");
    }
    log.warn("다시 지켜보려면 담은 기록을 지우세요 — --reset (데스크톱 앱: 로그 패널의 '산 기록 지우기')");
    return;
  }

  let limit = cfg.max_carts_per_run ?? 5;
  let checkEvery = cfg.session_check_minutes ?? 10;
  let stamp = configStamp();
  const counters: Counters = { carted: 0 };
  let fails = 0;

  let checkedAt: number | null = null;
  let who = "[dry-run] 쿠키 없이 재고만 봅니다";
  if (!dryRun) {
    const info = await loginInfo(s);
    if (!info.no) throw new Error("로그인 세션이 아닙니다. --cookie 로 쿠키를 다시 넣어주세요.");
    const left = tokenLeft(s);
    who = `${info.name} 님` +
      (info.level ? ` [${info.level}]` : "") +
      ` · 장바구니 ${info.cart_size}개` +
      // 토큰이 몇 분 남았는지 처음부터 보여 준다. 이 숫자가 확인할 때마다 60 근처로
      // 돌아오면 갱신되는 것이고, 계속 줄면 한 시간이 시한이다.
      (left !== null ? ` · 토큰 ${left}분` : "");
    checkedAt = Date.now();
  }

  // 훑어서 찾아낼 것들의 mode 도 함께 센다. 지금 대상이 없다고 "장바구니까지만" 이라고
  // 적으면, 정작 찾아낸 뒤에는 결제창까지 가는데 화면은 딴소리를 하고 있게 된다.
  const modes = new Set(entries.map((t) => t.mode as string));
  for (const d of cfg.discover ?? []) {
    modes.add(String((typeof d === "object" && d !== null ? d.mode : null) || "DIRECT").toUpperCase());
  }
  UI.banner("BNKR", [
    who,
    `감시 ${entries.length}개 · ${cfg.poll_interval_seconds ?? 15}초 주기 ` +
      `(±${cfg.poll_jitter_seconds ?? 4}) · 최대 ${limit}개 · 설정은 실시간 반영`,
    cfg.buy_on_restock_only ? "품절 → 구매가능 으로 바뀔 때만 담습니다" : "재고가 있으면 바로 담습니다",
    // 동시성이 실제로 일하는 자리는 조회뿐이다. 담기까지 여럿이 도는 줄 알면 곤란하다.
    Number(cfg.max_concurrency || 1) > 1 && entries.length > 1
      ? `한 번에 ${Math.min(Number(cfg.max_concurrency), entries.length)}개씩 봅니다 ` +
        "· 담기·주문서·결제는 한 줄로"
      : null,
    (cfg.discover ?? []).length
      ? `목록 ${(cfg.discover ?? []).length}곳을 ${cfg.discover_interval_seconds ?? 15}초마다 훑습니다 ` +
        "— 새 상품·품절 해제를 잡으면 감시에 넣습니다"
      : null,
    modes.has("DIRECT") && cfg.order_action === "submit"
      ? "결제창까지 갑니다 (" + pgSteps(cfg).join("·") + ")"
      : "장바구니까지만 담습니다",
    // 창이 안 보이면 사람은 안 뜬 줄 안다. 어디 있는지 먼저 말해 둔다.
    cfg.browser_offscreen && !cfg.browser_headless
      ? "크롬은 화면 밖에서 돕니다 — 진행 상황은 여기 콘솔에 나옵니다"
      : null,
    "Node.js/TypeScript 판 · 결제 확정은 사람이 누릅니다",
  ].filter((line): line is string => !!line));

  for (const target of entries) {
    const known = state.targets?.[target.gno]?.name;
    const label = target.label || known || "이름은 첫 조회에서";
    log.info(`[${target.gno}] ${label} ×${target.ea} · ${target.mode}`);
  }

  await preheatBrowser(cfg);
  let lookedAt = 0;

  for (;;) {
    // **보기 전에 갈아 끼운다.** 반영을 한 바퀴 뒤로 미루면, 상품을 바꿔 놓고도 예전
    // 것을 한 번 더 확인한 다음에야 새 것을 본다. 그 사이가 주기만큼 뜬다.
    const freshStamp = configStamp();
    if (freshStamp !== stamp) {
      stamp = freshStamp;
      [cfg, entries, s] = await reloadConfig(cfg, entries, s, state);
      limit = cfg.max_carts_per_run ?? 5;
      checkEvery = cfg.session_check_minutes ?? 10;
    }

    // 아직 주소를 모르는 상품을 기다리는 중이면 목록을 훑는다. 재고 조회와 주기를 따로
    // 두는 이유는 무게가 1000배 넘게 차이 나기 때문이다 — 목록 한 장이 150KB, 재고 조회
    // 한 방이 113바이트다.
    const every = (cfg.discover_interval_seconds ?? 15) * 1000;
    if ((cfg.discover ?? []).length && Date.now() - lookedAt >= every) {
      lookedAt = Date.now();
      try {
        await discover(cfg, s, state, entries);
      } catch (e) {
        if (e instanceof QueueWait) await holdForQueue(cfg, e);
        else log.warn(`목록을 훑다 실패 (계속 진행): ${(e as Error).message}`);
      }
    }

    // 보는 일은 한꺼번에, 손대는 일은 한 줄로.
    const looked = await sweep(cfg, s, state, entries);

    if (looked.ok) fails = 0;
    let queued: QueueWait | null = null;
    for (const { target, error } of looked.errors) {
      if (error instanceof QueueWait) {
        // 실패로 세지 않는다. 세면 세션을 새로 만들게 되고, 그건 줄을 섰다가 스스로
        // 나가서 맨 뒤로 가는 짓이다. 동시에 봤으니 여럿이 같은 줄에 걸렸을 텐데,
        // 그럴수록 기다림은 **한 번만** 한다 — 걸린 수만큼 기다릴 일이 아니다.
        queued = error;
      } else if (error instanceof SiteError) {
        fails += 1;
        log.warn(`[${target.gno}] 조회 실패 (${fails}회 연속): ${error.message}`);
      } else {
        fails += 1;
        log.error(`[${target.gno}] 오류 (${fails}회 연속): ${(error as Error).stack || error}`);
      }
    }
    if (queued) await holdForQueue(cfg, queued);

    for (const reading of looked.readings) {
      try {
        await cartOne(cfg, s, state, reading, counters);
      } catch (e) {
        if (e instanceof QueueWait) await holdForQueue(cfg, e);
        else if (e instanceof SiteError) log.warn(`[${reading.target.gno}] 담기 실패: ${e.message}`);
        else log.error(`[${reading.target.gno}] 오류: ${(e as Error).stack || e}`);
      }

      if (counters.carted >= limit) {
        log.info(`한 번 실행에서 담을 수 있는 최대치(${limit}개)에 닿았습니다. 종료합니다.`);
        saveState(state);
        return;
      }
    }

    saveState(state);

    const remaining = entries.filter((t) => !state.targets?.[t.gno]?.done);
    // 훑을 목록이 있으면 지금 남은 것이 없다고 끝내지 않는다. 기다리는 상품이 아직 안
    // 올라온 것뿐이고, 그걸 기다리려고 켜 둔 것이다.
    if (!remaining.length && !(cfg.discover ?? []).length) {
      log.info("담을 상품이 모두 끝났습니다. 종료합니다.");
      return;
    }
    if (once) return;

    if (fails >= 3) {
      // 계속 실패하면 세션부터 의심한다. 같은 속도로 두드려 봐야 소용없다.
      log.warn(`연속 실패가 ${fails}회입니다. 세션을 새로 만듭니다.`);
      s = await newSession(cookieOf(cfg), {
        queueWatch: cfg.queue_watch, queueMarkers: cfg.queue_markers,
      });
      await wait(Math.min(300, 30 * fails), "쉬는 중");
    }

    // 빌려온 세션은 한 시간이면 만료된다. 끊긴 줄 모르고 도는 게 제일 나쁘다.
    if (checkedAt && checkEvery && Date.now() - checkedAt >= checkEvery * 60_000) {
      if (!(await sessionAlive(cfg, s))) return;
      checkedAt = Date.now();
    }

    // 주기도 설정에서 매번 읽는다. 돌아가는 중에 바꿔도 다음 바퀴부터 먹힌다.
    const interval = cfg.poll_interval_seconds ?? 15;
    const jitter = cfg.poll_jitter_seconds ?? 4;

    // 기다리는 도중에 설정이 바뀌면 기다림을 접는다. 남은 시간을 다 채우고 나서야 새
    // 상품을 보면, 바꿔 놓고 최대 한 주기를 놓치는 셈이다.
    const woke = await wait(
      Math.max(3, interval + (Math.random() * 2 - 1) * jitter),
      `지켜보는 중 · ${remaining.length}개`,
      () => configStamp() !== stamp,
    );
    if (woke) sayOk("설정이 바뀌었습니다 — 기다리지 않고 바로 확인합니다");
  }
}
