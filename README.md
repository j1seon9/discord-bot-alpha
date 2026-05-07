# Discord School Bot

JavaScript 기반 Discord 봇입니다. 별도 서버 API와 연동해 학교 회원가입, 급식, 시간표 정보를 제공하고 Groq API를 이용한 AI 대화 기능을 지원합니다.

## 주요 기능

- Discord 슬래시 커맨드 자동 등록
- 웹 회원가입 페이지 안내 및 6자리 토큰 로그인
- 연동된 사용자 학교 정보 조회
- 오늘 급식 및 오늘 시간표 조회
- Groq AI 채팅
- 한국어 응답 품질 보정 및 깨진 한글 응답 재시도
- 서버 `/health` 확인 후 DB 연결이 정상일 때만 봇 시작

## 필요 환경

- Node.js
- Discord Bot Token
- Groq API Key
- 연동 서버 API

## 설치

```bash
npm install
```

## 환경변수

`.env.example`을 참고해 `.env` 파일을 설정합니다.

```env
DISCORD_TOKEN=
GROQ_API_KEY=
SERVER_URL=
```

- `DISCORD_TOKEN`: Discord 개발자 포털에서 발급한 봇 토큰
- `GROQ_API_KEY`: Groq API 키
- `SERVER_URL`: 학교/회원 서버 주소. 비워두면 `http://localhost:8000`을 사용합니다.

## 실행

```bash
npm start
```

봇은 시작할 때 다음 순서로 초기화됩니다.

1. 필수 환경변수 확인
2. `SERVER_URL/health` 호출
3. 응답의 `db` 값이 `true`인지 확인
4. Groq API 클라이언트 초기화
5. Discord 로그인 및 슬래시 커맨드 등록

## 슬래시 커맨드

| 커맨드 | 설명 |
| --- | --- |
| `/회원가입` | 회원가입 웹페이지 링크와 Discord 연동 방법을 안내합니다. |
| `/로그인` | 회원가입 후 발급된 6자리 토큰으로 Discord 계정을 연동합니다. |
| `/내정보` | 현재 연동된 학교, 학년, 반 정보를 확인합니다. |
| `/급식` | 오늘 급식 메뉴를 조회합니다. |
| `/시간표` | 오늘 시간표를 조회합니다. |
| `/ping` | 봇 응답 속도를 확인합니다. |
| `/chat` | Groq AI와 대화합니다. |
| `/clear` | 현재 채널의 AI 대화 기록을 초기화합니다. |
| `/status` | 현재 채널의 AI 대화 기록 수를 확인합니다. |
| `/도움말` | 사용 가능한 봇 커맨드 설명을 보여줍니다. |

## 서버 API 의존성

봇은 아래 서버 엔드포인트를 사용합니다.

| 메서드 | 경로 | 용도 |
| --- | --- | --- |
| `GET` | `/health` | 서버 및 DB 상태 확인 |
| `GET` | `/register` | 회원가입 웹페이지 |
| `POST` | `/api/verify` | 6자리 토큰 검증 및 Discord 계정 연동 |
| `GET` | `/api/user/:discordId` | Discord 사용자 연동 정보 조회 |
| `GET` | `/api/dailyMeal` | 오늘 급식 조회 |
| `GET` | `/api/dailyTimetable` | 오늘 시간표 조회 |

## 참고

- `/회원가입` 응답에는 `SERVER_URL/register`로 이동하는 버튼이 포함됩니다.
- 서버가 JSON이 아닌 오류 응답을 반환해도 봇이 종료되지 않도록 방어 처리되어 있습니다.
- Groq 응답이 한국어 질문에 대해 깨진 한글이나 비한국어 응답을 반환하면 한 번 자동 재시도합니다.
