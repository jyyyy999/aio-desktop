/**
 * 태스크 관리 명령. 한 번 부르고 끝나는 것들이다. 지켜보는 것은 watch.ts 가 한다.
 *
 *   task list                태스크 표
 *   task add --site S 상품   태스크 추가 (--ea --mode --option --max-price --label)
 *   task remove S 키         태스크 제거
 *   task pause|resume S 키   껐다 켰다
 *   task status [S]          사이트에 직접 물어 지금 재고
 *   task cookie S [값]       세션 쿠키 저장 (값 없으면 클립보드)
 *   task pin S [값]          간편결제 비밀번호 저장 (값 없으면 클립보드)
 */
import { cell, width } from "../ui.js";
import {
  loadTaskConfig, saveTaskConfig, syncTargets, taskKey, type Site, type Task,
} from "./config.js";
import { log, sayOk } from "./log.js";

// --- 사이트별 재료 ----------------------------------------------------------
import {
  cookieOf as bnkrCookieOf, loadConfig as bnkrLoadConfig, loadState as bnkrLoadState,
  saveConfig as bnkrSaveConfig,
} from "../bnkr-test/config.js";
import { newSession as bnkrNewSession } from "../bnkr-test/http.js";
import { cookieFromClipboard } from "../bnkr-test/commands.js";
import { fetchGoods, fetchStock as bnkrFetchStock, IN_STOCK, parseGno } from "../bnkr-test/site.js";

import {
  cookieOf as lotteCookieOf, loadConfig as lotteLoadConfig, loadState as lotteLoadState,
  saveConfig as lotteSaveConfig,
} from "../lotte-test/config.js";
import { newSession as lotteNewSession } from "../lotte-test/http.js";
import { clipboardText as lotteClipboard } from "../lotte-test/commands.js";
import { fetchStock as lotteFetchStock } from "../lotte-test/product.js";
import { parseUrl as lotteParseUrl } from "../lotte-test/targets.js";

export function parseSite(value: string): Site {
  const v = String(value ?? "").toLowerCase().trim();
  if (v === "bnkr" || v === "lotte") return v;
  throw new Error(`사이트는 bnkr 또는 lotte 입니다: ${value}`);
}

/** 상태 파일에서 이 태스크의 한 줄. 사이트별 상태 파일을 그대로 읽는다. */
function entryNote(task: Task): string {
  const state = task.site === "bnkr" ? bnkrLoadState() : lotteLoadState();
  const entry = (state.targets as Record<string, Record<string, unknown>> | undefined)?.[taskKey(task)];
  if (!entry) return "";
  if (entry.done) return "done";
  if (task.site === "bnkr") {
    if (entry.carted_at) {
      const at = String(entry.carted_at).split("T")[1]?.slice(0, 5) ?? String(entry.carted_at);
      return entry.landed ? `carted ${at}` : `carted ${at} (checkout failed)`;
    }
    if (entry.blocked) return `blocked: ${String(entry.blocked).split("(")[0]!.trim()}`;
    if (entry.status) return entry.status === IN_STOCK ? `in stock ${entry.stock ?? ""}`.trim() : "sold out";
  } else {
    if (entry.opened) return `opened (${String(entry.stage ?? "")})`;
    if (entry.blocked) return `blocked: ${String(entry.blocked).split("(")[0]!.trim()}`;
    if (entry.status) return entry.status === IN_STOCK ? "in stock" : "sold out";
  }
  return "";
}

/** 태스크 표. 상태 파일까지 읽어 한 줄로 보여 준다. */
export function cmdList(): void {
  const cfg = loadTaskConfig();
  if (!cfg.tasks.length) {
    log.info("No tasks. Add one with: task add --site bnkr|lotte <상품>");
    return;
  }

  const row = (cols: string[]) => cols.join("  ");
  const rows = cfg.tasks.map((task, at) => row([
    cell(String(at + 1).padStart(2, "0"), 2),
    cell(task.site.toUpperCase(), 5),
    cell(task.label || taskKey(task), 30),
    cell(task.site === "bnkr" ? task.mode : task.option || "—", 6),
    cell(`x${task.ea}`, 4),
    cell(task.paused ? "OFF" : "ON", 4),
    entryNote(task),
  ]));

  const head = row([
    cell("#", 2), cell("SITE", 5), cell("PRODUCT", 30),
    cell("MODE", 6), cell("QTY", 4), cell("RUN", 4), "NOTE",
  ]);

  const paused = cfg.tasks.filter((t) => t.paused).length;
  process.stdout.write(
    `\n${head}\n${"-".repeat(width(head) + 8)}\n${rows.join("\n")}\n\n` +
    `${cfg.tasks.length} tasks · ${cfg.tasks.length - paused} active · ${paused} paused\n\n`,
  );
}

