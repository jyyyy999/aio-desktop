/**
 * 모니터의 규칙. 폼(화면)과 main(저장·시작)이 같은 답을 내게 여기 둔다. 타입은 types.ts 에 있다.
 */
import { SITES } from "./sites.js";
import type { MonitorInput, MonitorOnFound, MonitorStatus, SiteId, TimingDefaults } from "./types.js";

export const MONITOR_STATUS_LABEL: Record<MonitorStatus, string> = {
  idle: "대기",
  monitoring: "확인 중",
  found: "재고 발견",
  paused: "일시정지",
  stopping: "멈추는 중",
  stopped: "중지됨",
  error: "오류",
};

/** 프로세스가 도는 상태. 목록의 "실행 중" 묶음. */
export const MONITOR_RUNNING: readonly MonitorStatus[] = ["monitoring", "found", "stopping"];

/**
 * 간격에 붙는 경고 (막지는 않는다 — 막는 것은 monitorProblem).
 *   롯데   씨앗 하한(min_interval_seconds, 기본 5초)보다 짧으면 드랍 걸음(--drop)으로 돈다
 *   네이버 상품 하나를 이 간격으로 보면 분당 요청이 원본의 권장선(10회/분)을 넘는다 — 6초보다 짧으면
 */
export function monitorIntervalWarning(site: SiteId, ms: number, timing: TimingDefaults): string | null {
  if (site === "lotte" && ms < timing.minIntervalMs) {
    return `${timing.minIntervalMs / 1000}초 미만은 드랍 모드로 실행됩니다. 봇 차단 위험이 높아집니다.`;
  }
  if (timing.rateWarnPerMin !== null && 60 / Math.max(Math.ceil(ms / 1000), 1) > timing.rateWarnPerMin) {
    return `네이버 요청 권장선(${timing.rateWarnPerMin}회/분)을 넘습니다. 차단 위험이 있습니다.`;
  }
  return null;
}

/**
 * 이보다 촘촘히는 못 본다.
 *   롯데   0.5초 — 원본 드랍 걸음의 바닥 (watch.ts 의 DROP_FLOOR). 씨앗 하한(min_interval_seconds, 기본 5초)
 *          아래는 드랍 걸음(--drop)으로 돈다
 *   네이버 2초 — 상품 하나를 이보다 자주 보면 원본이 요청률 거부선(분당 30회)에 걸려 시작하지 않는다
 */
export const MONITOR_MIN_INTERVAL_MS: Record<SiteId, number> = { lotte: 500, naver: 2000, bnkr: 3000, supreme: 2500 };

export const ON_FOUND_LABEL: Record<MonitorOnFound, string> = {
  notify: "알림만",
  switch_to_task: "알리고 구매 전환 버튼",
};

/** 이름을 비워 두면 상품번호. */
export function monitorName(input: Pick<MonitorInput, "name" | "site" | "productUrl">): string {
  return input.name.trim() || SITES[input.site].productCode(input.productUrl);
}

/** 만들거나 고칠 수 없는 까닭. 괜찮으면 null. */
export function monitorProblem(m: MonitorInput): string | null {
  const spec = SITES[m.site];
  if (!spec) return `모르는 사이트입니다: ${String(m.site)}`;
  if (!spec.monitors) return `${spec.name}는 모니터를 지원하지 않습니다 — 원본의 드라이런이 한 번만 보고 끝납니다. 태스크로 돌리세요.`;
  if (!spec.isProductUrl(m.productUrl)) return spec.urlError;
  if (!Number.isFinite(m.checkIntervalMs) || m.checkIntervalMs < MONITOR_MIN_INTERVAL_MS[m.site]) {
    return `${spec.name} 모니터는 ${MONITOR_MIN_INTERVAL_MS[m.site] / 1000}초보다 촘촘히 볼 수 없습니다.`;
  }
  if (!Number.isInteger(m.ea) || m.ea < 1) return "수량은 1 이상이어야 합니다.";
  if (!Number.isFinite(m.maxPrice) || m.maxPrice < 0) return "상한가는 0(없음) 이상이어야 합니다.";
  if (m.onFound !== "notify" && m.onFound !== "switch_to_task") return `모르는 발견 시 동작입니다: ${String(m.onFound)}`;
  // 네이버 원본은 조회도 로그인한 브라우저로 한다 (Node fetch 는 429). 롯데는 재고 API 가 공개라 감시에는 없어도 된다.
  if (!m.profileId && m.site === "naver") return "네이버 모니터는 로그인 프로필이 있어야 합니다 — 네이버는 조회도 로그인 세션으로 합니다.";
  // 슈프림은 게스트 체크아웃이라 로그인 없이도 살 수 있다 (프로필은 사람 확인 통과 쿠키용).
  if (!m.profileId && m.site !== "supreme" && m.onFound === "switch_to_task") return "구매 전환을 하려면 로그인 프로필이 필요합니다.";
  return null;
}
