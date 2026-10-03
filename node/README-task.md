# 통합 태스크 러너 — bnkr-test + lotte-test 한 프로그램으로

bnkr-test(반다이남코코리아몰, 네이버페이)와 lotte-test(롯데온)를 **한 프로세스에서
동시에** 돌리는 판이다. 감시 대상은 `task_config.json` 의 태스크 목록으로 관리한다 —
사이버슐 같은 태스크 그리드 화면에서 어느 태스크가 무슨 상태인지 한눈에 본다.

```
node dist/task/index.js                 두 사이트를 동시에 지켜본다
node dist/task/index.js list            태스크 표
node dist/task/index.js add --site bnkr|lotte 상품 [옵션]
node dist/task/index.js remove bnkr|lotte 키
node dist/task/index.js pause|resume bnkr|lotte 키
node dist/task/index.js status [bnkr|lotte]
node dist/task/index.js cookie bnkr|lotte [쿠키]
node dist/task/index.js pin bnkr|lotte [비밀번호]
```

윈도우에서는 `..\run-cyber-node.bat` 이 빌드까지 해 주고 뒤에 붙인 옵션을 그대로 넘긴다.
npm 스크립트는 `npm run cyber` · `cyber:list` · `cyber:status` · `cyber:add` · `cyber:cookie` · `cyber:pin`.

## 태스크 목록 — task_config.json

`task_config.json` 이 감시 대상의 **주인**이다. 처음 켜면 기존 사이트 설정
(bnkr_test_config.json · lotteon_test_config.json)의 targets 를 베껴 만든다.

```json
{
  "tasks": [
    { "site": "bnkr",  "product": "42301299", "ea": 1, "mode": "DIRECT",
      "max_price": 48000, "label": "원피스 카드게임 - 창해의 칠걸 (BOX)" },
    { "site": "lotte", "product": "https://www.lotteon.com/p/product/LM8800305760362?sitmNo=LM8800305760362_001",
      "ea": 1, "option": "", "max_price": 0, "label": "" }
  ]
}
```

- `site` — `bnkr` 또는 `lotte`. 어느 사이트의 상품인지.
- `product` — bnkr 는 gno(숫자), lotte 는 상품 주소(또는 상품번호).
- `mode` — bnkr 전용. `ADD`(장바구니) · `DIRECT`(바로구매) · `GIFT`(선물하기).
- `option` — lotte 전용. 옵션 상품이면 무엇을 고를지.
- `ea` · `max_price` · `label` — 수량 · 상한가 · 표시 이름.
- `paused` — `true` 로 두면 감시에서 뺀다(설정과 기록은 남는다).

**사이트별 설정(쿠키·결제수단·브라우저·주기·동시성)은 기존 파일을 그대로 쓴다.**
여기서 다시 적지 않는다 — bnkr 쪽은 `bnkr_test_config.json`, lotte 쪽은
`lotteon_test_config.json`. 이 러너는 그 파일들의 `targets` 만 task_config.json 의
내용으로 맞춰 쓸 뿐, 다른 키는 건드리지 않는다.

## 실시간 반영

돌아가는 동안 `task_config.json` 을 고치면(또는 `task add` · `task pause` 등을 다른
창에서 부르면) 1초 안에 사이트별 목록에 반영된다. 재시작이 필요 없다. 도는 루프가 자기
설정 파일이 바뀐 것을 보고 목록을 갈아 끼운다 — bnkr 루프는 `configStamp`, lotte 루프는
targets 비교를 쓴다(기존 판과 같은 동작).

## 화면

터미널이면 화면을 매 초 통째로 다시 그린다 — 위는 태스크 표, 아래는 지나간 로그 꼬리.
기다리는 줄(banner·status)은 표가 대신 말해 주므로 눌러 지우지 않는다. 파일로 넘길
때(TTY 아님)는 평범한 줄 모드로 돌아간다.

## 성능 — 두 사이트를 한 프로세스로 돌려도 느려지지 않는다

이 러너는 bnkr 루프와 lotte 루프를 **나란히** 시작하고(`Promise.all`), 각 루프는
기존 판의 코드를 그대로 쓴다. 둘 다 I/O 바운드(async fetch)라 이벤트 루프가 두 루프를
알아서 섞어 준다 — bnkr 루프의 조회·담기는 bnkr 설정의 `max_concurrency` 와 주기가,
lotte 루프는 lotte 설정의 그것이 그대로 적용된다. 각 사이트의 요청 빈도와 동시성은
따로 돌릴 때와 **똑같다**. 조회 주기도 사이트별 설정(`poll_interval_seconds`)을 그대로
쓴다.

한 루프가 죽어도(bnkr 세션 만료 등) 다른 쪽은 계속 돈다. 둘 다 죽었을 때만 실패로
끝난다.

## 로그

- `task-buy.log` — 러너 자신의 말
- `bnkr-test-buy.log` — bnkr 루프 (기존과 같은 파일)
- `lotteon-test-buy.log` — lotte 루프 (기존과 같은 파일)
- 상태 파일(`bnkr_test_state.json` · `lotteon_test_state.json`)도 기존 것 그대로 쓴다.

## 쿠키

두 사이트가 각자 자기 쿠키를 쓴다(각 사이트 설정 파일, 비어 있으면 본판에서 빌려 온다).
처음 켜기 전에:

```
task cookie bnkr     (클립보드의 bnkr Cookie 줄)
task cookie lotte    (클립보드의 lotte Cookie 줄)
```
