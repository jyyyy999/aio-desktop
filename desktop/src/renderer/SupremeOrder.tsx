/**
 * **슈프림 주문서 프로필** — 슈프림 주문창에 그대로 들어가는 값을 적는 화면.
 *
 * 다른 사이트의 "프로필"(로그인·쿠키·--whoami)과 완전히 다르다. 슈프림은 게스트 체크아웃이라
 * 로그인이 없고, **무엇을 어디로 받을지**가 곧 프로필이다. 2026-10-08 에 실제 주문창을 열어
 * 확인한 칸들을 그대로 적는다 (회사명·별도 청구지 주소는 주문창에 없다).
 *
 * 카드·생년월일·PIN 은 화면으로 **값이 오지 않는다** — 있는지 없는지만 오고(main 의 has),
 * 저장할 때만 새 값이 main 으로 가서 safeStorage 로 암호화된다.
 */
import { useCallback, useEffect, useState } from "react";
import type { SupremeDrop, SupremeOrder, SupremeOrderSecrets, SupremeOrderState } from "../shared/types.js";

const aio = window.aio;

const COUNTRY_LABEL: Record<string, string> = {
  KR: "South Korea",
  HK: "Hong Kong SAR",
  MO: "Macao SAR",
  SG: "Singapore",
  TW: "Taiwan",
};

type SecretKey = keyof SupremeOrderSecrets;

const BLANK_SECRETS = (): Record<SecretKey, string> => ({
  card_number: "",
  card_expiry: "",
  card_cvv: "",
  card_holder: "",
  date_of_birth: "",
  card_pin_first_two: "",
  personal_customs_code: "",
});

const SECRET_INPUTS: { key: SecretKey; label: string; hint: string; type?: string }[] = [
  { key: "card_number", label: "카드 번호", hint: "숫자만" },
  { key: "card_expiry", label: "만료 (MM/YY)", hint: "12/30" },
  { key: "card_cvv", label: "CVC", hint: "뒤 3자리" },
  { key: "card_holder", label: "카드 소유자명", hint: "GIL HONG (카드에 찍힌 이름)" },
  { key: "date_of_birth", label: "생년월일 (한국 카드 결제)", hint: "1990-01-01" },
  { key: "card_pin_first_two", label: "카드 PIN 앞 2자리", hint: "12" },
  // 한국 배송이면 주문창의 "additional information" 이 이걸 요구한다 (P + 12자리).
  { key: "personal_customs_code", label: "개인통관고유부호 (additional information)", hint: "P123456789012" },
];

/** 주문창이 요구하는 필수 칸 — 비면 담지 않는다 (원본의 사전 점검과 같은 목록). */
function missingFields(order: SupremeOrder, has: Record<SecretKey, boolean>): string[] {
  const out: string[] = [];
  const need: [string, string][] = [
    [order.email, "이메일"],
    [order.first_name, "이름"],
    [order.last_name, "성"],
    [order.postal_code, "우편번호"],
    [order.province, "시/도"],
    [order.city, "도시"],
    [order.address1, "주소"],
    [order.phone, "전화번호"],
  ];
  for (const [value, label] of need) if (!String(value || "").trim()) out.push(label);
  for (const key of ["card_number", "card_expiry", "card_cvv", "card_holder"] as SecretKey[]) {
    if (!has[key]) out.push(SECRET_INPUTS.find((one) => one.key === key)?.label ?? key);
  }
  return out;
}

