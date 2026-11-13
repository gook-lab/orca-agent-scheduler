# OrcaCron 예약 — Orca 플러그인 시험판

Orca 에 열어 둔 Claude Code·Codex·Gemini CLI 터미널에 정해진 시각마다 글을 보내는 Orca 플러그인입니다. 메뉴 막대 앱 [OrcaCron](https://github.com/gook-lab/orca-cron) 을 Orca 안으로 옮기는 시험판이며, 앱과 데이터를 나누지 않습니다.

## 앱과 다른 점 — 에이전트 상태 알림 · 결과 명령 없음

- 받는 터미널이 일하는 중인지를 Orca 의 에이전트 상태 알림(working·blocked·waiting·done)으로 먼저 보고, 화면 끝의 입력 칸 모양으로 한 번 더 봅니다.
- 끝났는지는 에이전트가 일을 시작했다가 멈춘 것으로 압니다. 그래서 보내는 글 끝에 결과 명령(`OrcaCron finish …`)을 붙이지 않고, 받는 쪽 권한 설정도 필요 없습니다. 대신 한 줄 요약·링크는 남지 않고 「성공 · 걸린 시간 4분」만 남습니다.
- 앱 설치·빌드가 없습니다. Orca 가 꺼져 있으면 돌지 않는 것은 앱과 같습니다.

## 화면 — 오른쪽 사이드바 패널 · 상태 막대

- 오른쪽 사이드바의 달력 아이콘 「OrcaCron 예약」 패널에서 예약을 만들고 켜고 끕니다. 터미널은 **지금 보고 있는 워크스페이스**의 에이전트 터미널에서 고릅니다(플러그인이 볼 수 있는 범위).
- 시각은 요일(매일·평일·휴일) + `09:00, 18:30` 처럼 쉼표로 나눈 시각, 또는 cron 식을 직접 씁니다.
- 아래 상태 막대에 다음 예약 시각이 보이고, 기다리는 예약이 있으면 주황으로 바뀝니다.

## 전송 조건 — 터미널이 비었을 때만

30초마다 확인하고, 시각이 된 예약은 아래가 모두 맞을 때 보냅니다. 60분을 기다려도 안 맞으면 그 회차는 「건너뜀」입니다.

1. 에이전트 상태가 working·blocked 가 아닙니다.
2. 화면이 1분 동안 움직이지 않았습니다.
3. 화면 끝 입력 칸이 비었습니다(Claude Code `❯`, Codex `›`, Gemini `│ >`). 권한·질문 창이 떠 있으면 기다립니다.

## 개발 — orca plugin test · check

```bash
ORCA=/Applications/Orca.app/Contents/Resources/bin/orca
$ORCA plugin test . --json      # 시험(시각 계산·화면 판정·실행기·worker·패널)
$ORCA plugin check . --json     # 패널을 상황별로 한 번씩 그려 봄
npx -p typescript tsc -p .      # 형 검사
$ORCA plugin dev watch . --check --json   # Orca 에 올려 고칠 때마다 다시 읽음(처음 한 번 권한 승인 필요)
```
