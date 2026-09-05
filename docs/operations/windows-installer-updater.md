# Kodex Windows installer/updater/rollback runbook

이 runbook은 Phase 31의 per-user code layout과 state machine을 packaging host에서 사용하는 절차다. 실제 installer
binary, service, registry, shortcut, process lifecycle과 DB migration은 이 CLI가 수행하지 않는다. Packaging host는
각 adapter 결과와 health evidence를 release record에 남기되 경로, credential, tenant payload를 log에 복사하지
않는다.

## 전제와 보존 경계

- 기본 install root는 `%LOCALAPPDATA%\Programs\Kodex`다. 다른 절대 경로는 `--install-root`로 전달할 수 있지만
  drive root나 user profile root는 거부된다.
- Candidate와 trust store는 install root 밖의 서로 다른 경로에 둔다. External trust store는 현재 승인된
  `storeVersion`/digest여야 하고 artifact가 제공한 store를 사용하지 않는다.
- `--acl-adapter <absolute-executable>`은 packaging이 신뢰하는 외부 Windows ACL verifier다. CLI는 검사 root와
  purpose를 `KODEX_ACL_INSPECTION_ROOT`, `KODEX_ACL_INSPECTION_PURPOSE`로만 전달한다. Verifier는 current user 소유,
  untrusted principal의 write/replace/delete 거부와 ACL 조회 성공을 확인할 때만 exit `0`이어야 한다. 없거나
  애매하거나 실패하면 mutation은 fail-closed다. Candidate/install root 안 verifier는 금지한다.
- `%APPDATA%\Kodex\data`의 tenant data와 tenant별 `CODEX_HOME`, `%APPDATA%\Kodex\kodex.env`, PostgreSQL data,
  operator가 선택한 backup root는 install root 밖에 유지한다. 어떤 installer/uninstall adapter도 이 경로를
  재귀 삭제 대상으로 받지 않는다.

## Plan과 stage

먼저 read-only plan으로 signature, Phase 29 secret gate, compatibility와 ACL precondition을 확인한다.

```powershell
npm run installer:plan -- --candidate D:\incoming\Kodex-0.2.0-windows-x64-<commit12> --trust-store D:\kodex-trust\release-trust-store.json --acl-adapter D:\kodex-packaging\Kodex-Acl-Verify.exe
```

`operation`, release ID, schema version, trust-store version과 automatic rollback 가능성만 출력된다. Path, key,
manifest body나 사용자 payload는 출력하지 않는다. Stage는 candidate를 다시 검증하고 side-by-side release root로
exclusive copy한 뒤 복사본을 다시 검증한다.

```powershell
npm run installer:stage -- --candidate D:\incoming\Kodex-0.2.0-windows-x64-<commit12> --trust-store D:\kodex-trust\release-trust-store.json --acl-adapter D:\kodex-packaging\Kodex-Acl-Verify.exe
npm run installer:status
```

동일 signed digest의 재실행은 `alreadyStaged=true`다. Unsigned/tampered/unknown 또는 revoked key, 낮은 trust-store
version, 같은 version의 다른 digest, reparse/special file, unsafe ACL, ID collision과 unexpected install entry는
실패한다. 실패를 이유로 release directory를 직접 덮어쓰거나 trust receipt/journal을 편집하지 않는다.

## Activate와 health confirm

1. Packaging process adapter로 현재 Electron/Product API/Local Server를 정상 종료하고 Phase 24 backup을 검증한다.
2. Pointer transaction을 시작해 candidate와 conservative schema 위험값을 journal에 먼저 고정한다.

   ```powershell
   npm run installer:activate -- --release Kodex-0.2.0-windows-x64-<commit12> --trust-store D:\kodex-trust\release-trust-store.json --acl-adapter D:\kodex-packaging\Kodex-Acl-Verify.exe
   ```

3. 별도 migration adapter가 current pointer의 candidate에서 필요한 forward migration을 수행한다. Application
   credential로 migration하지 않는다. 이 단계부터 이전 binary의 readable range를 벗어나면 자동 downgrade는
   금지되고 operator recovery가 필요하다.
