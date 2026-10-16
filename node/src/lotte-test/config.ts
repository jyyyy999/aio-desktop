/**
 * 설정과 상태 — **테스트 판.** 쓰는 파일이 본판과 다르다.
 *
 * 본판(src/lotte/config.ts)과 같은 파일을 쓰면 시험 삼아 돌린 한 판이 본판의 산 기록·
 * 로그·결제창 받아쓰기를 덮는다. 실제로 그렇게 덮여서 결제창을 받아 적을 유일한 기회를
 * 날린 적이 있다. 그래서 설정·상태·로그·덤프를 전부 `lotteon_test_*` 로 갈라 둔다.
 *
 * **쿠키만은 두 벌 관리하지 않는다.** 쿠키는 자주 갈아 끼우는 것이라 두 군데 넣게 하면
 * 반드시 한쪽이 낡는다. 테스트 설정에 쿠키가 비어 있으면 본판 설정
 * (lotteon_buy_config.json) 것을 빌려 온다. 처음 켤 때 본판 설정을 통째로 베껴 오는 것도
 * 같은 이유다 — 감시 대상과 웹훅을 다시 적게 하지 않는다.
 *
 * bnkr 쪽 테스트 판(src/bnkr-test/)과 같은 짜임이다. 다른 것은 하나 — bnkr 쪽은 본판이
 * ui·util·log 를 제 것으로 갖고 있어 그것까지 통째로 베꼈지만, 롯데온 판은 그 조각들을
 * 원래 bnkr 것에서 빌려 쓴다(`../ui.js`·`../util.js`·`../log.js`·`../browser.js`).
 * 그래서 여기서도 그대로 빌려 쓴다 — 롯데온 판이 제 것으로 가진 열 개 파일만 베꼈다.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useLogFile } from "../log.js";

/** 프로젝트 뿌리. bnkr 쪽 파일이 표지 노릇을 한다 (거기가 이 프로젝트의 집이다). */
function findBase(): string {
  const env = (process.env["LOTTEON_HOME"] || "").trim();
  if (env) return resolve(env);
  // dist/lotte-test 에서 돌든 src/lotte-test 에서 돌든 같은 곳을 찾아야 한다.
  let here = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(here, "lotteon_buy_config.json")) || existsSync(join(here, "bnkr_buy.py"))) {
      return here;
    }
    here = dirname(here);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export const BASE = findBase();
export const CONFIG_PATH = join(BASE, "lotteon_test_config.json");
export const STATE_PATH = join(BASE, "lotteon_test_state.json");
export const LOG_PATH = join(BASE, "lotteon-test-buy.log");
// 상품 페이지에서 무엇을 찾았는지 적어 두는 곳. --probe 가 쓴다.
export const DUMP_PATH = join(BASE, "lotteon-test-page-dump.txt");
// 결제창에 무엇이 있었는지 적어 두는 곳. --dump-pay 가 쓴다.
export const PG_DUMP_PATH = join(BASE, "lotteon-test-pg-dump.txt");
/** 본판 설정. 처음 켤 때 베껴 오고, 쿠키가 비었을 때 빌려 온다. **여기에 쓰지는 않는다.** */
export const REAL_CONFIG_PATH = join(BASE, "lotteon_buy_config.json");
// 웹훅을 따로 안 적으면 bnkr 쪽 것을 빌려 쓴다. 채널을 여러 벌 만들 이유가 없다.
export const BNKR_CONFIG_PATH = join(BASE, "bnkr_buy_config.json");

/**
 * 로그를 테스트 쪽 파일로 돌린다. **이 파일을 들이는 순간 바뀐다.**
 *
 * main() 안에서 부르면 늦다 — 인자를 잘못 줘서 그 앞에서 나는 오류까지
 * lotteon-test-buy.log 에 남아야 한다. 테스트 판의 모든 파일이 이 파일을 거치므로
 * 여기가 가장 이른 자리다.
 */
useLogFile(LOG_PATH);

export const IN_STOCK = "instock";
export const SOLDOUT = "soldout";
export type Status = typeof IN_STOCK | typeof SOLDOUT;
export const STATUS_LABEL: Record<string, string> = { [IN_STOCK]: "구매 가능", [SOLDOUT]: "품절" };

