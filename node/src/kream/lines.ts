/**
 * 로그 줄 규약 — **한 곳에 모아 둔다.**
 *
 * 데스크톱 대시보드의 어댑터(desktop/src/main/sites/kream.ts)가 이 줄들을 정규식으로 읽어 화면의 회차·단계·진행을
 * 그린다. 그래서 문구를 바꾸면 **양쪽을 같이** 고쳐야 한다. 어댑터의 정규식 옆에 "이 파일의 어느 줄인가" 를 적어 두었다.
 *
 * 모니터의 발견 줄은 사이트들이 같은 모양이다 — 첫 묶음이 **상품 주소**여야 한다 (monitorManager.ts 가 그걸로 알림을 만든다):
 *     [dry-run] 여기서 … 눌렀을 것입니다 — <상품 주소>
 */

export const LINES = {
  /* ── 감시 ─────────────────────────────────────────────── */
  /** 드라이런(모니터)의 발견 줄. 어댑터 monitorSignal.found 가 이 줄에서 주소를 뽑는다. */
  foundDry: (url: string) => `[dry-run] 여기서 구매하기를 눌렀을 것입니다 — ${url}`,
  /** 재고 판정. 어댑터 monitorSignal.stock */
  stockIn: (what: string) => `재고 있음 — ${what}`,
  stockOut: (what: string) => `품절 — ${what}`,
  /** 한 바퀴. 어댑터 progress.round (회차를 여기서 센다) */
  round: (n: number, products: number, seconds: number) => `확인 ${n}회 · 상품 ${products}개 · ${seconds}초 걸림`,
  restock: (what: string) => `재입고 — ${what}`,
  /** 상품 이름. 어댑터 productNameLine */
  product: (name: string, price: string) => `상품 — ${name} · ${price}`,

  /* ── 대기열 (wait.kream.co.kr) ────────────────────────── */
  /** 어댑터 progress.queue — 묶음: 1 내 앞 인원 */
  queue: (ahead: number | null) => (ahead === null ? "대기열에 들어왔습니다 — 차례를 기다립니다" : `대기열 내 앞 ${ahead.toLocaleString("en-US")}명`),
  /** 어댑터 progress.queueDone */
  queueDone: (seconds: number) => `대기열을 통과했습니다 (${seconds}초)`,

  /* ── 구매 ─────────────────────────────────────────────── */
  /** 어댑터 progress.buying · busy.start */
  buying: (what: string) => `구매 시작 — ${what}`,
  option: (text: string) => `옵션을 골랐습니다 — ${text}`,
  /** 어댑터 progress.checkout */
  checkout: (step: string) => `주문서 — ${step}`,
  /** 결제 비밀번호를 대신 누르기 시작한다 (프로필에 6자리가 있을 때) */
  pinTrying: (digits: number) => `결제 비밀번호 — 자판에서 ${digits}자리를 누릅니다`,
  /** 다 눌렀다 — 이제 주문 완료를 기다린다 (여기서 중지하면 결제 결과를 못 남긴다) */
  pinEntered: () => `결제 비밀번호를 넣었습니다 — 결제 승인을 기다립니다 (끝날 때까지 중지하지 마세요)`,
  /** 대신 누르지 못했다 (자판을 못 읽었거나 안 먹혔다) — 사람에게 넘긴다 */
  pinMissed: (why: string) => `결제 비밀번호를 대신 넣지 못했습니다 (${why}) — 창을 사람에게 넘깁니다`,
  /** 결제 비밀번호를 사람이 넣을 차례 */
  pinHandoff: (why: string) => `결제 비밀번호 — 창에서 직접 넣어 주세요 (${why})`,
  stoppedAtOrder: () => `주문서에서 멈췄습니다 — 창에서 확인하고 결제해 주세요`,
  /** 어댑터 progress.paid */
  paid: (orderNo: string) => `결제 완료 — 주문 ${orderNo}`,

  /* ── 사람 개입이 필요한 상태 ──────────────────────────── */
  /** 어댑터 session.deadLine 이 이 줄을 본다. */
  sessionDead: (detail: string) => `로그인이 풀렸습니다 — ${detail}`,
  failed: (step: string, reason: string) => `${step} 실패 — ${reason}`,
  paidState: (orderNo: string, what: string) => `이미 산 기록이 있습니다 — ${orderNo} · ${what}`,
  dumped: (path: string) => `화면을 담아 두었습니다 — ${path}`,
} as const;
