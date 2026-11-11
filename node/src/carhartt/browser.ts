/**
 * 칼하트윕 용 크롬 창. 감시·담기·주문 생성은 전부 API 로 한다 (창이 없다).
 *
 *   humanLogin   로그인 화면을 띄워 사람이 로그인하면 토큰을 읽어 온다 (자동 로그인 정보가 없을 때의 --login)
 *   WarmChrome   구매 태스크가 **켜질 때** 크롬을 미리 띄워 상품 페이지에 세워 둔다 — 주문이 잡히면 그 탭을 쓴다
 *   openOrder    로그인 토큰을 심고 주문서(/order)를 연다 — 결제는 사람이 그 창에서 한다
 *   submitOrder  주문서에서 결제하기를 누르고, 토스 브랜드페이 비밀번호 자판이면 6자리를 대신 누른다 (--action submit)
 *
 * 미리 띄우는 까닭: 주문을 만든 **뒤에** 크롬을 띄우면 크롬이 뜨고(1~3초) 사이트 번들이 올라오는(새 프로필이면
 * 20초 넘게) 동안 주문서가 빈 화면이다. 켤 때 띄워 두면 그 시간이 감시하는 동안에 지나간다.
 *
 * 세워 둔 탭에는 **로그인 토큰을 두지 않는다.** 사이트 화면이 토큰을 쥐고 있으면 스스로 갱신하다가 우리가 쥔 갱신
 * 토큰을 죽일 수 있다 (humanLogin 이 끝나면 창을 닫는 까닭과 같다). 토큰은 주문서를 여는 순간에 심는다.
 *
 * **크롬드라이버(셀레니움)를 쓰지 않는다.** 크롬을 `--remote-debugging-port` 로 직접 띄우고 개발자 도구 규약(CDP)으로
 * 말한다. 크롬드라이버는 크롬과 버전이 맞아야 하는데, 크롬이 스스로 올라간 뒤 셀레니움 매니저가 새 드라이버를 못 받으면
 * 창이 아예 안 뜬다 — 2026-11-11 에 이 PC 가 그 상태였다 (크롬 157 · 받아 둔 드라이버 155 · 매니저는 "액세스가
 * 거부되었습니다"). 발매 날 아침에 그러면 끝이라, 여기는 맞출 버전이 없는 길로 간다. 할 일도 주소 열기와
 * localStorage 읽고 쓰기, 단추·자판 누르기뿐이다.
 *
 * 사이트는 로그인을 localStorage 에 둔다 (번들에서 읽은 열쇠 — token · refreshToken · device_id). 쿠키가 아니라서
 * 같은 출처의 아무 페이지나 연 뒤 그 셋을 적으면 로그인된 창이 된다.
 *
 * 프로필은 집에 고정한다 (carhartt-chrome-profile). 봇 탐지를 속이는 짓은 하지 않는다.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import { sleep } from "../util.js";
import { killChromeUsingProfile } from "../supreme/browser.js";
import { CHROME_PROFILE, LOGIN_URL, ORDER_URL, SITE } from "./config.js";
import { LINES } from "./lines.js";
import { sessionFromTokens, type Session } from "./session.js";

export class BrowserError extends Error {}

const WINDOW = { x: 120, y: 40, width: 1180, height: 900 };
/** 사이트 번들의 저장소 열쇠 (ACCESS_TOKEN · REFRESH_TOKEN · DEVICE_ID). */
const KEYS = { access: "token", refresh: "refreshToken", device: "device_id" } as const;
/** 크롬이 디버깅 포트를 적어 두는 파일 (첫 줄이 포트). */
const PORT_FILE = join(CHROME_PROFILE, "DevToolsActivePort");

