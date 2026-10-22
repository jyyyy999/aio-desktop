/**
 * Electron main. 창을 띄우고, 렌더러의 요청을 TaskManager 로 넘기고, 워커에서 올라온
 * 상태·로그를 렌더러로 흘린다. 여기에 태스크 상태를 따로 들고 있지 않는다.
 */
import { app, BrowserWindow, dialog, ipcMain, safeStorage, screen, session, shell } from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SITE_IDS, SITES, TIMING_BLANK } from "../shared/sites.js";
import type {
  LogLine, MonitorEntry, MonitorFound, MonitorInput, Profile, ProfilePatch, QueuePeek, ReleaseInput, Settings, SiteId, SiteSettings, TaskDef,
  TaskRuntime,
} from "../shared/types.js";
import { MonitorManager } from "./monitorManager.js";
import { MonitorStore } from "./monitorStore.js";
import * as supremeOrder from "./supremeOrder.js";
import { SessionManager, type LoginWindows, type PinVault } from "./sessions.js";
import { isDiscordWebhook, sendFound, sendTest } from "./webhook.js";
import { ADAPTERS } from "./sites/index.js";
import { QueueWatch } from "./queueWatch.js";
import { ReleaseStore } from "./releaseStore.js";
import { isHttpUrl } from "../shared/releases.js";
import { TaskManager } from "./taskManager.js";

/** 앱이 aio/desktop 에 있으니 롯데 원본은 옆집 aio/node, 네이버 원본은 ../naver/ts 에 있다. */
function defaultSettings(): Settings {
  const aio = resolve(app.getAppPath(), "..");
  return {
    sites: Object.fromEntries(SITE_IDS.map((id) => [id, ADAPTERS[id].defaults(aio)])) as Record<SiteId, SiteSettings>,
    discordWebhookUrl: "",
  };
}

/** 저장된 것 위에 기본값을 깐다. 사이트가 늘어도 예전 설정 파일이 그대로 읽힌다. */
function withDefaults(saved: Partial<Settings> & { legacyRoot?: string; templateConfig?: string }): Settings {
  const base = defaultSettings();
  // 0.1 은 롯데 하나였다: { legacyRoot, templateConfig }
  const old: Partial<SiteSettings> = {};
  if (saved.legacyRoot) old.root = saved.legacyRoot;
  if (saved.templateConfig) old.seed = saved.templateConfig;
  const sites = { ...base.sites };
  for (const id of SITE_IDS) {
    sites[id] = { ...base.sites[id], ...(id === "lotte" ? old : {}), ...saved.sites?.[id] };
  }
  return { sites, discordWebhookUrl: String(saved.discordWebhookUrl ?? "").trim() };
}

const settingsPath = () => join(app.getPath("userData"), "settings.json");

function loadSettings(): Settings {
  try {
    return withDefaults(JSON.parse(readFileSync(settingsPath(), "utf-8")) as Partial<Settings>);
  } catch {
    return defaultSettings();
  }
}

let win: BrowserWindow | null = null;
let manager: TaskManager;
let sessions: SessionManager;
/** 모니터 — 사지 않고 재고만 본다. 태스크와 따로 돈다. */
let monitors: MonitorManager;
/** 열리기 전 대기열 보기 — 태스크 창이 켠 동안만 돈다. */
let queueWatch: QueueWatch | undefined;
/** 발매정보 — 수동 항목은 releases.json, 자동 항목은 태스크(드랍 시각·열리는 시각)에서 만든다. */
let releases: ReleaseStore;

const releaseList = () => releases.list(manager.list(), manager.runtimes());
/** 자동 항목이 태스크를 따라 바뀌므로 태스크·예약·열리는 시각이 바뀌어도 보낸다. */
const pushReleases = () => win?.webContents.send("release:changed", releaseList());

const RENDERER = join(__dirname, "..", "renderer", "index.html");

