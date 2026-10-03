/**
 * 렌더러에 window.aio 하나만 연다. 렌더러는 노드를 못 만지고, 이 목록에 있는 것만 부른다.
 * sandbox 에서 돌므로 electron 말고는 들이지 않는다 (types 는 컴파일 때 지워진다).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AioApi, LogLine, MonitorEntry, MonitorFound, Profile, TaskDef, TaskRuntime } from "../shared/types.js";

const call = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(`aio:${channel}`, ...args);
/** 모니터는 채널을 monitor:* 로 가른다. */
const callMonitor = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(`monitor:${channel}`, ...args);

function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: AioApi = {
  monitor: {
    list: () => callMonitor("list"),
    create: (data) => callMonitor("create", data),
    update: (id, data) => callMonitor("update", id, data),
    delete: (id) => callMonitor("delete", id),
    start: (id) => callMonitor("start", id),
    stop: (id) => callMonitor("stop", id),
    pause: (id) => callMonitor("pause", id),
    resume: (id) => callMonitor("resume", id),
    switchToTask: (id) => callMonitor("switchToTask", id),
    openPopup: (id) => callMonitor("openPopup", id),
    closePopup: (id) => callMonitor("closePopup", id),
    getLogs: (id) => callMonitor("getLogs", id),
    saveLog: (id) => callMonitor("saveLog", id),
    onUpdate: (cb) => listen<MonitorEntry>("monitor:update", cb),
    onLog: (cb) => listen<LogLine[]>("monitor:log", cb),
    onFound: (cb) => listen<MonitorFound>("monitor:found", cb),
    onRemoved: (cb) => listen<string>("monitor:removed", cb),
    onSwitched: (cb) => listen<{ monitorId: string; taskId: string }>("monitor:switched", cb),
  },
  listTasks: () => call("listTasks"),
  saveTask: (t) => call("saveTask", t),
  deleteTask: (id) => call("deleteTask", id),
  runtimes: () => call("runtimes"),
  logs: (id) => call("logs", id),
  start: (id) => call("start", id),
  stop: (id) => call("stop", id),
  startAll: () => call("startAll"),
  stopAll: () => call("stopAll"),
  resetState: (id) => call("resetState", id),
  openHome: (id) => call("openHome", id),
  getSettings: () => call("getSettings"),
  saveSettings: (s) => call("saveSettings", s),
  sitesInfo: () => call("sitesInfo"),
  prepareSite: (site) => call("prepareSite", site),
  listProfiles: () => call("listProfiles"),
  createProfile: (site, name, memo) => call("createProfile", site, name, memo),
  updateProfile: (id, patch) => call("updateProfile", id, patch),
  deleteProfile: (id) => call("deleteProfile", id),
  loginProfile: (id) => call("loginProfile", id),
  cancelLogin: (id) => call("cancelLogin", id),
  logoutProfile: (id) => call("logoutProfile", id),
  verifyProfile: (id) => call("verifyProfile", id),
  setPin: (site, pin) => call("setPin", site, pin),
  testWebhook: (url) => call("testWebhook", url),
  openTaskWatch: (id) => call("openTaskWatch", id),
  closeTaskWatch: (id) => call("closeTaskWatch", id),
  captureTaskWatch: (id) => call("captureTaskWatch", id),
  onRuntime: (cb) => listen<TaskRuntime>("aio:runtime", cb),
  onLogs: (cb) => listen<LogLine[]>("aio:logs", cb),
  onProfile: (cb) => listen<Profile>("aio:profile", cb),
  onTasks: (cb) => listen<TaskDef[]>("aio:tasks", cb),
};

contextBridge.exposeInMainWorld("aio", api);
