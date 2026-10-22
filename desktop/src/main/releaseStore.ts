/**
 * 발매정보 저장. 태스크·모니터와 따로 둔다 — %APPDATA%/aio-task-manager/releases.json
 *
 *   releases     사람이 넣은 항목 (수동)
 *   opens        롯데 대기열 보기가 상품 API 에서 읽은 열리는 시각 — 태스크 id → ms. 대기열 보기는 창을 닫으면
 *                멈추고 열린 뒤에는 null 을 돌려줘서, 읽은 것을 여기 남겨 둔다 (열린 뒤에도 "지난 발매" 로 보이게)
 *   hiddenAuto   사람이 숨긴 자동 항목 id
 *
 * 자동 항목은 적지 않는다 — 목록을 줄 때마다 태스크에서 만든다 (태스크를 고치거나 지우면 따라 바뀐다).
 *   드랍 태스크  드랍 시각. 예약돼 있으면 매니저가 잡은 시각(dropAt), 아니면 planDrop 으로 다음 드랍 시각
 *   열리는 시각  위 opens. 날짜까지 있는 사이트의 값이라 드랍 시각보다 먼저 쓴다
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isHttpUrl, releaseProblem, tidyRelease } from "../shared/releases.js";
import { planDrop, SITES } from "../shared/sites.js";
import type { Release, ReleaseInput, ReleaseList, TaskDef, TaskRuntime } from "../shared/types.js";

interface Saved {
  releases: Release[];
  opens: Record<string, number>;
  hiddenAuto: string[];
}

const now = () => new Date().toISOString();
const autoId = (taskId: string) => `auto-${taskId}`;

/** 17:30:00 */
function clockOf(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

export class ReleaseStore {
  private data: Saved;

  constructor(private readonly dataDir: string) {
    this.data = this.load();
  }

  get path(): string {
    return join(this.dataDir, "releases.json");
  }

  private load(): Saved {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<Saved>;
      return {
        releases: Array.isArray(raw.releases)
          ? raw.releases.filter((r): r is Release => typeof r?.id === "string").map((r) => ({ ...r, source: "manual" as const }))
          : [],
        opens: raw.opens && typeof raw.opens === "object" ? raw.opens : {},
        hiddenAuto: Array.isArray(raw.hiddenAuto) ? raw.hiddenAuto.filter((id) => typeof id === "string") : [],
      };
    } catch {
      return { releases: [], opens: {}, hiddenAuto: [] };
    }
  }

  /** 옆에 쓰고 바꿔치기한다 (monitors.json 과 같다). */
  private flush(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...this.data }, null, 2), "utf-8");
    renameSync(tmp, this.path);
  }

  private clean(input: ReleaseInput): ReleaseInput {
    const clean = tidyRelease(input);
    const problem = releaseProblem(clean);
    if (problem) throw new Error(problem);
    return { ...clean, releaseAt: new Date(clean.releaseAt).toISOString() };
  }

  create(input: ReleaseInput): void {
    const at = now();
    this.data.releases.push({ ...this.clean(input), id: randomUUID().slice(0, 8), source: "manual", createdAt: at, updatedAt: at });
    this.flush();
  }

  update(id: string, input: ReleaseInput): void {
    const at = this.data.releases.findIndex((r) => r.id === id);
    if (at < 0) throw new Error(id.startsWith("auto-") ? "자동 항목은 고칠 수 없습니다 — 수동 항목으로 베껴서 고치세요." : `없는 항목입니다: ${id}`);
    const was = this.data.releases[at]!;
    this.data.releases[at] = { ...this.clean(input), id, source: "manual", createdAt: was.createdAt, updatedAt: now() };
    this.flush();
  }

  remove(id: string): void {
    this.data.releases = this.data.releases.filter((r) => r.id !== id);
    this.flush();
  }

  hideAuto(id: string): void {
    if (!this.data.hiddenAuto.includes(id)) this.data.hiddenAuto.push(id);
    this.flush();
  }

  showHidden(): void {
    this.data.hiddenAuto = [];
    this.flush();
  }

  /** 대기열 보기가 열리는 시각을 읽었다. → 바뀌었나. null(모름·이미 열림)은 지난 값을 지우지 않는다. */
  noteOpensAt(taskId: string, opensAt: number | null): boolean {
    if (opensAt === null || this.data.opens[taskId] === opensAt) return false;
    this.data.opens[taskId] = opensAt;
    this.flush();
    return true;
  }

  /** 태스크에서 만든 자동 항목. 숨긴 것도 포함. */
  private auto(tasks: TaskDef[], runtimes: TaskRuntime[]): Release[] {
    const out: Release[] = [];
    const at = now();
    for (const t of tasks) {
      const opensAt = this.data.opens[t.id];
      const rt = runtimes.find((r) => r.id === t.id);
      const drop = t.mode === "drop" && t.dropSettings.dropTime.trim()
        ? rt?.dropAt ?? planDrop(t.dropSettings, Date.now())?.dropAt ?? null
        : null;
      const when = opensAt ?? drop;
      if (when === null) continue;
      const origin = opensAt !== undefined
        ? "대기열 보기가 상품 API 에서 읽은 열리는 시각"
        : `드랍 태스크의 드랍 시각 ${clockOf(drop!)}${rt?.dropAt ? " (예약됨)" : " — 날짜 없이 매일 그 시각이라 다음 드랍으로 셉니다"}`;
      out.push({
        id: autoId(t.id),
        name: t.label || SITES[t.site].productCode(t.url) || "(이름 없음)",
        store: SITES[t.site].name,
        releaseAt: new Date(when).toISOString(),
        method: "fcfs",
        price: t.max_price ? `≤ ${t.max_price.toLocaleString("ko-KR")}원 (상한가)` : "",
        thumbnail: "",
        links: isHttpUrl(t.url) ? [{ label: "상품 페이지", url: t.url.trim() }] : [],
        memo: "",
        source: "auto",
        taskId: t.id,
        origin,
        createdAt: at,
        updatedAt: at,
      });
    }
    return out;
  }

  list(tasks: TaskDef[], runtimes: TaskRuntime[]): ReleaseList {
    const auto = this.auto(tasks, runtimes);
    const shown = auto.filter((r) => !this.data.hiddenAuto.includes(r.id));
    return { items: [...this.data.releases, ...shown], hiddenAuto: auto.length - shown.length, path: this.path };
  }
}
