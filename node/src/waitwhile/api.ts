/**
 * Waitwhile 공개 API 에서 한 곳의 지금 상태를 받아 온다.
 *
 * 페이지를 뜯지 않는다. `waitwhile.com/locations/<슬러그>` 는 Next.js 로 그려지는
 * 화면이라 "현재 등록이 마감되었습니다" 라는 글자는 자바스크립트가 만들어 낸 것이고,
 * 그 글자를 찾으러 가면 사이트가 문구 하나 고칠 때마다 감시가 눈이 먼다.
 *
 * 그 화면이 보고 판단하는 원본이 여기 있다. 열쇠도 필요 없다:
 *
 *   GET https://api.waitwhile.com/v2/public/locations/supremeseongsu   → 200
 *
 * 슬러그가 그대로 먹으므로 아이디를 따로 찾아 둘 필요도 없다.
 */

import { createHash } from "node:crypto";

const API = "https://api.waitwhile.com/v2/public/locations";
// 사람 흉내를 내려는 것이 아니라, 빈 UA 로 오는 것을 막아 두는 앞단이 흔해서다.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** 요일 한 칸. periods 가 적혀 있어도 isOpen 이 false 면 그날은 닫은 것이다. */
export interface DayHours {
  isOpen: boolean;
  periods: { from: string; to: string }[];
}
export type HoursMap = Partial<Record<string, DayHours>>;

/** 우리가 보는 것만 추린 원본. 나머지 삼백 남짓한 칸은 쳐다보지 않는다. */
interface Raw {
  id?: string;
  name?: string;
  displayName?: string;
  businessName?: string;
  timezone?: string;
  isActive?: boolean;
  isForceOpen?: boolean;
  isForceClosed?: boolean;
  isOpen?: boolean;
  isWaitlistActive?: boolean;
  isPublicWaitlist?: boolean;
  isWaitlistOpen?: boolean;
  isWaitlistFull?: boolean;
  isBookingActive?: boolean;
  isPublicBooking?: boolean;
  isBookingOpen?: boolean;
  numWaiting?: number;
  wait?: number;
  naEstWaitReason?: string;
  hours?: HoursMap | null;
  hoursByDate?: Record<string, DayHours> | null;
  waitlistHours?: HoursMap | null;
  waitlistHoursByDate?: Record<string, DayHours> | null;
  bookingHours?: HoursMap | null;
  bookingHoursByDate?: Record<string, DayHours> | null;
}

export interface Snapshot {
  slug: string;
  id: string;
  name: string;
  timezone: string;
  /** 가게 자체가 열려 있는가. 등록 가능 여부와는 다른 이야기다. */
  storeOpen: boolean;
  active: boolean;
  forceOpen: boolean;
  forceClosed: boolean;
  /** 지금 대기열에 이름을 넣을 수 있는가. */
  waitlistJoinable: boolean;
  /** 지금 예약을 잡을 수 있는가. */
  bookingJoinable: boolean;
  waitlistFull: boolean;
  numWaiting: number;
  /** 예상 대기(분). -1 이면 사이트가 모르겠다고 한 것이다. */
  wait: number;
  reason: string;
  hours: HoursMap;
  hoursByDate: Record<string, DayHours>;
  waitlistHours: HoursMap | null;
  waitlistHoursByDate: Record<string, DayHours>;
  bookingHours: HoursMap | null;
  bookingHoursByDate: Record<string, DayHours>;
  fetchedAt: Date;
}

/** 등록이 열려 있는가. 대기열이든 예약이든 하나만 열려 있으면 열린 것이다. */
export function isOpenNow(snap: Snapshot): boolean {
  return snap.waitlistJoinable || snap.bookingJoinable;
}

