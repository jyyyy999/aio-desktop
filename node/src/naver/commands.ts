/** 한 번 부르고 끝나는 명령들. 지켜보는 것은 watch.ts · window.ts 가 한다. */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { writeFileSync } from "node:fs";
import { log, sayOk, sayStar, sayStep } from "../log.js";
import { comma, nowStamp } from "../util.js";
import {
  DUMP_PATH, cookieOf, entryOf, Quit, saveConfig, SOLDOUT, STATUS_LABEL,
  type Config, type State, type TargetSpec,
} from "./config.js";
import {
  CAPTCHA_SAID, getPage, hasLoginCookie, loginAlive, needsBrowser, PUSHED_BACK, sayHowto,
  sayPushedHowto, SiteError, type Session,
} from "./http.js";
import { notifyOpened } from "./notify.js";
import { doBuy, dumpedAlready, dumpHere, OPEN_BROWSERS } from "./order.js";
import {
  fetchStock, findProduct, firstKey, KEY_NAME, KEY_OPTIONS, KEY_PRICE, KEY_STATUS, KEY_STOCK,
  pageState, STATE_VARS, walk, type Node,
} from "./product.js";
import { parseTarget, parseUrl, productUrl, PRODUCT_RE, targetsOf } from "./targets.js";
import { buyNowInBrowser } from "./window.js";

/**
 * 클립보드에 있는 것을 그대로 가져온다.
 *
 * **명령줄로 받지 않는 것이 기본이다.** 파워셸은 따옴표 없는 세미콜론을 명령 구분자로
 * 읽는다. 쿠키 줄에는 세미콜론이 열몇 개씩 들어 있으니, 그대로 넘기면 프로그램에는
 * **첫 조각 하나만** 가고 나머지는 파워셸이 명령으로 실행하려 든다. 설정에는 NNB 하나만
 * 남는데 오류는 엉뚱한 데서 나서, 왜 안 되는지 알기 어렵다.
 *
 * fallback 은 못 읽었을 때 알려 줄 다른 방법이다(사람이 바로 다음에 칠 명령).
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
  let told = false;
  for (const target of targetsOf(cfg)) {
    let info;
    try {
      info = await fetchStock(s, target);
    } catch (e) {
      if (!(e instanceof SiteError)) throw e;
      log.error(`[${target.key}] ${e.message}`);
      // 벽이면 상품마다 같은 말을 되풀이하지 않는다. 갈 길은 한 번만 적는다.
      if (needsBrowser(e.message) && !told) {
        told = true;
        if (e.message === CAPTCHA_SAID) sayHowto();
        if (e.message === PUSHED_BACK) sayPushedHowto();
      }
      continue;
    }
    const option = info.option ? ` · ${info.option.text}` : "";
    log.info(`[${target.key}] ${target.label || info.name} — ${STATUS_LABEL[info.status]} ` +
      `(${info.stock}개, ${comma(info.price)}원)${option}`);
  }
}

/**
 * 상품 페이지에서 무엇을 찾았는지 적고, 찾은 JSON 을 파일로 남긴다.
 *
 * 이 프로그램이 네이버에 대해 세운 가정을 사람이 확인하는 자리다. 네이버가 구조를 바꾸면
 * 여기부터 본다.
 */
