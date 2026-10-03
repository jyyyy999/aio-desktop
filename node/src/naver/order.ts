/**
 * 주문서까지 데려다 놓는 일. 그리고 도착한 뒤에 무엇을 더 할지.
 *
 * **결제 확정은 사람이 누른다.** 기본값(order_action=open)은 주문서를 열어 두고 멈춘다.
 * submit 으로 두면 결제하기까지 누르고 **인증 화면 앞에서** 멈춘다. 생체인증은 다루지 않는다.
 *
 * pg_password 를 적어 두면 **인증 화면의 비밀번호 자판까지 눌러 준다**(pin.ts). 네이버페이는
 * 그 순간 결제가 끝난다 — 비워 두면(기본) 예전처럼 인증 화면 앞에서 멈춘다.
 *
 * 롯데온 판에서 가져온 것 셋:
 *   - 결제하기 뒤에 무엇이 떴는지 가른다 (인증 화면 / 막힘 / 못 봄)
 *   - 어긋나면 화면을 naver-pg-dump.txt 에 받아 적는다 (pg_dump)
 *   - 결제가 끝나기를 지켜보다가 끝나면 디스코드로 알린다 (discord_notify 의 "paid")
 */
import { exec } from "node:child_process";
import { basename } from "node:path";
import { log, sayOk, sayStar, sayStep } from "../log.js";
import { sleep } from "../util.js";
import {
  actionOf, passwordOf, PG_DUMP_PATH, run, wants, type Config, type Stage,
} from "./config.js";
import type { StockInfo } from "./product.js";
import type { Target } from "./targets.js";
import { notifyPaid } from "./notify.js";
import {
  BrowserError, Chrome, dumpPayment, openBuy, PAID_ANYWAY, payHere, PG_OPENED, PG_UNSEEN,
  SESSION_DEAD, windowGone,
} from "./browser.js";
import { enterPin } from "./pin.js";

/**
 * 열어 둔 크롬 창의 손잡이. 놓아 버리면 정리하면서 창까지 닫는 판이 되므로 프로세스가
 * 사는 동안 붙잡고 있는다.
 */
export const OPEN_BROWSERS: Chrome[] = [];

export async function closeLastBrowser(): Promise<void> {
  const box = OPEN_BROWSERS.pop();
  if (box) await box.quit();
}

/**
 * 감시를 시작할 때 배너에 적는 줄. **어디까지 가는지 먼저 보여 준다.**
 * 켜 놓고 잊어버리는 설정이라, 매번 시작할 때 눈에 띄어야 한다.
 */
export function arrivalLine(cfg: Config): string {
  if (actionOf(cfg) === "submit") {
    return passwordOf(cfg)
      ? "결제하기 → 간편결제 비밀번호까지 누릅니다 — **사람 손 없이 결제됩니다** (pg_password)"
      : "결제하기까지 누릅니다 — 인증 화면에서 멈춥니다 (order_action=submit)";
  }
  return "주문서까지만 갑니다 — 결제는 사람이 누릅니다";
}

/** 이 창을 이미 받아 적었는가. --dump-pay 가 같은 판을 두 번 적지 않게 센다. */
const DUMPED = new WeakSet<Chrome>();

export function dumpedAlready(box: Chrome): boolean {
  return DUMPED.has(box);
}

/** 받아 적는다. 받아적기도 창을 만지는 일이라 터질 수 있어 삼킨다. → 적었으면 true */
export async function dumpHere(box: Chrome): Promise<boolean> {
  try {
    if (await dumpPayment(box, PG_DUMP_PATH)) {
      DUMPED.add(box);
      sayStar(`결제하기 뒤 화면을 적어 뒀습니다: ${basename(PG_DUMP_PATH)}`);
      log.info("  이 파일을 보고 naver/browser.ts 의 AUTH_MARKS·PAY_TEXT 를 고치면 됩니다.");
      log.info("  사람 정보(연락처·카드번호)는 가리고, 주문서 마크업은 남기지 않았습니다.");
      return true;
    }
  } catch (e) {
    log.warn(`결제창을 받아 적지 못했습니다 — ${(e as Error).message}`);
  }
  return false;
}

/**
 * 주문서에 도착했다. 설정에 따라 결제하기까지 누른다. → 어디까지 갔나
 *
 * doBuy(새 창) 와 buyFromWindow(띄워 둔 창) 가 같은 자리에서 이걸 부른다. 어디로 왔든
 * 도착 다음에 할 일은 하나여야 한다 — 한쪽만 고치면 다른 쪽이 조용히 달라진다.
 *
 * **여기서 나는 어떤 오류도 위로 올리지 않는다.** 롯데온 판이 데인 자리다 — 주문서에
 * 도착한 뒤 크롬 창이 사라지자 셀레니움 오류가 감시 루프까지 뚫고 올라가 프로그램을
 * 통째로 끝냈고, 받아적기도 못 했다. 창이 사라진 것은 고장이 아니라 그냥 일어나는 일이다.
 */
