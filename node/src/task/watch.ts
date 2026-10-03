/**
 * 통합 러너의 심장. bnkr-test 와 lotte-test 를 **한 프로세스에서 나란히** 돈다.
 *
 *   node dist/task/index.js  →  bnkr 루프 + lotte 루프 동시 시작
 *
 * 각 사이트 루프는 기존 판을 그대로 쓴다 — 감시·담기·주문서·결제 판단은 하나도 손대지
 * 않았다. 병렬성도 그대로다. bnkr 루프의 max_concurrency 는 bnkr 설정이, lotte 루프의
 * max_concurrency 는 lotte 설정이 정한다. 두 루프는 서로를 기다리지 않는다.
 *
 * **한 프로세스라서 조회가 느려지지 않는다.** 둘 다 I/O 바운드(async fetch)라
 * 이벤트 루프가 두 루프를 알아서 섞어 준다. 화면만 하나(공용 UI)이고, 로그 파일은
 * 사이트별로 그대로 갈라져 있다.
 */
import { loadTaskConfig, syncTargets, taskStamp, type Task, type TaskConfig } from "./config.js";
import { log } from "./log.js";
import { startDashboard, stopDashboard } from "./ui.js";

import {
  cookieOf as bnkrCookieOf, loadConfig as bnkrLoadConfig, loadState as bnkrLoadState,
  run as bnkrRun, saveState as bnkrSaveState, type State as BnkrState,
} from "../bnkr-test/config.js";
import { newSession as bnkrNewSession, type Session as BnkrSession } from "../bnkr-test/http.js";
import { watch as bnkrWatch } from "../bnkr-test/watch.js";

import {
  cookieOf as lotteCookieOf, loadConfig as lotteLoadConfig, loadState as lotteLoadState,
  run as lotteRun, saveState as lotteSaveState, type State as LotteState,
} from "../lotte-test/config.js";
import { newSession as lotteNewSession, type Session as LotteSession } from "../lotte-test/http.js";
import { watch as lotteWatch } from "../lotte-test/watch.js";

export interface RunOpts {
  once: boolean;
  dryRun: boolean;
}

/** 지금 도는 사이트 루프의 상태. SIGINT 로 끊길 때 저장하려고 붙잡아 둔다. */
const live = { bnkr: null as BnkrState | null, lotte: null as LotteState | null };

/**
 * task_config.json 이 바뀌는 것을 보고, 사이트별 설정 파일의 targets 를 맞춰 쓴다.
 *
 * 사이트 루프는 자기 설정 파일이 바뀌는 것을 보고 목록을 갈아 끼운다(bnkr: configStamp,
 * lotte: targets 비교). 그래서 여기서 파일을 고쳐 주면, 실행 중에 task_config.json 을
 * 고쳐도 다음 바퀴부터 반영된다 — 재시작이 필요 없다. → 멈출 수 있는 타이머
 */
function watchTaskFile(): NodeJS.Timeout {
  let stamp = taskStamp();
  const timer = setInterval(() => {
    const now = taskStamp();
    if (now !== stamp) {
      stamp = now;
      const fresh = loadTaskConfig();
      syncTargets(fresh, { includeEmpty: true });
      log.info("task_config.json 이 바뀌었습니다 — 사이트별 목록에 반영합니다");
    }
  }, 1000);
  timer.unref();
  return timer;
}

/** bnkr 루프 하나. 기존 bnkr-test 의 watch() 를 그대로 부른다. */
async function runBnkr(opts: RunOpts, tasks: Task[]): Promise<void> {
  bnkrRun.dryRun = opts.dryRun;
  const cfg = bnkrLoadConfig();
  // targets 는 이미 syncTargets 가 파일에 맞춰 썼다. 여기서 다시 만지지 않는다.
  const session: BnkrSession = await bnkrNewSession(bnkrCookieOf(cfg), {
    queueWatch: cfg.queue_watch, queueMarkers: cfg.queue_markers,
  });
  const state: BnkrState = bnkrLoadState();
  live.bnkr = state;
  log.info(`bnkr 루프 시작 — ${tasks.length}개 태스크`);
  try {
    // bnkr 판은 --dry-run 을 한 바퀴로 본다(본판 index.ts 와 같은 약속).
    await bnkrWatch(cfg, session, state, opts.once || opts.dryRun, opts.dryRun);
  } finally {
    bnkrSaveState(state);
  }
}

