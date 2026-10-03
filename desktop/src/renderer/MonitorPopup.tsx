/**
 * 모니터 창 (팝업) — 모니터 하나의 상태·대상·실시간 로그. main 이 #monitor/<id> 로 연다 (모니터마다 창 하나).
 * 창을 닫아도 모니터는 계속 돈다.
 *
 * 재고를 발견하면 위에 "재고 발견!" 판이 뜬다. 구매 전환으로 만든 모니터면 🛒 즉시 구매 전환 — 누르면 모니터를
 * 멈추고 같은 대상으로 지금 구매 태스크를 띄운다 (저절로는 안 한다).
 */
import { useEffect, useState } from "react";
import { MONITOR_RUNNING, MONITOR_STATUS_LABEL, ON_FOUND_LABEL } from "../shared/monitors";
import { SITES } from "../shared/sites";
import type { LogLine, MonitorEntry, Profile } from "../shared/types";
import { errText, LOGIN_LABEL, LogView, mergeLogs, span } from "./App";
import { agoOf, clockOf, MONITOR_DOT, switchMonitor } from "./Monitors";

const aio = window.aio;

/** 모니터 창이 들고 있는 로그 줄. */
const KEEP = 1000;

/** 00:12:34 */
function elapsed(from: string | undefined, now: number): string {
  if (!from) return "—";
  const sec = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(sec / 3600))}:${two(Math.floor((sec % 3600) / 60))}:${two(sec % 60)}`;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function MonitorPopup({ monitorId }: { monitorId: string }) {
  const [entry, setEntry] = useState<MonitorEntry | null>(null);
  const [gone, setGone] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  /** 일시정지(보기만)하면 그때의 줄을 붙잡아 보인다. 로그는 그동안에도 계속 받는다. */
  const [frozen, setFrozen] = useState<LogLine[] | null>(null);
  /** "알림만 받고 닫기" 를 누른 발견 — 같은 발견이면 판을 다시 띄우지 않는다. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void aio.monitor.list().then((list) => {
      const mine = list.find((e) => e.def.id === monitorId);
      if (mine) setEntry(mine);
      else setGone(true);
    });
    void aio.listProfiles().then(setProfiles);
    // 받아 오는 사이에 흘러온 줄이 이미 붙어 있을 수 있다. 번호로 이어 붙인다.
    void aio.monitor.getLogs(monitorId).then((list) => setLogs((streamed) => mergeLogs(list, streamed).slice(-KEEP)));
    const offs = [
      aio.monitor.onUpdate((e) => {
        if (e.def.id === monitorId) setEntry(e);
      }),
      aio.monitor.onLog((batch) => {
        const mine = batch.filter((l) => l.taskId === monitorId);
        if (mine.length) setLogs((prev) => mergeLogs(prev, mine).slice(-KEEP));
      }),
      aio.monitor.onRemoved((id) => {
        if (id === monitorId) setGone(true);
      }),
      aio.onProfile((p) => setProfiles((prev) => (prev.some((one) => one.id === p.id) ? prev.map((one) => (one.id === p.id ? p : one)) : [...prev, p]))),
    ];
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      for (const off of offs) off();
      clearInterval(tick);
    };
  }, [monitorId]);

  const def = entry?.def;
  const state = entry?.state;
  const found = state?.status === "found" && state.foundAt !== dismissed;

  useEffect(() => {
    if (!def || !state) return;
    const head = found ? "🔴 재고 발견!" : `${MONITOR_DOT[state.status]} 모니터`;
    document.title = `${head} — ${SITES[def.site].name} ${def.name}`;
  }, [def, state, found]);

  if (gone) return <div className="monitor-popup"><div className="empty">모니터가 지워졌습니다.</div></div>;
  if (!def || !state || !entry) return <div className="monitor-popup"><div className="empty">불러오는 중…</div></div>;

  const live = MONITOR_RUNNING.includes(state.status);
  const profile = profiles.find((p) => p.id === def.profileId);
  const shown = frozen ?? logs;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const saveLog = () =>
    act(async () => {
      const r = await aio.monitor.saveLog(monitorId);
      setMsg({ ok: true, text: `모니터 폴더에 적었습니다: ${baseName(r.txt)}${r.png ? ` · ${baseName(r.png)}` : ""}` });
    });

  return (
    <div className={`monitor-popup ${found ? "found" : ""}`}>
      <header className="tw-head">
        <span>📊</span>
        <span className="tw-title">{SITES[def.site].name} - {def.name}</span>
        <span className="grow" />
        <span className={`pill mon ${state.status}`}>{MONITOR_DOT[state.status]} {MONITOR_STATUS_LABEL[state.status]}</span>
      </header>

      {found && (
        <section className="found-panel">
          <div className="found-big">🎯 재고 발견!</div>
          <div>{SITES[def.site].name} - {def.name}</div>
          <div className="muted">발견 시간: {clockOf(state.foundAt)}</div>
          <div className="account-actions">
            {def.onFound === "switch_to_task" && (
              <button
                type="button" className="btn buy" disabled={busy}
                onClick={() => void act(async () => {
                  const taskId = await switchMonitor(entry, profiles);
                  if (taskId) setMsg({ ok: true, text: "구매 태스크로 전환했습니다 — 메인 창의 태스크 목록에서 볼 수 있습니다." });
                })}
              >
                🛒 즉시 구매 전환
              </button>
            )}
            <button
              type="button" className="btn ghost"
              onClick={() => {
                setDismissed(state.foundAt ?? null);
                void aio.monitor.closePopup(monitorId);
              }}
            >
              알림만 받고 닫기
            </button>
          </div>
          <p className="muted small">
            {def.onFound === "switch_to_task"
              ? "누르면 모니터를 멈추고 같은 대상·같은 프로필로 지금 구매를 띄웁니다. 저절로 전환하지는 않습니다."
              : "알림만 보내는 모니터입니다 — 모니터는 계속 봅니다. 사려면 태스크를 만드세요."}
          </p>
        </section>
      )}

      <section className="tw-state">
        <div className="tw-cells">
          <div className={`tw-cell mon-state ${state.status}`}>
            <div className="l">상태</div>
            <div className="v">{MONITOR_DOT[state.status]} {MONITOR_STATUS_LABEL[state.status]}</div>
          </div>
          <div className="tw-cell">
            <div className="l">체크 · 간격</div>
            <div className="v">#{state.checkCount}회 <span className="muted small">· {span(def.checkIntervalMs)}</span></div>
          </div>
          <div className="tw-cell">
            <div className="l">경과</div>
            <div className="v mono">{live ? elapsed(state.startedAt, now) : "—"}</div>
            <div className="muted small">시작 {clockOf(state.startedAt)}</div>
          </div>
          <div className="tw-cell">
            <div className="l">마지막 확인</div>
            <div className="v">{agoOf(state.lastCheckAt, now)}</div>
          </div>
          <div className="tw-cell">
            <div className="l">재고</div>
            <div className="v">{state.stock ?? "—"}</div>
          </div>
        </div>
        {live && state.note && <div className="tw-note" title="원본이 기다리는 동안 제자리에서 고쳐 쓰는 줄">{state.note}</div>}
        {state.status === "paused" && <p className="tw-hint">일시정지 중입니다 — 재개하면 이어서 봅니다. 그 사이에 풀린 재입고는 놓칠 수 있습니다.</p>}
        {state.status === "error" && state.lastResult && <p className="err small">{state.lastResult}</p>}
      </section>

      <section className="mon-target-box">
        <div className="l muted small">대상 정보</div>
        <div>제품: <b>{def.name}</b> <span className="muted small">{SITES[def.site].productCode(def.productUrl)}</span></div>
        <div>옵션: {def.option || <span className="muted">없음</span>} · 수량 {def.ea}</div>
        <div>상한가: {def.maxPrice ? `${def.maxPrice.toLocaleString()}원` : <span className="muted">무제한</span>}</div>
        <div className="muted small">
          {def.restockOnly ? "재입고 순간에만 발견" : "지금 팔고 있어도 발견"} · 발견 시 {ON_FOUND_LABEL[def.onFound]} · 프로필{" "}
          {profile ? `${profile.name} (${LOGIN_LABEL[profile.loginStatus]})` : def.profileId ? "지워짐" : "없음"}
        </div>
      </section>

      <section className="tw-logs">
        <div className="logs-head">
          <span>
            📋 실시간 로그 <span className="muted">· {shown.length}줄{frozen ? ` · 멈춘 뒤 ${logs.filter((l) => l.seq > (frozen.at(-1)?.seq ?? 0)).length}줄 더 옴` : ""}</span>
          </span>
        </div>
        <LogView lines={shown} />
      </section>

      <footer className="tw-foot">
        {(state.status === "monitoring" || state.status === "found") && (
          <button type="button" className="btn small" disabled={busy} onClick={() => void act(() => aio.monitor.pause(monitorId))}>⏸ 일시정지</button>
        )}
        {state.status === "paused" && (
          <button type="button" className="btn small go" disabled={busy} onClick={() => void act(() => aio.monitor.resume(monitorId))}>▶ 재개</button>
        )}
        {!live && state.status !== "paused" && (
          <button type="button" className="btn small go" disabled={busy} onClick={() => void act(() => aio.monitor.start(monitorId))}>▶ 시작</button>
        )}
        <button type="button" className="btn small" disabled={busy} onClick={() => void saveLog()} title="로그(텍스트)와 이 창의 모습(PNG)을 모니터 폴더에 적습니다">📸 로그 저장</button>
        {(live || state.status === "paused") && (
          <button type="button" className="btn small stop" disabled={busy && state.status !== "stopping"} onClick={() => void act(() => aio.monitor.stop(monitorId))}>
            {state.status === "stopping" ? "강제" : "⏹ 중지"}
          </button>
        )}
        <button type="button" className="btn small ghost" onClick={() => setFrozen(frozen ? null : logs)} title="로그 보기만 멈춥니다 (모니터는 계속 봅니다)">
          {frozen ? "로그 이어 보기" : "로그 멈춰 보기"}
        </button>
        {msg && <span className={`small ${msg.ok ? "ok" : "err"}`}>{msg.text}</span>}
      </footer>
    </div>
  );
}
