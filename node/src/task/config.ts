/**
 * 통합 태스크 설정. bnkr-test 와 lotte-test 를 한 프로세스에서 돌리기 위한 목록이다.
 *
 *   task_config.json     사고 싶은 것을 "사이트 + 상품" 으로 한 줄에 적는다.
 *                        여기가 감시 대상의 주인이다.
 *
 * 사이트별 설정(쿠키·결제·브라우저·웹훅·주기·동시성)은 **기존 파일을 그대로 쓴다** —
 * bnkr_test_config.json / lotteon_test_config.json. 여기서 다시 적지 않는다.
 * 다만 그 파일들의 `targets` 만은 이 목록에서 맞춰 쓴다. 그래야 사이트 루프가 스스로
 * 다시 읽고(파일 변경 감지) 실시간 반영이 두 판에서 똑같이 동작한다.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASE as BNKR_BASE, CONFIG_PATH as BNKR_CONFIG_PATH, loadConfig as bnkrLoadConfig,
} from "../bnkr-test/config.js";
import { CONFIG_PATH as LOTTE_CONFIG_PATH, loadConfig as lotteLoadConfig } from "../lotte-test/config.js";
import { parseTarget as bnkrParseTarget, targetEntry as bnkrTargetEntry } from "../bnkr-test/targets.js";
import { parseGno } from "../bnkr-test/site.js";
import { parseUrl as lotteParseUrl, parseTarget as lotteParseTarget } from "../lotte-test/targets.js";

export const TASK_CONFIG_PATH = join(BNKR_BASE, "task_config.json");

export type Site = "bnkr" | "lotte";

/** 태스크 한 줄. site 가 어느 사이트의 무슨 상품을 살지 말한다. */
export interface Task {
  site: Site;
  /** bnkr: gno (숫자), lotte: 상품 주소 (또는 상품번호). 준 대로 둔다. */
  product: string;
  ea: number;
  /** bnkr 전용: ADD | DIRECT | GIFT */
  mode: string;
  /** lotte 전용: 옵션 상품이면 무엇을 고를지 */
  option: string;
  max_price: number;
  label: string;
  paused: boolean;
}

export interface TaskConfig {
  tasks: Task[];
}

/** 파일에 적힌 한 줄 → 태스크. 모르는 것은 그대로 두지 않고 말한다. */
export function parseTask(entry: unknown): Task | null {
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    const site = String(e["site"] ?? "");
    if (site !== "bnkr" && site !== "lotte") return null;
    const product = String(e["product"] ?? "").trim();
    if (!product) return null;
    return {
      site,
      product,
      ea: Math.max(1, Number(e["ea"] ?? 1)),
      mode: String(e["mode"] ?? "").toUpperCase() || (site === "bnkr" ? "ADD" : ""),
      option: String(e["option"] ?? "").trim(),
      max_price: Number(e["max_price"] ?? 0),
      label: String(e["label"] ?? "").trim(),
      paused: Boolean(e["paused"]),
    };
  }
  return null;
}

/**
 * 설정 파일에 적힌 그대로 돌려준다. 없으면 만든다.
 *
 * 처음 만들 때는 **기존 사이트 설정의 targets 를 베껴 온다.** 두 파일에 이미 적어 둔
 * 것을 여기 다시 적게 하지 않는다. 감시 대상이 여기로 오면 그 파일들의 targets 는
 * 이 목록으로 맞춰지므로, 두 벌이 어긋날 일이 없다.
 */
export function loadTaskConfig(): TaskConfig {
  if (!existsSync(TASK_CONFIG_PATH)) {
    const seed: Task[] = [];
    try {
      for (const entry of bnkrLoadConfig().targets ?? []) {
        const t = bnkrParseTarget(entry);
        if (t) seed.push({
          site: "bnkr", product: t.gno, ea: t.ea, mode: t.mode, option: "",
          max_price: t.max_price, label: t.label ?? "", paused: t.paused,
        });
      }
    } catch { /* 본판 설정이 없거나 깨졌다. 기본값으로 시작한다. */ }
    try {
      for (const entry of lotteLoadConfig().targets ?? []) {
        const t = lotteParseTarget(entry);
        seed.push({
          site: "lotte", product: t.url, ea: t.ea, mode: "", option: t.option,
          max_price: t.max_price, label: t.label, paused: false,
        });
      }
    } catch { /* 마찬가지 */ }
    writeFileSync(TASK_CONFIG_PATH, JSON.stringify({ tasks: seed }, null, 2), "utf-8");
    process.stderr.write(
      `task_config.json 을 만들었습니다 — 기존 사이트 설정에서 ${seed.length}개를 베껴 왔습니다.\n`,
    );
  }
  const raw = JSON.parse(readFileSync(TASK_CONFIG_PATH, "utf-8")) as { tasks?: unknown[] };
  const tasks: Task[] = [];
  for (const entry of raw.tasks ?? []) {
    const task = parseTask(entry);
    if (task) tasks.push(task);
  }
  return { tasks };
}

export function saveTaskConfig(cfg: TaskConfig): void {
  writeFileSync(TASK_CONFIG_PATH, JSON.stringify({ tasks: cfg.tasks }, null, 2), "utf-8");
}

/** 설정 파일이 마지막으로 바뀐 시각. 바뀌었는지만 알면 되므로 내용은 안 본다. */
export function taskStamp(): bigint {
  try {
    return statSync(TASK_CONFIG_PATH, { bigint: true }).mtimeNs;
  } catch {
    return 0n;
  }
}

