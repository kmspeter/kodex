# Phase 29 security/release runbook

## 변경 및 CI gate

1. 실제 credential 없이 clean checkout에서 `npm ci --ignore-scripts` 후 `npm run security:validate`와
   `npm run test:security`를 실행한다.
2. Secret 후보가 나오면 값은 ticket/log에 복사하지 않는다. 해당 credential을 폐기·회전하고 파일을 제거한다.
   의도적인 test fixture만 exact path/rule/fingerprint/reason allowlist로 review한다. Directory/prefix 예외는 금지한다.
3. Dependency 변경은 package manifest와 `package-lock.json`을 같은 review에 둔다. Vendor/pin/protocol은 일반
   dependency update로 재생성하지 않는다.

## Production PostgreSQL 역할

- Bootstrap admin: 최초 DB/role provision에만 사용하며 Product API, Local Server, runtime env에 주입하지 않는다.
- Migration: target database와 public schema의 owner지만 cluster superuser/CREATEDB/CREATEROLE/replication/BYPASSRLS는
  금지한다. `PRODUCT_DB_MIGRATION_URL`은 migration job에만 주입한다.
- Application: schema USAGE, application table SELECT/INSERT/UPDATE/DELETE, sequence 사용, `schema_migrations` SELECT만
  허용한다. DB/schema ownership, CREATE, TRUNCATE/REFERENCES/TRIGGER를 금지한다.

새 Compose volume은 `infra/postgres/010-kodex-roles.sh`가 역할을 만든다. 기존 volume은 init script가 재실행되지
않으므로 maintenance window에서 동등한 grants를 적용한 뒤 migration job, application startup 순서로 확인한다.

```powershell
docker compose --env-file .env.local -f infra/compose.yaml --profile migration run --rm product-db-migrate
docker compose --env-file .env.local -f infra/compose.yaml --profile product-api up -d product-api
```

Application startup이 권한 또는 ledger를 거부하면 broad grant로 우회하지 않는다. Migration job의 역할/ledger와
grant를 고친 뒤 다시 시작한다. Production DB URL은 CLI 인자나 일반 log에 출력하지 않는다.

## Release candidate

`release:build`는 build 전에 repository gate를, seal 전에 runtime input gate를 다시 실행한다. 후보가 생성되면
`release:verify`를 별도 host에서도 실행하고 version/commit/fileCount를 release record에 남긴다. Candidate 내부에
환경 파일, tenant/outbox, secret 후보, source와 다른 npm/Cargo lock 또는 Codex metadata가 있으면 배치하지 않는다.
현재 SHA-256 manifest는 authenticity 증명이 아니므로 승인된 저장소 접근 통제와 별도 signing 정책이 필요하다.
