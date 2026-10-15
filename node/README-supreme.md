# 슈프림 (shop.supreme.com — Shopify)

재고 감시 + 자동구매. **캡차(hCaptcha)는 사람이 풉니다** — 캡차가 뜨면 캡차만 보이는 창을 띄웁니다.

```
원본(CLI)   aio/node/src/supreme/           ← 롯데·반다이남코와 같은 프로젝트, 같은 빌드
어댑터      aio/desktop/src/main/sites/supreme.ts
화면        aio/desktop/src/renderer (사이트 칩·색은 자동, 문구만 넣었다)
시험        node dist/supreme/selftest.js [--browser]
```

## 0. 처음 할 일 — **배송 정보를 채운다**

씨앗 설정 `aio/node/supreme_config.json` 을 열어 `profile` 을 채우세요 (대시보드 설정 창에서 그 파일 위치를 볼 수 있다).
태스크는 띄울 때 이걸 베낀다.

**비어 있으면 담지 않습니다.** 2026-10-08 에 빈 채로 돌아서 장바구니에 담고 주문서에서야
"0칸 입력" 으로 멈췄다 — 그 뒤로는 **담기 전에 멈추고 무엇이 빠졌는지 줄줄이 알려 준다**:

```
✖  배송 정보가 비어 있어 주문서를 채울 수 없습니다 — 담지 않았습니다.
✖     이 태스크의 설정: …\task-homes\<id>\supreme_config.json
✖     · profile.email (이메일)
✖     · profile.card_number (카드 번호)
✖     결제까지 가려면 카드 정보도 있어야 합니다 (없으면 buy.click_pay 를 false 로).
```

감시(지켜보기·드라이런)는 배송 정보 없이도 돈다 — 담기 직전에만 막는다.

## 0-1. 사이즈는 별칭까지 맞춘다

사람은 `L` 이라고 적고 사이트는 `Large` 라고 쓴다. 이걸 못 맞춰서 **원하는 L 을 두고 Small 을 담은 적이 있다**
(2026-10-08, 그때 Large 는 재고가 있었다). 이제 `L`=Large · `XL`=XLarge · `XXL`=XXLarge · `M`=Medium · `270`=270 로 맞춘다.

원하는 사이즈가 **없으면 사지 않는다** (기본). 다른 사이즈로도 사고 싶으면 설정의 `buy.size_fallback` 을 `true` 로.

```
✖  [cvfbegdsyzwk3nd] 원하는 사이즈(L)가 없습니다 — 재고: Small, Medium, XLarge
      엉뚱한 사이즈를 담지 않았습니다. 다른 사이즈도 괜찮으면 설정의 buy.size_fallback 을 true 로 두세요.
```

## 1. 실제 사이트에서 확인한 것 (2026-10-08, 읽기만)

| 확인 | 결과 |
|---|---|
| `/collections/all` | 200 — 다만 **`/pages/shop` 으로 넘어가고 목록은 JS 로 그려진다** (기다렸다 긁어야 한다) |
| `/collections/all/products.json` | **403** (사람 확인 HTML) |
| `/products/<handle>.js` | **403** |
| `/products/<handle>` (상품 페이지) | 200 — 안에 `<script type="application/json" id="product-<handle>-json">` 로 **variant 전체**(사이즈·재고·id) |
| `/cart.js` · `/cart` | **200** (장바구니 API 는 막히지 않았다) |
| 목록 규모 | 상품 209개 · 재고 있음 126개 |
| 옵션 | **`Size` 하나뿐** (색은 상품 이름에 들어 있다 — `… - Predator Camo`) |
| 가격 | KRW, 화면 단위 878,000 (JSON 은 최소 단위 87,800,000 → 코드가 100 으로 나눈다) |
| 봇 차단 | 평소에는 뜨지 않는다. 떴을 때는 **창을 사람에게 넘기고 기다린다** (자동으로 뚫지 않는다) |

그래서 이 모듈은 **셀렉터 대신 Shopify 표준 경로**를 쓴다:
목록은 `products.json` → 막히면 페이지 HTML, variant 해석은 `.js` → 막히면 **상품 페이지의 임베디드 JSON**,
담기는 `POST /cart/add.js`, 확인은 `GET /cart.js`. 셀렉터는 체크아웃(사람이 보는 그 화면)에만 쓴다.

## 2. 어떻게 도나

```
확인(2.5초) → 새 상품/새 사이즈/재입고 발견 → 규칙(키워드·사이즈·색·상한가) 통과
   → 사이즈 고르기(우선순위) → POST /cart/add.js → /checkout
   → 배송 정보 입력 → **캡차가 뜨면 캡차 전용 창을 띄우고 사람이 풀 때까지 기다린다**
   → 배송 방법 → 카드 입력(card-fields-* iframe 안) → 결제 버튼 → 주문 완료(주문번호)
```

