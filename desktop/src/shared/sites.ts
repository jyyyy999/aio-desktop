/**
 * 사이트마다 다른 **겉모습**: 이름, 상품 주소 모양, 어디까지 갈 수 있나. 화면과 main 이 같이 본다.
 *
 * 원본을 어떻게 띄우는지(진입점·인자·파일)는 여기 없다 — main/sites/ 의 어댑터가 안다.
 * preload 는 이 파일을 들이지 않는다 (sandbox 라 electron 말고는 못 들인다).
 */
import type { DropSettings, OrderAction, SiteId, TaskDef, TaskMode } from "./types.js";

/** 반복해서 보는 모드. 확인 간격·감시 시간은 이 모드에서만 쓴다 (나머지는 한 번 돌고 끝난다). */
export const REPEATING_MODES: readonly TaskMode[] = ["watch", "dry-run", "drop"];

export const MODE_LABEL: Record<TaskMode, string> = {
  watch: "지켜보기",
  once: "한 번만",
  buy: "지금 구매",
  "dry-run": "드라이런",
  status: "재고만",
  drop: "드랍",
};

type Timing = Pick<TaskDef, "checkIntervalMs" | "maxRetries" | "retryDelayMs" | "monitorDurationMs" | "stopOnSuccess" | "maxBuys" | "dropSettings">;

/** 간격·재시도·드랍을 비운 태스크 (= 전부 씨앗 설정). 이 칸들이 생기기 전의 태스크도 이걸로 채운다. */
export const TIMING_BLANK: Timing = {
  checkIntervalMs: null, maxRetries: null, retryDelayMs: null, monitorDurationMs: 0, stopOnSuccess: null, maxBuys: 2,
  dropSettings: { dropTime: "", preCheckMinutes: 2, intervalMs: null },
};

/** 드랍 시각이 이만큼 안쪽으로 지났으면 "내일" 이 아니라 지금 띄운다 — 드랍 직후에 ▶ 를 누른 것이다. */
export const DROP_LATE_GRACE_MS = 30 * 60_000;

/**
 * 드랍 예약 계산. 화면과 main 이 같은 답을 내게 여기 둔다. → null 이면 시각을 못 알아봤다.
 *   dropAt  다음 드랍 시각 (오늘, 이미 지났으면 내일 — 단 방금 지났으면 오늘)
 *   startAt 띄울 때 (드랍 − preCheckMinutes)
 *   late    드랍 시각이 방금 지났다 (지금 띄운다)
 */
export function planDrop(d: DropSettings, now: number): { dropAt: number; startAt: number; late: boolean } | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(d.dropTime.trim());
  if (!m) return null;
  const [h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || mi > 59 || se > 59) return null;
  const at = new Date(now);
  at.setHours(h, mi, se, 0);
  let dropAt = at.getTime();
  const late = dropAt <= now && now - dropAt < DROP_LATE_GRACE_MS;
  if (dropAt <= now && !late) dropAt += 24 * 60 * 60_000;
  return { dropAt, startAt: dropAt - Math.max(0, d.preCheckMinutes) * 60_000, late };
}

/**
 * 원본이 받는 --action. **원본의 ACTIONS 와 같아야 한다** — src/legacy/contract.ts 가
 * `npm run typecheck` 때 원본 타입과 맞대 본다.
 */
export const LOTTE_ACTIONS = ["open", "agree", "submit"] as const;
export const NAVER_ACTIONS = ["open", "submit"] as const;

export interface SiteSpec {
  id: SiteId;
  name: string;
  /** 표에 붙는 짧은 표. */
  tag: string;
  actions: readonly Exclude<OrderAction, "">[];
  /** "어디까지" 를 이 사이트 말로. submit 이 어디서 멈추는지가 사이트마다 다르다. */
  actionLabel: Record<Exclude<OrderAction, "">, string>;
  placeholder: string;
  urlError: string;
  isProductUrl(url: string): boolean;
  /** 표에 보일 상품번호. */
  productCode(url: string): string;
  /**
   * 돌던 중에 고치면 **다시 시작하지 않고** 원본이 바로 읽는 칸. 롯데 원본은 기다리는 사이에
   * 설정의 targets 를 다시 읽는다 (watch.ts 의 reread). 네이버 원본은 시작할 때 한 번만 읽는다.
   */
  liveFields: readonly (keyof TaskDef)[];
  /** 이 사이트 원본이 받는 모드. 드랍(--drop)은 롯데 원본에만 있다. */
  modes: readonly TaskMode[];
  /**
   * 로그인 프로필 없이 도는 모드. 롯데 원본은 재고만·드라이런을 쿠키 없이 공개 페이지로 본다
   * (index.ts 의 readOnly). 네이버 원본은 조회도 로그인한 브라우저로 해서 어느 모드도 안 된다.
   */
  loginOptional: readonly TaskMode[];
  /**
   * 한 프로필로 동시에 도는 태스크·모니터를 하나로 막나. 지금은 두 사이트 다 막지 않는다.
   *   롯데    쿠키를 태스크마다 환경변수로 넘긴다 — 원본은 크롬을 매번 빈 임시 프로필로 띄우고 쿠키를 심는다
   *   네이버  워커마다 같은 세션 파일을 읽기만 한다 (원본은 --login 때만 쓴다). 로그인 세션째로 막는 요청률은
   *           TaskManager·MonitorManager 가 프로필과 상관없이 사이트 합으로 막으므로 한 세션이 그 선을 넘을 수 없다
   *           (2026-10-06 에 풀었다 — 그 전에는 true)
   * 같은 프로필로 같은 상품을 둘 돌리면 같은 계정으로 주문서가 두 번 열린다.
   */
  oneTaskPerProfile: boolean;
}

