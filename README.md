# Kodex

Kodex는 공식 오픈소스 [OpenAI Codex](https://github.com/openai/codex)의 App Server를 로컬에서 실행하는 Windows 개인 앱입니다. UI, Local Server, 공식 Codex 전체 소스, 실행 파일, thread와 설정은 사용자의 컴퓨터에 있습니다. Kodex 전용 원격 백엔드·DB·thread 저장소·배포 서비스는 없습니다.

Kodex는 네트워크 차단기가 아닙니다. 모델 호출, Web Search, 원격 MCP, Git 네트워크 작업과 패키지 설치는 공식 Codex의 sandbox·approval과 사용자 설정에 따라 사용할 수 있습니다. Local Server는 모델을 호출하거나 tool을 선택하지 않으며, 공식 Codex App Server의 stdio JSONL을 localhost HTTP/WebSocket UI에 연결하고 로컬 상태와 프로세스 수명만 관리합니다.

## 구조

```text
apps/ui                 React/Vite renderer
apps/local-server       localhost API, 정적 UI, scheduler, Codex 수명 관리
apps/desktop            Electron 창과 Local Server 수명 관리
packages/codex-protocol 공식 바이너리에서 생성한 protocol/schema
packages/kodex-api      UI ↔ Local Server 계약
packages/shared         JSONL, sequence, 마스킹 유틸리티
vendor/openai-codex     고정된 공식 전체 소스
bin/codex.exe           위 소스에서 빌드한 공식 App Server 바이너리
```

모든 production HTTP API, WebSocket과 정적 UI는 `127.0.0.1`의 같은 origin에서 제공됩니다. 개발 모드에서만 Vite dev server가 별도로 실행됩니다.

## 공식 Codex 소스 고정과 무결성

- upstream commit: `f1433fc71f2062ae3c007a03d7ff549bc582d386`
- source: `vendor/openai-codex/`
- SHA-256 manifest: `VENDOR_SOURCE_SHA256.json`
- build metadata: `bin/codex-build.json`
- protocol metadata: `packages/codex-protocol/codex-version.json`

`npm run codex:verify-source`는 manifest의 commit이 `CODEX_UPSTREAM_COMMIT`과 일치하는지 확인한 뒤 vendored source의 모든 파일을 SHA-256으로 검증합니다. 파일이 추가·삭제·변경되면 명확한 목록과 함께 실패합니다. `.git`이 없어도 검사가 생략되지 않으며 `codex:build`도 Cargo를 실행하기 전에 이 검증을 반드시 거칩니다.

현재 바이너리가 보고하는 내부 문자열 `codex-cli 0.0.0`은 정식 릴리스 버전으로 표시하지 않습니다. UI와 metadata에는 `Codex source build f1433fc71f20`으로 표시됩니다. 다른 release/tag로 바꾸려면 source·protocol 차이를 검토하고 manifest, binary, generated protocol을 함께 갱신해야 합니다.

공식 Rust 소스를 실제로 바꾸거나 바이너리/프로토콜 불일치가 확인된 경우에만 다음을 실행합니다.

```powershell
npm run codex:build
npm run codex:generate-protocol
```

## 실행

Node.js 22.13 이상에서 의존성을 준비합니다.

```powershell
npm install
```

### OpenAI 모드

루트 `.env.local` 또는 Local Server 환경에 키만 설정합니다.

```dotenv
OPENAI_API_KEY=your_openai_api_key_here
```

```powershell
npm run dev
# 또는 production
npm run build
npm start
```

OpenAI 모드가 기본값입니다. Vite/renderer 환경에서는 `OPENAI_API_KEY`와 로컬 provider key를 제거하며, bootstrap·WebSocket·번들·브라우저 저장소·Kodex 로그에도 키를 보내지 않습니다. OpenAI key는 Local Server만 읽고 이 provider를 선택했을 때만 공식 App Server에 전달합니다.

### OpenAI Responses 호환 로컬 모델

설정 창에서 provider를 `Local OpenAI-compatible`로 바꾸고 다음을 입력합니다.

- Base URL: `http://127.0.0.1:<port>/v1` 또는 `http://localhost:<port>/v1`
- Model: 로컬 서버가 노출하는 model 이름
- 선택적 인증: Local Server 환경의 `KODEX_LOCAL_LLM_API_KEY`

이 모드는 `OPENAI_API_KEY` 없이 시작합니다. 공식 Codex의 `model_providers`, `base_url`, `wire_api="responses"`, `requires_openai_auth=false` 설정을 사용하며 자체 추론 adapter는 두지 않습니다. 현재 고정 소스는 Responses wire API만 지원합니다. 로컬 서버가 Responses streaming, Codex tool call 왕복을 충분히 구현하지 않으면 호환성 오류가 표시됩니다. 로컬 모델 선택은 Web Search/원격 MCP 선택과 별개입니다.

## 로컬 데이터와 안정성

`.kodex-data/`에는 공식 `CODEX_HOME`, projects/settings/automations JSON, 마스킹된 approval/log가 저장됩니다. JSON 없음과 손상·권한 오류를 구분하고, 손상 파일은 덮어쓰지 않습니다. atomic rename과 process 내 write 직렬화를 사용하며 `instance.lock`으로 동일 데이터 디렉터리를 여러 Kodex 인스턴스가 동시에 수정하지 못하게 합니다. App Server가 공식 thread 형식을 소유하며 Kodex가 별도 thread DB로 복제하지 않습니다.

## 연결 복구, 승인, 자동화, 재시작

- WebSocket event는 process epoch와 sequence를 가집니다. `hello`는 cursor를 전진시키지 않으며 reconnect replay는 중복 제거 후 reducer에 한 번만 적용됩니다.
- buffer gap 또는 Local Server epoch 변경 시 streaming 임시 상태를 지우고 `thread/list`, active `thread/read`/`thread/resume`으로 재동기화합니다.
- approval/user-input은 가장 최근 활동한 UI 하나에만 할당됩니다. request registry가 중복 응답, timeout, owner disconnect와 App Server restart를 처리하고 다른 UI는 읽기 전용으로 표시합니다.
- scheduler는 명시적 project/cwd를 사용하며 UI active project를 바꾸지 않습니다. automation claim과 다음 실행 시각을 한 저장 작업으로 기록하고 automation별 in-flight lock으로 장기 실행 중복을 막습니다. 재시작 때 실행 중이던 작업은 `interrupted`로 보존하고 overdue 작업은 한 번만 다시 claim합니다.
- App Server는 전체 restart 횟수와 연속 실패를 분리합니다. 안정 실행 시간이 지난 뒤에만 연속 실패를 초기화하며 exponential backoff와 최대 횟수 이후 `failed`를 유지합니다. UI에서 수동 재시작할 수 있습니다.

지원하는 핵심 event는 agent/reasoning/plan delta, command/process 출력과 종료, file change/patch/turn diff, token usage, thread status, warning/error, approval/user input입니다. 알 수 없는 notification은 비밀값을 마스킹한 method/metadata만 진단 로그에 남깁니다. 별도 host dynamic tool registry가 없으므로 `item/tool/call`을 지원한다고 표시하지 않습니다.

## 설정

UI 설정은 실제 Codex 요청/설정에 연결된 항목만 노출합니다: provider/model, sandbox, approval, shell network, Web Search, sidebar/detail panel. Web Search 변경은 active thread를 다음 turn 전에 resume하여 반영합니다. Remote MCP는 가짜 boolean이 아니라 공식 config write/reload 경로로 추가합니다.

## Windows desktop와 runtime bundle

Electron은 기존 Node Local Server를 그대로 관리하면서 Windows 창과 수명 관리를 얇게 제공하기 때문에 사용합니다. renderer Node integration은 꺼져 있고 context isolation과 sandbox를 켭니다. privileged renderer에서 원격 페이지를 열지 않고 외부 링크는 OS 브라우저로 보냅니다. preload에는 파일/폴더 선택만 노출하며 API key를 전달하지 않습니다.

```powershell
npm run build
npm run runtime:bundle
runtime\Kodex-win32-x64\Kodex.exe
```

조직 Device Guard가 이름 변경된 executable을 차단하는 환경에서는 서명이 보존된 원본 Electron 이름을 사용하는 `runtime\Kodex-win32-x64\Kodex.cmd`를 실행합니다.

portable runtime에는 Electron/Node/Chromium runtime, built UI/Local Server, 필요한 JS runtime dependency, `bin/codex.exe`, build/protocol metadata와 license notice가 들어갑니다. 실행 시 Rust, Cargo, MSVC, Vite 또는 TypeScript가 필요하지 않고 외부에서 코드나 바이너리를 내려받지 않습니다. 공식 전체 source는 runtime이 아니라 source repository/bundle에 계속 보존됩니다.

## 검증

```powershell
npm run codex:verify-source
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke:production
npm run runtime:bundle
npm run runtime:smoke
npm run test:local-provider
npm run test:handshake
```

기본 `npm test`는 외부 모델을 호출하지 않습니다. local-provider 검증은 loopback fake Responses server만 사용하고, handshake는 fake key로 `initialize`와 `thread/list`까지만 수행합니다. 실제 API 비용, Web Search, 원격 MCP를 쓰는 `npm run test:live`는 명시적으로 요청받은 경우에만 실행합니다.

## 실제 한계

- 자동화는 Local Server가 켜져 있을 때만 실행되는 로컬 scheduler입니다.
- local provider는 현재 고정 Codex가 지원하는 Responses API 호환성에 한정되며 Chat Completions 전용 서버는 지원하지 않습니다.
- Apps/Plugins/connector와 원격 MCP의 실제 범위·인증은 고정 Codex source와 사용자의 계정/서버에 따릅니다.
- SSR, cloud task, Kodex 전용 cloud backend와 배포 기능은 제공하지 않습니다.

제3자 license와 notice는 `THIRD_PARTY.md` 및 각 dependency에 포함된 license 파일을 참조하십시오.
