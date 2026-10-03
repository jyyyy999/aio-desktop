/** 담을 상품. 설정에 적힌 것을 알아보고, 다시 적어 넣을 형태로 돌려준다. */
import type { Config, Mode } from "./config.js";
import { log } from "./log.js";
import { LANDING, parseGno } from "./site.js";

export interface Target {
  gno: string;
  ea: number;
  mode: Mode;
  max_price: number;
  label: string | null;
  /** 태스크를 꺼 둔 상태. 감시 목록에서는 빠지되 설정에는 그대로 남는다. */
  paused: boolean;
}

export function parseTarget(entry: unknown): Target | null {
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    const gno = parseGno(e["gno"] ?? e["url"] ?? "");
    if (!gno) return null;
    const mode = String(e["mode"] ?? "ADD").toUpperCase();
    return {
      gno,
      ea: Math.max(1, Number(e["ea"] ?? 1)),
      mode: (mode in LANDING ? mode : "ADD") as Mode,
      max_price: Number(e["max_price"] ?? 0),
      label: String(e["label"] ?? "").trim() || null,
      paused: Boolean(e["paused"]),
    };
  }
  const gno = parseGno(entry);
  return gno ? { gno, ea: 1, mode: "ADD", max_price: 0, label: null, paused: false } : null;
}

export function targetsOf(cfg: Config): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const entry of cfg.targets ?? []) {
    const target = parseTarget(entry);
    if (!target) {
      log.warn(`담을 상품을 알아볼 수 없어 건너뜁니다: ${JSON.stringify(entry)}`);
      continue;
    }
    if (seen.has(target.gno)) continue;
    seen.add(target.gno);
    out.push(target);
  }
  return out;
}

/** 설정 파일에 다시 적어 넣을 형태. 기본값뿐이면 gno 한 줄로 줄인다. */
export function targetEntry(target: Target): string | Record<string, unknown> {
  if (target.ea === 1 && target.mode === "ADD" && !target.max_price && !target.label && !target.paused) {
    return target.gno;
  }
  const entry: Record<string, unknown> = { gno: target.gno };
  for (const key of ["ea", "mode", "max_price", "label"] as const) {
    if (target[key]) entry[key] = target[key];
  }
  if (target.paused) entry["paused"] = true;
  return entry;
}

/** 감시할 것만. 꺼 둔 태스크는 이 목록엔 안 든다. */
export function activeTargets(cfg: Config): Target[] {
  return targetsOf(cfg).filter((t) => !t.paused);
}
