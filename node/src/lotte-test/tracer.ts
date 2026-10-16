/**
 * 롯데온 대기열 — TRACER ("대량접속제어서버"). (2026-10-03)
 *
 * MEGA 30th 예약판매(10:00, 딜 150개)에서 처음 만났다. 10:00:00 에 API 로 열린 것을 봤고
 * 크롬을 띄웠는데, 상품 페이지 대신 이 대기 화면이 떴다. 원본은 그걸 몰라서 구매 버튼을
 * 20초 찾다가 실패로 치고 **크롬을 닫고 새 크롬을 띄웠다** — 세 번. 순번은 쿠키에 붙어 있어
 * 새 크롬(빈 임시 프로필)은 매번 맨 뒤에 다시 섰다. 10:01:11 에 딜 0/150 이었다.
 *
 * 생김새 (상품 페이지 주소 그대로, 본문만 3KB 짜리로 바뀌어 온다):
 *
 *   <input type="hidden" id="isWait" value="T">            T 대기 / F 통과 / R 차단 / NE 못 받음
 *   <input type="hidden" id="waitCnt" value="273">
 *   <input type="hidden" id="tracer_domain" value="tracer-ext-lecs.lotteon.com">
 *   <input type="hidden" id="session_time_out" value="30">
 *   <input type="hidden" id="limitCnt" value="200">
 *   <div id="app"></div>   ← foCommon 의 TracerPage(vue) 가 그린다. 루트가 div.wrap
 *
 * 화면 스크립트(foCommon.v1.0.umd.min.TracerPage.js)가 하는 일:
 *   - 쿠키 wcCookie (.lotteon.com, 365일) 가 없으면 만든다. **이것이 줄에서의 내 이름이다.**
 *   - 1초마다 POST https://{tracer_domain}:8180/TRACERAPI/inputQueue.do 로 순번을 묻는다.
 *   - 답이 F 면 location.reload() — 같은 주소에 진짜 상품 페이지가 뜬다.
 *   - 답을 못 받아도 reload 한다.
 *   - R 은 "서비스 접속이 차단되었어요 — 현재 접속하신 아이피에서는 접속이 불가능해요"
 *   - NE(limitCnt 0)는 "서비스 접속이 어려워요 — 잠시 후 다시 시도해주겠어요?" 로 멈춘다.
 *
 * 브라우저 창으로 직접 서 봤다 (10:07, 끝난 뒤의 줄): 내 순번 78 · 전체 81 · 예상 12초 →
 * 12초쯤 뒤 reload 되어 상품 페이지("품절된 상품입니다")가 떴다.
 *
 * **여기서 하는 일은 사람처럼 줄을 서 있는 것뿐이다.** 창을 닫지 않고, 새로 고치지 않고,
 * 화면 스크립트가 알아서 넘겨 줄 때까지 기다린다. 줄을 건너뛰는 길(주문 API 를 바로
 * 부르기, 쿠키를 지어내기, 창을 여러 개 띄워 여러 번 서기)은 쓰지 않는다 — 공정하게 줄을
 * 세우려는 장치를 피해 가는 일이고, R(아이피 차단)을 부르는 지름길이기도 하다.
 */
import type { WebDriver } from "selenium-webdriver";
import { log, tick } from "../log.js";
import { sleep } from "../util.js";

/** 대기열에서 진 것의 사유는 모두 이것으로 시작한다. order.ts 의 lostRace 가 이걸 본다. */
export const QUEUE_PREFIX = "대기열";

export interface TracerState {
  /** T 대기 / F 통과 / R 차단 / NE 못 받음 */
  result: string;
  /** 화면이 "현재 N명의 고객님이 대기중이에요" 로 보이는 수 */
  ahead: number;
  /** 내 순번 (waitMyCnt) */
  mine: number;
  /** 줄 전체 (waitQueueSize) */
  total: number;
  /** 화면 스크립트가 셈한 남은 시간(초) = session_time_out / limitCnt × waitCnt */
  eta: number;
}

/**
 * 지금 화면이 대기 화면이면 그 상태, 아니면 null.
 *
 * 숨은 칸(#tracer_domain)은 서버가 HTML 에 박아 보내서 화면 스크립트가 돌기 전부터 있다.
 * 값은 화면 스크립트가 1초마다 고쳐 쓰는 vue 의 것을 먼저 보고, 없으면 숨은 칸을 본다.
 */
const TRACER_JS = `
if (!document.getElementById('tracer_domain')) return document.readyState === 'loading' ? 'loading' : null;
function v(id) { var el = document.getElementById(id); return el ? el.value : ''; }
var root = document.querySelector('.wrap');
var vm = (root && root.__vue__) || {};
return {
  result: String(vm.waitResult || v('isWait') || ''),
  ahead: Number(vm.waitCnt || v('waitCnt') || 0),
  mine: Number(vm.waitMyCnt || 0),
  total: Number(vm.waitQueueSize || 0),
  eta: Number(vm.waitTime || 0)
};
`;

/** 대기 화면의 상태 / null (대기 화면이 아님이 확실) / "unknown" (reload 하는 틈·alert·문서가 덜 그려짐) */
async function peek(driver: WebDriver): Promise<TracerState | null | "unknown"> {
  try {
    const got = await driver.executeScript<TracerState | null | "loading">(TRACER_JS);
    return got === "loading" ? "unknown" : got;
  } catch {
    return "unknown";
  }
}

