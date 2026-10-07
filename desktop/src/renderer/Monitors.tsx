/**
 * 모니터 화면 — 사지 않고 재고만 보는 모니터의 목록, 만들기·고치기 폼, 메인 창의 재고 발견 알림.
 * 사이드바의 "모니터". 모니터 창(팝업)은 MonitorPopup.tsx.
 */
import { useState, type ReactNode } from "react";
import {
  MONITOR_MIN_INTERVAL_MS, MONITOR_RUNNING, MONITOR_STATUS_LABEL, monitorIntervalWarning, monitorProblem, ON_FOUND_LABEL,
} from "../shared/monitors";
import { SITE_IDS, SITES, siteOfUrl } from "../shared/sites";
import type { MonitorEntry, MonitorFound, MonitorInput, MonitorStatus, Profile, SiteId, SiteInfo } from "../shared/types";
import { errText, LOGIN_LABEL, SiteTag, span, when } from "./App";

const aio = window.aio;

/** 메인 창 로그 패널이 모니터의 로그를 보일 때의 이름 (태스크 id 와 섞이지 않게). */
export const MONITOR_LOG = "__monitor__:";
export const monitorLog = (id: string): string => `${MONITOR_LOG}${id}`;

/** 목록·창 제목 앞의 표시. */
export const MONITOR_DOT: Record<MonitorStatus, string> = {
  idle: "⚪", monitoring: "🟢", found: "🔴", paused: "⏸", stopping: "🟡", stopped: "⚪", error: "⚠️",
};

/** 17:30:12 */
export function clockOf(iso: string | undefined): string {
  return iso ? new Date(iso).toTimeString().slice(0, 8) : "—";
}

/** 3초 전 · 2분 5초 전 */
export function agoOf(iso: string | undefined, now: number): string {
  if (!iso) return "—";
  const sec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return sec < 60 ? `${sec}초 전` : `${Math.floor(sec / 60)}분 ${sec % 60}초 전`;
}

/**
 * 모니터를 지금 구매 태스크로 넘긴다. 사람이 눌렀을 때만 — 한 번 더 묻는다 (오작동 방지).
 * → 만든 태스크 id (그만뒀거나 실패하면 null. 실패는 alert 로 알린다)
 */
export async function switchMonitor(entry: MonitorEntry, profiles: Profile[]): Promise<string | null> {
  const { def } = entry;
  const profile = profiles.find((p) => p.id === def.profileId);
  const who = profile ? `'${profile.name}' 프로필` : "고른 프로필";
  if (!confirm(`'${def.name}' 을(를) 지금 구매 태스크로 전환할까요?\n모니터는 멈추고, ${who}로 바로 구매를 시작합니다.`)) return null;
  try {
    return (await aio.monitor.switchToTask(def.id)).taskId;
  } catch (e) {
    alert(errText(e));
    return null;
  }
}

// ── 메인 창의 재고 발견 알림 ─────────────────────────────────────────────────

/** 모니터 창이 닫혀 있어도 메인 창 위에 뜬다. 닫기는 알림만 치운다 — 모니터는 계속 돈다. */
export function FoundAlerts({ alerts, monitors, profiles, onSwitched, onDismiss }: {
  alerts: MonitorFound[]; monitors: MonitorEntry[]; profiles: Profile[];
  onSwitched: (monitorId: string, taskId: string) => void; onDismiss: (monitorId: string) => void;
}) {
  if (!alerts.length) return null;
  return (
    <div className="found-alerts">
      {alerts.map((f) => {
        const entry = monitors.find((m) => m.def.id === f.monitorId);
        return (
          <div key={f.monitorId} className="found-alert">
            <span className="found-bell">🔔</span>
            <div className="grow">
              <b>재고 발견!</b> <span className="muted">{SITES[f.site].name}</span> — {f.name}
              <span className="muted"> | {clockOf(f.at)}</span>
            </div>
            <button type="button" className="btn small" onClick={() => void aio.monitor.openPopup(f.monitorId)}>🖥 팝업</button>
            {f.onFound === "switch_to_task" && entry && (
              <button
                type="button" className="btn small buy"
                onClick={async () => {
                  const taskId = await switchMonitor(entry, profiles);
                  if (taskId) onSwitched(f.monitorId, taskId);
                }}
              >
                🛒 구매 전환
              </button>
            )}
            <button type="button" className="btn small ghost" onClick={() => onDismiss(f.monitorId)}>닫기</button>
          </div>
        );
      })}
    </div>
  );
}