/** 메인 창과 태스크 창이 같이 쓰는 렌더러 설정. 둘 다 preload 의 window.aio 하나만 본다. */
const rendererPrefs = (): Electron.WebPreferences => ({
  preload: join(__dirname, "..", "preload", "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

// ── 태스크 창 ───────────────────────────────────────────────────────────
//
// 태스크마다 창 하나. 같은 렌더러를 #task-watch/<id> 로 연다. 화면(브라우저)은 없다 — 원본은 감시하는
// 동안 브라우저를 안 띄운다 (롯데는 HTTP 로 보고, 네이버는 헤드리스 탭을 1초 열었다 닫는다). 그 태스크의
// 상태·로그만 흘려 준다. 창이 없는 태스크에는 아무것도 보내지 않는다.

/** 창 크기를 지금 화면의 작업 영역 안으로 줄인다 — 작은 화면에서 아래가 잘리지 않게. */
function fitToScreen(width: number, height: number, minWidth: number, minHeight: number) {
  const area = screen.getPrimaryDisplay().workArea;
  const w = Math.min(width, area.width);
  const h = Math.min(height, area.height);
  return { width: w, height: h, minWidth: Math.min(minWidth, w), minHeight: Math.min(minHeight, h) };
}

const taskWatches = new Map<string, BrowserWindow>();

/** 그 태스크의 태스크 창에 보낸다. 창이 없거나 닫혔으면 아무것도 안 한다. */
function toTaskWatch(id: string, channel: string, value: unknown): void {
  const watch = taskWatches.get(id);
  if (watch && !watch.isDestroyed()) watch.webContents.send(channel, value);
}

function openTaskWatch(id: string): void {
  const open = taskWatches.get(id);
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    open.focus();
    return;
  }
  if (!manager.list().some((t) => t.id === id)) throw new Error(`없는 태스크입니다: ${id}`);
  const watch = new BrowserWindow({
    ...fitToScreen(900, 700, 560, 420), backgroundColor: "#0d0f14",
    title: "태스크 창 — AIO Task Manager", webPreferences: rendererPrefs(),
  });
  watch.removeMenu();
  void watch.loadFile(RENDERER, { hash: `task-watch/${encodeURIComponent(id)}` });
  taskWatches.set(id, watch);
  watch.on("closed", () => {
    if (taskWatches.get(id) === watch) taskWatches.delete(id);
    // 대기열 보기는 태스크 창이 켠 것이다 — 창이 없으면 볼 사람도 없다.
    queueWatch?.stop(id);
  });
}

function closeTaskWatch(id: string): void {
  const watch = taskWatches.get(id);
  if (watch && !watch.isDestroyed()) watch.close();
}

function closeTaskWatches(): void {
  for (const id of taskWatches.keys()) closeTaskWatch(id);
}

/** 파일 이름에 붙이는 시각. 20260926-173012 */
function fileStamp(at = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

/** 태스크 창의 지금 모습(PNG)과 그 태스크의 로그(텍스트)를 태스크 폴더에 적는다. */
async function captureTaskWatch(id: string): Promise<{ png: string; txt: string }> {
  const watch = taskWatches.get(id);
  if (!watch || watch.isDestroyed()) throw new Error("태스크 창이 열려 있지 않습니다.");
  const home = manager.homeOf(id);
  mkdirSync(home, { recursive: true });
  const base = join(home, `task-watch-${fileStamp()}`);
  const png = `${base}.png`;
  const txt = `${base}.txt`;
  writeFileSync(png, (await watch.webContents.capturePage()).toPNG());
  const mark = { out: "", err: "[err] ", sys: "[매니저] " } as const;
  const lines = manager.logs(id).map((l) => `${new Date(l.at).toTimeString().slice(0, 8)} ${mark[l.stream]}${l.text}`);
  writeFileSync(txt, `${lines.join("\n")}\n`, "utf-8");
  return { png, txt };
}

// ── 모니터 창 (팝업) ───────────────────────────────────────────────────────
//
// 모니터마다 창 하나. 같은 렌더러를 #monitor/<id> 로 연다. 창을 닫아도 모니터는 계속 돈다 (백그라운드).
// 창이 열려 있나(popupOpen)는 monitors.json 에 남긴다. 앱을 닫느라 닫힌 창은 적지 않는다 — 다음에 켰을 때
// 마지막에 열려 있었는지 알게. 창이 없는 모니터에는 아무것도 보내지 않는다.

const monitorPopups = new Map<string, BrowserWindow>();
/** 앱을 닫는 중이라 창을 닫는다 — popupOpen 을 고치지 않는다. */
let keepPopupState = false;

/** 그 모니터의 창에 보낸다. 창이 없거나 닫혔으면 아무것도 안 한다. */
function toMonitorPopup(id: string, channel: string, value: unknown): void {
  const popup = monitorPopups.get(id);
  if (popup && !popup.isDestroyed()) popup.webContents.send(channel, value);
}

function openMonitorPopup(id: string): void {
  const open = monitorPopups.get(id);
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    open.focus();
    return;
  }
  const entry = monitors.list().find((e) => e.def.id === id);
  if (!entry) throw new Error(`없는 모니터입니다: ${id}`);
  const popup = new BrowserWindow({
    ...fitToScreen(820, 760, 560, 480), backgroundColor: "#0d0f14",
    title: `모니터 — ${entry.def.name}`, webPreferences: rendererPrefs(),
  });
  popup.removeMenu();
  void popup.loadFile(RENDERER, { hash: `monitor/${encodeURIComponent(id)}` });
  monitorPopups.set(id, popup);
  monitors.setPopupOpen(id, true);
  popup.on("closed", () => {
    if (monitorPopups.get(id) === popup) monitorPopups.delete(id);
    if (!keepPopupState) monitors.setPopupOpen(id, false);
  });
}

function closeMonitorPopup(id: string): void {
  const popup = monitorPopups.get(id);
  if (popup && !popup.isDestroyed()) popup.close();
}

/** 앱을 닫을 때 — 창은 닫되 popupOpen 은 닫기 전 값으로 남긴다. */
function closeMonitorPopupsForQuit(): void {
  keepPopupState = true;
  for (const id of monitorPopups.keys()) closeMonitorPopup(id);
}

/**
 * 모니터 → 구매 전환. 사람이 "구매 전환" 을 눌렀을 때만 온다 (저절로는 안 한다).
 *   1. 모니터를 멈추고 끝나기를 기다린다 — 감시는 할 일을 마쳤고, 구매 태스크와 요청률을 나눠 쓰지 않게 먼저 비킨다
 *   2. 같은 대상·같은 프로필로 지금 구매(buy — 원본 --buy URL) 태스크를 만든다. "지켜보기" 는 재입고 순간에만
 *      사서, 이미 팔고 있는 물건을 사지 않는다
 *   3. 태스크를 띄운다. 로그인은 그 프로필의 것 그대로 (쿠키·세션)
 */
async function switchToTask(id: string): Promise<{ taskId: string }> {
  const entry = monitors.list().find((e) => e.def.id === id);
  if (!entry) throw new Error(`없는 모니터입니다: ${id}`);
  const { def, state } = entry;
  if (!def.profileId) throw new Error("구매 전환을 하려면 로그인 프로필이 필요합니다 — 모니터를 고쳐 프로필을 고르세요.");
  await monitors.halt(id);
  const task: TaskDef = {
    ...TIMING_BLANK,
    id: randomUUID().slice(0, 8),
    site: def.site,
    profileId: def.profileId,
    label: `${def.name} (모니터 전환)`,
    url: def.productUrl,
    option: def.option,
    ea: def.ea,
    max_price: def.maxPrice,
    mode: "buy",
    action: "",
    checkIntervalMs: def.checkIntervalMs,
  };
  manager.save(task);
  const found = state.foundAt ? ` — ${new Date(state.foundAt).toLocaleTimeString("ko-KR")} 에 발견` : "";
  manager.appendLog(task.id, "sys", `모니터 '${def.name}' 에서 전환했습니다${found}. 지금 구매로 띄웁니다.`);
  monitors.note(id, `모니터 → 태스크 전환: '${task.label}' (지금 구매) 를 띄웠습니다. 모니터는 멈췄습니다.`);
  manager.start(task.id);
  // 모니터 창에서 눌렀어도 메인 창이 알게 — 알림을 치우고 그 태스크를 보인다.
  win?.webContents.send("monitor:switched", { monitorId: id, taskId: task.id });
  return { taskId: task.id };
}

/** 로그(텍스트)와 모니터 창의 모습(PNG, 창이 열려 있으면)을 모니터 폴더에 적는다. */
async function saveMonitorLog(id: string): Promise<{ txt: string; png: string | null }> {
  if (!monitors.list().some((e) => e.def.id === id)) throw new Error(`없는 모니터입니다: ${id}`);
  const home = monitors.homeOf(id);
  mkdirSync(home, { recursive: true });
  const base = join(home, `monitor-${fileStamp()}`);
  const mark = { out: "", err: "[err] ", sys: "[매니저] " } as const;
  const lines = monitors.logs(id).map((l) => `${new Date(l.at).toTimeString().slice(0, 8)} ${mark[l.stream]}${l.text}`);
  writeFileSync(`${base}.txt`, `${lines.join("\n")}\n`, "utf-8");
  const popup = monitorPopups.get(id);
  let png: string | null = null;
  if (popup && !popup.isDestroyed()) {
    png = `${base}.png`;
    writeFileSync(png, (await popup.webContents.capturePage()).toPNG());
  }
  return { txt: `${base}.txt`, png };
}

/** 모니터 로그도 묶어서 보낸다. 메인 창에는 전부(모니터 화면의 로그 패널), 모니터 창에는 제 모니터의 줄만. */
let pendingMonitorLogs: LogLine[] = [];
let monitorFlushTimer: NodeJS.Timeout | null = null;
function queueMonitorLog(line: LogLine): void {
  pendingMonitorLogs.push(line);
  monitorFlushTimer ??= setTimeout(() => {
    monitorFlushTimer = null;
    const batch = pendingMonitorLogs;
    pendingMonitorLogs = [];
    win?.webContents.send("monitor:log", batch);
    for (const id of monitorPopups.keys()) {
      const mine = batch.filter((l) => l.taskId === id);
      if (mine.length) toMonitorPopup(id, "monitor:log", mine);
    }
  }, 120);
}

/** 로그는 초에 수십 줄 올라온다. 줄마다 보내지 않고 묶어서 보낸다. 태스크 창에는 제 태스크의 줄만. */
let pending: LogLine[] = [];
let flushTimer: NodeJS.Timeout | null = null;
function queueLog(line: LogLine): void {
  pending.push(line);
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    const batch = pending;
    pending = [];
    win?.webContents.send("aio:logs", batch);
    for (const id of taskWatches.keys()) {
      const mine = batch.filter((l) => l.taskId === id);
      if (mine.length) toTaskWatch(id, "aio:logs", mine);
    }
  }, 120);
}

