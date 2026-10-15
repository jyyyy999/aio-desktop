/**
 * 슈프림용 크롬 창 다루기.
 *
 * 집(aio/node)의 규약을 따른다.
 *   · 프로필을 한 곳에 고정한다(`--user-data-dir`) — 사람이 한 번 통과한 사람확인(Cloudflare) 쿠키가 남는다
 *   · 창을 **모니터 밖**에 세운다(`--window-position=-32000,-32000`). headless 와 다르다 — 사이트에는
 *     평소의 크롬으로 보이고, 내 눈에만 안 보인다. headless 는 사이트가 알아본다.
 *   · 봇 탐지를 속이는 짓(navigator.webdriver 감추기 따위)은 하지 않는다
 *
 * 그리고 **캡차 전용 창**을 만든다. 캡차가 뜨면 새 창을 열어 같은 체크아웃 주소로 가고, 그 창만
 * 화면 안으로 옮긴 뒤 "캡차만 남기는" 집중 모드를 건다 — 사람 눈에는 hCaptcha 만 있는 창이다.
 * 풀고 나면 그 창에서 그대로 이어서 진행한다 (토큰이 그 창의 폼에 들어가 있으므로).
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Builder, By, type WebDriver } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { probeScript } from "./captcha.js";
import type { CaptchaWindowHost } from "./captcha-window.js";
import type { CheckoutHost } from "./checkout.js";
import { log } from "./log.js";

export class BrowserError extends Error {}

const OFFSCREEN_X = -32000;
const OFFSCREEN_Y = -32000;
/** 캡차 창을 놓을 자리 — 사람이 바로 볼 수 있게 화면 안쪽. */
const CAPTCHA_RECT = { x: 160, y: 60, width: 720, height: 860 };

export interface BrowserOptions {
  profileDir: string | null;
  headless: boolean;
  /** 창을 모니터 밖에 둔다 (사람이 볼 일이 없을 때) */
  offscreen: boolean;
  /** 캡차 창 크기 (0 이면 기본값) */
  captchaWidth: number;
  captchaHeight: number;
  /** 스토어프론트 오리진 — 빌려온 쿠키를 심을 도메인 */
  origin: string;
  /** 쿠키를 CDP 로 심는다 (사람이 창에서 통과한 세션) */
  cookie?: string;
}

