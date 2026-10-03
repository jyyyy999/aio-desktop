/**
 * 대기열에 걸렸는지 알아본다. bnkr_queue.py 와 같은 판정을 한다.
 *
 * 이 사이트에 대기열은 없다(2026-08-12 확인). 그래도 이 파일이 있는 이유는,
 * **대기열을 못 알아보면 하는 짓이 정확히 반대**여서다.
 *
 *   주문서가 안 열림  → 창을 닫고 다시 연다  → 대기열이면 순번을 버린다
 *   조회가 계속 실패  → 세션을 새로 만든다   → 대기열이면 처음부터 다시 줄 선다
 *   5초마다 다시 본다 → 두드린다             → 대기열은 기다리라는 뜻이다
 *
 * 대기열은 에러가 아니라 지시다. 그걸 에러로 읽으면 줄을 섰다가 스스로 나가기를 반복한다.
 * 그래서 "무엇이 대기열인가" 만 여기서 판정하고, 어떻게 기다릴지는 부르는 쪽이 정한다.
 */

// 대기열 솔루션들이 화면이나 주소에 남기는 말. 국내는 NetFUNNEL(STCLab) 이 가장 흔하다.
export const DEFAULT_MARKERS = [
  "netfunnel", "NetFunnel", "ts.wseq",
  "queue-it", "queueit", "surfoffice",
  "대기열", "대기번호", "접속대기", "waitingroom", "waiting_room",
  "잠시 후 다시", "접속자가 많아",
];

const POSITION_RE = /(?:대기\s*(?:번호|순번|인원)|앞에)\D{0,10}([\d,]{1,9})/;
const SECONDS_RE = /(?:약\s*)?([\d,]{1,6})\s*(?:초|second)/;

/**
 * 이 응답이 대기열 화면인가. → 걸린 표시 (아니면 null)
 *
 * 주소와 본문 둘 다 본다. 대기열은 주소를 바꿔 보내기도 하고, 같은 주소에 다른 화면을
 * 그려 주기도 한다.
 */
export function looksLike(text: string, url = "", markers?: string[] | null): string | null {
  const words = markers ?? DEFAULT_MARKERS;
  const haystack = `${url}\n${text || ""}`.toLowerCase();
  for (const word of words) {
    if (haystack.includes(word.toLowerCase())) return word;
  }
  return null;
}

/** 화면에서 순번과 예상 시간을 주워 온다. 못 찾아도 그만이다. */
export function hint(text: string): string {
  const parts: string[] = [];
  const at = POSITION_RE.exec(text || "");
  if (at) parts.push(`앞에 ${at[1]}명`);
  const secs = SECONDS_RE.exec(text || "");
  if (secs) parts.push(`예상 ${secs[1]}초`);
  return parts.join(" · ");
}

/** 대기열에 걸렸을 때. SiteError 와 일부러 갈라 놨다 — 고장은 다시 두드리는 게 맞지만
 *  대기열은 그 반대라, 같은 걸로 묶으면 재시도가 정확히 해로운 쪽으로 작동한다. */
export class QueueWait extends Error {
  constructor(public mark: string, public note = "") {
    super(`대기열에 걸렸습니다 (${mark})` + (note ? ` · ${note}` : ""));
  }
}
