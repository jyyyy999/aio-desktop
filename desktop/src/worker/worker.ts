/**
 * 태스크 하나 = 이 워커 하나. main 이 child_process.fork 로 띄운다.
 *
 * **사이트를 모른다.** main 이 넣어 준 것만 보고 원본을 들인다.
 *
 *   process.argv       원본의 명령줄 인자 (fork 할 때 붙인다)
 *   AIO_LEGACY_ENTRY   원본 진입점. **들이는 순간 main() 이 돈다** (롯데 dist/…/index.js, 네이버 src/cli.ts)
 *   AIO_TSX_FROM       TS 소스를 그대로 들여야 하면, tsx 를 찾을 원본 프로젝트 폴더
 *   AIO_REDIRECTS      원본이 제 폴더에 박아 둔 파일 → 태스크 홈·프로필 폴더. [[from, to], …]
 *   AIO_TTY            "1" 이면 표준출력을 화면처럼 보이게 한다 (원본의 제자리 상태 줄을 받으려고)
 *   그 밖              원본이 읽는 환경변수 (LOTTEON_HOME · 쿠키 · 비밀번호 …)
 *
 * 그래서 원본을 한 줄도 고치지 않고 태스크마다 다른 상품·다른 상태 파일·다른 계정으로 돌릴 수 있다.
 *
 * 여기서 하는 일
 *   1. 원본을 들이기 **전에** process.exit 를 가로챈다
 *   2. 원본이 박아 둔 파일 경로로 가는 읽기·쓰기를 태스크 홈·프로필 폴더로 돌린다
 *   3. (TS 원본이면) tsx 를 걸고, 원본을 들인다
 *   4. main 이 STOP 을 보내면 Ctrl+C 를 누른 것처럼 원본의 SIGINT 처리기를 태운다
 */
import { existsSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MainMessage, WorkerMessage } from "../shared/types.js";

const originalExit = process.exit.bind(process) as (code?: number) => never;

function send(msg: WorkerMessage, done?: () => void): void {
  if (process.send && process.connected) {
    process.send(msg, undefined, {}, () => done?.());
  } else {
    done?.();
  }
}

/** 가로챈 exit. 이걸 던져서 원본의 나머지 줄이 돌지 않게 한다. */
class InterceptedExit extends Error {
  constructor(readonly code: number) {
    super(`INTERCEPTED_EXIT_${code}`);
    this.name = "InterceptedExit";
  }
}

let finishing = false;

/**
 * exit 를 청한 뒤로는 원본의 말을 막는다.
 *
 * 진짜 exit 였다면 그 뒤의 줄은 돌지 않는다. 가로챈 exit 는 던지는 것으로 흉내 내는데,
 * 롯데 원본은 `main().then(() => process.exit(0)).catch((e) => { log.error(e.message); … })`
 * 모양이라 우리가 던진 것을 제 catch 가 받아 "✖ INTERCEPTED_EXIT_0" 을 화면과 로그 파일에
 * 적는다 — 성공한 판이 실패처럼 보인다. 그래서 끝내는 동안 표준출력과 원본의 로그 파일
 * 쓰기(appendFileSync)를 먹는다. 산 기록은 exit **앞에서** 저장되므로 잃는 것이 없다.
 */
function gag(): void {
  const mute = (() => true) as typeof process.stdout.write;
  process.stdout.write = mute;
  process.stderr.write = mute;
  // 원본은 `import { appendFileSync } from "node:fs"` 로 들인다. 내장 모듈을 고친 뒤
  // syncBuiltinESMExports 를 불러야 ESM 쪽 이름에도 반영된다.
  const fs = require("node:fs") as typeof import("node:fs");
  fs.appendFileSync = () => undefined;
  syncBuiltinESMExports();
}