export interface FrameHandle {
  name: string;
  run(script: string): Promise<unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * **이 프로필을 쓰고 있는 크롬만** 골라 끝낸다.
 *
 * 왜 필요한가: `detachDriver(true)` 라서 태스크를 멈춰도 크롬 창은 남는다(사람이 결제를 끝내야 할 때
 * 필요하다). 그런데 **같은 프로필로 크롬이 이미 떠 있으면 새 크롬은 그 창에 붙었다가 곧바로 죽는다** —
 * 셀레니움은 그것을 "Chrome failed to start: crashed" 로 보고한다. 2026-10-08 에 이걸로 네 번 연속
 * 실패했다(첫 실행이 남긴 크롬 11개가 프로필을 잡고 있었다). 그래서 띄우기 전에 정리한다.
 *
 * 다른 크롬(사용자가 쓰는 평소 크롬)은 **건드리지 않는다** — 명령줄에 이 프로필 경로가 있는 것만.
 */
export function killChromeUsingProfile(profileDir: string): number {
  if (!profileDir) return 0;
  if (process.platform !== "win32") return killChromeUsingProfilePosix(profileDir);
  // 결과는 **파일로** 받는다. child_process 의 파이프(stdio: pipe)는 이 환경에서 막힐 수 있다(EPERM).
  const outFile = join(tmpdir(), `supreme-kill-${process.pid}-${Date.now()}.txt`);
  // PowerShell 문자열은 **작은따옴표**로. JSON.stringify 를 쓰면 경로가 C:\\Users\\… 로 들어가
  // 아무것도 매칭되지 않는다 (2026-10-08 에 이걸로 정리가 조용히 실패했다).
  const ps = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const script = [
    `$p = ${ps(profileDir)};`,
    `$k = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) });`,
    "$k | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };",
    `Set-Content -LiteralPath ${ps(outFile)} -Value $k.Count -Encoding ascii`,
  ].join(" ");
  try {
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", timeout: 25_000 });
    const count = Number(String(readFileSync(outFile, "utf-8")).trim());
    rmSync(outFile, { force: true });
    return Number.isFinite(count) ? count : 0;
  } catch (e) {
    log.debug(`프로필을 쓰는 크롬을 정리하지 못했습니다: ${String((e as Error).message || e)}`);
    return 0;
  }
}

/**
 * 맥·리눅스 판. PowerShell 이 없으니 `ps` 로 모든 프로세스의 명령줄을 받아 고른다.
 *
 * 맥은 앱 데이터가 `~/Library/Application Support/…` 라 프로필 경로에 **띄어쓰기가 있다.** `ps` 는 인자를
 * 띄어쓰기로 이어 붙여 보여 주므로 경로를 쪼개지 말고 `--user-data-dir=<경로>` 통째로 찾는다. 뒤에 띄어쓰기나
 * 줄 끝이 와야 한다 — `chrome-profile` 이 `chrome-profile-2` 를 잡지 않게.
 * 크롬 본체와 도우미(맥의 "Google Chrome Helper (Renderer)" 따위) 모두 명령줄에 이 인자를 달고 있어 같이 잡힌다.
 * 윈도우 판이 chrome.exe 전부를 세는 것과 같다.
 */
function killChromeUsingProfilePosix(profileDir: string): number {
  // 윈도우 판처럼 결과는 파일로 받는다 (파이프를 쓰지 않는다).
  const outFile = join(tmpdir(), `supreme-kill-${process.pid}-${Date.now()}.txt`);
  try {
    const fd = openSync(outFile, "w");
    try {
      spawnSync("ps", ["-axww", "-o", "pid=,command="], { stdio: ["ignore", fd, "ignore"], timeout: 10_000 });
    } finally {
      closeSync(fd);
    }
    let killed = 0;
    for (const pid of pidsUsingProfile(readFileSync(outFile, "utf-8"), profileDir, process.pid)) {
      try {
        process.kill(pid, "SIGKILL");
        killed++;
      } catch {
        /* 그새 끝났다 */
      }
    }
    return killed;
  } catch (e) {
    log.debug(`프로필을 쓰는 크롬을 정리하지 못했습니다: ${String((e as Error).message || e)}`);
    return 0;
  } finally {
    rmSync(outFile, { force: true });
  }
}

/** `ps -axww -o pid=,command=` 의 출력에서 이 프로필을 쓰는 크롬의 pid 만. 나(self)는 뺀다. */
export function pidsUsingProfile(psOutput: string, profileDir: string, self: number): number[] {
  const flag = `--user-data-dir=${profileDir}`;
  const out: number[] = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[2] ?? "";
    const at = command.indexOf(flag);
    // 크롬인지는 **인자 앞쪽**(실행 파일)으로 본다. 프로필 경로 자체에 chrome-profile 이 있어서, 명령줄 전체를
    // 보면 같은 경로를 인자로 받은 node 따위도 크롬으로 잡힌다.
    if (pid === self || at < 0 || !/chrom/i.test(command.slice(0, at))) continue;
    const next = command.charAt(at + flag.length);
    if (next === "" || next === " ") out.push(pid);
  }
  return out;
}

/** 크롬이 남긴 잠금 파일 껍데기를 치운다 (프로세스가 없으면 무해하지만, 있으면 못 뜨는 판이 있다). */
function cleanProfileLocks(profileDir: string): void {
  for (const name of ["lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket", join("Default", "LOCK")]) {
    try {
      rmSync(join(profileDir, name), { force: true });
    } catch {
      /* 쓰고 있으면 그냥 둔다 */
    }
  }
}

function parseCookies(raw: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const part of (raw || "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (name) out.push({ name, value: part.slice(at + 1).trim() });
  }
  return out;
}

