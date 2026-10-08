/**
 * hCaptcha — **사람이 손으로 푸는** 자리.
 *
 * 이 앱은 캡차를 자동으로 풀지 않는다. 대신
 *   1. 캡차가 떴는지 알아보고
 *   2. **캡차만 보이는 창**을 만들어 사람에게 넘기고 (focus 모드)
 *   3. 사람이 다 풀면(토큰이 폼에 들어가면) 그대로 이어서 진행한다
 *
 * 왜 캡차만 따로 창에 "복사"하지 않나: hCaptcha 의 체크박스·문제는 cross-origin iframe 이고,
 * 응답 토큰은 **그 페이지의 폼**으로 들어간다. 다른 창에 그려 봐야 토큰이 원래 체크아웃 폼에
 * 닿지 않는다. 그래서 진짜 페이지에서 캡차만 남기고 나머지를 숨긴다 — 사람 눈에는 캡차 전용
 * 창이고, 토큰은 제자리에 들어간다.
 *
 * 페이지 쪽 스크립트만 여기 있다 (드라이버·창 관리는 browser.ts).
 */

export const CAPTCHA_HINTS = ["hcaptcha.com", "hcaptcha", "challenges.cloudflare.com", "turnstile", "recaptcha"];

/** 응답 토큰이 들어가는 칸 (Shopify 체크아웃·커스텀 테마 모두 대비) */
export const TOKEN_FIELDS = [
  'textarea[name="h-captcha-response"]',
  'input[name="h-captcha-response"]',
  'textarea[name="cf-turnstile-response"]',
  'input[name="cf-turnstile-response"]',
  'textarea[name="g-recaptcha-response"]',
  'input[name="g-recaptcha-response"]',
];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CaptchaProbe {
  present: boolean;
  kind: "hcaptcha" | "turnstile" | "recaptcha" | "unknown" | "none";
  frames: { src: string; rect: Rect; visible: boolean }[];
  rect: Rect | null;
  token: string;
  solved: boolean;
  viewport: { w: number; h: number; dpr: number };
  url: string;
  /** 캡차가 안 보이는데 자바스크립트로만 도는 경우 (invisible hCaptcha) */
  scriptOnly: boolean;
}

const HINTS = JSON.stringify(CAPTCHA_HINTS);
const FIELDS = JSON.stringify(TOKEN_FIELDS);

/** 캡차 iframe 들과 응답 토큰 상태를 한 번에 본다. */
export function probeScript(): string {
  return `(() => {
  const hints = ${HINTS};
  const frames = [];
  for (const f of document.querySelectorAll("iframe")) {
    const src = f.getAttribute("src") || "";
    const title = f.getAttribute("title") || "";
    const hay = (src + " " + title).toLowerCase();
    if (!hints.some((h) => hay.includes(h))) continue;
    const r = f.getBoundingClientRect();
    const cs = getComputedStyle(f);
    const visible = r.width > 8 && r.height > 8 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity || "1") > 0.05;
    frames.push({ src: src.slice(0, 200), rect: { x: r.left, y: r.top, w: r.width, h: r.height }, visible });
  }
  const vis = frames.filter((f) => f.visible);
  let rect = null;
  if (vis.length) {
    const x1 = Math.min(...vis.map((f) => f.rect.x));
    const y1 = Math.min(...vis.map((f) => f.rect.y));
    const x2 = Math.max(...vis.map((f) => f.rect.x + f.rect.w));
    const y2 = Math.max(...vis.map((f) => f.rect.y + f.rect.h));
    rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  let token = "";
  for (const sel of ${FIELDS}) {
    const el = document.querySelector(sel);
    if (el && el.value) { token = String(el.value); if (token) break; }
  }
  if (!token && window.hcaptcha && typeof window.hcaptcha.getResponse === "function") {
    try { token = String(window.hcaptcha.getResponse() || ""); } catch (e) {}
  }
  if (!token && window.turnstile && typeof window.turnstile.getResponse === "function") {
    try { token = String(window.turnstile.getResponse() || ""); } catch (e) {}
  }
  const src = frames.map((f) => f.src).join(" ").toLowerCase();
  const kind = src.includes("hcaptcha") ? "hcaptcha"
    : src.includes("turnstile") || src.includes("cloudflare") ? "turnstile"
    : src.includes("recaptcha") ? "recaptcha"
    : frames.length ? "unknown" : "none";
  const scriptOnly = !frames.length && !!(window.hcaptcha || window.turnstile);
  return {
    present: frames.length > 0 || scriptOnly,
    kind,
    frames,
    rect,
    token,
    solved: token.length > 20,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    url: location.href,
    scriptOnly,
  };
})()`;
}

