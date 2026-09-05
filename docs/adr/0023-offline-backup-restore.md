# ADR 0023: PostgreSQL과 tenant data의 검증된 offline backup/restore

- 상태: 승인
- 날짜: 2026-09-04

> Phase 34는 이 plaintext directory/manifest를 검증된 inner format으로 유지하면서 production CLI 바깥
> encrypted/signed envelope v2를 추가했다. 현재 운영 경계와 plaintext 호환 정책은
> [ADR 0033](0033-encrypted-signed-offline-backup.md)이 우선한다.

## 배경과 결정

제품의 durable 상태는 PostgreSQL과 Local Server의 `KODEX_DATA_ROOT`에 나뉜다. PostgreSQL에는 계정,
workspace, History/RAG/audit가 있고 tenant root에는 공식 Codex home, settings, automation, approval log와
DB 장애 중 pending History outbox가 있다. 둘 중 하나만 복사하면 재해 복구가 완전하지 않다.

Phase 24는 `scripts/kodex-backup.mjs`와 Windows runtime의 `Kodex-Backup.cmd`를 offline 운영 도구로
제공한다. Create는 PostgreSQL custom-format consistent dump와 tenant tree를 새 backup directory에 모으고,
manifest checksum을 전부 검증한 뒤에만 임시 directory를 최종 이름으로 atomic rename한다. Restore는
manifest 전체를 먼저 검증하고 **빈 PostgreSQL database와 존재하지 않는 `KODEX_DATA_ROOT`**에만 적용한다.
기존 database/data root를 덮거나 merge하는 모드는 제공하지 않는다.

## Quiesce와 lock

Backup/restore 전에 모든 Local Server/Electron instance를 종료한다. 도구는 data root 최상위에
`.kodex-offline-maintenance.lock`을 `wx`로 만들고 모든 하위 `instance.lock`을 검사한다. 하나라도 있으면
backup을 거부한다. `RuntimeManager`도 maintenance lock이 있으면 시작하지 않아 backup 도중 새 runtime이
tenant 파일을 변경하는 경쟁을 막는다. Product API는 PostgreSQL dump의 transaction snapshot과 양립하지만,
정확한 운영 restore point를 위해 runbook은 Product API도 quiesce하도록 요구한다.

Lock은 backup에 포함되지 않는다. Symlink, special file, 200,000개 초과 파일, root/상호 포함 경로,
existing output, non-empty restore DB, existing restore data root는 fail-closed다. 실패한 create의 UUID partial
directory와 restore의 새 data root는 정리하지만, `pg_restore`가 시작된 뒤 실패한 target database는
부분 상태일 수 있으므로 폐기하고 새 빈 DB에서 다시 수행한다.

## Manifest와 비밀 경계

Manifest version 1은 application version/optional 40-hex commit, 생성 시각, ordered migration
version/name/checksum, database dump size/SHA-256, tenant regular-file relative path/size/SHA-256만 가진다. DB URL,
password, host/user, data root absolute path, cookie/provider secret은 저장하지 않는다. Restore는 exact-key,
contiguous migration, bounded path/count/manifest size와 backup 및 복구 대상의 모든 실제 file hash를 검증한다.

Host `pg_dump`/`pg_restore`에는 password를 argument가 아닌 `PGPASSWORD`로 전달한다. Child environment는
실행에 필요한 OS 변수와 PostgreSQL SSL 변수로 제한해 `AUTH_COOKIE_SECRET`, OpenAI/provider key 등 Product
process secret을 상속하지 않는다. `verify-full`은 `PRODUCT_DB_CA_CERT`를 permission-restricted temporary
file로 전달하고 즉시 삭제한다. `--database-container`는 Compose/test의 동일 database/user를 local socket로
접속할 때만 쓰며 strict container name을 요구한다.

Backup은 인증정보와 사용자 content를 포함하는 민감 artifact다. 이 Phase의 plaintext manifest checksum은
무결성 검출이지 authenticity/signature가 아니다. Phase 34 production CLI는 이 directory를 직접 배포하지 않고
AES-256-GCM/Ed25519 envelope로만 게시한다. Storage ACL, off-site copy, key rotation, immutable retention과 backup
삭제는 계속 운영자가 책임진다.

## Acceptance

`npm run test:backup-restore`는 source/target `pgvector/pgvector:0.8.6-pg17` container를 각각 만들고 source에
실제 migration, Argon2 계정/session/workspace, History snapshot, 3차원 private RAG document와 pending outbox를
기록한다. Active `instance.lock` 거부 뒤 backup을 만들고 fresh target에 restore한 다음 password login,
History/RAG 조회와 tenant outbox content를 검증한다. Existing target 재복원과 checksum tamper도 거부하며
두 container와 temp tree는 `finally`에서 정리한다.