4. Packaging launcher는 `.installer-state/current.json`이 가리키는 release의 `Kodex.exe`를 시작한다. `/api/health/live`,
   `/api/health/ready`, `/api/version`, login/workspace/history read smoke와 실제 migration ledger version을 확인한다.
5. 모든 health evidence가 맞을 때만 exact release ID와 DB schema를 confirm한다.

   ```powershell
   npm run installer:confirm -- --release Kodex-0.2.0-windows-x64-<commit12> --database-schema 12 --trust-store D:\kodex-trust\release-trust-store.json --acl-adapter D:\kodex-packaging\Kodex-Acl-Verify.exe
   ```

Confirm 전에는 candidate가 last-known-good가 아니다. 중복 activate/confirm은 같은 state 조합에서만 idempotent하고
다른 pending transaction을 덮지 않는다.

## Rollback과 crash recovery

Health 확인 전 실패나 launcher 중단 뒤에는 process를 정지한 상태로 recover한다.

```powershell
npm run installer:recover -- --trust-store D:\kodex-trust\release-trust-store.json --acl-adapter D:\kodex-packaging\Kodex-Acl-Verify.exe
```

- Pointer 전환 전 중단이면 prepared transaction을 취소한다.
- Pointer 전환 후 confirm 전이면 이전 verified release로 자동 rollback한다.
- 첫 설치에 이전 release가 없으면 current pointer를 비활성화한다.
- Confirm 중단이면 이미 기록된 health 결정을 따라 last-known-good promotion을 완성한다.
- Dead PID의 stale lock만 recover가 인수한다. Live PID lock은 `installer_busy`다.
- 이전 release의 signed readable schema range가 journal의 schema 위험값을 포함하지 않으면
  `operator_recovery_required`이며 pointer는 강제로 downgrade하지 않는다.

Confirmed release 뒤의 manual rollback은 다음과 같다. 생략한 schema는 active release latest로 보수적으로
간주하지만, 운영에서는 실제 ledger를 명시한다.

```powershell
npm run installer:rollback -- --database-schema 12 --trust-store D:\kodex-trust\release-trust-store.json --acl-adapter D:\kodex-packaging\Kodex-Acl-Verify.exe
```

Rollback target도 새 activation처럼 health confirmation이 필요하다. 성공하면 그 target ID로 `confirm`한다. 자동
downgrade가 차단되면 migration ledger/down SQL을 수정하지 않는다. Candidate fix-forward 또는 검증된 backup을
새 빈 DB와 새 data root에 복원하는 operator recovery를 수행하고 release record에 분리 기록한다.

## Retention과 uninstall boundary

Stage/confirm은 protected pointer를 제외한 oldest release direct child만 정리해 최대 3개를 유지한다. `.staging-*`나
`.removed-*`가 중단 뒤 남으면 `recover`만 exact root를 재검사해 정리한다. Unknown directory, link/reparse 또는 ACL
검사 실패 때 broad cleanup을 실행하지 않는다.

```powershell
npm run installer:uninstall-code-boundary -- --acl-adapter D:\kodex-packaging\Kodex-Acl-Verify.exe
```

이 명령은 `codeRemovalPerformed=false`인 plan만 반환한다. Packaging uninstaller가 별도 승인을 받아 process를
정지하고 install root code와 shortcut만 제거한다. Phase 31 CLI는 registry/service/shortcut이나 filesystem을 실제
제거하지 않는다. 특히 `%APPDATA%\Kodex`, PostgreSQL storage, backup root를 install root cleanup에 합치지 않는다.

## 검증

```powershell
node --check scripts/lib/windows-installer.mjs
node --check scripts/kodex-installer.mjs
npm run test:installer
npm run test:installer-unit
npm run test:release-signing
npm run security:validate
npm run typecheck
npm run lint
git diff --check
```

`test:installer`는 dependency-free이며 temp release/key/root를 모두 정리한다. `test:installer-unit`, typecheck와 lint는
설치된 repository dependencies가 있을 때 실행한다. 실제 runtime/release/installer artifact 생성, process/service/
registry/shortcut 변경, Docker, Electron과 DB migration은 이 runbook 검증에 포함하지 않는다.
