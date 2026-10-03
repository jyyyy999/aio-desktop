/**
 * 담고 나서 주문서(또는 장바구니)를 연다. 그리고 결제창까지.
 *
 * bnkr_buy.py 의 브라우저 관련 부분을 그대로 옮겼다. **결제 확정은 사람이 누른다** —
 * 여기서 하는 일은 주문서를 열고, 필수 동의를 체크하고, 결제창을 띄워 그 화면을 폰으로
 * 보내는 데까지다. 카드 인증도 간편결제 비밀번호도 자동화 대상이 아니다.
 */
import { exec } from "node:child_process";
import {
  cookieOf, PG_DUMP_PATH, profileDir, run, wants, type Config, type Mode,
} from "./config.js";
import { log, sayOk, sayStar, sayStep } from "./log.js";
import { notifyPaid, notifyPayment } from "./notify.js";
import {
  alive, BrowserError, capturePayment, isQueue, openOrder, paidDetails, preheat, stepLabels,
  waitLogin, waitPaid, type Action, type Chrome,
} from "./browser.js";
import { LANDING, LANDING_LABEL, STAGE_LABEL } from "./site.js";
import { Session } from "./http.js";
import { UI } from "./ui.js";
import { sleep } from "./util.js";

/**
 * 열어 둔 크롬 창의 손잡이. 놓아 버리면 정리하면서 창까지 닫는 판이 되므로 프로세스가
 * 사는 동안 붙잡고 있는다.
 */
const OPEN_BROWSERS: Chrome[] = [];
/** 지켜보는 동안 미리 세워 둔 크롬. 재고가 열린 뒤에 띄우면 그 1.6초가 고스란히 늦는다. */
const IDLE_BROWSER: Chrome[] = [];

/** 결제창에서 할 일을 사람이 읽을 이름으로. 넣는 값은 여기 안 나온다. */
export function pgSteps(cfg: Config): string[] {
  return stepLabels(cfg.pg_clicks);
}

/** 지켜보기 시작할 때 크롬을 미리 세워 둔다. 어차피 노는 시간이다. */
export async function preheatBrowser(cfg: Config): Promise<void> {
  if (run.dryRun || !cfg.open_browser) return;
  if (!cfg.preheat_browser) return;
  if ((cfg.browser || "selenium").toLowerCase() !== "selenium") return;

  const box = await preheat(cfg.browser_headless, profileDir(cfg), cfg.browser_offscreen);
  if (!box) return;

  IDLE_BROWSER.push(box);
  sayStep("크롬을 미리 띄워 뒀습니다 (재고가 열리면 1.6초 빨라집니다)");
  await prelogin(cfg, box);
}

/**
 * 감시를 시작하기 전에 로그인 페이지를 띄워 두고 사람을 기다린다.
 *
 * 네이버페이처럼 결제창에서 다른 사이트에 로그인해야 하는 수단을 쓸 때 필요하다. 재고가
 * 열린 뒤에 로그인을 시작하면 늦다 — 그 순간에 캡차라도 뜨면 그 판은 끝이다. 지켜보는
 * 동안은 어차피 노는 시간이니 그때 해 둔다.
 *
 * **로그인은 사람이 한다.** 안 되면 그냥 넘어간다 — 담기까지는 이 로그인 없이도 된다.
 */
async function prelogin(cfg: Config, box: Chrome): Promise<void> {
  const url = (cfg.prelogin_url || "").trim();
  if (!url) return;

  const minutes = cfg.prelogin_wait_minutes ?? 5;
  sayStar(`로그인 페이지를 띄웠습니다 — 크롬 창에서 직접 로그인해 주세요 (최대 ${minutes}분)`);
  const ok = await waitLogin(box, url, cfg.prelogin_marker || "login", minutes * 60,
    (left) => UI.status(`로그인을 기다리는 중 · ${Math.floor(left / 60)}분 ${left % 60}초 남음`));

  if (ok) sayOk("로그인됐습니다 — 이 창으로 결제까지 갑니다");
  else {
    log.warn("로그인을 확인하지 못했습니다. 그대로 감시를 시작합니다 " +
      "(담기까지는 이 로그인이 없어도 됩니다)");
  }
}

/**
 * 쓸 창을 꺼내 온다. 없거나 죽었으면 null.
 *
 * 미리 세워 둔 것이 먼저고, 없으면 **앞 바퀴에 쓰던 창을 다시 쓴다.**
 *
 * 매 바퀴 크롬을 새로 띄우면 창이 쌓인다. 앞 창은 일부러 닫지 않으므로(사람이 이어서
 * 할 것이 있다) 똑같이 생긴 창이 둘, 셋이 되고, 스크립트가 보는 창과 사람이 보는 창이
 * 어긋난다. 그러면 눈앞의 화면은 그대로인데 "왜 안 눌리지" 가 된다.
 */