/**
 * 주문서에 도착한 뒤 어디까지 갈 것인가. bnkr 쪽과 이름을 맞췄다.
 *
 *   "open"    주문서를 열어 두고 멈춘다
 *   "agree"   필수 동의까지 체크하고 멈춘다
 *   "submit"  (기본) 결제하기를 눌러 **PG 결제창을 띄우고 멈춘다**
 *
 * **submit 이 이 프로그램의 끝이다.** 결제창 안에서 사람이 하는 것(카드 인증·앱 승인
 * 따위)은 그대로 사람이 한다. 다만 **간편결제 비밀번호만은** pg_password 를 적어 두면
 * 자판을 눌러 준다 (browser.ts 의 enterPin 참고) — 못 누르면 사람이 누르면 된다.
 */
export const ACTIONS = ["open", "agree", "submit"] as const;
export type OrderAction = (typeof ACTIONS)[number];
export type Stage = "opened" | "agreed" | "submitted";

export interface TargetSpec {
  url?: string;
  ea?: number;
  option?: string;
  max_price?: number;
  label?: string;
}

export interface Config {
  cookie: string;
  discord_webhook_url: string;
  mention: string;
  targets: (string | TargetSpec)[];
  poll_interval_seconds: number;
  poll_jitter_seconds: number;
  min_interval_seconds: number;
  /** 드랍 모드(--drop)의 조회 간격·흔들림(초). */
  drop_interval_seconds: number;
  drop_jitter_seconds: number;
  max_concurrency: number;
  session_check_minutes: number;
  buy_on_restock_only: boolean;
  discord_notify: string[];
  max_buys_per_run: number;
  stop_after_success: boolean;
  cooldown_minutes: number;
  max_price: number;
  max_attempts: number;
  retry_delay_seconds: number;
  open_browser: boolean;
  browser_headless: boolean;
  browser_timeout_seconds: number;
  /** 대기열(TRACER)에서 차례를 기다릴 최대 시간(초). 이 시간은 browser_timeout_seconds 에 안 든다. */
  queue_wait_seconds: number;
  /** 열리는 시각을 아는 상품이면 크롬을 미리 띄워 대기열에 세워 둔다 (warm.ts). */
  warm_browser: boolean;
  /** 열리기 이만큼(분) 전부터 대기열을 살피기 시작한다. */
  warm_window_minutes: number;
  /** 대기열을 열리기 이만큼(초) 전에 통과하도록 크롬 띄울 때를 잡는다. 크롬 뜨는 시간 포함. (queue_timing "early") */
  warm_lead_seconds: number;
  /** 줄 설 때를 잡는 방식. "late" = 열리기 직전 통과를 노린다 (기본) · "early" = 예전 방식 (warm_lead_seconds 전) */
  queue_timing: "late" | "early";
  /** "late" 에서 통과를 노리는 시각 — 열리기 이만큼(초) 전. 통과한 자리는 ~30초뿐이라 그보다 작게 둔다. */
  queue_pass_lead_seconds: number;
  /**
   * "late" 에서 줄이 빠지는 속도(명/초) — **열리기까지 남은 시간대별.** [열리기 N초 전보다 이르면, 속도] 를 N 이
   * 큰 것부터. 화면 스크립트의 셈(limitCnt ÷ session_time_out)은 쓰지 않는다.
   */
  queue_drain_profile: [number, number][];
  order_action: OrderAction;
  pay_method: string[];
  pay_method_mark: string;
  pay_card: string;
  /** 간편결제 비밀번호. 비워 두면 자동 입력하지 않는다. 값은 로그·덤프에 남기지 않는다. */
  pg_password: string;
  pg_dump: boolean;
  /** 결제가 끝나기를 지켜볼 시간(분). 완료 화면이 뜨면 디스코드로 알린다. 0 이면 지켜보지 않는다. */
  paid_wait_minutes: number;
  /** 결제 완료를 무엇으로 볼지. 주소가 먼저고, 화면 글자는 주문서를 떠났을 때만 믿는다. */
  paid_markers: string[];
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: Config = {
  cookie: "",
  discord_webhook_url: "",
  mention: "@everyone",
  targets: [],
  poll_interval_seconds: 15,
  poll_jitter_seconds: 4,
  // 상품 페이지 한 장이 27KB 다(재 봤다). 이보다 촘촘하게 두드리지 않는다.
  min_interval_seconds: 5,

  /**
   * **드랍 모드** (`--drop`). 드랍 때 켜는 빠른 걸음이다. 켜 둔 동안 내내 이 걸음으로 간다.
   *
   * 재고 API 는 한 번에 0.18초다 (2026-09-23 에 스무 번 재서 중간값 184ms, 최악 281ms).
   * 1초 간격이면 한 바퀴가 약 1.2초라, 재입고를 알아채는 데 평균 0.6초·최악 1.4초다.
   * 이 동안은 min_interval_seconds 를 따르지 않는다 — 대신 0.5초 밑으로는 못 내린다.
   *
   * 롯데온은 Imperva(봇 차단) 뒤에 있다. 처음에는 30분 뒤 평소 걸음으로 돌아가게 했다가
   * 사용자가 없앴다 (2026-09-26) — 드랍 때만 켜고 끄는 모드라서다. 대신 조회가 실패한
   * 바퀴 뒤에는 한 번 평소 걸음으로 쉰다 (watch.ts).
   */
  drop_interval_seconds: 1,
  drop_jitter_seconds: 0.2,
  // 조회에만 걸린다. 담기·주문서·결제창은 어떤 값을 주든 한 줄로 간다 —
  // 계정이 하나고, 크롬도 한 창이다.
  max_concurrency: 4,
  session_check_minutes: 10,
  // 품절 → 구매가능 으로 **바뀌는 순간**에만 산다.
  buy_on_restock_only: true,
  discord_notify: ["opened", "blocked", "session", "paid"],
  max_buys_per_run: 1,
  stop_after_success: true,
  cooldown_minutes: 30,
  max_price: 0,
  max_attempts: 3,
  retry_delay_seconds: 2,
  open_browser: true,
  // 켜지 마라. 결제창은 새 창으로 뜨는 물건이라 headless 에서 볼 것이 없다.
  browser_headless: false,
  browser_timeout_seconds: 20,

  /**
   * **대기열 (TRACER, tracer.ts).** 2026-10-03 MEGA 30th 예약판매에 떴다 — 10시 전부터.
   *
   * 붐비면 상품 페이지 대신 "현재 N명의 고객님이 대기중이에요" 가 뜨고, 차례가 오면 화면이
   * 스스로 상품 페이지로 넘어간다. 순번은 크롬의 쿠키에 붙어 있어서 **창을 닫거나 새 크롬을
   * 띄우면 맨 뒤로 간다** — 그날 원본이 20초마다 그렇게 해서 세 번 맨 뒤에 섰다.
   * 그래서 대기 화면이면 browser_timeout_seconds 와 따로, 이만큼 그 창에서 기다린다.
   */
  queue_wait_seconds: 300,

  /**
   * **크롬 미리 띄우기 (warm.ts).** 열리는 시각을 API 가 알려 주는 상품(예약판매·판매 시작 전)은
   * 열리기 warm_window_minutes 분 전부터 대기열 길이를 살핀다. 화면 스크립트와 같은 셈
   * (session_time_out ÷ limitCnt × 대기 인원)으로 기다릴 시간을 어림해, **열리기
   * warm_lead_seconds 초 전에 통과하도록** 크롬을 띄워 줄을 세운다. 대기열이 없어도 그만큼
   * 전에는 띄워 둔다 — 크롬 뜨는 3~4초를 열리는 순간에 쓰지 않으려고.
   *
   * 일찍 통과해도 된다. 그날 산 사람들이 그렇게 했다 — 10시 전에 줄을 뚫어 놓고 상품 페이지에서
   * 10시에 새로 고쳤다 (사용자가 들은 말, 2026-10-03). 통과한 자리가 새로 고침에도 남는다는
   * 뜻이다. 그래서 어림이 틀려도 넉넉하게 60초 전을 노린다. 다음 드랍 로그(통과 시각·열린 뒤
   * 새로 받을 때 다시 대기열이 떴는지)로 확인한다.
   */
  warm_browser: true,
  warm_window_minutes: 30,
  warm_lead_seconds: 60,

  /**
   * **늦게 통과 노리기 (2026-10-17, 시험 중).** 위의 "일찍 통과해도 된다" 는 틀렸다 — 2026-10-10 에 직접 재 보니
   * 통과한 자리는 ~30초뿐이고(session_time_out=30), 그 뒤 새로 고치면 다시 줄 맨 뒤다. 상품 페이지는 판매 시작을
   * 로드할 때 한 번만 보고 시계를 돌리지 않아서(main.js) 열린 뒤 한 번은 새로 고쳐야 버튼이 바뀐다. 그래서 통과는
   * **열리기 30초 안쪽**이어야 하고, 일찍 통과하면 끝이지만 늦으면 그만큼만 손해다 (열린 뒤 줄은 3~5명/초로 빠진다).
   *
   *   - 줄 설 때 = "지금 서면 내 앞 인원" 이 "지금부터 통과 목표(열리기 queue_pass_lead_seconds 초 전)까지 빠질
   *     인원" 과 같아지는 때. 빠질 인원은 queue_drain_profile 의 시간대별 속도를 이어 붙여 센다.
   *   - **속도는 한 값이 아니다.** 10-10 실측: 09:31~34 4.2 · 09:54~55 3.5 · 09:56 1.4 · 09:57~58 0.7명/초 — 열리기
   *     4~5분 전부터 뚝 떨어진다. 한 값(예: 1명/초)으로 세면 초반의 빠른 몇 분을 못 보고 너무 일찍 서서 일찍 통과한다.
   *     거꾸로 아래 표는 그날보다 조금 느리게 잡혔다 (09:54:26 앞 1,505명 → 09:58 표로는 1,176명 남음 · 실제 1,070명).
   *     느리게 잡으면 늦게 서고, 늦는 쪽이 덜 위험하다.
   *   - 감시를 켤 때 이미 대기열이 서 있으면 상품 페이지를 미리 받지 않는다 (받는 순간 줄에 서서 일찍 통과한다).
   *   - 줄에 서 있는 동안 내 순번을 5초마다 로그에 남기니, 드랍이 끝나면 그날 속도로 표를 고친다.
   *
   * 예전 방식으로 돌리려면 queue_timing: "early".
   */
  queue_timing: "late",
  queue_pass_lead_seconds: 10,
  queue_drain_profile: [[300, 3.5], [180, 1.4], [0, 0.7]],
  // 결제창을 띄우는 데까지가 이 프로그램의 끝이다.
  order_action: "submit",

  /**
   * 주문서에서 고를 결제수단. **한 줄이 한 단계**이고, `|` 로 여러 이름을 적어 두면
   * 그중 눌리는 것을 누른다.
   *
   * 기본값이 L.PAY 간편결제다. **"L.PAY" 가 아니라 "간편결제" 인 이유**는, 주문서를
   * 받아 적어 보니 결제수단이 탭 아홉 개인데 롯데 것만 제 이름 대신 그렇게 앉아 있어서다
   * (카카오페이·네이버페이·토스페이·삼성페이는 각자 제 이름의 탭을 갖고 있다).
   *
   *   간편결제 · 신용카드 · 충전결제 · 퀵계좌이체 ·
   *   카카오페이 · 네이버페이 · 토스페이 · 삼성페이 · 온누리상품권
   *
   * 탭 안에서 카드까지 정해 두고 싶으면 단계를 늘린다:
   *   ["간편결제", "롯데카드"]
   *
   * **비워 두면 건드리지 않는다.** 화면에 이미 골라져 있는 것으로 결제창을 띄운다
   * (받아 적었을 때 켜져 있던 것은 카카오페이였다).
   */
  pay_method: ["간편결제", "L.PAY 카드"],

  /**
   * 결제수단을 고른 **뒤에** 화면에 보여야 하는 글자. `|` 로 여러 철자를 적는다.
   *
   * 탭을 눌렀다고 그것이 L.PAY 라는 보장은 없다. 눌린 뒤에 무엇이 떴는지로 확인한다 —
   * 이게 없으면 "간편결제" 가 딴 것을 가리키게 바뀌었을 때 조용히 엉뚱한 수단으로
   * 결제창을 띄운다. 사이트 안에서 `L.PAY` 와 `L.pay` 가 섞여 나와 둘 다 적어 둔다.
   *
   * 안 보이면 결제하기를 누르지 않는다. 비워 두면 확인하지 않는다.
   */
  pay_method_mark: "L.PAY|L.pay|엘페이",

  /**
   * 간편결제 안에서 고를 **카드**. 이름의 일부면 된다 ("롯데", "1234").
   *
   * 비워 두면 **등록된 카드가 하나일 때만** 그것을 고른다. 여러 개인데 안 적어 뒀으면
   * 고르지 않고 목록을 적어 준다 — 남의 카드를 우리가 정할 일이 아니다.
   */
  pay_card: "",

  /**
   * 간편결제 비밀번호. 결제창이 뜬 뒤 **비밀번호 자판을 눌러 준다.**
   *
   * 비워 두면 건드리지 않는다 — 결제창 안은 원래 사람 몫이다. 이 값을 넣으면
   * 결제창이 떴을 때 자판을 읽어 차례로 누르고, 확인 키가 있으면 그것도 누른다.
   *
   * **값 자체는 로그·덤프에 남기지 않는다** — 자릿수만 남긴다. 파일에 평문으로
   * 남는 것이 싫으면 LOTTEON_PG_PASSWORD 환경변수로 넘긴다.
   *
   * 자판 구조를 아직 한 번도 못 봤다. 글자 키(0-9)든 속성에 값이 박힌 키든
   * 그릇만 찾으면 누르게 해 뒀는데, 그림 자판이면 받아 적은 화면을 보고 고친다.
   */
  pg_password: "",

  // 결제창에서 뭔가 어긋났을 때만 받아 적는다. 사람 정보는 지우고 적는다.
  pg_dump: true,

  // 결제가 끝나기를 지켜볼 시간. 완료 화면(주문완료)이 뜨면 디스코드로 "successfully
  // checkout" + 제품명 + 제품 링크를 보낸다 (notify.ts 의 notifyPaid).
  paid_wait_minutes: 10,

  /**
   * 완료를 무엇으로 볼지. **주소가 먼저다** — 주소에 걸리면 그것만으로 끝난 것이다.
   * 화면 글자는 주문서를 떠났거나 **자판 모달이 닫혔을 때만** 믿는다:
   * 주문서의 단계 표시줄에도 "주문완료" 가 달려 있어서, 서 있으면서 글자로 판정하면
   * 결제를 시작하자마자 끝난 것으로 읽는다 (bnkr 판에서 실제로 그랬다).
   *
   * 마지막 두 개는 완료 화면에만 뜨는 문구다 — 사용자가 2026-08-25 에 확인했다:
   * "우리 이제 곧 만나요!" "선택하신 배송지로 안전하게 배송해 드릴게요!"
   */
  paid_markers: [
    "주문이 완료", "주문완료", "결제가 완료", "결제 완료",
    "orderComplete", "orderResult",
    "우리 이제 곧 만나요", "배송지로 안전하게 배송해",
  ],
};

/** 사지 않고 무엇을 살지만 본다. 프로세스 하나에 하나뿐인 상태라 여기 둔다. */
export const run = {
  dryRun: false,
  /** 드랍 모드(--drop)인가. */
  drop: false,
  /** --link 로 이번 실행의 상품을 정했는가. 그러면 설정 파일의 targets 를 따라가지 않는다. */
  linked: false,
};

/**
 * 할 말은 이미 화면에 적었으니 조용히 1 로 끝내라는 뜻.
 * 고칠 자리가 있는 고장이 아닌 것들이 여기로 온다.
 */
export class Quit extends Error {
  constructor() {
    super("");
  }
}

/**
 * 본판 설정을 씨앗으로 베껴 온다.
 *
 * **쿠키는 일부러 안 베낀다.** 베껴 두면 그 순간부터 두 벌이 되고, 본판을 갱신해도
 * 이쪽은 낡은 것을 붙들고 있게 된다. 비워 두면 cookieOf 가 매번 본판에서 빌려 온다.
 *
 * 산 기록(done)까지 따라오면 안 되므로 상태는 베끼지 않는다 — 그건 다른 파일이다.
 */
function seedFromReal(): Partial<Config> {
  let real: Partial<Config> = {};
  try {
    real = JSON.parse(readFileSync(REAL_CONFIG_PATH, "utf-8")) as Partial<Config>;
  } catch {
    // 본판 설정이 없거나 깨졌으면 기본값으로 시작한다. 그것 때문에 못 켤 일은 아니다.
  }
  return { ...real, cookie: "" };
}

/**
 * 설정을 읽는다. **본판과 달리 없다고 멈추지 않는다.**
 *
 * 본판은 "설정을 만들었으니 상품과 쿠키를 넣고 다시 실행하세요" 하고 멈춘다. 여기서
 * 그러면 시험해 보려는 사람이 감시 대상과 웹훅을 처음부터 다시 적어야 한다 — 본판에
 * 이미 다 있는 것을. 그래서 베껴 오고 그대로 진행한다.
 */
export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    const seed = { ...DEFAULT_CONFIG, ...seedFromReal() };
    writeFileSync(CONFIG_PATH, JSON.stringify(seed, null, 2), "utf-8");
    // 어디서 왔는지 밝힌다. 조용히 베껴 두면 왜 이 상품이 여기 있는지 알 수 없다.
    process.stderr.write(
      `${basename(CONFIG_PATH)} 을 만들었습니다 ` +
      `(${basename(REAL_CONFIG_PATH)} 에서 베껴 왔고, 쿠키는 그때그때 빌려 씁니다).
`);
  }
  const own = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...own };
}

