# Kodex offline backup/restore runbook

이 절차는 PostgreSQL과 `KODEX_DATA_ROOT`를 함께 복구하는 운영 runbook이다. Backup에는 계정과 대화,
embedding, audit, Codex thread와 pending outbox가 포함되므로 암호화된 restricted volume에서만 수행한다.

## 사전 조건

- 현재 release의 `Kodex-Backup.cmd` 또는 같은 commit의 source checkout
- PostgreSQL 17 호환 `pg_dump`/`pg_restore` (`KODEX_PG_DUMP_BIN`, `KODEX_PG_RESTORE_BIN`으로 exact path 지정)
- 원본/대상 `DATABASE_URL`, `PRODUCT_DB_SSL`; `verify-full`이면 `PRODUCT_DB_CA_CERT`
- 실제 `KODEX_DATA_ROOT`와 이를 모두 담을 여유 공간
- backup output은 data root 안이나 상위 directory가 아니며 아직 존재하지 않아야 함

## Backup

1. 새 agent turn과 UI mutation을 중단하고 Product API, Local Server, Electron을 정상 종료한다.
2. 남아 있는 process가 없는지 확인한다. 도구는 tenant `instance.lock`이 하나라도 있으면 중단한다.
3. 환경에 `DATABASE_URL`, `PRODUCT_DB_SSL`, `KODEX_DATA_ROOT`를 주입한다. Secret을 command argument나 shell
   history에 직접 쓰지 않는다.
4. Source checkout에서는 다음을 실행한다.

   ```powershell
   npm run backup:create -- --path D:\restricted-backups\kodex-2026-09-04
   npm run backup:verify -- --path D:\restricted-backups\kodex-2026-09-04
   ```

   Windows runtime에서는 같은 인자를 `Kodex-Backup.cmd create|verify`에 전달한다. Runtime command는
   `%APPDATA%\Kodex\kodex.env`와 기본 `%APPDATA%\Kodex\data`를 앱과 같은 규칙으로 사용하며 process
   environment가 파일보다 우선한다. Compose의 DB container local socket을 사용할 때만
   `--database-container <exact-name>`을 추가한다.
5. JSON 결과의 `formatVersion`, `databaseBytes`, `fileCount`, `durationMs`를 운영 기록에 남긴다. 경로나
   manifest 내용, token/content는 중앙 log에 복사하지 않는다.
6. Backup directory를 storage-level encryption과 immutable/off-site 정책으로 복제한다. 별도 hash 서명과
   key custody는 release 보안 절차에서 관리한다.

기본 RPO는 마지막 성공 backup 시점이다. 더 짧은 RPO는 PostgreSQL WAL/PITR과 tenant filesystem snapshot을
별도 설계해야 하며 이 도구가 제공하지 않는다.

## Restore drill / 재해 복구

1. 원본 release version과 manifest migration ledger를 확인하고 같은 또는 명시적으로 호환되는 artifact를
   준비한다. 기존 서비스를 정지한 상태를 유지한다.
2. **새 빈 PostgreSQL database**와 **존재하지 않는 새 `KODEX_DATA_ROOT` 경로**를 준비한다. 기존 운영
   DB/data root에 restore하지 않는다.
3. 먼저 `backup:verify`를 실행한 뒤 대상의 `DATABASE_URL`과 새 `KODEX_DATA_ROOT`를 주입한다.
4. 다음을 실행한다.

   ```powershell
   npm run backup:restore -- --path D:\restricted-backups\kodex-2026-09-04
   ```

5. Restore 성공 뒤 Product API readiness, 사용자 login, workspace 목록, Saved DB History, Knowledge 문서,
   Local bootstrap과 기존 Codex thread를 확인한다. Local Server가 시작되면 복원된 pending outbox가 DB로
   drain되는지 status/log로 확인한다.
6. 측정한 create/restore 시간과 검증 결과를 RTO 기록에 남긴다. 테스트 harness의 시간은 작은 fixture일
   뿐 실제 데이터의 RTO가 아니다.
7. 검증이 끝난 뒤에만 DNS/service endpoint 또는 desktop env를 새 DB/data root로 전환한다. 이전 저장소는
   정책 기간 동안 read-only 보존한다.

`pg_restore` 시작 뒤 오류가 발생하면 target database가 부분 상태일 수 있다. 이를 계속 쓰거나 migration으로
수리하지 말고 대상 DB와 새 data root를 폐기한 뒤 다른 빈 대상에서 처음부터 재실행한다. Backup checksum
오류는 원본을 수정하지 말고 다른 immutable copy에서 복구한다.
