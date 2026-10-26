/**
 * KREAM 로그 — 집(aio/node)의 공용 로그(`../log.ts`)를 그대로 쓴다.
 * 파일은 KREAM_HOME/kream.log 로 돌린다 — 태스크마다 제 로그를 갖는다.
 */
import { log, sayOk, sayStar, sayStep, tick, useLogFile } from "../log.js";
import { LOG_PATH } from "./config.js";

export { log, sayOk, sayStar, sayStep, tick };

/** 이 모듈의 로그 파일로 바꾼다 (index.ts 가 가장 먼저 부른다). */
export function useKreamLog(): void {
  useLogFile(LOG_PATH);
}