// ── 로그인 창 ─────────────────────────────────────────────────────────────
//
// 원본에 로그인 명령이 없는 사이트(롯데)는 매니저가 창을 띄운다. 사람이 창 안에서 로그인하고
// (캡차·2단계 인증도 사람이 한다), 로그인이 됐는지는 원본과 같은 물음으로 본다. 아이디·비밀번호는
// 창 안에만 있다 — 매니저는 로그인이 된 뒤의 쿠키만 모은다. 창의 저장소(partition)는 프로필마다 따로다.

/** 로그인 창이 기다리는 시간. 원본 네이버 --login 과 같다. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** 로그인됐나 묻는 사이 간격. 사이트에 가는 요청이라 촘촘히 두지 않는다. */
const LOGIN_CHECK_GAP_MS = 2000;

/**
 * Electron 이 붙이는 이름표를 뗀 크롬 UA. 창의 속은 크롬 그대로인데 UA 에 "Electron/…" 과 앱
 * 이름이 붙어 있으면 로그인 페이지가 낯선 브라우저로 보고 막을 수 있다.
 */
function chromeUserAgent(ua: string): string {
  const name = app.getName().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return ua.replace(new RegExp(`\\s(?:Electron|${name})/\\S+`, "g"), "");
}

const openLoginWindow: LoginWindows["open"] = (title, partition, spec, note) => {
  const ses = session.fromPartition(partition);
  ses.setUserAgent(chromeUserAgent(ses.getUserAgent()));
  const webPreferences = { partition, sandbox: true, contextIsolation: true, nodeIntegration: false };
  const login = new BrowserWindow({
    width: 1100, height: 860, title: `${title} — AIO Task Manager`, autoHideMenuBar: true, webPreferences,
  });
  login.removeMenu();
  // 본인 확인 같은 팝업도 같은 저장소로 연다 — 거기서 받은 쿠키도 같이 모아야 한다.
  login.webContents.setWindowOpenHandler(() => ({ action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences } }));

  let finish: (cookie: string | null) => void = () => undefined;
  const done = new Promise<string | null>((resolve) => {
    let over = false;
    let asking = false;
    let lastAsk = 0;
    finish = (cookie) => {
      if (over) return;
      over = true;
      clearInterval(tick);
      clearTimeout(limit);
      if (!login.isDestroyed()) login.close();
      resolve(cookie);
    };
    const ask = async () => {
      if (over || asking || login.isDestroyed()) return;
      const url = login.webContents.getURL();
      if (!url || spec.isLoginPage(url) || Date.now() - lastAsk < LOGIN_CHECK_GAP_MS) return;
      asking = true;
      lastAsk = Date.now();
      try {
        const cookies = await ses.cookies.get({ url: spec.cookieUrl });
        const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        if (header && (await spec.alive(header))) finish(header);
      } catch (e) {
        note(`로그인을 확인하지 못했습니다 (다시 봅니다): ${(e as Error).message}`);
      } finally {
        asking = false;
      }
    };
    login.webContents.on("did-navigate", () => void ask());
    login.webContents.on("did-navigate-in-page", () => void ask());
    const tick = setInterval(() => void ask(), 3000);
    const limit = setTimeout(() => {
      note(`${LOGIN_TIMEOUT_MS / 60_000}분 안에 로그인하지 않아 창을 닫습니다.`);
      finish(null);
    }, LOGIN_TIMEOUT_MS);
    login.on("closed", () => finish(null));
  });
  void login.loadURL(spec.startUrl);
  return { done, cancel: () => finish(null) };
};