export function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

/**
 * 쿠키. 테스트 설정이 비어 있으면 **본판에서 빌려 온다.**
 *
 * 빌려 오기만 하고 베껴 두지 않는다. 베껴 두면 본판에 쿠키를 새로 넣어도 이쪽은 낡은
 * 것을 붙들고 있게 되고, 그걸 알아채는 자리는 하필 재고가 열린 순간이다.
 */
export function cookieOf(cfg: Config): string {
  const own = (process.env["LOTTEON_COOKIE"] || cfg.cookie || "").trim();
  if (own) return own;
  try {
    const real = JSON.parse(readFileSync(REAL_CONFIG_PATH, "utf-8")) as Partial<Config>;
    return String(real.cookie || "").trim();
  } catch {
    return "";
  }
}

/** 웹훅을 따로 안 적었으면 bnkr 쪽 것을 빌려 쓴다. 빌려 쓰기만 하고 베껴 두지는 않는다. */
export function webhookOf(cfg: Config): string {
  const own = (cfg.discord_webhook_url || "").trim();
  if (own) return own;
  try {
    const borrowed = JSON.parse(readFileSync(BNKR_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    return String(borrowed["discord_webhook_url"] || "").trim();
  } catch {
    return "";
  }
}

export function wants(cfg: Config, event: string): boolean {
  return (cfg.discord_notify || []).includes(event);
}

/** 어디까지 갈지. 설정에 모르는 값이 적혀 있으면 그렇게 말하고 open 으로 물러선다. */
export function actionOf(cfg: Config): OrderAction {
  const raw = String(cfg.order_action ?? "submit").toLowerCase() as OrderAction;
  return ACTIONS.includes(raw) ? raw : "open";
}

/** 간편결제 안에서 고를 카드. */
export function payCardOf(cfg: Config): string {
  return String(cfg.pay_card ?? "").trim();
}

/**
 * 간편결제 비밀번호. 설정보다 환경변수가 먼저다 — 비밀번호를 파일에 두기 싫은 사람을
 * 위한 길이고, 값 자체는 어디에도 로그로 남기지 않는다 (browser.ts 의 enterPin).
 */
export function passwordOf(cfg: Config): string {
  return (process.env["LOTTEON_PG_PASSWORD"] || cfg.pg_password || "").trim();
}

/** 결제수단을 고른 뒤 화면에 보여야 하는 글자. */
export function payMarkOf(cfg: Config): string {
  return String(cfg.pay_method_mark ?? "").trim();
}

/** 고를 결제수단. 문자열 하나로 적어 놔도 받는다. */
export function payMethodOf(cfg: Config): string[] {
  const raw = cfg.pay_method;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  return list.map((one) => String(one).trim()).filter(Boolean);
}

/** 상태 파일에 상품마다 적어 두는 것. */
export interface TargetEntry {
  name?: string;
  status?: string;
  price?: number;
  done?: boolean;
  opened?: boolean;
  stage?: Stage;
  blocked?: string;
  opened_at?: string;
  last_try_at?: string;
  /** 사이트가 "품절" 이라며 막은 것이 몇 번 이어졌나. 경쟁에서 진 것이라 쉬지 않고 다시 보되,
   *  이게 LOST_RACE_LIMIT 번 이어지면 판정이 틀린 것으로 보고 그때는 쉰다 (watch.ts). */
  lost_races?: number;
}

export interface State {
  targets?: Record<string, TargetEntry>;
  [key: string]: unknown;
}

export function loadState(): State {
  if (!existsSync(STATE_PATH)) return { targets: {} };
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as State;
  } catch {
    return { targets: {} };
  }
}

export function saveState(state: State): void {
  // **--dry-run 은 기록을 남기지 않는다.** 사지 않고 "샀을 것" 이라고만 한 판을 done 으로
  // 적어서, 다음 진짜 감시가 그 상품을 "이미 샀습니다" 로 건너뛰게 만들었다 (2026-09-26).
  // 이번 실행 안에서 품절→구매가능 을 가리는 것은 메모리에 든 state 로 충분하다.
  if (run.dryRun) return;
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/** 상태 파일에서 이 상품의 자리. 없으면 만들어 준다. */
export function entryOf(state: State, key: string): TargetEntry {
  const targets = (state.targets ??= {});
  return (targets[key] ??= {});
}