* 감시는 크롬을 **화면 밖**에 두고 돈다 (`--window-position=-32000,-32000`). headless 가 아니다 — 사이트에는 평소의 크롬으로 보인다.
* 캡차 차례가 되면 **캡차만 보이는 창 하나만** 화면 안으로 올라온다 (`captcha.mode: hide`).
* 카드사 인증(3DS)이 뜨면 그것도 사람에게 넘기고 기다린다.
* 어느 단계든 실패하면 창을 사람에게 보여 주고 멈춘다 — 조용히 틀린 주문을 넣지 않는다.

## 3. 돌리기

```bat
:: 대시보드에서 (권장) — 태스크를 만들고 ▶
cd aio\desktop && npm start

:: 손으로 (원본)
cd aio\node && npm run build
npm run supreme                                  감시하며 사기 (설정의 targets)
npm run supreme -- --watch --dry-run             계속 감시만 (모니터가 쓰는 모드)
npm run supreme -- --once                        한 바퀴만
npm run supreme -- --buy https://shop.supreme.com/products/<handle> --ea 1
npm run supreme -- --status                       한 번 조회 (재고 목록)
npm run supreme -- --whoami                       세션 살아 있나
npm run supreme -- --cookie                       Cookie 줄을 붙여넣어 저장 (Ctrl+Z, Enter)
npm run supreme -- --reset                        산 기록 지우기
npm run supreme:selftest -- --browser             모의 상점 왕복 시험 (진짜 크롬)
```

`SUPREME_HOME` 이 그 판의 집이다 — 설정·상태·로그·**크롬 프로필**이 전부 그 안에 있다.
대시보드는 태스크마다 다른 홈을 준다.

## 4. 설정 (`<SUPREME_HOME>/supreme_config.json`)

씨앗 설정은 `aio/node/supreme_config.json` 에 두면 태스크가 그걸 베껴 온다 (대시보드 설정 창에서 위치를 바꿀 수 있다).

```jsonc
{
  "origin": "https://shop.supreme.com",
  "collections": ["all"],
  "check_interval_ms": 2500,        // 2500 미만은 차단 위험 (대시보드도 2.5초 밑으로 못 내린다)
  "max_retries": 3, "retry_delay_ms": 5000,
  "include_keywords": [],           // 비우면 전부. 예: ["Box Logo", "Track Jacket"]
  "exclude_keywords": ["gift card"],
  "sizes": [],                      // 비우면 전부
  "max_price": 0,                   // 0 = 없음 (화면 단위)
  "detect_restock": true, "detect_new_variant": true, "silent_first_scan": true,
  "buy": {
    "enabled": true,
    "quantity": 1,
    "size_priority": ["Large", "Medium", "X-Large", "Small"],  // 없으면 이 순서로 내려간다
    "size_fallback": false,          // 원하는 사이즈가 없을 때 다른 사이즈로 대체할지 (기본 false = 안 산다)
    "fill_shipping": true,
    "fill_payment": true,
    "click_pay": true,              // false = 결제 버튼 앞에서 멈춘다
    "stop_after_success": true,
    "max_buys_per_run": 1,
    "shipping_prefer": "cheapest",
    "three_ds_handoff": true, "handoff_on_failure": true
  },
  "profile": {
    "email": "…", "first_name": "…", "last_name": "…",
    "address1": "…", "address2": "", "city": "…", "state": "…", "zip": "…",
    "country": "KR", "phone": "…",
    "card_number": "…", "card_expiry": "MM/YY", "card_cvv": "…", "card_holder": "…"
  },
  "captcha": {
    "mode": "hide",                 // hide = 캡차만 남긴다 · dim = 흐리게만
    "timeout_ms": 180000, "refresh_ms": 1000,
    "banner": "hCaptcha를 직접 풀어 주세요. 다 풀면 자동으로 이어서 진행합니다."
  },
  "browser": { "headless": false, "offscreen": true },
  "discord_webhook_url": "",
  "targets": [ { "url": "https://shop.supreme.com/products/<handle>", "option": "Large", "ea": 1, "max_price": 0, "label": "" } ]
}
```

**카드 정보가 평문으로 저장된다.** 이 파일을 Git 에 올리지 말고, 그 PC 안에서만 쓰세요.
(대시보드 프로필의 결제 비밀번호 같은 암호화는 슈프림에 해당 없다 — 슈프림은 간편결제 PIN 을 쓰지 않는다.)

## 5. 캡차 창

* 캡차가 뜨면 **캡차 전용 창**(같은 크롬 프로필의 새 창)이 화면 안으로 올라오고, 그 창에서는 캡차 말고 나머지가 치워진다.
* 안내 띠에 "직접 풀어 주세요" 가 뜨고, 풀면(토큰이 폼에 들어가면) **1초 안에 알아채고 이어서 진행**한다.
* 캡차가 다시 그려져도 집중 모드는 1초마다 다시 걸린다.
* 창을 못 열면 보고 있던 창을 화면 안으로 옮긴다 (그래도 사람은 풀 수 있다).
* 디스코드 웹훅이 있으면 "캡차가 떴습니다" 를 폰으로도 알린다.
* **자동으로 풀지 않는다.** 대신 풀지도 않는다 — 못 풀면 그 판은 멈추고 그렇게 말한다.

