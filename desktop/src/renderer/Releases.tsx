/**
 * 발매정보 화면 — 발매 예정·진행 중인 상품과 그 링크(공식 판매처·응모 페이지·참고 글). 사이드바의 "발매정보".
 * 수동 항목은 고치고 지운다. 자동 항목(드랍 태스크의 드랍 시각 · 롯데 대기열 보기가 읽은 열리는 시각)은 태스크에서
 * 만들어지므로 고치지 않고, 숨기거나 수동 항목으로 베낀다. 링크는 앱 안이 아니라 기본 브라우저로 연다.
 */
import { useMemo, useState } from "react";
import { isHttpUrl, METHOD_LABEL, RELEASE_METHODS, releaseProblem, tidyRelease } from "../shared/releases";
import { SITE_IDS, SITES } from "../shared/sites";
import type { Release, ReleaseInput, ReleaseList } from "../shared/types";
import { errText, shortLink } from "./App";

const aio = window.aio;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
const LINK_LABELS = ["공식 판매처", "응모 페이지", "래플", "드로우", "참고 글"];

const two = (n: number) => String(n).padStart(2, "0");
const timeOf = (r: Release) => new Date(r.releaseAt).getTime();

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 오늘 발매하나 (이 PC 시계로). */
export function isToday(iso: string, now: number): boolean {
  return startOfDay(new Date(iso).getTime()) === startOfDay(now);
}

/** 지난 발매 — 오늘보다 앞선 날의 것. 오늘 것은 시각이 지나도 "진행 중" 으로 위에 남는다. */
export function isPast(iso: string, now: number): boolean {
  return new Date(iso).getTime() < startOfDay(now);
}

/** "1시간 5분" · "12분" */
function hm(ms: number): string {
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / 60_000);
  return h ? `${h}시간 ${m}분` : `${m}분`;
}

/** 남은 시간. 오늘이면 시·분(1시간 안쪽이면 분·초), 내일이면 D-1 과 시간, 그 뒤는 D-N. 지난 것은 D+N. */
export function untilText(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days < 0) return `D+${-days}`;
  const left = at - now;
  if (days === 1 && left < DAY) return `D-1 · ${hm(left)} 남음`;
  if (days > 0) return `D-${days}`;
  if (left <= 0) return `진행 중 · ${hm(-left)} 전 시작`;
  if (left < HOUR) return `${Math.floor(left / 60_000)}분 ${Math.floor((left % 60_000) / 1000)}초 남음`;
  return `${hm(left)} 남음`;
}

/** 10/25 (토) 10:00 — 올해가 아니면 연도도. */
function dateText(iso: string): string {
  const d = new Date(iso);
  const year = d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()}. `;
  return `${year}${d.getMonth() + 1}/${d.getDate()} (${WEEKDAY[d.getDay()]}) ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** datetime-local 칸의 값 (이 PC 시각). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

async function openLink(url: string): Promise<void> {
  try {
    await aio.release.openLink(url);
  } catch (e) {
    await aio.tell(errText(e));
  }
}

// ── 목록 ────────────────────────────────────────────────────────────────────

