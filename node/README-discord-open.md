# 디스코드 알림 → 크롬 창 (`node/src/discord-open/`)

waitwhile·bnkr·naver 판이 웹훅으로 보낸 알림이 채널에 올라오면, **속에 든 링크를 크롬 새 창으로 띄웁니다.**

```
[감시 도구] ──웹훅──▶ 디스코드 채널 ──봇이 읽음──▶ 이 프로그램 ──▶ 크롬 새 창
```

봇은 읽기만 합니다. 채널에 아무것도 쓰지 않습니다.

## 처음 한 번 — 봇 만들기 (5분)

1. <https://discord.com/developers/applications> → **New Application** → 이름 아무거나
2. 왼쪽 **Bot** 탭
   - **Reset Token** → 나온 토큰 복사 (한 번만 보여 줍니다)
   - 아래 **Privileged Gateway Intents** 에서 **MESSAGE CONTENT INTENT** 켜고 **Save**
     (이게 꺼져 있으면 알림 속 링크가 빈 채로 옵니다)
3. 토큰 저장
   ```
   cd node
   npm run discord -- --token 복사한토큰
   ```
4. `run-discord-open.bat` 실행. 봇이 아직 어느 서버에도 없으면 **초대 주소를 찍어 줍니다.**
   그 주소를 열어 알림 받는 서버에 넣으면 끝 (권한은 채널 보기·기록 읽기 두 개만 달라고 합니다).

## 쓰기

```
run-discord-open.bat                       지켜본다 (더블클릭)
npm run discord -- --dry-run               열지 않고 무엇을 열지만 찍는다
npm run discord -- --open https://...      크롬이 제대로 뜨는지만 본다
npm run discord -- --channel 123 456       이 채널들만 본다 (값 없이 = 전부)
```

## 어떤 링크를 여나

1. 임베드의 `url` — 우리 알림은 전부 여기에 상품·매장 주소를 싣습니다
2. 없으면 본문 → 임베드 설명 → 필드 순으로 처음 나오는 주소
3. 디스코드 자신의 주소(썸네일·채널 링크)는 열지 않습니다

같은 주소가 `reopen_after_seconds`(60초) 안에 또 오면 다시 열지 않습니다 — 알림이 몰려도 창이 쌓이지 않게.

## 설정 (`discord_open_config.json`, 프로젝트 뿌리)

| 키 | 기본 | 뜻 |
|---|---|---|
| `bot_token` | | 봇 토큰. 환경변수 `DISCORD_BOT_TOKEN` 이 있으면 그쪽이 먼저 |
| `channel_ids` | `[]` | 볼 채널. 비우면 봇이 보이는 모든 채널 |
| `webhook_only` | `true` | 웹훅 알림만. 사람이 붙인 링크로는 안 연다 |
| `keywords` | `[]` | 적으면 이 말이 든 알림만 연다 (예: `["열림", "재입고"]`) |
| `skip_keywords` | `[]` | 이 말이 든 알림은 안 연다 (예: `["시간표", "마감"]`) |
| `reopen_after_seconds` | `60` | 같은 주소 다시 열기까지 |
| `chrome_path` | 자동 | 못 찾을 때만 `chrome.exe` 경로 |
| `chrome_args` | `["--new-window"]` | 탭으로 열고 싶으면 `[]` |

토큰이 들어 있으므로 `.gitignore` 에 넣어 두었습니다.

## 막힐 때

| 화면 | 할 일 |
|---|---|
| 봇 토큰이 틀렸습니다 | 포털에서 Reset Token 후 다시 `--token` |
| MESSAGE CONTENT INTENT 가 꺼져 있습니다 | 위 2번의 스위치 |
| 메시지가 비어서 왔습니다 | 같은 스위치. 저장을 안 누른 경우가 많습니다 |
| 크롬을 찾지 못했습니다 | `chrome_path` 에 경로 |
| 창이 안 뜨고 아무 말도 없음 | 채널 아이디·`keywords` 확인, `--dry-run` 으로 알림이 들어오는지 본다 |
