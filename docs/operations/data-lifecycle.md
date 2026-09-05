# Data lifecycle 운영 runbook

이 문서는 migration `0012_operational_data_lifecycle.sql` 이후의 사용자 export, 계정/Workspace 영구 삭제,
legal hold, Product/Local worker를 운영하는 절차다. 설계 원본은
[ADR 0027](../adr/0027-operational-data-lifecycle.md)이다.

## 보존·삭제 범위

| 데이터 | export | 계정 삭제 | Workspace 삭제 |
| --- | --- | --- | --- |
| 계정 공개 필드와 본인 membership | 포함 | 삭제 | target membership 삭제 |
| 사용자 private History/tool/approval | bounded JSON | 삭제 | target Workspace 범위 삭제 |
| 사용자 private RAG 원문/citation | vector를 제외하고 포함 | 삭제 | target Workspace 범위 삭제 |
| Workspace audit | actor/action/target type/time만 export | 사용자 actor/target 기록 삭제 | FK cascade로 삭제 |
| password/session/reset/invitation hash, abuse bucket | 제외 | 계정 범위 삭제 | 관련 invitation 삭제 |
| provider credential와 embedding/query vector | 제외 | DB export 대상 아님; tenant root/vector row 삭제 | tenant root/vector row 삭제 |
| 알려진 Local tenant root | 제외 | lease/lock 종료 뒤 삭제 | lease/lock 종료 뒤 삭제 |

Export는 category당 기본 10,000행, 전체 최대 16 MiB이고 기본 7일 뒤 artifact가 삭제된다. 한도를 넘으면
`export_limit`으로 종료하며 일부 JSON을 제공하지 않는다. History/RAG content는 자동 age purge하지 않고 명시적
삭제 전까지 보존한다.

삭제 완료 뒤에도 늦게 다시 연결되는 Local 설치를 조정하기 위해 job, installation, local target에 payload가 없는
UUID와 상태가 tombstone으로 남는다. 현재 tombstone 자동 만료는 없다. 이는 “모든 식별자의 삭제” 또는 secure
erasure가 아니라 application content와 연결된 online tenant data 삭제 계약이다.

## 상태와 재시작

`data_lifecycle_jobs`는 `pending → running → waiting_local/blocked_legal_hold → completed`로 진행한다. Worker는
`FOR UPDATE SKIP LOCKED`와 만료 lease를 사용한다. Product API 또는 Local Server가 중단되면 process를 정상
재시작한다. 만료된 `running` claim은 다른 worker가 다시 가져가며, 이미 지워진 filesystem root는 `missing`으로
멱등 완료된다.

- `waiting_local`: 알려진 설치 중 완료되지 않은 local target이 있다.
- `blocked_legal_hold`: active hold가 있다. Hold 해제 뒤 자동으로 다시 검사한다.
- `failed`: `export_limit`, ownership conflict 또는 unsafe filesystem처럼 자동 반복해서는 안 되는 상태다.
- `runtime_busy`/`partial_cleanup`: bounded backoff 뒤 자동 재시도한다.

`unsafe_filesystem`이면 Local Server를 중지하고 해당 설치의 전용 data root에서 target root가 UUID 형태의
`tenants/users/<user>/workspaces/<workspace>`인지, junction/symlink/special `instance.lock`이 없는지 확인한다.
광범위한 root를 삭제하거나 job scope를 임의 변경하지 않는다. 원인을 제거한 뒤 아래 operations retry endpoint에
보호된 ticket/DB 조회로 확인한 job UUID를 전달한다. Job UUID나 tenant 경로를 일반 로그에 남기지 않는다.

```powershell
$headers = @{ Authorization = "Bearer $env:PRODUCT_OPERATIONS_BEARER_TOKEN" }
Invoke-RestMethod -Method Post -Headers $headers `
  -Uri "http://127.0.0.1:47832/api/operations/data-lifecycle/jobs/<job-uuid>/retry"