/** 크롬 하나 + 그 안의 창들. CheckoutHost·CaptchaWindowHost 를 그대로 만족한다. */
export class SupremeBrowser implements CheckoutHost {
  private readonly driver: WebDriver;
  /** 처음 창(감시·자동 진행이 도는 창). 보통 모니터 밖에 있다. */
  private readonly mainHandle: string;
  /** 이 크롬의 프로필 — 끝낼 때 이 프로필을 쓰는 크롬을 정리한다. */
  private readonly profileDir: string | null;
  /** 사람이 창에서 이어서 해야 하는 상황이면 true — 끝낼 때 크롬을 남긴다. */
  keepAlive = false;
  /** 캡차 전용 창 */
  private captchaHandle: string | null = null;
  private activeHandle: string;
  private stopRequested = false;
  private failing = false;
  /** 캡차 전용 창을 열었을 때 부르는 것 (index.ts 가 알림을 보낸다) */
  onCaptchaWindow?: () => void;

  private constructor(driver: WebDriver, mainHandle: string, profileDir: string | null) {
    this.driver = driver;
    this.mainHandle = mainHandle;
    this.profileDir = profileDir;
    this.activeHandle = mainHandle;
  }

  static async launch(options: BrowserOptions): Promise<SupremeBrowser> {
    const chromeOptions = new chrome.Options();
    chromeOptions.detachDriver(true);
    chromeOptions.setPageLoadStrategy("eager");
    chromeOptions.addArguments("--disable-popup-blocking");
    chromeOptions.excludeSwitches("enable-logging");
    chromeOptions.addArguments("--log-level=3");
    // 첫 실행 안내·기본 브라우저 확인 창이 뜨면 자동화가 그 창에 막힌다.
    chromeOptions.addArguments("--no-first-run", "--no-default-browser-check");
    // 새 창을 열어도 크롬이 배경 창의 타이머를 늦추지 않게 한다 (감시가 멈추면 안 된다).
    chromeOptions.addArguments("--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows");
    if (options.profileDir) {
      mkdirSync(options.profileDir, { recursive: true });
      // 같은 프로필로 이미 크롬이 떠 있으면 우리 크롬은 못 뜬다 ("Chrome failed to start: crashed").
      // 띄우기 전에 **이 프로필을 쓰는 크롬만** 정리한다.
      const killed = killChromeUsingProfile(options.profileDir);
      if (killed > 0) log.warn(`같은 프로필로 떠 있던 크롬 ${killed}개를 정리하고 새로 띄웁니다`);
      cleanProfileLocks(options.profileDir);
      await sleep(500); // 크롬이 프로필을 놓을 시간
      chromeOptions.addArguments(`--user-data-dir=${options.profileDir}`);
    } else {
      log.warn("프로필 폴더가 없습니다 — 크롬이 임시 프로필로 뜹니다(사람이 해 둔 것·통과한 사람확인이 안 남습니다)");
    }
    if (options.headless) {
      chromeOptions.addArguments("--headless=new");
    } else if (options.offscreen) {
      chromeOptions.addArguments(`--window-position=${OFFSCREEN_X},${OFFSCREEN_Y}`, "--window-size=1280,900");
    }

    let driver: WebDriver;
    try {
      driver = await new Builder().forBrowser("chrome").setChromeOptions(chromeOptions).build();
    } catch (e) {
      // 그래도 못 뜨면(프로필을 다른 크롬이 잡고 있거나 프로필이 깨졌으면) **임시 프로필로 한 번 더**.
      // 이 판은 사람 확인(Cloudflare) 쿠키가 없으므로 새로 받아야 한다 — 그 사실을 남긴다.
      if (!options.profileDir) {
        throw new BrowserError(String((e as Error).message || e).trim().split("\n")[0] ?? "크롬을 띄우지 못했습니다");
      }
      log.warn("프로필로 크롬을 못 띄웠습니다 — 임시 프로필로 다시 시도합니다 (사람 확인 쿠키는 새로 받아야 합니다)");
      const fallback = new chrome.Options();
      fallback.detachDriver(true);
      fallback.setPageLoadStrategy("eager");
      fallback.excludeSwitches("enable-logging");
      for (const arg of [
        "--disable-popup-blocking",
        "--log-level=3",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        ...(options.headless
          ? ["--headless=new"]
          : options.offscreen
            ? [`--window-position=${OFFSCREEN_X},${OFFSCREEN_Y}`, "--window-size=1280,900"]
            : []),
      ]) {
        fallback.addArguments(arg);
      }
      fallback.addArguments(`--user-data-dir=${options.profileDir}-tmp`);
      try {
        driver = await new Builder().forBrowser("chrome").setChromeOptions(fallback).build();
      } catch (e2) {
        throw new BrowserError(String((e2 as Error).message || e2).trim().split("\n")[0] ?? "크롬을 띄우지 못했습니다");
      }
    }

    const handles = await driver.getAllWindowHandles();
    const main = handles[handles.length - 1];
    if (!main) throw new BrowserError("크롬 창을 하나도 못 얻었습니다");
    const browser = new SupremeBrowser(driver, main, options.profileDir);
    if (options.cookie) await browser.injectCookies(options.cookie, options.origin);
    return browser;
  }

