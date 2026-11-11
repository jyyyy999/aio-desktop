# aio — 한정판 구매 태스크 관리 데스크톱 앱

사이트마다 따로 만든 구매 원본(콘솔 프로그램)을 **한 줄도 고치지 않고** 태스크마다 따로 띄워, 한 화면에서 켜고 끄고
지켜보는 Electron + React 앱이다. 재고 감시 → 담기·주문서 → (켜 두면) 간편결제 비밀번호까지 간다.

## 사이트

| 사이트 | 원본 | "어디까지" | 알아 둘 것 |
|---|---|---|---|
| 롯데온 | `node/src/lotte-test` | 주문서 · 필수 동의 · 결제창 | 대기열(순번)을 지나야 산다 |
| 네이버 스마트스토어 | `../naver/ts` (따로 저장소) | 주문서 · 결제 단계 | 조회도 로그인 세션으로 한다 — 모니터에도 프로필이 있어야 한다 |
| 반다이남코 | `node/src/bnkr-test` | 주문서 · 필수 동의 · 결제 단계 | 결제는 네이버페이 |
| 슈프림 | `node/src/supreme` | (원본 설정이 정한다) | Shopify 게스트 체크아웃 — 로그인 없이도 산다 |
| KREAM 브랜드배송 | `node/src/kream` | 주문서 · 결제하기 | 로그인된 크롬이 상품 페이지를 다시 읽다가 같은 창에서 누른다 |
| 칼하트윕 | `node/src/carhartt` | 주문서 · 결제 비밀번호 | 재고는 공개 API (사이즈마다 수량, 0.5초까지). 구매 태스크는 켤 때 크롬을 미리 띄워 둔다 |

사이트마다의 동작·로그인·주의할 점은 [desktop/README.md](desktop/README.md) 의 사이트별 절에 있다.

## 저장소 짜임

| | |
|---|---|
| `desktop/` | 데스크톱 앱 (Electron · React). 태스크·모니터·프로필·발매정보 화면, 원본을 태스크마다 따로 띄우는 매니저 |
| `node/` | 앱이 띄우는 원본들 (롯데온 · 반다이남코 · 슈프림 · KREAM · 칼하트윕) 과 그것들이 같이 쓰는 조각 (로그·화면·크롬 다루기) |
| `../naver/ts` | **네이버 원본** — 따로 저장소 [naver-ts](https://github.com/jyyyy999/naver-ts) |

앱은 원본을 **폴더 자리로** 찾는다 — `aio/desktop` 옆의 `aio/node`, 그리고 `aio` 옆의 `naver/ts`.
그래서 두 저장소를 이 배치대로 받는다.

```
project/
├─ aio/
│  ├─ desktop/        ← 앱
│  ├─ node/           ← 원본들
│  └─ lotteon_test_config.json   ← 씨앗 설정 (직접 만든다)
└─ naver/
   ├─ ts/             ← 네이버 원본
   └─ smartstore_config.json     ← 씨앗 설정 (직접 만든다)
```

```
renderer (React) ──ipc──▶ main (TaskManager · MonitorManager · SessionManager) ──fork──▶ worker ──import──▶ 원본
                           └─ desktop/src/main/sites/<사이트>.ts   (사이트마다 다른 것은 전부 여기)
```

원본은 따로 fork 한 프로세스에서 돈다 — 하나가 터져도 앱과 다른 태스크는 산다. 앱은 원본이 찍는 줄을 읽어 진행
(회차·구매 시작·주문서·결제 완료)을 그린다. 그 줄의 문구는 원본마다 `lines.ts` 한 곳에 모아 두었다.

## 새 PC 에서

```bash
mkdir project && cd project
git clone https://github.com/jyyyy999/aio-desktop.git aio
mkdir naver && git clone https://github.com/jyyyy999/naver-ts.git naver/ts
```

```bash
cd aio/node && npm install && npm run build      # 원본들 (앱에서 '원본 빌드' 로도 된다)
cd ../../naver/ts && npm install                  # 네이버 원본 (tsx 로 바로 돈다)
cd ../../aio/desktop && npm install && npm start  # 앱
```

맥에서 쓸 때는 [README-macos.md](README-macos.md) — 윈도우와 다른 것만 따로 적었다.

**윈도우 사용자 폴더가 한글이면**(`C:\Users\제영`) `electron.exe` 가 그 아래에서 말없이 죽는다. `npm start` 가 Electron 을
영문 경로(`C:\aio-electron\<버전>`)에 한 번 복사해 두고 거기서 띄우므로 따로 할 일은 없다.

## 저장소에 없는 것

| | 왜 · 어떻게 |
|---|---|
| 씨앗 설정 (`*_config.json`) | 쿠키·간편결제 비밀번호·웹훅·결제창 자동 입력 값이 들어 있다. 비밀값을 비운 `*.example.json` 만 있다 — 복사해 `.example` 을 빼고 채우거나 원래 PC 의 파일을 옮겨 온다 |
| `node_modules` | `desktop/node_modules` 만 459MB 이고 `electron.exe` 가 GitHub 파일 한도(100MB)를 넘는다. `package-lock.json` 이 있어 `npm install` 이 같은 판을 깐다 |
| KREAM 결제 비밀번호 입력 코드 (`node/src/kream/pin.ts`) | `.gitignore` 에 있다. 원본이 불러오므로 새 PC 에서는 원래 PC 의 파일을 같은 자리에 넣어야 `npm run build` 가 된다 |
| 로그인 토큰·크롬 프로필 (`carhartt-session.json` · `*-chrome-profile/` 등) | 계정 그 자체다. 앱에서 다시 로그인하면 생긴다 |
| 앱 데이터 (`%APPDATA%/aio-task-manager/`) | 프로필(로그인·암호화한 결제 비밀번호·자동 로그인 정보)·태스크 목록·설정·태스크마다의 로그. 암호화한 것은 그 PC 의 그 윈도 계정에서만 풀리므로 새 PC 에서는 다시 넣는다 |

```bash
cp aio/lotteon_test_config.example.json aio/lotteon_test_config.json
cp naver/ts/smartstore_config.example.json naver/smartstore_config.json
```

**이 저장소는 공개다.** 위 표의 것들은 `.gitignore` 가 막지만, 새 파일을 더할 때 비밀값이 들어가지 않았는지 커밋 전에 본다.
