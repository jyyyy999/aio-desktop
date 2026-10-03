/**
 * 주문서까지 데려다 놓고, 시킨 데까지 마저 누르는 일.
 *
 * **결제 확정은 사람이 누른다.** 기본값(order_action=submit)은 결제하기를 눌러 PG
 * 결제창을 띄우고 거기서 멈춘다 — 결제창 안에서는 아무것도 누르지 않는다.
 */
import { exec } from "node:child_process";
import { basename } from "node:path";
import { log, sayOk, sayStar, sayStep } from "../log.js";
import { sleep } from "../util.js";
import {
  actionOf, CONFIG_PATH, payCardOf, payMarkOf, payMethodOf, PG_DUMP_PATH, run,
  type Config, type Stage,
} from "./config.js";
import type { Target } from "./targets.js";
import {
  BrowserError, Chrome, dumpPayment, finish, KICKED_OUT, leftOrder, openBuy, PAY_METHOD_MISSING,
  SESSION_DEAD, WINDOW_GONE, windowGone,
} from "./browser.js";

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
  switch (actionOf(cfg)) {
    case "submit": return "결제창까지 띄웁니다 — 결제 확정은 사람이 누릅니다";
    case "agree": return "주문서에서 필수 동의까지 하고 멈춥니다";
    default: return "주문서까지만 갑니다 — 결제는 사람이 누릅니다";
  }
}

/**
 * 주문서에 도착했다. 설정에 따라 결제창까지 간다. → 어디까지 갔나
 *
 * doBuy(새 창) 와 buyNow(사람이 부른 것) 가 같은 자리에서 이걸 부른다. 어디로 왔든
 * 도착 다음에 할 일은 하나여야 한다 — 한쪽만 고치면 다른 쪽이 조용히 달라진다.
 */