/** 주소를 통째로 적어 놨어도 슬러그만 뽑아 쓴다. */
export function slugOf(text: string): string {
  const raw = String(text || "").trim();
  const m = /waitwhile\.com\/(?:locations|l|welcome)\/([^/?#\s]+)/i.exec(raw);
  if (m) return m[1]!;
  return raw.replace(/^\/+|\/+$/g, "");
}

export function pageUrl(slug: string): string {
  return `https://waitwhile.com/locations/${slug}`;
}

/** 조회가 안 된 것. 고칠 자리가 있는 고장과 구분하려고 따로 둔다. */
export class FetchFailed extends Error {}

export async function fetchRaw(slug: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${API}/${encodeURIComponent(slug)}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new FetchFailed(`조회 중 오류: ${(e as Error).message}`);
  }
  if (res.status === 404) {
    // 이건 다시 두드려 봐야 소용없다. 슬러그가 틀렸거나 곳이 없어진 것이다.
    throw new Error(`${slug} 을(를) 찾을 수 없습니다 (404). 주소를 확인해 주세요.`);
  }
  if (res.status >= 300) {
    throw new FetchFailed(`조회 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    throw new FetchFailed(`받은 것이 JSON 이 아닙니다: ${(e as Error).message}`);
  }
}

/**
 * 원본을 우리가 볼 모양으로 접는다.
 *
 * **"열렸는가" 를 우리가 시간표로 계산하지 않는다.** isWaitlistOpen·isBookingOpen 은
 * 사이트가 이미 시간표와 강제 개폐(isForceOpen·isForceClosed)까지 셈해서 내놓은 답이다.
 * 여기서 다시 세면 그쪽이 규칙을 바꿀 때마다 우리만 틀린 답을 들고 있게 된다.
 *
 * 다만 isPublic* 은 따로 봐야 한다. 시간표상 열려 있어도 공개 페이지에 등록 창구를
 * 내주지 않으면 사람은 넣을 수가 없다 — 지금 이 가게가 딱 그 상태다
 * (isBookingOpen 은 true 인데 isPublicBooking 이 false 다).
 */
export function toSnapshot(slug: string, raw: Record<string, unknown>): Snapshot {
  const d = raw as Raw;
  const on = (v: unknown) => v === true;
  const num = (v: unknown, blank = 0) => (typeof v === "number" ? v : blank);
  const byDate = (v: unknown) => (v && typeof v === "object" ? v as Record<string, DayHours> : {});
  const live = on(d.isActive) && !on(d.isForceClosed);

  return {
    slug,
    id: String(d.id ?? ""),
    name: String(d.displayName || d.name || d.businessName || slug),
    timezone: String(d.timezone || "Asia/Seoul"),
    storeOpen: on(d.isOpen),
    active: on(d.isActive),
    forceOpen: on(d.isForceOpen),
    forceClosed: on(d.isForceClosed),
    waitlistJoinable: live && on(d.isWaitlistActive) && on(d.isPublicWaitlist) &&
      on(d.isWaitlistOpen) && !on(d.isWaitlistFull),
    bookingJoinable: live && on(d.isBookingActive) && on(d.isPublicBooking) && on(d.isBookingOpen),
    waitlistFull: on(d.isWaitlistFull),
    numWaiting: num(d.numWaiting),
    wait: num(d.wait, -1),
    reason: String(d.naEstWaitReason ?? ""),
    hours: d.hours ?? {},
    hoursByDate: byDate(d.hoursByDate),
    waitlistHours: d.waitlistHours ?? null,
    waitlistHoursByDate: byDate(d.waitlistHoursByDate),
    bookingHours: d.bookingHours ?? null,
    bookingHoursByDate: byDate(d.bookingHoursByDate),
    fetchedAt: new Date(),
  };
}

export async function fetchSnapshot(slug: string): Promise<Snapshot> {
  return toSnapshot(slug, await fetchRaw(slug));
}

// --- 시간표 ---------------------------------------------------------------

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const DAY_LABEL: Record<string, string> = {
  mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토", sun: "일",
};

/** 그곳 시간으로 지금이 며칠 몇 시 무슨 요일인지. */
export function localNow(snap: Snapshot, at: Date = new Date()): {
  date: string; day: string; minutes: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: snap.timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  // 자정을 24 로 내주는 판이 있다. 0 으로 되돌린다.
  const hour = Number(get("hour")) % 24;
  // Date 쪽 요일을 그냥 쓰면 UTC 와 날짜가 갈릴 때 하루가 어긋난다. 위에서 뽑은 날짜로 센다.
  const day = DAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
  return { date, day, minutes: hour * 60 + Number(get("minute")) };
}

/** "11:00" → 660. 못 읽으면 null. */
function toMinutes(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 그날 열려 있는 구간들. 날짜로 따로 잡아 둔 것이 있으면 그것이 요일표를 이긴다.
 *
 * 날짜별 시간표는 드롭 날에 쓰는 물건이다 — "이번 토요일만 10시 30분에 연다" 같은 것이
 * 여기로 들어온다. 요일표만 보고 있으면 그런 날을 통째로 놓친다.
 */
function periodsOn(
  map: HoursMap | null, byDate: Record<string, DayHours>, date: string, day: string,
): [number, number][] {
  const entry = byDate[date] ?? map?.[day];
  if (!entry || !entry.isOpen) return [];
  const out: [number, number][] = [];
  for (const period of entry.periods ?? []) {
    const from = toMinutes(period.from);
    const to = toMinutes(period.to);
    if (from !== null && to !== null && to > from) out.push([from, to]);
  }
  return out;
}

/** 시간표를 볼 곳들. 대기열 시간표를 따로 안 적어 둔 곳은 영업시간을 그대로 쓴다. */
function hourSources(snap: Snapshot): [HoursMap | null, Record<string, DayHours>][] {
  return [
    [
      snap.waitlistHours ?? snap.hours,
      snap.waitlistHours ? snap.waitlistHoursByDate : snap.hoursByDate,
    ],
    [snap.bookingHours, snap.bookingHoursByDate],
  ];
}

export interface NextOpening {
  /** 지금부터 몇 분 뒤인가. 이미 그 구간 안이면 0. */
  minutes: number;
  date: string;
  day: string;
  /** 여는 시각 ("11:00"). */
  from: string;
}

/**
 * 다음에 열릴 때. 지금이 열려 있는 구간 안이면 minutes 는 0.
 * 이레 안에 예정이 없으면 null.
 *
 * **오늘·내일만 보면 모자란다.** 이 가게는 토요일에만 여는데, 화요일에 켜 놓고
 * "다음 예정 없음" 을 보여 주면 감시가 죽은 것처럼 보인다. 요일표는 이레가 한 바퀴라
 * 거기까지만 본다.
 *
 * 하루를 1440분으로 세므로 서머타임을 쓰는 곳에서는 한 시간쯤 어긋날 수 있다. 여기 쓰는
 * 곳은 서울(서머타임 없음)이고, 이 값은 "언제쯤" 을 보여 주고 주기를 좁힐 때만 쓴다.
 */
export function nextOpening(snap: Snapshot, at: Date = new Date()): NextOpening | null {
  const today = localNow(snap, at);
  const sources = hourSources(snap);
  const walk = new Date(`${today.date}T00:00:00Z`);
  let best: NextOpening | null = null;

  const consider = (minutes: number, date: string, day: string, from: number) => {
    if (best !== null && best.minutes <= minutes) return;
    const two = (n: number) => String(n).padStart(2, "0");
    best = { minutes, date, day, from: `${two(Math.floor(from / 60))}:${two(from % 60)}` };
  };

  for (let ahead = 0; ahead <= 7; ahead++) {
    const date = walk.toISOString().slice(0, 10);
    const day = DAY_KEYS[walk.getUTCDay()]!;
    for (const [map, byDate] of sources) {
      for (const [from, to] of periodsOn(map, byDate, date, day)) {
        if (ahead === 0) {
          // 이미 열려 있는 시간대 안이다. 더 볼 것이 없다.
          if (today.minutes >= from && today.minutes < to) {
            consider(0, date, day, from);
            return best;
          }
          if (from > today.minutes) consider(from - today.minutes, date, day, from);
        } else {
          consider(ahead * 1440 - today.minutes + from, date, day, from);
        }
      }
    }
    // 날짜를 앞에서부터 훑고 있으므로, 찾은 날보다 뒤는 볼 이유가 없다.
    if (best !== null) break;
    walk.setUTCDate(walk.getUTCDate() + 1);
  }
  return best;
}

/** 다음에 열릴 때까지 몇 분. 주기를 좁힐지 정할 때 쓴다. */
export function minutesUntilOpen(snap: Snapshot, at: Date = new Date()): number | null {
  return nextOpening(snap, at)?.minutes ?? null;
}

/**
 * 시간표를 짧은 글자로 접는다. 이 글자가 달라지면 시간표가 바뀐 것이다.
 *
 * 통째로 적어 두면 상태 파일 한 줄이 1.5KB 가 되어 눈으로 훑을 수가 없다. 무엇이
 * 어떻게 바뀌었는지는 알림이 시간표를 그대로 실어 보내므로, 여기서는 **달라졌다는
 * 사실만** 있으면 된다.
 */
export function hoursMark(snap: Snapshot): string {
  const body = JSON.stringify([
    snap.hours, snap.hoursByDate,
    snap.waitlistHours, snap.waitlistHoursByDate,
    snap.bookingHours, snap.bookingHoursByDate,
  ]);
  return createHash("sha1").update(body).digest("hex").slice(0, 16);
}

/** 사람이 읽을 시간표. 여는 날만 적는다 — 닫은 요일 일곱 줄은 볼 것이 없다. */
export function hoursText(map: HoursMap | null, byDate: Record<string, DayHours>): string {
  const lines: string[] = [];
  for (const day of DAY_ORDER) {
    const entry = map?.[day];
    if (!entry?.isOpen) continue;
    const spans = (entry.periods ?? []).map((p) => `${p.from}~${p.to}`).join(", ");
    lines.push(`${DAY_LABEL[day]} ${spans || "시간 미지정"}`);
  }
  for (const [date, entry] of Object.entries(byDate)) {
    const spans = (entry.periods ?? []).map((p) => `${p.from}~${p.to}`).join(", ");
    lines.push(`**${date} ${entry.isOpen ? spans || "시간 미지정" : "휴무"}**`);
  }
  return lines.length ? lines.join(" · ") : "여는 날 없음";
}
