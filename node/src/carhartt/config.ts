/**
 * 칼하트윕 판의 집과 파일들.
 *
 *   carhartt-session.json    로그인 토큰 (비밀 — 올리지 않는다). CARHARTT_SESSION_FILE 로 자리를 바꿀 수 있다
 *   carhartt-stock.log       전부 적는 곳
 *   carhartt-chrome-profile  로그인 창·주문서·결제창이 쓰는 크롬 프로필
 *   carhartt_config.json     결제 비밀번호 하나 (콘솔용 — --pin). 태스크는 환경변수로 넘긴다
 *
 * 무엇을 볼지·살지는 명령줄로 받는다. 집은 CARHARTT_HOME (없으면 프로젝트 뿌리 aio/).
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// dist/carhartt 에서 돌든 src/carhartt 에서 돌든 프로젝트 뿌리(aio/)는 세 칸 위다. 다른 판의 로그와 같은 자리에 둔다.
export const BASE = (process.env["CARHARTT_HOME"] || "").trim()
  ? resolve(process.env["CARHARTT_HOME"]!.trim())
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const LOG_PATH = join(BASE, "carhartt-stock.log");
/** 로그인 토큰. 데스크톱이 프로필마다 따로 두려면 CARHARTT_SESSION_FILE 로 알려 준다 (KREAM_COOKIE_FILE 과 같은 구실). */
export const SESSION_PATH = (process.env["CARHARTT_SESSION_FILE"] || "").trim() || join(BASE, "carhartt-session.json");
export const CHROME_PROFILE = join(BASE, "carhartt-chrome-profile");

export const SITE = "https://www.carhartt-wip.co.kr";
export const LOGIN_URL = `${SITE}/auth/login`;
export const ORDER_URL = `${SITE}/order`;

/**
 * 설정 파일 — 지금은 **결제 비밀번호 하나뿐**이다. 원본은 대상·간격을 명령줄로 받으므로 다른 칸이 없다.
 * 콘솔에서 `--pin` 으로 넣은 값이 여기 적히고, 데스크톱은 태스크를 띄울 때 `CARHARTT_PG_PASSWORD` 로 넘긴다
 * (환경변수가 파일보다 먼저다 — KREAM 판과 같은 규칙).
 */
export const CONFIG_PATH = join(BASE, "carhartt_config.json");

const digitsOf = (text: unknown): string => String(text ?? "").replace(/\D/g, "");

/** 결제 비밀번호 — 환경변수 → 설정 파일. 없으면 "". */
export function pgPasswordOf(): string {
  // **환경변수가 있으면 빈 값이어도 그것이 답이다** — 태스크가 프로필 비밀번호 없이 띄워질 때
  // 콘솔용(설정 파일) 비밀번호가 새어 들어가면 안 된다 (adapter.ts 의 launch 설명과 같은 규칙).
  const fromEnv = process.env["CARHARTT_PG_PASSWORD"];
  if (fromEnv !== undefined) return digitsOf(fromEnv);
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    return digitsOf(raw["pg_password"]);
  } catch {
    return "";
  }
}

/** `--pin <6자리>` — 설정 파일의 그 칸만 고쳐 쓴다 (다른 칸이 생기면 남긴다). */
export function savePgPassword(digits: string): void {
  let current: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) current = raw as Record<string, unknown>;
  } catch {
    /* 없으면 새로 만든다 */
  }
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...current, pg_password: digits }, null, 2)}\n`, "utf-8");
  renameSync(tmp, CONFIG_PATH);
}

/** `--pin clear` — 그 칸을 지운다 (파일이 비면 파일도 지운다). */
export function clearPgPassword(): boolean {
  if (!existsSync(CONFIG_PATH)) return false;
  let current: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) current = raw as Record<string, unknown>;
  } catch {
    /* 깨진 파일이면 통째로 지운다 */
  }
  delete current["pg_password"];
  if (Object.keys(current).length === 0) {
    rmSync(CONFIG_PATH, { force: true });
  } else {
    const tmp = `${CONFIG_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
    renameSync(tmp, CONFIG_PATH);
  }
  return true;
}

/**
 * 자동 로그인에 쓸 이메일·비밀번호. **환경변수로만** 받는다 — 파일에는 적지 않는다 (KREAM 판과 같은 규칙).
 * 없으면 null — 그때 --login 은 크롬 창을 띄워 사람이 로그인하게 한다.
 */
export function credentialsOf(): { email: string; password: string } | null {
  const email = (process.env["CARHARTT_LOGIN_EMAIL"] ?? "").trim();
  const password = process.env["CARHARTT_LOGIN_PASSWORD"] ?? "";
  return email && password ? { email, password } : null;
}

/** 사지 않고 어디서 눌렀을지만 본다. 프로세스 하나에 하나뿐인 상태라 여기 둔다. */
export const run = { dryRun: false };