/** 프로필의 결제 비밀번호를 잠그는 것. 윈도에서는 DPAPI — 이 PC 의 이 윈도 계정에서만 풀린다. */
const pinVault: PinVault = {
  available: () => safeStorage.isEncryptionAvailable(),
  seal: (text) => safeStorage.encryptString(text),
  open: (data) => safeStorage.decryptString(data),
};

const loginWindows: LoginWindows = {
  open: openLoginWindow,
  forget: (partition) => session.fromPartition(partition).clearStorageData(),
};

// ── 닫기 ──────────────────────────────────────────────────────────────────
//
// 창을 닫으면 태스크도 끝낸다. 대부분은 곧 끝나지만, 네이버 태스크는 구매 창이 열려 있으면
// 사람이 닫을 때까지 기다린다 — 그 창에서 결제 중일 수 있다. 그때는 물어본다.

let quitting = false;
let closing = false;

async function requestQuit(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    const stuck = await manager.shutdown();
    if (stuck.length) {
      const ask: Electron.MessageBoxOptions = {
        type: "warning",
        title: "AIO Task Manager",
        message: `구매 창이 열린 태스크 ${stuck.length}개가 창이 닫히기를 기다리고 있습니다.`,
        detail: `${stuck.join(", ")}\n\n강제로 끝내면 그 창도 같이 닫힙니다 (결제 중이면 결제도 끊깁니다).`,
        buttons: ["기다리기", "강제로 끝내기"],
        defaultId: 0,
        cancelId: 0,
      };
      const { response } = await (win ? dialog.showMessageBox(win, ask) : dialog.showMessageBox(ask));
      if (response === 0) return; // 앱은 그대로 두고, 태스크는 "멈추는 중" 으로 남는다
      await manager.killAll();
    }
    // 드랍 예약은 앱이 켜져 있어야 돈다. 닫으면 없어진다는 것을 알고 닫게 한다.
    const scheduled = manager.scheduledNames();
    if (scheduled.length) {
      const ask: Electron.MessageBoxOptions = {
        type: "warning",
        title: "AIO Task Manager",
        message: `드랍 예약 ${scheduled.length}개가 있습니다. 앱을 닫으면 예약이 없어집니다.`,
        detail: scheduled.join(", "),
        buttons: ["앱 켜 두기", "예약 거두고 닫기"],
        defaultId: 0,
        cancelId: 0,
      };
      const { response } = await (win ? dialog.showMessageBox(win, ask) : dialog.showMessageBox(ask));
      if (response === 0) return;
      manager.cancelSchedules();
    }
    sessions.cancelAll();
    closeTaskWatches();
    // 모니터는 사지 않으니 물어볼 것이 없다. 멈추라고 하고 기다렸다가, 안 끝나면 죽인다.
    await monitors.shutdown();
    closeMonitorPopupsForQuit();
    quitting = true;
    app.quit();
  } finally {
    closing = false;
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    ...fitToScreen(1320, 840, 960, 560),
    backgroundColor: "#0d0f14",
    title: "AIO Task Manager",
    webPreferences: rendererPrefs(),
  });
  win.removeMenu();
  void win.loadFile(RENDERER);
  // 모니터가 재고를 발견하면 작업 표시줄에서 깜빡인다 — 창을 보면 멈춘다.
  win.on("focus", () => win?.flashFrame(false));
  win.on("close", (e) => {
    if (quitting || (!manager.hasLive() && !manager.hasScheduled() && !monitors.hasLive())) {
      quitting = true;
      return;
    }
    e.preventDefault();
    void requestQuit();
  });
  win.on("closed", () => {
    win = null;
    // 떠 있는 로그인 창·태스크 창·모니터 창도 닫는다. 안 그러면 그 창이 앱을 붙들고 남는다.
    // 메인 창이 닫히면 앱이 끝나는 것이라 모니터 창의 popupOpen 은 닫기 전 값으로 남긴다.
    sessions?.cancelAll();
    closeTaskWatches();
    queueWatch?.stopAll();
    closeMonitorPopupsForQuit();
  });
}