async function takeIdleBrowser(): Promise<Chrome | null> {
  while (IDLE_BROWSER.length) {
    const box = IDLE_BROWSER.pop()!;
    if (await alive(box)) return box;
  }
  while (OPEN_BROWSERS.length) {
    const box = OPEN_BROWSERS.pop()!;
    if (await alive(box)) {
      log.debug("앞 바퀴에 쓰던 창을 다시 씁니다.");
      return box;
    }
  }
  return null;
}

/** 마지막으로 연 크롬을 닫는다. 다시 시도하기 전에 부른다. */
async function closeLastBrowser(): Promise<void> {
  const box = OPEN_BROWSERS.pop();
  if (box) await box.quit();
}

type OpenResult = "ok" | "partial" | "none" | "queue";

/**
 * 쿠키를 심은 크롬으로 주문서를 연다.
 *
 *   "ok"      시킨 데까지 갔다
 *   "partial" 창은 떴는데 거기까지 못 갔다 (다시 해볼 만하다)
 *   "none"    크롬을 아예 못 띄웠다 (기본 브라우저로 넘길 일이다)
 *   "queue"   대기열이다 (창을 그대로 두고 기다린다)
 */
async function openWithSelenium(
  cfg: Config, mode: Mode, cookie: string, goods: { gno?: string; name: string },
): Promise<OpenResult> {
  let opened;
  try {
    opened = await openOrder(LANDING[mode], cookie, {
      action: (cfg.order_action || "open").toLowerCase() as Action,
      headless: cfg.browser_headless,
      timeout: cfg.browser_timeout_seconds ?? 20,
      chrome: await takeIdleBrowser(),
      profile: profileDir(cfg),
      offscreen: cfg.browser_offscreen,
    });
  } catch (e) {
    if (!(e instanceof BrowserError)) throw e;
    log.warn(`크롬을 띄우지 못했습니다 (${e.message}). 기본 브라우저로 엽니다.`);
    return "none";
  }

  const { chrome: box, ok, reason, stage } = opened;
  OPEN_BROWSERS.push(box);
  if (!ok) {
    if (isQueue(reason)) {
      // 창을 그대로 둔다. 닫고 다시 열면 순번을 버린다.
      log.warn(`${reason} — 창을 그대로 두고 기다립니다`);
      return "queue";
    }
    log.warn(`크롬은 열렸지만 ${LANDING_LABEL[mode]}에 실패했습니다 — ${reason}`);
    return "partial";
  }

  log.info(`${LANDING_LABEL[mode]} — ${STAGE_LABEL[stage]}`);
  if (reason) {
    // 시킨 데까지 못 갔다. 창은 떠 있으니 나머지는 사람이 누르면 된다.
    log.warn(`남은 클릭은 직접 해주세요 — ${reason}`);
  }

  if (stage === "submitted" && cfg.pg_capture) {
    await sendPaymentShot(cfg, goods, box);
  }

  // 시킨 데까지 못 갔으면 다시 해볼 값어치가 있다. 창은 부른 쪽이 정리한다.
  return reason ? "partial" : "ok";
}

/**
 * 결제창에서 정해진 것들을 누르고, 그 화면을 디스코드로 보낸다.
 * 여기서 실패해도 담기와 주문서는 이미 끝난 일이다. 예외를 위로 올려 그걸 망치지 않는다.
 */
async function sendPaymentShot(
  cfg: Config, goods: { gno?: string; name: string }, box: Chrome,
): Promise<void> {
  let got;
  try {
    got = await capturePayment(box, {
      clicks: cfg.pg_clicks,
      timeout: cfg.browser_timeout_seconds ?? 20,
      settle: cfg.pg_settle_seconds ?? 3,
      dumpPath: PG_DUMP_PATH,
      probes: cfg.pg_probe,
    });
  } catch (e) {
    log.warn(`결제창을 다루는 중 오류 (창은 떠 있습니다): ${(e as Error).message}`);
    return;
  }

  const { shot, done, quiet, missed } = got;
  if (!shot) {
    log.warn("화면을 찍지 못했습니다. 크롬 창을 직접 봐주세요.");
    return;
  }

  if (done.length) log.info(`결제창에서 누른 것: ${done.join(" → ")}`);
  // 못 찾은 것과는 다르다. 눌리긴 했으니 대개 먹힌 것이고, 화면을 봐야 안다.
  if (quiet.length) log.info(`눌렀지만 화면 변화를 못 본 것: ${quiet.join(", ")}`);
  if (missed.length) log.warn(`결제창에서 못 찾은 것: ${missed.join(", ")}`);

  if (await notifyPayment(cfg, goods, shot, done, quiet, missed)) {
    if (missed.length) sayStar("결제창에서 막힌 화면을 디스코드로 보냈습니다");
    else sayStar("QR 을 디스코드로 보냈습니다 — 폰으로 찍어 승인해 주세요");
  }
  await watchUntilPaid(cfg, goods, box);
}