export interface AddOpts {
  site: string;
  product: string;
  ea?: number;
  mode?: string;
  option?: string;
  max_price?: number;
  label?: string;
}

export function cmdAdd(opts: AddOpts): void {
  const site = parseSite(opts.site);
  const cfg = loadTaskConfig();

  let product = String(opts.product ?? "").trim();
  if (!product) throw new Error("상품을 주세요 (bnkr: gno 또는 URL, lotte: URL 또는 상품번호).");

  // bnkr 는 gno 로, lotte 는 상품 주소로 정규화한다. 모르는 것은 여기서 걸러진다.
  if (site === "bnkr") {
    const gno = parseGno(product);
    if (!gno) throw new Error(`상품 번호를 알아보지 못했습니다: ${product}`);
    product = gno;
  } else {
    // 주소든 상품번호든 알아들을 수 있는지 확인만 한다. 준 대로 저장한다 —
    // sitmNo(옵션) 가 붙은 주소는 그 꼬리를 떼면 안 된다.
    lotteParseUrl(product);
  }

  const task: Task = {
    site,
    product,
    ea: Math.max(1, Number(opts.ea ?? 1)),
    mode: (opts.mode || (site === "bnkr" ? "ADD" : "")).toUpperCase(),
    option: String(opts.option ?? "").trim(),
    max_price: Number(opts.max_price ?? 0),
    label: String(opts.label ?? "").trim(),
    paused: false,
  };

  const key = taskKey(task);
  if (cfg.tasks.some((t) => t.site === site && taskKey(t) === key)) {
    log.info(`이미 있습니다: [${site}] ${key}`);
    return;
  }

  cfg.tasks.push(task);
  saveTaskConfig(cfg);
  syncTargets(cfg);
  sayOk(`추가했습니다: [${site}] ${task.label || key} ${task.mode} x${task.ea}`.trim());
}

/** 사이트 + 열쇠로 태스크 하나를 찾는다. 없으면 null. */
function findTask(cfg: { tasks: Task[] }, site: Site, key: string): Task | null {
  return cfg.tasks.find((t) => t.site === site && taskKey(t) === key) ?? null;
}

function mutate(site: Site, key: string, change: (task: Task) => void): void {
  const cfg = loadTaskConfig();
  const task = findTask(cfg, site, key);
  if (!task) {
    log.warn(`No such task: ${key} (site ${site})`);
    return;
  }
  change(task);
  saveTaskConfig(cfg);
  syncTargets(cfg);
}

export function cmdRemove(site: Site, key: string): void {
  const cfg = loadTaskConfig();
  const before = cfg.tasks.length;
  cfg.tasks = cfg.tasks.filter((t) => !(t.site === site && taskKey(t) === key));
  if (cfg.tasks.length === before) {
    log.warn(`No such task: ${key} (site ${site})`);
    return;
  }
  saveTaskConfig(cfg);
  syncTargets(cfg);
  log.info(`Task removed: ${key} (기록과 캐시는 남습니다)`);
}

export function cmdPause(site: Site, key: string): void {
  mutate(site, key, (t) => { t.paused = true; });
  log.info(`Task paused: ${key} — 도는 루프가 다음 바퀴에 뺍니다`);
}

export function cmdResume(site: Site, key: string): void {
  mutate(site, key, (t) => { t.paused = false; });
  log.info(`Task resumed: ${key} — 도는 루프가 다음 바퀴에 다시 넣습니다`);
}

