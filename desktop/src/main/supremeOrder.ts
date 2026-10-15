/**
 * **슈프림 주문서 프로필** — 사이트당 한 벌.
 *
 * 다른 사이트의 프로필(profiles.json)과 **완전히 다르다.** 그쪽은 로그인·쿠키·`--whoami` 를 다루고,
 * 이쪽은 슈프림 주문창에 그대로 들어가는 값이다 (게스트 체크아웃이라 로그인이 없다):
 *
 *   supreme-order.json   연락·배송·동의 (사람이 눈으로 보고 고칠 수 있는 것)
 *   supreme-order.enc    카드·생년월일·카드 PIN 앞 2자리 — **Electron safeStorage 로 암호화**
 *                        (이 PC 의 이 Windows 계정에서만 풀린다. 기존 결제 비밀번호와 같은 방식)
 *
 * 태스크를 띄울 때만 풀어서 넘긴다 — 비밀은 태스크 홈 설정 파일에 적지 않고 환경변수로 보낸다
 * (원본 supreme/config.ts 의 SUPREME_CARD_NUMBER · SUPREME_DOB · SUPREME_CARD_PIN2).
 */
import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SupremeDrop, SupremeDropState, SupremeOrder, SupremeOrderSecrets, SupremeOrderState } from "../shared/types.js";

const ORDER_FILE = "supreme-order.json";
const SECRET_FILE = "supreme-order.enc";

const dataDir = (): string => app.getPath("userData");
const orderPath = (): string => join(dataDir(), ORDER_FILE);
const secretPath = (): string => join(dataDir(), SECRET_FILE);

export const EMPTY_ORDER: SupremeOrder = {
  email: "",
  first_name: "",
  last_name: "",
  country: "KR",
  postal_code: "",
  province: "",
  city: "",
  address1: "",
  address2: "",
  phone: "",
  save_shipping_information: false,
  agree_age14: true,
  agree_globale_tos: true,
  agree_privacy: true,
  agree_third_party: true,
  agree_supreme_tos: true,
};

const SECRET_KEYS: (keyof SupremeOrderSecrets)[] = [
  "card_number",
  "card_expiry",
  "card_cvv",
  "card_holder",
  "date_of_birth",
  "card_pin_first_two",
  "personal_customs_code",
];

const EMPTY_SECRETS = (): SupremeOrderSecrets => ({
  card_number: "",
  card_expiry: "",
  card_cvv: "",
  card_holder: "",
  date_of_birth: "",
  card_pin_first_two: "",
  personal_customs_code: "",
});

const text = (value: unknown, fallback = ""): string => (value == null ? fallback : String(value).trim());
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/** 저장된 주문서(비밀 아님)를 읽는다. */
export function readOrder(): SupremeOrder {
  try {
    const raw = JSON.parse(readFileSync(orderPath(), "utf-8").replace(/^\uFEFF/, "")) as Partial<SupremeOrder>;
    return {
      email: text(raw.email),
      first_name: text(raw.first_name),
      last_name: text(raw.last_name),
      country: text(raw.country, "KR").toUpperCase() || "KR",
      postal_code: text(raw.postal_code),
      province: text(raw.province),
      city: text(raw.city),
      address1: text(raw.address1),
      address2: text(raw.address2),
      phone: text(raw.phone),
      save_shipping_information: bool(raw.save_shipping_information, false),
      agree_age14: bool(raw.agree_age14, true),
      agree_globale_tos: bool(raw.agree_globale_tos, true),
      agree_privacy: bool(raw.agree_privacy, true),
      agree_third_party: bool(raw.agree_third_party, true),
      agree_supreme_tos: bool(raw.agree_supreme_tos, true),
    };
  } catch {
    return { ...EMPTY_ORDER };
  }
}

/** 저장된 비밀을 **풀어서** 읽는다. 못 풀면(다른 PC·다른 계정) 빈 값 — 조용히 지우지는 않는다. */
export function readSecrets(): SupremeOrderSecrets {
  const empty = EMPTY_SECRETS();
  if (!existsSync(secretPath())) return empty;
  try {
    if (!safeStorage.isEncryptionAvailable()) return empty;
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(secretPath()))) as Partial<SupremeOrderSecrets>;
    for (const key of SECRET_KEYS) empty[key] = text(parsed[key]);
    return empty;
  } catch {
    return empty;
  }
}

/** 비밀이 **들어 있기는 한가** (화면에는 이것만 보낸다 — 값은 안 보낸다). */
export function hasSecrets(): Record<keyof SupremeOrderSecrets, boolean> {
  const secrets = readSecrets();
  const out = {} as Record<keyof SupremeOrderSecrets, boolean>;
  for (const key of SECRET_KEYS) out[key] = secrets[key].length > 0;
  return out;
}

