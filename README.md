<p align="center">
  <a href="https://encbird.com">
    <img src="plugins/encbird/assets/icon.png" alt="잉크버드(EncBird) 아이콘" width="112" height="112">
  </a>
</p>

<h1 align="center">Encbird Plugin · 잉크버드 플러그인</h1>

<p align="center">
  Codex와 Claude Code에서 영어 표현을 모으고 복습하세요.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="라이선스: Apache 2.0"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.12-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 22.12 이상"></a>
</p>

<p align="center">
  <a href="https://encbird.com">잉크버드(EncBird)</a> ·
  <a href="#설치">설치</a> ·
  <a href="#사용-방법">사용 방법</a> ·
  <a href="#라이선스와-소유권">라이선스</a>
</p>

## 주요 기능

[잉크버드(EncBird)](https://encbird.com)에 저장한 영어 표현을 대화 중에 찾아보고, 새 표현과 학습 기록을 잉크버드(EncBird) 계정에 모을 수 있습니다.

- **표현 검색과 수집** — 저장한 표현의 뜻과 쓰임을 확인하고 새 표현을 추가합니다.
- **퀴즈 복습** — 복습 문제를 한 문제씩 풀고 기억 난이도를 직접 선택합니다.
- **맞춤 추천** — 대화를 바탕으로 연습할 표현과 대화 상황을 추천받습니다.
- **학습 메모리** — 동의한 범위의 학습 정보를 저장하고, 정정하거나 삭제합니다.

## 설치

### 준비 사항

- macOS 또는 Linux 데스크톱
- [Node.js](https://nodejs.org) 22.12 이상
- 플러그인을 지원하는 Codex 또는 Claude Code
- 같은 컴퓨터에서 로그인에 사용할 수 있는 브라우저

Windows와 브라우저를 사용할 수 없는 원격 환경은 현재 지원하지 않습니다. 사용하는 도구에 맞는 명령을 터미널에서 실행하세요.

### Codex

```sh
codex plugin marketplace add haandol/encbird-plugin
codex plugin add encbird@encbird
```

### Claude Code

```sh
claude plugin marketplace add haandol/encbird-plugin
claude plugin install encbird@encbird
```

설치 후 새 대화를 시작합니다. 별도의 패키지 설치나 API 키 입력은 필요하지 않습니다. 플러그인 관리 방법은 [Codex 공식 안내](https://learn.chatgpt.com/docs/developer-commands#codex-plugin)와 [Claude Code 공식 안내](https://code.claude.com/docs/en/discover-plugins)를 참고하세요.

## 사용 방법

### 계정 연결

다음 순서로 잉크버드(EncBird) 계정을 연결합니다.

1. 대화에서 “잉크버드(EncBird) 계정에 연결해줘”라고 요청합니다.
2. 열린 브라우저에서 잉크버드(EncBird) 계정으로 로그인합니다.
3. 대화로 돌아와 “로그인했어. 연결을 확인해줘”라고 알려줍니다.

연결이 완료되면 플러그인이 잉크버드(EncBird) 서버에 연결합니다. 서버 주소나 API 키를 따로 설정할 필요는 없습니다. 비밀번호나 인증 토큰을 대화에 붙여 넣지 마세요. 로그인 정보는 사용 중인 컴퓨터에, 표현과 저장한 학습 기록은 잉크버드(EncBird) 계정에 보관합니다.

### 대화 예시

계정 연결 후 다음처럼 요청할 수 있습니다.

| 하고 싶은 일 | 요청 예시 |
| --- | --- |
| 표현 찾기 | “잉크버드(EncBird)에 저장한 표현 중 회의에서 쓸 만한 표현을 찾아줘.” |
| 복습하기 | “오늘 복습할 표현을 한 문제씩 내줘.” |
| 표현 추가하기 | “이 영어 표현을 잉크버드(EncBird)에 추가해줘.” |
| 추천받기 | “이번 대화에서 연습할 만한 표현과 대화 상황을 추천해줘.” |

복습에서는 답을 제출한 뒤 기억 난이도를 직접 선택합니다. 새 표현을 등록할 때 무료 체험 사용이나 크레딧 차감이 필요하면, 안내된 내용을 확인하고 승인한 뒤 등록합니다. 대화 내용을 학습 메모리나 추천에 저장할 때도 저장할 범위를 먼저 확인합니다.

### 다시 로그인하거나 연결 해제하기

다시 로그인하라는 안내가 나오면 같은 계정으로 연결을 요청하세요. 연결을 해제하려면 “잉크버드(EncBird) 계정 연결을 해제해줘”라고 요청합니다. 해제가 완료되지 않았다는 안내가 나오면 다시 요청해 완료 여부를 확인합니다.

## 라이선스와 소유권

이 플러그인의 소유권과 저작권은 잉크버드(EncBird)에 있습니다.

Copyright 2026 EncBird. [Apache License 2.0](LICENSE)에 따라 배포합니다.

함께 제공되는 외부 라이브러리는 각각의 라이선스를 따릅니다. 전문은 [외부 라이브러리 라이선스](plugins/encbird/dist/THIRD_PARTY_LICENSES.txt)에 있습니다.
