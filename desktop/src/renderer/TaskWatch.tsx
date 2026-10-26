/**
 * 태스크 창 — 태스크 하나의 상태와 로그. 메인 창 표의 🖥 로 연다 (태스크마다 창 하나, 여럿을 같이 연다).
 *
 * 화면(브라우저)은 없다. 원본이 띄우는 창은 이미 화면에 보인다 (롯데는 재고를 HTTP 로 보면서 크롬 창 하나를
 * 상품 페이지에 띄워 두고 — warm.ts — 네이버는 헤드리스 탭을 1초 열었다 닫는다). 여기서는 원본
 * 출력으로 알아본 것 — 단계·확인 회차·마지막 확인·원본의 상태 줄 — 과 로그를 보인다.
 */
import { useEffect, useState } from "react";
import { MODE_LABEL, REPEATING_MODES, SITES, siteOfUrl } from "../shared/sites";
import type { LogLine, Profile, QueuePeek, SiteInfo, TaskDef, TaskPhase, TaskRuntime, TaskStatus } from "../shared/types";
import {
  copyText, countdown, errText, idleRuntime, LIVE, LOGIN_LABEL, LogView, mergeLogs, SiteTag, span, STATUS_LABEL, targetText, uptime,
} from "./App";
import { isSupremeProductUrl } from "../shared/supremeSpec";

const aio = window.aio;

/** 태스크 창이 들고 있는 로그 줄. main 은 2000 줄을 들고 있지만 여기서는 최근 것만 본다. */
const KEEP = 1000;

/** 대기열 상태를 이만큼(ms) 못 받으면 줄에서 나온 것으로 보고 숨긴다. 원본은 로그에 10초마다 적는다. */
const QUEUE_STALE_MS = 15_000;

const PHASE_LABEL: Record<TaskPhase, string> = {
  watching: "확인 중",
  buying: "구매 중",
  checkout: "결제 단계",
  paid: "결제 완료",
};

