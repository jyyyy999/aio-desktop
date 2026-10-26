# aio — 태스크 관리 데스크톱 앱

| | |
|---|---|
| `desktop/` | 태스크 관리 데스크톱 앱 (Electron · React). 원본들을 태스크마다 따로 띄운다 |
| `node/` | 앱이 띄우는 원본들 — **롯데온** (`src/lotte-test`) · **반다이남코** (`src/bnkr-test`) · **슈프림** (`src/supreme`) · **KREAM 브랜드배송** (`src/kream`) 과 그것들이 빌려 쓰는 공용 조각 |
| `../naver/ts` | 앱이 띄우는 **네이버 원본** — 따로 저장소 [naver-ts](https://github.com/EthanlOLOO/naver-ts) |

앱은 원본을 **폴더 자리로** 찾는다 — `aio/desktop` 옆의 `aio/node`, 그리고 `aio` 옆의 `naver/ts`.
그래서 두 저장소를 이 배치대로 받는다.

맥에서 쓸 때는 [README-macos.md](README-macos.md) — 윈도우와 다른 것만 따로 적었다.

## 새 PC 에서

```bash
mkdir project && cd project
git clone https://github.com/EthanlOLOO/aio-desktop.git aio
mkdir naver && git clone https://github.com/EthanlOLOO/naver-ts.git naver/ts
```

```
project/
├─ aio/
│  ├─ desktop/        ← 앱
│  ├─ node/           ← 원본들 (롯데온 · 반다이남코 · 슈프림 · KREAM)
│  └─ lotteon_test_config.json   ← 씨앗 설정 (직접 만든다)
└─ naver/
   ├─ ts/             ← 네이버 원본
   └─ smartstore_config.json     ← 씨앗 설정 (직접 만든다)
```

**설정은 저장소에 없다.** 쿠키·간편결제 비밀번호·웹훅·결제창 자동 입력 값(전화번호 등)이 들어
있어서다. 비밀값을 비운 `*.example.json` 만 있다 — 복사해 이름에서 `.example` 을 빼고 채우거나,
원래 PC 의 설정 파일을 그대로 옮겨 온다.

```bash
cp aio/lotteon_test_config.example.json aio/lotteon_test_config.json
cp naver/ts/smartstore_config.example.json naver/smartstore_config.json
```

**모듈(`node_modules`)도 저장소에 없다.** `desktop/node_modules` 만 459MB 이고 그중 `electron.exe` 하나가
GitHub 파일 한도(100MB)를 넘는다. 대신 `package-lock.json` 이 있어 `npm install` 이 같은 판을 그대로
깐다.

```bash
cd aio/node && npm install && npm run build      # 원본들 (앱에서 '원본 빌드' 로도 된다)
cd ../../naver/ts && npm install                  # 네이버 원본 (tsx 로 바로 돈다)
cd ../../aio/desktop && npm install && npm start  # 앱
```

**KREAM 결제 비밀번호 입력 코드(`node/src/kream/pin.ts`)도 저장소에 없다** (`.gitignore`). 원본(`node/`)이 이 파일을
불러오므로, 새 PC 에서는 원래 PC 의 파일을 같은 자리에 넣어야 `npm run build` 가 된다.

앱의 프로필(로그인 쿠키·암호화한 결제 비밀번호·KREAM 자동 로그인 정보)·태스크 목록·설정은 `%APPDATA%/aio-task-manager/`
에 있다 — 이것도 저장소 밖이다. 암호화한 것은 그 PC 의 그 윈도 계정에서만 풀리므로, 새 PC 에서는 앱에서 다시 로그인하고
다시 넣는다.