/** 태스크를 표시·상태 조회에 쓸 열쇠. bnkr 는 gno, lotte 는 상품번호. */
export function taskKey(task: Task): string {
  if (task.site === "bnkr") return parseGno(task.product) ?? task.product;
  try {
    return lotteParseUrl(task.product);
  } catch {
    return task.product;
  }
}

/**
 * 통합 목록을 사이트별 설정 파일의 targets 로 맞춰 쓴다.
 *
 * **다른 키는 건드리지 않는다** — 쿠키·결제·브라우저 설정은 그대로 두고 targets 만
 * 바꾼다. 사이트 루프는 자기 파일이 바뀌는 것을 보고 목록을 갈아 끼우므로, 여기서
 * 파일을 고쳐 주면 실시간 반영이 그대로 이어진다.
 *
 * bnkr 는 paused 를 설정에 남긴다(그 판이 OFF 로 알고 있다). lotte 는 그 개념이
 * 없으므로 쉬는 태스크는 파일에 아예 쓰지 않는다.
 */
/**
 * 통합 목록을 사이트별 설정 파일의 targets 로 맞춰 쓴다.
 *
 * **다른 키는 건드리지 않는다** — 쿠키·결제·브라우저 설정은 그대로 두고 targets 만
 * 바꾼다. 사이트 루프는 자기 파일이 바뀌는 것을 보고 목록을 갈아 끼우므로, 여기서
 * 파일을 고쳐 주면 실시간 반영이 그대로 이어진다.
 *
 * bnkr 는 paused 를 설정에 남긴다(그 판이 OFF 로 알고 있다). lotte 는 그 개념이
 * 없으므로 쉬는 태스크는 파일에 아예 쓰지 않는다.
 *
 * includeEmpty 를 주면 태스크가 없는 사이트도 targets 를 비워 쓴다. 러너가 도는 동안
 * 이 목록이 주인이라는 뜻이다 — bnkr 루프가 discover(목록 훑기) 만으로 도는 경우,
 * 낡은 targets 가 남아 있으면 그것까지 같이 지켜보게 된다. 그래서 러너 시작 시에는
 * 비워 쓰는 쪽이 안전하다.
 */
export function syncTargets(cfg: TaskConfig, opts: { includeEmpty?: boolean } = {}): void {
  const bnkrTasks = cfg.tasks.filter((t) => t.site === "bnkr");
  const lotteTasks = cfg.tasks.filter((t) => t.site === "lotte" && !t.paused);

  if (bnkrTasks.length || opts.includeEmpty || !existsSync(BNKR_CONFIG_PATH)) {
    // 파일을 통째로 다시 쓰지 않는다. targets 만 갈아 끼운다 — 다른 설정은
    // 손으로 적어 둔 그대로 남아야 한다.
    const raw = readRaw(BNKR_CONFIG_PATH, bnkrLoadConfig);
    const targets = bnkrTasks.map((t) => {
      const mode = (t.mode || "ADD").toUpperCase();
      return bnkrTargetEntry({
        gno: parseGno(t.product) ?? t.product,
        ea: t.ea,
        mode: mode as "ADD" | "DIRECT" | "GIFT",
        max_price: t.max_price,
        label: t.label || null,
        paused: t.paused,
      });
    });
    writeIfChanged(BNKR_CONFIG_PATH, raw, "targets", targets);
  }

  if (lotteTasks.length || opts.includeEmpty || !existsSync(LOTTE_CONFIG_PATH)) {
    const raw = readRaw(LOTTE_CONFIG_PATH, lotteLoadConfig);
    const targets = lotteTasks.map((t) => {
      if (t.ea === 1 && !t.option && !t.max_price && !t.label) return t.product;
      const spec: Record<string, unknown> = { url: t.product };
      if (t.ea !== 1) spec["ea"] = t.ea;
      if (t.option) spec["option"] = t.option;
      if (t.max_price) spec["max_price"] = t.max_price;
      if (t.label) spec["label"] = t.label;
      return spec;
    });
    writeIfChanged(LOTTE_CONFIG_PATH, raw, "targets", targets);
  }
}

/**
 * targets 가 바뀌었을 때만 파일을 고친다.
 *
 * 사이트 루프는 파일 mtime 으로 재로딩을 판단한다. 내용이 같은데도 mtime 만 바꾸면
 * 쓸데없는 재로딩이 일어난다 — 한 사이트의 태스크를 고쳤다고 다른 사이트 루프까지
 * 깨어나서는 안 된다.
 */
function writeIfChanged(
  path: string, raw: Record<string, unknown>, key: string, targets: unknown[],
): void {
  const before = JSON.stringify(raw[key]);
  const after = JSON.stringify(targets);
  if (before === after) return;
  raw[key] = targets;
  writeFileSync(path, JSON.stringify(raw, null, 2), "utf-8");
}

/**
 * 설정 파일을 있는 그대로 읽는다. 없으면 기본값으로 새로 만들고 그것을 돌려준다.
 * loadConfig() 를 그대로 쓰지 않는 이유는, 그 함수는 기본값을 섞어 돌려주므로
 * 다시 쓰면 파일이 기본값으로 부풀기 때문이다.
 */
function readRaw(path: string, fallback: () => Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return fallback() as unknown as Record<string, unknown>;
  }
}

/** 사이트 이름 → 사람이 읽을 이름. */
export const SITE_LABEL: Record<Site, string> = {
  bnkr: "반다이남코코리아몰",
  lotte: "롯데온",
};