/** 설치된 크롬. CHROME_PATH 가 먼저다. */
function chromePath(): string {
  const env = process.env;
  const candidates = [
    env["CHROME_PATH"],
    env["PROGRAMFILES"] && join(env["PROGRAMFILES"], "Google", "Chrome", "Application", "chrome.exe"),
    env["PROGRAMFILES(X86)"] && join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    env["LOCALAPPDATA"] && join(env["LOCALAPPDATA"], "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  const found = candidates.find((path): path is string => !!path && existsSync(path));
  if (!found) throw new BrowserError("크롬을 찾지 못했습니다 — CHROME_PATH 에 chrome.exe 위치를 적어 주세요.");
  return found;
}

/** 크롬 탭 하나와의 CDP 연결. */
class Tab {
  private next = 1;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  closed = false;
  /** 창이 닫혔을 때 (사람이 닫았거나 크롬이 죽었다). detach 로 끊은 것은 부르지 않는다. */
  onClose: (() => void) | null = null;

  private constructor(private readonly socket: WebSocket, readonly port: number, readonly targetId: string) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      const pending = message.id !== undefined ? this.waiting.get(message.id) : undefined;
      if (!pending) return;
      this.waiting.delete(message.id!);
      if (message.error) pending.reject(new BrowserError(message.error.message || "크롬이 명령을 거절했습니다"));
      else pending.resolve(message.result);
    });
    // 사람이 창을 닫으면 여기로 온다.
    socket.addEventListener("close", () => {
      if (!this.closed) this.onClose?.();
      this.closed = true;
      for (const pending of this.waiting.values()) pending.reject(new BrowserError("크롬 창이 닫혔습니다"));
      this.waiting.clear();
    });
  }

  static connect(url: string, port: number): Promise<Tab> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      // ws://127.0.0.1:<포트>/devtools/page/<탭 id> — 끝 마디가 탭 id 다 (닫을 때 쓴다).
      socket.addEventListener("open", () => resolve(new Tab(socket, port, url.split("/").pop() ?? "")), { once: true });
      socket.addEventListener("error", () => reject(new BrowserError("크롬에 연결하지 못했습니다")), { once: true });
    });
  }

  send(method: string, params: object = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new BrowserError("크롬 창이 닫혔습니다"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 페이지에서 식 하나를 셈해 값을 받는다. */
  async evaluate<T>(expression: string): Promise<T> {
    const out = (await this.send("Runtime.evaluate", { expression, returnByValue: true })) as {
      result?: { value?: T }; exceptionDetails?: { text?: string };
    };
    if (out.exceptionDetails) throw new BrowserError(out.exceptionDetails.text || "페이지에서 식을 셈하지 못했습니다");
    return out.result?.value as T;
  }

  /**
   * 진짜 마우스로 한 번 누른다. 사이트 단추가 `element.click()` 을 무시하는 경우가 있어서(KREAM),
   * 좌표를 재서 입력 규약으로 보낸다. 좌표는 이 탭의 뷰포트 기준이다.
   */
  async clickAt(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** 이 탭을 닫는다 (마지막 탭이면 크롬도 끝난다). CDP 의 Page.close 는 이 판에서 안 먹혀서(2026-11-12) 디버깅 포트의 /json/close 로 한다. */
  async closeTab(): Promise<void> {
    if (this.targetId) {
      await fetch(`http://127.0.0.1:${this.port}/json/close/${this.targetId}`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    }
    this.detach();
  }

  /** 연결만 끊는다 — 크롬 창은 남는다. */
  detach(): void {
    this.closed = true;
    this.socket.close();
  }
}

/**
 * 이 프로필을 크롬이 쥐고 있나. 크롬은 떠 있는 동안 프로필에 잠금 파일을 둔다 (윈도우 lockfile — 지우려 하면 거절된다,
 * 맥·리눅스 SingletonLock). 안 쥐고 있으면 PowerShell 로 프로세스를 뒤지지 않는다 — 그 정리는 1~2초 동안
 * 이 프로세스를 통째로 멈춰 세운다 (spawnSync). 태스크를 켜자마자 사는 판에서 그만큼 늦어진다.
 */
function profileInUse(): boolean {
  if (process.platform === "win32") {
    const lock = join(CHROME_PROFILE, "lockfile");
    if (!existsSync(lock)) return false;
    try {
      rmSync(lock);
      return false;
    } catch {
      return true;
    }
  }
  try {
    lstatSync(join(CHROME_PROFILE, "SingletonLock"));
    return true;
  } catch {
    return false;
  }
}

/** 이 프로필로 떠 있는 크롬의 디버깅 포트. 크롬이 적어 둔 파일이 남아 있어도 답하지 않으면 0. */
async function livePort(): Promise<number> {
  let port = 0;
  try {
    port = Number(readFileSync(PORT_FILE, "utf-8").split("\n")[0]) || 0;
  } catch {
    return 0;
  }
  if (!port) return 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { Browser?: string };
    return body.Browser ? port : 0;
  } catch {
    return 0;
  }
}

/**
 * 이 프로필로 떠 있는 크롬에 **새 탭**을 연다 (지난번 주문서 창 따위). → 탭, 떠 있는 것이 없으면 null.
 * 죽이고 새로 띄우지 않는 까닭: 그 창에서 사람이 지난 주문을 결제하는 중일 수 있다.
 */
async function attachExisting(url: string): Promise<Tab | null> {
  const port = await livePort();
  if (!port) return null;
  try {
    // 크롬 111 부터 /json/new 는 PUT 이어야 한다.
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT", signal: AbortSignal.timeout(3000) });
    const target = (await res.json()) as CdpTarget;
    if (!target.webSocketDebuggerUrl) return null;
    return await Tab.connect(target.webSocketDebuggerUrl, port);
  } catch {
    return null;
  }
}

/** 떠 있는 크롬이 있으면 거기 새 탭을, 없으면 새로 띄운다. */
async function openTab(url: string): Promise<Tab> {
  return (await attachExisting(url)) ?? launch(url);
}

/** 크롬을 띄워 첫 탭에 붙는다. 우리 프로세스가 끝나도 창은 남는다 (detached). */
async function launch(url: string): Promise<Tab> {
  mkdirSync(CHROME_PROFILE, { recursive: true });
  // 같은 프로필로 크롬이 남아 있으면 새 크롬은 그쪽에 탭만 넘기고 끝난다 (디버깅 포트가 안 열린다) — 이 프로필을 쓰는 크롬만 정리한다.
  if (profileInUse() && killChromeUsingProfile(CHROME_PROFILE) > 0) await sleep(800);
  rmSync(PORT_FILE, { force: true });
  spawn(chromePath(), [
    `--user-data-dir=${CHROME_PROFILE}`,
    // 0 이면 크롬이 빈 포트를 골라 프로필의 DevToolsActivePort 에 적는다. 이 PC 안(127.0.0.1)에서만 열린다.
    "--remote-debugging-port=0",
    "--no-first-run", "--no-default-browser-check", "--disable-popup-blocking",
    `--window-position=${WINDOW.x},${WINDOW.y}`, `--window-size=${WINDOW.width},${WINDOW.height}`,
    url,
  ], { detached: true, stdio: "ignore" }).unref();

  const deadline = Date.now() + 20_000;
  let port = 0;
  while (!port) {
    if (Date.now() > deadline) throw new BrowserError("크롬이 뜨지 않았습니다 (디버깅 포트를 못 읽었습니다).");
    await sleep(200);
    try {
      port = Number(readFileSync(PORT_FILE, "utf-8").split("\n")[0]) || 0;
    } catch {
      /* 아직 안 적었다 */
    }
  }
  // 탭 목록에서 우리가 연 페이지를 찾는다. 뜨자마자는 목록이 비어 있을 수 있다.
  while (Date.now() <= deadline) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type?: string; webSocketDebuggerUrl?: string }[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return await Tab.connect(page.webSocketDebuggerUrl!, port);
    } catch {
      /* 아직 준비가 안 됐다 */
    }
    await sleep(200);
  }
  throw new BrowserError("크롬 탭에 붙지 못했습니다.");
}

