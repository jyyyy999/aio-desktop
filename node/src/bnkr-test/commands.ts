/** 한 번 부르고 끝나는 명령들. 지켜보는 것은 watch.ts 가 한다. */
import { execFileSync } from "node:child_process";
import {
  saveConfig, saveState, type Config, type Mode, type State, type TargetEntry,
} from "./config.js";
import { Session, SiteError } from "./http.js";
import { log, sayStep } from "./log.js";
import { blockingReason, doCart } from "./cart.js";
import { notifyCarted } from "./notify.js";
import { openLanding } from "./landing.js";
import { fetchList, parseWatch } from "./list.js";
import {
  cartItems, CART_URL, fetchGoods, fetchStock, goodsMeta, IN_STOCK, loginInfo, SOLDOUT,
  STATUS_LABEL,
} from "./site.js";
import { parseTarget, targetEntry, targetsOf, type Target } from "./targets.js";
import { cell, width } from "./ui.js";
import { nowStamp, priceText } from "./util.js";

/**
 * 클립보드에서 문자열을 그대로 가져온다. --cookie 나 --pin 처럼 셸을 거치고 싶지 않은
 * 값을 받을 때 쓴다.
 */
export function clipboardText(): string {
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
    throw new Error(`클립보드를 읽지 못했습니다 (${(e as Error).message}). 값을 직접 주세요.`);
  }
}

/**
 * 복사해 둔 Cookie 줄을 클립보드에서 그대로 가져온다.
 *
 * 명령줄로 받으면 파워셸이 값 안의 따옴표를 문자열 끝으로 읽는다. 쿠키 줄에는 따옴표가
 * 든 값이 섞여 있어서(_fcOM 이 그렇다) 한 덩어리가 여러 인자로 쪼개진다. 셸을 거치지
 * 않는 길이 하나 필요하다.
 */
export function cookieFromClipboard(): string {
  return clipboardText();
}

/**
 * 이름으로 목록을 훑어 gno 를 찾는다.
 *
 * 드랍을 기다릴 때, 상품이 이미 등록돼 있으면 번호가 있다. 그러면 목록을 훑는 대신 그
 * 번호를 targets 에 적어 두는 편이 낫다 — 목록 한 장이 150KB 인데 재고 조회는 113바이트라,
 * 같은 일을 1000분의 1로 할 수 있다.
 */
export async function cmdFind(s: Session, words: string[], pages = 3): Promise<void> {
  const keyword = words.join(" ").trim();
  const watch = parseWatch(keyword);
  if (!watch) throw new Error(`검색어를 알아보지 못했습니다: ${keyword}`);

  const { items, total } = await fetchList(s, watch, { maxPages: pages, delay: 0.5 });
  if (!items.length) {
    log.warn(`'${keyword}' 로는 찾지 못했습니다. 아직 안 올라왔거나 이름이 다릅니다.`);
    return;
  }

  for (const item of items) {
    log.info(`[${item.gno}] ${item.name.slice(0, 52)} — ${STATUS_LABEL[item.status] ?? "?"} · ` +
      priceText(item.price));
  }
  log.info(`${items.length}개 (검색 ${total}장 중 ${Math.min(total, pages)}장)`);
  sayStep("담을 것을 정했으면: node dist/bnkr-test/index.js --add <gno>");
}

export async function cmdStatus(cfg: Config, s: Session): Promise<void> {
  for (const target of targetsOf(cfg)) {
    const gno = target.gno;
    try {
      const stock = await fetchStock(s, gno);
      const meta = await fetchGoods(s, gno);
      const status = stock.stock > 0 ? IN_STOCK : SOLDOUT;
      const note = meta.has_option ? " · 옵션 상품" : "";
      log.info(`[${gno}] ${target.label || meta.name} — ${STATUS_LABEL[status]} · ` +
        priceText(stock.price - stock.event_discount) + note);
    } catch (e) {
      if (!(e instanceof SiteError)) throw e;
      log.warn(`[${gno}] 조회 실패: ${e.message}`);
    }
  }
}

export async function cmdWhoami(s: Session): Promise<void> {
  const info = await loginInfo(s);
  if (!info.no) throw new Error("로그인되어 있지 않습니다. --cookie 로 세션 쿠키를 넣어주세요.");
  const level = info.level ? ` [${info.level}]` : "";
  log.info(`로그인됨 — ${info.name} 님${level} · 장바구니 ${info.cart_size}개`);
}