/** 지금 재고를 사이트에 직접 물어 본다. 로그인 없이 되는 것만 쓴다. */
export async function cmdStatus(site?: Site): Promise<void> {
  const cfg = loadTaskConfig();
  const tasks = site ? cfg.tasks.filter((t) => t.site === site && !t.paused)
                     : cfg.tasks.filter((t) => !t.paused);
  if (!tasks.length) {
    log.info("확인할 태스크가 없습니다. task list 로 봐주세요.");
    return;
  }

  const bnkr = tasks.filter((t) => t.site === "bnkr");
  if (bnkr.length) {
    const bcfg = bnkrLoadConfig();
    const s = await bnkrNewSession(bnkrCookieOf(bcfg), {
      queueWatch: bcfg.queue_watch, queueMarkers: bcfg.queue_markers,
    });
    const state = bnkrLoadState();
    for (const task of bnkr) {
      const gno = taskKey(task);
      try {
        const stock = await bnkrFetchStock(s, gno);
        const meta = await fetchGoods(s, gno);
        const label = stock.stock > 0 ? `in stock ${stock.stock}` : "sold out";
        log.info(`[${gno}] ${task.label || meta.name} — ${label}`);
      } catch (e) {
        log.warn(`[${gno}] 조회 실패: ${(e as Error).message}`);
      }
    }
    void state;
  }

  const lotte = tasks.filter((t) => t.site === "lotte");
  if (lotte.length) {
    const lcfg = lotteLoadConfig();
    const s = lotteNewSession(lotteCookieOf(lcfg));
    for (const task of lotte) {
      const key = taskKey(task);
      try {
        const info = await lotteFetchStock(s, { url: task.product, key });
        const label = info.status === IN_STOCK ? "in stock" : "sold out";
        log.info(`[${key}] ${task.label || info.name || key} — ${label} · ${info.price}원`);
      } catch (e) {
        log.warn(`[${key}] 조회 실패: ${(e as Error).message}`);
      }
    }
  }
}

// --- 쿠키 / 비밀번호 --------------------------------------------------------

/** 쿠키를 사이트 설정에 저장한다. 값 없이 부르면 클립보드에서 가져온다. */
export async function cmdCookie(site: Site, value: string): Promise<void> {
  let raw = String(value ?? "").trim();
  if (!raw) {
    if (site === "bnkr") {
      raw = cookieFromClipboard();
      log.info(`클립보드에서 ${raw.length}자를 읽었습니다.`);
    } else {
      raw = lotteClipboard("--cookie -");
      log.info(`클립보드에서 ${raw.length}자를 읽었습니다.`);
    }
  }

  if (site === "bnkr") {
    const cfg = bnkrLoadConfig();
    if (!raw.split(";").filter((p) => p.includes("=")).length) {
      throw new Error("쿠키를 알아보지 못했습니다.");
    }
    cfg.cookie = raw;
    bnkrSaveConfig(cfg);
  } else {
    const cfg = lotteLoadConfig();
    if (!raw.split(";").filter((p) => p.includes("=")).length) {
      throw new Error("쿠키를 알아보지 못했습니다.");
    }
    cfg.cookie = raw;
    lotteSaveConfig(cfg);
  }
  sayOk(`쿠키를 저장했습니다 (${site}). --whoami 로 확인해 보세요.`);
}

/** 간편결제 비밀번호를 사이트 설정에 저장한다. 값은 로그에 남기지 않는다. */
export function cmdPin(site: Site, value: string): void {
  let raw = String(value ?? "").trim();
  if (!raw) {
    raw = site === "bnkr" ? cookieFromClipboard() : lotteClipboard("--pin -");
    log.info(`클립보드에서 ${raw.length}자를 읽었습니다.`);
  }
  const digits = raw.replace(/\D/g, "");
  if (!digits) throw new Error("비밀번호를 알아보지 못했습니다. 숫자만 입력해 주세요.");

  if (site === "bnkr") {
    const cfg = bnkrLoadConfig();
    cfg.pg_password = digits;
    bnkrSaveConfig(cfg);
  } else {
    const cfg = lotteLoadConfig();
    cfg.pg_password = digits;
    lotteSaveConfig(cfg);
  }
  log.info(`간편결제 비밀번호를 저장했습니다 (${site}, ${digits.length}자리).`);
}

/** 저장된 쿠키가 있는가. 지켜보기 전에 확인용으로 쓴다. */
export function hasCookie(site: Site): boolean {
  return site === "bnkr"
    ? !!bnkrCookieOf(bnkrLoadConfig())
    : !!lotteCookieOf(lotteLoadConfig());
}
