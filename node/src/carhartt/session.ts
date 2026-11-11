/**
 * 로그인. 칼하트윕은 쿠키가 아니라 **토큰**으로 로그인한다 — 사이트가 localStorage 에 두는 것과 같은 둘이다:
 *
 *   POST /v2/auth/login           {email, password}   → {accessToken, refreshToken, expiresIn(초, 보통 900)}
 *   POST /v2/auth/token/refresh   {refreshToken}      → 같은 모양 (X-Device-Id 를 같이 보낸다)
 *   GET  /v2/users/info           로그인돼 있으면 회원 정보, 아니면 payload 가 null (200 — 재 봤다, 2026-11-11)
 *
 * 사이트 번들(로그인 화면·axios 인터셉터)에서 읽은 것이다. 로그인한 뒤의 응답은 계정이 없어 직접 보지 못했다 —
 * 칸 이름이 다르면 여기 한 곳(tokensOf)만 고치면 된다.
 *
 * **비밀번호를 다섯 번 틀리면 계정이 잠긴다** (사이트 문구). 그래서 거절당한 로그인은 다시 시도하지 않는다.
 * 이메일·비밀번호는 로그·파일 어디에도 남기지 않는다. 토큰만 SESSION_PATH 에 적는다.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { call, Rejected, type CallOptions } from "./api.js";
import { SESSION_PATH } from "./config.js";

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** 접근 토큰이 끝나는 때 (ms). */
  expiresAt: number;
  /** 사이트의 device_id — 로그인·갱신에 같은 것을 보낸다. */
  deviceId: string;
  /** 누구로 로그인했나 (보여 주려고만). 창에서 사람이 로그인했으면 "". */
  email: string;
  savedAt: string;
}

/** 로그인이 안 된 것 (세션 없음·만료·거절). 다시 두드려도 소용없다 — 사람이 로그인해야 한다. */
export class NotLoggedIn extends Error {}

