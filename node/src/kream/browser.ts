/**
 * KREAM 용 크롬 창.
 *
 * 집(aio/node)의 규약을 따른다 (supreme/browser.ts 와 같은 방식).
 *   · 프로필을 태스크 홈에 고정한다(`--user-data-dir`)
 *   · 창을 **모니터 밖**에 세운다 — 사이트에는 평소의 크롬으로 보이고, 내 눈에만 안 보인다. 사람이 손댈 차례가 되면
 *     그 창을 화면 안으로 올린다
 *   · 봇 탐지를 속이는 짓은 하지 않는다. 대기열(wait.kream.co.kr)도 사람처럼 줄을 서서 기다린다
 *
 * 로그인은 데스크톱 프로필 창에서 사람이 한 쿠키를 CDP 로 심는다 (KREAM_COOKIE).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Builder, By, Key, type WebDriver, type WebElement } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { killChromeUsingProfile } from "../supreme/browser.js";
import { log } from "./log.js";

export class BrowserError extends Error {}

const OFFSCREEN = { x: -32000, y: -32000, width: 1280, height: 900 };
const ONSCREEN = { x: 120, y: 40, width: 1180, height: 900 };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** 크롬이 남긴 잠금 파일 껍데기를 치운다. */
function cleanProfileLocks(profileDir: string): void {
  for (const name of ["lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket", join("Default", "LOCK")]) {
    try {
      rmSync(join(profileDir, name), { force: true });
    } catch {
      /* 쓰고 있으면 그냥 둔다 */
    }
  }
}

/** 눌러 볼 것 — 화면 글자로 찾는다. 정규식은 글자(source)로 넘긴다 (셀레니움 인자는 JSON 이다). */
export interface TextQuery {
  /** 이 중 하나와 같은 글자 (앞뒤 공백·줄바꿈은 접는다) */
  exact?: string[];
  /** 이 정규식에 맞는 글자 */
  pattern?: string;
  /** 이 선택자 안에서만 찾는다 (옵션 고르기 창 따위) */
  within?: string;
  /** 여럿이면 마지막 것 (아래 고정 버튼은 문서 끝에 있다) */
  last?: boolean;
}

/**
 * 글자로 찾는 스크립트. 가장 안쪽의 맞는 마디를 찾고, 그 마디를 감싼 누를 수 있는 것(button·a·label·role=button)을
 * 돌려준다 — 누르는 것은 셀레니움의 진짜 마우스 클릭으로 한다 (clickText). 안 보이거나 막혀 있는(disabled·aria-disabled)
 * 것은 건너뛴다. → [누를 마디, 글자], 못 찾으면 null
 */
const FIND_BY_TEXT = `
const q = arguments[0];
const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
const re = q.pattern ? new RegExp(q.pattern) : null;
const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
// within 은 여럿에 맞을 수 있다 — 보이는 것들 안에서 모두 찾는다.
const roots = q.within ? [...document.querySelectorAll(q.within)].filter(visible) : [document];
if (!roots.length) return null;
const blocked = (el) => !!el.closest("[disabled],[aria-disabled='true']") || /(^|\\s)(disabled|is-disabled|dimmed)(\\s|$)/.test(String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className));
const hits = [];
const pool = [...new Set(roots.flatMap((root) => [...root.querySelectorAll("button,a,label,li,[role=button],[role=option],[role=radio],div,span,p,strong")]))];
for (const el of pool) {
  const text = norm(el.innerText);
  if (!text || text.length > 60) continue;
  const ok = (q.exact && q.exact.some((t) => norm(t) === text)) || (re && re.test(text));
  if (!ok || !visible(el)) continue;
  // 더 안쪽에 같은 글자를 가진 마디가 있으면 그쪽을 쓴다
  if ([...el.children].some((c) => norm(c.innerText) === text)) continue;
  const target = el.closest("button,a,label,[role=button],[role=option],[role=radio]") || el;
  if (blocked(target)) continue;
  hits.push({ target, text });
}
if (!hits.length) return null;
const pick = q.last ? hits[hits.length - 1] : hits[0];
pick.target.scrollIntoView({ block: "center" });
return [pick.target, pick.text];
`;

