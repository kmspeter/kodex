# Kodex encrypted offline backup/restore runbook

이 절차는 PostgreSQL custom dump와 `KODEX_DATA_ROOT`를 함께 암호화·서명하고 복구하는 운영 runbook이다.
Backup에는 계정, 대화, embedding, audit, Codex thread와 pending outbox가 포함된다. Phase 34 CLI는 단일-file
envelope v2만 생성·검증·복원하며 plaintext backup directory를 production에서 받지 않는다.

## 사전 조건

- 승인된 exact release의 `Kodex-Backup.cmd` 또는 clean source checkout
- PostgreSQL 17 호환 `pg_dump`/`pg_restore` (`KODEX_PG_DUMP_BIN`, `KODEX_PG_RESTORE_BIN`으로 exact path 지정)
- 원본/대상 `DATABASE_URL`, `PRODUCT_DB_SSL`; `verify-full`이면 `PRODUCT_DB_CA_CERT`
- 실제 `KODEX_DATA_ROOT`, encrypted output과 transient restricted work root를 담을 여유 공간
- artifact 밖의 Ed25519 PKCS#8 private key와 별도 경로로 배포한 canonical public trust store
- 16~4,096 byte one-line backup passphrase의 승인된 custody/recovery 절차

Output은 data root 안이나 그 상위가 아니고 아직 존재하지 않는 file이어야 한다. 같은 파일을 덮거나 in-place로
재서명하지 않는다. 기본 `config/release-trust-store.json`은 key가 없는 bootstrap 예시이므로 production backup을
신뢰하지 않는다.

Create의 transient root는 output parent에 둔다. Verify/restore는 기본적으로 artifact parent를 사용하며 그 위치가
read-only이면 `--work-directory D:\restricted-backup-work`로 별도의 existing restricted directory를 지정한다.
CLI는 work/output parent의 POSIX mode 또는 Windows owner/DACL도 secret file과 같은 정책으로 확인한다.

Passphrase/key bytes를 command argument, 일반 environment, `kodex.env`, manifest, shell transcript 또는 ticket에
넣지 않는다. CLI는 전용 file path 또는 non-interactive stdin flag만 받는다. POSIX secret file은 group/other mode가
없어야 한다. Windows file은 inheritance를 제거하고 현재 사용자(필요하면 SYSTEM/Administrators만 추가) 외 allow
ACE가 없게 만든다. CLI가 Windows owner/DACL을 확인할 수 없거나 다른 SID의 allow ACE가 있으면 실패한다.
Repository/runtime/artifact 안에 private key를 두지 않는다.

## Backup 생성

1. 새 agent turn과 UI mutation을 중단하고 Product API, Local Server, Electron을 정상 종료한다.
2. 남아 있는 process가 없는지 확인한다. 도구는 tenant `instance.lock` 또는 runtime start intent가 하나라도 있으면
   중단하고 data root 최상위 maintenance lock으로 새 runtime 시작을 막는다.
3. DB/data-root 환경만 승인된 secret injection 경로로 주입한다. DB password는 PostgreSQL child argument나 결과
   JSON에 나타나지 않는다.
4. Passphrase를 pipe하고 private signing key는 restrictive file로 전달하는 예시는 다음과 같다.

   ```powershell
   Get-Content -Raw -LiteralPath E:\offline-secrets\backup.passphrase |
     npm run backup:create -- --path D:\restricted-backups\kodex-2026-09-05.kdbx --key-id backup-2026-q3 --passphrase-stdin --signing-key-file E:\offline-secrets\backup-2026-q3.pem
   ```

   Portable runtime은 `npm run backup:create --` 대신 다음 entrypoint를 사용한다.

   ```powershell
   Get-Content -Raw -LiteralPath E:\offline-secrets\backup.passphrase |
     .\Kodex-Backup.cmd create --path D:\restricted-backups\kodex-2026-09-05.kdbx --key-id backup-2026-q3 --passphrase-stdin --signing-key-file E:\offline-secrets\backup-2026-q3.pem
   ```

   반대로 `--passphrase-file`과 `--signing-key-stdin`을 사용할 수 있다. 두 secret을 모두 stdin으로 지정하거나
   `--passphrase`/환경 변수로 값을 전달하는 형식은 없다. Compose/test의 같은 DB container local socket을 사용할
   때만 `--database-container <exact-name>`을 추가한다.
5. Create는 verified plaintext v1 directory를 output과 같은 restricted volume의 UUID 임시 root에 만들고
   streaming archive/gzip/AES-256-GCM을 거쳐 exclusive final file로 게시한 뒤 임시 root를 제거한다. 중간 plaintext가
   crash residue로 남을 가능성에 대비해 volume encryption, ACL과 운영 cleanup 정책을 적용한다.
6. JSON의 `formatVersion=2`, `databaseBytes`, `fileCount`, `durationMs`, `keyId`만 운영 record에 남긴다. 경로,
   passphrase, private key, manifest/tenant content나 signature bytes를 중앙 log에 복사하지 않는다.

## Independent verify와 보관

Signer와 다른 host에서 artifact 밖의 현재 public trust store를 사용한다.