export const SITES: Record<SiteId, SiteSpec> = {
  lotte: {
    id: "lotte",
    name: "롯데온",
    tag: "LOTTE",
    actions: LOTTE_ACTIONS,
    actionLabel: { open: "주문서까지", agree: "필수 동의까지", submit: "결제창까지" },
    placeholder: "https://www.lotteon.com/p/product/LM…?sitmNo=…",
    urlError: "롯데온 상품 주소나 상품번호가 아닙니다.",
    isProductUrl: (url) => /lotteon\.com\/[pm]\/product\/|^[A-Za-z]{1,3}\d{6,}$/.test(url.trim()),
    productCode: (url) => /product\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? url.trim(),
    liveFields: ["url", "ea", "option", "max_price", "label"],
    modes: ["watch", "drop", "once", "buy", "dry-run", "status"],
    loginOptional: ["status", "dry-run"],
    oneTaskPerProfile: false,
  },
  naver: {
    id: "naver",
    name: "네이버",
    tag: "NAVER",
    actions: NAVER_ACTIONS,
    // agree 는 없다. 네이버페이 주문서는 필수 동의를 따로 누르지 않는다 (원본 types.ts).
    // submit 이 인증 화면에서 멈추는지, 비밀번호 뒤 마지막 확인까지 가는지는 씨앗 설정에 달렸다
    // — 어댑터의 actionHints 가 태스크 폼에 적어 준다.
    actionLabel: { open: "주문서까지", agree: "—", submit: "결제 단계까지" },
    placeholder: "https://smartstore.naver.com/…/products/123… 또는 brand.naver.com/…",
    urlError: "스마트스토어·브랜드스토어 상품 주소가 아닙니다.",
    // 원본 commands.ts 의 urlFrom 과 같은 모양이다. 꼬리(?nl-au=…)는 원본이 떼어 낸다.
    isProductUrl: (url) => /https?:\/\/(?:brand|smartstore)\.naver\.com\/[^/\s]+\/products\/\d+/.test(url.trim()),
    productCode: (url) => /products\/(\d+)/.exec(url)?.[1] ?? url.trim(),
    liveFields: [],
    modes: ["watch", "once", "buy", "dry-run", "status"],
    loginOptional: [],
    oneTaskPerProfile: false,
  },
};

export const SITE_IDS = Object.keys(SITES) as SiteId[];

/** 붙여 넣은 주소가 어느 사이트 것인가. 모르면 null. */
export function siteOfUrl(url: string): SiteId | null {
  const u = url.trim();
  if (!/^https?:/.test(u)) return null; // 상품번호만 적은 것은 롯데온 모양이지만, 넘겨짚지 않는다
  return SITE_IDS.find((id) => SITES[id].isProductUrl(u)) ?? null;
}

/** 디스코드 웹훅 주소 모양인가. 설정 창과 main(시험 보내기)이 같이 쓴다. */
export function isDiscordWebhook(url: string): boolean {
  return /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(url.trim());
}

/** 준비 명령(빌드·설치)의 출력이 쌓이는 가짜 태스크 id. */
export const PREPARE_LOG = "__prepare__";

/** 태스크 칸의 이름. 돌던 중에 무엇이 바뀌었는지 로그에 적을 때 쓴다. */
export const FIELD_LABEL: Record<keyof TaskDef, string> = {
  id: "id", site: "사이트", profileId: "로그인 프로필", label: "이름", url: "상품 주소", option: "옵션", ea: "수량", max_price: "상한가",
  mode: "모드", action: "어디까지", checkIntervalMs: "확인 간격", maxRetries: "재시도", retryDelayMs: "재시도 간격",
  monitorDurationMs: "감시 시간", stopOnSuccess: "사고 나면", maxBuys: "최대 몇 번", dropSettings: "드랍 설정",
};

/** 결제 비밀번호 자릿수. 두 원본 다 6자리를 기준으로 자판을 누른다 (다르면 경고만 하고 누른다 — 우리는 받지 않는다). */
export const PAYMENT_PIN_DIGITS = 6;

/** 사는 모드 — 구매 자리까지 갈 수 있는 것. 재고만·드라이런은 사지 않는다. */
const BUYING_MODES: readonly TaskMode[] = ["watch", "once", "buy", "drop"];

/**
 * 이 태스크에 결제 비밀번호가 쓰이나 — 사는 모드이고, "어디까지" 가 결제 단계(submit)일 때 (비웠으면 씨앗 설정의
 * order_action 을 따른다). 아니면 원본이 결제창 앞에서 멈추므로 비밀번호가 쓰일 자리가 없다.
 */
export function pinMatters(task: Pick<TaskDef, "mode" | "action">, defaultAction: Exclude<OrderAction, "">): boolean {
  return BUYING_MODES.includes(task.mode) && (task.action || defaultAction) === "submit";
}

/** 로그인·세션 확인의 출력이 쌓이는 가짜 태스크 id. 프로필마다 따로 쌓인다. */
export const LOGIN_LOG_PREFIX = "__login__:";
export const loginLog = (profileId: string): string => `${LOGIN_LOG_PREFIX}${profileId}`;

/** 사이트 공통 명령(간편결제 비밀번호)의 출력이 쌓이는 가짜 태스크 id. */
export const siteLog = (site: SiteId): string => `__site__:${site}`;