function registerIpc(): void {
  const m = () => manager;
  ipcMain.handle("aio:supremeOrderGet", () => supremeOrder.stateOf());
  ipcMain.handle("aio:supremeOrderSave", (_e, input: Parameters<typeof supremeOrder.saveOrder>[0]) => supremeOrder.saveOrder(input));
  // 드랍 설정은 **씨앗 설정 파일**(sites.supreme.seed)의 drop 칸에 적는다.
  ipcMain.handle("aio:supremeDropGet", () => supremeOrder.readDrop(loadSettings().sites.supreme.seed));
  ipcMain.handle("aio:supremeDropSave", (_e, drop: Parameters<typeof supremeOrder.saveDrop>[1]) =>
    supremeOrder.saveDrop(loadSettings().sites.supreme.seed, drop),
  );
  ipcMain.handle("aio:listTasks", () => m().list());
  ipcMain.handle("aio:saveTask", (_e, t: TaskDef) => m().save(t));
  ipcMain.handle("aio:deleteTask", (_e, id: string) => m().remove(id));
  ipcMain.handle("aio:runtimes", () => m().runtimes());
  ipcMain.handle("aio:logs", (_e, id: string) => m().logs(id));
  ipcMain.handle("aio:start", (_e, id: string) => m().start(id));
  ipcMain.handle("aio:stop", (_e, id: string) => m().stop(id));
  ipcMain.handle("aio:startAll", () => m().startAll());
  ipcMain.handle("aio:stopAll", () => m().stopAll());
  ipcMain.handle("aio:resetState", (_e, id: string) => m().resetState(id));
  // 렌더러의 confirm()·alert() 대신 (AioApi.ask 주석). 물은 창(메인·태스크 창·모니터 창)에 붙여 띄운다.
  ipcMain.handle("aio:ask", async (e, message: string) => {
    const opts: Electron.MessageBoxOptions = {
      type: "question", title: "AIO Task Manager", message: String(message), buttons: ["확인", "취소"], defaultId: 0, cancelId: 1,
    };
    const win = BrowserWindow.fromWebContents(e.sender);
    const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
    return response === 0;
  });
  ipcMain.handle("aio:tell", async (e, message: string) => {
    const opts: Electron.MessageBoxOptions = { type: "warning", title: "AIO Task Manager", message: String(message), buttons: ["확인"] };
    const win = BrowserWindow.fromWebContents(e.sender);
    await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  });
  ipcMain.handle("aio:openHome", async (_e, id: string) => {
    const home = m().homeOf(id);
    mkdirSync(home, { recursive: true });
    await shell.openPath(home);
  });
  ipcMain.handle("aio:getSettings", () => loadSettings());
  ipcMain.handle("aio:saveSettings", (_e, s: Settings) => {
    const merged = withDefaults(s);
    writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), "utf-8");
    m().setSettings(merged);
    return merged;
  });
  ipcMain.handle("aio:sitesInfo", () => m().sitesInfo());
  ipcMain.handle("aio:prepareSite", (_e, site: SiteId) => m().prepareSite(site));
  ipcMain.handle("aio:listProfiles", () => sessions.list());
  ipcMain.handle("aio:createProfile", (_e, site: SiteId, name: string, memo?: string) =>
    sessions.create(site, String(name ?? ""), String(memo ?? "")));
  ipcMain.handle("aio:updateProfile", (_e, id: string, patch: ProfilePatch) => {
    if (patch?.isActive === false) {
      const busy = [...m().busyWith(id), ...monitors.busyWith(id)];
      if (busy.length) throw new Error(`이 프로필로 돌고 있거나 예약된 태스크·모니터가 있습니다 (${busy.join(", ")}) — 멈춘 뒤 끄세요.`);
    }
    return sessions.update(id, patch ?? {});
  });
  ipcMain.handle("aio:deleteProfile", async (_e, id: string) => {
    const busy = [...m().busyWith(id), ...monitors.busyWith(id)];
    if (busy.length) throw new Error(`이 프로필로 돌고 있거나 예약된 태스크·모니터가 있습니다 (${busy.join(", ")}) — 멈춘 뒤 지우세요.`);
    const list = await sessions.remove(id);
    m().forgetProfile(id);
    return list;
  });
  ipcMain.handle("aio:loginProfile", (_e, id: string) => sessions.login(id));
  ipcMain.handle("aio:cancelLogin", (_e, id: string) => sessions.cancelLogin(id));
  ipcMain.handle("aio:logoutProfile", (_e, id: string) => {
    const busy = [...m().busyWith(id), ...monitors.busyWith(id)];
    if (busy.length) throw new Error(`이 프로필로 돌고 있거나 예약된 태스크·모니터가 있습니다 (${busy.join(", ")}) — 멈춘 뒤 로그아웃하세요.`);
    return sessions.logout(id);
  });
  ipcMain.handle("aio:verifyProfile", (_e, id: string) => sessions.check(id));
  ipcMain.handle("aio:setPin", async (_e, site: SiteId, pin: string | null) => {
    await sessions.setPin(site, pin);
    return m().sitesInfo();
  });
  // 프로필의 결제 비밀번호. 값은 화면 → 여기 → 암호화해서 파일로만 간다. 돌려주는 것은 Profile (있나 없나만).
  ipcMain.handle("aio:setProfilePin", (_e, id: string, pin: string) => sessions.setPaymentPin(id, String(pin ?? "")));
  ipcMain.handle("aio:clearProfilePin", (_e, id: string) => sessions.clearPaymentPin(id));
  ipcMain.handle("aio:testWebhook", (_e, url: string) =>
    isDiscordWebhook(url)
      ? sendTest(url)
      : { ok: false, message: "디스코드 웹훅 주소 모양이 아닙니다 (https://discord.com/api/webhooks/…)." });
  ipcMain.handle("aio:openTaskWatch", (_e, id: string) => openTaskWatch(id));
  ipcMain.handle("aio:closeTaskWatch", (_e, id: string) => closeTaskWatch(id));
  ipcMain.handle("aio:captureTaskWatch", (_e, id: string) => captureTaskWatch(id));
  ipcMain.handle("aio:watchQueue", (_e, id: string, on: boolean) => queueWatch!.set(id, !!on));
  // 모니터 — 채널은 monitor:* (태스크와 가른다)
  const entryOf = (id: string) => {
    const e = monitors.list().find((one) => one.def.id === id);
    if (!e) throw new Error(`없는 모니터입니다: ${id}`);
    return e;
  };
  ipcMain.handle("monitor:list", () => monitors.list());
  ipcMain.handle("monitor:create", (_e, data: MonitorInput) => monitors.create(data));
  ipcMain.handle("monitor:update", (_e, id: string, data: MonitorInput) => monitors.update(id, data));
  ipcMain.handle("monitor:delete", async (_e, id: string) => {
    await monitors.remove(id);
    return monitors.list();
  });
  ipcMain.handle("monitor:start", (_e, id: string) => {
    monitors.start(id);
    return entryOf(id);
  });
  ipcMain.handle("monitor:stop", (_e, id: string) => monitors.stop(id));
  ipcMain.handle("monitor:pause", (_e, id: string) => monitors.pause(id));
  ipcMain.handle("monitor:resume", (_e, id: string) => monitors.resume(id));
  ipcMain.handle("monitor:switchToTask", (_e, id: string) => switchToTask(id));
  ipcMain.handle("monitor:openPopup", (_e, id: string) => openMonitorPopup(id));
  ipcMain.handle("monitor:closePopup", (_e, id: string) => closeMonitorPopup(id));
  ipcMain.handle("monitor:getLogs", (_e, id: string) => monitors.logs(id));
  ipcMain.handle("monitor:saveLog", (_e, id: string) => saveMonitorLog(id));
  // 발매정보 — 채널은 release:*. 바꾸는 것은 전부 새 목록을 돌려준다.
  ipcMain.handle("release:list", () => releaseList());
  ipcMain.handle("release:create", (_e, input: ReleaseInput) => {
    releases.create(input);
    return releaseList();
  });
  ipcMain.handle("release:update", (_e, id: string, input: ReleaseInput) => {
    releases.update(id, input);
    return releaseList();
  });
  ipcMain.handle("release:delete", (_e, id: string) => {
    releases.remove(id);
    return releaseList();
  });
  ipcMain.handle("release:hideAuto", (_e, id: string) => {
    releases.hideAuto(id);
    return releaseList();
  });
  ipcMain.handle("release:showHidden", () => {
    releases.showHidden();
    return releaseList();
  });
  // 앱 안에서 열지 않고 기본 브라우저로. 렌더러가 무엇을 넘기든 http · https 말고는 열지 않는다.
  ipcMain.handle("release:openLink", async (_e, url: string) => {
    if (!isHttpUrl(String(url ?? ""))) throw new Error("http · https 주소만 열 수 있습니다.");
    await shell.openExternal(new URL(String(url).trim()).toString());
  });
}

