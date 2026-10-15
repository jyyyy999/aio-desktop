# aio — macOS 에서 쓰기

앱과 원본은 윈도우 PC 에서 만들고 써 왔다. 맥에서도 같은 코드가 돈다 — Node·Electron·셀레니움·Playwright 가
전부 맥을 받는다. 다만 **윈도우에만 맞춰 둔 자리가 몇 군데** 있어서 그것만 따로 적는다. 나머지 쓰는 법은
[README.md](README.md) · [desktop/README.md](desktop/README.md) 와 같다.

## 준비물

| | |
|---|---|
| Node.js | 20 이상 (만든 PC 는 24). `brew install node` 또는 nodejs.org 설치본 |
| Git | `xcode-select --install` 이면 같이 깔린다 |
| Google Chrome | `/Applications/Google Chrome.app`. 롯데·반다이·슈프림이 셀레니움으로 띄운다. 크롬드라이버는 셀레니움이 처음 띄울 때 알아서 받는다 (그래서 첫 실행은 인터넷이 있어야 한다) |

## 받기

윈도우와 같은 배치다. 앱이 원본을 **폴더 자리로** 찾기 때문에 이 모양을 지켜야 한다.

```bash
mkdir -p ~/project && cd ~/project
git clone https://github.com/EthanlOLOO/aio-desktop.git aio
mkdir naver && git clone https://github.com/EthanlOLOO/naver-ts.git naver/ts
```

```
~/project/
├─ aio/
│  ├─ desktop/        ← 앱
│  ├─ node/           ← 롯데온·반다이·슈프림 원본
│  └─ lotteon_test_config.json   ← 씨앗 설정 (직접 만든다)
└─ naver/
   ├─ ts/             ← 네이버 원본
   └─ smartstore_config.json     ← 씨앗 설정 (직접 만든다)
```

설정은 저장소에 없다 (쿠키·비밀번호·웹훅이 들어 있어서). 예시를 베껴 채운다.

```bash
cd ~/project
cp aio/lotteon_test_config.example.json aio/lotteon_test_config.json
cp aio/bnkr_buy_config.example.json aio/bnkr_buy_config.json
cp naver/ts/smartstore_config.example.json naver/smartstore_config.json
```

## 설치 · 실행

```bash
cd ~/project/aio/node && npm install && npm run build
cd ~/project/naver/ts && npm install && npx playwright install chromium
cd ~/project/aio/desktop && npm install && npm start
```

- `npm install` 이 **맥용 Electron** 을 받는다. 윈도우의 `node_modules` 를 복사해 오면 안 된다 (`electron.exe` 는 맥에서 안 돈다).
  애플 실리콘(M1~)이든 인텔이든 `npm install` 이 맞는 것을 고른다.
- `npx playwright install chromium` — 네이버 원본은 Playwright 의 번들 크로미움을 먼저 쓰고, 없으면 설치된 크롬으로
  간다. 윈도우 PC 에는 이미 받아 둔 것이 있었지만 새 맥에는 없다.
- 원본 빌드·네이버 설치는 앱의 🔔 알림에 있는 **원본 빌드** · **설치** 버튼으로도 된다.

## 윈도우와 다른 것

| | 윈도우 | 맥 |
|---|---|---|
| 앱 데이터 (프로필·태스크·설정) | `%APPDATA%/aio-task-manager/` | `~/Library/Application Support/aio-task-manager/` |
| `run-*.bat` | 더블클릭 | **없다** (저장소에도 없다). `node/` 에서 `npm run lotte:test` 처럼 npm 스크립트로 부른다 — 목록은 `node/package.json` |
| 결제 비밀번호·슈프림 카드 암호화 | DPAPI | **키체인.** 처음 저장하거나 풀 때 "aio-task-manager 이(가) 키체인을 사용하려고 합니다" 가 뜬다 — **항상 허용**을 누른다. 안 그러면 태스크를 띄울 때마다 묻는다 |
| 클립보드에서 쿠키·주소 읽기 | `Get-Clipboard` | `pbpaste` — 그대로 된다 |
| 멈추기 | 앱의 ■ / 콘솔에서 Ctrl+C | 같다 |

### 조심할 것

- **크롬을 화면 밖에 띄우는 것이 안 숨겨질 수 있다.** 슈프림 등은 크롬을 `-32000,-32000` 에 세워 눈에 안 보이게
  하는데, 맥은 창을 화면 안으로 끌어다 놓는다. 창이 화면에 보여도 고장이 아니다 — 그냥 두면 된다.
- **슈프림: 남은 크롬 정리.** 같은 프로필로 크롬이 이미 떠 있으면 새 크롬이 `Chrome failed to start: crashed` 로
  죽는다. 그래서 띄우기 전에 그 프로필을 쓰는 크롬만 찾아 끈다 (`node/src/supreme/browser.ts` 의
  `killChromeUsingProfile`). 윈도우는 PowerShell, 맥·리눅스는 `ps` 로 명령줄에 `--user-data-dir=<그 프로필>` 이 있는
  크롬만 고른다 — 평소 쓰는 크롬은 건드리지 않는다. 고르는 규칙은 셀프테스트(`npm run supreme:selftest`)가 맥 모양
  `ps` 출력으로 확인하지만, **진짜 맥에서는 아직 돌려 보지 않았다.** 그래도 그 오류가 나면 남은 크롬 창을 닫거나
  터미널에서 끈다.

  ```bash
  pkill -f "user-data-dir=.*aio-task-manager"
  ```

## 윈도우 PC 에서 옮겨 오기

**새로 로그인하는 편이 낫다.** 앱 데이터 폴더를 통째로 복사해도 다 살아나지는 않는다.

| | 옮겨지나 |
|---|---|
| 결제 비밀번호(`payment-pin.enc`) · 슈프림 카드(`supreme-order.enc`) | **안 된다.** 윈도우 계정에 묶인 암호화(DPAPI)라 맥에서 못 푼다. 프로필에서 다시 입력한다 |
| 앱의 로그인 창이 쥔 쿠키 (`persist:login-…`) | 안 된다 — 이것도 윈도우에서 암호화돼 있다. 프로필에서 다시 로그인한다 |
| 롯데 쿠키(`lotte-cookie.txt`) · 네이버 세션(`naver_session.json`) | 글자 파일이라 복사하면 읽힌다. 다만 세션이 이미 끝났을 수 있다 — 프로필의 **확인**으로 본다 |
| 씨앗 설정 (`lotteon_test_config.json` · `smartstore_config.json` …) | 그대로 복사해도 된다 |

태스크 목록은 앱에서 다시 만드는 것이 깔끔하다. 태스크마다 고른 프로필이 위에서 다시 만든 것과 이어져야 하기 때문이다.