export function SupremeOrderPage(): React.ReactElement {
  const [state, setState] = useState<SupremeOrderState | null>(null);
  const [order, setOrder] = useState<SupremeOrder | null>(null);
  const [secrets, setSecrets] = useState<Record<SecretKey, string>>(BLANK_SECRETS());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [drop, setDrop] = useState<SupremeDrop | null>(null);
  const [seedPath, setSeedPath] = useState("");

  const load = useCallback(async () => {
    const next = await aio.supremeOrder.get();
    setState(next);
    setOrder(next.order);
    setSecrets(BLANK_SECRETS());
    const d = await aio.supremeOrder.getDrop();
    setDrop(d.drop);
    setSeedPath(d.seedPath);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof SupremeOrder>(key: K, value: SupremeOrder[K]): void => {
    setOrder((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async (clearSecrets = false): Promise<void> => {
    if (!order) return;
    setBusy(true);
    setNote("");
    try {
      const next = await aio.supremeOrder.save({ order, secrets, clearSecrets });
      setState(next);
      setOrder(next.order);
      setSecrets(BLANK_SECRETS());
      setNote(clearSecrets ? "카드·생년월일·PIN 을 지웠습니다." : "저장했습니다 — 새로 띄우는 태스크부터 이 값을 씁니다.");
    } catch (e) {
      setNote(`저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveDropSettings = async (): Promise<void> => {
    if (!drop) return;
    setBusy(true);
    setNote("");
    try {
      const next = await aio.supremeOrder.saveDrop(drop);
      setDrop(next.drop);
      setSeedPath(next.seedPath);
      setNote(`드랍 설정을 저장했습니다 — ${next.seedPath}`);
    } catch (e) {
      setNote(`드랍 설정을 저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!order || !state) {
    return (
      <div className="empty">
        <p>슈프림 주문서를 불러오는 중…</p>
      </div>
    );
  }

  const missing = missingFields(order, state.has);
  const savedCount = Object.values(state.has).filter(Boolean).length;

  return (
    <div className="monitors-page">
      <header className="page-head">
        <div>
          <b>슈프림 주문서</b>
          <span className="muted small"> — 주문창에 그대로 들어가는 값 (사이트당 한 벌)</span>
        </div>
        <div className="row">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save(false)}>
            {busy ? "저장 중…" : "저장"}
          </button>
          <button type="button" className="btn ghost" disabled={busy || savedCount === 0} onClick={() => void save(true)}>
            카드 정보 지우기
          </button>
        </div>
      </header>

      {note && <p className="muted small">{note}</p>}
      {missing.length > 0 ? (
        <p className="muted small">
          ⚠ 아직 못 사는 칸: <b>{missing.join(" · ")}</b> — 이 칸들이 비면 담기 전에 멈춥니다.
        </p>
      ) : (
        <p className="muted small">✔ 살 준비가 됐습니다 — 담기 → 배송 입력 → 카드 → 동의 → 결제 버튼까지 자동입니다.</p>
      )}

      <fieldset className="timing">
        <legend>연락</legend>
        <label>
          이메일
          <input value={order.email} placeholder="buyer@example.com" onChange={(e) => set("email", e.target.value)} />
        </label>
      </fieldset>

      <fieldset className="timing">
        <legend>배송</legend>
        <label>
          국가/지역
          <select value={order.country} onChange={(e) => set("country", e.target.value)}>
            {Object.entries(COUNTRY_LABEL).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          성
          <input value={order.last_name} onChange={(e) => set("last_name", e.target.value)} />
        </label>
        <label>
          이름
          <input value={order.first_name} onChange={(e) => set("first_name", e.target.value)} />
        </label>
        <label>
          우편번호
          <input value={order.postal_code} placeholder="06134" onChange={(e) => set("postal_code", e.target.value)} />
        </label>
        <label>
          시/도 <span className="muted small">(Seoul 또는 KR-11)</span>
          <input value={order.province} placeholder="Seoul" onChange={(e) => set("province", e.target.value)} />
        </label>
        <label>
          도시
          <input value={order.city} placeholder="Seoul" onChange={(e) => set("city", e.target.value)} />
        </label>
        <label>
          주소
          <input value={order.address1} onChange={(e) => set("address1", e.target.value)} />
        </label>
        <label>
          상세 (동·호) <span className="muted small">선택</span>
          <input value={order.address2} onChange={(e) => set("address2", e.target.value)} />
        </label>
        <label>
          전화번호
          <input value={order.phone} placeholder="01012345678" onChange={(e) => set("phone", e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={order.save_shipping_information} onChange={(e) => set("save_shipping_information", e.target.checked)} />
          주문창에서 "Save this information for next time" 도 켠다
        </label>
      </fieldset>

      <fieldset className="timing">
        <legend>결제 (암호화 저장)</legend>
        <p className="muted small">
          {state.encrypted
            ? "카드·생년월일·PIN 은 이 PC 에서만 풀리는 암호화(safeStorage)로 저장합니다. 값은 화면으로 다시 오지 않습니다 — 바꿀 때만 새로 입력하세요."
            : "⚠ 이 PC 에서 암호화를 쓸 수 없습니다 — 카드 정보는 저장되지 않습니다."}
        </p>
        {SECRET_INPUTS.map((one) => (
          <label key={one.key}>
            {one.label} <span className="muted small">{state.has[one.key] ? "저장됨 · 바꾸려면 새로 입력" : one.hint}</span>
            <input
              type={one.key === "card_number" || one.key === "card_cvv" || one.key === "card_pin_first_two" ? "password" : "text"}
              value={secrets[one.key]}
              placeholder={state.has[one.key] ? "•••• (저장됨)" : one.hint}
              onChange={(e) => setSecrets((prev) => ({ ...prev, [one.key]: e.target.value }))}
            />
          </label>
        ))}
        <p className="muted small">
          생년월일·PIN 앞 2자리는 **한국(Global-e) 카드 결제**가 요구합니다. 비워 두면 그 두 칸만 창에서 사람이 채웁니다.
        </p>
      </fieldset>

      <fieldset className="timing">
        <legend>동의 (결제 전 필수)</legend>
        <p className="muted small">켜 두면 주문창에서 자동으로 체크합니다 — 결제 버튼이 눌리려면 필요합니다.</p>
        {(
          [
            ["agree_age14", "I am 14 years or older."],
            ["agree_globale_tos", "I accept the Global-e Terms & Conditions"],
            ["agree_privacy", "개인정보 수집·이용 동의 (두 칸)"],
            ["agree_third_party", "개인정보 제3자 제공 동의"],
            ["agree_supreme_tos", "I have read and agree to the supreme terms"],
          ] as [keyof SupremeOrder, string][]
        ).map(([key, label]) => (
          <label key={key} className="check">
            <input type="checkbox" checked={Boolean(order[key])} onChange={(e) => set(key, e.target.checked as never)} />
            {label}
          </label>
        ))}
      </fieldset>

      <fieldset className="timing">
        <legend>드랍 (큐 태우기)</legend>
        <p className="muted small">
          드랍 때는 미끼 상품을 담아 <b>큐를 미리 태워 주문창에 들어가 있고</b>, 드랍 시각에 장바구니를
          원하는 상품으로 바꿔 결제합니다. 태스크에서 <b>모드: 드랍</b> 을 고르고 대상에 원하는 상품 주소를 넣으세요.
        </p>
        {drop && (
          <>
            <label>
              미끼 상품 <span className="muted small">(큐를 태울 아무 상품 주소)</span>
              <input
                value={drop.preload_url}
                placeholder="https://shop.supreme.com/products/…"
                onChange={(e) => setDrop({ ...drop, preload_url: e.target.value })}
              />
            </label>
            <div className="row">
              <label>
                드랍 시각 <span className="muted small">(태스크 폼 값이 있으면 그게 우선)</span>
                <input value={drop.drop_at} placeholder="11:00:00" onChange={(e) => setDrop({ ...drop, drop_at: e.target.value })} />
              </label>
              <label className="narrow">
                미리 담기(분)
                <input
                  type="number"
                  min={0}
                  value={drop.preload_lead_minutes}
                  onChange={(e) => setDrop({ ...drop, preload_lead_minutes: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
            </div>
            <div className="row">
              <label>
                대기열 제한(분)
                <input
                  type="number"
                  min={1}
                  value={drop.queue_timeout_minutes}
                  onChange={(e) => setDrop({ ...drop, queue_timeout_minutes: Math.max(1, Number(e.target.value) || 1) })}
                />
              </label>
              <label className="narrow">
                늦게 시작(분)
                <input
                  type="number"
                  min={0}
                  value={drop.late_grace_minutes}
                  onChange={(e) => setDrop({ ...drop, late_grace_minutes: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void saveDropSettings()}>
                드랍 저장
              </button>
            </div>
            <p className="muted small">저장 위치(씨앗 설정): <code>{seedPath || "(모름)"}</code></p>
          </>
        )}
      </fieldset>

      <p className="muted small">
        저장 위치 — 주문서: <code>{state.orderPath}</code> · 비밀(암호화): <code>{state.secretPath}</code>
      </p>
      <p className="muted small">
        태스크를 띄울 때 이 값이 태스크 홈의 <code>supreme_config.json</code> 에 들어가고, 카드·생년월일·PIN 은
        파일에 적지 않고 환경변수로만 넘어갑니다.
      </p>
    </div>
  );
}
