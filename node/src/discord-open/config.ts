/**
 * 설정.
 *
 * 다른 판과 마찬가지로 프로젝트 뿌리에 이름을 맞춰 둔다.
 *
 *   discord_open_config.json   설정 (봇 토큰·볼 채널·크롬)
 *   discord-open.log           전부 적는 곳
 *
 * 우리 웹훅이 보낸 알림을 **읽기만** 한다. 봇은 아무 말도 하지 않는다.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useLogFile } from "../log.js";

/** 프로젝트 뿌리. waitwhile 판과 같은 방법으로 찾는다. */
function findBase(): string {
  const env = (process.env["DISCORD_OPEN_HOME"] || "").trim();
  if (env) return resolve(env);
  let here = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(here, "discord_open_config.json")) || existsSync(join(here, "bnkr_buy.py"))) {
      return here;
    }
    here = dirname(here);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export const BASE = findBase();
export const CONFIG_PATH = join(BASE, "discord_open_config.json");
export const LOG_PATH = join(BASE, "discord-open.log");

// 들이는 순간 로그를 이쪽으로 돌린다. 인자 오류까지 이 파일에 남아야 한다.
useLogFile(LOG_PATH);

export interface Config {
  /** 디스코드 개발자 포털에서 만든 봇의 토큰. 환경변수 DISCORD_BOT_TOKEN 이 있으면 그쪽이 먼저다. */
  bot_token: string;
  /** 볼 채널 아이디. 비우면 봇이 들어가 있는 모든 채널을 본다. */
  channel_ids: string[];
  /**
   * 웹훅이 보낸 메시지만 볼까. 켜 두면 채널에서 사람이 링크를 붙여도 창이 안 뜬다.
   * 알림은 전부 우리 도구가 웹훅으로 보낸 것이다.
   */
  webhook_only: boolean;
  /** 비어 있지 않으면, 알림 글(제목·본문·필드)에 이 중 하나가 들어 있을 때만 연다. */
  keywords: string[];
  /** 이 말이 들어 있으면 열지 않는다. 예: "마감", "하트비트" */
  skip_keywords: string[];
  /** 같은 주소를 이 시간 안에 다시 받으면 또 열지 않는다. 알림이 겹쳐 와도 창이 쌓이지 않게. */
  reopen_after_seconds: number;
  /** 크롬 실행 파일. 비우면 흔한 자리에서 찾는다. */
  chrome_path: string;
  /** 크롬에 같이 넘길 인자. 기본은 새 창. 탭으로 열고 싶으면 [] 로. */
  chrome_args: string[];
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: Config = {
  bot_token: "",
  channel_ids: [],
  webhook_only: true,
  keywords: [],
  skip_keywords: [],
  reopen_after_seconds: 60,
  chrome_path: "",
  chrome_args: ["--new-window"],
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    throw new Error(
      `${basename(CONFIG_PATH)} 을 만들었습니다. bot_token 을 넣고 다시 실행해 주세요.\n` +
      `  (만드는 법은 node/README-discord-open.md)`,
    );
  }
  const own = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...own };
}

export function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

export function tokenOf(cfg: Config): string {
  return (process.env["DISCORD_BOT_TOKEN"] || cfg.bot_token || "").trim().replace(/^Bot\s+/i, "");
}
