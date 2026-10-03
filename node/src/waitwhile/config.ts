/**
 * 설정과 상태.
 *
 * 롯데온 판과 마찬가지로 **파이썬 짝이 없다.** 이름만 맞춰 프로젝트 뿌리에 둔다 —
 * 웹훅을 넣고 로그를 읽는 자리가 사이트마다 흩어지면 사람이 헷갈린다.
 *
 *   waitwhile_config.json   설정 (감시할 곳·웹훅·주기)
 *   waitwhile_state.json    지난번에 본 상태. 바뀐 것만 알리려는 것
 *   waitwhile-watch.log     전부 적는 곳
 *   waitwhile-dump.json     받아 온 JSON 통째로 (--dump 가 적는다)
 *
 * 사는 프로그램이 아니라 **보는 프로그램이다.** 쿠키도 브라우저도 없다 — 공개
 * API 한 곳만 두드린다.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useLogFile } from "../log.js";

/** 프로젝트 뿌리. bnkr 쪽 파일이 표지 노릇을 한다 (거기가 이 프로젝트의 집이다). */
function findBase(): string {
  const env = (process.env["WAITWHILE_HOME"] || "").trim();
  if (env) return resolve(env);
  // dist/waitwhile 에서 돌든 src/waitwhile 에서 돌든 같은 곳을 찾아야 한다.
  let here = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(here, "waitwhile_config.json")) || existsSync(join(here, "bnkr_buy.py"))) {
      return here;
    }
    here = dirname(here);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export const BASE = findBase();
export const CONFIG_PATH = join(BASE, "waitwhile_config.json");
export const STATE_PATH = join(BASE, "waitwhile_state.json");
export const LOG_PATH = join(BASE, "waitwhile-watch.log");
export const DUMP_PATH = join(BASE, "waitwhile-dump.json");
// 웹훅을 따로 안 적으면 bnkr 쪽 것을 빌려 쓴다. 채널을 또 만들 이유가 없다.
export const BNKR_CONFIG_PATH = join(BASE, "bnkr_buy_config.json");

/**
 * 로그를 이쪽 파일로 돌린다. **이 파일을 들이는 순간 바뀐다.**
 *
 * main() 안에서 부르면 늦다 — 인자를 잘못 줘서 그 앞에서 나는 오류까지
 * waitwhile-watch.log 에 남아야 한다.
 */
useLogFile(LOG_PATH);

/** 감시할 곳. 주소를 통째로 적어도 되고 슬러그만 적어도 된다. */
export interface PlaceSpec {
  slug?: string;
  label?: string;
}

/**
 * 알릴 만한 일들. discord_notify 에 적힌 것만 나간다.
 *
 *   open    등록이 열렸다        ← 이거 하나 받자고 지켜보는 것이다
 *   close   등록이 닫혔다
 *   hours   영업·예약 시간표가 바뀌었다 (날짜가 새로 잡히는 것도 여기)
 *   full    대기열이 꽉 찼다
 *   error   조회가 연달아 실패한다
 *   beat    아직 살아 있다는 소식 (heartbeat_hours 마다)
 */
export const EVENTS = ["open", "close", "hours", "full", "error", "beat"] as const;
export type Event = (typeof EVENTS)[number];

