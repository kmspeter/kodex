# Operational observability runbook

## 목적과 보안 경계

이 runbook은 Product API와 Local Server의 payload-free 상태를 수집하고 fixed alert를 분류하는 절차다. Endpoint는
제품 사용자 기능이 아니며 기본 `404`다. 두 component에 서로 다른 random secret을 secret manager로 주입한다.

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

생성한 값을 각각 `PRODUCT_OPERATIONS_BEARER_TOKEN`, `KODEX_OPERATIONS_BEARER_TOKEN`으로 server process에만
주입한다. `.env.local`, shell history, ticket, screenshot, artifact 또는 `VITE_*` 환경에 실제 값을 남기지 않는다.
Reverse proxy를 통과하는 Product endpoint는 TLS와 source network allowlist를 함께 사용하고, Local endpoint는
loopback 밖으로 publish하지 않는다. Token rotation은 새 secret으로 process를 재시작한 뒤 collector를 즉시
전환하는 방식이며 grace period나 복수 token은 제공하지 않는다.

## 조회

Secret이 이미 현재 process environment에 안전하게 주입되어 있다는 전제에서 다음처럼 조회한다. 응답은 저장이
필요하면 restricted monitoring backend에만 보내고 일반 application log에 전문을 반복 기록하지 않는다.

```powershell
$productHeaders = @{ Authorization = "Bearer $env:PRODUCT_OPERATIONS_BEARER_TOKEN" }
$localHeaders = @{ Authorization = "Bearer $env:KODEX_OPERATIONS_BEARER_TOKEN" }

Invoke-RestMethod http://127.0.0.1:47832/api/operations/status -Headers $productHeaders
Invoke-RestMethod http://127.0.0.1:47831/api/operations/status -Headers $localHeaders
```

30~60초 polling을 권장한다. 공개 liveness/readiness도 별도로 확인하며 운영 endpoint 실패를 application process
failure와 동일시하지 않는다.

## Alert triage

| code | 우선 확인 | 복구 원칙 |
| --- | --- | --- |
| `product_database_unavailable` | PostgreSQL service/TLS/pool/network, 공개 ready 503 | credential을 출력하지 않고 DB 복구 후 ready/status 연속 성공 확인 |
| `local_database_unavailable` | Local process에서 같은 DB 접근과 pool 상태 | 실행 중 agent를 강제 중단하지 말고 DB 복구 후 outbox drain 확인 |
| `product_retention_failed` | DB availability, lock/statement failure, 다음 sweep | 임의 bulk delete 금지; 원인을 고친 뒤 bounded sweep 성공 확인 |
| `runtime_capacity_saturated` | active runtime/lease와 장시간 열린 client | 정상 작업을 우선 보존하고 idle eviction 또는 명시적 capacity 조정 |
| `codex_app_server_unavailable` | pinned binary 존재/integrity와 child lifecycle | vendor pin을 바꾸지 말고 release verification 후 해당 runtime 재시작 |
| `codex_provider_credentials_missing` | tenant provider 설정과 server-only key 주입 | key를 UI/log/status에 복사하지 않고 정상 secret 경계로 재주입 |
| `history_outbox_overflow` | pending bytes/records, DB와 drain 속도 | spool 삭제 금지; DB/sink 복구 후 ordered drain, 필요 시 검증된 backup |
| `history_outbox_database_unavailable` | Local DB probe와 Product DB 상태 | DB 복구 후 pending count 감소와 error runtime 0 확인 |
| `history_outbox_spool_invalid` | tenant backup, filesystem integrity/권한 | 손상 파일을 직접 편집하지 말고 process 정지 후 forensic copy와 복구 판단 |
| `history_reconciliation_failed` | App Server state, bounded retry와 failed/partial count | App Server 복구 후 다음 reconciliation success를 확인 |
| `authorization_revalidation_unavailable` | 503만 장애인지, DB와 pool 상태 | 401/403 logout/archive와 구분하고 DB 복구 후 revalidation success 확인 |

경보가 해제되어도 process-local failure counter는 재시작 전까지 누적된다. Counter 증가율을 보되 user 또는 tenant
별 label을 만들지 않는다. `pendingRecords > 0`만으로 장애로 보지 않고 error/overflow와 drain 추세를 함께 본다.

## 검증과 incident evidence

배포 전 다음을 실행한다.

```powershell
npm run test:observability
npm run test:history-postgres
npm run test:retention-postgres
npm run test:tenant-auth
```

Incident 기록에는 release version/commit, component, fixed alert code, aggregate count와 시각만 남긴다. 응답 전문에
예상 밖 key가 생기면 수집을 중지하고 secret scan을 수행한다. DB URL, stack/error message, tenant root, email,
workspace/thread ID와 outbox record body는 ticket에 첨부하지 않는다. PostgreSQL row와 local spool의 복구/보존은
offline backup runbook을 따르며 이 endpoint는 삭제나 repair action을 제공하지 않는다.
