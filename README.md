<p align="center">
  <a href="https://encbird.com">
    <img src="plugins/encbird/assets/icon.png" alt="잉크버드(EncBird) 아이콘" width="112" height="112">
  </a>
</p>

<h1 align="center">잉크버드(EncBird) 플러그인</h1>

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
- **맞춤 추천** — 잉크버드(EncBird)가 학습에 맞춰 생성한 표현과 대화 상황을 받아봅니다.
- **학습 정보 전달** — 동의한 프로필·활동·학습 관찰을 후보로 전달하면 잉크버드(EncBird)가 평가해 학습에 반영합니다.

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

설치 후 새 대화를 시작합니다. 별도의 패키지 설치나 API 키 입력은 필요하지 않습니다.

## 사용 방법

### 계정 연결

다음 순서로 잉크버드(EncBird) 계정을 연결합니다.

1. 대화에서 “잉크버드(EncBird) 계정에 연결해줘”라고 요청합니다.
2. 열린 브라우저에서 잉크버드(EncBird) 계정으로 로그인합니다.
3. 대화로 돌아와 “로그인했어. 연결을 확인해줘”라고 알려줍니다.

연결 완료 안내를 받으면 학습을 시작할 수 있습니다. 서버 주소나 API 키를 따로 설정할 필요는 없습니다.

비밀번호나 인증 토큰, 로그인 후 이동한 URL을 대화에 붙여 넣지 마세요. 로그인 정보는 사용 중인 컴퓨터에, 표현과 저장한 학습 기록은 잉크버드(EncBird) 계정에 보관합니다.

잉크버드(EncBird) 계정 연결은 Codex·Claude Code 자체 로그인과 별개이며, 연결 정보도 기본적으로 도구별로 분리됩니다. 별도로 스크립트 실행 방식을 선택하면 그 방식에서도 로그인이 필요할 수 있으며, 기존 도구의 로그인 정보를 자동으로 공유하거나 옮기지 않습니다.

### 첫 표현 등록하기

저장한 표현이 없는 계정이라면 `take a break`(잠깐 쉬다)를 등록하고 다시 찾아보세요.

1. “`take a break`를 잉크버드(EncBird)에 등록하고 싶어. 서버에서 필요한 비용을 먼저 확인해줘”라고 요청합니다. 서버가 무료 체험 사용 여부와 크레딧 수량을 안내하며, 이 안내만으로는 아직 등록되지 않습니다.
2. 안내된 사용 방식과 수량에 동의할 때만 승인합니다. 예를 들어 서버가 크레딧 1개 사용을 안내했다면 “`take a break` 등록에 크레딧 1개 사용을 승인해”라고 답합니다. 무료 체험 안내를 받았다면 그 체험 사용을 명시적으로 승인합니다. 조건이 바뀌면 새 안내를 확인하고 다시 승인합니다.
3. 등록 결과에서 저장이 완료됐는지, 크레딧이 차감됐는지 또는 무료 체험이 사용됐는지 확인합니다.
4. 등록이 성공하면 “잉크버드(EncBird)에 저장한 `take a break`를 찾아줘”라고 요청해 저장된 표현의 뜻과 쓰임을 확인합니다.

등록 직후에는 그 표현의 퀴즈가 없을 수 있습니다. 준비 여부가 궁금하면 “방금 등록한 표현의 퀴즈가 준비됐는지 확인해줘”라고 요청하세요. 준비된 문제가 있을 때 복습을 이어가세요.

### 대화 예시

표현을 모으고 복습할 때는 다음처럼 요청할 수 있습니다.

| 하고 싶은 일 | 요청 예시 |
| --- | --- |
| 표현 찾기 | “잉크버드(EncBird)에 저장한 표현 중 회의에서 쓸 만한 표현을 찾아줘.” |
| 복습하기 | “오늘 복습할 표현을 한 문제씩 내줘.” |
| 표현 추가하기 | “이 영어 표현을 잉크버드(EncBird)에 추가하고 싶어. 필요한 비용을 먼저 알려줘.” |
| 추천받기 | “잉크버드(EncBird)가 추천한 표현과 대화 상황을 보여줘.” |

복습에서는 답을 제출한 뒤 기억 난이도를 직접 선택합니다.

| 번호 | 선택 |
| --- | --- |
| 1 | 다시 (Again) |
| 2 | 어려움 (Hard) |
| 3 | 좋음 (Good) |
| 4 | 쉬움 (Easy) |

번호나 선택 항목으로 답하면 됩니다. 복습 기록에는 사용자가 실제로 낸 답과 직접 선택한 난이도를 사용합니다. 정답 여부나 힌트 사용만으로 난이도를 대신 선택하지 않으며, 명확하게 선택한 난이도는 다시 묻지 않습니다.

