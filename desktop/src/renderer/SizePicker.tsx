/**
 * 사이즈 고르기 — 상품 주소를 적으면 그 상품의 사이즈와 남은 수량을 받아 버튼으로 보인다 (칼하트윕).
 *
 * 손으로 적지 않는다: 사이즈 글자는 상품마다 다르다 (2026-11-11 에 본 것 — 신발 240·250·255…300, 옷 XS·S·M·L·XL·XXL,
 * 모자·소품 OS 하나). 사이트가 주는 글자 그대로 옵션 칸에 적으므로 "XL" 과 "XLarge" 가 어긋날 일이 없다.
 *
 * **여러 개를 차례대로 고른다.** 누른 차례가 우선순위다 — 원본은 앞에서부터 재고 있는 첫 사이즈를 산다
 * (옵션 칸에는 "270,275" 로 간다). 고른 것을 다시 누르면 뺀다. 품절인 사이즈도 고를 수 있다 (재입고를 기다리는 태스크).
 * 사이즈가 하나뿐인 상품(OS)은 고를 것이 없어 옵션을 비워 둔다 — 원본이 그 하나를 산다.
 */
import { useEffect, useState } from "react";
import type { ProductSizes, SiteId } from "../shared/types";

const aio = window.aio;

/** 옵션 칸의 글자 ↔ 고른 사이즈들 (차례대로). */
export const splitSizes = (option: string): string[] => option.split(",").map((s) => s.trim()).filter(Boolean);
export const joinSizes = (sizes: string[]): string => sizes.join(",");

const won = (n: number): string => `${n.toLocaleString("en-US")}원`;

/** "11/12 11:00" — 한국 시간으로. */
function kst(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return `${get("month")}/${get("day")} ${String(Number(get("hour")) % 24).padStart(2, "0")}:${get("minute")}`;
}

export function ProductSizePicker({ site, url, valid, option, onChange }: {
  site: SiteId;
  url: string;
  /** 주소가 이 사이트의 상품 주소 모양인가 — 아니면 받지 않는다. */
  valid: boolean;
  option: string;
  onChange: (option: string) => void;
}) {
  const [data, setData] = useState<ProductSizes | null>(null);
  const [loading, setLoading] = useState(false);
  /** 다시 받기를 누를 때마다 올린다. */
  const [again, setAgain] = useState(0);
  const [custom, setCustom] = useState(false);
  const picked = splitSizes(option);

  useEffect(() => {
    setData(null);
    if (!valid) return;
    let stale = false;
    setLoading(true);
    // 주소를 치는 동안에는 받지 않는다 — 멈춘 뒤 0.4초에 한 번.
    const timer = setTimeout(() => {
      aio.productSizes(site, url.trim())
        .then((got) => { if (!stale) setData(got); })
        .catch((e: unknown) => {
          if (!stale) setData({ name: "", price: 0, availableFrom: null, perUser: 0, sizes: [], error: e instanceof Error ? e.message : String(e) });
        })
        .finally(() => { if (!stale) setLoading(false); });
    }, 400);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [site, url, valid, again]);

  const sizes = data?.sizes ?? [];
  const single = sizes.length === 1;
  // 고른 것 가운데 이 상품에 없는 사이즈 (주소를 바꿨거나 손으로 적은 것) — 원본이 "그런 사이즈가 없습니다" 로 멈춘다.
  const unknown = sizes.length ? picked.filter((p) => !sizes.some((s) => s.name.toLowerCase() === p.toLowerCase())) : [];
  const toggle = (name: string) => onChange(joinSizes(picked.includes(name) ? picked.filter((p) => p !== name) : [...picked, name]));
  const total = sizes.reduce((sum, s) => sum + (s.stock ?? 0), 0);

  return (
    <div className="modal-field">
      <span>
        사이즈{" "}
        {picked.length
          ? <span className="muted">— <b className="size-picked">{picked.join(" → ")}</b>{picked.length > 1 && " (앞에서부터 재고 있는 첫 사이즈)"}</span>
          : single
            ? <span className="muted">— 사이즈가 하나뿐입니다 ({sizes[0]!.name}) · 고를 것이 없습니다</span>
            : <span className="muted">(누른 차례가 우선순위 — 여러 개 고를 수 있습니다)</span>}
      </span>

      {data && !data.error && (
        <span className="muted small">
          {data.name}{data.price ? ` · ${won(data.price)}` : ""}
          {data.availableFrom && new Date(data.availableFrom).getTime() > Date.now() ? ` · 발매 ${kst(data.availableFrom)}` : ""}
          {data.perUser ? ` · 1인 ${data.perUser}개` : ""}
          {sizes.length ? ` · 재고 ${total.toLocaleString("en-US")}개` : ""}
        </span>
      )}

      {custom ? (
        <input value={option} placeholder="270,275" onChange={(e) => onChange(e.target.value)} />
      ) : !valid ? (
        <span className="muted small">상품 주소를 적으면 그 상품의 사이즈를 불러옵니다.</span>
      ) : loading && !data ? (
        <span className="muted small">사이즈를 불러오는 중…</span>
      ) : data?.error ? (
        <span className="err">사이즈를 받지 못했습니다 — {data.error}</span>
      ) : !sizes.length ? (
        <span className="muted small">이 상품에는 사이즈가 없습니다.</span>
      ) : (
        <div className="size-grid">
          {sizes.map((s) => {
            const order = picked.indexOf(s.name);
            return (
              <button
                key={s.name} type="button" disabled={single}
                className={`size-btn stocked ${order >= 0 ? "on" : ""} ${s.inStock ? "" : "out"}`}
                title={s.inStock ? `${s.name} — ${s.stock === null ? "재고 있음" : `${s.stock}개 남음`}` : `${s.name} — 품절 (골라 두면 재입고를 기다립니다)`}
                onClick={() => toggle(s.name)}
              >
                {order >= 0 && picked.length > 1 && <span className="size-order">{order + 1}</span>}
                <span>{s.name}</span>
                <span className="size-stock">{s.inStock ? (s.stock === null ? "있음" : s.stock) : "품절"}</span>
              </button>
            );
          })}
        </div>
      )}

      {unknown.length > 0 && !custom && (
        <span className="err">이 상품에 없는 사이즈를 골라 두었습니다: {unknown.join(", ")} — <button type="button" className="chip" onClick={() => onChange(joinSizes(picked.filter((p) => !unknown.includes(p))))}>빼기</button></span>
      )}
      {!single && sizes.length > 1 && !picked.length && !custom && (
        <span className="muted small">사이즈가 여러 개인 상품은 하나 이상 골라야 삽니다.</span>
      )}

      <div className="size-tabs">
        <button type="button" className="chip" disabled={!valid || loading} onClick={() => setAgain((n) => n + 1)}>{loading ? "불러오는 중…" : "다시 받기"}</button>
        <button type="button" className={`chip ${custom ? "on" : ""}`} onClick={() => setCustom((on) => !on)}>직접 적기</button>
        {picked.length > 0 && <button type="button" className="chip" onClick={() => onChange("")}>지우기</button>}
      </div>
    </div>
  );
}
