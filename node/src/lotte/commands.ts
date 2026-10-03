/** 한 번 부르고 끝나는 명령들. 지켜보는 것은 watch.ts 가 한다. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { log, sayOk, sayStar, sayStep } from "../log.js";
import { priceText } from "../util.js";
import {
  DUMP_PATH, PG_DUMP_PATH, cookieOf, entryOf, Quit, saveConfig, SOLDOUT, STATUS_LABEL,
  type Config, type State,
} from "./config.js";
import { getPage, loginAlive, looksLikeCookie, SiteError, type Session } from "./http.js";
import { dumpPayment } from "./browser.js";
import { doBuy, OPEN_BROWSERS } from "./order.js";
import { fetchStock, findProduct, ldBlocks, readStock } from "./product.js";
import { parseTarget, PRODUCT_RE, targetFor, targetsOf, type Target } from "./targets.js";
import { statusLine } from "./watch.js";

/**
 * 클립보드에 있는 것을 그대로 가져온다.
 *
 * **명령줄로 받지 않는 것이 기본이다.** 파워셸은 따옴표 없는 세미콜론을 명령 구분자로
 * 읽는다. 쿠키 줄에는 세미콜론이 열몇 개씩 들어 있으니, 그대로 넘기면 프로그램에는
 * **첫 조각 하나만** 가고 나머지는 파워셸이 명령으로 실행하려 든다.
 *
 * 네이버 판에 같은 함수가 있지만 빌려 오지 않는다. 그쪽 config.ts 는 들이는 순간
 * 로그 파일을 naver-buy.log 로 돌려 버려서(useLogFile), 이 판의 로그가 거기로 샌다.
 */
export function clipboardText(fallback: string): string {
  try {
    if (process.platform === "win32") {
      // 출력 인코딩을 못 박는다. 안 그러면 cp949 로 나와 값이 깨질 수 있다.
      const out = execFileSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw",
      ], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
      return out.trim();
    }
    const command = process.platform === "darwin" ? "pbpaste" : "xclip";
    const args = process.platform === "darwin" ? [] : ["-selection", "clipboard", "-o"];
    return execFileSync(command, args, { encoding: "utf-8" }).trim();
  } catch (e) {
    throw new Error(`클립보드를 읽지 못했습니다 (${(e as Error).message}). ${fallback} 로 붙여넣어 주세요.`);
  }
}

export async function cmdStatus(cfg: Config, s: Session): Promise<void> {
  for (const target of targetsOf(cfg)) {
    try {
      log.info(statusLine(target, await fetchStock(s, target)));
    } catch (e) {
      if (!(e instanceof SiteError)) throw e;
      log.error(`[${target.key}] ${e.message}`);
    }
  }
}

/**
 * 상품 페이지에서 무엇을 찾았는지 적고, 찾은 ld+json 을 파일로 남긴다.
 *
 * 이 프로그램이 롯데온에 대해 세운 가정을 사람이 확인하는 자리다. 롯데온이 구조를
 * 바꾸면 여기부터 본다.
 */
export async function cmdProbe(cfg: Config, s: Session, url: string): Promise<void> {
  const target = targetFor(cfg, url);
  sayStep(`받는 중 — ${target.url}`);

  let html: string;
  try {
    html = await getPage(s, target.url);
  } catch (e) {
    if (!(e instanceof SiteError)) throw e;
    log.error(e.message);
    throw new Quit();
  }
  log.info(`페이지 ${html.length}바이트`);

  const blocks = ldBlocks(html);
  log.info(`ld+json 덩어리 ${blocks.length}개: ` +
    blocks.map((one) => String(one["@type"] ?? "?")).join(", "));

  const product = findProduct(html, target.key);
  sayOk(`상품 덩어리: 키 ${Object.keys(product).length}개`);

  const info = readStock(product);
  log.info(`  이름   ${info.name}`);
  log.info(`  상품번호 ${info.sku}${info.sku === target.key ? "" : `  (주소의 ${target.key} 와 다릅니다)`}`);
  log.info(`  가격   ${priceText(info.price)}`);
  log.info(`  재고   ${STATUS_LABEL[info.status]}  ← ${info.raw_status}  (ld+json — 참고용)`);

  // 감시가 실제로 믿는 것은 이쪽이다. ld+json 은 품절에도 InStock 이라 해서 갈라 보여 준다.
  try {
    const api = await fetchStock(s, target);
    log.info(`  API    ${STATUS_LABEL[api.status]}  ← ${api.raw_status}`);
    if (api.status !== info.status) log.warn("  ld+json 과 API 가 다릅니다 — 감시는 API 를 따릅니다");
  } catch (e) {
    if (!(e instanceof SiteError)) throw e;
    log.error(`  API    ${e.message}`);
  }

  try {
    writeFileSync(DUMP_PATH, JSON.stringify(blocks, null, 2), "utf-8");
    sayOk(`찾은 ld+json 을 적어 뒀습니다: ${basename(DUMP_PATH)}`);
  } catch (e) {
    log.warn(`적지 못했습니다: ${(e as Error).message}`);
  }
}