/** 토큰만 확인 (가벼운 폴링용) */
export function tokenScript(): string {
  return `(() => {
  for (const sel of ${FIELDS}) {
    const el = document.querySelector(sel);
    if (el && el.value && String(el.value).length > 20) return String(el.value);
  }
  try { if (window.hcaptcha && window.hcaptcha.getResponse) return String(window.hcaptcha.getResponse() || ""); } catch (e) {}
  try { if (window.turnstile && window.turnstile.getResponse) return String(window.turnstile.getResponse() || ""); } catch (e) {}
  return "";
})()`;
}

/** 사람이 틀렸을 때 다시 시도할 수 있게 캡차를 되돌린다. */
export function resetScript(): string {
  return `(() => {
  let done = false;
  try { if (window.hcaptcha && window.hcaptcha.reset) { window.hcaptcha.reset(); done = true; } } catch (e) {}
  try { if (window.turnstile && window.turnstile.reset) { window.turnstile.reset(); done = true; } } catch (e) {}
  for (const sel of ${FIELDS}) for (const el of document.querySelectorAll(sel)) { el.value = ""; done = true; }
  return done;
})()`;
}

export const FOCUS_STYLE_ID = "aio-supreme-captcha-focus";
export const FOCUS_BAR_ID = "aio-supreme-captcha-bar";
const HIDDEN_ATTR = "data-aio-hidden";

/**
 * **캡차만 남기는 집중 모드.**
 *
 * body 부터 캡차 iframe 까지 올라가며, 그 길(the chain) 위에 있지 않은 형제를 전부 숨긴다 —
 * 조상까지 숨기면(visibility) 캡차도 같이 사라지므로 형제만 건드린다. 캡차가 둘 이상(체크박스 +
 * 문제 창)일 수 있어 모든 캡차의 길을 한꺼번에 남긴다.
 *
 * @param mode hide = 나머지를 아예 치운다(캡차 전용 창) · dim = 흐리게만 (페이지 모양 유지)
 */
export function focusScript(mode: "hide" | "dim" = "hide", bannerText = "hCaptcha를 직접 풀어 주세요. 다 풀면 자동으로 이어서 진행합니다."): string {
  return `(() => {
  const hints = ${HINTS};
  const mode = ${JSON.stringify(mode)};
  const barText = ${JSON.stringify(bannerText)};
  const isCaptcha = (el) => {
    if (!el || el.tagName !== "IFRAME") return false;
    const hay = ((el.getAttribute("src") || "") + " " + (el.getAttribute("title") || "")).toLowerCase();
    return hints.some((h) => hay.includes(h));
  };
  const frames = [...document.querySelectorAll("iframe")].filter(isCaptcha);
  if (!frames.length) return { ok: false, reason: "캡차 iframe 없음", hidden: 0 };

  const keep = new Set();
  for (const f of frames) {
    let node = f;
    while (node && node !== document.documentElement) { keep.add(node); node = node.parentElement; }
  }

  const old = document.getElementById(${JSON.stringify(FOCUS_STYLE_ID)});
  if (old) old.remove();

  let hidden = 0;
  for (const node of keep) {
    const parent = node.parentElement;
    if (!parent) continue;
    for (const sib of [...parent.children]) {
      if (sib === node || keep.has(sib)) continue;
      if (sib.id === ${JSON.stringify(FOCUS_BAR_ID)}) continue;
      if (mode === "hide") {
        if (!sib.hasAttribute(${JSON.stringify(HIDDEN_ATTR)})) {
          sib.setAttribute(${JSON.stringify(HIDDEN_ATTR)}, sib.style.display || "");
          sib.style.setProperty("display", "none", "important");
        }
        hidden++;
      } else {
        sib.style.setProperty("opacity", "0.15", "important");
        sib.style.setProperty("filter", "grayscale(1)", "important");
      }
    }
  }

  const target = frames[0];
  const rect = target.getBoundingClientRect();
  const wantsScroll = rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth;
  if (wantsScroll) target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

  // 사람에게 보이는 안내 띠. body 형제 숨김에 걸리지 않게 documentElement 에 직접 붙인다.
  let bar = document.getElementById(${JSON.stringify(FOCUS_BAR_ID)});
  if (!bar) {
    bar = document.createElement("div");
    bar.id = ${JSON.stringify(FOCUS_BAR_ID)};
    bar.setAttribute("style", [
      "position:fixed", "left:0", "right:0", "top:0", "z-index:2147483647",
      "background:#111", "color:#fff", "font:600 13px/1.5 system-ui,'Malgun Gothic',sans-serif",
      "padding:10px 14px", "text-align:center", "box-shadow:0 2px 12px rgba(0,0,0,.45)",
    ].join(";"));
    bar.textContent = barText;
    document.documentElement.appendChild(bar);
  } else {
    bar.textContent = barText;
  }

  const r2 = target.getBoundingClientRect();
  return { ok: true, hidden, mode, rect: { x: r2.left, y: r2.top, w: r2.width, h: r2.height }, scrollY: window.scrollY };
})()`;
}

