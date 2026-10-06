/**
 * 태스크 창 — 태스크 하나의 상태와 로그. 메인 창 표의 🖥 로 연다 (태스크마다 창 하나, 여럿을 같이 연다).
 *
 * 화면(브라우저)은 없다. 원본이 띄우는 창은 이미 화면에 보인다 (롯데는 재고를 HTTP 로 보면서 크롬 창 하나를
 * 상품 페이지에 띄워 두고 — warm.ts — 네이버는 헤드리스 탭을 1초 열었다 닫는다). 여기서는 원본
 * 출력으로 알아본 것 — 단계·확인 회차·마지막 확인·원본의 상태 줄 — 과 로그를 보인다.
 */
import { useEffect, useState } from "react";
import { MODE_LABEL, REPEATING_MODES, SITES } from "../shared/sites";
import type { LogLine, Profile, SiteInfo, TaskDef, TaskPhase, TaskRuntime } from "../shared/types";
import { countdown, errText, idleRuntime, LIVE, LOGIN_LABEL, LogView, mergeLogs, SiteTag, span, STATUS_LABEL, uptime } from "./App";

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

  useEffect(() => {
    void aio.listTasks().then(setTasks);
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
  const name = task ? task.label || SITES[task.site].productCode(task.url) : "";

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
  const target = [
    name,
    task.option && `옵션 ${task.option}`,
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
    if (!confirm("이 태스크의 산 기록·쉬는 기록을 지울까요? (원본의 --reset)\n다음 실행에서 쉬지 않고 바로 다시 보고, 산 것도 다시 삽니다.")) return;
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
        {rt.note && <div className="tw-note" title="원본이 기다리는 동안 제자리에서 고쳐 쓰는 줄">{rt.note}</div>}
        {phase === "checkout" && (
          <p className="tw-hint">
            주문서·결제창이 열렸습니다 — 원본이 띄운 {task.site === "lotte" ? "크롬" : "브라우저"} 창에서 이어 가세요.
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
          {task.site === "lotte" && REPEATING_MODES.includes(task.mode) && (
            <span className="muted small">롯데 원본은 바뀐 것이 있을 때만 줄을 찍습니다 — 그 사이는 위의 상태 줄이 보여 줍니다</span>
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
