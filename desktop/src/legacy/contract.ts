/**
 * 원본과 맞대 보는 곳. **런타임에는 없다** — `npm run typecheck` 때만 컴파일된다
 * (tsconfig.legacy.json, 아무것도 굽지 않는다).
 *
 * 원본은 경로 별칭(@lotte/* · @naver/* · @bnkr/*)으로 **타입만** 들인다. 원본을 실제로 들이는 것은
 * 워커가 런타임에 **원래 자리에서** 한다 — 원본이 제 위치(import.meta)로 설정·세션 파일을
 * 찾고, 제 node_modules 에서 셀레니움·Playwright 를 찾기 때문이다. 별칭으로 묶어 옮기면
 * 그 둘이 다 어긋난다.
 *
 * 여기서는 우리가 원본에 넘기는 것(--action 값, 설정에 쓰는 대상 한 줄, 요청률 선, 간격·재시도
 * 칸, 모니터가 적는 칸)이 원본이 받는 것과 같은지 본다. 원본이 바뀌어 어긋나면 typecheck 가 여기서 깨진다.
 */
import type { ACTIONS as LotteActions, Config as LotteConfig, TargetSpec } from "@lotte/config.js";
import type { ACTIONS as NaverActions, BuyConfig as NaverBuyConfig, Config as NaverConfig } from "@naver/types.js";
import type { LOGIN_PATH as LotteLoginPath } from "@lotte/http.js";
import type { RATE_HARD_PER_MIN, RATE_WARN_PER_MIN } from "@naver/watch.js";
import type { ACTIONS as BnkrActions } from "@bnkr/browser.js";
import type { Config as BnkrConfig } from "@bnkr/config.js";
import type { Target as BnkrTarget } from "@bnkr/targets.js";
import type { BnkrTaskTarget, BnkrTimingFields } from "../main/sites/bnkr.js";
import type { SupremeMonitorFields, SupremeTaskTarget, SupremeTimingFields } from "../main/sites/supreme.js";
import type { BuyConfig, SupremeConfig, Target as SupremeTarget } from "@supreme/config.js";
import type { LOTTE_LOGIN_PATH, LotteMonitorFields, LotteTaskTarget, LotteTimingFields } from "../main/sites/lotte.js";
import type { NAVER_RATE, NaverMonitorFields } from "../main/sites/naver.js";
import type { BNKR_ACTIONS, LOTTE_ACTIONS, NAVER_ACTIONS } from "../shared/sites.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
/** 색인 서명([key: string]: unknown)을 뺀, 이름이 박힌 칸만. 롯데 Config 는 아무 칸이나 받는 서명이 있다. */
type KnownKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

