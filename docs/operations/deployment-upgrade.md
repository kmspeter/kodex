# Kodex release/deployment/upgrade runbook

이 runbook은 versioned Windows portable artifact와 Product API container의 보수적인 배치 절차다. 실제
credential은 환경/secret manager에서 주입하고 artifact, manifest, 명령 인자와 운영 log에 넣지 않는다.

## Release 생성과 검증

1. `main`의 승인된 commit을 checkout하고 `git status --short`가 비어 있는지 확인한다. Tag/release commit과
   vendored Codex pin을 검토한다.
2. Production database recovery policy/schema/docs drift와 current provider drill receipt를 검증한다. Receipt
   timestamp를 수정하거나 development/acceptance profile로 낮춰 우회하지 않는다.

   ```powershell
   npm run recovery:validate
   npm run recovery:cli -- status --receipt <absolute-receipt-path> --at <canonical-utc-evaluation-time>
   ```

   상세 exact-key와 payload-free evidence 계약은 [database recovery runbook](database-recovery.md)을 따른다.
3. clean checkout에서 새 경로로 artifact를 봉인한다. 이 시점 결과는 unsigned이며 배포 승인 대상이 아니다.

   ```powershell
   npm ci
   npm run security:validate
   npm run codex:verify-source
   npm run release:build -- --path D:\releases\Kodex-0.2.0-windows-x64-<commit12>
   ```

4. [offline signing runbook](artifact-signing.md)에 따라 repository/artifact 밖의 private key로 candidate를
   서명한다. 외부 versioned public trust store를 signer와 다른 verifier host에 배포한 뒤 다음 두 경로를
   모두 통과시킨다.

   ```powershell
   npm run release:verify -- --path D:\releases\Kodex-0.2.0-windows-x64-<commit12> --trust-store D:\kodex-trust\release-trust-store.json
   D:\releases\Kodex-0.2.0-windows-x64-<commit12>\Kodex-Release-Verify.cmd --trust-store D:\kodex-trust\release-trust-store.json
   ```

5. JSON의 version/commit/fileCount/keyId/manifestSha256/trustStoreVersion을 release record와 대조한다.
   `release-manifest.json`과 `release-signature.json`은 보존하되 운영 env/data나 private key와 합치지 않는다.
   Restricted immutable storage에 artifact를 복제한다. Unsigned candidate나 artifact가 제공한 trust store는
   배포하지 않는다.
6. Product API container는 같은 clean commit에서 `KODEX_RELEASE_COMMIT` build arg를 주입해 만들고 OCI
   revision label과 `/api/version`을 release record에 대조한다. Mutable tag만으로 배치하지 않는다.

## 배치 전 준비

- Phase 34 encrypted/signed offline backup을 만들고 external trust store와 passphrase 경계로 `backup:verify`를
  통과시킨다. Exact release provenance, 허용 RPO, 예상 RTO와 복원 담당자를 기록한다.
- Phase 35 policy digest와 fresh `recovery_ready` receipt 결과를 release record에 연결한다. DB URL, provider
  resource/snapshot/replica ID, WAL LSN/timeline, host/path와 provider error text는 release record에 넣지 않는다.
- Release record의 trust-store version/digest가 현재 승인 상태보다 오래되지 않았는지 확인한다. Revoked key로
  서명된 이전 artifact도 rollback 대상으로 활성화하지 않는다.
- application과 migration DB 역할/secret을 분리하고 [security runbook](security-release.md)의 금지 권한을 확인한다.
- 새 release의 migration ledger와 현재 DB ledger를 비교한다. Migration lock/write blocking, HNSW build 공간과
  유지보수 창을 계획한다.
- Production은 HTTPS reverse proxy에서 UI와 Product API를 exact same-origin으로 제공한다. API container는
  private network에 두고 `PRODUCT_API_NODE_ENV=production`, exact hosts/origins, secure cookie, DB `verify-full`,
  least-privilege secret을 주입한다.
- 이전 verified artifact/image digest와 이전 환경 계약을 그대로 보존한다. Data root를 release directory 안에
  두지 않는다.

## Deploy/upgrade

1. 새 agent mutation을 막고 API/Local Server/Electron을 정상 종료한다. Backup 이후 쓰기가 없음을 확인한다.
2. Candidate artifact에서 external trust store를 전달한 `Kodex-Release-Verify.cmd --trust-store <path>`를 다시
   실행한다. 실패하면 활성 release를 바꾸지 않는다.
3. 별도 migration job에만 migration credential을 주입해 `npm run db:migrate`를 실행한다. 그 credential을 제거한
   뒤 application credential만 가진 Product API candidate를 시작한다. API/Local은 권한과 exact ledger가 다르면
   port를 열지 않는다.
4. `/api/health/live`, `/api/health/ready`, `/api/version`을 순서대로 확인한다. Version과 commit이 manifest/image
   digest record와 정확히 일치하지 않으면 중단한다.
5. Login, workspace 목록, Saved DB History, Knowledge 조회의 read smoke 후 Local Server/Electron을 시작한다.
   Local readiness, 기존 thread resume, pending outbox drain을 확인한다.
6. 오류율, DB connection, retention/outbox/backfill failure를 관찰한 뒤 maintenance를 해제한다. 시작/완료
   시각, migration, version, smoke와 담당자를 release record에 남긴다.

## 실패와 rollback

- Verify/config/migration 전 실패: candidate를 활성화하지 않고 현재 trust store에서 아직 trusted인 이전
  verified artifact를 재시작한다.
- Migration이 없거나 이전 artifact가 현재 ledger를 이해하는 경우: 모든 process를 중지하고 이전 directory/
  image digest를 다시 실행한 뒤 readiness/version/smoke를 반복한다.
- Migration 적용 뒤 이전 artifact가 `Database migration ... is not present`로 거부되는 경우: ledger를 수정하거나
  down SQL을 만들지 않는다. Candidate를 수정해 재배포하거나, 운영을 계속 중지한 채 검증된 backup을 **새 빈
  DB와 새 data root**에 복원하고 이전 artifact를 그 대상에 연결한다.
- `pg_restore` 실패 target, 부분 배치 directory와 failed container는 재사용하지 않는다. 증거와 aggregate
  진단만 보존하고 secret/사용자 payload는 incident log에 복사하지 않는다.

`test:release-deployment` 시간은 작은 fixture의 RTO일 뿐이다. 실제 데이터와 host에서 정기 restore/deploy
drill을 수행하고 DNS/cache/reverse proxy/container registry의 전환 시간까지 별도로 측정한다.