export async function cmdProbe(cfg: Config, s: Session, url: string): Promise<void> {
  const where = url || (cfg.targets?.length ? targetsOf(cfg)[0]!.url : "");
  if (!where) throw new Error("확인할 상품 주소를 주세요.");
  const [channel, productNo] = parseUrl(where);
  sayStep(`받는 중 — ${where}`);

  let html: string;
  try {
    html = await getPage(s, where);
  } catch (e) {
    if (!(e instanceof SiteError)) throw e;
    // 캡차 벽은 고칠 자리가 있는 고장이 아니다. 무슨 일인지 적고, 갈 수 있는 길을 알려 준다.
    log.error(e.message);
    if (e.message === CAPTCHA_SAID) sayHowto();
    if (e.message === PUSHED_BACK) sayPushedHowto();
    throw new Quit();
  }
  log.info(`페이지 ${html.length}바이트`);

  for (const name of STATE_VARS) {
    log.info(`  ${html.includes(name) ? "찾음  " : "없음  "} ${name}`);
  }

  const [name, state] = pageState(html);
  sayOk(`상태 JSON: ${name}`);

  const product = findProduct(state, productNo);
  sayOk(`상품 덩어리: 키 ${Object.keys(product).length}개`);
  const rows: [string, string[]][] = [
    ["재고", KEY_STOCK], ["판매상태", KEY_STATUS], ["이름", KEY_NAME],
    ["가격", KEY_PRICE], ["옵션", KEY_OPTIONS],
  ];
  for (const [label, names] of rows) {
    const hit = names.find((n) => n in product);
    const value = firstKey(product, names);
    const shown = value !== null && typeof value === "object"
      ? `(${Array.isArray(value) ? value.length : Object.keys(value as Node).length}개)`
      : String(value);
    log.info(`  ${label.padEnd(5)} ${hit ?? "— 못 찾음"} = ${shown}`);
  }

  // 채널 UID 가 보이면 상품 API 를 시험해 볼 수 있다.
  let uid: unknown = null;
  for (const node of walk(state)) {
    uid = node["channelUid"] ?? node["channelNo"];
    if (uid) break;
  }
  log.info(`  채널UID ${uid ?? "— 못 찾음"}`);

  writeFileSync(DUMP_PATH,
    `# ${where}\n# ${nowStamp()}\n` +
    `# 상태 JSON: ${name} · 채널 ${channel} · 상품 ${productNo} · 채널UID ${uid}\n\n` +
    `## 상품 덩어리\n${JSON.stringify(product, null, 2)}\n`,
    "utf-8");
  sayStar(`${basename(DUMP_PATH)} 에 남겼습니다`);
}

export async function cmdWhoami(cfg: Config, s: Session): Promise<void> {
  const cookie = cookieOf(cfg);
  const names = cookie.split(";").filter((p) => p.includes("=")).map((p) => p.split("=")[0]!.trim());
  log.info(`쿠키 ${names.length}개 · 신분(NID_AUT·NID_SES) ${hasLoginCookie(cookie) ? "있음" : "없음"}`);
  if (!names.length) throw new Error("쿠키가 없습니다. --cookie 로 넣어주세요.");

  if (await loginAlive(s)) sayOk("로그인돼 있습니다 — 살 수 있습니다");
  else log.error("세션이 끊겼습니다. 브라우저에서 다시 복사해 --cookie 로 넣어주세요.");
}

export function cmdAdd(cfg: Config, values: string[]): void {
  for (const value of values) {
    const [channel, productNo] = parseUrl(value);
    if (!channel) throw new Error("상품 주소를 통째로 넣어주세요 (채널 이름이 필요합니다).");
    const host = /smartstore\.naver\.com/.test(value) ? "smartstore.naver.com" : "brand.naver.com";
    const url = productUrl(channel, productNo, host);
    if ((cfg.targets ?? []).some((t) => parseTarget(t).key === productNo)) {
      log.info(`이미 있습니다: ${url}`);
      continue;
    }
    (cfg.targets ??= []).push(url);
    sayOk(`넣었습니다: ${url}`);
  }
  saveConfig(cfg);
}

/**
 * 클립보드(또는 준 값)의 상품 주소를 **이번에 볼 상품**으로 삼는다.
 *
 * 쓰는 흐름이 --cookie 와 같다. 상품 페이지 주소를 복사해 두고 부르면 끝이다.
 *
 * --add 와 다르다. --add 는 목록에 **더한다**. 이쪽은 목록을 **이 하나로 바꾼다** —
 * "지금은 이걸 본다" 는 뜻이라서다. 다만 빼는 것을 조용히 하지 않고, 무엇을 뺐는지 적어
 * 둔다. 같은 상품이 이미 목록에 있었으면 거기 적어 둔 수량·옵션·상한가를 그대로 가져간다.
 * 주소만 다시 넣었다고 그 설정을 잃으면 사고다.
 *
 * 주소는 주변에 딴 글자가 붙어 있어도 된다. 공유하기로 복사하면 이름이 앞에 붙는다.
 */
