# Kodex

Kodex는 공식 오픈소스 [OpenAI Codex](https://github.com/openai/codex)의 App Server를 로컬에서 직접 빌드하고 실행하는 개인용 애플리케이션입니다. UI, Local Server, Codex 소스, thread와 설정을 포함한 애플리케이션 상태는 로컬에 있습니다. 모델 호출과 사용자가 허용한 Web Search, Git, MCP, 패키지 설치 등의 도구는 정상적으로 네트워크를 사용할 수 있습니다.

Kodex Local Server는 에이전트 엔진이 아닙니다. 공식 App Server의 stdio JSONL RPC를 localhost HTTP/WebSocket UI에 연결하고, 로컬 프로젝트·UI 설정·자동화·로그와 프로세스 수명만 관리합니다. 모델 호출, reasoning, tool 선택, sandbox와 approval은 공식 Codex가 담당합니다.

## 구조

```text
apps/
  ui/                 React + Vite SPA (브라우저)
  local-server/       localhost 전용 Node.js 호스트
packages/
  codex-protocol/     로컬 Codex가 생성한 App Server 타입과 schema
  kodex-api/          UI ↔ Local Server 공용 API 타입
  shared/             JSONL, sequence, 비밀정보 마스킹 유틸리티
vendor/
  openai-codex/       고정 commit의 공식 전체 소스
bin/
  codex.exe           로컬 source build 결과(커밋하지 않음)
scripts/              Windows 빌드·프로토콜 생성·프로세스 실행
test/                 unit, fake/real App Server integration, opt-in live
```

UI와 Local Server는 별도 패키지이며 별도 프로세스로 실행됩니다. Next.js API Route, React 의존 백엔드, `globalThis` singleton은 사용하지 않습니다.

## 고정된 공식 Codex

- Upstream: `https://github.com/openai/codex`
- Commit: `f1433fc71f2062ae3c007a03d7ff549bc582d386`
- Source: `vendor/openai-codex/`
- License/notice: `vendor/openai-codex/LICENSE`, `vendor/openai-codex/NOTICE`
- Build metadata: `bin/codex-build.json`
- Protocol metadata: `packages/codex-protocol/codex-version.json`

자세한 제3자 고지는 `THIRD_PARTY.md`에 있습니다. upstream 내부의 Codex 이름과 소스는 불필요하게 변경하지 않습니다.

## 준비와 로컬 Codex 빌드

Node.js 22.13 이상과 npm이 필요합니다.

```powershell
npm install
```

Windows에서 Rust가 없다면 저장소 내부 `.tools`에 upstream이 고정한 Rust toolchain을 설치할 수 있습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-rust.ps1
```

MSVC linker가 없다면 Visual Studio 2022 Build Tools의 `Microsoft.VisualStudio.Workload.VCTools` workload가 필요합니다. `codex:build`는 설치된 VS 개발자 환경과 저장소 내부 Rust를 자동으로 찾고, 한글 사용자 TEMP 경로의 `protoc` 문제를 피하도록 `.codex-build/tmp`를 사용합니다.

```powershell
npm run codex:build
npm run codex:generate-protocol
```

첫 명령은 고정 commit을 검증한 뒤 공식 `codex-cli` release를 빌드해 `bin/codex.exe`에 둡니다. 두 번째 명령은 반드시 그 로컬 바이너리로 다음 산출물을 새로 생성합니다.

- `packages/codex-protocol/src/generated/`
- `packages/codex-protocol/schema/`

Kodex는 기본적으로 이 로컬 바이너리만 사용합니다. 개발 중 전역 Codex를 명시적으로 시험할 때만 `KODEX_ALLOW_GLOBAL_CODEX=1`과 `KODEX_CODEX_BIN`을 사용하십시오.

## API 키와 실행

루트의 `.env.local`을 만들거나 Local Server 프로세스 환경에 키를 설정합니다.

```dotenv
OPENAI_API_KEY=your_openai_api_key_here
```

키가 없으면 UI는 설정 방법만 표시하고 App Server를 시작하지 않습니다. 키는 Local Server만 읽고 공식 App Server 자식 프로세스에 전달합니다. 브라우저 응답·번들, `localStorage`, IndexedDB, 설정 JSON, Git, 로그에는 넣지 않으며 Codex가 실행하는 shell 환경에서도 제외합니다. ChatGPT 로그인이나 기기 인증은 요구하지 않습니다.

개발 실행:

```powershell
npm run dev
```

- UI: `http://127.0.0.1:5173`
- Local Server: `http://127.0.0.1:47831`
- Ctrl+C: UI, Local Server, App Server 자식 프로세스 트리를 모두 종료

프로덕션 로컬 실행:

```powershell
npm run build
npm run start
```

- UI preview: `http://127.0.0.1:4173`
- Local Server: `http://127.0.0.1:47831`

경로의 공백과 한글을 shell 문자열 결합 없이 child-process argument로 전달합니다.

## UI ↔ Local Server ↔ App Server

- HTTP: bootstrap, health, 설정, 프로젝트, 자동화, Git 상태/diff
- WebSocket: typed App Server RPC, notification stream, server approval/user-input request와 응답
- App Server: Local Server 자식 프로세스, `stdio://` JSONL
- Handshake: `initialize` 응답 후 `initialized`
- 복구: 증가 sequence, 1,000개 replay buffer, 중복 sequence 제거, reconnect/backoff, replay gap 알림
- 보호: `127.0.0.1` bind, Host/Origin 검사, HttpOnly SameSite cookie와 메모리 전용 session token, CSRF token, 1MiB 요청 제한, 4MiB WebSocket backpressure cutoff

App Server RPC client와 UI reducer는 `ClientRequest`, `ServerNotification`, `ServerRequest` 등 생성 타입을 직접 import합니다. 생성 파일은 손으로 수정하지 않습니다. 프로토콜 변경은 compile-time fixture와 전체 TypeScript build에서 드러납니다.

## 로컬 데이터

추적되지 않는 `.kodex-data/`에 저장합니다.

```text
.kodex-data/
  codex-home/          공식 CODEX_HOME: thread rollout/state/config/MCP/skills
  projects.json        로컬 프로젝트 목록과 최근 프로젝트
  settings.json        UI, sandbox, approval, network 선택
  automations.json     Local Server가 공식 thread/turn으로 실행하는 일정
  approvals.jsonl      마스킹된 승인 응답 기록
  logs/                마스킹된 App Server stderr/프로토콜 오류
```

Thread를 별도 Kodex 데이터베이스로 복제하지 않습니다. 공식 App Server가 Kodex 전용 `CODEX_HOME`에 공식 형식으로 저장합니다.

## 네트워크, sandbox, approval

Kodex는 프로세스 수준 네트워크 봉쇄, URL/명령 정규식 차단, `networkAccess: false` 하드코딩을 사용하지 않습니다.

설정 UI에서 다음을 별도로 선택합니다.

- Shell network: 공식 turn `SandboxPolicy.networkAccess`
- Web Search: 공식 Codex `web_search` 설정
- Remote MCP: 공식 `config/value/write`와 `config/mcpServer/reload`
- Sandbox: `read-only`, `workspace-write`, `danger-full-access`
- Approval: `untrusted`, `on-request`, `never`

따라서 OpenAI API, 공식 Web Search, 사용자가 설정한 원격 MCP, Git fetch/pull/push, 패키지 설치, 외부 문서 조회, Apps/Plugins가 공식 Codex 정책과 사용자 승인 범위에서 네트워크를 사용할 수 있습니다. Kodex 전용 원격 서버·DB·Thread 저장소·필수 SaaS 인증·원격 feature flag는 없습니다.

## 연결된 공식 기능

UI/Local Server가 공식 v2 method 및 notification을 통해 연결하는 주요 기능:

- thread start/list/read/resume/fork/archive/unarchive/name
- turn start/steer/interrupt
- model list, streaming agent message, reasoning, token usage
- command execution, stdout/stderr, file change/patch
- command/file/permission approval, user input, MCP elicitation
- MCP tool call, Web Search, Skills, Apps, Plugins
- 공식 config read/write 및 MCP reload

Apps/Plugins/일부 connector가 API-key 인증에서 사용 가능한지는 해당 고정 Codex commit과 서버 측 제품 지원 범위에 따릅니다. Kodex는 지원되지 않는 기능을 가짜 데이터나 자체 Responses API 호출로 흉내 내지 않습니다.

## 검증

```powershell
npm run typecheck
npm run lint
npm run test
npm run build
```

`npm test`는 API 키나 외부 모델 호출 없이 unit test, fake App Server lifecycle/RPC/restart/approval, HTTP 보안·로컬 저장, 그리고 실제 로컬 `bin/codex.exe`의 handshake와 `thread/list`를 실행합니다.

실 API 비용과 tool 실행이 발생하는 테스트는 기본 스위트에서 완전히 제외되어 있습니다. 사용자가 명시적으로 실행할 때만 현재 `OPENAI_API_KEY`로 ephemeral thread와 승인된 sandbox tool을 검증합니다.

```powershell
npm run test:live
```

## 현재 한계

- Kodex 자동화는 Local Server 프로세스가 실행 중일 때만 동작하는 로컬 scheduler입니다.
- API-key 환경에서 Apps/Plugins/connector의 실제 제공 범위는 공식 App Server/계정 지원에 따릅니다.
- 실 모델 호출, Web Search, 원격 MCP 인증은 유효한 사용자 키·설정·명시적 승인 없이는 기본 테스트에서 실행하지 않습니다.
- SSR, cloud task 실행, Kodex 전용 cloud backend는 의도적으로 제공하지 않습니다.
