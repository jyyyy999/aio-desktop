/**
 * 원본 하나를 워커로 띄우는 일. 태스크(taskManager)와 계정 명령(sessions — 로그인·세션 확인)이
 * 같이 쓴다. 무엇을 띄울지는 어댑터가 정한 Launch 가 다 갖고 있다.
 */
import { fork, type ChildProcess } from "node:child_process";
import type { Launch } from "./sites/index.js";

export function forkLegacy(workerPath: string, launch: Launch, cwd: string): ChildProcess {
  const child = fork(workerPath, launch.args, {
    cwd,
    // 표준입력은 원본에 흘려 넣을 것이 있을 때만 연다 (롯데 --cookie -). 아니면 닫아 둔다.
    stdio: [launch.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      // Electron 바이너리를 노드로 돌린다. 이게 없으면 창이 하나 더 뜬다.
      ELECTRON_RUN_AS_NODE: "1",
      NO_COLOR: "1",
      AIO_LEGACY_ENTRY: launch.entry,
      AIO_TSX_FROM: launch.tsxFrom ?? "",
      AIO_REDIRECTS: JSON.stringify(launch.redirects),
      ...launch.env,
    },
  });
  if (launch.stdin !== undefined) child.stdin?.end(launch.stdin);
  return child;
}

/**
 * 표준출력 조각을 줄로 자른다. 줄 끝이 안 온 꼬리는 다음 조각을 기다린다.
 *
 * 터미널이 보여 주는 대로 읽는다 — \r 은 그 줄을 처음부터 고쳐 쓰는 것이다. 그래서
 *   끝난 줄(\n)       그 안의 마지막 \r 뒤가 그 줄이다 (앞의 것은 지워진 상태 줄)
 *   안 끝난 꼬리의 \r 제자리에서 고쳐 쓰는 줄이다 → onStatus (빈 글이면 지운 것)
 * 롯데 원본이 기다리는 동안 "품절 · 다음 확인 3초" 를 이렇게 찍는다 (ui.ts 의 status·clear).
 */
export function eachLine(
  source: NodeJS.ReadableStream | null, onLine: (text: string) => void, onStatus?: (text: string) => void,
): void {
  if (!source) return;
  let tail = "";
  const shown = (line: string) => line.slice(line.lastIndexOf("\r") + 1);
  source.setEncoding("utf-8");
  source.on("data", (chunk: string) => {
    const parts = (tail + chunk).replace(/\r\n/g, "\n").split("\n");
    tail = parts.pop() ?? "";
    for (const part of parts) {
      const text = shown(part);
      if (text.trim()) onLine(text);
    }
    if (tail.includes("\r")) {
      // 이 조각에서 새로 고쳐 쓴 것마다 알린다 — 같은 글을 다시 쓴 것도 뜻이 있다 (새로 기다리기 시작했다).
      const fresh = chunk.replace(/\r\n/g, "\n");
      const writes = fresh.slice(fresh.lastIndexOf("\n") + 1).split("\r").slice(1);
      if (onStatus) for (const one of writes) onStatus(one.trim());
      // 꼬리에는 마지막으로 고쳐 쓴 것만 남긴다. 하루 종일 기다리는 줄이 꼬리에 쌓이지 않게.
      tail = tail.slice(tail.lastIndexOf("\r"));
    }
  });
  source.on("end", () => {
    // 끝까지 줄 끝이 안 온 꼬리. 제자리 상태 줄이었으면 로그로 남기지 않는다.
    if (!tail.includes("\r") && tail.trim()) onLine(tail);
    tail = "";
  });
}
