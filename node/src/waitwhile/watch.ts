/**
 * 지켜본다. 바뀌는 순간만 알린다.
 *
 * 이 프로그램이 하는 일은 한 문장이다 — **닫혀 있던 등록 창구가 열리는 순간을 잡아
 * 폰으로 보낸다.** 상태를 매번 알리면 알림이 배경 소음이 되고, 배경 소음이 되면 정작
 * 열린 날의 알림도 안 본다. 그래서 지난번에 본 것을 상태 파일에 적어 두고 **달라진
 * 것만** 내보낸다.
 *
 * 주기는 두 개다. 평소에는 느긋하게 보고, 시간표에 적힌 열리는 시각이 가까워지면
 * 좁혀 본다. 하루 종일 10초로 두드리는 것은 서버에도 우리에게도 손해다.
 */
import { log, sayOk, sayStar, sayStep, tick } from "../log.js";
import { UI } from "../ui.js";
import { nowStamp, wait } from "../util.js";
import {
  entryOf, intervalOf, Quit, saveState, type Config, type PlaceSpec, type State,
} from "./config.js";
import {
  FetchFailed, fetchSnapshot, hoursMark, isOpenNow, minutesUntilOpen, pageUrl, slugOf,
  type Snapshot,
} from "./api.js";
import { notifyBeat, notifyClose, notifyError, notifyFull, notifyHours, notifyOpen, summary, untilText } from "./notify.js";

export interface Place {
  slug: string;
  label: string;
}

/** 설정에 적힌 것을 감시 대상으로 편다. 주소로 적어도 되고 슬러그만 적어도 된다. */
export function placesOf(cfg: Config): Place[] {
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const raw of cfg.places ?? []) {
    const spec: PlaceSpec = typeof raw === "string" ? { slug: raw } : raw;
    const slug = slugOf(spec.slug ?? "");
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, label: spec.label || slug });
  }
  return out;
}

/** 조회가 연달아 몇 번 실패했는지. 켜져 있는 동안만 세면 되므로 상태 파일에 안 적는다. */
const failures = new Map<string, { times: number; told: boolean }>();

/**
 * 한 곳을 보고, 지난번과 달라진 것을 알린다. → 이번에 받아 온 것 (못 받았으면 null)
 *
 * 처음 보는 곳은 기준선만 잡고 지나간다. 다만 **그때 이미 열려 있으면 알린다** —
 * 감시를 켠 사람이 알고 싶은 것은 "지금 넣을 수 있는가" 이지 "방금 바뀌었는가" 가
 * 아니다.
 */
async function checkOne(cfg: Config, state: State, place: Place): Promise<Snapshot | null> {
  const prev = entryOf(state, place.slug);
  const first = prev.seen_at === undefined;

  let snap: Snapshot;
  try {
    snap = await fetchSnapshot(place.slug);
  } catch (e) {
    if (!(e instanceof FetchFailed)) throw e; // 404 같은 것은 위에서 처리한다.
    const seat = failures.get(place.slug) ?? { times: 0, told: false };
    seat.times += 1;
    failures.set(place.slug, seat);
    log.warn(`${place.label}: ${(e as Error).message} (${seat.times}번째)`);
    if (seat.times >= (cfg.error_threshold ?? 3) && !seat.told) {
      seat.told = true;
      await notifyError(cfg, place.slug, seat.times, (e as Error).message);
    }
    return null;
  }
  failures.delete(place.slug);

  const open = isOpenNow(snap);
  const mark = hoursMark(snap);

  if (open && !prev.open) {
    sayStar(`${snap.name}: ${summary(snap)} → ${pageUrl(snap.slug)}`);
    prev.opened_at = nowStamp();
    await notifyOpen(cfg, snap);
  } else if (!open && prev.open) {
    sayStep(`${snap.name}: 등록이 닫혔습니다.`);
    prev.closed_at = nowStamp();
    await notifyClose(cfg, snap);
  }

  // 시간표는 첫 실행에서 알리지 않는다. "바뀌었다" 고 할 이전 값이 없다.
  if (!first && prev.hours_mark !== undefined && mark !== prev.hours_mark) {
    sayStep(`${snap.name}: 시간표가 바뀌었습니다 · ${untilText(snap)}`);
    await notifyHours(cfg, snap);
  }

  if (!first && snap.waitlistFull && !prev.full) {
    log.info(`${snap.name}: 대기열이 찼습니다.`);
    await notifyFull(cfg, snap);
  }

  prev.name = snap.name;
  prev.open = open;
  prev.full = snap.waitlistFull;
  prev.hours_mark = mark;
  prev.seen_at = nowStamp();
  return snap;
}

/** 아직 살아 있다는 소식을 보낼 때가 됐는가. */
async function beat(cfg: Config, state: State, snaps: Snapshot[]): Promise<void> {
  const every = cfg.heartbeat_hours ?? 0;
  if (every <= 0 || !snaps.length) return;
  const last = state.beat_at ? Date.parse(state.beat_at) : 0;
  if (Date.now() - last < every * 3600_000) return;
  state.beat_at = new Date().toISOString();
  await notifyBeat(cfg, snaps);
}