/**
 * 결제가 끝나기를 지켜보다가, 끝나면 알린다.
 *
 * 여기서부터는 우리가 할 일이 없다. 사람이 폰에서 승인하는 것을 기다릴 뿐이다. 그래도
 * 지켜보는 이유는, 끝났다는 사실을 폰으로 한 번 더 알려 주기 위해서다 — QR 을 찍고 나서
 * PC 앞으로 돌아와 확인해야 한다면 반쪽짜리다.
 */
async function watchUntilPaid(
  cfg: Config, goods: { gno?: string; name: string }, box: Chrome,
): Promise<void> {
  const minutes = cfg.paid_wait_minutes ?? 10;
  if (!minutes || !wants(cfg, "paid")) return;

  const markers = cfg.paid_markers || [];
  if (!markers.length) {
    log.warn("완료를 무엇으로 볼지(paid_markers) 가 비어 있어 지켜보지 않습니다.");
    return;
  }

  sayStep(`결제가 끝나기를 지켜봅니다 (최대 ${minutes}분)`);
  let shot: Buffer | null;
  try {
    shot = await waitPaid(box, markers, minutes * 60, {
      onTick: (left) => UI.status(`결제를 기다리는 중 · ${Math.floor(left / 60)}분 ${left % 60}초 남음`),
      finish: cfg.pg_finish,
    });
  } catch (e) {
    // 창이 닫힌 것과 진짜 오류는 다르다. 앞엣것은 셀레니움 말투 그대로 옮기면 무슨 일이
    // 난 건지 알 수 없다 — 지켜보기도, 마지막 확인 클릭도 여기서 끝난다.
    const message = (e as Error).message || "";
    if (["invalid session id", "no such window", "browser has closed"].some((m) => message.includes(m))) {
      log.warn("크롬이 닫혀서 결제 확인을 멈춥니다. 확인 화면이 남아 있으면 직접 눌러 주세요");
    } else {
      log.warn(`결제 확인 중 오류 (창은 떠 있습니다): ${message}`);
    }
    return;
  }

  if (shot === null) {
    log.warn(`${minutes}분 안에 결제 완료를 못 봤습니다. 크롬 창을 확인해 주세요.`);
    return;
  }

  sayStar("결제 완료");

  // 완료 화면에 서 있는 지금이 주문번호를 읽을 유일한 때다. 창은 사람이 언제든 닫는다.
  const info = await paidDetails(box);
  if (info.order_no) sayOk(`주문번호 ${info.order_no}`);
  await notifyPaid(cfg, goods, info);
}

/** 기본 브라우저에 주소만 던진다. 확인은 못 한다. */
function openDefaultBrowser(url: string): void {
  const command = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, { windowsHide: true }, (e) => {
    if (e) log.warn(`브라우저를 열지 못했습니다: ${e.message}`);
  });
}

/**
 * 담고 나서 주문서(또는 장바구니)를 연다. → 시킨 데까지 갔으면 true
 *
 * session 을 받으면 그 세션이 지금 들고 있는 쿠키를 넘긴다. 담기를 한 세션과 주문서를
 * 보는 창이 같은 세션이어야 방금 담은 것이 거기 있다.
 */
export async function openLanding(
  cfg: Config, mode: Mode, session?: Session | null, goods?: { gno?: string; name: string } | null,
): Promise<boolean> {
  // 열 일이 없는 것과 열려다 실패한 것은 다르다. 여기서 false 를 주면 부른 쪽이
  // "못 끝냈다" 고 보고 다음 바퀴에 또 붙든다.
  if (run.dryRun || !cfg.open_browser) return true;

  const cookie = session ? session.cookie : cookieOf(cfg);
  const what = goods ?? { name: LANDING_LABEL[mode] };

  if ((cfg.browser || "selenium").toLowerCase() === "selenium") {
    const attempts = Math.max(1, Number(cfg.max_attempts || 1));
    const delay = cfg.retry_delay_seconds ?? 2;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let result: OpenResult;
      try {
        result = await openWithSelenium(cfg, mode, cookie, what);
      } catch (e) {
        log.warn(`크롬으로 여는 중 오류 (${attempt}/${attempts}): ${(e as Error).message}`);
        result = "partial";
      }

      if (result === "ok") return true;
      if (result === "none") break;  // 크롬 자체가 안 뜬다. 다시 해봐야 같다.
      // 줄을 섰다. 창을 닫지도, 다시 열지도 않는다 — 둘 다 순번을 버린다.
      if (result === "queue") break;

      if (attempt < attempts) {
        // 반쯤 열린 창을 쌓아 두지 않는다. 마지막 것만 사람이 볼 수 있게 남긴다.
        await closeLastBrowser();
        log.warn(`${LANDING_LABEL[mode]} 을(를) 다시 시도합니다 (${attempt + 1}/${attempts})`);
        await sleep(delay * 1000);
      }
    }

    if (OPEN_BROWSERS.length) {
      // 창은 떠 있다. 시킨 데까지는 못 갔어도 사람이 이어서 할 수 있다.
      return false;
    }
  }

  openDefaultBrowser(LANDING[mode]);
  return false;
}