export async function cmdCartList(s: Session): Promise<void> {
  const info = await loginInfo(s);
  if (!info.no) throw new Error("로그인되어 있지 않습니다. --cookie 로 세션 쿠키를 넣어주세요.");

  const items = await cartItems(s);
  for (const item of items) {
    log.info(`[${item.gno || "?"}] ${item.name.slice(0, 60)} ×${item.ea} — ${priceText(item.price)}`);
  }
  if (!items.length) {
    // 사이트가 세는 개수와 우리가 읽은 개수가 다르면 그 사실을 그대로 말한다.
    if (info.cart_size) {
      log.warn(`장바구니에 ${info.cart_size}개가 있다고 하는데 목록을 읽지 못했습니다. ` +
        `장바구니 페이지 구조가 바뀐 것 같습니다: ${CART_URL}`);
    } else {
      log.info("장바구니가 비어 있습니다.");
    }
  } else {
    log.info(`총 ${items.length}개 (사이트 집계 ${info.cart_size}개)`);
  }
}

export function cmdAdd(cfg: Config, values: string[]): void {
  const known = new Set(targetsOf(cfg).map((t) => t.gno));
  const added: string[] = [];
  for (const value of values) {
    const target = parseTarget(value);
    if (!target) {
      log.warn(`상품 번호를 알아볼 수 없습니다: ${value}`);
      continue;
    }
    if (known.has(target.gno)) {
      log.info(`이미 담을 목록에 있습니다: ${target.gno}`);
      continue;
    }
    known.add(target.gno);
    cfg.targets.push(targetEntry(target));
    added.push(target.gno);
  }
  if (added.length) {
    saveConfig(cfg);
    log.info(`추가했습니다: ${added.join(", ")}`);
  }
}

/**
 * `task` 하위 명령들. targets 배열 자체는 그대로 두고, 각 항목을 개별 태스크로 다룬다.
 *
 *   task list                 지금 등록된 태스크와 상태
 *   task add gno|URL [옵션]    태스크 추가
 *   task remove gno            태스크를 목록에서 뺀다
 *   task pause / resume gno    감시에서 뺐다 켰다 (설정·기록은 남는다)
 *   task status [gno]          사이트에 직접 물어 지금 재고까지 확인
 */

/** cfg.targets 안에서 이 gno 를 가진 자리. 찾으면 지우거나 고쳐 쓸 수 있게 인덱스도 준다. */
function findTargetIndex(cfg: Config, gno: string): number {
  return targetsOf(cfg).findIndex((t) => t.gno === gno);
}

/** 이 태스크가 지금 어떤 상태인가. 상태 파일에 적힌 것을 한 마디로 옮긴다. */
function taskNote(entry: TargetEntry | undefined): string {
  if (!entry) return "";
  if (entry.done) return "done";
  // 담은 날짜까지는 필요 없다. 표에서 궁금한 것은 "언제쯤" 이고, 정확한 시각은 로그에 있다.
  if (entry.carted_at) {
    const at = entry.carted_at.split("T")[1]?.slice(0, 5) ?? entry.carted_at;
    return entry.landed ? `carted ${at}` : `carted ${at} (checkout failed)`;
  }
  if (entry.blocked) return `blocked: ${entry.blocked.split("(")[0]!.trim()}`;
  if (entry.status) return entry.status === IN_STOCK ? `in stock ${entry.stock ?? ""}`.trim() : "sold out";
  return "";
}

/**
 * 태스크 목록을 표로. 시각을 앞에 붙이지 않고 stdout 에 그대로 쓴다 —
 * 로그 줄처럼 찍으면 앞머리 길이 때문에 세로줄이 어긋나 표로 안 읽힌다.
 */
export function cmdTaskList(cfg: Config, state: State): void {
  const targets = targetsOf(cfg);
  if (!targets.length) {
    log.info("No tasks. Add one with: task add <gno|URL>");
    return;
  }

  // 칸 사이는 두 칸씩 띄운다. 붙여 두면 이름이 칸을 꽉 채웠을 때 옆 칸과 맞닿아 읽히지 않는다.
  const row = (cols: string[]) => cols.join("  ");
  const rows = targets.map((target, at) => row([
    cell(String(at + 1).padStart(2, "0"), 2),
    cell(target.gno, 9),
    // 상품 이름은 사이트에서 온 것이라 한글 그대로다. 폭으로 세어 자르는 이유가 여기 있다.
    cell(target.label || state.targets?.[target.gno]?.name || "", 32),
    cell(target.mode, 6),
    cell(`x${target.ea}`, 4),
    cell(target.paused ? "OFF" : "ON", 4),
    taskNote(state.targets?.[target.gno]),
  ]));

  const head = row([
    cell("#", 2), cell("GNO", 9), cell("PRODUCT", 32),
    cell("MODE", 6), cell("QTY", 4), cell("RUN", 4), "NOTE",
  ]);

  const paused = targets.filter((t) => t.paused).length;
  process.stdout.write(
    `\n${head}\n${"-".repeat(width(head) + 8)}\n${rows.join("\n")}\n\n` +
    `${targets.length} tasks · ${targets.length - paused} active · ${paused} paused\n\n`,
  );
}

