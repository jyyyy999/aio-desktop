/**
 * 통합 러너의 태스크 표. Cybersole 의 태스크 그리드처럼, 지금 어떤 태스크가
 * 무슨 상태인지 한눈에 보여 준다.
 *
 * 표는 매 초 다시 그려진다(공용 UI 의 setTaskTable). 상태는 **상태 파일에서** 읽는다 —
 * 사이트 루프가 저마다 제 상태 파일에 적는 것을 그대로 보여 주면, 루프가 죽었는지
 * 살았는지까지 그대로 드러난다.
 */
import { readFileSync } from "node:fs";
import { cell, UI } from "../ui.js";
import { STATE_PATH as BNKR_STATE_PATH } from "../bnkr-test/config.js";
import { STATE_PATH as LOTTE_STATE_PATH } from "../lotte-test/config.js";
import { taskKey, type Task, type TaskConfig } from "./config.js";

interface Entry {
  name?: string;
  status?: string;
  stock?: number;
  done?: boolean;
  carted_at?: string;
  landed?: boolean;
  blocked?: string;
  opened?: boolean;
  stage?: string;
}

function readEntries(path: string): Record<string, Entry> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { targets?: Record<string, Entry> };
    return raw.targets ?? {};
  } catch {
    return {};
  }
}

/** 상태 파일의 한 항목 → 표에 적을 한 줄. 사이트마다 적는 말이 조금 다르다. */
function noteOf(site: Task["site"], entry: Entry | undefined): string {
  if (!entry) return "";
  if (entry.done) return "완료";
  if (site === "bnkr") {
    if (entry.carted_at) {
      const at = entry.carted_at.split("T")[1]?.slice(0, 5) ?? entry.carted_at;
      return entry.landed ? `담김 ${at}` : `담김 ${at} (주문서 실패)`;
    }
    if (entry.blocked) return `막힘: ${entry.blocked.split("(")[0]!.trim()}`;
    if (entry.status) return entry.status === "instock" ? `구매 가능 ${entry.stock ?? ""}`.trim() : "품절";
  } else {
    if (entry.opened) return `주문서 ${entry.stage ?? ""}`.trim();
    if (entry.blocked) return `막힘: ${entry.blocked.split("(")[0]!.trim()}`;
    if (entry.status) return entry.status === "instock" ? "구매 가능" : "품절";
  }
  return "";
}

/**
 * 표를 그린다. 매 초 불리는 함수라 파일을 다시 읽는다 — 파일 두 개를 읽는 것은
 * 1초에 한 번이면 아무것도 아니다.
 */
function buildRows(cfg: TaskConfig): string[] {
  const bnkr = readEntries(BNKR_STATE_PATH);
  const lotte = readEntries(LOTTE_STATE_PATH);
  const sites = { bnkr, lotte } as const;

  const row = (cols: string[]) => cols.join("  ");
  const head = row([
    cell("#", 3), cell("SITE", 5), cell("PRODUCT", 26),
    cell("MODE", 6), cell("QTY", 4), cell("RUN", 4), "NOTE",
  ]);

  const rows = cfg.tasks.map((task, at) => {
    const key = taskKey(task);
    const entry = sites[task.site][key];
    return row([
      cell(String(at + 1).padStart(2, "0"), 3),
      cell(task.site.toUpperCase(), 5),
      cell(task.label || entry?.name || key, 26),
      cell(task.site === "bnkr" ? task.mode : task.option || "—", 6),
      cell(`x${task.ea}`, 4),
      cell(task.paused ? "OFF" : "ON", 4),
      noteOf(task.site, entry),
    ]);
  });

  const active = cfg.tasks.filter((t) => !t.paused).length;
  const header = `TASKS — ${cfg.tasks.length}개 (${active} 진행 · ${cfg.tasks.length - active} OFF) · ` +
    `BNKR ${cfg.tasks.filter((t) => t.site === "bnkr").length} · ` +
    `LOTTE ${cfg.tasks.filter((t) => t.site === "lotte").length}`;

  return [header, head, "-".repeat(68), ...rows];
}

/** 표를 켠다. 이 함수를 부르는 순간부터 화면은 표가 주인이 된다. */
export function startDashboard(cfg: TaskConfig): void {
  UI.setTaskTable(() => buildRows(cfg));
}

/** 표를 끄고 평범한 줄 모드로 돌아간다. */
export function stopDashboard(): void {
  UI.setTaskTable(null);
}
