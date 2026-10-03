/**
 * 주문서까지 데려다 놓고, 시킨 데까지 마저 누르는 일.
 *
 * **결제 확정은 사람이 누른다.** 기본값(order_action=submit)은 결제하기를 눌러 PG
 * 결제창을 띄우고 거기서 멈춘다 — 결제창 안의 카드 인증·앱 승인 따위는 그대로
 * 사람이 한다. 다만 **간편결제 비밀번호(pg_password)만은 적어 두면 자판을 눌러 준다.**
 */
import { exec } from "node:child_process";
import { basename } from "node:path";
import { log, sayOk, sayStar, sayStep } from "../log.js";
import { sleep } from "../util.js";
import {
  actionOf, CONFIG_PATH, passwordOf, payCardOf, payMarkOf, payMethodOf, PG_DUMP_PATH, run,
  wants, type Config, type Stage,
} from "./config.js";
import type { Target } from "./targets.js";
import { notifyPaid } from "./notify.js";
import {
  BrowserError, buyIn, Chrome, dumpPayment, finish, KICKED_OUT, kickedReason, keypadModalUp, leftOrder,
  openBuy, PAY_METHOD_MISSING, SESSION_DEAD, WINDOW_GONE, windowGone, type Bought,
} from "./browser.js";
import { QUEUE_PREFIX } from "./tracer.js";
import { giveBack, takeWarm } from "./warm.js";

/**
 * 열어 둔 크롬 창의 손잡이. 놓아 버리면 정리하면서 창까지 닫는 판이 되므로 프로세스가
 * 사는 동안 붙잡고 있는다.
 */
export const OPEN_BROWSERS: Chrome[] = [];

/**
 * 감시를 시작할 때 배너에 적는 줄. **어디까지 가는지 먼저 보여 준다.**
 * 켜 놓고 잊어버리는 설정이라, 매번 시작할 때 눈에 띄어야 한다.
 */