const READ_TOKENS = `[${[KEYS.access, KEYS.refresh, KEYS.device].map((k) => `localStorage.getItem(${JSON.stringify(k)})`).join(", ")}]`;

/** 지금 페이지가 사이트 안인가 — 다른 출처(빈 탭·오류 페이지)의 localStorage 를 읽고 쓰면 안 된다. */
async function onSite(tab: Tab): Promise<boolean> {
  return (await tab.evaluate<string>("location.origin").catch(() => "")) === new URL(SITE).origin;
}

const CLEAR_TOKENS = `localStorage.removeItem(${JSON.stringify(KEYS.access)}); localStorage.removeItem(${JSON.stringify(KEYS.refresh)}); true`;

/** 지금 떠 있는 미리 띄운 크롬들 — 멈출 때(SIGINT) 쓰지 않은 것을 닫으려고 모아 둔다. */
const warms = new Set<WarmChrome>();

/**
 * 구매 태스크가 켜질 때 미리 띄워 두는 크롬 탭.
 *
 *   start()    크롬을 띄우고(떠 있으면 새 탭) 로그인 토큰을 지운 뒤, 주문서를 한 번 열어 번들을 받아 두고
 *              (로그인이 없으니 로그인 화면으로 튕긴다 — 그래도 받은 번들은 캐시에 남는다) 상품 페이지에 세워 둔다
 *   take()     주문이 잡혔다 — 데우기를 멈추고 그 탭을 넘긴다. 닫혔거나 못 띄웠으면 null (그때는 새로 띄운다)
 *   release()  안 쓰고 끝난다 — 우리가 연 탭만 닫는다 (마지막 탭이면 크롬도 같이 끝난다)
 *
 * 띄우다 실패해도 던지지 않는다 — 주문이 잡히면 예전처럼 그때 띄운다.
 */
