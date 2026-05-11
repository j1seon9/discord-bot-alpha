# Discord School Bot

학교 정보 서버와 연동하는 Discord 봇입니다. 회원가입 안내, 토큰 로그인, 급식/시간표 조회, Groq AI 채팅을 제공합니다.

## Overview

- Runtime: Node.js
- Discord library: `discord.js`
- AI provider: Groq API
- Server API default: `http://localhost:8000`
- License: Proprietary, all rights reserved

## Features

- Discord 슬래시 커맨드 동기화
- 회원가입 웹페이지 버튼 안내
- 6자리 토큰 기반 Discord 계정 연동
- 연동된 학교/학년/반 정보 조회
- 오늘 급식 및 시간표 조회
- Groq AI 채팅
- 한국어 응답 품질 보정
- 서버 `/health`와 DB 상태 확인 후 봇 시작

## Commands

| Command | Description |
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

## Setup

```bash
npm install
```

`.env.example`을 참고해 `.env`를 만듭니다.

```env
DISCORD_TOKEN=
GROQ_API_KEY=
SERVER_URL=
```

### Environment Variables

| Name | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Discord Developer Portal에서 발급한 봇 토큰 |
| `GROQ_API_KEY` | Yes | Groq API 키 |
| `SERVER_URL` | No | 연동 서버 주소. 비어 있으면 `http://localhost:8000` 사용 |

## Run

```bash
npm start
```

봇 시작 순서:

1. 필수 환경변수 확인
2. `SERVER_URL/health` 호출
3. 응답의 `db` 값이 `true`인지 확인
4. Groq API 클라이언트 초기화
5. Discord 로그인
6. 슬래시 커맨드 후순위 동기화
7. 모든 관리 커맨드가 확인되면 커맨드 활성화

## Server API

봇은 서버의 아래 엔드포인트를 사용합니다.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | 서버 및 DB 상태 확인 |
| `GET` | `/register` | 회원가입 웹페이지 |
| `POST` | `/api/verify` | 6자리 토큰 검증 및 Discord 계정 연동 |
| `GET` | `/api/user/:discordId` | Discord 사용자 연동 정보 조회 |
| `GET` | `/api/dailyMeal` | 오늘 급식 조회 |
| `GET` | `/api/dailyTimetable` | 오늘 시간표 조회 |

## Notes

- `/회원가입` 응답에는 `SERVER_URL/register`로 이동하는 링크 버튼이 포함됩니다.
- 서버가 JSON이 아닌 오류 응답을 반환해도 봇이 종료되지 않도록 처리합니다.
- Groq가 한국어 질문에 대해 깨진 한글 또는 비한국어 응답을 반환하면 한 번 자동 재시도합니다.
- Discord 앱의 Entry Point command를 건드리지 않도록 슬래시 커맨드는 개별 생성/수정 방식으로 동기화합니다.

## License

Copyright (c) 2026 J1S9O. All rights reserved.

이 프로젝트는 저작권자의 허가 없이 복제, 재배포, 수정 배포, 상업적 이용을 금지합니다.
