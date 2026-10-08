/**
 * **Shopify 체크포인트** — 장바구니에서 체크아웃으로 넘어갈 때 `/checkpoint?return_to=…` 로 돌려 hCaptcha 를 끼운다
 * (2026-10-08 실사이트 확인: 주소가 shop.supreme.com/checkpoint?... 이고, 다 푼 뒤 버튼을 눌러야 넘어간다).
 *
 * 흐름
 *   1. 체크포인트 주소인지 본다
 *   2. 캡차가 그려질 때까지 잠깐 기다린 뒤 **캡차 창을 띄워 사람이 푼다** (captcha-window.ts — 자동으로 풀지 않는다)
 *   3. 토큰이 들어오면 그 폼의 버튼을 **대신 누른다** — 캡차만 보이는 창에서는 버튼이 숨겨져 사람이 못 누른다
 *   4. 체크포인트를 벗어날 때까지 기다린다. 다시 체크포인트면(토큰 만료·오답) 한 번 더 사람에게 넘긴다
 *
 * 체크포인트에서는 **주소를 다시 열지 않는다** — 다시 열면 캡차가 처음부터 다시 그려져 사람이 풀던 것이 날아간다.
 */
import { type CaptchaOptions, type CaptchaWindowHost, probeCaptcha, solveCaptcha } from "./captcha-window.js";

export interface CheckpointHost extends CaptchaWindowHost {
  url(): Promise<string>;
}

/** 체크포인트 주소인가 — `/checkpoint`, `/checkpoint?return_to=/checkout` … */
export function isCheckpointUrl(url: string | null | undefined): boolean {
  const text = String(url || "");
  try {
    return /^\/checkpoint(?:\/|$)/i.test(new URL(text).pathname);
  } catch {
    return /(^|\/\/[^/]+)\/checkpoint(?:[/?#]|$)/i.test(text);
  }
}

/** 토큰이 들어간 폼의 제출 버튼을 누른다 (없으면 폼을 제출한다). */
export function submitCheckpointScript(): string {
  return `(() => {
  const token = document.querySelector('textarea[name="h-captcha-response"], input[name="h-captcha-response"]');
  const form = (token && token.closest("form"))
    || document.querySelector('form[action*="checkpoint"]')
    || [...document.forms].find((f) => f.querySelector('iframe[src*="hcaptcha"], .h-captcha'))
    || document.forms[0];
  if (!form) return { ok: false, reason: "체크포인트 폼 없음" };
  const button = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  if (button && !button.disabled) {
    button.click();
    return { ok: true, how: "버튼 클릭", label: (button.textContent || button.value || "").trim().slice(0, 40) };
  }
  if (typeof form.requestSubmit === "function") form.requestSubmit(); else form.submit();
  return { ok: true, how: "폼 제출" };
})()`;
}

export interface CheckpointOutcome {
  ok: boolean;
  reason: string;
}

/**
 * 체크포인트를 사람과 함께 넘는다. 체크포인트가 아니면 곧바로 ok.
 * @param tries 다시 체크포인트로 돌아오면 몇 번까지 다시 사람에게 넘길지
 */
export async function passCheckpoint(
  host: CheckpointHost,
  options: { captcha?: Partial<CaptchaOptions>; leaveTimeoutMs?: number; tries?: number } = {},
): Promise<CheckpointOutcome> {
  const tries = Math.max(1, options.tries ?? 2);
  const leaveTimeoutMs = options.leaveTimeoutMs ?? 20_000;
  if (!isCheckpointUrl(await host.url())) return { ok: true, reason: "체크포인트 아님" };

  for (let attempt = 1; attempt <= tries; attempt++) {
    host.note(`체크아웃 전 사람 확인(체크포인트)이 떴습니다 — 캡차 창을 엽니다${attempt > 1 ? ` (${attempt}번째)` : ""}`);

    // hCaptcha 는 늦게 그려진다 — 없다고 바로 넘어가면 토큰 없이 제출해 같은 화면으로 돌아온다.
    let probe = await probeCaptcha(host);
    const drawUntil = Date.now() + 15_000;
    while ((!probe || !probe.present) && Date.now() < drawUntil && !host.cancelled()) {
      await host.sleep(500);
      probe = await probeCaptcha(host);
    }
    if (host.cancelled()) return { ok: false, reason: "사람이 멈췄습니다" };

    if (probe?.present && !probe.solved) {
      const outcome = await solveCaptcha(host, {
        ...options.captcha,
        bannerText: "체크아웃 전 사람 확인입니다 — hCaptcha 를 풀어 주세요. 버튼은 자동으로 누릅니다.",
      });
      if (!outcome.solved) return { ok: false, reason: `체크포인트 캡차를 못 풀었습니다 — ${outcome.reason}` };
    }

    // 사람이 이미 버튼까지 눌러 넘어갔을 수 있다.
    if (isCheckpointUrl(await host.url())) {
      let sent: { ok?: boolean; how?: string; reason?: string } | null = null;
      try {
        sent = (await host.run(submitCheckpointScript())) as typeof sent;
      } catch {
        sent = { ok: true, how: "제출 중 페이지가 바뀜" };
      }
      if (!sent?.ok) return { ok: false, reason: `체크포인트를 제출하지 못했습니다 — ${sent?.reason ?? "?"}` };
      host.note(`체크포인트를 제출했습니다 (${sent.how ?? ""})`);
    }

    const until = Date.now() + leaveTimeoutMs;
    while (Date.now() < until && !host.cancelled()) {
      await host.sleep(500);
      let now = "";
      try {
        now = await host.url();
      } catch {
        continue;
      }
      if (now && !isCheckpointUrl(now)) {
        host.note("체크포인트를 통과했습니다 — 체크아웃으로 이어 갑니다");
        return { ok: true, reason: attempt > 1 ? `체크포인트 통과 (${attempt}번째)` : "체크포인트 통과" };
      }
    }
    // 아직 체크포인트 — 토큰이 만료됐거나 틀렸다. 페이지가 새 캡차를 그렸을 것이니 다시 넘긴다.
  }
  return { ok: false, reason: `체크포인트를 ${tries}번 넘지 못했습니다` };
}
