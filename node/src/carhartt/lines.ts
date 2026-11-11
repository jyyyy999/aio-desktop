/**
 * 로그 줄 규약 — **한 곳에 모아 둔다** (kream/lines.ts 와 같은 모양).
 *
 * 데스크톱 어댑터를 붙이면 이 줄들을 정규식으로 읽게 된다. 그때 문구를 바꾸면 양쪽을 같이 고쳐야 하므로, 다른 사이트와
 * 같은 줄은 같은 글자로 맞춰 두었다 (발견 줄의 첫 묶음은 상품 주소 · "구매 시작 — " · "주문서 — " · "로그인이 풀렸습니다 — ").
 */
export const LINES = {
  /** 드라이런의 발견 줄. 첫 묶음이 상품 주소다. */
  foundDry: (url: string) => `[dry-run] 여기서 구매하기를 눌렀을 것입니다 — ${url}`,
  stockIn: (what: string) => `재고 있음 — ${what}`,
  stockOut: (what: string) => `품절 — ${what}`,
  restock: (what: string) => `재입고 — ${what}`,
  /** 한 바퀴. 어댑터 progress.round 가 회차를 여기서 센다. */
  round: (n: number, products: number, seconds: number) => `확인 ${n}회 · 상품 ${products}개 · ${seconds}초 걸림`,
  product: (name: string, price: string) => `상품 — ${name} · ${price}`,

  buying: (what: string) => `구매 시작 — ${what}`,
  option: (text: string) => `옵션을 골랐습니다 — ${text}`,
  checkout: (step: string) => `주문서 — ${step}`,
  stoppedAtOrder: () => `주문서에서 멈췄습니다 — 창에서 확인하고 결제해 주세요`,

  /** --action submit: 결제하기를 눌러 비밀번호 창까지 갔다. */
  pinOpened: () => `결제 비밀번호 창을 열었습니다 — 창에서 6자리를 넣어 주세요`,
  /** 프로필의 비밀번호로 자판을 눌렀다 (값은 어디에도 적지 않는다 — 자릿수만). */
  pinEntered: () => `결제 비밀번호 6자리를 넣었습니다`,
  paid: (orderNumber: string) => `결제 완료 — 주문 ${orderNumber || "번호는 창에서 확인해 주세요"}`,
  pinWaiting: (why: string) => `결제는 창에서 마저 해 주세요 — ${why}`,

  loggedIn: (who: string) => `로그인됨 — ${who}`,
  noSession: () => `저장된 로그인이 없습니다 — --login 으로 로그인해 주세요`,
  loggedOut: () => `로그인되어 있지 않습니다 — 저장된 토큰이 만료됐습니다`,
  sessionDead: (detail: string) => `로그인이 풀렸습니다 — ${detail}`,
  failed: (step: string, reason: string) => `${step} 실패 — ${reason}`,
} as const;