/**
 * 다음 확인까지 몇 초 쉴까.
 *
 * 보는 곳 중 **하나라도** 열릴 때가 가까우면 좁힌다. 곳마다 주기를 따로 돌리면
 * 코드가 두 배로 복잡해지는데, 여기서 보는 것은 많아야 몇 곳이라 값이 안 맞는다.
 *
 * **좁혀 보는 동안에는 지터를 붙이지 않는다.** 지터는 평소에 고정 패턴을 남기지
 * 않으려고 넣은 것인데, 정작 몇 초를 다투는 순간에 최대 몇 초를 더하고 앉아 있으면
 * 좁힌 보람이 없다. 그 구간은 어차피 짧아서 패턴이랄 것도 남지 않는다.
 */
function nextDelay(
  cfg: Config, snaps: Snapshot[], forced: boolean,
): { seconds: number; fast: boolean } {
  const soon = cfg.fast_before_minutes ?? 20;
  const fast = forced || snaps.some((snap) => {
    if (isOpenNow(snap)) return true;
    const left = minutesUntilOpen(snap);
    return left !== null && left <= soon;
  });
  const base = intervalOf(cfg, fast);
  return { seconds: fast ? base : base + Math.random() * (cfg.poll_jitter_seconds ?? 0), fast };
}

/** 기다리는 동안 화면 아래에 고쳐 쓰는 줄. */
function watching(snaps: Snapshot[], fast: boolean): string {
  const head = fast ? "좁혀 보는 중" : "지켜보는 중";
  if (!snaps.length) return `${head} · 아직 받아 온 것이 없습니다`;
  const parts = snaps.map((s) => `${s.name} ${isOpenNow(s) ? "열림" : "마감"}`);
  return `${head} · ${parts.join(" / ")} · ${untilText(snaps[0]!)}`;
}

/**
 * @param forceFast 시간표와 상관없이 처음부터 좁혀 본다 (--fast).
 *
 * 시간표에 안 적힌 날 갑자기 여는 경우가 있다 — 공개 깃발(isPublicWaitlist)만
 * 손으로 올려 버리면 시간표는 그대로다. 그런 날을 아는 것은 사람뿐이므로, 사람이
 * 말해 줄 자리를 둔다.
 */
export async function watch(
  cfg: Config, state: State, once: boolean, forceFast = false,
): Promise<void> {
  const places = placesOf(cfg);
  if (!places.length) {
    throw new Error("감시할 곳이 없습니다. waitwhile_config.json 의 places 에 주소를 넣어주세요.");
  }

  UI.banner("Waitwhile 등록 감시", [
    ...places.map((p) => `${p.label}  ${pageUrl(p.slug)}`),
    forceFast
      ? `줄곧 ${intervalOf(cfg, true)}초 주기 (--fast · 시간표는 보지 않습니다)`
      : `평소 ${intervalOf(cfg, false)}초 · 열릴 때 가까우면 ${intervalOf(cfg, true)}초` +
        ` (${cfg.fast_before_minutes ?? 20}분 전부터)`,
    `알림: ${(cfg.discord_notify ?? []).join(", ") || "없음"}`,
  ]);

  // 조회조차 안 되는 곳은 빼고 돈다. 슬러그 하나 틀렸다고 나머지까지 멈출 이유가 없다.
  const live = [...places];
  // 곳마다 마지막으로 파일에 적은 줄. 같은 줄을 또 적지 않으려는 것이다.
  const said = new Map<string, string>();

  for (;;) {
    const snaps: Snapshot[] = [];
    for (const place of [...live]) {
      try {
        const snap = await checkOne(cfg, state, place);
        if (snap) snaps.push(snap);
      } catch (e) {
        log.error(`${place.label}: ${(e as Error).message}`);
        live.splice(live.indexOf(place), 1);
      }
    }

    if (!live.length) throw new Quit();
    await beat(cfg, state, snaps);
    // 며칠씩 도는 물건이다. 끝에 한 번만 적으면 전원이 나갔을 때 본 것을 통째로 잃는다.
    saveState(state);

    for (const snap of snaps) {
      const line = `${snap.name} · ${summary(snap)} · ${untilText(snap)}`;
      // 화면에는 늘 보여 주되, **달라졌을 때만** 파일에 적는다. 60초마다 같은 줄을
      // 쌓으면 하루에 천사백 줄이고, 그 사이에 낀 진짜 사건은 눈에 안 띈다.
      if (said.get(snap.slug) === line) UI.status(line);
      else {
        said.set(snap.slug, line);
        tick(line);
      }
    }
    if (once) {
      for (const snap of snaps) sayOk(`${snap.name}: ${summary(snap)}`);
      return;
    }

    const { seconds, fast } = nextDelay(cfg, snaps, forceFast);
    await wait(seconds, watching(snaps, fast));
  }
}