export async function sayArrived(cfg: Config, box: Chrome): Promise<Stage> {
  if (actionOf(cfg) !== "submit") {
    sayOk("주문서까지 갔습니다 — 결제는 크롬 창에서 직접 해주세요");
    return "opened";
  }

  const pin = passwordOf(cfg);
  sayStep(pin
    ? `결제하기를 누릅니다 (order_action=submit) — 간편결제 비밀번호(${pin.length}자리)도 넣습니다`
    : "결제하기를 누릅니다 (order_action=submit) — 비밀번호는 넣지 않습니다");
  let pressed = false;
  let note: string;
  try {
    [pressed, note] = await payHere(box, cfg.browser_timeout_seconds ?? 20);
  } catch (e) {
    note = `주문서에서 결제하기를 누르다 끊겼습니다 — ${(e as Error).message}`;
  }

  // **누른 것과 인증 화면이 뜬 것은 다르다.** 사이트가 alert 로 막은 것도 "눌린" 것이라,
  // 그걸 "결제창까지 갔습니다" 로 적으면 막힌 이유가 그 줄에 묻힌다.
  let stage: Stage = "opened";
  if (!pressed) {
    log.warn(`결제하기를 못 눌렀습니다 — ${note}`);
  } else if (note === PAID_ANYWAY) {
    // 인증이 없는 계정이다. 다음부터 이걸 켜 두면 눈 감고 사는 것과 같다.
    log.error(note);
    log.error("이 계정은 결제 인증을 묻지 않습니다. order_action 을 open 으로 되돌려 주세요.");
    stage = "submitted";
  } else if (note === PG_OPENED || note === PG_UNSEEN) {
    stage = "submitted";
    if (!pin) {
      if (note === PG_OPENED) sayStar(note);
      else log.warn(note);
    } else {
      // 신호를 못 봤어도(PG_UNSEEN) 자판은 찾아본다. enterPin 이 창·프레임을 다 뒤지고,
      // 못 찾으면 "none" 으로 물러난다.
      const pinNote = await pinTail(box, pin, cfg.browser_timeout_seconds ?? 20);
      if (pinNote) note = pinNote;
      else note = PIN_DONE;
    }
  } else {
    log.warn(`결제 인증 화면까지 못 갔습니다 — ${note}`);
  }

  if (stage === "opened") {
    if (await windowGone(box)) log.warn("크롬 창이 사라졌습니다 — 다음 바퀴에 새로 띄웁니다");
    else sayOk("주문서는 열려 있습니다 — 결제는 크롬 창에서 직접 해주세요");
  }

  // **어긋난 것이 있을 때 받아 적는다.** 그리고 비밀번호를 사람이 넣는 판이면 인증 화면이
  // 떴어도 받아 적는다 — 네이버 스토어 쪽 인증 화면은 아직 한 번도 받아 적지 못했고,
  // 사람이 자판을 누르는 동안이라 몇 초를 써도 잃는 것이 없다. 2026-09-18 23:46 에
  // "인증 화면이 떴습니다" 로 잘 간 판이 바로 그 기회였는데, 잘 갔다고 건너뛰었다.
  const tellsSomething = note !== PG_OPENED || !pin;
  if (cfg.pg_dump && tellsSomething && note !== PAID_ANYWAY && note !== PIN_DONE) {
    // 인증 화면은 창이 먼저 서고 자판이 뒤에 그려진다. 빈 껍데기를 적지 않게 잠깐 둔다.
    if (note === PG_OPENED) await sleep(2500);
    await dumpHere(box);
  }
  return stage;
}

const PIN_DONE = "간편결제 비밀번호까지 넣었습니다";

/**
 * 인증 화면에서 비밀번호를 넣는다. → 사유 (다 넣었으면 null)
 *
 * **여기서 나는 오류도 삼킨다.** sayArrived 와 같은 이유다. 못 넣었으면 창은 그대로
 * 두고 사람이 넣으면 된다 — 틀렸다고 다시 넣어 보지는 않는다(몇 번 틀리면 잠긴다).
 */
async function pinTail(box: Chrome, pin: string, timeout: number): Promise<string | null> {
  let result;
  try {
    result = await enterPin(box, pin, Math.min(timeout, 15));
  } catch (e) {
    const why = `비밀번호를 넣다 끊겼습니다 — ${(e as Error).message}`;
    log.warn(why);
    return why;
  }
  if (result === "ok") {
    sayStar(`${PIN_DONE} — 결제가 끝나는지 크롬 창을 봐주세요`);
    return null;
  }
  const why = result === "quiet"
    ? "비밀번호를 넣었지만 넘어가지 않았습니다 (틀렸거나 확인 화면이 더 있습니다)"
    : "비밀번호 자판을 못 찾았습니다";
  log.warn(`${why} — 나머지는 크롬 창에서 직접 해주세요`);
  return why;
}