export function stateOf(): SupremeOrderState {
  return {
    order: readOrder(),
    has: hasSecrets(),
    encrypted: safeStorage.isEncryptionAvailable(),
    orderPath: orderPath(),
    secretPath: secretPath(),
  };
}

/** 저장. 넘어온 비밀만 갈아 끼운다 (빈 값은 "안 바꿈" 으로 본다 — 실수로 지우지 않게). */
export function saveOrder(input: {
  order: SupremeOrder;
  secrets?: Partial<SupremeOrderSecrets>;
  clearSecrets?: boolean;
}): SupremeOrderState {
  mkdirSync(dataDir(), { recursive: true });
  const order = { ...EMPTY_ORDER, ...input.order };
  writeFileSync(orderPath(), `${JSON.stringify(order, null, 2)}\n`, "utf-8");

  const merged = input.clearSecrets ? EMPTY_SECRETS() : readSecrets();
  for (const key of SECRET_KEYS) {
    const value = text(input.secrets?.[key]);
    if (value) merged[key] = value;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("이 PC 에서 암호화를 쓸 수 없어 카드 정보를 저장하지 않았습니다 (배송 정보는 저장했습니다).");
  }
  writeFileSync(secretPath(), safeStorage.encryptString(JSON.stringify(merged)), undefined);
  return stateOf();
}

/** 태스크를 띄울 때 쓴다 — 비밀까지 풀어서. */
export function orderForLaunch(): { order: SupremeOrder; secrets: SupremeOrderSecrets } {
  return { order: readOrder(), secrets: readSecrets() };
}

/* ── 드랍 설정 ────────────────────────────────────────────────────────────
 * 화면에서 정하는 드랍 값은 **씨앗 설정**(aio/node/supreme_config.json)의 `drop` 에 적는다.
 * 어댑터가 태스크를 띄울 때 그걸 읽어 원본에 넘긴다 (미끼 상품·대기열 제한 등).
 */
export const EMPTY_DROP: SupremeDrop = {
  preload_url: "",
  drop_at: "",
  preload_lead_minutes: 2,
  swap_to_url: "",
  queue_timeout_minutes: 30,
  late_grace_minutes: 30,
};

function readJsonFile(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readDrop(seedPath: string): SupremeDropState {
  const seedExists = !!seedPath && existsSync(seedPath);
  const raw = seedExists ? readJsonFile(seedPath) : {};
  const found = raw["drop"] && typeof raw["drop"] === "object" && !Array.isArray(raw["drop"]) ? (raw["drop"] as Partial<SupremeDrop>) : {};
  return {
    drop: {
      preload_url: text(found.preload_url),
      drop_at: text(found.drop_at),
      preload_lead_minutes: Number.isFinite(Number(found.preload_lead_minutes)) ? Number(found.preload_lead_minutes) : EMPTY_DROP.preload_lead_minutes,
      swap_to_url: text(found.swap_to_url),
      queue_timeout_minutes: Number.isFinite(Number(found.queue_timeout_minutes)) ? Number(found.queue_timeout_minutes) : EMPTY_DROP.queue_timeout_minutes,
      late_grace_minutes: Number.isFinite(Number(found.late_grace_minutes)) ? Number(found.late_grace_minutes) : EMPTY_DROP.late_grace_minutes,
    },
    seedPath,
    seedExists,
  };
}

export function saveDrop(seedPath: string, input: SupremeDrop): SupremeDropState {
  if (!seedPath) throw new Error("씨앗 설정 위치를 모릅니다 — 설정 창에서 슈프림 원본 폴더를 확인하세요.");
  const raw = readJsonFile(seedPath);
  const drop: SupremeDrop = {
    preload_url: text(input?.preload_url),
    drop_at: text(input?.drop_at),
    preload_lead_minutes: Math.max(0, Number(input?.preload_lead_minutes ?? EMPTY_DROP.preload_lead_minutes) || 0),
    swap_to_url: text(input?.swap_to_url),
    queue_timeout_minutes: Math.max(1, Number(input?.queue_timeout_minutes ?? EMPTY_DROP.queue_timeout_minutes) || 1),
    late_grace_minutes: Math.max(0, Number(input?.late_grace_minutes ?? EMPTY_DROP.late_grace_minutes) || 0),
  };
  mkdirSync(dirname(seedPath), { recursive: true });
  writeFileSync(seedPath, `${JSON.stringify({ ...raw, drop }, null, 2)}\n`, "utf-8");
  return readDrop(seedPath);
}