/** 몇 초 전 · 몇 분 전 */
function ago(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec}초 전` : `${Math.floor(sec / 60)}분 ${sec % 60}초 전`;
}

/** 원본이 실제로 보는 간격. 비워 둔 칸은 씨앗 설정 (SiteInfo.timing). 한 번 돌고 끝나는 모드는 간격이 없다. */
function intervalOf(t: TaskDef, info: SiteInfo | undefined): string {
  if (!REPEATING_MODES.includes(t.mode)) return "한 번";
  if (t.mode === "drop") {
    const ms = t.dropSettings.intervalMs ?? info?.timing.drop?.intervalMs;
    return ms ? `드랍 ${span(ms)}` : "드랍";
  }
  const ms = t.checkIntervalMs ?? info?.timing.checkIntervalMs;
  if (!ms) return "—";
  return t.checkIntervalMs === null ? `${span(ms)} (씨앗)` : span(ms);
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * 상품 주소를 바꾸면 무엇이 되나. TaskManager.applyToLive 와 같은 규칙이다 (주소 하나만 바뀌는 경우).
 *   돌고 있지 않다             → 다음 실행부터
 *   한 번 돌고 끝나는 모드     → 이번 실행에는 반영하지 않는다 (다시 띄우면 한 번 더 산다)
 *   원본이 다시 읽는 칸 (롯데) → 바로 반영 — 원본이 다음 확인 때 읽는다
 *   그 밖 (네이버)             → 다시 시작 — 구매 중이거나 구매 창이 열려 있으면 그게 끝난 뒤에
 */
function linkChangeNote(task: TaskDef, status: TaskStatus, saved = false): string {
  if (status === "scheduled") return "예약된 태스크입니다 — 띄울 때 새 주소로 돕니다.";
  if (!LIVE.includes(status)) return "다음 실행부터 새 주소로 돕니다.";
  if (!REPEATING_MODES.includes(task.mode)) {
    return `한 번 돌고 끝나는 모드라 이번 실행에는 반영하지 ${saved ? "않았습니다" : "않습니다"} — 다음 실행부터 새 주소입니다.`;
  }
  if (SITES[task.site].liveFields.includes("url")) {
    return saved ? "바로 반영했습니다 — 원본이 다음 확인 때 새 주소를 읽습니다." : "저장하면 바로 반영됩니다 — 원본이 다음 확인 때 새 주소를 읽습니다.";
  }
  return `${saved ? "다시 시작합니다" : "저장하면 다시 시작합니다"} — 구매 중이거나 구매 창이 열려 있으면 그게 끝난 뒤에. 확인 회차·감시 시간은 이어서 셉니다.`;
}

/**
 * 상품 주소 — 보이고, 복사하고, 그 자리에서 고친다. 저장은 태스크 폼과 같은 saveTask 다 — 돌고 있으면 main 이
 * 바로 반영하거나(롯데) 다시 시작하고(네이버), 그 일을 태스크 로그에 적는다.
 */
/**
 * 줄이 빠지는 속도 어림(명/초)의 기본값. 2026-10-10 MEGA 30th — 09:54:26 에 앞 1,505명으로 서서 10:04 쯤 통과했다
 * (평균 약 2.6명/초). 화면이 쓰는 셈(limitCnt 200 ÷ 30초 = 6.7명/초)보다 훨씬 느리고, 오픈이 가까울수록 더 느려졌다
 * (09:31 4.2 → 09:54 3.5 → 09:58 0.7명/초 · 열린 뒤 3~5명/초).
 */
const DRAIN_DEFAULT = 2.5;
/** 켜고 나서 크롬이 떠 상품 페이지(대기 화면)에 서기까지 어림(초). */
const LAUNCH_SECONDS = 10;

/** 10:00:05 */
const hms = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

/**
 * 열리기 전 대기열 — 언제 태스크를 켤지 고르는 데 쓴다 (롯데). 켜면 main 이 10초마다 쿠키 없이 상품 페이지·상품 API 를
 * 읽는다. 줄에 서지 않는다. 창을 닫으면 꺼진다.
 *
 * 켤 때의 셈: 통과한 자리는 30초쯤만 남는다 (10/10 측정) — 원본은 열리는 순간 띄워 둔 창을 새로 고치므로, 그보다
 * 일찍 통과하면 다시 줄 맨 뒤로 간다. 그래서 "열리기 직전에 통과하거나 열린 뒤 통과" 가 되게 켠다:
 *   권장 켜는 시각 = 열리는 시각 − (줄 ÷ 빠지는 속도) − 크롬 뜨는 시간
 */
function QueueBox({ task, live, now }: { task: TaskDef; live: boolean; now: number }) {
  const [on, setOn] = useState(false);
  const [peeks, setPeeks] = useState<QueuePeek[]>([]);
  const [rate, setRate] = useState(DRAIN_DEFAULT);
  const [fail, setFail] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
    let alive = true;
    setFail(null);
    aio.watchQueue(task.id, true).then((h) => alive && setPeeks(h)).catch((e) => alive && setFail(errText(e)));
    const off = aio.onQueuePeek((p) => {
      if (p.taskId === task.id) setPeeks((prev) => [...prev, p].slice(-90));
    });
    return () => {
      alive = false;
      off();
      void aio.watchQueue(task.id, false).catch(() => undefined);
    };
  }, [on, task.id]);

  const last = peeks.at(-1);
  // 1분 전과 비교한 줄의 변화 — 길어지는지 줄어드는지.
  const before = last ? [...peeks].reverse().find((p) => last.at - p.at >= 55_000 && !p.error) : undefined;
  const trend = last && before && last.waiting ? last.count - before.count : null;
  const wait = last?.waiting && rate > 0 ? Math.round(last.count / rate) : null;
  const startAt = last?.opensAt && wait !== null ? last.opensAt - (wait + LAUNCH_SECONDS) * 1000 : null;

  return (
    <div className="tw-queue">
      <div className="tw-link-row">
        <span className="muted">열리기 전 대기열</span>
        {on && last && !last.error && (
          <span className="muted small">{hms(last.at)} 기준 · {Math.max(0, Math.round((now - last.at) / 1000))}초 전</span>
        )}
        <span className="grow" />
        <button
          type="button" className={`btn small ${on ? "ghost" : ""}`} onClick={() => setOn(!on)}
          title="쿠키 없이 상품 페이지를 10초마다 읽습니다 — 줄에 서지 않습니다. 창을 닫으면 꺼집니다"
        >{on ? "그만 보기" : "대기열 보기"}</button>
      </div>
      {fail && <p className="err small">{fail}</p>}
      {on && !last && !fail && <p className="muted small">읽는 중…</p>}
      {on && last?.error && <p className="err small">{last.error} — 10초 뒤 다시 읽습니다.</p>}
      {on && last && !last.error && (
        <>
          <div className="tw-cells">
            <div className="tw-cell">
              <div className="l">줄</div>
              <div className="v">
                {last.waiting ? `${last.count.toLocaleString()}명` : "없음"}
                {trend !== null && <span className={`small ${trend > 0 ? "warn-text" : "muted"}`}> · 1분에 {trend > 0 ? "+" : ""}{trend.toLocaleString()}</span>}
              </div>
            </div>
            <div className="tw-cell">
              <div className="l">열리는 시각</div>
              <div className="v">
                {last.opensAt ? <>{hms(last.opensAt)} <span className="muted small">· {countdown(last.opensAt - now)} 뒤</span></> : <span className="muted">모름</span>}
              </div>
            </div>
            <div className="tw-cell">
              <div className="l">지금 서면 기다릴 어림</div>
              <div className="v">{wait !== null ? countdown(wait * 1000) : "—"}</div>
            </div>
            <div className={`tw-cell ${startAt !== null && startAt <= now ? "phase buying" : ""}`}>
              <div className="l">권장 켜는 시각</div>
              <div className="v">
                {startAt === null ? "—"
                  : startAt > now ? <>{hms(startAt)} <span className="muted small">· {countdown(startAt - now)} 뒤</span></>
                  : <>지금 켜세요 <span className="muted small">· {hms(startAt)} 지남</span></>}
              </div>
            </div>
          </div>
          <div className="tw-link-row small">
            <span className="muted">줄이 빠지는 속도 어림</span>
            <input
              className="tw-rate" type="number" min={0.5} step={0.5} value={rate}
              onChange={(e) => setRate(Math.max(0.5, Number(e.target.value) || DRAIN_DEFAULT))}
            />
            <span className="muted">명/초 · 화면의 셈은 {last.waiting && last.limit ? `${(last.limit / Math.max(1, last.session)).toFixed(1)}명/초 (예상 ${last.pageEta}초)` : "—"}</span>
          </div>
          {!last.waiting && (
            <p className="tw-hint live">지금은 대기열이 없습니다 — 서면 바로 상품 페이지가 뜹니다. 열리기 직전에 켜도 됩니다 (줄은 열리기 전에 갑자기 설 수 있으니 계속 보세요).</p>
          )}
          {last.waiting && !last.opensAt && (
            <p className="tw-hint">열리는 시각을 모릅니다 (이미 판매 중이거나 상품 정보에 시각이 없습니다) — 권장 켜는 시각은 셈하지 않습니다.</p>
          )}
          {live && <p className="tw-hint live">태스크가 이미 돌고 있습니다 — 줄 선 자리는 위의 "대기열" 칸에 보입니다. 이 칸은 줄 전체입니다.</p>}
          <p className="muted small">
            통과한 자리는 30초쯤만 남습니다 — 일찍 통과하면 열릴 때 다시 줄 맨 뒤로 갑니다. 열리기 직전 30초 안이나 열린 뒤에 통과하게
            켜세요. 오픈이 가까울수록 줄이 느리게 빠지니 어림 속도를 낮게 잡는 쪽이 안전합니다 (10/10: 09:31 초당 4.2명 → 09:58 0.7명).
          </p>
        </>
      )}
    </div>
  );
}

function LinkBox({ task, status }: { task: TaskDef; status: TaskStatus }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const spec = SITES[task.site];
  const draft = editing?.trim() ?? "";
  const error = editing === null || !draft ? null
    : siteOfUrl(draft) && siteOfUrl(draft) !== task.site
      ? `${SITES[siteOfUrl(draft)!].name} 주소입니다 — 사이트는 바꿀 수 없습니다 (새 태스크로 만드세요).`
      : spec.isProductUrl(draft) ? null : spec.urlError;
  const changed = editing !== null && draft !== task.url.trim();

  const save = async () => {
    if (!draft || error || !changed) return;
    setBusy(true);
    setMsg(null);
    try {
      await aio.saveTask({ ...task, url: draft });
      setEditing(null);
      setMsg({ ok: true, text: `주소를 바꿨습니다. ${linkChangeNote(task, status, true)}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => setMsg((await copyText(task.url.trim()))
    ? { ok: true, text: "주소를 복사했습니다." }
    : { ok: false, text: "복사하지 못했습니다." });

  return (
    <div className="tw-link">
      <div className="tw-link-row">
        <span className="muted">{task.site === "supreme" && !isSupremeProductUrl(task.url) ? "키워드" : "상품 주소"}</span>
        {editing === null ? (
          <>
            <span className="tw-link-url mono" title={task.url}>{task.url}</span>
            <button type="button" className="btn small ghost" onClick={() => void copy()}>복사</button>
            <button
              type="button" className="btn small" disabled={status === "stopping"}
              title={status === "stopping" ? "멈추는 중에는 고칠 수 없습니다" : undefined}
              onClick={() => {
                setMsg(null);
                setEditing(task.url);
              }}
            >고치기</button>
          </>
        ) : (
          <>
            <input
              className="tw-link-input mono" autoFocus value={editing} placeholder={spec.placeholder}
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                else if (e.key === "Escape") setEditing(null);
              }}
            />
            <button type="button" className="btn small primary" disabled={busy || !!error || !draft || !changed} onClick={() => void save()}>저장</button>
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => setEditing(null)}>취소</button>
          </>
        )}
      </div>
      {editing !== null && (error ? <p className="err small">{error}</p> : <p className="tw-hint live">{linkChangeNote(task, status)}</p>)}
      {msg && editing === null && <p className={`small ${msg.ok ? "ok" : "err"}`}>{msg.text}</p>}
    </div>
  );
}

