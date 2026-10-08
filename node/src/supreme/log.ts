/**
 * 슈프림 로그 — 집(aio/node)의 공용 로그(`../log.ts`)를 그대로 쓴다.
 *
 * 화면 한 줄은 `17:55:37  ✔  <말>` 모양이고, 기호는 kind 가 정한다 (log.ts 의 MARKS):
 *   ok ✔ · info · · step ▸ · warn ! · err ✖ · star ★
 * 데스크톱의 태스크 창은 이 줄에서 시각만 떼어 보여 준다 (taskManager.ts 의 STAMP).
 *
 * 파일은 SUPREME_HOME/supreme.log 로 돌린다 — 태스크마다 제 로그를 갖는다.
 */
import { log, quietConsole, sayOk, sayStar, sayStep, tick, useLogFile } from "../log.js";
import { LOG_PATH } from "./config.js";
import type { WatchLog } from "./watch.js";

export { log, quietConsole, sayOk, sayStar, sayStep, tick };

/** 이 모듈을 들이는 순간 로그 파일을 슈프림 것으로 바꾼다 (index.ts 가 가장 먼저 부른다). */
export function useSupremeLog(): void {
  useLogFile(LOG_PATH);
}

/** 감시 루프가 쓰는 모양으로 맞춘 것. */
export function watchLog(): WatchLog {
  return {
    note: (text: string) => log.info(text),
    ok: (text: string) => sayOk(text),
    warn: (text: string) => log.warn(text),
    error: (text: string) => log.error(text),
    step: (text: string) => sayStep(text),
    tick: (text: string) => tick(text),
  };
}
