# Decision Log: plugin-delivery

This document is the **major decision-change history** of the plugin-delivery category. Each
ADR body describes only the current state, while the timeline of "what changed and why"
accumulates here, newest first. Git preserves the individual diffs.

The current Purpose, all still-valid Decision Drivers, adopted choice, rationale,
and requirement contract remain together in the ADR body. Reading this log is
optional for understanding the current decision.

## 2026-11-08 — 설치본 실행과 개발·검증 런타임을 Bun으로 전환

- **Current ADR**: [verification-boundary](./0001-verification-boundary.md)
- **Change type**: requirement value change
- **What**: 설치본은 Node.js 22.12.0 이상에서 실행하고 Node.js 도구로 검증했다 → 설치본은 Node.js 없이 Bun 1.4.2 이상에서 실행하고, 의존성 준비·빌드·테스트·검증도 기록된 하나의 Bun 버전으로 수행한다.
- **Why**: 운영자가 시작 속도와 메모리 사용량을 이유로 Bun을 선택했고, 사용자 실행과 검증이 같은 런타임을 사용해야 설치본 검사가 실제 실행 환경을 대표한다.
- **What is now void**: Node.js 22.12.0 하한과 Node.js 24 실행 검증, npm 잠금 파일에 결합한 검증 결과.