export type Contract = [
  // --action: 화면이 고르게 하는 값 = 원본이 받는 값
  Assert<Same<(typeof LOTTE_ACTIONS)[number], (typeof LotteActions)[number]>>,
  Assert<Same<(typeof NAVER_ACTIONS)[number], (typeof NaverActions)[number]>>,
  // 롯데 태스크 설정의 대상 한 줄이 원본 TargetSpec 과 같은 칸, 맞는 타입이다
  Assert<LotteTaskTarget extends TargetSpec ? true : false>,
  Assert<Same<keyof LotteTaskTarget, keyof TargetSpec>>,
  // 네이버 태스크끼리 더해 막는 요청률 선 = 원본 watch.ts 의 선
  Assert<Same<(typeof NAVER_RATE)["warn"], typeof RATE_WARN_PER_MIN>>,
  Assert<Same<(typeof NAVER_RATE)["hard"], typeof RATE_HARD_PER_MIN>>,
  // 네이버 "결제 단계까지" 설명이 기대는 칸 — 비밀번호 뒤 마지막 확인 (buy.finish_steps)
  Assert<NaverBuyConfig["finishSteps"] extends string[] ? true : false>,
  // 간격·재시도: 롯데는 우리가 적는 칸이 원본 Config 에 이름이 박힌 칸이고 타입이 맞다
  Assert<keyof LotteTimingFields extends KnownKeys<LotteConfig> ? true : false>,
  Assert<Required<LotteTimingFields> extends Pick<LotteConfig, keyof LotteTimingFields> ? true : false>,
  // 네이버는 설정을 날 JSON(snake_case)으로 읽어 camelCase 로 옮긴다 — 옮겨진 쪽에 그 칸이 있는지 본다
  Assert<NaverConfig["checkIntervalSeconds"] extends number ? true : false>,
  Assert<Pick<NaverBuyConfig, "maxAttempts" | "retryDelaySeconds" | "maxBuysPerRun"> extends Record<string, number> ? true : false>,
  Assert<NaverBuyConfig["stopAfterSuccess"] extends boolean ? true : false>,
  // 롯데 로그인 창이 "로그인 페이지" 로 보는 경로 = 원본이 로그아웃으로 보는 경로
  Assert<Same<typeof LOTTE_LOGIN_PATH, typeof LotteLoginPath>>,
  // 간편결제 비밀번호·웹훅: 롯데 태스크 설정에 적는 칸 / 네이버가 읽어 옮기는 칸
  Assert<"pg_password" | "discord_webhook_url" extends KnownKeys<LotteConfig> ? true : false>,
  Assert<Pick<LotteConfig, "pg_password" | "discord_webhook_url"> extends Record<string, string> ? true : false>,
  Assert<NaverBuyConfig["pgPassword"] extends string ? true : false>,
  Assert<NaverConfig["discordWebhookUrl"] extends string ? true : false>,
  // 모니터(dry-run 감시): 롯데는 우리가 적는 칸이 원본 Config 에 이름이 박힌 칸이고 타입이 맞다
  Assert<keyof LotteMonitorFields extends KnownKeys<LotteConfig> ? true : false>,
  Assert<Required<Omit<LotteMonitorFields, "targets">> extends Pick<LotteConfig, Exclude<keyof LotteMonitorFields, "targets">> ? true : false>,
  Assert<LotteMonitorFields["targets"] extends LotteConfig["targets"] ? true : false>,
  // 네이버는 날 JSON 을 읽어 옮긴다 — 옮겨진 쪽에 그 칸이 있고 타입이 맞는지 본다
  Assert<NaverMonitorFields["top"]["products"] extends NaverConfig["products"] ? true : false>,
  Assert<NaverMonitorFields["top"]["categories"] extends NaverConfig["categories"] ? true : false>,
  Assert<Pick<NaverBuyConfig, "buyOnRestockOnly" | "stopAfterSuccess"> extends Record<string, boolean> ? true : false>,
  Assert<Pick<NaverBuyConfig, "maxBuysPerRun" | "cooldownMinutes"> extends Record<string, number> ? true : false>,
  // 반다이남코: --action 값 = 원본 ACTIONS
  Assert<Same<(typeof BNKR_ACTIONS)[number], (typeof BnkrActions)[number]>>,
  // 대상 한 줄은 원본 parseTarget 이 읽어 Target 으로 만드는 칸이고 타입이 맞다 (label 은 원본에서 null 도 된다)
  Assert<keyof BnkrTaskTarget extends keyof BnkrTarget ? true : false>,
  Assert<BnkrTaskTarget extends Pick<BnkrTarget, keyof BnkrTaskTarget> ? true : false>,
  // 간격·재시도: 우리가 적는 칸이 원본 Config 에 이름이 박힌 칸이고 타입이 맞다
  Assert<keyof BnkrTimingFields extends KnownKeys<BnkrConfig> ? true : false>,
  Assert<Required<BnkrTimingFields> extends Pick<BnkrConfig, keyof BnkrTimingFields> ? true : false>,
  // 태스크 설정에 비우거나 적는 칸 (쿠키·비밀번호·웹훅·네이버 세션 경로·목록 훑기)
  Assert<"cookie" | "pg_password" | "discord_webhook_url" | "naver_session" | "discover" | "targets" extends KnownKeys<BnkrConfig> ? true : false>,
  Assert<Pick<BnkrConfig, "cookie" | "pg_password" | "discord_webhook_url" | "naver_session"> extends Record<string, string> ? true : false>,
  // 슈프림: 우리가 태스크·모니터 홈에 적는 칸이 원본 설정에 이름이 박힌 칸이고 타입이 맞는가
  Assert<keyof SupremeTaskTarget extends KnownKeys<SupremeTarget> ? true : false>,
  Assert<Required<SupremeTaskTarget> extends Pick<SupremeTarget, keyof SupremeTaskTarget> ? true : false>,
  Assert<keyof SupremeTimingFields extends KnownKeys<SupremeConfig> ? true : false>,
  Assert<Pick<SupremeConfig, "check_interval_ms" | "max_retries" | "retry_delay_ms" | "monitor_duration_ms"> extends Record<string, number> ? true : false>,
  Assert<keyof SupremeMonitorFields extends KnownKeys<SupremeConfig> ? true : false>,
  Assert<keyof SupremeMonitorFields["buy"] extends KnownKeys<BuyConfig> ? true : false>,
  Assert<Pick<SupremeConfig, "targets" | "cookie" | "discord_webhook_url"> extends Pick<SupremeConfig, "targets"> ? true : false>,
];