export class KreamBrowser {
  private readonly driver: WebDriver;
  /** 사람이 창에서 이어서 해야 하면 true — 끝낼 때 크롬을 남긴다. */
  keepAlive = false;
  private readonly offscreen: boolean;

  private constructor(driver: WebDriver, offscreen: boolean) {
    this.driver = driver;
    this.offscreen = offscreen;
  }

  static async launch(options: { profileDir: string; offscreen: boolean; cookie: string; origin: string }): Promise<KreamBrowser> {
    const o = new chrome.Options();
    o.detachDriver(true);
    o.setPageLoadStrategy("eager");
    o.excludeSwitches("enable-logging");
    o.addArguments(
      "--disable-popup-blocking",
      "--log-level=3",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
    );
    mkdirSync(options.profileDir, { recursive: true });
    // 같은 프로필로 크롬이 남아 있으면 새 크롬이 못 뜬다 — 이 프로필을 쓰는 크롬만 정리한다.
    const killed = killChromeUsingProfile(options.profileDir);
    if (killed > 0) {
      log.warn(`같은 프로필로 떠 있던 크롬 ${killed}개를 정리하고 새로 띄웁니다`);
      // 크롬이 프로필을 놓을 시간 — 바로 띄우면 "Chrome failed to start: crashed" (2026-10-26, 슈프림도 같은 이유로 쉰다).
      await sleep(800);
    }
    cleanProfileLocks(options.profileDir);
    o.addArguments(`--user-data-dir=${options.profileDir}`);
    if (options.offscreen) o.addArguments(`--window-position=${OFFSCREEN.x},${OFFSCREEN.y}`, `--window-size=${OFFSCREEN.width},${OFFSCREEN.height}`);
    let driver: WebDriver | null = null;
    for (let attempt = 0; !driver; attempt++) {
      try {
        driver = await new Builder().forBrowser("chrome").setChromeOptions(o).build();
      } catch (e) {
        const why = String((e as Error).message || e).trim().split("\n")[0] ?? "크롬을 띄우지 못했습니다";
        // 남은 크롬이 늦게 내려가는 판이 있다 — 한 번만 정리·쉬었다가 다시.
        if (attempt >= 1 || !/crash|failed to start|user data directory/i.test(why)) throw new BrowserError(why);
        log.warn(`크롬이 바로 뜨지 않아 한 번 더 띄웁니다 (${why})`);
        killChromeUsingProfile(options.profileDir);
        await sleep(1500);
        cleanProfileLocks(options.profileDir);
      }
    }
    const browser = new KreamBrowser(driver, options.offscreen);
    if (options.cookie) await browser.injectCookies(options.cookie, options.origin);
    return browser;
  }

  private async cdp(command: string, params: object): Promise<unknown> {
    const driver = this.driver as WebDriver & { sendDevToolsCommand(cmd: string, params: object): Promise<unknown> };
    return driver.sendDevToolsCommand(command, params);
  }

  /** 프로필의 로그인 쿠키를 심는다 (kream.co.kr 와 그 아래 전부에 가게 .kream.co.kr 로). */
  async injectCookies(raw: string, origin: string): Promise<number> {
    const jar = parseCookies(raw);
    if (!jar.length) return 0;
    const host = new URL(origin).host;
    const cookies = jar.map((c) => ({ name: c.name, value: c.value, domain: `.${host}`, path: "/", secure: true }));
    try {
      await this.cdp("Network.enable", {});
      await this.cdp("Network.setCookies", { cookies });
      log.debug(`쿠키 ${cookies.length}개를 심었습니다`);
      return cookies.length;
    } catch (e) {
      log.warn(`쿠키를 심지 못했습니다: ${String((e as Error).message || e)}`);
      return 0;
    }
  }

  async goto(url: string): Promise<void> {
    await this.driver.get(url);
    await this.settle(15_000);
  }

  async reload(): Promise<void> {
    await this.driver.navigate().refresh();
    await this.settle(15_000);
  }

  async url(): Promise<string> {
    try {
      return await this.driver.getCurrentUrl();
    } catch {
      return "";
    }
  }

  async html(): Promise<string> {
    return this.driver.getPageSource();
  }

  async text(): Promise<string> {
    try {
      return String(await this.driver.executeScript("return document.body ? document.body.innerText : ''"));
    } catch {
      return "";
    }
  }