export function arrivalLine(cfg: Config): string {
  switch (actionOf(cfg)) {
    case "submit":
      return passwordOf(cfg)
        ? "결제창까지 띄우고 간편결제 비밀번호까지 누릅니다 — 결제 확정은 사람이 누릅니다"
        : "결제창까지 띄웁니다 — 결제 확정은 사람이 누릅니다";
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
  const hasPin = !!passwordOf(cfg);
  sayStep(action === "agree"
    ? "필수 동의를 체크합니다 (order_action=agree)"
    : `필수 동의 → ${method.length ? `결제수단(${method.join(" → ")}) → ` : ""}결제하기 ` +
      "(order_action=submit)" +
      (hasPin ? " — 결제창에서 간편결제 비밀번호도 눌러 줍니다" : " — 결제창 앞에서 멈춥니다"));

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
    [stage, reason] = await finish(
      box, action, timeout, method, payMarkOf(cfg), payCardOf(cfg), passwordOf(cfg),
    );
  } catch (e) {
    reason = `주문서에서 마저 누르다 끊겼습니다 — ${(e as Error).message}`;
    log.error(reason);
  }

  if (stage === "submitted") {
    // **사유가 있으면 반드시 적는다.** 여기서 데었다 — 사이트가 alert 로 막은 판을
    // "결제창까지 띄웠습니다" 로 적고 그 alert 문구를 묻어 버린 적이 있다.
    if (reason) log.warn(reason);
    sayStar(hasPin
      ? "결제창까지 띄우고 간편결제 비밀번호까지 눌렀습니다 — 결제 확정은 크롬 창에서 직접 해주세요"
      : "결제창까지 띄웠습니다 — 결제는 크롬 창에서 직접 해주세요");
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

/**
 * 결제가 끝나기를 지켜보다가, 끝나면 디스코드로 알린다. → 알렸으면 true
 *
 * 완료는 주소나 화면 글자로 본다. **화면 글자는 주문서를 떠났을 때만 믿는다** —
 * 주문서의 단계 표시줄에도 "주문완료" 가 붙어 있어서, 서 있으면서 글자로 판정하면
 * 결제를 시작하자마자 끝난 것으로 읽는다 (bnkr 판에서 실제로 그랬다).
 *
 * 결제가 끝나면 디스코드로 "successfully checkout" + 제품명 + 제품 링크를 보낸다.
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

  const notYet = "/order/orderSheet";
  const deadline = Date.now() + minutes * 60_000;
  const driver = box.driver;
  sayStep(`결제가 끝나기를 지켜봅니다 (최대 ${minutes}분)`);

  while (Date.now() < deadline) {
    let handles: string[];
    try {
      handles = await driver.getAllWindowHandles();
    } catch {
      // 창이 없어졌다 — 끝났는지조차 알 수 없다.
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
      // 화면 글자는 주문서를 떠났거나 **자판 모달이 닫혔을 때만** 믿는다. 완료되면
      // 모달이 닫히고 완료 문구("우리 이제 곧 만나요!")가 뜬다. 주문서의 단계
      // 표시줄 "주문완료" 는 모달이 떠 있는 동안 걸리지 않게 가린다.
      const keypadGone = !(await keypadModalUp(driver));
      const leftOrder = !(notYet && where.includes(notYet));
      const byText = (leftOrder || keypadGone) && markers.some((m) => text.includes(m));
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

// 사이트가 "이미 다 팔렸다" 고 한 말들. 실제로 받은 문구다 (2026-09-18·19):
//   "… 상품은 재고가 모두 소진되었습니다."
//   "… 상품은 현재 품절 로 구매가 어렵습니다."
// 주문서에 들어갔다가 장바구니로 밀려난 것도 같은 일이다 — 주문서가 뜨는 사이 소진됐다.
// 구매 버튼 자리에 "현재 판매중인 상품이 아닙니다" 따위가 그려진 것도 같다 (2026-09-26 —
// 예약배송 딜 250개가 다 나간 뒤의 MEGA 30th 가 그랬다). browser.ts 가 "사이트 버튼:" 으로 올린다.
// 대기열(TRACER)에서 진 것도 같다 (2026-10-03 — tracer.ts). 고장이 아니라 줄에서 밀린 것이라,
// 쉬면 그사이 풀리는 취소분을 놓친다.
const SOLD_OUT_WORDS = ["소진", "품절", KICKED_OUT, "사이트 버튼:", QUEUE_PREFIX];

/**
 * **고장이 아니라 경쟁에서 진 것인가.**
 *
 * 둘은 다르게 다뤄야 한다. 고장(버튼을 못 찾음·창이 죽음)은 다시 해도 같으니 쉬어야
 * 하지만, 품절로 진 것은 다시 해 봐야 같은 답이 오니 **지금은** 그만두되, 취소분이
 * 풀리면 곧장 다시 가야 한다. 쉬어 버리면 그 취소분을 놓친다.
 */
export function lostRace(reason: string | null | undefined): boolean {
  return !!reason && SOLD_OUT_WORDS.some((word) => reason.includes(word));
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
export async function doBuy(
  cfg: Config, cookie: string, target: Target, name = "",
): Promise<BuyResult> {
  if (run.dryRun) {
    sayStep(`[dry-run] 여기서 바로 구매하기를 눌렀을 것입니다 — ${target.url}`);
    return { ok: true, reason: null, stage: "opened", dead: false };
  }
  if (!cfg.open_browser) return { ok: true, reason: null, stage: "opened", dead: false };

  const attempts = Math.max(1, Number(cfg.max_attempts || 1));
  const delay = cfg.retry_delay_seconds ?? 2;
  const opts = {
    option: target.option,
    ea: target.ea,
    timeout: cfg.browser_timeout_seconds ?? 20,
    queueWait: cfg.queue_wait_seconds ?? 300,
  };

  // 띄워 둔 창이 있으면 그걸로 간다 (warm.ts). 아직 줄에 서 있으면 차례를 기다린다.
  let box: Chrome | null = null;
  const warm = await takeWarm(target.key);
  if (warm) {
    if (!OPEN_BROWSERS.includes(warm.box)) OPEN_BROWSERS.push(warm.box);
    if (warm.why === SESSION_DEAD) return { ok: false, reason: warm.why, stage: "opened", dead: true };
    // 줄에서 시간이 다 됐어도 창은 쓴다 — 그사이 화면이 스스로 넘어갔을 수 있고, 아직 대기
    // 화면이면 buyIn 이 그 자리에서 마저 줄을 선다. 새 크롬은 맨 뒤다.
    box = warm.box;
    log.info("띄워 둔 크롬으로 이어서 삽니다.");
  }
  const result = await buyWith(cfg, cookie, target, name, box, attempts, delay, opts);
  // 사지 못했으면 창을 돌려준다 — 다음 재입고도 새 크롬 없이 이 창에서 새로 고쳐 간다.
  if (!result.bought.ok && result.box) giveBack(target.key, result.box, result.bought.reason);
  return result.bought;
}

async function buyWith(
  cfg: Config, cookie: string, target: Target, name: string, box: Chrome | null,
  attempts: number, delay: number,
  opts: { option: string; ea: number; timeout: number; queueWait: number },
): Promise<{ bought: BuyResult; box: Chrome | null }> {
  const done = (bought: BuyResult) => ({ bought, box });
  let last: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // **다시 할 때도 같은 창으로 간다.** 예전에는 창을 닫고 새 크롬을 띄웠는데, 대기열 순번이
    // 그 창의 쿠키에 붙어 있어 매번 맨 뒤로 갔다 (2026-10-03). 창을 못 쓸 때만 새로 띄운다.
    let got: Bought | null = box ? await buyIn(box, target.url, opts) : null;
    if (!got) {
      try {
        got = await openBuy(target.url, cookie, { ...opts, headless: cfg.browser_headless });
      } catch (e) {
        if (!(e instanceof BrowserError)) throw e;
        log.warn(`크롬을 띄우지 못했습니다 (${e.message}). 기본 브라우저로 상품 페이지만 엽니다.`);
        openDefaultBrowser(target.url);
        return done({ ok: false, reason: e.message, stage: "opened", dead: false });
      }
      OPEN_BROWSERS.push(got.chrome);
    }
    box = got.chrome;

    if (got.ok) {
      const stage = await sayArrived(cfg, got.chrome);
      // 결제창까지 갔으면, 결제가 끝나기를 지켜보다가 끝나면 디스코드로 알린다.
      if (stage === "submitted") {
        await watchUntilPaid(cfg, got.chrome, target, name);
      }
      // 주문서에 들어갔다가 쫓겨났으면 **산 것이 아니다.** 여기서 ok 를 돌려주면 감시가
      // "데려왔다" 며 멈추고 디스코드로 "결제해 주세요" 를 보낸다 — 빈 장바구니를 두고.
      // 그래서 실패로 돌려 감시를 잇게 한다. 다시 누르지는 않는다 — 쫓겨난 이유가
      // 대개 품절이라, 다음 조회가 재고를 다시 확인하는 편이 낫다.
      if (stage !== "submitted") {
        const where = await leftOrder(got.chrome);
        if (where) {
          return done({ ok: false, reason: await kickedReason(got.chrome, where), stage, dead: false });
        }
      }
      return done({ ok: true, reason: null, stage, dead: false });
    }

    last = got.reason;
    // 다시 해봐야 같다. 위에서 멈추게 한다.
    if (got.reason === SESSION_DEAD) {
      return done({ ok: false, reason: got.reason, stage: "opened", dead: true });
    }

    log.warn(`주문서까지 못 갔습니다 (${attempt}/${attempts}) — ${got.reason}`);
    // 사이트가 품절이라고 했으면 크롬을 또 띄워 같은 말을 들을 이유가 없다. 여기서
    // 접고 감시로 돌려보낸다 — 재고가 다시 생기는지는 API 가 먼저, 더 싸게 안다.
    if (lostRace(got.reason)) break;
    if (attempt < attempts) await sleep(delay * 1000);
  }

  // 창은 남긴다. 어디서 멈췄는지 사람이 봐야 판단이 되고, 손으로라도 사 볼 수 있다.
  // **지금은 건드리지 않는다** — 앞으로 띄우거나 상품 페이지로 되돌리는 것까지는 원하지 않았다
  // (2026-09-26). doBuy 가 warm.ts 에 돌려주어, 다음 재입고 때 그 창에서 새로 고쳐 간다.
  return done({ ok: false, reason: last, stage: "opened", dead: false });
}
