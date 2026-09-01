# ADR 0007: 공식 런타임 히스토리와 저장된 DB 히스토리 UI 분리

## 결정

공식 Codex App Server의 thread/sidebar 상태는 실행, resume, archive의 유일한 런타임 원본으로 유지한다. PostgreSQL의 `agent_*`, `tool_calls`, `approvals` projection은 로그인한 사용자가 별도의 **저장된 DB 히스토리** 다이얼로그에서 읽는 학습·회고용 보조 기록이다. 두 목록을 병합하거나 한쪽의 상태로 다른 쪽을 덮어쓰지 않는다.

Product API는 매 history GET마다 HttpOnly session을 다시 인증하고, URL의 `workspace_id`와 `X-Kodex-Workspace-Id`가 정확히 한 번 존재하며 동일한 UUID인지 확인한 뒤 membership을 검사한다. repository와 route 모두 `(workspace_id, current user id)`를 적용한다. 추측한 다른 사용자 thread는 `404`, membership 없는 workspace는 `403`, 만료·폐기 session은 `401`이다.

브라우저 계약에는 Codex 공개 thread/turn/item/call/request 식별자와 표시용 상태·시각만 둔다. DB PK, project PK, `source_instance`, `source_event_id`, checksum, embedding/vector, credential/session 정보는 내보내지 않는다. JSONB는 서버에서 민감 키를 다시 필터링하고 깊이·항목 수를 제한한 최대 4,000자 JSON preview로 직렬화한다. 한 page는 최대 50 turn/thread이고 하위 종류별 최대 250개이며, 생략 여부를 명시한다. cursor는 최대 512자의 불투명 base64url 토큰으로 취급한다.

UI는 목록/상세 cursor, loading/empty/error/retry를 독립적으로 관리한다. 긴 preview는 기본적으로 접고 React text rendering만 사용한다. 현재까지 검증된 DTO의 JSON 내보내기만 허용하며 생성한 Blob URL은 클릭 직후 해제한다.

## 결과

projection delivery는 ordered at-least-once이고 DB 장애 시 재시도되므로 최신 공식 대화가 저장 화면에 잠시 없을 수 있다. UI에 이 지연을 명시한다. DB 화면에서 resume/archive/rename 같은 공식 thread 동작은 제공하지 않는다. 기존 migration `0001`~`0004`, vendor와 generated protocol은 이 결정으로 변경하지 않는다.