/** 지금 화면이 대기 화면이면 그 상태, 아니면(또는 모르겠으면) null. */
export async function readTracer(driver: WebDriver): Promise<TracerState | null> {
  const got = await peek(driver);
  return got === "unknown" ? null : got;
}

function lineOf(s: TracerState): string {
  return [
    `내 앞 ${s.ahead.toLocaleString()}명`,
    s.total ? `줄 ${s.total.toLocaleString()}명` : "",
    s.eta ? `예상 ${s.eta}초` : "",
  ].filter(Boolean).join(" · ");
}

/** 대기열에서 진 사유. 이게 남으면 이번 판은 접는다. */
const BLOCKED = `${QUEUE_PREFIX}(TRACER)가 이 아이피를 막았습니다 — 서비스 접속이 차단되었어요`;
const REFUSED = `${QUEUE_PREFIX}(TRACER)가 입장을 받지 않습니다 — 서비스 접속이 어려워요 (잠시 후 다시)`;

/**
 * 대기 화면이면 차례가 올 때까지 기다린다. → null (통과했거나 처음부터 대기 화면이 아님) / 사유
 *
 * 통과는 "대기 화면이 사라졌다" 로 안다. 화면 스크립트가 F 를 받으면 reload 해서 같은 주소에
 * 진짜 페이지를 받아 오기 때문이다. reload 하는 사이(스크립트가 안 도는 짧은 틈)는 모르는
 * 것으로 두고 조금 더 본다.
 *
 * 기다리는 동안 상태 줄(tick)을 고쳐 쓴다 — 데스크톱 태스크 창에도 그 줄이 뜬다. 감시가 따로
 * 돌고 있을 때(warm.ts)는 그 상태 줄과 다투지 않게 say 로 다른 데 적는다. 바뀔 때마다
 * 로그 파일에도 한 줄씩 남는다. 다음 드랍에서 줄이 얼마나 빨리 줄었는지 볼 재료다.
 */
export async function waitTracer(
  driver: WebDriver, maxSeconds: number, say: (line: string) => void = tick,
  /** 읽을 때마다 상태를 넘긴다 (warm.ts 가 순번 기록에 쓴다) */
  watch?: (s: TracerState) => void,
): Promise<string | null> {
  const s = await readTracer(driver);
  if (!s) return null;
  watch?.(s);

  const started = Date.now();
  const deadline = started + Math.max(1, maxSeconds) * 1000;
  log.warn(`${QUEUE_PREFIX}(TRACER)에 섰습니다 — ${lineOf(s)}. 창을 닫거나 새로 고치지 않고 차례를 기다립니다 (최대 ${maxSeconds}초)`);

  let said = "";
  let last = s;
  let now: TracerState | null | "unknown" = s;
  while (Date.now() < deadline) {
    if (now === null) {
      // 스크립트가 돌았고, 다 그려진 문서에 대기 화면의 숨은 칸이 없다 — reload 로 넘어왔다.
      log.info(`${QUEUE_PREFIX}을 통과했습니다 (${Math.round((Date.now() - started) / 1000)}초 기다림)`);
      return null;
    }
    if (now !== "unknown") {
      last = now;
      watch?.(now);
      if (now.result === "R") return BLOCKED;
      if (now.result === "NE") return REFUSED;
      const line = `${QUEUE_PREFIX} ${lineOf(now)} · ${Math.round((Date.now() - started) / 1000)}초째`;
      if (line !== said) {
        say(line);
        said = line;
      }
    }
    await sleep(500);
    now = await peek(driver);
  }
  return `${QUEUE_PREFIX}에서 ${maxSeconds}초를 기다렸지만 차례가 오지 않았습니다 (마지막: ${lineOf(last)})`;
}

/** 크롬 없이 본 대기열. 상품 페이지를 HTTP 로 받으면 서버가 박아 보내는 숨은 칸들이다. */
export interface Gate {
  /** 대기 화면이 왔는가 (isWait T) */
  waiting: boolean;
  /** 지금 줄에 선 사람 (waitCnt) */
  count: number;
  /** 통과시키는 자리 수 (limitCnt) */
  limit: number;
  /** 한 자리의 수명(초) (session_time_out) */
  session: number;
  /** 지금 서면 기다릴 어림(초). 화면 스크립트의 setWaitTime 과 같은 셈이다. */
  eta: number;
}

const hidden = (html: string, id: string): string =>
  new RegExp(`id="${id}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? "";

/** 상품 페이지 HTML → 대기열 상태. 대기 화면이 아니면 waiting false · eta 0. */
export function gateOf(html: string): Gate {
  if (!hidden(html, "tracer_domain")) return { waiting: false, count: 0, limit: 0, session: 0, eta: 0 };
  const count = Number(hidden(html, "waitCnt")) || 0;
  const limit = Number(hidden(html, "limitCnt")) || 0;
  const session = Number(hidden(html, "session_time_out")) || 0;
  const waiting = hidden(html, "isWait") === "T";
  return { waiting, count, limit, session, eta: waiting && limit ? Math.round((session / limit) * count) : 0 };
}