// ── 모니터 목록 ─────────────────────────────────────────────────────────────

export function MonitorsPage({ monitors, profiles, infos, selected, now, onSelect, onChanged, onUpsert, onSwitched }: {
  monitors: MonitorEntry[]; profiles: Profile[]; infos: SiteInfo[]; selected: string | null; now: number;
  onSelect: (logId: string) => void;
  /** 지웠다 — 새 목록. */
  onChanged: (list: MonitorEntry[]) => void;
  onUpsert: (entry: MonitorEntry) => void;
  onSwitched: (monitorId: string, taskId: string) => void;
}) {
  const [editing, setEditing] = useState<MonitorEntry | "new" | null>(null);
  const running = monitors.filter((m) => MONITOR_RUNNING.includes(m.state.status));
  const rest = monitors.filter((m) => !MONITOR_RUNNING.includes(m.state.status));
  const card = (m: MonitorEntry) => (
    <MonitorCard
      key={m.def.id} entry={m} profiles={profiles} now={now} selected={selected === monitorLog(m.def.id)}
      onSelect={() => onSelect(monitorLog(m.def.id))} onEdit={() => setEditing(m)}
      onChanged={onChanged} onUpsert={onUpsert} onSwitched={onSwitched}
    />
  );
  return (
    <section className="monitors-page">
      <div className="page-head">
        <h2>모니터</h2>
        <span className="muted small">사지 않고 재고만 봅니다 — 발견하면 알리고, 원하면 구매 태스크로 넘깁니다.</span>
        <span className="grow" />
        <button type="button" className="btn primary" onClick={() => setEditing("new")}>+ 새 모니터</button>
      </div>
      <div className="group-head"><b>실행 중</b> <span className="muted">{running.length}개</span></div>
      <div className="monitor-cards">
        {running.map(card)}
        {!running.length && <div className="empty-card muted">돌고 있는 모니터가 없습니다.</div>}
      </div>
      <div className="group-head"><b>중지됨</b> <span className="muted">{rest.length}개</span></div>
      <div className="monitor-cards">
        {rest.map(card)}
        {!rest.length && !monitors.length && <div className="empty-card muted">모니터가 없습니다 — <b>+ 새 모니터</b> 로 만드세요.</div>}
      </div>
      {editing && (
        <MonitorForm
          initial={editing === "new" ? null : editing} profiles={profiles} infos={infos}
          onSaved={(e) => {
            onUpsert(e);
            setEditing(null);
            onSelect(monitorLog(e.def.id));
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function MonitorCard({ entry, profiles, now, selected, onSelect, onEdit, onChanged, onUpsert, onSwitched }: {
  entry: MonitorEntry; profiles: Profile[]; now: number; selected: boolean;
  onSelect: () => void; onEdit: () => void;
  onChanged: (list: MonitorEntry[]) => void; onUpsert: (e: MonitorEntry) => void; onSwitched: (monitorId: string, taskId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const { def, state } = entry;
  const profile = profiles.find((p) => p.id === def.profileId);
  const live = MONITOR_RUNNING.includes(state.status);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setFail(null);
    try {
      await fn();
    } catch (e) {
      setFail(errText(e));
    } finally {
      setBusy(false);
    }
  };

  let line: ReactNode;
  if (state.status === "found") {
    line = <span className="found-text">재고 발견! {clockOf(state.foundAt)} <span className="muted">· 체크 #{state.checkCount} · 계속 봅니다</span></span>;
  } else if (state.status === "monitoring" || state.status === "stopping") {
    line = <>체크 #{state.checkCount} | {state.lastCheckAt ? agoOf(state.lastCheckAt, now) : "첫 확인 전"} | 재고: {state.stock ?? "—"}</>;
  } else if (state.status === "paused") {
    line = <>일시정지 · 체크 #{state.checkCount} <span className="muted">· 재개하면 이어서 봅니다 (그 사이에 풀린 재입고는 놓칠 수 있습니다)</span></>;
  } else if (state.status === "error") {
    line = <span className="err">{state.lastResult ?? "오류"}</span>;
  } else {
    line = <>마지막 체크 #{state.checkCount} | {MONITOR_STATUS_LABEL[state.status]}{state.foundAt && <span className="muted"> · 마지막 발견 {when(state.foundAt)}</span>}</>;
  }

  return (
    <div className={`monitor-card ${state.status} ${selected ? "sel" : ""}`} onClick={onSelect}>
      <div className="card-top">
        <span>{MONITOR_DOT[state.status]}</span>
        <SiteTag site={def.site} />
        <b className="grow">{def.name}</b>
        <span className={`pill mon ${state.status}`}>{MONITOR_STATUS_LABEL[state.status]}</span>
      </div>
      <div className="small">{line}</div>
      {live && state.note && <div className="mon-note small" title="원본이 기다리는 동안 제자리에서 고쳐 쓰는 줄">{state.note}</div>}
      <div className="muted small">
        {span(def.checkIntervalMs)}마다 · {def.restockOnly ? "재입고 순간만" : "지금 팔고 있어도"} 발견 · 발견 시 {ON_FOUND_LABEL[def.onFound]}
        {" · "}프로필 {profile ? profile.name : def.profileId ? "지워짐" : "없음"}
      </div>
      <div className="account-actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn small" onClick={() => void aio.monitor.openPopup(def.id)}>🖥 팝업</button>
        {state.status === "found" && def.onFound === "switch_to_task" && (
          <button
            type="button" className="btn small buy" disabled={busy}
            onClick={() => void act(async () => {
              const taskId = await switchMonitor(entry, profiles);
              if (taskId) onSwitched(def.id, taskId);
            })}
          >
            🛒 구매 전환
          </button>
        )}
        {(state.status === "monitoring" || state.status === "found") && (
          <>
            <button type="button" className="btn small" disabled={busy} onClick={() => void act(() => aio.monitor.pause(def.id))}>⏸ 일시정지</button>
            <button type="button" className="btn small stop" disabled={busy} onClick={() => void act(() => aio.monitor.stop(def.id))}>⏹ 중지</button>
          </>
        )}
        {state.status === "stopping" && (
          <button type="button" className="btn small stop" title="강제로 끝냅니다" onClick={() => void act(() => aio.monitor.stop(def.id))}>강제</button>
        )}
        {state.status === "paused" && (
          <>
            <button type="button" className="btn small go" disabled={busy} onClick={() => void act(async () => onUpsert(await aio.monitor.start(def.id)))}>▶ 재개</button>
            <button type="button" className="btn small stop" disabled={busy} onClick={() => void act(() => aio.monitor.stop(def.id))}>⏹ 중지</button>
          </>
        )}
        {!live && state.status !== "paused" && (
          <button type="button" className="btn small go" disabled={busy} onClick={() => void act(async () => onUpsert(await aio.monitor.start(def.id)))}>▶ 시작</button>
        )}
        <span className="grow" />
        <button type="button" className="icon" title={live ? "고치기 — 저장하면 바뀐 설정으로 다시 띄웁니다" : "고치기"} disabled={state.status === "stopping"} onClick={onEdit}>✎</button>
        <button
          type="button" className="icon" title="지우기" disabled={busy}
          onClick={() => {
            if (!confirm(`'${def.name}' 모니터를 지울까요?${live ? " 돌고 있으면 멈춥니다." : ""} 모니터 폴더와 로그도 지워집니다.`)) return;
            void act(async () => onChanged(await aio.monitor.delete(def.id)));
          }}
        >
          ✕
        </button>
      </div>
      {fail && <span className="err small">{fail}</span>}
    </div>
  );
}

// ── 만들기 · 고치기 폼 ──────────────────────────────────────────────────────

/** 간격을 비워 둘 때 — 롯데는 씨앗 하한(드랍 걸음이 아니게), 네이버는 권장선 안쪽. */
const DEFAULT_INTERVAL_MS: Record<SiteId, number> = { lotte: 5000, naver: 10000 };

function blankInput(site: SiteId, profiles: Profile[]): MonitorInput {
  const mine = profiles.filter((p) => p.site === site && p.isActive);
  const profileId = (mine.find((p) => p.loginStatus === "logged_in") ?? mine[0])?.id;
  return {
    site, name: "", productUrl: "", option: "", ea: 1, maxPrice: 0, checkIntervalMs: DEFAULT_INTERVAL_MS[site],
    ...(profileId && site === "naver" ? { profileId } : {}), restockOnly: true, onFound: "notify",
  };
}

function MonitorForm({ initial, profiles, infos, onSaved, onCancel }: {
  initial: MonitorEntry | null; profiles: Profile[]; infos: SiteInfo[];
  onSaved: (e: MonitorEntry) => void; onCancel: () => void;
}) {
  const [m, setM] = useState<MonitorInput>(() => {
    if (!initial) return blankInput("lotte", profiles);
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = initial.def;
    return rest;
  });
  const [saving, setSaving] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const set = <K extends keyof MonitorInput>(k: K, v: MonitorInput[K]) => setM((prev) => ({ ...prev, [k]: v }));
  const setProfile = (id: string) =>
    setM((prev) => {
      const { profileId: _old, ...rest } = prev;
      return id ? { ...rest, profileId: id } : rest;
    });
  const setSite = (site: SiteId) => {
    if (initial) return; // 모니터 폴더의 설정 파일 이름이 사이트마다 달라 고칠 때는 못 바꾼다
    setM((prev) => ({ ...blankInput(site, profiles), name: prev.name, productUrl: prev.productUrl, option: prev.option, ea: prev.ea, maxPrice: prev.maxPrice }));
  };
  const setUrl = (url: string) => {
    const guessed = siteOfUrl(url);
    if (!initial && guessed && guessed !== m.site) setSite(guessed);
    set("productUrl", url);
  };

  const spec = SITES[m.site];
  const info = infos.find((i) => i.site === m.site);
  const mine = profiles.filter((p) => p.site === m.site);
  const picked = mine.find((p) => p.id === m.profileId);
  const problem = monitorProblem(m);
  const warning = info ? monitorIntervalWarning(m.site, m.checkIntervalMs, info.timing) : null;
  const needProfileForSwitch = m.onFound === "switch_to_task" && !m.profileId;
  const minSec = MONITOR_MIN_INTERVAL_MS[m.site] / 1000;

  return (
    <div className="modal-back" onClick={onCancel}>
      <form
        className="modal wide"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (problem) return;
          setSaving(true);
          setFail(null);
          try {
            onSaved(initial ? await aio.monitor.update(initial.def.id, m) : await aio.monitor.create(m));
          } catch (err) {
            setFail(errText(err));
          } finally {
            setSaving(false);
          }
        }}
      >
        <h2>{initial ? "모니터 고치기" : "새 모니터"}</h2>
        {initial && MONITOR_RUNNING.includes(initial.state.status) && (
          <p className="hint live">돌고 있는 모니터입니다. 저장하면 바뀐 설정으로 다시 띄웁니다 (체크 횟수는 이어서 셉니다).</p>
        )}
        <div className="segmented">
          {SITE_IDS.map((id) => (
            <button
              key={id} type="button" className={`${id} ${m.site === id ? "on" : ""}`} onClick={() => setSite(id)}
              disabled={!!initial && id !== m.site} title={initial && id !== m.site ? "모니터의 사이트는 바꿀 수 없습니다 — 새 모니터를 만드세요" : undefined}
            >
              {SITES[id].name}
            </button>
          ))}
        </div>
        <label>
          이름 <span className="muted">(비워 두면 상품번호)</span>
          <input autoFocus value={m.name} placeholder="후드티 블랙" onChange={(e) => set("name", e.target.value)} />
        </label>

        <fieldset className="timing">
          <legend>대상 설정 <span className="muted">— 원본 설정의 대상 한 줄로 적습니다</span></legend>
          <label>
            제품 URL
            <input value={m.productUrl} placeholder={spec.placeholder} onChange={(e) => setUrl(e.target.value)} />
            {m.productUrl && !spec.isProductUrl(m.productUrl) && <span className="err">{spec.urlError}</span>}
          </label>
          <div className="row">
            <label>
              옵션 <span className="muted">(글자 일부)</span>
              <input value={m.option} placeholder={m.site === "lotte" ? "블랙 / 270" : "270"} onChange={(e) => set("option", e.target.value)} />
            </label>
            <label className="narrow">
              수량
              <input type="number" min={1} value={m.ea} onChange={(e) => set("ea", Math.max(1, Math.trunc(Number(e.target.value)) || 1))} />
            </label>
            <label>
              상한가 <span className="muted">(비워 두면 무제한)</span>
              <input
                type="number" min={0} value={m.maxPrice || ""} placeholder="무제한"
                onChange={(e) => set("maxPrice", Math.max(0, Math.trunc(Number(e.target.value)) || 0))}
              />
            </label>
          </div>
          <p className="muted small">
            {m.site === "lotte"
              ? "롯데는 주소의 단품(sitmNo)으로 재고를 봅니다 — 옵션 글자는 구매로 전환했을 때 고르는 데 씁니다. 상한가를 넘으면 발견으로 보지 않습니다."
              : "네이버는 옵션 재고까지 봅니다 — 옵션을 적으면 그 옵션이 풀려야 발견입니다. 상한가를 넘으면 발견으로 보지 않습니다."}
          </p>
        </fieldset>

        <fieldset className="timing">
          <legend>모니터링 설정</legend>
          <div className="row">
            <label>
              체크 간격 (초)
              <input
                type="number" min={minSec} step={m.site === "naver" ? 1 : 0.5} value={m.checkIntervalMs / 1000}
                onChange={(e) => set("checkIntervalMs", Math.round((Number(e.target.value) || 0) * 1000))}
              />
            </label>
            <label>
              로그인 프로필 <span className="muted">({m.site === "naver" ? "필수 — 네이버는 조회도 로그인 세션으로" : "선택 — 확인에는 필요 없고 구매 전환에 씀"})</span>
              <select value={m.profileId ?? ""} onChange={(e) => setProfile(e.target.value)}>
                <option value="">{m.site === "naver" ? "— 고르세요 —" : "없음"}</option>
                {mine.map((p) => <option key={p.id} value={p.id}>{p.name} ({LOGIN_LABEL[p.loginStatus]})</option>)}
              </select>
            </label>
          </div>
          {warning && <p className="warn-line small">⚠️ {warning}</p>}
          {SITES[m.site].oneTaskPerProfile && (
            <p className="muted small">{SITES[m.site].name}는 한 프로필로 태스크·모니터를 통틀어 하나만 돌립니다 (같은 로그인 세션).</p>
          )}
          {picked && picked.loginStatus !== "logged_in" && (
            <p className="warn-line small">⚠️ '{picked.name}' 은(는) {LOGIN_LABEL[picked.loginStatus]} 상태입니다 — 프로필 화면에서 로그인하세요.</p>
          )}
          <label className="check">
            <input type="checkbox" checked={m.restockOnly} onChange={(e) => set("restockOnly", e.target.checked)} />
            재입고 순간에만 감지
            <span className="muted small">— 체크 해제하면 현재 판매 중이어도 발견으로 처리합니다</span>
          </label>
        </fieldset>

        <fieldset className="timing">
          <legend>재고 발견 시</legend>
          <label className="check">
            <input type="radio" name="onFound" checked={m.onFound === "notify"} onChange={() => set("onFound", "notify")} />
            알림만 <span className="muted small">— 메인 창·모니터 창·디스코드로 알리고 계속 봅니다</span>
          </label>
          <label className="check">
            <input type="radio" name="onFound" checked={m.onFound === "switch_to_task"} onChange={() => set("onFound", "switch_to_task")} />
            구매 태스크로 전환 <span className="muted small">— 알리고 🛒 구매 전환 버튼을 띄웁니다. 누르면 모니터를 멈추고 같은 대상으로 지금 구매를 띄웁니다 (저절로 전환하지는 않습니다)</span>
          </label>
          {needProfileForSwitch && <p className="warn-line small">⚠️ 구매 전환을 하려면 로그인 프로필이 필요합니다.</p>}
        </fieldset>

        {problem && !needProfileForSwitch && m.productUrl && <p className="err small">{problem}</p>}
        {fail && <p className="err small">{fail}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>취소</button>
          <button type="submit" className="btn primary" disabled={!!problem || saving}>{initial ? "저장" : "➕ 추가"}</button>
        </div>
      </form>
    </div>
  );
}
