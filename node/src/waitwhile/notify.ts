/**
 * 디스코드로 알린다.
 *
 * 진행 상황은 화면에서 보고, **손댈 차례만 폰으로 받는다.** 무엇을 보낼지는 설정의
 * discord_notify 가 정한다 — 다 보내면 정작 중요한 것이 묻힌다.
 *
 * 이 감시가 폰으로 보내야 할 것은 사실상 하나다: **지금 등록 창구가 열렸다.**
 * 나머지(시간표 변경·꽉 참·고장)는 그 하나를 놓치지 않기 위한 곁가지다.
 */
import { log } from "../log.js";
import { run, wants, webhookOf, type Config, type Event } from "./config.js";
import {
  DAY_LABEL, hoursText, isOpenNow, nextOpening, pageUrl, type Snapshot,
} from "./api.js";

export interface Embed {
  title?: string;
  url?: string;
  color?: number;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

interface Payload {
  content?: string | null;
  embeds?: Embed[];
}

const now = () => new Date().toISOString();

const GREEN = 0x2ecc71;
const GREY = 0x95a5a6;
const BLUE = 0x3498db;
const YELLOW = 0xf1c40f;
const RED = 0xe74c3c;

export async function postDiscord(webhookUrl: string, payload: Payload): Promise<boolean> {
  if (run.dryRun) {
    log.info(`[dry-run] 디스코드 전송 생략:\n${JSON.stringify(payload, null, 2)}`);
    return true;
  }
  if (!webhookUrl) {
    log.warn("웹훅이 없어 알림을 건너뜁니다.");
    return false;
  }
  let res: Response;
  try {
    res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    log.error(`디스코드 전송 중 오류: ${(e as Error).message}`);
    return false;
  }
  if (res.status >= 300) {
    log.error(`디스코드 전송 실패 (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return false;
  }
  log.info(`디스코드 전송 완료 (${res.status})`);
  return true;
}

function notify(cfg: Config, embed: Embed, mention?: string | null): Promise<boolean> {
  const payload: Payload = { embeds: [embed] };
  if (mention) payload.content = mention;
  return postDiscord(webhookOf(cfg), payload);
}

/**
 * 다음에 열릴 때를 사람 말로. "토 11:00 (3일 뒤)" 처럼.
 *
 * 남은 시간만 적으면 "약 82시간 뒤" 같은 것이 나와서 아무도 못 읽는다. 시각을 같이
 * 적어 두면 달력을 보지 않아도 언제인지 안다.
 */
export function untilText(snap: Snapshot): string {
  const next = nextOpening(snap);
  if (next === null) return "이레 안에 예정 없음";
  if (next.minutes === 0) return "지금이 열려 있을 시간대";

  const when = `${DAY_LABEL[next.day] ?? next.day} ${next.from}`;
  const left = next.minutes;
  if (left < 60) return `${when} (${left}분 뒤)`;
  if (left < 1440) {
    const hours = Math.floor(left / 60);
    const minutes = left % 60;
    return `${when} (${minutes ? `${hours}시간 ${minutes}분` : `${hours}시간`} 뒤)`;
  }
  return `${next.date} ${when} (${Math.floor(left / 1440)}일 뒤)`;
}

/** 한 줄 요약. 화면에도 쓰고 임베드에도 쓴다. */
export function summary(snap: Snapshot): string {
  if (isOpenNow(snap)) {
    const how = [
      snap.waitlistJoinable ? "대기열" : null,
      snap.bookingJoinable ? "예약" : null,
    ].filter(Boolean).join(" · ");
    return `등록 열림 (${how})`;
  }
  if (snap.waitlistFull) return "대기열이 꽉 찼습니다";
  if (snap.forceClosed) return "강제 마감 상태";
  if (!snap.active) return "곳이 비활성 상태";
  return "등록 마감";
}

/** 임베드마다 붙는 지금 상태 칸들. 사람이 열자마자 판단할 수 있어야 한다. */
function statusFields(snap: Snapshot): { name: string; value: string; inline?: boolean }[] {
  const mark = (ok: boolean) => (ok ? "🟢 가능" : "⚪ 불가");
  const fields = [
    { name: "대기열", value: mark(snap.waitlistJoinable), inline: true },
    { name: "예약", value: mark(snap.bookingJoinable), inline: true },
    { name: "다음 예정", value: untilText(snap), inline: true },
  ];
  if (snap.numWaiting > 0) {
    fields.push({ name: "대기 인원", value: `${snap.numWaiting}팀`, inline: true });
  }
  if (snap.wait >= 0) {
    fields.push({ name: "예상 대기", value: `${snap.wait}분`, inline: true });
  }
  return fields;
}

function say(cfg: Config, event: Event, embed: Embed, mention = false): Promise<boolean> {
  if (!wants(cfg, event)) return Promise.resolve(false);
  return notify(cfg, embed, mention ? cfg.mention : null);
}

/**
 * 등록이 열렸다. **이 알림 하나 받자고 지켜본 것이다.**
 *
 * 주소를 본문에 크게 적어 둔다 — 폰에서 알림을 받았을 때 임베드 제목을 누르는 것보다
 * 링크 한 줄이 손가락에 가깝고, 그 몇 초가 대기 순번을 가른다.
 */
export function notifyOpen(cfg: Config, snap: Snapshot, test = false): Promise<boolean> {
  // 시험으로 보낸 것을 진짜처럼 보이게 하면 안 된다. 열리지도 않았는데 폰을 보고
  // 페이지로 달려가게 만드는 알림은 없느니만 못하다.
  return say(cfg, "open", {
    title: (test ? `🧪 [시험] ${snap.name}` : `🟢 등록이 열렸습니다 — ${snap.name}`).slice(0, 250),
    url: pageUrl(snap.slug),
    color: test ? GREY : GREEN,
    description: [
      test ? `현재 상태: **${summary(snap)}**` : `**[지금 등록하기](${pageUrl(snap.slug)})**`,
      "",
      test ? `열리면 이 모양으로 갑니다. [페이지](${pageUrl(snap.slug)})` : summary(snap),
    ].join("\n"),
    fields: statusFields(snap),
    footer: { text: test ? "알림이 가는지 확인한 것입니다" : "등록은 직접 해주세요" },
    timestamp: now(),
  }, !test);
}

export function notifyClose(cfg: Config, snap: Snapshot): Promise<boolean> {
  return say(cfg, "close", {
    title: `⚪ 등록이 닫혔습니다 — ${snap.name}`.slice(0, 250),
    url: pageUrl(snap.slug),
    color: GREY,
    description: summary(snap),
    fields: statusFields(snap),
    timestamp: now(),
  });
}

/**
 * 시간표가 바뀌었다. 열린 것은 아니지만 **열릴 날이 정해졌다는 뜻일 수 있다.**
 *
 * 날짜별 시간표(hoursByDate)가 생기는 것이 특히 그렇다 — 드롭 날을 그렇게 잡는다.
 * 열림 알림보다 며칠 앞서 오는 소식이라 값어치가 있다.
 */
export function notifyHours(cfg: Config, snap: Snapshot): Promise<boolean> {
  return say(cfg, "hours", {
    title: `🗓 시간표가 바뀌었습니다 — ${snap.name}`.slice(0, 250),
    url: pageUrl(snap.slug),
    color: BLUE,
    description: "여는 날짜나 시간이 달라졌습니다. 드롭 일정이 잡혔을 수 있습니다.",
    fields: [
      { name: "영업", value: hoursText(snap.hours, snap.hoursByDate).slice(0, 1000) },
      {
        name: "대기열",
        value: (snap.waitlistHours
          ? hoursText(snap.waitlistHours, snap.waitlistHoursByDate)
          : "영업시간과 같음").slice(0, 1000),
      },
      {
        name: "예약",
        value: hoursText(snap.bookingHours, snap.bookingHoursByDate).slice(0, 1000),
      },
      { name: "다음 예정", value: untilText(snap) },
    ],
    footer: { text: `${snap.timezone} 기준` },
    timestamp: now(),
  }, true);
}

export function notifyFull(cfg: Config, snap: Snapshot): Promise<boolean> {
  return say(cfg, "full", {
    title: `🈵 대기열이 찼습니다 — ${snap.name}`.slice(0, 250),
    url: pageUrl(snap.slug),
    color: YELLOW,
    description: "더 받지 않는 상태입니다. 빠지는 자리가 생기면 다시 열릴 수 있습니다.",
    fields: statusFields(snap),
    timestamp: now(),
  });
}

/**
 * 조회가 연달아 실패한다. 조용히 죽어 있는 감시가 제일 나쁘다 —
 * 열렸는데 아무 알림이 없으면 사람은 "아직 안 열렸구나" 로 읽는다.
 */
export function notifyError(cfg: Config, slug: string, times: number, why: string): Promise<boolean> {
  return say(cfg, "error", {
    title: `⚠️ 상태를 못 읽고 있습니다 — ${slug}`,
    url: pageUrl(slug),
    color: RED,
    description: `${times}번 연달아 실패했습니다.\n\`\`\`${why.slice(0, 500)}\`\`\``,
    footer: { text: "감시는 계속 돌고 있습니다" },
    timestamp: now(),
  }, true);
}

/** 아직 보고 있다는 소식. heartbeat_hours 를 켜 둔 사람만 받는다. */
export function notifyBeat(cfg: Config, snaps: Snapshot[]): Promise<boolean> {
  return say(cfg, "beat", {
    title: "👀 감시 중",
    color: GREY,
    description: snaps
      .map((s) => `**${s.name}** — ${summary(s)} · ${untilText(s)}`)
      .join("\n") || "보는 곳이 없습니다.",
    timestamp: now(),
  });
}