/** 집중 모드를 푼다 (숨겼던 것을 원래대로). */
export function unfocusScript(): string {
  return `(() => {
  const bar = document.getElementById(${JSON.stringify(FOCUS_BAR_ID)});
  if (bar) bar.remove();
  let restored = 0;
  for (const el of document.querySelectorAll("[" + ${JSON.stringify(HIDDEN_ATTR)} + "]")) {
    const prev = el.getAttribute(${JSON.stringify(HIDDEN_ATTR)}) || "";
    el.removeAttribute(${JSON.stringify(HIDDEN_ATTR)});
    if (prev) el.style.display = prev; else el.style.removeProperty("display");
    restored++;
  }
  for (const el of document.querySelectorAll('[style*="grayscale"]')) {
    el.style.removeProperty("opacity");
    el.style.removeProperty("filter");
  }
  return restored;
})()`;
}

/** 캡차 영역이 화면 안에 들어오게만 맞춘다 (집중 모드 없이 창을 띄울 때). */
export function scrollToCaptchaScript(): string {
  return `(() => {
  const hints = ${HINTS};
  const f = [...document.querySelectorAll("iframe")].find((el) =>
    hints.some((h) => (((el.getAttribute("src") || "") + " " + (el.getAttribute("title") || "")).toLowerCase()).includes(h)));
  if (!f) return { ok: false };
  f.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = f.getBoundingClientRect();
  return { ok: true, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
})()`;
}

/** 창을 키우거나 스크롤해도 캡차가 확실히 보이게 — 필요하면 확대/축소까지. */
export function bringCaptchaIntoViewScript(): string {
  return `(() => {
  const hints = ${HINTS};
  const frames = [...document.querySelectorAll("iframe")].filter((el) =>
    hints.some((h) => (((el.getAttribute("src") || "") + " " + (el.getAttribute("title") || "")).toLowerCase()).includes(h)));
  if (!frames.length) return { ok: false, reason: "캡차 없음" };
  const first = frames[0];
  first.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = first.getBoundingClientRect();
  const fits = r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
  if (!fits) {
    const need = Math.max(r.width / Math.max(1, window.innerWidth), r.height / Math.max(1, window.innerHeight));
    const z = Math.max(0.5, Math.min(1, 1 / (need * 1.15)));
    document.documentElement.style.zoom = String(z);
    first.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  }
  const r2 = first.getBoundingClientRect();
  return { ok: true, rect: { x: r2.left, y: r2.top, w: r2.width, h: r2.height }, inner: { w: window.innerWidth, h: window.innerHeight } };
})()`;
}

/** 여러 사각형을 하나로 (여백 포함). 겹치는 캡차 창들(체크박스+문제)을 함께 담는다. */
export function unionRect(rects: Rect[], pad = 0): Rect | null {
  const usable = rects.filter((r) => r.w > 0 && r.h > 0);
  if (!usable.length) return null;
  const x1 = Math.min(...usable.map((r) => r.x));
  const y1 = Math.min(...usable.map((r) => r.y));
  const x2 = Math.max(...usable.map((r) => r.x + r.w));
  const y2 = Math.max(...usable.map((r) => r.y + r.h));
  return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
}

/** 프로브 결과 해석 — 사람을 불러야 하나? */
export function needsHuman(probe: CaptchaProbe | null): { needed: boolean; reason: string } {
  if (!probe || !probe.present) return { needed: false, reason: "캡차 없음" };
  if (probe.solved) return { needed: false, reason: "이미 풀림" };
  if (probe.scriptOnly) return { needed: true, reason: "보이지 않는 캡차(invisible) — 창을 띄운다" };
  return { needed: true, reason: `${probe.kind} 확인 필요` };
}

/** 사람이 다 풀었나 — 토큰이 폼에 들어왔는가. */
export function isSolved(probe: CaptchaProbe | null): boolean {
  return !!probe && probe.solved;
}

/** 캡차 대기 중 사람에게 보여 줄 한 줄 */
export function waitNote(elapsedMs: number, timeoutMs: number): string {
  const left = Math.max(0, Math.ceil((timeoutMs - elapsedMs) / 1000));
  return `캡차 창에서 사람이 푸는 중… 남은 시간 ${left}초`;
}