/**
 * 진짜로 끝낸다. main 에 알린 **뒤에**.
 *
 * 워커를 살려 두지 않는 이유: 원본은 끝날 때 exit 로 브라우저 연결을 끊는 것에 기대고
 * 있다 (롯데: "그냥 끝내면 크롬드라이버가 붙들고 있어 안 꺼진다"). 여기서 안 끝내면 워커가
 * 좀비로 남는다. 롯데 크롬 창은 detach 라 남고, 네이버(Playwright) 창은 원본이 사람이
 * 닫을 때까지 기다린 뒤에야 exit 를 부른다.
 */
function finish(code: number): void {
  if (finishing) return;
  finishing = true;
  gag();
  // IPC 가 비워진 뒤에 끝낸다. 콜백이 안 오는 경우를 대비해 늦어도 2초 뒤에는 끝낸다.
  const hard = setTimeout(() => originalExit(code), 2000);
  send({ type: "WORKER_EXIT_REQUEST", code }, () => {
    clearTimeout(hard);
    originalExit(code);
  });
}

process.exit = ((code?: string | number | null) => {
  const exitCode = typeof code === "number" ? code : Number(code ?? 0) || 0;
  finish(exitCode);
  throw new InterceptedExit(exitCode);
}) as typeof process.exit;

function fatal(err: unknown): void {
  if (err instanceof InterceptedExit) return; // 우리가 던진 것. 이미 끝내는 중이다.
  const e = err instanceof Error ? err : new Error(String(err));
  process.stderr.write(`[worker] ${e.stack ?? e.message}\n`);
  send({ type: "FATAL", message: e.message, stack: e.stack });
  finish(1);
}

// 원본의 `.then(() => process.exit(0))` 안에서 던진 InterceptedExit 는 거부된 프라미스로
// 여기 떨어진다. 그건 조용히 삼키고, 그 밖의 것만 FATAL 로 올린다.
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

/**
 * 원본이 제 폴더에 박아 둔 파일로 가는 읽기·쓰기를 다른 파일로 돌린다.
 *
 * 네이버 원본은 로그·결제창 받아쓰기·로그인 세션 경로를 바꿀 길을 안 열어 두었다. 그대로 두면
 *   로그·받아쓰기  태스크끼리 한 파일에 섞여 쓰고, 받아쓰기는 나중 태스크가 앞의 것을 덮는다 → 태스크 홈으로
 *   로그인 세션    모든 태스크가 한 계정으로 돈다 → 태스크가 고른 프로필의 세션 파일로
 * 원본이 그 파일에 쓰는 함수만 감싸고, 표에 있는 경로가 아니면 손대지 않는다.
 *
 * 세션 파일은 원본(existsSync · readFileSync)과 Playwright(fs.promises — newContext 의 storageState 로
 * 읽고, --login 의 storageState({path}) 로 쓴다)가 같이 만진다. 둘 다 부를 때마다 fs 에서 함수를
 * 꺼내므로 여기서 바꿔 끼우면 둘 다 돌려진다.
 */
function installRedirects(): void {
  const pairs = JSON.parse(process.env["AIO_REDIRECTS"] || "[]") as [string, string][];
  if (!pairs.length) return;
  const key = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const table = new Map(pairs.map(([from, to]) => [key(from), to]));
  const swap = <T>(file: T): T => (typeof file === "string" ? ((table.get(key(file)) ?? file) as T) : file);

  // 첫 인자(파일)만 바꿔 넘기고 나머지는 그대로. fs 함수마다 겹친 타입을 하나하나 맞추지 않는다.
  const around = <F extends (...args: never[]) => unknown>(fn: F): F =>
    ((file: unknown, ...rest: unknown[]) => (fn as unknown as (...a: unknown[]) => unknown)(swap(file), ...rest)) as unknown as F;

  const fs = require("node:fs") as typeof import("node:fs");
  fs.appendFileSync = around(fs.appendFileSync);
  fs.writeFileSync = around(fs.writeFileSync);
  fs.existsSync = around(fs.existsSync);
  fs.readFileSync = around(fs.readFileSync);
  fs.promises.readFile = around(fs.promises.readFile);
  fs.promises.writeFile = around(fs.promises.writeFile);
  syncBuiltinESMExports();
}

