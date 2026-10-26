/**
 * 자동 로그인 — 프로필에 저장한 이메일·비밀번호로 KREAM 로그인 화면을 채운다.
 *
 *   loginWithPassword   로그인 화면에서 이메일·비밀번호를 넣고 로그인을 누른다
 *   ensureLoggedIn      로그인이 풀려 있으면 다시 로그인한다 (태스크 도중에도) — 받은 쿠키는 프로필 쿠키 파일에 적어
 *                       다른 태스크도 새 쿠키로 띄우게 한다
 *
 * 캡차·본인 인증·추가 인증이 뜨면 **대신 풀지 않는다** — 창을 사람에게 넘기고 기다린다.
 * 이메일·비밀번호는 로그·화면 어디에도 남기지 않는다.
 *
 * 로그인 화면 (2026-10-25 크롬으로 확인): /login 에는 칸이 없고 "네이버로 · Apple로 · 휴대폰으로 · 이메일 로그인" 버튼만 있다.
 * "이메일 로그인" 을 누르면 /login/email — 이메일 칸(type=email, autocomplete=username) · 비밀번호 칸(type=password) ·
 * 아래쪽 "로그인" 버튼(머리말에도 "로그인" 링크가 있어 마지막 것). 로그인한 뒤의 화면(틀렸을 때 문구·추가 인증)은 아직 못 봤다.
 * 칸을 못 찾으면 "human" 으로 돌려 사람에게 넘긴다.
 */
import { writeFileSync } from "node:fs";
import type { KreamBrowser } from "./browser.js";
import { ORIGIN, cookieFileOf, credentialsOf } from "./config.js";
import { LINES } from "./lines.js";
import { log, sayOk, sayStar } from "./log.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const EMAIL_INPUT = 'input[type="email"], input[name*="email" i], input[placeholder*="이메일"], input[autocomplete="username"], input[name*="id" i][type="text"]';
const PASSWORD_INPUT = 'input[type="password"]';

/** 사람이 해야 하는 화면 (캡차·인증번호·본인 인증). */
const HUMAN_TEXT = /보안\s*문자|자동\s*입력\s*방지|인증\s*번호|본인\s*인증|추가\s*인증|captcha|로봇이 아닙니다/i;
/** 아이디·비밀번호가 틀렸다는 말. */
const WRONG_TEXT = /(이메일|아이디|비밀번호)[^.\n]{0,30}(확인해|올바르지|일치하지|잘못)/;

export type LoginOutcome = { kind: "ok" } | { kind: "wrong"; message: string } | { kind: "human"; why: string };

const onLoginPage = (url: string): boolean => /kream\.co\.kr\/login/i.test(url);

/** 로그인 화면(이미 열려 있다)에서 이메일·비밀번호로 로그인한다. */
export async function loginWithPassword(browser: KreamBrowser, email: string, password: string): Promise<LoginOutcome> {
  // 이메일 칸이 바로 없으면 "이메일로 로그인" 같은 버튼 뒤에 있다.
  let typed = await browser.typeInto(EMAIL_INPUT, email);
  if (!typed) {
    await browser.clickText({ pattern: "^이메일(로)?\\s*로그인$" });
    await sleep(800);
    typed = await browser.typeInto(EMAIL_INPUT, email);
  }
  if (!typed) return { kind: "human", why: "이메일 칸을 못 찾았습니다" };
  if (!(await browser.typeInto(PASSWORD_INPUT, password, true))) return { kind: "human", why: "비밀번호 칸을 못 찾았습니다" };
  log.info("이메일·비밀번호를 넣고 로그인을 눌렀습니다");

  const deadline = Date.now() + 20_000;
  let pressed = false;
  while (Date.now() < deadline) {
    await sleep(700);
    const url = await browser.url();
    if (!onLoginPage(url) && (await browser.loggedIn()) === true) return { kind: "ok" };
    const text = await browser.text();
    if (HUMAN_TEXT.test(text)) return { kind: "human", why: "캡차·인증 화면이 떴습니다" };
    const wrong = WRONG_TEXT.exec(text);
    if (wrong) return { kind: "wrong", message: wrong[0] };
    // 엔터로 안 넘어가면 로그인 버튼을 한 번 누른다 (머리말의 로그인 링크가 아니라 아래쪽 버튼 — 마지막 것).
    if (!pressed && Date.now() > deadline - 17_000) {
      pressed = true;
      await browser.clickText({ exact: ["로그인"], last: true });
    }
  }
  if ((await browser.loggedIn()) === true) return { kind: "ok" };
  return { kind: "human", why: "로그인 버튼을 눌러도 넘어가지 않았습니다" };
}

/** 받은 쿠키를 프로필의 쿠키 파일에 적는다 (KREAM_COOKIE_FILE 이 있을 때). */
export async function saveCookieBack(browser: KreamBrowser): Promise<void> {
  const file = cookieFileOf();
  if (!file) return;
  try {
    const line = await browser.cookieLine();
    if (line) writeFileSync(file, `${line}\n`, "utf-8");
  } catch (e) {
    log.debug(`쿠키를 프로필에 적지 못했습니다: ${String((e as Error).message || e)}`);
  }
}

/** 사람이 창에서 끝낼 때까지 로그인을 기다린다. → 로그인됐나 */
async function waitForHuman(browser: KreamBrowser, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (!onLoginPage(await browser.url()) && (await browser.loggedIn()) === true) return true;
  }
  return false;
}

/**
 * 로그인이 살아 있게 한다. 살아 있으면 바로 true. 풀려 있으면 저장된 이메일·비밀번호로 다시 로그인하고, 캡차·인증이 뜨면
 * 창을 사람에게 넘겨 3분까지 기다린다. 다시 로그인했으면 원래 보던 주소로 돌아간다. → 로그인돼 있나
 */
export async function ensureLoggedIn(browser: KreamBrowser): Promise<boolean> {
  if ((await browser.loggedIn()) !== false) return true;
  const creds = credentialsOf();
  if (!creds) {
    log.error(LINES.sessionDead("자동 로그인 정보가 없습니다 — 데스크톱 프로필에서 다시 로그인하거나 자동 로그인을 넣으세요"));
    return false;
  }
  const back = await browser.url();
  log.warn("로그인이 풀려 있습니다 — 저장된 이메일로 다시 로그인합니다");
  await browser.goto(`${ORIGIN}/login`);
  const outcome = await loginWithPassword(browser, creds.email, creds.password);
  let ok = outcome.kind === "ok";
  if (outcome.kind === "wrong") {
    log.error(LINES.sessionDead(`자동 로그인이 거절됐습니다 (${outcome.message}) — 프로필의 이메일·비밀번호를 확인하세요`));
    return false;
  }
  if (outcome.kind === "human") {
    sayStar(`로그인 — 창에서 마저 해 주세요 (${outcome.why})`);
    await browser.showToHuman("로그인을 마저 해 주세요");
    ok = await waitForHuman(browser, 3 * 60_000);
    if (ok) await browser.hide();
  }
  if (!ok) {
    log.error(LINES.sessionDead("다시 로그인하지 못했습니다"));
    return false;
  }
  sayOk("다시 로그인했습니다");
  await saveCookieBack(browser);
  if (back && !onLoginPage(back) && /kream\.co\.kr/.test(back)) await browser.goto(back);
  return true;
}