export async function cmdLink(cfg: Config, value: string, readStdin: () => Promise<string>): Promise<void> {
  let raw = value;
  if (value === "-clip-") {
    raw = clipboardText("--link <URL>");
    log.info(`클립보드에서 ${raw.length}자를 읽었습니다.`);
  } else if (value === "-") {
    process.stderr.write("상품 주소를 붙여넣고 Ctrl+Z 를 누른 뒤 Enter (취소는 Ctrl+C)\n");
    raw = (await readStdin()).trim();
  }

  const found = PRODUCT_RE.exec(raw || "");
  if (!found) {
    log.error(`상품 주소를 못 찾았습니다: ${(raw || "(빈 클립보드)").slice(0, 80)}`);
    log.info("  상품 페이지 주소를 복사한 뒤 다시 불러주세요.");
    log.info("  예) https://smartstore.naver.com/xoxo_xoplay/products/13485710677");
    throw new Quit();
  }

  const channel = found[1]!;
  const productNo = found[2]!;
  const host = found[0].includes("smartstore") ? "smartstore.naver.com" : "brand.naver.com";
  const url = productUrl(channel, productNo, host);

  const keep = (cfg.targets ?? []).find((t) => parseTarget(t).key === productNo);
  const entry: TargetSpec = typeof keep === "object" && keep !== null ? { ...keep } : {};
  entry.url = url;

  const dropped = (cfg.targets ?? [])
    .filter((t) => parseTarget(t).key !== productNo)
    .map((t) => parseTarget(t).url);
  cfg.targets = [entry];
  saveConfig(cfg);

  sayOk(`이 상품을 봅니다: ${url}`);
  if (keep) {
    sayStep(`전에 적어 둔 설정을 그대로 씁니다 (수량 ${entry.ea || 1} · ` +
      `옵션 ${entry.option || "—"} · 상한가 ${entry.max_price || "—"})`);
  }
  for (const gone of dropped) {
    log.info(`목록에서 뺐습니다: ${gone}  (다시 넣으려면 --add ${gone})`);
  }
}

/**
 * 기다리지 않고 지금 바로 산다 (order_action 이 정한 데까지).
 *
 * alwaysDump 는 --dump-pay 로 불렀다는 뜻이다. 잘 갔든 아니든 끝난 뒤 화면을 받아 적는다 —
 * 그게 그 명령의 목적이다. 네이버페이 인증 화면을 처음 한 번 받아 적으려고 둔다.
 */
export async function cmdBuy(
  cfg: Config, s: Session, state: State, url: string, alwaysDump = false,
): Promise<void> {
  try {
    await buyNow(cfg, s, state, url);
  } finally {
    if (alwaysDump) {
      const box = OPEN_BROWSERS[OPEN_BROWSERS.length - 1];
      // 결제하기 뒤에서 이미 적었으면 또 적지 않는다 — 같은 파일을 두 번 덮을 뿐이다.
      if (!box) log.warn("받아 적을 크롬 창이 없습니다.");
      else if (!dumpedAlready(box)) await dumpHere(box);
    }
  }
}

async function buyNow(cfg: Config, s: Session, state: State, url: string): Promise<void> {
  const target = parseTarget(url);

  let info;
  try {
    info = await fetchStock(s, target);
  } catch (e) {
    if (!(e instanceof SiteError) || !needsBrowser(e.message)) throw e;
    // HTTP 로는 재고도 못 묻는다(캡차 벽이거나 TLS 지문 때문이거나). 크롬 창에서
    // 조회부터 구매까지 한다 — 창을 둘로 나누면 캡차를 두 번 풀어야 한다.
    sayStep(`HTTP 가 막혔습니다 (${e.message}) — 크롬 창에서 곧장 해봅니다`);
    await buyNowInBrowser(cfg, state, target);
    return;
  }

  log.info(`[${target.key}] ${info.name} — ${STATUS_LABEL[info.status]}`);
  if (info.status === SOLDOUT) throw new Error("품절입니다.");

  const got = await doBuy(cfg, cookieOf(cfg), target, info);
  if (got.ok) {
    // 손으로 산 상품이 감시 목록에도 있으면, 다음 실행에서 또 산다. 여기서 기록해 둔다.
    const entry = entryOf(state, target.key);
    entry.name = target.label || info.name;
    entry.opened = true;
    entry.opened_at = nowStamp();
    entry.last_try_at = entry.opened_at;
    entry.stage = got.stage;
    entry.done = !!cfg.stop_after_success;
    await notifyOpened(cfg, target, info, got.stage);
  } else {
    log.warn(`주문서를 못 열었습니다 — ${got.reason}`);
  }
}