/** lotte 루프 하나. 기존 lotte-test 의 watch() 를 그대로 부른다. */
async function runLotte(opts: RunOpts, tasks: Task[]): Promise<void> {
  lotteRun.dryRun = opts.dryRun;
  const cfg = lotteLoadConfig();
  const session: LotteSession = lotteNewSession(lotteCookieOf(cfg));
  const state: LotteState = lotteLoadState();
  live.lotte = state;
  log.info(`lotte 루프 시작 — ${tasks.length}개 태스크`);
  try {
    await lotteWatch(cfg, session, state, opts.once);
  } finally {
    lotteSaveState(state);
  }
}

/** 죽어서 나온 루프의 상태를 저장한다. 러너가 끝나기 전에 부른다. */
export function saveLive(): void {
  if (live.bnkr) {
    try {
      bnkrSaveState(live.bnkr);
    } catch {
      // 못 적어도 여기서 더 할 수 있는 것이 없다.
    }
  }
  if (live.lotte) {
    try {
      lotteSaveState(live.lotte);
    } catch {
      // 마찬가지.
    }
  }
}

/**
 * 두 사이트를 한꺼번에 돈다. → 한 쪽이라도 제대로 끝났는가
 *
 * 한 루프가 죽어도 다른 쪽은 계속 돌게 한다 — bnkr 세션이 끊겼다고 lotte 까지
 * 접을 이유가 없다. 둘 다 죽었을 때만 실패로 끝낸다.
 */
export async function runAll(opts: RunOpts): Promise<boolean> {
  const cfg: TaskConfig = loadTaskConfig();
  // 러너가 도는 동안 이 목록이 targets 의 주인이다. 태스크가 없는 사이트는 비워 쓴다.
  syncTargets(cfg, { includeEmpty: true });

  const bnkrTasks = cfg.tasks.filter((t) => t.site === "bnkr" && !t.paused);
  const lotteTasks = cfg.tasks.filter((t) => t.site === "lotte" && !t.paused);

  const bnkrCfg = bnkrLoadConfig();
  const bnkrDiscover = (bnkrCfg.discover ?? []).length > 0;

  if (!bnkrTasks.length && !bnkrDiscover && !lotteTasks.length) {
    throw new Error(
      "task_config.json 의 tasks 가 비어 있습니다. " +
      "task add --site bnkr|lotte <상품> 으로 넣어주세요. " +
      "(또는 기존 사이트 설정의 discover 만으로 돌리려면 그 설정을 쓰세요)",
    );
  }

  startDashboard(cfg);
  const watchFile = watchTaskFile();

  const jobs: Promise<void>[] = [];
  // bnkr 은 discover(목록 훑기) 만 있어도 돌 가치가 있다. 그 설정은 bnkr 쪽 파일에 있다.
  if (bnkrTasks.length || bnkrDiscover) jobs.push(runBnkr(opts, bnkrTasks));
  if (lotteTasks.length) jobs.push(runLotte(opts, lotteTasks));

  const results = await Promise.allSettled(jobs);
  clearInterval(watchFile);
  stopDashboard();
  saveLive();

  let failed = 0;
  let reason = "";
  for (const r of results) {
    if (r.status === "rejected") {
      failed += 1;
      reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
    }
  }
  if (failed === results.length) {
    throw new Error(reason || "모든 루프가 실패했습니다.");
  }
  if (failed) log.error(`일부 루프가 실패했습니다: ${reason}`);
  return failed === 0;
}
