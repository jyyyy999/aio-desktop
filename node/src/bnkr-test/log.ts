/**
 * 로그. 파일에는 전부 적고, 화면에는 지금 볼 것만 보여 준다.
 *
 * 파이썬 판과 **같은 파일에 같은 형식으로** 적는다. 어느 쪽으로 돌렸든 "그때 무슨 일이
 * 있었나" 를 한 파일에서 이어 읽을 수 있어야 한다 — 담긴 기록도 설정도 이미 공유한다.
 *
 * 부르는 쪽은 무엇을 적을지만 정하고, 어떤 기호로 보일지는 kind 로 말한다. 이렇게 해
 * 두면 화면 꾸미는 일이 코드 곳곳에 번지지 않는다.
 */
import { appendFileSync } from "node:fs";
import { LOG_PATH } from "./config.js";
import { UI, type Kind } from "./ui.js";

function fileStamp(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ` +
    `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
}

/**
 * 적어 넣을 파일. 기본은 bnkr 쪽이고, 네이버 판이 켜지면 그쪽으로 바꾼다
 * (`naver/config.ts` 가 들여지는 순간 바뀐다).
 *
 * 프로그램 하나에 로그 파일 하나다. 두 판이 한 파일에 섞여 쌓이면 "그때 무슨 일이
 * 있었나" 를 이어 읽을 수가 없다 — 로그를 한 파일에 모으는 것과는 다른 이야기다.
 */
let logPath: string = LOG_PATH;

export function useLogFile(path: string): void {
  logPath = path;
}

function toFile(level: string, text: string): void {
  try {
    appendFileSync(logPath, `${fileStamp()} [${level}] ${text}\n`, "utf-8");
  } catch {
    // 파일에 못 적는다고 하던 일을 멈출 이유는 없다.
  }
}

let quiet = false;
/** 다른 화면을 쓰는 쪽(러너 따위)이 부른다. 파일에는 그대로 적힌다. */
export function quietConsole(on: boolean): void {
  quiet = on;
}

function emit(level: string, kind: Kind, text: string): void {
  toFile(level, text);
  if (!quiet) UI.line(text, kind);
}

export const log = {
  info: (text: string) => emit("INFO", "info", text),
  warn: (text: string) => emit("WARNING", "warn", text),
  error: (text: string) => emit("ERROR", "err", text),
  /** 파일에만. 왜 그랬는지 따질 때만 보는 것들 (BNKR_DEBUG·NAVER_DEBUG=1 이면 화면에도). */
  debug: (text: string) => {
    if (!process.env["BNKR_DEBUG"] && !process.env["NAVER_DEBUG"]) return;
    emit("DEBUG", "info", text);
  },
};

export const sayOk = (text: string) => emit("INFO", "ok", text);
export const sayStep = (text: string) => emit("INFO", "step", text);
export const sayStar = (text: string) => emit("INFO", "star", text);

/** 기다리는 중에 보이는 줄. 화면에서는 제자리에서 고쳐 쓰고, 파일에는 그대로 쌓인다. */
export function tick(text: string): void {
  toFile("INFO", text);
  if (!quiet) UI.status(text);
}