export function ReleasesPage({ list, now, onList }: {
  list: ReleaseList | null; now: number;
  /** 바꾼 뒤의 새 목록. */
  onList: (list: ReleaseList) => void;
}) {
  const [query, setQuery] = useState("");
  const [store, setStore] = useState("all");
  const [pastOpen, setPastOpen] = useState(false);
  /** 폼 — 고칠 항목(null 이면 새로)과 처음 채울 값. */
  const [editing, setEditing] = useState<{ edit: Release | null; seed: ReleaseInput | null } | null>(null);
  const items = useMemo(() => list?.items ?? [], [list]);
  const stores = useMemo(() => [...new Set(items.map((r) => r.store))].sort((a, b) => a.localeCompare(b, "ko")), [items]);
  // 고른 스토어의 마지막 항목을 지웠으면 전체로 돌아간다.
  const picked = stores.includes(store) ? store : "all";

  const q = query.trim().toLowerCase();
  const matches = (r: Release) =>
    (picked === "all" || r.store === picked) &&
    (!q || [r.name, r.store, r.memo, r.price, METHOD_LABEL[r.method], ...r.links.map((l) => l.label)].join(" ").toLowerCase().includes(q));
  const shown = items.filter(matches);
  const upcoming = shown.filter((r) => !isPast(r.releaseAt, now)).sort((a, b) => timeOf(a) - timeOf(b));
  // 지난 것도 가까운 순 — 최근에 지난 것부터.
  const past = shown.filter((r) => isPast(r.releaseAt, now)).sort((a, b) => timeOf(b) - timeOf(a));
  const todayCount = upcoming.filter((r) => isToday(r.releaseAt, now)).length;

  const act = async (fn: () => Promise<ReleaseList>) => {
    try {
      onList(await fn());
    } catch (e) {
      await aio.tell(errText(e));
    }
  };
  const card = (r: Release) => (
    <ReleaseCard
      key={r.id} r={r} now={now}
      onEdit={() => setEditing({ edit: r, seed: null })}
      onCopy={() => setEditing({ edit: null, seed: { ...r, memo: [r.memo, r.origin && `(자동: ${r.origin})`].filter(Boolean).join("\n") } })}
      onDelete={() => void aio.ask(`'${r.name}' 을(를) 발매정보에서 지울까요?`).then((ok) => { if (ok) void act(() => aio.release.delete(r.id)); })}
      onHide={() => void act(() => aio.release.hideAuto(r.id))}
    />
  );

  return (
    <section className="releases-page">
      <div className="page-head">
        <h2>발매정보</h2>
        <span className="muted small">발매 예정·진행 중인 상품과 링크 — 링크는 기본 브라우저로 엽니다.</span>
        <span className="grow" />
        <input className="release-search" type="search" placeholder="검색 (상품명·스토어·메모)" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="btn primary" onClick={() => setEditing({ edit: null, seed: null })}>+ 발매 추가</button>
      </div>

      {items.length > 0 && (
        <nav className="release-filters">
          <button type="button" className={`chip ${picked === "all" ? "on" : ""}`} onClick={() => setStore("all")}>전체 {items.length}</button>
          {stores.map((s) => (
            <button key={s} type="button" className={`chip ${picked === s ? "on" : ""}`} onClick={() => setStore(s)}>
              {s} {items.filter((r) => r.store === s).length}
            </button>
          ))}
          {(list?.hiddenAuto ?? 0) > 0 && (
            <button type="button" className="btn small ghost hidden-auto" onClick={() => void act(() => aio.release.showHidden())}>
              숨긴 자동 항목 {list!.hiddenAuto}개 다시 보기
            </button>
          )}
        </nav>
      )}

      {!items.length ? (
        <div className="empty-card release-empty">
          <p className="muted">아직 발매정보가 없습니다.</p>
          <p className="muted small">
            발매 일시·방식과 공식 판매처·응모 페이지 링크를 모아 둡니다. 드랍 시각을 정한 드랍 태스크나, 롯데 태스크 창에서
            대기열 보기로 읽은 열리는 시각은 <b>자동</b>으로 여기 뜹니다.
          </p>
          <button type="button" className="btn primary" onClick={() => setEditing({ edit: null, seed: null })}>+ 발매 추가</button>
        </div>
      ) : (
        <>
          <div className="group-head">
            <b>예정 · 진행 중</b> <span className="muted">{upcoming.length}개</span>
            {todayCount > 0 && <span className="pill today">오늘 {todayCount}</span>}
          </div>
          <div className="release-cards">
            {upcoming.map(card)}
            {!upcoming.length && (
              <div className="empty-card muted">{q || picked !== "all" ? "조건에 맞는 예정 발매가 없습니다." : "예정된 발매가 없습니다."}</div>
            )}
          </div>
          {past.length > 0 && (
            <>
              <button type="button" className="group-head fold" onClick={() => setPastOpen((v) => !v)} aria-expanded={pastOpen}>
                <span className="fold-mark">{pastOpen ? "▾" : "▸"}</span> <b>지난 발매</b> <span className="muted">{past.length}개</span>
              </button>
              {pastOpen && <div className="release-cards">{past.map(card)}</div>}
            </>
          )}
        </>
      )}

      {editing && (
        <ReleaseForm
          initial={editing.edit} seed={editing.seed} stores={stores}
          onSaved={(l) => {
            onList(l);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function ReleaseCard({ r, now, onEdit, onCopy, onDelete, onHide }: {
  r: Release; now: number;
  onEdit: () => void; onCopy: () => void; onDelete: () => void; onHide: () => void;
}) {
  const [thumbBroken, setThumbBroken] = useState(false);
  const today = isToday(r.releaseAt, now);
  const past = isPast(r.releaseAt, now);
  const auto = r.source === "auto";
  return (
    <div className={`release-card ${today ? "today" : ""} ${past ? "past" : ""}`}>
      {r.thumbnail && !thumbBroken && (
        <img className="release-thumb" src={r.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setThumbBroken(true)} />
      )}
      <div className="release-main">
        <div className="card-top">
          <b className="grow release-name" title={r.name}>{r.name}</b>
          <span className={`pill src ${r.source}`} title={auto ? `자동 — ${r.origin ?? "봇이 아는 것"}` : "직접 넣은 항목"}>{auto ? "자동" : "수동"}</span>
        </div>
        <div className="release-meta small">
          <span className="store-tag">{r.store}</span>
          <span className={`pill method ${r.method}`}>{METHOD_LABEL[r.method]}</span>
          {r.price && <span className="muted">{r.price}</span>}
        </div>
        <div className="release-when">
          <span className="mono">{dateText(r.releaseAt)}</span>
          <span className={`until ${today ? "today" : ""}`}>{untilText(r.releaseAt, now)}</span>
        </div>
        {auto && r.origin && <div className="muted small">⚙ {r.origin}</div>}
        {r.memo && <div className="release-memo small">{r.memo}</div>}
        {r.links.length > 0 && (
          <div className="release-links">
            {r.links.map((l, i) => (
              <button key={i} type="button" className="btn small" title={`${l.url}\n기본 브라우저로 엽니다`} onClick={() => void openLink(l.url)}>
                ↗ {l.label || shortLink(l.url)}
              </button>
            ))}
          </div>
        )}
        <div className="account-actions">
          <span className="grow" />
          {auto ? (
            <>
              <button type="button" className="btn small ghost" title="수동 항목으로 베껴 링크·메모를 붙입니다" onClick={onCopy}>수동으로 베끼기</button>
              <button type="button" className="icon" title="숨기기 — 태스크는 그대로 둡니다" onClick={onHide}>✕</button>
            </>
          ) : (
            <>
              <button type="button" className="icon" title="고치기" onClick={onEdit}>✎</button>
              <button type="button" className="icon" title="지우기" onClick={onDelete}>✕</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 추가 · 고치기 폼 ────────────────────────────────────────────────────────

function blankInput(): ReleaseInput {
  return { name: "", store: "", releaseAt: "", method: "fcfs", price: "", thumbnail: "", links: [{ label: "", url: "" }], memo: "" };
}

function ReleaseForm({ initial, seed, stores, onSaved, onCancel }: {
  initial: Release | null; seed: ReleaseInput | null; stores: string[];
  onSaved: (list: ReleaseList) => void; onCancel: () => void;
}) {
  // releaseAt 은 폼 안에서는 datetime-local 값(이 PC 시각)으로 들고, 저장할 때 ISO 로 바꾼다.
  const [r, setR] = useState<ReleaseInput>(() => {
    const from = initial ?? seed;
    if (!from) return blankInput();
    const { name, store, releaseAt, method, price, thumbnail, links, memo } = from;
    return { name, store, releaseAt: toLocalInput(releaseAt), method, price, thumbnail, links: links.length ? links.map((l) => ({ ...l })) : [{ label: "", url: "" }], memo };
  });
  const [saving, setSaving] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const set = <K extends keyof ReleaseInput>(k: K, v: ReleaseInput[K]) => setR((prev) => ({ ...prev, [k]: v }));
  const setLink = (i: number, k: "label" | "url", v: string) =>
    setR((prev) => ({ ...prev, links: prev.links.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));

  const at = r.releaseAt ? new Date(r.releaseAt) : null;
  const clean = tidyRelease({ ...r, releaseAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : "" });
  const problem = releaseProblem(clean);
  const storeOptions = [...new Set([...stores, ...SITE_IDS.map((id) => SITES[id].name)])];

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
            onSaved(initial ? await aio.release.update(initial.id, clean) : await aio.release.create(clean));
          } catch (err) {
            setFail(errText(err));
          } finally {
            setSaving(false);
          }
        }}
      >
        <h2>{initial ? "발매정보 고치기" : "발매 추가"}</h2>
        <label>
          상품명
          <input autoFocus value={r.name} placeholder="Nike Air Max 1 '86 OG" onChange={(e) => set("name", e.target.value)} />
        </label>
        <div className="row">
          <label>
            브랜드 / 스토어
            <input list="release-stores" value={r.store} placeholder="나이키 · 롯데온 · 무신사" onChange={(e) => set("store", e.target.value)} />
            <datalist id="release-stores">{storeOptions.map((s) => <option key={s} value={s} />)}</datalist>
          </label>
          <label>
            발매 일시
            <input type="datetime-local" value={r.releaseAt} onChange={(e) => set("releaseAt", e.target.value)} />
          </label>
        </div>
        <div className="modal-field">
          발매 방식
          <div className="segmented">
            {RELEASE_METHODS.map((m) => (
              <button key={m} type="button" className={r.method === m ? "on method" : ""} onClick={() => set("method", m)}>{METHOD_LABEL[m]}</button>
            ))}
          </div>
        </div>
        <div className="row">
          <label>
            가격 <span className="muted">(선택)</span>
            <input value={r.price} placeholder="139,000원" onChange={(e) => set("price", e.target.value)} />
          </label>
          <label>
            썸네일 URL <span className="muted">(선택)</span>
            <input value={r.thumbnail} placeholder="https://…/image.jpg" onChange={(e) => set("thumbnail", e.target.value)} />
            {r.thumbnail.trim() && !isHttpUrl(r.thumbnail) && <span className="err small">http:// 나 https:// 주소만 됩니다.</span>}
          </label>
        </div>

        <fieldset className="timing">
          <legend>링크 <span className="muted">— 공식 판매처 · 응모/래플 페이지 · 참고 글</span></legend>
          {r.links.map((l, i) => (
            <div key={i} className="link-row">
              <input className="link-label" list="release-link-labels" value={l.label} placeholder="라벨" onChange={(e) => setLink(i, "label", e.target.value)} />
              <div className="link-url">
                <input value={l.url} placeholder="https://" onChange={(e) => setLink(i, "url", e.target.value)} />
                {l.url.trim() && !isHttpUrl(l.url) && <span className="err small">http:// 나 https:// 주소만 됩니다.</span>}
                {!l.url.trim() && l.label.trim() && <span className="err small">주소를 넣으세요.</span>}
              </div>
              <button type="button" className="icon" title="이 링크 빼기" onClick={() => set("links", r.links.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <datalist id="release-link-labels">{LINK_LABELS.map((s) => <option key={s} value={s} />)}</datalist>
          <div>
            <button type="button" className="btn small" onClick={() => set("links", [...r.links, { label: "", url: "" }])}>+ 링크</button>
          </div>
        </fieldset>

        <label>
          메모 <span className="muted">(선택)</span>
          <textarea rows={3} value={r.memo} placeholder="사이즈 · 응모 마감 · 당첨 발표일 …" onChange={(e) => set("memo", e.target.value)} />
        </label>

        {problem && (r.name || r.store || r.releaseAt) && <p className="err small">{problem}</p>}
        {fail && <p className="err small">{fail}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>취소</button>
          <button type="submit" className="btn primary" disabled={!!problem || saving}>{initial ? "저장" : "➕ 추가"}</button>
        </div>
      </form>
    </div>
  );
}