  async run<T>(script: string, ...args: unknown[]): Promise<T> {
    return this.driver.executeScript<T>(script, ...args);
  }

  /** 지금 창의 모든 프레임 길. `[]` 는 맨 위 문서, `[2, 0]` 은 셋째 프레임 안의 첫째 프레임이다. */
  async framePaths(maxDepth = 2): Promise<number[][]> {
    const out: number[][] = [[]];
    const walk = async (path: number[]): Promise<void> => {
      if (path.length >= maxDepth) return;
      let count = 0;
      try {
        count = await this.driver.executeScript<number>("return document.querySelectorAll('iframe,frame').length");
      } catch {
        return;
      }
      for (let i = 0; i < count; i++) {
        const next = [...path, i];
        out.push(next);
        if (await this.enterFrame(next)) await walk(next);
      }
      await this.topFrame();
    };
    await this.topFrame();
    await walk([]);
    await this.topFrame();
    return out;
  }

  /** 맨 위 문서로 돌아간다. */
  async topFrame(): Promise<void> {
    try {
      await this.driver.switchTo().defaultContent();
    } catch {
      /* 창이 닫혔을 수 있다 */
    }
  }

  /** 이 크롬의 창들 (첫째가 처음 연 창). 결제창이 새 창으로 뜨는 사이트가 있어서 필요하다. */
  async windowHandles(): Promise<string[]> {
    try {
      return await this.driver.getAllWindowHandles();
    } catch {
      return [];
    }
  }

  async currentWindow(): Promise<string> {
    try {
      return await this.driver.getWindowHandle();
    } catch {
      return "";
    }
  }

  async useWindow(handle: string): Promise<boolean> {
    try {
      await this.driver.switchTo().window(handle);
      // 창을 바꾸면 프레임 문맥도 처음으로 돌린다 (Selenium 이 대개 해 주지만 확실히).
      await this.topFrame();
      return true;
    } catch {
      return false;
    }
  }

  /** 프레임 길로 들어간다. 못 들어가면 맨 위 문서로 돌아오고 false. */
  async enterFrame(path: number[]): Promise<boolean> {
    try {
      await this.topFrame();
      for (const index of path) await this.driver.switchTo().frame(index);
      return true;
    } catch {
      await this.topFrame();
      return false;
    }
  }

  /** 글자로 찾아 누른다. → 누른 글자, 못 찾으면 null */
  async clickText(q: TextQuery): Promise<string | null> {
    let found: [WebElement, string] | null;
    try {
      found = await this.driver.executeScript<[WebElement, string] | null>(FIND_BY_TEXT, q);
    } catch (e) {
      log.debug(`찾지 못했습니다: ${String((e as Error).message || e)}`);
      return null;
    }
    if (!found) return null;
    const [el, text] = found;
    return (await this.press(el)) ? text : null;
  }

  /**
   * 진짜 마우스 클릭으로 누른다. 스크립트의 el.click() 은 KREAM 구매하기 버튼에 먹지 않았다 (2026-10-25: 같은 버튼을
   * 셀레니움 클릭으로 누르니 옵션 창이 떴다). 다른 것이 가로막으면 그때만 스크립트로 누른다. → 눌렀나
   */
  async press(el: WebElement): Promise<boolean> {
    try {
      await el.click();
      return true;
    } catch (e) {
      log.debug(`마우스로 못 눌러 스크립트로 누릅니다: ${String((e as Error).message || e).split("\n")[0]}`);
      try {
        await this.driver.executeScript("arguments[0].click();", el);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * 페이지가 살아날 때까지(Nuxt 하이드레이션) 기다린다. 그 전에 누르면 버튼이 아무 일도 안 한다 — 서버가 그린 껍데기라서다.
   * 감시는 빠르게 하려고 문서가 설 때(interactive)까지만 기다리므로, 누르기 전에 따로 기다린다. → 살아났나
   */
  async waitHydrated(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ok = await this.driver.executeScript<boolean>(
          "var a = document.querySelector('#__nuxt'); return !!(a && a.__vue_app__) && document.readyState === 'complete';",
        );
        if (ok) return true;
      } catch {
        /* 문서가 바뀌는 중 */
      }
      await sleep(150);
    }
    return false;
  }

  /** 글자로 찾아 누를 때까지 기다린다. → 누른 글자, 시간이 다 되면 null */
  async clickTextWithin(q: TextQuery, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = await this.clickText(q);
      if (hit || Date.now() >= deadline) return hit;
      await sleep(200);
    }
  }