  /* ── 창 ──────────────────────────────────────────────── */

  /** 창 좌표를 옮긴다. 창이 닫혔으면 무시한다. */
  private async setRect(handle: string, rect: { x: number; y: number; width: number; height: number }): Promise<void> {
    try {
      await this.driver.switchTo().window(handle);
      await this.driver.manage().window().setRect(rect);
    } catch (e) {
      log.debug(`창 좌표를 못 옮겼습니다: ${String((e as Error).message || e)}`);
    }
  }

  /** CDP 명령 — 셀레니움 타입에 없어서 캐스팅해 부른다 (집의 browser.ts 와 같은 방식). */
  private async cdp(command: string, params: object): Promise<void> {
    const driver = this.driver as WebDriver & {
      sendDevToolsCommand(cmd: string, params: object): Promise<void>;
    };
    await driver.sendDevToolsCommand(command, params);
  }

  private async bringToFront(handle: string): Promise<void> {
    try {
      await this.driver.switchTo().window(handle);
      await this.cdp("Page.bringToFront", {});
    } catch (e) {
      log.debug(`창을 앞으로 못 가져왔습니다: ${String((e as Error).message || e)}`);
    }
  }

  /** 지금 활성 창으로 조작 대상을 맞춘다 (창을 바꾸면 프레임 문맥이 풀린다). */
  private async use(handle: string): Promise<void> {
    await this.driver.switchTo().window(handle);
    await this.driver.switchTo().defaultContent();
    this.activeHandle = handle;
  }

  /**
   * 조작 대상 창으로 간다. **사람이 캡차 창을 닫아 버렸으면** 원래 창으로 돌아가 그 창을 화면에 띄운다 —
   * 닫힌 창을 붙잡고 예외로 태스크가 통째로 죽지 않게 (원래 창에도 같은 캡차가 있어 거기서 풀면 된다).
   */
  private async useAlive(): Promise<void> {
    try {
      await this.use(this.activeHandle);
      return;
    } catch (e) {
      if (!this.captchaHandle || this.activeHandle !== this.captchaHandle) throw e;
    }
    log.warn("캡차 창이 닫혔습니다 — 원래 창을 화면에 띄웁니다 (거기서 이어서 풀어 주세요)");
    this.captchaHandle = null;
    if (!(await this.fallbackToMain())) throw new BrowserError("캡차 창과 원래 창이 모두 닫혔습니다");
    await this.showCurrentWindowOnScreen();
  }

  async windowHandles(): Promise<string[]> {
    return this.driver.getAllWindowHandles();
  }