## 6. 셀렉터·DOM 이 바뀌었을 때

체크아웃은 테마가 바뀌면 셀렉터가 어긋난다. 그때는:

```
node dist/supreme/selftest.js --browser     모의 상점으로 어디가 깨졌는지 본다
```

그리고 `aio/node/src/supreme/checkout-fill.ts` 의 `FIELD_SELECTORS` 를 실제 DOM 에 맞춘다
(각 칸마다 후보가 여러 개라 보통은 그대로 돈다). 브라우저에서 직접 보려면 열린 창에서
`document.querySelector('input[name="email"]')` 따위로 확인하면 된다.

`src/supreme/` 안에서 손볼 곳:

| 파일 | 하는 일 |
|---|---|
| `index.ts` | 명령줄·모드·구매 흐름 |
| `config.ts` | 집(SUPREME_HOME)·설정·상태 |
| `site.ts` | Shopify 경로 (목록·variant 해석·담기·장바구니·페이지 상태) |
| `match.ts` | 상품 정규화·발견(diff)·필터·variant 고르기 — 순수 함수 |
| `watch.ts` | 감시 루프·물러서기(backoff) |
| `browser.ts` | 크롬·창·프레임·캡차 전용 창 |
| `captcha.ts` | 캡차 감지·집중 모드·토큰 |
| `captcha-window.ts` | 사람을 부르고 기다리는 흐름 |
| `checkout-fill.ts` | 체크아웃 칸 (셀렉터 사전) |
| `checkout.ts` | 담기 → 체크아웃 → 결제 상태 기계 |
| `lines.ts` | 로그 줄 규약 (**어댑터 정규식과 짝**) |
| `notify.ts` | 디스코드 |
| `mock-shop.ts` · `selftest.ts` | 모의 상점 · 시험 |

## 7. 대시보드 쪽에서 알아 둘 것

* `SITES.supreme.modes` = 지켜보기 · 한 번만 · 지금 구매 · 드라이런 · 재고만 (**드랍 없음**)
* `SITES.supreme.actions` = 없음 — "어디까지" 는 설정의 `buy.click_pay` 가 정한다 (기본: 결제 버튼까지)
* `loginOptional` = 전부 — 게스트 체크아웃이라 **로그인 없이도 산다**
  (프로필을 고르면 사람 확인 통과 쿠키 `cf_clearance` 를 물려준다. `/account` 로 판정한다)
* `monitors: true` — 모니터는 `--watch --dry-run` 으로 돌고, 발견 줄은 `[dry-run] 여기서 구매하기를 눌렀을 것입니다 — <주소>`
* `oneTaskPerProfile: true` — 같은 프로필로 동시에 결제하면 같은 장바구니를 밟는다
* `liveFields: []` — **돌던 중에 설정을 고치면 다시 시작해야 반영된다**
* `stopGraceMs: null` — 캡차·3DS 를 사람이 끝낼 때까지 기다린다 (죽이면 결제하던 창이 닫힌다)
* `prepare` = `원본 빌드 (npm run build)` — 태스크 홈 옆 `aio/node` 를 굽는다

## 8. 시험

```
node dist/supreme/selftest.js              순수 로직 63개 (정규화·diff·필터·캡차·스크립트·로그 줄 짝)
node dist/supreme/selftest.js --browser    + 진짜 크롬으로 모의 상점 왕복
```

`--browser` 가 확인하는 것 (전부 통과):

```
목록(products.json) → 품절 구분 → products/<handle>.js → 담기(cart/add.js) → 장바구니 수량
→ 체크아웃 배송정보 7칸 → 가짜 hCaptcha 감지 → 캡차만 남기는 집중 모드 → 캡차 iframe 찾기
→ 사람이 풀면 토큰이 폼에 들어옴 → 캡차 전용 창에서 풀고 이어서 진행
→ 배송 방법 → 카드 3칸(iframe 안) → 결제 버튼 → 주문 완료(MOCK-123456)
그리고 products.json·.js 가 403 인 상점(=진짜 슈프림)에서 상품 페이지 JSON 으로 variant 를 얻어 발견 줄까지
```

## 9. 한계와 주의

* **사이트 이용약관**이 자동구매를 금지할 수 있다. 개인 사용 범위에서, 요청 간격을 과하게 줄이지 말고 쓸 것.
  기본 2.5초·지터 0.4초는 그 선을 넘지 않으려는 값이다.
* 카드 정보 평문 저장 (위 4절), 3DS 는 사람이 끝내야 한다.
* Supreme 의 상품 페이지 JSON 구조가 바뀌면 `site.ts` 의 `productPageScript` 정규식을 고쳐야 한다
  (`id="product-…-json"` 이 그대로인 한 잘 돈다).
* 목록 HTML 파싱은 카드에 "Sold Out" 글자가 있다는 전제다. 품절 상품이 목록에서 아예 빠지면
  **재입고는 "새 상품" 으로 잡힌다** (동작에는 문제 없다).