학습 요청에는 개인정보를 넣지 마세요. 답에 개인정보가 있으면 복습 결과를 저장하지 않고 현재 대화에서만 피드백합니다. 내용을 바꿔 원래 답처럼 저장하지 않습니다.

학습 정보 전달을 요청하면 먼저 전달할 범위를 확인합니다. 접수나 처리가 끝나도 메모리에 반영됐다는 뜻은 아니며, 플러그인에서 실제 메모리를 조회·수정·삭제할 수는 없습니다.

## 문제가 생겼을 때

| 보이는 안내 | 다음 행동 |
| --- | --- |
| 요청 제한으로 기다려야 함 | 안내된 대기 시간이 끝난 뒤 다시 요청하세요. 대기 중에는 같은 요청을 반복하거나 다른 도구로 제한을 피하지 마세요. |
| 크레딧 부족 | [잉크버드(EncBird)](https://encbird.com)에서 잔액을 확인하고 충전한 뒤, 승인했던 등록을 다시 요청하세요. 사용 방식을 임의로 바꾸거나 잔액이 그대로인 상태에서 재시도하지 않습니다. |
| 재로그인 필요 | 처음 연결했던 것과 같은 잉크버드(EncBird) 계정으로 다시 로그인하고 연결 완료를 확인하세요. 다른 계정으로 로그인하면 기존 연결을 복구할 수 없습니다. |
| 연결 해제 미완료 | 안내된 원인을 해결한 뒤 연결 해제를 다시 요청하세요. 재로그인이 필요하다면 같은 계정을 사용하며, 해제 완료가 확인될 때까지 인증 기록을 그대로 두세요. |

등록이나 학습 기록 저장 결과가 불분명하면 같은 작업을 자동으로 반복하지 않습니다. 먼저 저장 여부와 오류 안내를 확인하세요.

문제가 계속되면 플러그인 버전과 오류 코드로 지원을 요청하세요. 인증 정보, 로그인 후 이동한 URL, 학습 원문은 보내지 마세요.

## 업데이트와 제거

### 버전 확인과 업데이트

잉크버드(EncBird) 플러그인의 코드와 버전은 공개 저장소 [haandol/encbird-plugin](https://github.com/haandol/encbird-plugin)에서 관리합니다. 버전별 변경 사항과 배포 파일은 발행된 [GitHub Releases](https://github.com/haandol/encbird-plugin/releases)에서 확인할 수 있습니다.

위 마켓플레이스 설치 명령은 저장소를 등록하며 특정 릴리즈 태그를 지정하지 않습니다. GitHub Release 발행만으로 설치 버전이 그 태그에 고정되지는 않습니다. 설치된 버전 확인과 업데이트는 [Codex 공식 관리 안내](https://learn.chatgpt.com/docs/developer-commands#codex-plugin)와 [Claude Code 공식 관리 안내](https://code.claude.com/docs/en/discover-plugins)를 따르세요.

### 연결 해제 후 제거

사용하던 도구의 대화에서 “잉크버드(EncBird) 계정 연결을 해제해줘”라고 요청하세요. 해제 완료(`disconnected`)가 확인된 뒤 위 공식 관리 안내에 따라 도구에서 플러그인을 제거하세요. 미완료 안내가 나오면 먼저 위 문제 해결 안내를 따라 해제를 마칩니다.

로컬 로그인 정보는 플러그인 설치 폴더 밖에 보관하므로, 앱을 닫거나 플러그인을 제거하는 것만으로 연결 해제가 완료되지는 않습니다. 연결을 해제하고 플러그인을 제거해도 표현과 저장한 학습 기록은 잉크버드(EncBird) 계정에 남습니다.

### 개발 문서

개발자는 공개 저장소를 별도로 clone하여 Dev Container에서 작업합니다. 다른 저장소에서 submodule로 연결할 때는 호환성을 검증한 커밋 SHA를 고정합니다. 개발·배포 절차는 [개발 안내](https://github.com/haandol/encbird-plugin/blob/main/docs/development.md), [버전 릴리즈 안내](https://github.com/haandol/encbird-plugin/blob/main/docs/releases.md), [에이전트 지침](https://github.com/haandol/encbird-plugin/blob/main/AGENTS.md)을 참고하세요.

## 라이선스와 소유권

이 플러그인의 소유권과 저작권은 잉크버드(EncBird)에 있습니다.

Copyright 2026 EncBird. [Apache License 2.0](LICENSE)에 따라 배포합니다.

함께 제공되는 외부 라이브러리는 각각의 라이선스를 따릅니다. 전문은 [외부 라이브러리 라이선스](plugins/encbird/dist/THIRD_PARTY_LICENSES.txt)에 있습니다.