  /** 사람이 볼 수 있게 **지금 창을** 화면 안으로 가져온다 (봇 차단·실패 화면용). */
  async showToHuman(note: string): Promise<void> {
    log.info(`창을 사람에게 보여 줍니다 — ${note}`);
    // 사람이 이어서 해야 한다 — 끝낼 때 크롬을 닫지 않는다.
    this.keepAlive = true;
    await this.showCurrentWindowOnScreen();
  }

  /** 자동 진행 창을 다시 모니터 밖으로 보낸다. */
  async background(): Promise<void> {
    if (this.captchaHandle) {
      await this.setRect(this.captchaHandle, { x: OFFSCREEN_X, y: OFFSCREEN_Y, width: 1280, height: 900 });
    }
    await this.setRect(this.activeHandle, { x: OFFSCREEN_X, y: OFFSCREEN_Y, width: 1280, height: 900 });
  }

  /* ── 페이지 ──────────────────────────────────────────── */

  async goto(url: string): Promise<void> {
    await this.useAlive();
    this.failing = false;
    await this.driver.get(url);
    await this.settle(10_000);
  }

  async url(): Promise<string> {
    try {
      return await this.driver.getCurrentUrl();
    } catch {
      return "";
    }
  }

  /**
   * 페이지에서 스크립트를 돌린다.
   *
   * 셀레니움은 넘긴 글을 **함수 몸통**으로 넣는다 — 그래서 값을 돌려받으려면 `return` 이 있어야 한다.
   * 이 모듈의 스크립트는 전부 IIFE 식(`(() => {…})()`)이라, `return` 으로 시작하지 않으면 감싸 준다.
   * (집의 다른 원본은 처음부터 `"return …"` 으로 쓴다. 둘 다 받게 해 둔다.)
   */
  private bodyOf(script: string): string {
    const text = script.trim();
    if (/^return\b/.test(text)) return script;
    return `return (${script});`;
  }

  async run(script: string): Promise<unknown> {
    await this.useAlive();
    return this.driver.executeScript(this.bodyOf(script));
  }

