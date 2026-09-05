# ADR 0028: 통합 보안 경계와 fail-closed release 입력

- 상태: 승인
- 날짜: 2026-09-05

## 결정

Phase 29는 [통합 threat model](../security/threat-model.md)을 현재 실제 architecture의 기준으로 둔다. 문서의
각 신뢰 경계는 코드 validation 또는 test에 연결하며, payload-free logging, HttpOnly/CSRF, private History/RAG,
tenant filesystem, 공식 App Server와 approval 불변식을 바꾸지 않는다.

`security:validate`는 Git tracked file만 bounded하게 열어 secret 후보를 검사하고 lockfile v3의 root/workspace/
registry integrity closure, strict Codex upstream pin·vendored manifest·build/protocol metadata, Compose/Docker/Local
최소 권한 계약을 검증한다. 진단에는 후보 값이 아니라 path, rule, line, truncated SHA-256 fingerprint만 남긴다.
예외는 exact `.secret-scanner-allowlist.json` entry와 검토 사유가 있어야 하며 사용되지 않는 stale entry도 실패한다.

Codex source build metadata v2는 binary, vendored manifest와 Cargo lock SHA-256을 포함한다. Runtime bundle은 binary를
포함한 repository provenance가 완전할 때만 시작하고 npm lock, Cargo lock, vendor/pin/build/protocol metadata를
release input으로 복사한다. Release 생성은 clean HEAD에 더해 tracked/release-input secret scan과 source/runtime
provenance equality를 통과해야 한다. 기존 full-tree release manifest가 이 metadata도 함께 봉인한다.

Production의 Product API와 Local Server는 `DATABASE_URL` application 역할로 migration을 실행하지 않는다. 시작 전
cluster-wide broad attribute, database/schema ownership/CREATE를 거부하고 application table DML 및 read-only migration
ledger를 확인한 뒤 exact ledger만 검증한다. 별도 `db:migrate` process만 `PRODUCT_DB_MIGRATION_URL`의 database-scoped
owner 역할로 DDL을 실행하며 application 역할과 동일하면 실패한다. Migration 역할도 superuser, CREATEDB,
CREATEROLE, replication, BYPASSRLS를 가질 수 없다. Development/test는 기존 single-role migration을 유지하고,
production 모양 acceptance는 explicit flag와 loopback disposable DB에서만 예외다.

## 결과와 한계

Compose는 bootstrap admin을 application process에 전달하지 않고 app/migration credential을 분리한다. Product API와
migration job은 non-root, read-only filesystem, tmpfs, no-new-privileges, dropped capabilities로 실행한다. 기존 volume은
init script가 다시 실행되지 않으므로 새 역할을 운영자가 별도로 provision하고 검증해야 한다.

이 결정은 artifact 서명, installer/update, registry transparency/SBOM, OS service account provisioning, PostgreSQL
TLS/HA를 구현하지 않는다. Secret scanning은 고신뢰 패턴과 entropy heuristic으로 제한되므로 DLP나 credential
rotation을 대신하지 않는다.