export class WarmChrome {
  private opening: Promise<Tab | null> | null = null;
  private warming: Promise<void> = Promise.resolve();
  private stopWarm = false;
  private done = false;

  constructor(private readonly parkUrl: string) {}

  start(): void {
    if (this.opening || this.done) return;
    warms.add(this);
    this.opening = openTab(`${SITE}/robots.txt`).then(
      (tab) => {
        tab.onClose = () => {
          if (!this.done) log.warn("미리 띄운 크롬 창이 닫혔습니다 — 주문이 잡히면 그때 새로 띄웁니다");
        };
        return tab;
      },
      (e: unknown) => {
        log.warn(`크롬을 미리 띄우지 못했습니다 (${messageOf(e)}) — 주문이 잡히면 그때 띄웁니다`);
        return null;
      },
    );
    this.warming = this.opening.then((tab) => (tab ? this.warm(tab) : undefined)).catch((e: unknown) => {
      log.debug(`크롬 데우기: ${messageOf(e)}`);
    });
  }

  /** until 이 참이 되거나 ms 가 지날 때까지 조금씩 기다린다. → 그새 멈추라고 했나 */
  private async pause(ms: number, until: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.stopWarm) return true;
      if (await until()) return false;
      await sleep(200);
    }
    return this.stopWarm;
  }

  private async warm(tab: Tab): Promise<void> {
    if (await this.pause(15_000, () => onSite(tab))) return;
    // 지난번 주문서에 심어 둔 토큰이 남아 있으면 사이트 화면이 그것으로 갱신을 할 수 있다 — 화면을 그리기 전에 지운다.
    await tab.evaluate(CLEAR_TOKENS);
    if (this.stopWarm) return;
    await tab.send("Page.navigate", { url: ORDER_URL });
    const bounced = () => tab.evaluate<boolean>(`document.readyState === "complete" && !location.pathname.startsWith("/order")`).catch(() => false);
    if (await this.pause(15_000, bounced)) return;
    await tab.send("Page.navigate", { url: this.parkUrl });
    log.info("크롬을 미리 띄워 상품 페이지에 세워 두었습니다 — 주문이 잡히면 이 창에서 주문서를 엽니다");
  }

  /** 주문서에 쓸 탭. 데우기가 한창이면 다음 쉼에서 멈춘다 (0.2초 안쪽). */
  async take(): Promise<Tab | null> {
    this.done = true;
    this.stopWarm = true;
    warms.delete(this);
    const tab = await (this.opening ?? Promise.resolve(null));
    await this.warming;
    return tab && !tab.closed ? tab : null;
  }

  /** 쓰지 않고 끝낸다 — 우리가 연 탭을 닫는다. 이미 넘긴 것은 건드리지 않는다. */
  async release(): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.stopWarm = true;
    warms.delete(this);
    const tab = await (this.opening ?? Promise.resolve(null));
    await this.warming;
    if (!tab || tab.closed) return;
    await tab.closeTab();
  }
}

/** 멈출 때 — 아직 주문에 안 쓴 미리 띄운 크롬을 전부 닫는다. */
export async function releaseWarmChrome(): Promise<void> {
  await Promise.all([...warms].map((w) => w.release().catch(() => undefined)));
}

/**
 * 로그인 화면을 띄우고 사람이 로그인할 때까지 기다린다. → 받은 세션, 시간 안에 안 했거나 창을 닫았으면 null.
 * 끝나면 창을 닫는다 — 같은 갱신 토큰을 창과 우리가 같이 쥐고 있으면 한쪽이 갱신할 때 다른 쪽이 죽을 수 있다.
 */
