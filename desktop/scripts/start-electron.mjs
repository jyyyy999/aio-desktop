/**
 * npm start 의 마지막 단계 — Electron 을 띄운다. (2026-10-17)
 *
 * **윈도우에서 electron.exe 가 한글 경로 아래 있으면 시작하자마자 죽는다.** 이 PC 는 사용자 폴더가
 * C:\Users\제영 이라 node_modules\electron\dist\electron.exe 가 그 아래 있다. 2026-10-17 에 재 봤다:
 *   - 그 자리에서 띄우면 아무 말 없이 죽는다 (0x80000003 · 이벤트 로그 c0000005). `--version` 도 죽는다.
 *   - 같은 파일(해시까지 같다)을 C:\ 아래 영문 경로에 복사해 띄우면 뜬다.
 *   - 앱 폴더(desktop/)가 한글 경로인 것은 괜찮다 — 실행 파일 자리만 문제다.
 *
 * 그래서 dist 경로에 ASCII 가 아닌 글자가 있으면 dist 를 통째로 영문 자리(기본 C:\aio-electron\<버전>)에
 * 한 번 복사해 두고, Electron 이 원래 받는 ELECTRON_OVERRIDE_DIST_PATH 로 그 자리를 가리킨 뒤 Electron 의
 * cli.js 를 그대로 부른다 — 신호 넘기기·종료 코드는 원래 실행기 그대로다. 앱의 워커는 fork 라 같은
 * 실행 파일(process.execPath)로 뜬다.
 *
 * 버전이 바뀌면(npm install 로 올리면) 새 버전 폴더에 다시 복사한다. 복사가 다 끝났다는 표시(.aio-copy)가
 * 없거나 electron.exe 크기가 다르면 다시 복사한다. 자리는 AIO_ELECTRON_DIR 로 바꿀 수 있다.
 * 맥·리눅스와 영문 경로의 윈도우에서는 아무것도 안 하고 원래대로 띄운다.
 */
import { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("electron/package.json"));
const nonAscii = (p) => /[^\x00-\x7f]/.test(p);

function asciiDist() {
  const dist = join(pkgDir, "dist");
  if (process.platform !== "win32" || !nonAscii(dist) || process.env.ELECTRON_OVERRIDE_DIST_PATH) return null;

  const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")).version;
  const exe = readFileSync(join(pkgDir, "path.txt"), "utf-8").trim();
  const root = process.env.AIO_ELECTRON_DIR || join(`${process.env.SystemDrive || "C:"}\\`, "aio-electron");
  const target = join(root, version);
  if (nonAscii(target)) {
    console.warn(`[start] ${target} 도 영문 경로가 아닙니다 — 원래 자리에서 띄웁니다 (AIO_ELECTRON_DIR 를 영문 경로로)`);
    return null;
  }

  const mark = join(target, ".aio-copy");
  const size = statSync(join(dist, exe)).size;
  const done = existsSync(mark) && existsSync(join(target, exe)) && statSync(join(target, exe)).size === size;
  if (!done) {
    console.log(`[start] Electron ${version} 을 영문 경로에 복사합니다 (처음 한 번) — ${target}`);
    rmSync(target, { recursive: true, force: true });
    cpSync(dist, target, { recursive: true });
    writeFileSync(mark, `${version}\n`);
  }
  return target;
}

const dist = asciiDist();
if (dist) process.env.ELECTRON_OVERRIDE_DIST_PATH = dist;
// cli.js 는 process.argv.slice(2) 를 electron 에 넘긴다. 아무것도 없으면 이 앱(desktop/)을 띄운다.
if (process.argv.length <= 2) process.argv.push(".");
require(join(pkgDir, "cli.js"));
