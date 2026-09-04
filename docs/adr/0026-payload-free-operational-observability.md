# ADR 0026: Payload-free operational observability

## 상태

Accepted — 2026-09-04

## 문제

기존 공개 health는 process와 Product DB readiness만 최소 응답으로 확인하고, Local Server의 tenant runtime,
공식 Codex App Server process, durable history outbox, 기존 thread reconciliation과 열린 WebSocket의 DB 재인가는
stderr의 aggregate event 또는 내부 객체로만 관찰할 수 있었다. 운영자는 장애를 빠르게 분류해야 하지만 대화,
email, tenant/thread ID, 로컬 경로, DB URL과 provider 오류문을 metric label이나 진단 응답으로 내보내면 새로운
정보 유출 경계와 무제한 cardinality가 생긴다.

## 결정

Product API와 Local Server에 각각 `GET /api/operations/status`를 추가한다. Endpoint는 기본 비활성이며 서버 전용
`PRODUCT_OPERATIONS_BEARER_TOKEN` 또는 `KODEX_OPERATIONS_BEARER_TOKEN`이 설정된 경우에만 활성화된다. Token은
32~512자의 whitespace/control-free secret이어야 하고 exact `Authorization: Bearer` 값을 constant-time으로
검사한다. 두 component에는 서로 다른 32-byte CSPRNG secret을 사용한다. Browser `Origin`이 있는 요청은
allowlist 여부와 관계없이 거부하며 CORS 또는 제품 session/CSRF를 운영 인증으로 재사용하지 않는다. Token이
없으면 `404`, 없거나 틀린 bearer와 browser 요청은 같은 `401`이다.

공개 `/api/health/live`, `/api/health/ready`, Local `/api/health` 계약은 바꾸지 않는다. 운영 응답은 다음 fixed
schema의 aggregate만 가진다.

- component/status/generatedAt과 process uptime
- 현재 DB probe 결과, 연속 실패 횟수와 첫/최근 안전 시각
- Product retention의 enabled/running/마지막 outcome과 table별 aggregate 삭제 수
- Local active runtime/lease/capacity와 App Server state별 수
- Local outbox pending record/byte 및 overflow/DB unavailable/invalid spool runtime 수
- reconciliation running/failed/partial runtime 수
- HTTP/WS 거부, history 상태, authorization revalidation 성공/실패의 process-local monotonic counter
- fixed alert code, severity, 최초 active 관측 시각

응답에 user/workspace/session/thread/document/event ID, email, prompt/response/tool payload, cursor, absolute path,
오류 message/name, DB URL, bearer/API key 또는 동적 label을 넣지 않는다. RuntimeManager의 기존 상세 `inspect()`를
직렬화하지 않고 별도 aggregate projection을 만든다. 실패 counter는 process 재시작 시 초기화되므로 감사 기록이나
과금 원장이 아니다.

## 경보 의미

`product_database_unavailable`와 `local_database_unavailable`은 endpoint 시점의 실제 `SELECT 1` 실패다.
`product_retention_failed`는 최신 sweep failure이며 다음 success에서 해제된다. Local의 runtime capacity,
App Server failure/missing binary or credential, outbox overflow/DB/spool, reconciliation failed/partial은 현재 active
runtime aggregate에서 계산한다. `authorization_revalidation_unavailable`은 status `503` 재인가 실패 뒤 더 최신
성공이 없을 때만 활성화한다. Session logout/archive에 따른 `401/403` 종료는 counter에는 포함되지만 장애 alert로
분류하지 않는다.

경보 code는 자동화 가능한 stable identifier지만 schema 전체는 아직 public compatibility API가 아니다. 외부
collector는 bounded 주기로 polling하고 HTTP status와 JSON schema를 함께 검증해야 한다. Endpoint 자체의 DB probe가
과도한 부하가 되지 않도록 scrape interval은 기본 30초 이상을 권장한다.

## 검증

`npm run test:observability`는 build된 계약과 실제 Product/Local HTTP server에서 disabled/missing/wrong/browser
bearer 경계를 확인한다. 주입한 DB error message에 credential/경로를 넣고 Product/Local DB failure, Local
runtime capacity, App Server failure, outbox overflow/DB outage, reconciliation failure와 reauthorization `503`을
발생시킨 뒤 fixed alert/counter만 응답하고 secret, 오류문과 tenant data root를 포함하지 않는지 검사한다. DB와
reauthorization recovery 뒤 해당 transient alert가 해제되는지도 확인한다.

## 한계와 후속 작업

이 결정은 외부 Prometheus/OTel backend, paging/on-call product, distributed counter persistence, trace와 log shipping을
설치하지 않는다. Process-local counter는 여러 replica에서 합산되지 않으며 alert 전달은 운영 collector 책임이다.
History/RAG/audit/local file의 보존·export·delete·legal hold와 backup/WAL/replica/snapshot의 삭제 한계는 Phase 28의
별도 data lifecycle 결정으로 다룬다.
