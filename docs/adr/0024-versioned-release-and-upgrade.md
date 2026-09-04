# ADR 0024: Versioned release artifact와 forward-only upgrade

- 상태: 승인
- 날짜: 2026-09-04

## 배경과 결정

Portable runtime이 실행된다는 사실만으로 어느 source와 migration으로 만들어졌는지, 배치 전에 파일이
변조되지 않았는지, 실패 뒤 어느 artifact로 돌아갈지 증명할 수 없다. Phase 25는 Windows runtime을 clean
Git HEAD에서만 sealed release directory로 만들고, Product API가 같은 release identity를 반환하도록 한다.

`npm run release:build -- --path <new-directory>`는 build와 runtime bundle을 새로 만든 뒤 release metadata를
주입한다. `release-manifest.json` version 1은 semantic application version, exact 40-hex Git commit,
`win32/x64`, ordered migration version/name/checksum, 고정 Codex upstream commit, vendored source manifest
SHA-256과 artifact의 모든 regular file path/size/SHA-256을 기록한다. Symlink, special file, unlisted file,
`.env*`, `kodex.env`, tenant/outbox/instance lock은 거부한다. Manifest 검증 성공 뒤에만 생성 runtime directory를
요청한 versioned path로 atomic rename한다.

Release에는 자체 전체-tree verifier인 `Kodex-Release-Verify.cmd`가 포함된다. Product API의 unauthenticated
`GET /api/version`은 `{ version, commit }`만 반환하고 no-store/security header를 유지한다. Sealed runtime은
`metadata/release.json`, container build는 clean commit build argument를 원본으로 사용한다. 환경과 packaged
identity가 다르면 listen 전에 실패해 실행 파일과 표시 version이 어긋나지 않는다.

## Upgrade와 rollback

SQL migration은 기존 checksum ledger와 동일한 forward-only 계약이다. Product API는 migration을 완료하고
DB-backed readiness가 준비된 뒤에만 listen한다. 적용 DB에 현재 artifact가 모르는 더 높은 migration이
있거나 기존 checksum이 다르면 listen하지 않는다. 배포 순서는 backup → artifact verify → API quiesce →
migrate/start → readiness/version/smoke → Local/Electron 활성화다.

Artifact directory는 in-place로 덮지 않고 이전 release와 candidate를 별도 보존한다. DB schema가 두
artifact 모두와 호환되는 동안에는 process를 중지하고 이전 verified directory를 다시 실행할 수 있다.
새 migration 적용 뒤 이전 artifact가 ledger를 모르면 애플리케이션만 강제로 rollback하지 않는다. 새
artifact를 수정/재배포하거나 Phase 24 backup을 새 빈 DB/data root에 복원한 뒤 이전 artifact로 전환한다.
Down migration과 운영 DB ledger 수동 삭제는 제공하지 않는다.

## Acceptance와 비목표

`npm run test:release-deployment`는 새 build/runtime를 봉인하고 실제 PostgreSQL 17 pgvector DB에 packaged
Electron Node runtime의 Product API를 production profile로 실행한다. Fresh DB migration 0001~0011이 listen
전에 끝났는지, readiness와 exact version/commit을 확인한다. Disposable DB에 future ledger entry를 넣으면
artifact가 listen 전에 종료되는지 확인하고 fixture를 원상복구한 뒤 같은 verified release 재기동까지
연습한다. Unit test는 manifest extra/tamper와 tenant 혼입, identity mismatch를 거부한다.

이 단계는 installer, automatic updater, Authenticode/code signing, container registry, DNS/reverse proxy,
PostgreSQL HA를 제공하지 않는다. SHA-256 manifest는 손상 검출이지 서명/authenticity가 아니므로 artifact
서명과 배포 권한은 별도 release security 단계에서 닫는다.