export interface TaskAddOpts { ea?: number; mode?: string; max_price?: number; label?: string }

export function cmdTaskAdd(cfg: Config, value: string, opts: TaskAddOpts = {}): void {
  const target = parseTarget({ gno: value, url: value, ...opts });
  if (!target) {
    log.warn(`Not a product number: ${value}`);
    return;
  }
  if (findTargetIndex(cfg, target.gno) >= 0) {
    log.info(`Task already exists: ${target.gno} (remove it first to change it)`);
    return;
  }
  cfg.targets.push(targetEntry(target));
  saveConfig(cfg);
  log.info(`Task added: [${target.gno}] ${target.label || ""} ` +
    `${target.mode} x${target.ea}`.trim());
}

export function cmdTaskRemove(cfg: Config, gno: string): void {
  const before = cfg.targets.length;
  cfg.targets = targetsOf(cfg).filter((t) => t.gno !== gno).map(targetEntry);
  if (cfg.targets.length === before) {
    log.warn(`No such task: ${gno}`);
    return;
  }
  saveConfig(cfg);
  log.info(`Task removed: ${gno} (cart history and goods cache are kept)`);
}

function setPaused(cfg: Config, gno: string, paused: boolean): void {
  const targets = targetsOf(cfg);
  const target = targets.find((t) => t.gno === gno);
  if (!target) {
    log.warn(`No such task: ${gno}`);
    return;
  }
  if (target.paused === paused) {
    log.info(`Already ${paused ? "paused" : "active"}: ${gno}`);
    return;
  }
  target.paused = paused;
  cfg.targets = targets.map(targetEntry);
  saveConfig(cfg);
  log.info(`Task ${paused ? "paused" : "resumed"}: ${gno} ` +
    "— a running watch picks this up on its next pass");
}

export const cmdTaskPause = (cfg: Config, gno: string): void => setPaused(cfg, gno, true);
export const cmdTaskResume = (cfg: Config, gno: string): void => setPaused(cfg, gno, false);

/** task status [gno]. 주면 그것만, 안 주면 전부 — 실제로 사이트에 물어 지금 값을 본다. */
export async function cmdTaskStatus(cfg: Config, s: Session, gno?: string): Promise<void> {
  const targets = gno ? targetsOf(cfg).filter((t) => t.gno === gno) : targetsOf(cfg);
  if (gno && !targets.length) {
    log.warn(`No such task: ${gno}`);
    return;
  }
  for (const target of targets) {
    try {
      const stock = await fetchStock(s, target.gno);
      const meta = await fetchGoods(s, target.gno);
      const label = stock.stock > 0 ? `in stock ${stock.stock}` : "sold out";
      const note = meta.has_option ? " · has options" : "";
      log.info(`[${target.gno}] ${target.label || meta.name} — ` +
        `${target.paused ? "OFF · " : ""}${label} · ` +
        priceText(stock.price - stock.event_discount) + note);
    } catch (e) {
      if (!(e instanceof SiteError)) throw e;
      log.warn(`[${target.gno}] lookup failed: ${e.message}`);
    }
  }
}

/** --cart / --buy. 기다리지 않고 지금 담는다. */
export async function cmdNow(
  cfg: Config, s: Session, state: State, gno: string, mode: Mode, ea: number,
): Promise<void> {
  const meta = await goodsMeta(s, state, gno, { refresh: true });
  const stock = await fetchStock(s, gno);
  const target = { gno, ea, mode, max_price: 0, label: null };

  const reason = blockingReason(cfg, target, meta, stock);
  if (reason) throw new Error(`담지 않습니다 — ${reason}`);

  const got = await doCart(cfg, s, meta, mode, ea);
  if (!got.ok) throw new Error(`담기 실패 — ${got.reason}`);

  // 손으로 담은 상품이 감시 목록에도 있으면, 다음 실행에서 또 담긴다. 여기서 기록해 둔다.
  const entry = ((state.targets ??= {})[gno] ??= {});
  entry.name = meta.name;
  entry.carted_at = nowStamp();
  entry.last_try_at = entry.carted_at;
  entry.done = !!cfg.stop_after_success;

  await notifyCarted(cfg, meta, mode, got.ea, stock.price - stock.event_discount);
  entry.landed = await openLanding(cfg, mode, s, meta);
  saveState(state);
}