export async function humanLogin(timeoutMs = 5 * 60_000): Promise<Session | null> {
  const tab = await launch(LOGIN_URL);
  try {
    const deadline = Date.now() + timeoutMs;
    // 전에 이 프로필로 로그인해 둔 토큰이 남아 있으면 그것이 곧 답이 되어 버린다 — 새로 로그인한 것만 받게 먼저 지운다.
    let cleared = false;
    while (Date.now() < deadline && !tab.closed) {
      await sleep(cleared ? 1000 : 300);
      if (!(await onSite(tab))) continue;
      if (!cleared) {
        await tab.evaluate(CLEAR_TOKENS);
        await tab.send("Page.reload");
        cleared = true;
        continue;
      }
      const tokens = await tab.evaluate<(string | null)[]>(READ_TOKENS).catch(() => null);
      if (tokens?.[0] && tokens[1]) return sessionFromTokens(tokens[0], tokens[1], tokens[2] ?? "");
    }
    return null;
  } finally {
    await tab.send("Browser.close").catch(() => undefined);
    tab.detach();
  }
}

/** 크롬이 알려 주는 탭·프레임 하나 (DevTools 의 /json/list). */
interface CdpTarget {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface CheckoutState {
  /** 지금 골라 둔 결제 수단 (라디오의 글자). */
  method: string;
  /** 등록된 간편결제 카드가 화면에 있나. */
  card: boolean;
}

export type PayOutcome =
  /** 여섯 자리를 넣었고 주문서가 /order/success 로 넘어갔다. */
  | { kind: "paid"; orderNumber: string }
  /** 결제는 창에서 마저 해야 한다 (비밀번호가 없거나, 자판을 못 읽었거나, 결과를 못 봤다). */
  | { kind: "waiting"; why: string }
  /** 창을 띄우지 못하는 따위 — 주문은 만들어졌지만 결제 화면까지 못 갔다. */
  | { kind: "failed"; why: string };

/** 결제하기 단추가 붙은 뒤, 간편결제와 등록 카드가 그려지기를 기다리는 시간. */
const CHECKOUT_TIMEOUT_MS = 15_000;
/** 결제 비밀번호 창이 뜨기를 기다리는 시간. 몰릴 때를 넉넉히 본다. */
const PAY_TIMEOUT_MS = 25_000;
/** 비밀번호를 넣은 뒤 결제 결과를 기다리는 시간. */
const PAY_RESULT_TIMEOUT_MS = 45_000;

const messageOf = (e: unknown): string => String((e as Error)?.message || e).split("\n")[0] ?? "";

async function targetsOn(port: number): Promise<CdpTarget[]> {
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as CdpTarget[];
  } catch {
    return [];
  }
}

/** 그런 탭이 뜰 때까지 짧게 되묻는다. 결제창은 따로 뜬 프레임/탭이라서 여기서만 볼 수 있다. */
async function waitForTarget(
  port: number, want: (target: CdpTarget) => boolean, timeoutMs: number,
): Promise<CdpTarget | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = (await targetsOn(port)).find(want);
    if (hit?.webSocketDebuggerUrl) return hit;
    await sleep(250);
  }
  return null;
}

const READY_JS = `(() => [...document.querySelectorAll("button")]
  .some((el) => el.innerText.trim() === "결제하기" && el.getBoundingClientRect().width > 10))()`;

/**
 * 주문서의 결제 수단. 로그인했고 토스 브랜드페이가 설정돼 있으면 사이트가 **간편결제**를 골라 둔다
 * (order 청크의 `ex ?? (brandpay ? BRAND_PAY : CARD)`). 그 밖(신용카드 등)이면 우리가 누를 것이 없다.
 */
const CHECKOUT_JS = `(() => {
  const radio = [...document.querySelectorAll('input[name="payMethodKind"]')].find((el) => el.checked);
  const label = radio ? (radio.closest("label")?.innerText || "").trim().split("\\n")[0] : "";
  const box = radio ? (radio.closest("label")?.parentElement?.parentElement?.innerText || "") : "";
  return { method: label || "", card: /\\d{6,}\\*{3,}/.test(box) };
})()`;

const PAD_READY_JS = `(() => !!document.querySelector('a[aria-label="가상키패드-1"]')
  && !!document.querySelector('[aria-label*="자리 중"]'))()`;

/** 비밀번호 자판이 몇 자리 채워졌나 ("6자리 중 3자리 입력" → 3). 못 읽으면 -1. */
const DOTS_JS = `(() => {
  const el = document.querySelector('[aria-label*="자리 중"]');
  const m = el ? /(\\d+)자리 중/.exec(el.getAttribute("aria-label") || "") : null;
  return m ? Number(m[1]) : -1;
})()`;

/** 틀린 비밀번호·잠금 같은 말이 떴나 (한 줄). */
const PAY_ERROR_JS = `(() => {
  const lines = (document.body.innerText || "").split("\\n").map((s) => s.trim()).filter(Boolean);
  return lines.find((s) => /일치하지|다시 입력|입력 횟수|초과|잠겼/.test(s)) || "";
})()`;

