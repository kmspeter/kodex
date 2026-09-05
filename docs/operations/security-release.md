# Phase 29/30 security/release runbook

## 변경 및 CI gate

1. 실제 credential 없이 clean checkout에서 `npm ci --ignore-scripts` 후 `npm run security:validate`와
   `npm run test:security`를 실행한다.
   Phase 35부터 `security:validate`는 default production database recovery policy와 schema/package/docs drift도
   함께 검사한다. Recovery-only 확인은 `npm run recovery:validate`, temp fixture는 `npm run test:recovery`다.
2. Secret 후보가 나오면 값은 ticket/log에 복사하지 않는다. 해당 credential을 폐기·회전하고 파일을 제거한다.
   의도적인 test fixture만 exact path/rule/fingerprint/reason allowlist로 review한다. Directory/prefix 예외는 금지한다.
3. `security:validate`가 key 없는 bootstrap release trust store까지 strict parser로 검증하는지 확인한다.
   Production public trust store는 별도 신뢰 경로에서 `trust-store-validate` 후 배포하며 private key는 이 gate의
   입력이나 환경에 넣지 않는다.
4. Dependency 변경은 package manifest와 `package-lock.json`을 같은 review에 둔다. Vendor/pin/protocol은 일반
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

`release:build`는 build 전에 repository gate를, seal 전에 runtime input gate를 다시 실행한다. 생성된 candidate는
`kodex_release_sealed_unsigned`이며 trusted로 취급하지 않는다. [offline artifact signing runbook](artifact-signing.md)에
따라 seal 이후 external private key로 Ed25519 서명하고, 별도 host의 versioned public trust store로
`release:verify`를 통과시킨 뒤 version/commit/fileCount/keyId/manifest digest/store version을 release record에
남긴다. Candidate 내부에 환경 파일, tenant/outbox, secret 후보, source와 다른 npm/Cargo lock/Codex metadata,
private key 또는 artifact-provided trust store가 있으면 배치하지 않는다. 설치·실행·rollback·update 전에도 같은
independent verifier를 호출한다.
