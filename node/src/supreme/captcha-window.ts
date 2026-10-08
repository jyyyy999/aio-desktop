/**
 * 캡차 전용 창 — **흐름**만 담당한다. 창을 실제로 다루는 일은 host 가 한다 (browser.ts 가 구현).
 *
 * 흐름
 *   1. 캡차가 떴나 본다 (probe)
 *   2. 떴으면 캡차 창을 연다/앞으로 가져온다 → **캡차만 남기는 집중 모드**를 걸고 안내 띠를 띄운다
 *   3. 사람이 풀 때까지 돈다 — 집중 모드는 1초마다 다시 건다 (페이지가 다시 그려도 유지)
 *   4. 토큰이 폼에 들어오면 집중 모드를 풀고 이어서 진행한다
 *   5. 시간이 다 되거나 사람이 취소하면 실패로 돌려준다 (앱은 태스크를 멈추고 사람에게 알린다)
 *
 * 자동으로 풀지 않는다. 사람이 푼다는 것이 이 모듈의 전제다.
 */
import {
  type CaptchaProbe,
  focusScript,
  needsHuman,
  probeScript,
  resetScript,
  tokenScript,
  unfocusScript,
  waitNote,
} from "./captcha.js";

export interface CaptchaWindowHost {
  /** 같은 프로필(같은 쿠키)로 창을 띄우거나 이미 뜬 창을 앞으로 가져온다. */
  showCaptchaWindow(opts: { width: number; height: number; onTop: boolean; title: string }): Promise<void>;
  /** 창을 원래 크기·위치로 되돌리고(선택) 집중 모드가 남지 않게 한다. */
  hideCaptchaWindow(): Promise<void>;
  /** 이 창이 지금 캡차를 담고 있는 페이지를 보고 있나. */
  isOnCaptchaPage(): Promise<boolean>;
  /** 창 안에서 스크립트를 돌린다 (본문 프레임). */
  run(script: string): Promise<unknown>;
  /** 로그 한 줄. 사이트 로그 규약을 host 가 안다. */
  note(text: string): void;
  /** 이만큼 기다린다 (취소를 존중). */
  sleep(ms: number): Promise<void>;
  /** 사람이 취소를 눌렀나 (창을 닫았거나 앱이 멈추라고 했나). */
  cancelled(): boolean;
}

export interface CaptchaOptions {
  mode: "hide" | "dim";
  /** 사람이 풀 때까지 기다리는 최대 시간 */
  timeoutMs: number;
  /** 집중 모드를 다시 거는 주기 */
  refreshMs: number;
  bannerText: string;
  /** 아예 창을 안 띄우고 확인만 (사람이 이미 다른 창에서 풀고 있을 때) */
  silent?: boolean;
  /** 확인만 하는 최대 시간 (silent 일 때) */
  probeOnlyTimeoutMs?: number;
}

export const DEFAULT_CAPTCHA_OPTIONS: CaptchaOptions = {
  mode: "hide",
  timeoutMs: 180_000,
  refreshMs: 1000,
  bannerText: "hCaptcha를 직접 풀어 주세요. 다 풀면 자동으로 이어서 진행합니다.",
};

export interface CaptchaOutcome {
  solved: boolean;
  waitedMs: number;
  reason: string;
  /** 몇 번 다시 그려졌나 (집중 모드 재적용 횟수) */
  refreshes: number;
}

function asProbe(value: unknown): CaptchaProbe | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<CaptchaProbe>;
  return typeof p.present === "boolean" ? (p as CaptchaProbe) : null;
}

/** 지금 이 페이지에 사람이 풀 캡차가 있나 (없으면 null) */
export async function probeCaptcha(host: CaptchaWindowHost): Promise<CaptchaProbe | null> {
  return asProbe(await host.run(probeScript()));
}

/** 캡차가 떠 있으면 사람에게 넘기고, 풀릴 때까지 기다린다. */
export async function solveCaptcha(host: CaptchaWindowHost, options: Partial<CaptchaOptions> = {}): Promise<CaptchaOutcome> {
  const opts: CaptchaOptions = { ...DEFAULT_CAPTCHA_OPTIONS, ...options };
  const started = Date.now();

  let probe = await probeCaptcha(host);
  if (!probe || !probe.present) return { solved: false, waitedMs: 0, reason: "캡차 없음", refreshes: 0 };
  if (probe.solved) return { solved: true, waitedMs: 0, reason: "이미 풀려 있음", refreshes: 0 };

  const verdict = needsHuman(probe);
  if (!opts.silent) {
    await host.showCaptchaWindow({ width: 0, height: 0, onTop: true, title: "hCaptcha" });
    await host.run(focusScript(opts.mode, opts.bannerText));
    host.note(`사람이 캡차를 풀 차례입니다 (${verdict.reason}) — 캡차 창을 띄웠습니다`);
  } else {
    host.note(`캡차를 기다립니다 (${verdict.reason})`);
  }

  const limit = opts.silent ? opts.probeOnlyTimeoutMs ?? opts.timeoutMs : opts.timeoutMs;
  let refreshes = 0;
  let lastNote = 0;

  while (Date.now() - started < limit) {
    if (host.cancelled()) {
      await host.run(unfocusScript());
      return { solved: false, waitedMs: Date.now() - started, reason: "사람이 취소함", refreshes };
    }
    await host.sleep(400);

    const token = String((await host.run(tokenScript())) ?? "");
    if (token.length > 20) {
      await host.run(unfocusScript());
      const waited = Date.now() - started;
      host.note(`캡차를 풀었습니다 (${Math.round(waited / 1000)}초) — 이어서 진행합니다`);
      return { solved: true, waitedMs: waited, reason: "토큰 확인", refreshes };
    }

    if (!opts.silent && Date.now() - started - refreshes * opts.refreshMs >= opts.refreshMs) {
      // 페이지가 다시 그려지며 숨김이 풀리거나 문제 창이 새로 뜬 경우를 여기서 다시 잡는다.
      await host.run(focusScript(opts.mode, opts.bannerText));
      refreshes++;
    }

    if (Date.now() - lastNote > 15_000) {
      lastNote = Date.now();
      host.note(waitNote(Date.now() - started, limit));
    }
  }

  await host.run(unfocusScript());
  return { solved: false, waitedMs: Date.now() - started, reason: `제한 시간(${Math.round(limit / 1000)}초) 안에 못 풀었습니다`, refreshes };
}

/** 사람이 틀렸을 때 다시 — 캡차를 되돌리고 다시 기다린다. */
export async function retryCaptcha(host: CaptchaWindowHost, options: Partial<CaptchaOptions> = {}): Promise<CaptchaOutcome> {
  host.note("캡차를 다시 시도합니다");
  await host.run(resetScript());
  await host.sleep(800);
  return solveCaptcha(host, options);
}

/** 결제 전에 사람이 풀 캡차가 있는지만 보고, 있으면 넘긴다. 없으면 곧바로 통과. */
export async function clearCaptchaIfAny(host: CaptchaWindowHost, options: Partial<CaptchaOptions> = {}): Promise<boolean> {
  const probe = await probeCaptcha(host);
  if (!probe || !probe.present || probe.solved) return true;
  const outcome = await solveCaptcha(host, options);
  return outcome.solved;
}