/**
 * TS 소스를 그대로 들일 수 있게 tsx 를 건다. **원본 프로젝트의 tsx** 를 쓴다 — 원본이 제
 * 명령(npm start = tsx src/cli.ts)으로 돌 때와 같은 판이어야 같은 결과가 나온다.
 */
function registerTsx(from: string): void {
  const req = createRequire(join(from, "package.json"));
  const { register } = req("tsx/esm/api") as { register(options: { tsconfig?: string }): unknown };
  const tsconfig = join(from, "tsconfig.json");
  register(existsSync(tsconfig) ? { tsconfig } : {});
}

/**
 * 표준출력을 화면(TTY)처럼 보이게 한다 (AIO_TTY). 원본 중에는 기다리는 동안의 줄("품절 · 다음 확인 3초")을
 * 화면일 때만 제자리에서(\r) 고쳐 쓰는 것이 있다 (롯데 ui.ts). main 이 그 줄을 받아 모니터링 창에 보인다 —
 * 로그에는 안 쌓는다. 색은 NO_COLOR 로 꺼 둔 채라 이스케이프 코드는 섞이지 않는다.
 */
function fakeTty(): void {
  if (process.env["AIO_TTY"] !== "1") return;
  (process.stdout as { isTTY?: boolean }).isTTY = true;
}

/** Ctrl+C 를 누른 것처럼 원본의 SIGINT 처리기를 태운다. → 처리기가 있었나 */
function interrupt(): boolean {
  if (process.listenerCount("SIGINT") === 0) return false;
  try {
    process.emit("SIGINT", "SIGINT");
  } catch (e) {
    // 처리기 안에서 부른 exit 가 위의 가로채기로 왔다 (롯데: 산 기록을 적고 exit(0)).
    if (!(e instanceof InterceptedExit)) fatal(e);
  }
  return true;
}

// 윈도우에서는 자식에게 시그널을 보낼 길이 없다. main 이 IPC 로 보낸 STOP 을 Ctrl+C 로 옮긴다.
process.on("message", (raw: MainMessage) => {
  if (raw?.type !== "STOP" || finishing) return;
  if (!raw.force) {
    // 처리기가 제자리에서 exit 하면(롯데) 이미 끝내는 중이다. 할 일을 걸어 두고 돌아오면
    // (네이버: 감시를 끊고, 열린 구매 창이 닫히기를 기다린다) 원본이 스스로 끝낼 때까지 둔다.
    // 처리기가 없으면(아직 못 들였거나 원본이 안 걸었으면) 우리가 끝낸다.
    if (!interrupt()) finish(0);
    return;
  }
  // 두 번째 Ctrl+C. 원본은 이걸 "창째로 끝내라" 로 받는다. 그래도 안 끝나면 우리가 끝낸다.
  interrupt();
  setTimeout(() => finish(130), 1500);
});

// main 이 먼저 죽으면(앱을 강제로 닫으면) 따라 끝낸다. 고아로 남아 사이트만 두드리지 않게.
process.on("disconnect", () => {
  try {
    if (process.listenerCount("SIGINT") > 0) process.emit("SIGINT", "SIGINT");
  } catch {
    // 끝내는 중이다.
  }
  finishing = true;
  originalExit(0);
});

async function main(): Promise<void> {
  const entry = process.env["AIO_LEGACY_ENTRY"];
  if (!entry) throw new Error("AIO_LEGACY_ENTRY 가 비었습니다 (main 이 넣어 줘야 합니다).");
  installRedirects();
  fakeTty();
  const tsxFrom = process.env["AIO_TSX_FROM"];
  if (tsxFrom) registerTsx(tsxFrom);
  send({ type: "READY" });
  await import(pathToFileURL(entry).href);
}

main().catch(fatal);