export function loadSession(): Session | null {
  try {
    const raw = JSON.parse(readFileSync(SESSION_PATH, "utf-8")) as Partial<Session>;
    if (!raw.accessToken || !raw.refreshToken) return null;
    return {
      accessToken: String(raw.accessToken),
      refreshToken: String(raw.refreshToken),
      expiresAt: Number(raw.expiresAt) || 0,
      deviceId: String(raw.deviceId || randomUUID()),
      email: String(raw.email || ""),
      savedAt: String(raw.savedAt || ""),
    };
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  mkdirSync(dirname(SESSION_PATH), { recursive: true });
  // 읽는 쪽이 반쯤 쓰인 파일을 보지 않게, 옆에 쓰고 바꿔치기한다.
  const tmp = `${SESSION_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...session, savedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, SESSION_PATH);
}

export function clearSession(): boolean {
  const had = existsSync(SESSION_PATH);
  rmSync(SESSION_PATH, { force: true });
  return had;
}

/** 로그인·갱신 응답 → 토큰. 사이트의 persistTokens 와 같은 일 (앞의 "Bearer " 를 뗀다, expiresIn 이 없으면 900초). */
function tokensOf(payload: unknown): Pick<Session, "accessToken" | "refreshToken" | "expiresAt"> | null {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p["accessToken"] !== "string" || typeof p["refreshToken"] !== "string") return null;
  const seconds = typeof p["expiresIn"] === "number" && p["expiresIn"] > 0 ? p["expiresIn"] : 900;
  return {
    accessToken: p["accessToken"].replace(/^Bearer\s+/i, ""),
    refreshToken: p["refreshToken"],
    expiresAt: Date.now() + seconds * 1000,
  };
}

/** 창에서 읽어 온 토큰으로 세션을 만든다 (사람이 크롬에서 로그인했을 때). 끝나는 때는 모르니 곧 갱신하게 둔다. */
export function sessionFromTokens(accessToken: string, refreshToken: string, deviceId: string): Session {
  return {
    accessToken: accessToken.replace(/^Bearer\s+/i, ""), refreshToken,
    expiresAt: 0, deviceId: deviceId || randomUUID(), email: "", savedAt: "",
  };
}

/**
 * 이메일·비밀번호로 로그인한다. **거절당하면 다시 하지 않는다** (다섯 번 틀리면 잠긴다).
 * @param deviceId 전에 쓰던 것이 있으면 그대로 — 사이트도 브라우저마다 하나를 계속 쓴다.
 */
export async function loginWithPassword(email: string, password: string, deviceId: string = randomUUID()): Promise<Session> {
  let payload: unknown;
  try {
    payload = await call("auth/login", { method: "POST", body: { email, password }, deviceId });
  } catch (e) {
    if (!(e instanceof Rejected)) throw e;
    // 사이트의 로그인 화면이 가르는 것과 같은 셋.
    if (e.status === 409 && e.message.includes("잠겼")) {
      throw new NotLoggedIn("비밀번호를 5번 틀려 로그인이 잠겼습니다 — 사이트에서 비밀번호 찾기로 새로 정한 뒤 다시 해 주세요.");
    }
    if (e.status === 400) throw new NotLoggedIn("이메일/비밀번호를 확인해 주세요 (다시 시도하지 않습니다 — 5번 틀리면 잠깁니다).");
    throw new NotLoggedIn(`로그인이 거절됐습니다 (${e.status}): ${e.message}`);
  }
  const tokens = tokensOf(payload);
  if (!tokens) throw new NotLoggedIn("로그인 응답에 토큰이 없습니다 — API 모양이 바뀌었을 수 있습니다.");
  const session: Session = { ...tokens, deviceId, email, savedAt: "" };
  saveSession(session);
  return session;
}

/** 접근 토큰을 새로 받는다. 갱신 토큰까지 죽었으면 NotLoggedIn. */
export async function refresh(session: Session): Promise<void> {
  // 같은 프로필로 도는 다른 프로세스(태스크·모니터·로그인 확인)가 먼저 갱신해 파일에 적어 두었으면 그것을 쓴다 —
  // 갱신 토큰이 한 번 쓰면 바뀌는 것이라면, 저마다 갱신하다가 서로의 토큰을 죽인다.
  const onDisk = loadSession();
  if (onDisk && onDisk.refreshToken !== session.refreshToken && onDisk.expiresAt > Date.now() + 30_000) {
    Object.assign(session, { accessToken: onDisk.accessToken, refreshToken: onDisk.refreshToken, expiresAt: onDisk.expiresAt });
    return;
  }
  let payload: unknown;
  try {
    payload = await call("auth/token/refresh", { method: "POST", body: { refreshToken: session.refreshToken }, deviceId: session.deviceId });
  } catch (e) {
    if (e instanceof Rejected) throw new NotLoggedIn(`토큰을 갱신하지 못했습니다 (${e.status}) — 다시 로그인해 주세요.`);
    throw e;
  }
  const tokens = tokensOf(payload);
  if (!tokens) throw new NotLoggedIn("갱신 응답에 토큰이 없습니다 — 다시 로그인해 주세요.");
  Object.assign(session, tokens);
  saveSession(session);
}

/** 곧 끝날 토큰이면 미리 갱신한다 (사이트는 1분 전에 한다). */
export async function keepFresh(session: Session, marginMs = 60_000): Promise<void> {
  if (Date.now() >= session.expiresAt - marginMs) await refresh(session);
}

/**
 * 로그인해서 부른다. 401 이 오면 한 번 갱신하고 다시 부른다 (사이트의 인터셉터와 같은 순서).
 * 응답에 새 토큰이 실려 오면 그것으로 바꾼다 (사이트의 syncFromPayload).
 */
export async function authed(session: Session, path: string, options: CallOptions = {}): Promise<unknown> {
  await keepFresh(session);
  const once = () => call(path, { ...options, token: session.accessToken, deviceId: session.deviceId });
  let payload: unknown;
  try {
    payload = await once();
  } catch (e) {
    if (!(e instanceof Rejected) || e.status !== 401) throw e;
    await refresh(session);
    payload = await once();
  }
  const rotated = tokensOf(payload);
  if (rotated) {
    Object.assign(session, rotated);
    saveSession(session);
  }
  return payload;
}

/** 회원 정보에서 보여 줄 이름 하나. 칸 이름을 직접 보지 못해 있을 법한 것을 차례로 본다. */
function whoOf(info: Record<string, unknown>, fallback: string): string {
  for (const key of ["email", "userId", "name", "userName", "nickname"]) {
    const value = info[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback || "회원";
}

export interface Whoami {
  who: string;
  /** 본인 인증을 했나. 모르면 null. 프리오더 상품은 인증한 회원만 산다. */
  verified: boolean | null;
}

/** 로그인이 살아 있나. 살아 있으면 누구인지, 아니면 null. */
export async function whoami(session: Session): Promise<Whoami | null> {
  let info: unknown;
  try {
    info = await authed(session, "users/info", { source: true });
  } catch (e) {
    if (e instanceof NotLoggedIn) return null;
    throw e;
  }
  // 토큰이 죽었으면 401 이 아니라 payload 가 null 인 200 이 온다.
  if (!info || typeof info !== "object") return null;
  const record = info as Record<string, unknown>;
  return { who: whoOf(record, session.email), verified: typeof record["isVerified"] === "boolean" ? record["isVerified"] : null };
}