export async function sayArrived(cfg: Config, box: Chrome): Promise<Stage> {
  const action = actionOf(cfg);
  const timeout = cfg.browser_timeout_seconds ?? 20;

  if (action === "open") {
    sayOk("주문서까지 갔습니다 — 결제는 크롬 창에서 직접 해주세요");
    return "opened";
  }

  const method = payMethodOf(cfg);
  sayStep(action === "agree"
    ? "필수 동의를 체크합니다 (order_action=agree)"
    : `필수 동의 → ${method.length ? `결제수단(${method.join(" → ")}) → ` : ""}결제하기 ` +
      "(order_action=submit) — 결제창 앞에서 멈춥니다");

  /**
   * **여기서 나는 어떤 오류도 위로 올리지 않는다.**
   *
   * 2026-08-23 에 여기서 크게 데었다. 주문서에 도착한 6초 뒤 크롬 창이 사라져
   * (사람이 닫았거나 크롬이 죽었거나) 셀레니움이 `invalid session id` 를 던졌는데,
   * 그게 이 함수를 뚫고 doBuy·handleTarget·watch 를 지나 프로그램을 통째로 끝냈다.
   * 감시가 죽은 것도 문제지만 더 나쁜 것은 **받아적기를 못 한 것**이다 — 결제창은
   * 아무 때나 띄워 볼 수 있는 화면이 아니라서, 그 판이 셀렉터를 고칠 유일한 기회였다.
   *
   * 그래서 잡는다. 창이 사라진 것은 고장이 아니라 그냥 일어나는 일이고, 그때 우리가
   * 할 일은 "무슨 일이 있었는지 적고 다음 바퀴로 넘어가는 것" 이다.
   */
  let stage: Stage = "opened";
  let reason: string | null = null;
  try {
    [stage, reason] = await finish(box, action, timeout, method, payMarkOf(cfg), payCardOf(cfg));
  } catch (e) {
    reason = `주문서에서 마저 누르다 끊겼습니다 — ${(e as Error).message}`;
    log.error(reason);
  }

  if (stage === "submitted") {
    // **사유가 있으면 반드시 적는다.** 여기서 데었다 — 사이트가 alert 로 막은 판을
    // "결제창까지 띄웠습니다" 로 적고 그 alert 문구를 묻어 버린 적이 있다.
    if (reason) log.warn(reason);
    sayStar("결제창까지 띄웠습니다 — 결제는 크롬 창에서 직접 해주세요");
  } else {
    if (reason) log.warn(`시킨 데까지 못 갔습니다 (${stage} 에서 멈춤) — ${reason}`);
    // 결제수단을 못 고른 것은 다르게 말해 준다. "왜 결제하기를 안 눌렀지" 가 아니라
    // "일부러 안 눌렀다" 는 것을 알아야 사람이 화면에서 이어갈 수 있다.
    if (reason?.startsWith(PAY_METHOD_MISSING)) {
      log.warn("엉뚱한 결제수단으로 결제창을 띄우지 않으려고 결제하기를 누르지 않았습니다.");
      log.info(`  주문서는 열려 있습니다. 화면에 보이는 이름을 ${basename(CONFIG_PATH)} 의 ` +
        "pay_method 에 적어 두면 다음부터 골라 줍니다.");
    }
    if (await windowGone(box)) log.warn(`${WINDOW_GONE} — 다음 바퀴에 새로 띄웁니다`);
    else sayOk("창은 열려 있습니다 — 나머지는 크롬 창에서 직접 해주세요");
  }

  // **어긋난 것이 있을 때만 받아 적는다.** 잘 간 판에서까지 200KB 짜리 마크업을 긁어
  // 오느라 몇 초를 치를 이유가 없다. 이 프로그램을 만들 때 결제창을 못 봤으므로,
  // 처음 한 번 여기까지 가 본 사람의 화면이 셀렉터를 고칠 유일한 재료다.
  //
  // 받아적기 자체도 창을 만지는 일이라 터질 수 있다. 그것도 삼킨다 — 못 적었다고
  // 주문서까지 온 일을 없던 것으로 만들 이유는 없다.
  if (cfg.pg_dump && (reason || stage !== "submitted")) {
    try {
      if (await dumpPayment(box, PG_DUMP_PATH)) {
        log.info(`결제창 내용을 적어 뒀습니다: ${basename(PG_DUMP_PATH)}`);
      }
    } catch (e) {
      log.warn(`결제창을 받아 적지 못했습니다 — ${(e as Error).message}`);
    }
  }
  return stage;
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
 * 크롬으로 상품 페이지를 열어 바로 구매하기를 누르고, 시킨 데까지 간다.
 *
 * 세션이 끊긴 것을 따로 돌려주는 이유는, 그것만 다시 해봐야 소용없는 실패라서다.
 * 나머지는 다음 바퀴에 다시 해볼 값어치가 있다.
 */
export async function doBuy(cfg: Config, cookie: string, target: Target): Promise<BuyResult> {
  if (run.dryRun) {
    sayStep(`[dry-run] 여기서 바로 구매하기를 눌렀을 것입니다 — ${target.url}`);
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
      // 주문서에 들어갔다가 쫓겨났으면 **산 것이 아니다.** 여기서 ok 를 돌려주면 감시가
      // "데려왔다" 며 멈춘다 — 빈 장바구니를 두고. 실패로 돌려 감시를 잇게 한다.
      if (stage !== "submitted") {
        const where = await leftOrder(got.chrome);
        if (where) {
          return { ok: false, reason: `${KICKED_OUT} (현재: ${where})`, stage, dead: false };
        }
      }
      return { ok: true, reason: null, stage, dead: false };
    }

    last = got.reason;
    // 다시 해봐야 같다. 위에서 멈추게 한다.
    if (got.reason === SESSION_DEAD) {
      return { ok: false, reason: got.reason, stage: "opened", dead: true };
    }

    log.warn(`주문서까지 못 갔습니다 (${attempt}/${attempts}) — ${got.reason}`);
    if (attempt < attempts) {
      await closeLastBrowser();
      await sleep(delay * 1000);
    }
  }

  // 창은 남긴다. 어디서 멈췄는지 사람이 봐야 판단이 된다.
  return { ok: false, reason: last, stage: "opened", dead: false };
}