export interface Config {
  discord_webhook_url: string;
  mention: string;
  places: (string | PlaceSpec)[];
  poll_interval_seconds: number;
  poll_jitter_seconds: number;
  fast_interval_seconds: number;
  fast_before_minutes: number;
  min_interval_seconds: number;
  error_threshold: number;
  heartbeat_hours: number;
  discord_notify: string[];
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: Config = {
  discord_webhook_url: "",
  mention: "@everyone",
  places: ["supremeseongsu"],

  // 평소 주기. 닫혀 있는 동안에는 이 간격으로 느긋하게 본다.
  poll_interval_seconds: 60,
  poll_jitter_seconds: 5,

  /**
   * 열릴 때가 가까우면(또는 --fast 로 부르면) 이 간격으로 좁혀 본다.
   *
   * 하루 종일 좁혀 보면 하루 수만 번이다. 그렇다고 늘 60초로 보면, 드롭 날 줄이
   * 몇 초 만에 차는 곳에서는 60초가 통째로 늦다.
   *
   * **2초 아래로 내려가 봐야 소용이 없다.** 이 API 는 앞단(Google Frontend)이
   * `cache-control: s-maxage=10` 으로 10초를 캐싱한다 — 재 봤다. 아무리 촘촘히
   * 두드려도 앞단이 들고 있는 것을 다시 받을 뿐이라, 감지가 빨라지는 폭은 캐시가
   * 만료된 뒤 얼마 만에 두드리느냐까지다. 2초면 그 몫을 거의 다 가져간다.
   *
   * 서버가 내주는 한도는 분당 600회(x-rate-limit-limit)다. 한 곳을 2초로 보면
   * 분당 30회 — 한도의 5% 다.
   */
  fast_interval_seconds: 2,
  fast_before_minutes: 20,

  // 이보다 촘촘하게는 두드리지 않는다. 설정을 잘못 적어도 넘지 않는 선이다.
  // 위의 10초 캐시 때문에 이 아래는 얻는 것 없이 남의 서버만 두드리는 짓이 된다.
  min_interval_seconds: 2,

  // 이만큼 연달아 실패해야 고장으로 친다. 한 번 끊긴 것으로 폰을 울릴 일은 아니다.
  error_threshold: 3,

  // 몇 시간마다 "아직 보고 있고 여전히 닫혀 있다" 를 보낼까. 0 이면 안 보낸다.
  heartbeat_hours: 0,

  // close 는 기본에서 뺐다. 열린 것을 받았으면 닫힌 것은 이미 아는 일이다.
  discord_notify: ["open", "hours", "full", "error"],
};

/** 보내지 않고 무엇을 보낼지만 본다. 프로세스 하나에 하나뿐인 상태라 여기 둔다. */
export const run = { dryRun: false };

/**
 * 할 말은 이미 화면에 적었으니 조용히 1 로 끝내라는 뜻.
 * 고칠 자리가 있는 고장이 아닌 것들이 여기로 온다.
 */
export class Quit extends Error {
  constructor() {
    super("");
  }
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    throw new Error(
      `${basename(CONFIG_PATH)} 을 만들었습니다. discord_webhook_url 을 넣고 다시 실행해 주세요.`,
    );
  }
  const own = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...own };
}

export function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

/** 웹훅을 따로 안 적었으면 bnkr 쪽 것을 빌려 쓴다. 빌려 쓰기만 하고 베껴 두지는 않는다. */
export function webhookOf(cfg: Config): string {
  const own = (process.env["WAITWHILE_WEBHOOK"] || cfg.discord_webhook_url || "").trim();
  if (own) return own;
  try {
    const borrowed = JSON.parse(readFileSync(BNKR_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    return String(borrowed["discord_webhook_url"] || "").trim();
  } catch {
    return "";
  }
}

export function wants(cfg: Config, event: Event): boolean {
  return (cfg.discord_notify || []).includes(event);
}

/** 주기를 설정에서 꺼낸다. min_interval_seconds 아래로는 내려가지 않는다. */
export function intervalOf(cfg: Config, fast: boolean): number {
  const floor = Math.max(1, cfg.min_interval_seconds ?? 5);
  const asked = fast ? cfg.fast_interval_seconds : cfg.poll_interval_seconds;
  return Math.max(floor, asked ?? 60);
}

/** 상태 파일에 곳마다 적어 두는 것. */
export interface PlaceEntry {
  name?: string;
  /** 지난번에 등록이 열려 있었는가. 바뀌는 순간만 알리려고 들고 있는다. */
  open?: boolean;
  full?: boolean;
  /** 시간표를 한 줄로 접은 것. 이게 달라지면 시간표가 바뀐 것이다. */
  hours_mark?: string;
  seen_at?: string;
  opened_at?: string;
  closed_at?: string;
}

export interface State {
  places?: Record<string, PlaceEntry>;
  beat_at?: string;
  [key: string]: unknown;
}

export function loadState(): State {
  if (!existsSync(STATE_PATH)) return { places: {} };
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as State;
  } catch {
    // 깨진 상태 파일 때문에 감시를 못 켜는 것이 더 나쁘다. 처음부터 다시 센다.
    return { places: {} };
  }
}

export function saveState(state: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/** 상태 파일에서 이곳의 자리. 없으면 만들어 준다. */
export function entryOf(state: State, slug: string): PlaceEntry {
  const places = (state.places ??= {});
  return (places[slug] ??= {});
}