/** 그 글자를 가진 보이는 단추 하나를 진짜 마우스로 누른다. → 눌렀나 */
async function clickButton(tab: Tab, text: string): Promise<boolean> {
  const rect = await tab.evaluate<{ x: number; y: number } | null>(`(() => {
    const el = [...document.querySelectorAll("button")]
      .filter((b) => b.innerText.trim() === ${JSON.stringify(text)} && b.getBoundingClientRect().width > 10)
      .pop();
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rect) return false;
  await tab.clickAt(rect.x, rect.y);
  return true;
}

/** 자판에서 그 숫자 키의 한가운데. */
const keyRect = (digit: string): string => `(() => {
  const el = document.querySelector('a[aria-label="가상키패드-${digit}"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;

/**
 * 토스 브랜드페이 결제 비밀번호 6자리를 자판으로 누른다.
 *
 * 자판은 뜰 때마다 숫자 자리가 바뀌므로(7·0·9·1…), **누를 때마다 다시 찾는다.** 한 자리를 누른 뒤 점이
 * 늘었는지 보고, 안 늘었으면 그 자리만 한 번 더 시도한 뒤 물러난다 — 틀린 비밀번호를 쌓으면 결제 수단이
 * 잠기므로, 확실하지 않으면 더 누르지 않는다. 값은 로그에 적지 않는다.
 */
async function enterPassword(frame: Tab, digits: string): Promise<boolean> {
  for (const digit of digits) {
    const before = await frame.evaluate<number>(DOTS_JS).catch(() => -1);
    let entered = false;
    for (let attempt = 0; attempt < 2 && !entered; attempt++) {
      const rect = await frame.evaluate<{ x: number; y: number } | null>(keyRect(digit)).catch(() => null);
      if (!rect) return false;
      await frame.clickAt(rect.x, rect.y);
      await sleep(220);
      const after = await frame.evaluate<number>(DOTS_JS).catch(() => -1);
      // 점이 하나 늘었거나, 이미 여섯 자리라 자판이 닫히는 중이면 눌린 것이다.
      entered = after === before + 1 || after === 6;
    }
    if (!entered) return false;
  }
  return true;
}

function orderNumberOf(url: string): string {
  try {
    return new URL(url).searchParams.get("orderNumber") || "";
  } catch {
    return "";
  }
}

/** 비밀번호를 넣은 뒤 — 주문서가 성공으로 넘어갔나, 틀렸다는 말이 떴나. */
async function waitForResult(tab: Tab, frame: Tab): Promise<PayOutcome> {
  const deadline = Date.now() + PAY_RESULT_TIMEOUT_MS;
  const currentUrl = () => tab.evaluate<string>("location.href").catch(() => "");
  while (Date.now() < deadline) {
    await sleep(400);
    const url = await currentUrl();
    if (/\/order\/success/.test(url)) return { kind: "paid", orderNumber: orderNumberOf(url) };
    if (frame.closed) {
      await sleep(600);
      const after = await currentUrl();
      return /\/order\/success/.test(after)
        ? { kind: "paid", orderNumber: orderNumberOf(after) }
        : { kind: "waiting", why: "결제 비밀번호 창이 닫혔습니다 — 주문 내역을 확인해 주세요" };
    }
    const problem = await frame.evaluate<string>(PAY_ERROR_JS).catch(() => "");
    if (problem) return { kind: "waiting", why: `${problem} — 창에서 다시 확인해 주세요` };
  }
  const url = await currentUrl();
  if (/\/order\/success/.test(url)) return { kind: "paid", orderNumber: orderNumberOf(url) };
  return { kind: "waiting", why: "비밀번호는 넣었습니다 — 결과는 창에서 확인해 주세요" };
}

type OrderPage = "ready" | "login" | "cart" | "timeout";

/**
 * 주문서가 어떻게 됐나 — 결제하기 단추가 붙었나(ready), 로그인 화면으로 튕겼나(login), 주문이 없어 장바구니로
 * 갔나(cart). **넘어간 새 화면만** 본다 — 옛 화면에 심어 둔 표지(__aioOld)가 없어진 뒤부터. 세워 둔 탭이
 * 로그인 화면에 있었을 수도 있어서, 옛 화면의 주소를 "튕겼다" 로 읽으면 안 된다.
 */
async function waitOrderPage(tab: Tab, timeoutMs: number): Promise<OrderPage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !tab.closed) {
    await sleep(150);
    const state = await tab.evaluate<{ old: boolean; path: string; ready: boolean }>(
      `({ old: !!window.__aioOld, path: location.pathname, ready: ${READY_JS} })`,
    ).catch(() => null);
    if (!state || state.old) continue;
    if (state.ready) return "ready";
    if (state.path.startsWith("/auth/login")) return "login";
    if (/^\/cart\/?$/.test(state.path)) return "cart";
  }
  return "timeout";
}

/**
 * 로그인 토큰을 심고 주문서를 연다. 창은 남긴다. 부른 쪽이 detach 한다.
 * 미리 띄운 탭이 살아 있으면 그것을 쓰고, 없으면 크롬을 새로 띄운다 (떠 있는 크롬이 있으면 새 탭).
 * → 열린 탭과 주문서의 상태 (waitMs 동안 본다 — 결제하기 단추가 붙으면 바로 돌아온다)
 */
async function openOrderTab(session: Session, warm: WarmChrome | null, waitMs: number): Promise<{ tab: Tab; page: OrderPage }> {
  // 같은 출처의 가벼운 것을 먼저 연다 — localStorage 는 출처마다 따로라, 주문서를 열기 전에 심어야 한다.
  const tab = (await warm?.take()) ?? (await openTab(`${SITE}/robots.txt`));
  try {
    const deadline = Date.now() + 15_000;
    while (!(await onSite(tab))) {
      if (Date.now() > deadline) throw new BrowserError("사이트가 열리지 않았습니다.");
      await sleep(200);
    }
    const set = (key: string, value: string) => `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`;
    await tab.evaluate(`${set(KEYS.access, session.accessToken)} ${set(KEYS.refresh, session.refreshToken)} ${set(KEYS.device, session.deviceId)} window.__aioOld = true; true`);
    await tab.send("Page.navigate", { url: ORDER_URL });
    await tab.send("Page.bringToFront").catch(() => undefined);
    return { tab, page: await waitOrderPage(tab, waitMs) };
  } catch (e) {
    tab.detach();
    log.debug(`주문서 창: ${messageOf(e)}`);
    throw e;
  }
}

/** 주문서를 열기만 한다. → 열렸나 (로그인 화면으로 튕겼으면 false) */
export async function openOrder(session: Session, warm: WarmChrome | null = null): Promise<boolean> {
  // 로그인이 안 먹혔으면 사이트가 /auth/login?returnUrl=… 로 보낸다. 단추가 붙거나 튕길 때까지만 본다.
  const { tab, page } = await openOrderTab(session, warm, 8000);
  tab.detach();
  return page !== "login";
}

/**
 * **결제하기를 누르고 토스 브랜드페이 비밀번호 자판까지 간다.**
 *
 *   주문서(/order) → [결제하기] → 비밀번호 창(connect.tosspayments.com) → 자판 6자리
 *
 * 비밀번호가 없으면 **결제하기까지만 누르고** 창을 사람에게 넘긴다 (KREAM 의 submit 과 같은 자리).
 * 간편결제가 골라져 있지 않거나 등록된 카드가 없으면 누르지 않고 주문서에 그대로 둔다 — 신용카드
 * 결제창은 카드 정보를 묻는 다른 화면이라 대신 채울 것이 없다.
 *
 * 창은 남긴다 (결제 결과·실패 화면을 사람이 봐야 한다). 부른 쪽이 detach 한다.
 */
export async function submitOrder(session: Session, pin: string, warm: WarmChrome | null = null): Promise<PayOutcome> {
  const digits = pin.replace(/\D/g, "");
  let opened: { tab: Tab; page: OrderPage };
  try {
    // Next.js 가 화면을 그릴 때까지 (단추가 붙기 전에 누르면 아무 일도 없다). 새 크롬 프로필에서는
    // 앱 번들이 늦게 올라와 20초 넘게 빈 화면인 적도 있다 — 넉넉히 본다 (미리 띄워 두었으면 금방이다).
    // 예전에는 로그인이 튕기나 보려고 3초를 그냥 기다린 뒤에야 단추를 찾았다 — 이제 같이 본다.
    opened = await openOrderTab(session, warm, 60_000);
  } catch (e) {
    return { kind: "failed", why: `주문서 창을 띄우지 못했습니다 — ${messageOf(e)}` };
  }
  const { tab, page } = opened;
  try {
    if (page === "login") return { kind: "failed", why: "로그인이 풀려 주문서가 열리지 않았습니다" };
    // 주문이 없거나 만료됐으면 사이트가 장바구니로 돌려보낸다 — 여기서 더 기다릴 것이 없다.
    if (page === "cart") {
      return { kind: "waiting", why: "주문서가 장바구니로 넘어갔습니다 (주문이 만료됐거나 만들어진 주문이 없습니다) — 창에서 확인해 주세요" };
    }
    if (page !== "ready") return { kind: "waiting", why: "주문서의 '결제하기' 단추를 찾지 못했습니다 — 창에서 확인해 주세요" };

    // 결제하기 단추는 먼저 붙고, 토스 브랜드페이(간편결제 · 등록 카드)는 그 뒤에 따로 올라온다 — 그 전에는 결제 수단이
    // 신용카드로 잡혀 있거나 카드 칸이 비어 있다. 미리 띄운 크롬이면 단추가 금방 붙어서 바로 읽으면 "카드 없음" 으로
    // 잘못 읽는다 (2026-11-12 07:37 에 그랬다). 간편결제 + 카드가 보일 때까지 기다리고, 끝까지 안 보일 때만 물러난다.
    let checkout: CheckoutState | null = null;
    const checkoutBy = Date.now() + CHECKOUT_TIMEOUT_MS;
    for (;;) {
      checkout = await tab.evaluate<CheckoutState>(CHECKOUT_JS).catch(() => null);
      if ((checkout?.method === "간편결제" && checkout.card) || Date.now() > checkoutBy || tab.closed) break;
      await sleep(200);
    }
    // 카드가 막 그려졌으면 위젯이 마저 붙을 틈을 조금 준다 (예전 흐름은 여기까지 3초 넘게 걸려 늘 그 틈이 있었다).
    if (checkout?.card) await sleep(300);
    if (!checkout) return { kind: "waiting", why: "결제 수단을 읽지 못했습니다 — 창에서 결제해 주세요" };
    if (checkout.method !== "간편결제") {
      return { kind: "waiting", why: `결제 수단이 간편결제가 아닙니다 (${checkout.method || "알 수 없음"}) — 창에서 결제해 주세요` };
    }
    if (!checkout.card) {
      return { kind: "waiting", why: "등록된 간편결제 카드가 없습니다 — 창에서 등록하고 결제해 주세요" };
    }

    // 같은 크롬의 다른 탭(지난번 주문서)에 남은 결제창을 잡지 않게, 누르기 전부터 있던 것은 뺀다.
    const before = new Set((await targetsOn(tab.port)).map((t) => t.id));
    if (!(await clickButton(tab, "결제하기"))) {
      return { kind: "waiting", why: "'결제하기' 단추를 누르지 못했습니다 — 창에서 결제해 주세요" };
    }

    const target = await waitForTarget(
      tab.port,
      (t) => !before.has(t.id) && (t.type === "iframe" || t.type === "page") && (t.url || "").includes("connect.tosspayments.com"),
      PAY_TIMEOUT_MS,
    );
    if (!target) return { kind: "waiting", why: "결제 비밀번호 창이 뜨지 않았습니다 — 창에서 결제해 주세요" };

    const frame = await Tab.connect(target.webSocketDebuggerUrl!, tab.port);
    try {
      // 비밀번호 화면이 그려질 때까지 (결제수단 화면이 먼저 뜰 수도 있다).
      let pad = false;
      for (let i = 0; i < 120 && !pad; i++) {
        await sleep(250);
        pad = await frame.evaluate<boolean>(PAD_READY_JS).catch(() => false);
      }
      if (!pad) return { kind: "waiting", why: "결제 비밀번호 화면이 열리지 않았습니다 — 창에서 확인해 주세요" };
      if (!digits) return { kind: "waiting", why: LINES.pinOpened() };
      if (digits.length !== 6) {
        return { kind: "waiting", why: `결제 비밀번호가 6자리가 아닙니다 (${digits.length}자리) — 창에서 넣어 주세요` };
      }
      if (!(await enterPassword(frame, digits))) {
        return { kind: "waiting", why: "비밀번호 자판을 누르지 못했습니다 — 창에서 넣어 주세요" };
      }
      log.info(LINES.pinEntered());
      return await waitForResult(tab, frame);
    } finally {
      frame.detach();
    }
  } finally {
    tab.detach();
  }
}
