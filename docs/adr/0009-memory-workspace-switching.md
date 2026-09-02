# ADR 0009: 메모리 전용 runtime workspace 전환과 tenant UI remount

- 상태: 승인
- 날짜: 2026-09-02

## 배경

Product auth context는 한 사용자에게 여러 workspace membership을 반환하지만 기존 UI는 실행 가능한
default 또는 첫 membership 하나에 고정되어 있었다. Local Server와 Product history/knowledge API는 이미
workspace scope를 검사하므로, UI 선택을 바꾸면서 이전 tenant의 socket, 공식 thread state 또는 보조
DB/RAG 화면이 남지 않는 명시적 수명주기가 필요하다. session bearer는 계속 HttpOnly cookie에만 있어야
하며 workspace 선택을 새로운 인증 수단처럼 취급해서는 안 된다.

## 결정

UI는 `{ userId, workspaceId }` 선택을 `ProductWorkspaceApp`의 React 메모리에만 보관한다. Web Storage,
IndexedDB, URL, cookie 또는 DB에는 기록하지 않는다. 최초 선택은 실행 가능한 default membership이고,
그것이 없으면 응답 순서의 첫 `owner`, `admin`, `member` membership이다. `viewer`는 account menu에 역할과
함께 표시하지만 disabled이며 runtime 대상으로 선택할 수 없다.

모든 render는 저장된 선택을 최신 Product auth context와 순수하게 reconcile한다. 사용자 ID가 같고 해당
membership 역할이 계속 실행 가능하면 `/api/auth/me` 재검증 뒤에도 보존한다. membership 제거 또는
`viewer` 강등이면 같은 render에서 default/첫 실행 가능 membership으로 fallback하고, 없으면 runtime을
생성하지 않는 권한 화면으로 이동한다. 사용자 ID가 바뀌면 이전 workspace ID를 고려하지 않고 새 사용자의
초기 규칙을 다시 적용한다. Auth gate는 revalidation 요청을 중복 실행하지 않고 superseded/unmount fetch를
abort하므로 오래된 응답이 종료된 gate를 되살리지 않는다.

실제 runtime subtree key는 `(userId, activeWorkspaceId)`다. key가 바뀌면 이전 `AuthenticatedApp` effect
cleanup이 listener를 해제하고 `KodexClient.close()`를 호출한다. `close()`는 reconnect timer와 socket을
닫고 pending RPC를 reject하며 bootstrap/session proof, replay cursor와 listener를 메모리에서 지운다. 새
subtree는 reducer, active thread, project, dialog, draft, RAG/history view를 초기값에서 만들고 새 workspace
ID로 bootstrap HTTP와 WebSocket을 시작한다. Product API knowledge/history 호출도 같은 active workspace
ID를 받는다. 어떤 client-side 목록이나 reducer도 두 user/workspace의 데이터를 병합하지 않는다.

전환 boot 화면은 새 workspace 이름과 연결 중 상태를 `role=status`/`aria-live`로 알린다. account menu는
현재 이름/역할, `aria-current`인 disabled 현재 항목, disabled viewer 항목을 구분한다. membership이 하나면
현재 workspace 요약만 보여 불필요한 selector를 만들지 않는다. 선택하면 menu가 닫히고 새 subtree boot가
시작된다.

## 진행 중인 turn의 의미

UI 전환은 이전 WebSocket과 pending UI RPC를 닫지만 이미 서버에 접수된 agent turn에 interrupt/cancel
RPC를 보내지 않는다. 따라서 전환 문구는 turn을 취소했다고 표현하지 않고, 이전 workspace의 작업이 서버
정책과 runtime lease 수명에 따라 계속될 수 있다고 알린다. 사용자가 다시 해당 workspace를 선택하면 공식
App Server state를 그 tenant runtime에서 새로 읽는다.

## 결과와 경계

빠른 선택이나 auth 재검증으로 render가 연속되어도 최신 context로 reconcile된 workspace만 key와 모든
HTTP/WS scope에 사용된다. 서버는 매 요청에서 HttpOnly session과 membership을 계속 독립 검증하므로
workspace ID 자체는 권한 증명이 아니다. 이 결정은 DB schema/migration, vendor/generated protocol,
membership 생성 방식을 바꾸지 않는다. 별도 workspace-switch API는 필요하지 않지만 서버측 workspace
생성, 초대, membership/role 관리 API는 아직 없다.
