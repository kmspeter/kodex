# ADR 0019: Bounded retention maintenance for terminal authentication data

## 상태

Accepted — 2026-09-03

Phase 21의 `product_abuse_rate_limits` 확장은 ADR 0020이 소유한다. 같은 coordinator는 이제 네 번째 bounded
hash-only batch와 `abuseRateLimitsDeleted` aggregate count를 포함하지만, 이 ADR의 기존 0009 migration과
session/invitation/login 보존 계약은 변경하지 않는다.

## 맥락

`auth_sessions`는 token hash만 저장하고 `workspace_invitations`는 raw token 대신 hash를 저장하지만, 폐기·만료·수락된
row도 명시적인 계정 cascade 전에는 남아 있었다. `auth_login_rate_limits`는 로그인 transaction이 오래된 bucket을
최대 100개씩 기회적으로 지우지만, 로그인이 드문 배치에서는 HMAC bucket이 오래 유지될 수 있다. 무제한 `DELETE`,
API request 안의 대규모 정리, 공개 admin endpoint는 serving latency와 권한 경계를 불필요하게 넓힌다.

## 결정

새 `0009_terminal_auth_invitation_retention.sql`은 기존 `0001`~`0008`을 바꾸지 않고 다음 oldest-first candidate
scan을 지원하는 expression index 두 개만 추가한다.

- session terminal time은 보수적으로 `COALESCE(revoked_at, expires_at)`이다. 폐기 row는 폐기 시각, 한 번도 폐기되지
  않은 row는 만료 시각을 사용한다. 따라서 오래전에 만료됐지만 최근에 명시적으로 폐기된 비정상/legacy row도 최근
  terminal row로 간주해 더 오래 보존한다.
- invitation terminal time은 `COALESCE(accepted_at, revoked_at, expires_at)`이다. accepted/revoked는 schema에서
  상호 배타적이며, 둘 다 없을 때만 expiry가 terminal time이다.

Repository의 각 delete는 주입한 cutoff보다 terminal time이 **엄격히 작은** row만 `(terminal_time, id)` 또는
`(updated_at, bucket_hash)` 순서로 고르고 `LIMIT`과 `FOR UPDATE SKIP LOCKED`를 적용한 CTE 한 문장으로 삭제한다.
메서드는 aggregate count만 반환하며 UUID, token/email/bucket hash나 다른 PII를 반환하지 않는다. 여러 Product API
process가 동시에 실행되어도 row lock을 획득한 process만 그 row를 삭제한다. 이는 distributed leader election이
아니며, 여러 bounded worker가 잠긴 row를 건너뛰는 concurrency 모델이다.

rate-limit cutoff는 별도 사용자 설정이 아니라 현재 login window와 block 기간 중 큰 값의 두 배로 계산한다. 또한
`blocked_until`이 reference time 뒤인 row는 보존한다. 기존 로그인 transaction의 최대 100-row 기회적 cleanup도
같은 두 배 정책을 유지하며, 새 global sweep는 로그인이 없는 기간의 stale bucket까지 처리한다.

Product API는 migration 완료 후 server가 listen한 다음 startup sweep를 기다리지 않고 시작하고, 이후 unref된 timer로
반복한다. process 안에서는 sweep가 겹치지 않는다. 각 sweep는 table별 batch size와 round 수를 모두 제한하며, 한
round가 대상 table 모두 batch를 채우지 못하면 일찍 끝난다. shutdown은 timer를 먼저 없애고 진행 중인 bounded DB
작업이 끝난 뒤 HTTP server와 pool을 닫는다. cleanup 오류는 serving을 중단하지 않고 다음 주기에 재시도한다.

로그 이벤트의 표면은 고정 category/outcome/trigger, table별 aggregate delete count, round count와 고정된
`DatabaseError | Error | NonError` class뿐이다. exception message, SQL, `DATABASE_URL`, UUID, hash, email, IP,
session/invitation 값은 기록하지 않는다. cleanup용 HTTP/admin endpoint나 공개 metric은 추가하지 않는다.

환경 설정과 hard range는 다음과 같다. 빈 값은 default로 처리하지만 malformed/out-of-range 값은 listen 전에
startup을 실패시킨다.

| 변수 | 기본값 | hard range |
| --- | ---: | ---: |
| `PRODUCT_RETENTION_ENABLED` | `true` | `true` 또는 `false` |
| `PRODUCT_RETENTION_INTERVAL_SECONDS` | `3600` | 60..86,400 |
| `PRODUCT_RETENTION_BATCH_SIZE` | `100` | 1..1,000 |
| `PRODUCT_RETENTION_MAX_BATCHES` | `10` | 1..100 |
| `PRODUCT_RETENTION_SESSION_DAYS` | `30` | 1..3,650 |
| `PRODUCT_RETENTION_INVITATION_DAYS` | `30` | 1..3,650 |

## 보존 불변식

cleanup은 active/unexpired session, unresolved/unexpired invitation, active login block을 지우지 않는다. `users`,
`workspace_members`, history/thread/turn/item/tool/approval/agent event, `audit_logs`, outbox, RAG source/document/chunk/
retrieval/citation row는 query 대상이 아니다. 기존 session/workspace/private-history/private-RAG authorization도
변경하지 않는다.

## 결과와 운영 한계

이 기능은 제한된 **row retention**이지 secure erasure가 아니다. PostgreSQL의 일반 `DELETE`는 MVCC dead tuple을
만들며 즉시 파일 블록을 덮어쓰지 않는다. 운영자는 autovacuum 상태를 관찰하고 필요하면 계획된 `VACUUM`을 수행해야
한다. `VACUUM FULL` 같은 blocking 작업을 앱이 자동 실행하지 않는다. WAL, replica, snapshot, dump와 외부 backup에는
삭제 전 데이터가 각 시스템의 보존 기간만큼 남을 수 있으므로 별도의 backup/WAL/replica retention과 폐기 정책이
필요하다. table bloat, secure media destruction, 사용자별 legal hold, content/history/RAG/audit retention은 이 결정의
범위가 아니다.