  /** 문서가 설 때까지 (interactive 면 충분하다 — 광고까지 기다리지 않는다) */
  private async settle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.driver.executeScript<string>("return document.readyState");
        if (state === "interactive" || state === "complete") return;
      } catch {
        // 아직 문서가 없다
      }
      await sleep(150);
    }
  }

  /** 지금 문서의 iframe 들 — 카드 입력창은 여기 안에 있다. */
  async frames(): Promise<FrameHandle[]> {
    await this.useAlive();
    const out: FrameHandle[] = [];
    let count = 0;
    try {
      count = (await this.driver.findElements(By.css("iframe"))).length;
    } catch {
      return out;
    }
    for (let i = 0; i < count; i++) {
      let name = `iframe[${i}]`;
      try {
        await this.driver.switchTo().defaultContent();
        const handle = (await this.driver.findElements(By.css("iframe")))[i];
        if (!handle) continue;
        name = (await this.driver.executeScript<string>(
          "return arguments[0].getAttribute('name') || arguments[0].getAttribute('title') || arguments[0].getAttribute('src') || '';",
          handle,
        )) || name;
      } catch {
        continue;
      }
      out.push({ name, run: async (script: string) => this.runInFrame(i, script) });
    }
    await this.driver.switchTo().defaultContent();
    return out;
  }

  private async runInFrame(index: number, script: string): Promise<unknown> {
    await this.useAlive();
    try {
      await this.driver.switchTo().frame(index);
      const value = await this.driver.executeScript(this.bodyOf(script));
      await this.driver.switchTo().defaultContent();
      return value;
    } catch (e) {
      log.debug(`iframe[${index}] 안에서 스크립트를 못 돌렸습니다: ${String((e as Error).message || e)}`);
      try {
        await this.driver.switchTo().defaultContent();
      } catch {
        /* 창이 닫혔을 수 있다 */
      }
      return null;
    }
  }

  async screenshot(path: string): Promise<string> {
    try {
      const png = await this.driver.takeScreenshot();
      writeFileSync(path, png, "base64");
      return path;
    } catch (e) {
      log.debug(`화면을 못 담았습니다: ${String((e as Error).message || e)}`);
      return "";
    }
  }

  /* ── 캡차 전용 창 ────────────────────────────────────── */

  async isOnCaptchaPage(): Promise<boolean> {
    try {
      const probe = (await this.run(probeScript())) as { present?: boolean } | null;
      return !!probe?.present;
    } catch {
      return false;
    }
  }

  /**
   * 새 문서마다 심을 스크립트 (CDP). 창이 새로 열려도 따라간다 —
   * 집의 lotte-test/browser.ts 가 알림 가로채기에 쓰는 것과 같은 방법이다.
   */
  async addNewDocumentScript(source: string): Promise<boolean> {
    try {
      await this.cdp("Page.enable", {});
      await this.cdp("Page.addScriptToEvaluateOnNewDocument", { source });
      return true;
    } catch (e) {
      log.debug(`새 문서 스크립트를 못 심었습니다: ${String((e as Error).message || e)}`);
      return false;
    }
  }

  /**
   * 캡차를 사람에게 넘길 창을 만든다.
   *
   * 지금 창이 이미 캡차 창이면 그냥 앞으로 가져온다. 아니면 **새 창을 열어 같은 주소로 간다**
   * (쿠키가 같아 체크아웃 진행 상황도 그대로다). 그 창만 화면 안으로 옮긴다.
   */
  async showCaptchaWindow(opts: { width: number; height: number; onTop: boolean; title: string }): Promise<void> {
    const width = opts.width > 0 ? opts.width : CAPTCHA_RECT.width;
    const height = opts.height > 0 ? opts.height : CAPTCHA_RECT.height;
    const rect = { x: CAPTCHA_RECT.x, y: CAPTCHA_RECT.y, width, height };

    const alive = this.captchaHandle && (await this.windowHandles()).includes(this.captchaHandle);
    if (alive) {
      await this.setRect(this.captchaHandle!, rect);
      await this.bringToFront(this.captchaHandle!);
      await this.use(this.captchaHandle!);
      return;
    }

    const currentUrl = await this.url();
    log.info("캡차 전용 창을 엽니다");
    try {
      await this.use(this.activeHandle);
      await this.driver.switchTo().newWindow("window");
      const handle = await this.driver.getWindowHandle();
      this.captchaHandle = handle;
      this.activeHandle = handle;
      if (currentUrl) {
        await this.driver.get(currentUrl);
        await this.settle(10_000);
      }
      await this.setRect(handle, rect);
      await this.bringToFront(handle);
      await this.use(handle);
      this.onCaptchaWindow?.();
    } catch (e) {
      log.warn(`캡차 전용 창을 못 열었습니다(${String((e as Error).message || e)}) — 보고 있던 창을 씁니다`);
      this.captchaHandle = null;
      await this.showCurrentWindowOnScreen();
      this.onCaptchaWindow?.();
    }
  }

  /** 새 창을 못 열었을 때: 지금 창을 화면 안으로 옮긴다 (그래도 사람은 캡차를 풀 수 있다). */
  private async showCurrentWindowOnScreen(): Promise<void> {
    await this.setRect(this.activeHandle, { x: CAPTCHA_RECT.x, y: CAPTCHA_RECT.y, width: CAPTCHA_RECT.width, height: CAPTCHA_RECT.height });
    await this.bringToFront(this.activeHandle);
  }

  /** 집중 모드만 풀고 창은 남긴다 (이어서 진행해야 하므로). */
  async hideCaptchaWindow(): Promise<void> {
    // 집중 모드 해제는 captcha-window.ts 가 한다 (unfocusScript). 여기서는 창만 정리한다.
  }

  /** 캡차 창을 닫고 자동 진행 창으로 돌아간다. 결제가 끝났을 때 부른다. */
  async closeCaptchaWindow(): Promise<void> {
    // 결제까지 끝났으면 남길 이유가 없다 — 다음 실행이 막히지 않게 크롬도 정리 대상으로 되돌린다.
    this.keepAlive = false;
    if (!this.captchaHandle) return;
    const handle = this.captchaHandle;
    this.captchaHandle = null;
    try {
      const handles = await this.windowHandles();
      if (handles.includes(handle)) {
        await this.driver.switchTo().window(handle);
        await this.driver.close();
      }
    } catch (e) {
      log.debug(`캡차 창을 못 닫았습니다: ${String((e as Error).message || e)}`);
    }
    const handles = await this.windowHandles();
    const back = handles.includes(this.mainHandle) ? this.mainHandle : handles[handles.length - 1];
    if (back) await this.use(back);
  }

  /** 캡차 창에서 진행하던 것을 원래 창으로 되돌린다 (사람이 캡차 창을 닫아 버렸을 때). */
  async fallbackToMain(): Promise<boolean> {
    const handles = await this.windowHandles();
    if (!handles.includes(this.mainHandle)) return false;
    await this.use(this.mainHandle);
    return true;
  }

  async activeIsCaptchaWindow(): Promise<boolean> {
    if (!this.captchaHandle) return false;
    return (await this.windowHandles()).includes(this.captchaHandle) && this.activeHandle === this.captchaHandle;
  }

  /* ── 쿠키 ───────────────────────────────────────────── */

  /** 빌려온 쿠키를 CDP 로 심는다 (사람이 창에서 통과한 사람확인 쿠키를 태스크로 옮길 때). */
  async injectCookies(raw: string, origin: string): Promise<number> {
    const jar = parseCookies(raw);
    if (!jar.length) return 0;
    let host = "shop.supreme.com";
    try {
      host = new URL(origin).host;
    } catch {
      /* 오리진이 이상하면 기본 호스트로 */
    }
    const cookies = jar.map((c) => ({ name: c.name, value: c.value, domain: host, path: "/", secure: true }));
    try {
      await this.cdp("Network.enable", {});
      await this.cdp("Network.setCookies", { cookies });
      log.debug(`쿠키 ${cookies.length}개를 심었습니다`);
      return cookies.length;
    } catch (e) {
      log.debug(`쿠키를 심지 못했습니다: ${String((e as Error).message || e)}`);
      return 0;
    }
  }

  async cookies(): Promise<Record<string, string>> {
    try {
      const list = await this.driver.manage().getCookies();
      const jar: Record<string, string> = {};
      for (const c of list) jar[c.name] = c.value;
      return jar;
    } catch {
      return {};
    }
  }

  /* ── 사람의 멈춤 ─────────────────────────────────────── */

  requestStop(): void {
    this.stopRequested = true;
  }

  cancelled(): boolean {
    return this.stopRequested;
  }

  note(text: string): void {
    log.info(text);
  }

  async sleep(ms: number): Promise<void> {
    const step = 200;
    let left = ms;
    while (left > 0 && !this.stopRequested) {
      const chunk = Math.min(step, left);
      await sleep(chunk);
      left -= chunk;
    }
  }

  /**
   * 끝낸다. `keepAlive`(사람이 창에서 이어서 해야 하는 상황)면 **크롬을 남기고**,
   * 아니면 이 프로필을 쓰는 크롬을 정리한다 — 남겨 두면 다음 실행이 "Chrome failed to start" 로 막힌다.
   */
  async quit(keepAlive = this.keepAlive): Promise<void> {
    try {
      await this.driver.quit();
    } catch {
      /* 이미 닫혔다 */
    }
    if (!keepAlive && this.profileDir) {
      const killed = killChromeUsingProfile(this.profileDir);
      if (killed > 0) log.debug(`크롬 ${killed}개를 정리했습니다 (다음 실행이 막히지 않게)`);
    } else if (this.profileDir) {
      log.info("창을 남겨 둡니다 — 사람이 이어서 해야 합니다 (다음 실행 때 정리하고 새로 띄웁니다)");
    }
  }
}

export { sleep as browserSleep };
export type { CaptchaWindowHost };
