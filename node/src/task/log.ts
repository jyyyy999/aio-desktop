/**
 * 통합 러너의 로그. 파일(task-buy.log)에는 전부 적고, 화면은 공용 UI 로 보여 준다.
 *
 * bnkr-test/log.ts 와 root log.ts 가 저마다 제 파일을 붙들고 있어서(그래야 사이트별
 * 로그가 갈라진다), 러너 자신의 말도 제 파일이 필요하다. 화면은 세 판이 다 같은
 * Console_(src/ui.ts) 하나를 쓴다.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { BASE } from "../bnkr-test/config.js";
import { UI, type Kind } from "../ui.js";

export const TASK_LOG_PATH = join(BASE, "task-buy.log");

let logPath: string = TASK_LOG_PATH;

function fileStamp(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ` +
    `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
}

function toFile(level: string, text: string): void {
  try {
    appendFileSync(logPath, `${fileStamp()} [${level}] ${text}\n`, "utf-8");
  } catch {
    // 파일에 못 적는다고 하던 일을 멈출 이유는 없다.
  }
}

function emit(level: string, kind: Kind, text: string): void {
  toFile(level, text);
  UI.line(text, kind);
}

export const log = {
  info: (text: string) => emit("INFO", "info", text),
  warn: (text: string) => emit("WARNING", "warn", text),
  error: (text: string) => emit("ERROR", "err", text),
};

export const sayOk = (text: string) => emit("INFO", "ok", text);
export const sayStep = (text: string) => emit("INFO", "step", text);
export const sayStar = (text: string) => emit("INFO", "star", text);