/**
 * 결제가 끝나기를 지켜보다가, 끝나면 디스코드로 알린다. → 알렸으면 true
 *
 * 완료는 주소나 화면 글자로 본다. **화면 글자는 주문서를 떠났을 때만 믿는다** —
 * 주문서 안에도 "주문완료" 같은 단계 표시가 붙을 수 있어서, 서 있으면서 글자로 판정하면
 * 결제를 시작하자마자 끝난 것으로 읽는다 (bnkr 판에서 실제로 그랬다).
 */
export async function watchUntilPaid(
  cfg: Config, box: Chrome, target: Target, name: string,
): Promise<boolean> {
  const minutes = cfg.paid_wait_minutes ?? 10;
  const markers = cfg.paid_markers || [];
  if (!minutes || !wants(cfg, "paid")) return false;
  if (!markers.length) {
    log.warn("완료를 무엇으로 볼지(paid_markers) 가 비어 있어 결제 완료를 지켜보지 않습니다.");
    return false;
  }

  const notYet = "/ordersheet";
  const deadline = Date.now() + minutes * 60_000;
  const driver = box.driver;
  sayStep(`결제가 끝나기를 지켜봅니다 (최대 ${minutes}분)`);

  while (Date.now() < deadline) {
    let handles: string[];
    try {
      handles = await driver.getAllWindowHandles();
    } catch {
      log.warn("크롬 창이 닫혀 결제 완료를 지켜보지 못했습니다.");
      return false;
    }

    for (const handle of handles) {
      let where = "";
      let text = "";
      try {
        await driver.switchTo().window(handle);
        where = await driver.getCurrentUrl();
        text = await driver.executeScript<string>("return (document.body.innerText || '')");
      } catch {
        continue;
      }
      const byUrl = markers.some((m) => where.includes(m));
      const byText = !where.includes(notYet) && markers.some((m) => text.includes(m));
      if (byUrl || byText) {
        log.debug(`결제 완료로 봅니다 (${byUrl ? "주소" : "화면 글자"}) — ${where}`);
        const sent = await notifyPaid(cfg, target, name);
        sayStar(sent ? "결제 완료 — 디스코드로 알렸습니다" : "결제 완료 — 알림은 못 보냈습니다");
        return sent;
      }
    }
    await sleep(2000);
  }

  log.warn(`${minutes}분 안에 결제 완료를 못 봤습니다. 크롬 창을 확인해 주세요.`);
  return false;
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

export interface BuyResult {
  ok: boolean;
  reason: string | null;
  stage: Stage;
  /** 세션이 끊겼는가. 그것만 다시 해봐야 소용없는 실패라 따로 돌려준다. */
  dead: boolean;
}

/**
 * 크롬으로 상품 페이지를 열어 구매하기를 누르고, 시킨 데까지 간다.
 *
 * 세션이 끊긴 것을 따로 돌려주는 이유는, 그것만 다시 해봐야 소용없는 실패라서다.
 * 나머지는 다음 바퀴에 다시 해볼 값어치가 있다.
 */
export async function doBuy(
  cfg: Config, cookie: string, target: Target, info: StockInfo,
): Promise<BuyResult> {
  if (run.dryRun) {
    sayStep(`[dry-run] 여기서 구매하기를 눌렀을 것입니다 — ${target.url}`);
    return { ok: true, reason: null, stage: "opened", dead: false };
  }
  if (!cfg.open_browser) return { ok: true, reason: null, stage: "opened", dead: false };

  const attempts = Math.max(1, Number(cfg.max_attempts || 1));
  const delay = cfg.retry_delay_seconds ?? 2;
  let last: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let got;
    try {
      got = await openBuy(target.url, cookie, {
        option: target.option,
        ea: target.ea,
        headless: cfg.browser_headless,
        timeout: cfg.browser_timeout_seconds ?? 20,
      });
    } catch (e) {
      if (!(e instanceof BrowserError)) throw e;
      log.warn(`크롬을 띄우지 못했습니다 (${e.message}). 기본 브라우저로 상품 페이지만 엽니다.`);
      openDefaultBrowser(target.url);
      return { ok: false, reason: e.message, stage: "opened", dead: false };
    }

    OPEN_BROWSERS.push(got.chrome);
    if (got.ok) {
      const stage = await sayArrived(cfg, got.chrome);
      if (stage === "submitted") {
        await watchUntilPaid(cfg, got.chrome, target, target.label || info.name);
      }
      return { ok: true, reason: null, stage, dead: false };
    }

    last = got.reason;
    // 다시 해봐야 같다. 위에서 멈추게 한다.
    if (got.reason === SESSION_DEAD) return { ok: false, reason: got.reason, stage: "opened", dead: true };

    log.warn(`주문서까지 못 갔습니다 (${attempt}/${attempts}) — ${got.reason}`);
    if (attempt < attempts) {
      await closeLastBrowser();
      await sleep(delay * 1000);
    }
  }

  // 창은 남긴다. 어디서 멈췄는지 사람이 봐야 판단이 된다.
  return { ok: false, reason: last, stage: "opened", dead: false };
}