app.whenReady().then(() => {
  manager = new TaskManager(
    app.getPath("userData"),
    join(__dirname, "..", "worker", "worker.js"),
    loadSettings(),
    (id) => sessions.ref(id),
    (profileId) => sessions.paymentPin(profileId),
    // 네이버 요청률 합·한 프로필에 하나 — 도는 모니터도 같이 센다.
    () => monitors.liveUses(),
  );
  releases = new ReleaseStore(app.getPath("userData"));
  /** 태스크마다 마지막으로 본 드랍 예약 시각 — 바뀔 때만 발매정보를 다시 보낸다 (runtime 은 초에 몇 번씩 온다). */
  const dropAts = new Map<string, number | null>();
  manager.on("runtime", (rt: TaskRuntime) => {
    win?.webContents.send("aio:runtime", rt);
    toTaskWatch(rt.id, "aio:runtime", rt);
    if ((dropAts.get(rt.id) ?? null) !== rt.dropAt) {
      dropAts.set(rt.id, rt.dropAt);
      pushReleases();
    }
  });
  manager.on("log", queueLog);
  // 열리기 전 대기열 보기 — 그 태스크의 태스크 창에만 보낸다 (켠 것도 그 창이다).
  queueWatch = new QueueWatch((id) => manager.list().find((t) => t.id === id));
  queueWatch.on("peek", (p: QueuePeek) => {
    toTaskWatch(p.taskId, "aio:queuePeek", p);
    // 대기열 보기가 읽은 열리는 시각을 발매정보의 자동 항목으로 남긴다.
    if (releases.noteOpensAt(p.taskId, p.opensAt)) pushReleases();
  });
  manager.on("tasks", (tasks: TaskDef[]) => {
    win?.webContents.send("aio:tasks", tasks);
    pushReleases();
    for (const id of [...taskWatches.keys()]) {
      // 지운 태스크의 태스크 창은 닫는다. 남은 것에는 바뀐 설정을 보낸다.
      if (tasks.some((t) => t.id === id)) toTaskWatch(id, "aio:tasks", tasks);
      else closeTaskWatch(id);
    }
  });
  sessions = new SessionManager(
    app.getPath("userData"),
    join(__dirname, "..", "worker", "worker.js"),
    (site) => manager.settingsOf(site),
    loginWindows,
    (id, stream, text) => manager.appendLog(id, stream, text),
    pinVault,
  );
  sessions.on("profile", (p: Profile) => {
    win?.webContents.send("aio:profile", p);
    // 태스크 창은 제 태스크가 고른 프로필의 로그인 상태를 보인다.
    for (const t of manager.list()) if (t.profileId === p.id) toTaskWatch(t.id, "aio:profile", p);
  });
  manager.on("sessionDead", (profileId: string, line: string) => sessions.sessionDead(profileId, line));
  monitors = new MonitorManager(
    new MonitorStore(app.getPath("userData")),
    join(__dirname, "..", "worker", "worker.js"),
    (site) => manager.settingsOf(site),
    (id) => sessions.ref(id),
    () => manager.liveUses(),
  );
  monitors.on("sessionDead", (profileId: string, line: string) => sessions.sessionDead(profileId, line));
  // 메인 창에는 전부, 모니터 창에는 제 모니터의 상태·로그·발견만. 지운 모니터의 창은 닫는다.
  monitors.on("update", (e: MonitorEntry) => {
    win?.webContents.send("monitor:update", e);
    toMonitorPopup(e.def.id, "monitor:update", e);
  });
  monitors.on("log", queueMonitorLog);
  monitors.on("found", (found: MonitorFound) => {
    win?.webContents.send("monitor:found", found);
    toMonitorPopup(found.monitorId, "monitor:found", found);
    // 앱이 뒤에 있으면 작업 표시줄에서 깜빡인다 (앞으로 오면 멈춘다).
    if (win && !win.isFocused()) win.flashFrame(true);
    // 디스코드 — 그 사이트 태스크의 알림이 가는 웹훅으로. dry-run 이라 원본은 보내지 않는다.
    const url = ADAPTERS[found.site].webhookUrl(manager.settingsOf(found.site), manager.common());
    if (!url) {
      monitors.note(found.monitorId, `디스코드 웹훅이 없어 알리지 않았습니다 (${SITES[found.site].name} — 설정에서 공통 웹훅을 넣으세요).`);
      return;
    }
    void sendFound(url, found).then((r) => monitors.note(found.monitorId, r.ok ? "디스코드로 알렸습니다." : `디스코드로 알리지 못했습니다 — ${r.message}`));
  });
  monitors.on("removed", (id: string) => {
    win?.webContents.send("monitor:removed", id);
    closeMonitorPopup(id);
  });
  registerIpc();
  createWindow();
  // 켤 때 한 번, 저장된 로그인이 살아 있는지 원본에 묻는다 (로그인 정보가 있는 프로필마다 요청 하나, 하나씩).
  void sessions.checkAll();
});

app.on("before-quit", (e) => {
  if (quitting || !manager) return;
  e.preventDefault();
  void requestQuit();
});
app.on("window-all-closed", () => app.quit());
