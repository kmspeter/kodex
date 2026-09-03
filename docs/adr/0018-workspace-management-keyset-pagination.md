# ADR 0018: Workspace 관리 목록의 scoped opaque keyset pagination

## 상태

Accepted — 2026-09-03

## 맥락

member와 active pending invitation API는 모든 row를 한 응답에 적재했다. Workspace가 커지면 DB 조회,
JSON 직렬화, strict browser parser와 React render가 함께 커지고, URL workspace UUID만으로는 현재 membership을
증명할 수 없다. offset은 동시 insert/delete에서 page 중복·누락을 만들고 뒤쪽 page 비용도 증가시킨다.

## 결정

`GET /api/workspaces/:id/members`와 `GET /api/workspaces/:id/invitations`는 `limit`과 선택적
`cursor`만 query parameter로 받는다. 기본은 50, 최대는 100이며 0, 음수, 비정수, 중복 parameter와
`offset`을 포함한 unknown parameter는 workspace 목록 repository SQL 전에 `400`으로 거부한다. 응답은 exact-key
`{ members, nextCursor? }` 또는 `{ invitations, nextCursor? }`이고, `nextCursor`가 없으면 끝이다.
브라우저 parser도 page row 100개, cursor 512자를 상한으로 하고 extra key와 `null` cursor를 거부한다.

member 순서는 immutable membership lifetime key `(joined_at ASC, user_id ASC)`, invitation 순서는
`(created_at ASC, id ASC)`이다. PostgreSQL tuple comparison과 `limit + 1` sentinel row를 사용하며 offset은
사용하지 않는다. timestamp는 JavaScript millisecond 변환값이 아니라 PostgreSQL의 정확한 text 값을 cursor에
넣어 microsecond tie 경계도 보존하고 UUID가 최종 tie-breaker가 된다. `0008_workspace_management_pagination.sql`은
각 순서를 직접 지원하는 `workspace_members_workspace_joined_idx`와
`workspace_invitations_pending_created_idx`를 추가한다. 실제 PostgreSQL 테스트는 planner 통계를 갱신한 뒤
test transaction에서만 `enable_seqscan=off`로 실제 page SQL의 index plan을 고정한다. 제품 query는 planner
설정을 강제하지 않는다.

cursor payload는 version, endpoint kind, workspace UUID와 마지막 정렬 key를 포함하지만 평문 base64 JSON이
아니다. Product API의 `AUTH_COOKIE_SECRET`에서 `kodex-workspace-pagination-key-v1` domain으로 HMAC-SHA-256
key를 파생하고, random 96-bit nonce의 AES-256-GCM으로 payload를 암호화·인증한다. 따라서 email,
display name, timestamp, UUID는 browser-visible cursor에 평문으로 나타나지 않는다. endpoint/workspace 재사용,
변조, malformed/oversized cursor와 key rotation 전 cursor는 repository SQL 전에 동일한 bounded
`400 invalid_cursor`가 되며 payload, key, SQL 또는 내부 오류는 응답하지 않는다. cursor는 React 메모리에만
있고 browser storage, audit, log에 저장하지 않는다.

각 page read는 cursor 검증 뒤 transaction에서 URL workspace의 active membership과 non-deleted workspace를
다시 확인하고 row를 share-lock한다. member 목록은 모든 current member가 읽을 수 있고, invitation 목록은
owner/admin만 읽는 기존 규칙을 유지한다. invitation predicate는 accepted/revoked/expired row를 계속 제외한다.
raw invitation token은 create `201` 외 page, cursor, DB audit와 log 어디에도 들어가지 않는다.

## 동시성 정책

page 간 snapshot은 유지하지 않는 live keyset이다. immutable 정렬 key보다 큰 row만 다음 page에 포함하므로
존재하는 동일 row가 단순 page 이동으로 중복되거나 건너뛰지 않는다. 첫 page 뒤 삭제·취소·만료된 unseen row는
뒤 page에서 보이지 않고, boundary 뒤에 생성된 row는 보이며 boundary 앞에 생성된 row는 이번 traversal에는
보이지 않는다. 이미 본 member를 제거한 뒤 다시 추가하면 새 `joined_at`의 새 membership lifetime으로 뒤 page에
다시 나타날 수 있다. UI는 `userId`/invitation `id`로 누적 결과를 dedupe한다. 앱 자체의 초대 생성·취소,
역할 변경·member 제거는 cursor traversal을 버리고 첫 page부터 다시 조회한다.

UI는 member/invitation 각각 첫 page loading/empty/error/retry와 누적 page loading/error/retry를 분리한다.
Workspace 변경, 권한 재검증, dialog close와 mutation refresh는 generation을 올리고 in-flight `AbortController`를
취소하므로 이전 page와 cursor가 새 workspace에 적용되지 않는다. 선택 workspace 변경 때 action error와 초대
form 메모리도 초기화한다.

## 결과와 한계

응답 메모리와 render 작업은 page 상한으로 제한되고 뒤 page는 indexable keyset을 사용한다. AES-GCM nonce
충돌 가능성은 96-bit random nonce의 운영상 무시 가능한 수준이며 cursor는 장기 bookmark 계약이 아니다.
Secret rotation, membership lifetime 재생성 또는 concurrent mutation 뒤 완전한 시점 일관성이 필요한 경우
사용자는 첫 page부터 다시 시작해야 한다. History/RAG의 user-private `(workspace_id, created_by_user_id)` scope는
이 변경으로 넓어지지 않는다.