export function TaskWatch({ taskId }: { taskId: string }) {
  const [tasks, setTasks] = useState<TaskDef[]>([]);
  const [rt, setRt] = useState<TaskRuntime>(idleRuntime(taskId));
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [infos, setInfos] = useState<SiteInfo[]>([]);
  /** 일시정지하면 그때의 줄을 붙잡아 보인다. 로그는 그동안에도 계속 받는다. */
  const [frozen, setFrozen] = useState<LogLine[] | null>(null);
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [now, setNow] = useState(Date.now());
  /** 상품 이름 (productKey → 이름) — 이름을 안 붙인 태스크는 상품번호 대신 이것을. */
  const [productNames, setProductNames] = useState<Record<string, string>>({});

  useEffect(() => {
    void aio.listTasks().then(setTasks);
    void aio.productNames().then(setProductNames);
    void aio.runtimes().then((list) => {
      const mine = list.find((r) => r.id === taskId);
      if (mine) setRt(mine);
    });
    void aio.listProfiles().then(setProfiles);
    void aio.sitesInfo().then(setInfos);
    // 받아 오는 사이에 흘러온 줄이 이미 붙어 있을 수 있다. 번호로 이어 붙인다.
    void aio.logs(taskId).then((list) => setLogs((streamed) => mergeLogs(list, streamed).slice(-KEEP)));
    const offs = [
      aio.onTasks(setTasks),
      aio.onProductNames(setProductNames),
      aio.onRuntime((r) => {
        if (r.id === taskId) setRt(r);
      }),
      aio.onProfile((p) => setProfiles((prev) => (prev.some((one) => one.id === p.id) ? prev.map((one) => (one.id === p.id ? p : one)) : [...prev, p]))),
      aio.onLogs((batch) => {
        const mine = batch.filter((l) => l.taskId === taskId);
        if (mine.length) setLogs((prev) => mergeLogs(prev, mine).slice(-KEEP));
      }),
    ];
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      for (const off of offs) off();
      clearInterval(tick);
    };
  }, [taskId]);

  const at = tasks.findIndex((t) => t.id === taskId);
  const task = tasks[at];
  const no = String(at + 1).padStart(2, "0");
  const name = task ? targetText(task, productNames).name : "";

  useEffect(() => {
    if (task) document.title = `태스크 창 — #${no} ${name} (${MODE_LABEL[task.mode]})`;
  }, [task, no, name]);

  if (!task) {
    return <div className="task-watch"><div className="empty">{tasks.length ? "태스크가 지워졌습니다." : "불러오는 중…"}</div></div>;
  }

  const info = infos.find((i) => i.site === task.site);
  const profile = profiles.find((p) => p.id === task.profileId);
  const live = LIVE.includes(rt.status);
  const phase = live ? rt.phase : null;
  const headline = phase
    ? `${PHASE_LABEL[phase]}${phase === "watching" && rt.rounds ? ` (#${rt.rounds})` : ""}`
    : rt.status === "scheduled" && rt.scheduledFor
      ? `예약 · ${countdown(rt.scheduledFor - now)} 뒤`
      : STATUS_LABEL[rt.status];
  // 원본이 몇 초마다 한 번 말해 주니, 그 사이는 받은 시각부터 줄여 보인다. 오래 말이 없으면 숨긴다.
  const queueShown = live && rt.queue !== null && now - rt.queue.at < QUEUE_STALE_MS;
  const queueLeft = queueShown && rt.queue!.eta !== null ? Math.max(0, rt.queue!.eta - Math.floor((now - rt.queue!.at) / 1000)) : null;
  const what = targetText(task, productNames);
  const target = [
    name,
    task.site === "supreme" ? what.sub : task.option && `옵션 ${task.option}`,
    `×${task.ea}`,
    task.max_price ? `상한가 ${task.max_price.toLocaleString()}원` : "상한가 없음",
  ].filter(Boolean).join(" / ");
  const shown = frozen ?? logs;

  const capture = async () => {
    setCapturing(true);
    setSaved(null);
    try {
      const r = await aio.captureTaskWatch(taskId);
      setSaved({ ok: true, text: `태스크 폴더에 적었습니다: ${baseName(r.png)} · ${baseName(r.txt)}` });
    } catch (e) {
      setSaved({ ok: false, text: errText(e) });
    } finally {
      setCapturing(false);
    }
  };

  const reset = async () => {
    if (!(await aio.ask("이 태스크의 산 기록·쉬는 기록을 지울까요? (원본의 --reset)\n다음 실행에서 쉬지 않고 바로 다시 보고, 산 것도 다시 삽니다."))) return;
    setSaved(null);
    try {
      await aio.resetState(taskId);
      setSaved({ ok: true, text: "기록을 지웠습니다 — 다음 실행부터 적용됩니다" });
    } catch (e) {
      setSaved({ ok: false, text: errText(e) });
    }
  };

  return (
    <div className="task-watch">
      <header className="tw-head">
        <SiteTag site={task.site} />
        <span className="tw-title">#{no} {name}</span>
        <span className="muted">{MODE_LABEL[task.mode]}</span>
        <span className="grow" />
        <span className={`pill ${rt.status}`}>{STATUS_LABEL[rt.status]}</span>
      </header>

      <section className="tw-state">
        <div className="tw-cells">
          <div className={`tw-cell phase ${phase ?? ""}`}>
            <div className="l">상태</div>
            <div className="v">{headline}</div>
          </div>
          {queueShown && (
            <div className="tw-cell phase queue">
              <div className="l">대기열</div>
              <div className="v" title={`내 앞 ${rt.queue!.ahead.toLocaleString()}명${rt.queue!.total ? ` · 줄 ${rt.queue!.total.toLocaleString()}명` : ""}`}>
                {queueLeft === null ? `내 앞 ${rt.queue!.ahead.toLocaleString()}명` : `남은 약 ${countdown(queueLeft * 1000)}`}
                {queueLeft !== null && <span className="muted small"> · 앞 {rt.queue!.ahead.toLocaleString()}명</span>}
              </div>
            </div>
          )}
          <div className="tw-cell">
            <div className="l">간격</div>
            <div className="v">{intervalOf(task, info)}</div>
          </div>
          <div className="tw-cell">
            <div className="l">경과</div>
            <div className="v mono">
              {uptime(rt, now)}
              {task.monitorDurationMs > 0 && REPEATING_MODES.includes(task.mode) && <span className="muted"> / {span(task.monitorDurationMs)}</span>}
            </div>
          </div>
          <div className="tw-cell">
            <div className="l">마지막 확인</div>
            <div className="v">{rt.lastCheckAt ? ago(now - rt.lastCheckAt) : "—"}{rt.rounds > 0 && <span className="muted small"> · {rt.rounds}번</span>}</div>
          </div>
          <div className="tw-cell">
            <div className="l">프로필</div>
            <div className="v">
              {profile ? (
                <span title={`${LOGIN_LABEL[profile.loginStatus]} — ${profile.statusNote}`}>
                  <span className={`login-dot ${profile.loginStatus}`} />{profile.name}
                </span>
              ) : <span className="muted">{task.profileId ? "지워짐" : "없음"}</span>}
            </div>
          </div>
        </div>
        <div className="tw-target"><span className="muted">대상</span> {target}</div>
        <LinkBox key={task.id} task={task} status={rt.status} />
        {task.site === "lotte" && <QueueBox key={`q-${task.id}`} task={task} live={live} now={now} />}
        {rt.note && <div className="tw-note" title="원본이 기다리는 동안 제자리에서 고쳐 쓰는 줄">{rt.note}</div>}
        {phase === "checkout" && (
          <p className="tw-hint">
            주문서·결제창이 열렸습니다 — 원본이 띄운 {task.site === "naver" ? "브라우저" : "크롬"} 창에서 이어 가세요.
            이 창에는 브라우저 화면이 없습니다.
          </p>
        )}
        {rt.restartPending && <p className="tw-hint live">설정이 바뀌어 다시 시작하려고 기다립니다 (구매 중이면 끝난 뒤).</p>}
      </section>

      <section className="tw-logs">
        <div className="logs-head">
          <span>
            최근 로그 <span className="muted">· {shown.length}줄{frozen ? ` · 멈춘 뒤 ${logs.filter((l) => l.seq > (frozen.at(-1)?.seq ?? 0)).length}줄 더 옴` : ""}</span>
          </span>
          {task.site !== "naver" && REPEATING_MODES.includes(task.mode) && (
            <span className="muted small">{SITES[task.site].name} 원본은 바뀐 것이 있을 때만 줄을 찍습니다 — 그 사이는 위의 상태 줄이 보여 줍니다</span>
          )}
        </div>
        <LogView lines={shown} />
      </section>

      <footer className="tw-foot">
        <button type="button" className="btn small" onClick={() => setFrozen(frozen ? null : logs)}>
          {frozen ? "▶ 이어 보기" : "⏸ 일시정지"}
        </button>
        <button type="button" className="btn small" disabled={capturing} onClick={() => void capture()} title="이 창의 모습(PNG)과 로그(텍스트)를 태스크 폴더에 적습니다">
          📸 캡처
        </button>
        <button type="button" className="btn small ghost" onClick={() => void aio.openHome(taskId)}>폴더 열기</button>
        <button
          type="button" className="btn small ghost" disabled={live}
          title={live
            ? "돌고 있는 원본은 기록을 들고 있다가 다시 적습니다 — 멈춘 뒤 누르세요"
            : "원본의 --reset 과 같습니다 — 산 기록·쉬는 기록(쿨다운)을 지워, 다음 실행에서 바로 다시 봅니다"}
          onClick={() => void reset()}
        >
          기록 지우기 (--reset)
        </button>
        {saved && <span className={`small ${saved.ok ? "ok" : "err"}`}>{saved.text}</span>}
      </footer>
    </div>
  );
}
