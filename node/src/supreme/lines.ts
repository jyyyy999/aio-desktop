/**
 * 로그 줄 규약 — **한 곳에 모아 둔다.**
 *
 * 데스크톱 대시보드의 어댑터(src/main/sites/supreme.ts)가 이 줄들을 정규식으로 읽어
 * 화면의 회차·단계·진행을 그린다. 그래서 문구를 바꾸면 **양쪽을 같이** 고쳐야 한다.
 * 어댑터의 정규식 옆에 "이 파일의 어느 줄인가" 를 주석으로 적어 두었다.
 *
 * 집(aio/node)의 관례를 따른다. 특히 모니터의 발견 줄은 세 사이트가 같은 모양이다 —
 * 첫 묶음이 **상품 주소**여야 한다 (monitorManager.ts 가 그걸로 알림을 만든다):
 *     [dry-run] 여기서 … 눌렀을 것입니다 — <상품 주소>
 *
 * 앞에 붙는 기호(✔ · ▸ ★)는 log.ts 가 kind 로 정한다 — 여기서는 글자만 정한다.
 */

export const LINES = {
  /* ── 감시 ─────────────────────────────────────────────── */
  /** 실제로 살 때의 발견 줄 (어댑터 progress.buying 이 이 줄을 본다) */
  found: (what: string) => `발견 — ${what}`,
  /**
   * 드라이런(모니터)의 발견 줄. **세 사이트 공통 모양** — 첫 묶음이 상품 주소다.
   * 어댑터 monitorSignal.found 가 이 줄에서 주소를 뽑는다.
   */
  foundDry: (url: string) => `[dry-run] 여기서 결제하기를 눌렀을 것입니다 — ${url}`,
  /** 재고 판정. 어댑터 monitorSignal.stock */
  stockIn: (what: string) => `재고 있음 — ${what}`,
  stockOut: (what: string) => `품절 — ${what}`,
  /** 한 바퀴. 어댑터 progress.round (회차를 여기서 센다) */
  round: (n: number, products: number, seconds: number) => `확인 ${n}회 · 상품 ${products}개 · ${seconds}초 걸림`,
  /** 제자리에서 고쳐 쓰는 줄. 어댑터 progress.countdown */
  countdown: (sec: number) => `다음 확인 ${sec}초`,
  /** 새 상품 / 새 사이즈 / 재입고 */
  newProduct: (what: string) => `새 상품 — ${what}`,
  newVariant: (what: string) => `새 사이즈 — ${what}`,
  restock: (what: string) => `재입고 — ${what}`,

  /* ── 구매 ─────────────────────────────────────────────── */
  buying: (what: string) => `구매 시작 — ${what}`,
  carted: (count: number, what: string) => `장바구니에 담았습니다 (${count}개) — ${what}`,
  /** 체크아웃 단계. 어댑터 progress.checkout */
  checkout: (step: string) => `체크아웃 — ${step}`,
  /** 캡차 창을 띄웠다 (사람이 풀 차례). 어댑터가 이 줄을 보면 "사람 차례" 로 표시한다. */
  captchaWindow: (detail: string) => `캡차 — 사람이 풀 차례입니다 (${detail})`,
  captchaSolved: (seconds: number) => `캡차를 풀었습니다 (${seconds}초) — 이어서 진행합니다`,
  /** 카드사 추가 인증(3DS) */
  threeDs: () => `추가 인증(3DS) — 카드사 인증을 창에서 완료해 주세요`,
  /** 결제 완료. 어댑터 progress.paid */
  paid: (orderNo: string) => `결제 완료 — 주문 ${orderNo}`,
  /** 결제 직전에서 멈춤 (수동 결제 모드) */
  stoppedBeforePay: () => `결제 버튼 앞에서 멈췄습니다 — 창에서 직접 눌러 주세요`,

  /* ── 사람 개입이 필요한 상태 ──────────────────────────── */
  /** 봇 차단·사람 확인 화면. 어댑터는 이 줄을 보면 창을 사람에게 보여 준다. */
  blocked: (detail: string) => `사람 확인이 필요합니다 — ${detail}`,
  /** 세션 끊김. 어댑터 session.deadLine 이 이 줄을 본다. */
  sessionDead: (detail: string) => `로그인이 풀렸습니다 — ${detail}`,
  failed: (step: string, reason: string) => `${step} 실패 — ${reason}`,
  stopped: (reason: string) => `멈췄습니다 — ${reason}`,
  ready: (detail: string) => `준비됨 — ${detail}`,
  paidState: (orderNo: string, what: string) => `이미 산 기록이 있습니다 — ${orderNo} · ${what}`,
} as const;

/**
 * 어댑터가 그대로 옮겨 적는 정규식 (한쪽만 고치는 사고를 막으려고 원문을 여기 적어 둔다).
 * 어댑터(src/main/sites/supreme.ts)의 같은 이름과 **글자까지 같아야** 한다.
 */
export const LINE_PATTERNS = {
  /** LINES.foundDry — 첫 묶음이 상품 주소 */
  foundDry: /\[dry-run\] 여기서 결제하기를 눌렀을 것입니다 — (\S+)/,
  /** LINES.found */
  found: /발견 — /,
  /** LINES.stockIn / stockOut */
  stockIn: /재고 있음 — (.+)$/,
  stockOut: /품절 — (.+)$/,
  /** LINES.round */
  round: /확인 (\d+)회 · 상품 (\d+)개 · (\d+)초 걸림/,
  /** LINES.countdown (제자리에서 고쳐 쓰는 줄) */
  countdown: /다음 확인 (\d+)초/,
  /** LINES.buying */
  buying: /구매 시작 — /,
  /** LINES.checkout */
  checkout: /체크아웃 — /,
  /** LINES.paid */
  paid: /결제 완료 — 주문 (.+)$/,
  /** LINES.blocked */
  blocked: /사람 확인이 필요합니다 — /,
  /** LINES.captchaWindow — 사람이 손댈 차례라는 표시 */
  captchaWindow: /캡차 — 사람이 풀 차례입니다/,
  /** LINES.sessionDead */
  sessionDead: /로그인이 풀렸습니다 — /,
} as const;

/** 결제 완료 줄에서 주문번호만. */
export function orderNoFrom(line: string): string {
  const m = LINE_PATTERNS.paid.exec(line);
  return m?.[1] ? m[1].trim() : "";
}