```

## Legal hold

Hold는 삭제 요청 전에 생성한다. 이미 삭제된 row/file 또는 만료된 backup을 복구하지 않는다. Product operations
token은 32자 이상의 별도 server secret이어야 하고, browser Origin이 붙은 요청은 거부된다. `reasonCode`는
자유 본문이 아닌 최대 64자의 낮은 cardinality code다.

```powershell
$headers = @{
  Authorization = "Bearer $env:PRODUCT_OPERATIONS_BEARER_TOKEN"
  "Content-Type" = "application/json"
}

# User hold
$body = @{ targetType = "user"; userId = "<user-uuid>"; reasonCode = "litigation" } |
  ConvertTo-Json -Compress
$hold = Invoke-RestMethod -Method Post -Headers $headers -Body $body `
  -Uri "http://127.0.0.1:47832/api/operations/legal-holds"

# Workspace hold는 workspaceId를 사용한다.
# 승인된 해제 시 hold response의 id를 사용한다.
Invoke-RestMethod -Method Delete -Headers $headers `
  -Uri "http://127.0.0.1:47832/api/operations/legal-holds/$($hold.id)"
```

Workspace와 관련 user row는 Product finalization과 Local cleanup transaction이 정렬해 잠근다. Hold 생성도 같은
target row를 잠그므로 hold가 먼저 commit되면 DB와 file 삭제가 모두 중단되고, 삭제가 먼저 선형화되면 뒤늦은
hold가 이미 삭제된 내용을 복원하지 않는다.

## 관측과 장애 대응

`GET /api/operations/status`의 `lifecycle`에는 enabled/running, aggregate 처리 수, 마지막 결과/실패 시각만 있다.
`product_data_lifecycle_failed`와 `local_data_lifecycle_failed`는 warning이다. UUID, email, path, payload, cursor,
credential, DB/provider 오류문은 status와 worker log에 포함하지 않는다.

1. Product와 모든 연결 가능한 Local Server의 status를 확인한다.
2. `blocked_legal_hold`는 승인 없는 hold 해제로 우회하지 않는다.
3. `runtime_busy`는 active UI/HTTP/WS lease가 끝나는지 기다린다. 강제 process 종료는 정상 runtime stop이 실패한
   경우에만 해당 설치 범위에서 수행한다.
4. Local 설치가 영구 offline이면 online job이 그 disk를 지울 수 없다. 장치 폐기/재연결 정책으로 별도 처리한다.
5. 실패 수정 뒤 operations retry를 한 번 요청한다. 여러 worker가 동시에 떠도 claim은 하나만 성공한다.

## Backup, PostgreSQL 물리 보존과 복구

삭제 worker가 실행 중일 때 backup을 시작하지 않는다. Product API와 Local Server를 모두 정상 종료한 뒤 offline
backup을 수행한다. Restore는 삭제 이전 backup의 데이터를 되살릴 수 있으므로 복원 직후 lifecycle job/hold와
복원 시점 이후 승인된 삭제 ticket을 재조정한 다음 서비스를 공개한다.

일반 PostgreSQL `DELETE`는 dead tuple, WAL, replica와 snapshot의 즉시 물리 소거를 보장하지 않는다. Lifecycle
worker는 `VACUUM FULL`, block overwrite, encrypted backup/WAL/PITR/replica/snapshot 만료·rekey 또는 disconnected
device 원격 삭제를 수행하지 않는다. Phase 34 backup 암호화/서명도 삭제나 cryptographic erasure를 뜻하지 않는다.
조직의 별도 보존 일정으로 이 복사본을 만료하고 autovacuum/bloat를 관찰한다. 법적 보존 의무가 있으면 backup
수명주기에도 동일한 hold를 운영 절차로 전파해야 한다.

Phase 35의 [managed database recovery runbook](database-recovery.md)은 production 정책에서 WAL/base backup/
replica/provider snapshot 모두에 legal hold와 logical deletion 뒤 `maximumResidualDays`를 선언하고, 외부 provider
drill receipt가 그 전파와 물리 사본 만료 상한을 검증했다고 표시해야 readiness를 허용한다. Lifecycle worker가
이 provider 통제를 실행하거나 receipt를 발행하지는 않는다. Active hold는 잔존 상한의 유일한 명시적 예외이며,
hold 해제 뒤 provider copy의 원래 expiration과 삭제 evidence를 다시 확인한다.