  /**
   * 보이는 입력칸 중 선택자에 맞는 첫 칸에 글자를 넣는다 — 사람이 치는 것처럼 키를 보낸다 (값만 바꾸면 화면 틀이 모른다).
   * → 넣었나. 값은 로그에 남기지 않는다.
   */
  async typeInto(css: string, text: string, enter = false): Promise<boolean> {
    for (const el of await this.driver.findElements(By.css(css))) {
      try {
        if (!(await el.isDisplayed()) || !(await el.isEnabled())) continue;
        await el.click();
        await el.clear();
        await el.sendKeys(text, ...(enter ? [Key.ENTER] : []));
        return true;
      } catch {
        /* 다음 칸 */
      }
    }
    return false;
  }

  /** 지금 문서(kream.co.kr)에 가는 쿠키를 한 줄로 — 개발자 도구의 Cookie 줄과 같다 (HttpOnly 포함). */
  async cookieLine(): Promise<string> {
    const jar = await this.driver.manage().getCookies();
    return jar.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  /** 페이지 안 같은 출처로 마이페이지를 물어 로그인을 본다 (서버가 302 로 /login 에 보내면 끊긴 것). */
  async loggedIn(): Promise<boolean | null> {
    try {
      return await this.driver.executeAsyncScript<boolean | null>(`
        const done = arguments[arguments.length - 1];
        fetch("/my", { redirect: "manual", credentials: "include" })
          .then((r) => done(r.type === "opaqueredirect" ? false : r.ok ? true : null))
          .catch(() => done(null));
      `);
    } catch {
      return null;
    }
  }

  /** 문서가 설 때까지 (interactive 면 충분하다). */
  private async settle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.driver.executeScript<string>("return document.readyState");
        if (state === "interactive" || state === "complete") return;
      } catch {
        /* 아직 문서가 없다 */
      }
      await sleep(150);
    }
  }

  /** 사람이 볼 수 있게 창을 화면 안으로 가져온다. 끝낼 때 크롬을 남긴다. */
  async showToHuman(note: string): Promise<void> {
    log.info(`창을 사람에게 보여 줍니다 — ${note}`);
    this.keepAlive = true;
    try {
      await this.driver.manage().window().setRect(ONSCREEN);
      await this.cdp("Page.bringToFront", {});
    } catch (e) {
      log.debug(`창을 못 옮겼습니다: ${String((e as Error).message || e)}`);
    }
  }

  /** 사람이 끝냈으면 창을 다시 모니터 밖으로 (처음에 밖에서 띄웠을 때만). */
  async hide(): Promise<void> {
    this.keepAlive = false;
    if (!this.offscreen) return;
    try {
      await this.driver.manage().window().setRect(OFFSCREEN);
    } catch {
      /* 창이 닫혔을 수 있다 */
    }
  }

  /** 실패했을 때 화면·HTML·글자를 담아 둔다. → 담은 파일 앞부분 경로 */
  async dump(dir: string, tag: string): Promise<string> {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = join(dir, `${stamp}-${tag}`);
    try {
      writeFileSync(`${base}.png`, await this.driver.takeScreenshot(), "base64");
    } catch {
      /* 창이 닫혔을 수 있다 */
    }
    try {
      writeFileSync(`${base}.html`, await this.html(), "utf-8");
      writeFileSync(`${base}.txt`, `${await this.url()}\n\n${await this.text()}`, "utf-8");
    } catch {
      /* 창이 닫혔을 수 있다 */
    }
    return base;
  }

  /** 끝낸다. 사람이 이어서 해야 하는 창이면 크롬을 남기고 드라이버만 놓는다. */
  async quit(): Promise<void> {
    if (this.keepAlive) {
      log.info("크롬 창은 남겨 둡니다 — 창에서 마저 끝내 주세요");
      return;
    }
    try {
      await this.driver.quit();
    } catch {
      /* 이미 닫혔다 */
    }
  }

  get isOffscreen(): boolean {
    return this.offscreen;
  }
}