```powershell
Get-Content -Raw -LiteralPath E:\offline-secrets\backup.passphrase |
  npm run backup:verify -- --path D:\restricted-backups\kodex-2026-09-05.kdbx --trust-store D:\kodex-trust\release-trust-store.json --passphrase-stdin
```

Runtime은 `Kodex-Backup.cmd verify`에 같은 flags를 전달한다. 출력의 format/keyId/trustStoreVersion과 release
version/commit, migration last version, Codex/vendor provenance를 승인 record에 대조한다. CLI 출력에는 provenance
값 자체를 반복하지 않으므로 필요하면 서명된 release record와 artifact custody record를 함께 사용한다.

Verified file을 restricted immutable/off-site storage에 복제하고 passphrase recovery material과 trust store는 서로
다른 통제 경로에 둔다. Key rotation은 새 trusted public key를 더 높은 store version으로 먼저 배포한 뒤 새 backup에
새 key ID를 사용한다. Key를 `revoked`로 바꾸면 그 key가 서명한 과거 backup도 즉시 복원 불가 상태가 되므로 incident
정책에 따라 격리·대체 backup 생성 여부를 결정한다. Trust-store rollback 방지는 외부 배포 record가 담당한다.

기본 RPO는 마지막 성공 encrypted backup 시점이다. 더 짧은 RPO는 PostgreSQL WAL/PITR과 tenant filesystem snapshot을
별도 설계해야 하며 이 도구가 제공하지 않는다.

## Restore drill / 재해 복구

1. Backup의 exact version/commit과 같은 signed release를 준비한다. 다른 version/commit/migration/vendor provenance는
   fail-closed하므로 먼저 최신 runtime으로 억지 복원하지 않는다. 원래 release로 복원한 뒤 forward upgrade한다.
2. 모든 서비스를 정지하고 **새 빈 PostgreSQL database**와 **존재하지 않는 새 `KODEX_DATA_ROOT` 경로**를 준비한다.
   기존 운영 DB/data root에 restore하거나 merge하지 않는다.
3. Independent `backup:verify`를 다시 통과시킨다. Restore 자체도 signature부터 모든 검사를 반복하므로 verify 결과를
   우회 token으로 사용하지 않는다.
4. 대상 DB/data-root 환경을 주입하고 다음을 실행한다.

   ```powershell
   Get-Content -Raw -LiteralPath E:\offline-secrets\backup.passphrase |
     npm run backup:restore -- --path D:\restricted-backups\kodex-2026-09-05.kdbx --trust-store D:\kodex-trust\release-trust-store.json --passphrase-stdin
   ```

5. 구현은 envelope length/trailing → external trust signature/revocation → scrypt/GCM authentication → gzip/archive
   framing/path → inner manifest/DB dump/tenant SHA-256 → runtime provenance를 모두 확인한 뒤에야 empty DB/new data-root
   계약과 `pg_restore`를 실행한다. 앞선 검증 실패에는 target DB/data-root write가 없다.
6. 성공 뒤 Product API readiness, 사용자 login, workspace 목록, Saved DB History, Knowledge 문서, Local bootstrap과
   기존 Codex thread를 확인한다. Local Server가 시작되면 복원된 pending outbox가 DB로 drain되는지 확인한다.
7. 측정한 create/verify/restore 시간과 stable 결과 code만 RTO record에 남긴다. 검증 뒤에만 DNS/service endpoint 또는
   desktop env를 새 DB/data root로 전환하고 이전 저장소는 정책 기간 read-only 보존한다.

`pg_restore` 시작 뒤 오류가 발생하면 target database가 부분 상태일 수 있다. 이를 계속 쓰거나 migration ledger를
수리하지 말고 대상 DB와 새 data root를 폐기한 뒤 다른 빈 대상에서 처음부터 재실행한다. Signature/GCM/checksum
오류는 원본을 수정하지 말고 다른 immutable copy와 custody record를 조사한다.

## Stable 실패 code와 exit status

| JSON `code` | Exit | 의미 |
| --- | ---: | --- |
| `backup_operation_failed` | 1 | DB/tool/I/O operation 실패 |
| `backup_usage_invalid` | 2 | command/flag/config 계약 위반 |
| `backup_secret_rejected` | 3 | passphrase/key input·permission·format 거부 |
| `backup_authenticity_rejected` | 4 | signature/trust/unknown/revoked key 거부 |
| `backup_integrity_rejected` | 5 | framing/GCM/archive/checksum/tamper 거부 |
| `backup_provenance_rejected` | 6 | version/commit/migration/Codex/vendor mismatch |
| `backup_target_rejected` | 7 | output/work/restore target 안전 계약 위반 |

오류 JSON은 `kind`와 code만 출력한다. 원인 조사 시에도 passphrase, key, tenant ID, path, manifest content 또는 DB
diagnostic을 일반 log에 추가하지 않는다.

## Plaintext v1 호환 정책

Phase 24 library와 실제 PostgreSQL acceptance는 inner format 검증을 위해 남아 있다. Phase 34 production CLI는
directory auto-detection, plaintext create/verify/restore나 `--allow-plaintext`를 제공하지 않는다. 기존 plaintext
backup은 격리된 legacy Phase 24 release와 restricted storage에서만 검증·복원하고, 서비스 연결 전에 Phase 34
CLI로 새 encrypted/signed backup을 생성해 이후 custody 기준으로 삼는다.