export async function cmdWhoami(cfg: Config, s: Session): Promise<void> {
  const cookie = cookieOf(cfg);
  if (!cookie) {
    log.warn("저장된 쿠키가 없습니다. --cookie 로 넣어주세요.");
    throw new Quit();
  }
  const names = cookie.split(";").filter((p) => p.includes("=")).map((p) => p.split("=")[0]!.trim());
  log.info(`쿠키 ${names.length}개: ` + names.slice(0, 8).join(", ") + (names.length > 8 ? " …" : ""));

  if (await loginAlive(s)) sayOk("세션이 살아 있습니다 — 로그인된 상태입니다");
  else {
    log.error("세션이 끊겼습니다. 브라우저에서 다시 복사해 --cookie 로 넣어주세요.");
    throw new Quit();
  }
}

/** 살 상품을 설정에 넣는다. 이미 있는 것은 넣지 않는다. */
export function cmdAdd(cfg: Config, values: string[]): void {
  const have = new Set(targetsOf(cfg).map((t) => `${t.key}|${t.sitmNo}`));
  let added = 0;

  for (const value of values) {
    let target: Target;
    try {
      target = parseTarget(value);
    } catch (e) {
      log.error((e as Error).message);
      continue;
    }
    const seat = `${target.key}|${target.sitmNo}`;
    if (have.has(seat)) {
      log.info(`이미 있습니다: ${target.url}`);
      continue;
    }
    have.add(seat);
    // 주소 하나로 넣는다. 수량·옵션·상한가는 설정 파일에서 손으로 붙이면 된다 —
    // 그런 것까지 명령줄로 받으면 여러 개를 한 번에 넣을 수 없다.
    (cfg.targets ??= []).push(target.url);
    added += 1;
    sayOk(`넣었습니다: ${target.url}`);
  }

  if (added) {
    saveConfig(cfg);
    log.info(`${basename("lotteon_buy_config.json")} 에 ${added}개를 넣었습니다. ` +
      "수량(ea)·옵션(option)·상한가(max_price) 는 파일에서 붙여 주세요.");
  }
}

/**
 * 클립보드(또는 표준입력)의 주소를 감시 대상으로 삼는다.
 *
 * **설정 파일은 건드리지 않는다.** 이번 실행에만 그 상품 하나를 본다 — 상품 주소를
 * 복사해 두고 명령 한 번으로 지켜보기 시작하는 것이 이 옵션의 전부다.
 */
export async function cmdLink(
  cfg: Config, value: string, readStdin: () => Promise<string>,
): Promise<void> {
  let raw: string;
  if (value === "-clip-") raw = clipboardText("--link -");
  else if (value === "-") raw = await readStdin();
  else raw = value;

  // 주소 말고도 이것저것 복사돼 있을 수 있다. 그중에서 상품 주소만 골라낸다.
  const found = PRODUCT_RE.exec(raw.trim());
  const url = found ? found[0] : raw.trim();
  const target = parseTarget(raw.trim().includes("lotteon.com") ? raw.trim() : url);

  cfg.targets = [target.url];
  sayOk(`이번 실행은 이 상품만 봅니다: ${target.url}`);
}

/**
 * 지금 바로 산다. → 결제창까지 (order_action 이 정한 데까지)
 *
 * 사람이 직접 부른 명령이라, 품절→구매가능 으로 바뀔 때만 사는 규칙과 이미 샀다는
 * 기록을 적용하지 않는다. 그 판단은 이미 사람이 한 것이다.
 */
export async function cmdBuy(
  cfg: Config, s: Session, state: State, url: string, alwaysDump = false,
): Promise<void> {
  const target = targetFor(cfg, url);

  if (!looksLikeCookie(cookieOf(cfg))) {
    throw new Error("쿠키가 비어 있습니다. 브라우저에서 Cookie 줄을 복사해 --cookie 로 넣어주세요.");
  }

  const info = await fetchStock(s, target);
  log.info(statusLine(target, info));
  if (info.status === SOLDOUT) throw new Error("품절입니다.");

  const entry = entryOf(state, target.key);
  delete entry.done;
  const now = { ...cfg, buy_on_restock_only: false };

  const got = await doBuy(now, cookieOf(cfg), target);
  entry.opened = got.ok;
  entry.stage = got.stage;
  entry.done = got.ok && !!cfg.stop_after_success;
  if (!got.ok) log.warn(`주문서까지 못 갔습니다 — ${got.reason}`);

  // --dump-pay 로 부른 것이면 잘 갔든 아니든 받아 적는다. 그게 그 명령의 목적이다.
  if (alwaysDump) {
    const box = OPEN_BROWSERS[OPEN_BROWSERS.length - 1];
    if (!box) {
      log.warn("받아 적을 창이 없습니다.");
      return;
    }
    if (await dumpPayment(box, PG_DUMP_PATH)) {
      sayStar(`결제창 내용을 적어 뒀습니다: ${basename(PG_DUMP_PATH)}`);
      log.info("  이 파일을 보고 lotte/browser.ts 의 PAY_TEXTS·ORDER_TEXTS 를 고치면 됩니다.");
      log.info("  사람 정보(이름·연락처·카드번호)는 가리고 적었습니다.");
    }
  }
}
