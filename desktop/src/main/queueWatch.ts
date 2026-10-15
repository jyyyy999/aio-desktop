/**
 * 열리기 전 대기열 보기. 태스크 창이 켜면 그 태스크의 상품을 몇 초마다 바깥에서 읽는다 (어댑터의 peekQueue —
 * 쿠키 없이, 줄에 서지 않는다). 태스크 창을 닫거나 끄면 멈춘다. 태스크를 띄울 때를 고르는 데 쓴다.
 *
 * 2026-10-10 MEGA 30th 때 손으로 하던 일을 옮긴 것이다 — 그날 잰 것은 태스크 창(TaskWatch)의 어림에 들어 있다.
 */
import { EventEmitter } from "node:events";
import type { QueuePeek, TaskDef } from "../shared/types.js";
import { ADAPTERS } from "./sites/index.js";

/** 이만큼마다 읽는다. 상품 페이지 3KB · 상품 API 20KB 한 번씩. */
const EVERY_MS = 10_000;
/** 이만큼 들고 있다 (10초마다면 15분). */
const KEEP = 90;

interface Watch {
  timer: NodeJS.Timeout;
  history: QueuePeek[];
  busy: boolean;
}

/**
 * 이벤트
 *   "peek" (p: QueuePeek)
 */
export class QueueWatch extends EventEmitter {
  private watches = new Map<string, Watch>();

  constructor(private readonly taskOf: (id: string) => TaskDef | undefined) {
    super();
  }

  /** 이 태스크의 사이트가 대기열을 볼 수 있나. */
  supports(task: TaskDef): boolean {
    return !!ADAPTERS[task.site].peekQueue;
  }

  /** 켜고 끈다. → 지금까지 읽은 것 */
  set(taskId: string, on: boolean): QueuePeek[] {
    const had = this.watches.get(taskId);
    if (!on) {
      this.stop(taskId);
      return had?.history ?? [];
    }
    if (had) return had.history;
    const task = this.taskOf(taskId);
    if (!task) throw new Error(`없는 태스크입니다: ${taskId}`);
    if (!this.supports(task)) throw new Error("이 사이트는 대기열을 볼 수 없습니다.");
    const w: Watch = { timer: setInterval(() => void this.tick(taskId), EVERY_MS), history: [], busy: false };
    this.watches.set(taskId, w);
    void this.tick(taskId);
    return w.history;
  }

  stop(taskId: string): void {
    const w = this.watches.get(taskId);
    if (!w) return;
    clearInterval(w.timer);
    this.watches.delete(taskId);
  }

  stopAll(): void {
    for (const id of [...this.watches.keys()]) this.stop(id);
  }

  private async tick(taskId: string): Promise<void> {
    const w = this.watches.get(taskId);
    if (!w || w.busy) return; // 앞의 것이 아직 안 끝났다 — 겹쳐 두드리지 않는다
    const task = this.taskOf(taskId);
    const peek = task ? ADAPTERS[task.site].peekQueue : undefined;
    if (!task || !peek) return this.stop(taskId);
    w.busy = true;
    let got: Omit<QueuePeek, "taskId" | "at">;
    try {
      got = await peek(task);
    } catch (e) {
      got = { waiting: false, count: 0, limit: 0, session: 0, pageEta: 0, opensAt: null, error: (e as Error).message };
    } finally {
      w.busy = false;
    }
    if (this.watches.get(taskId) !== w) return; // 그 사이에 껐다
    const p: QueuePeek = { taskId, at: Date.now(), ...got };
    w.history.push(p);
    if (w.history.length > KEEP) w.history.splice(0, w.history.length - KEEP);
    this.emit("peek", p);
  }
}
