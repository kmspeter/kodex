# ADR 0030: Windows per-user installer, updater와 rollback state machine

- 상태: 승인
- 날짜: 2026-09-05

## 배경과 결정

Phase 30은 release authenticity를 닫았지만 설치 경로, current release 전환, 중단 복구와 retention을 구현하지
않았다. Phase 31은 실제 installer executable을 만들지 않고 향후 packaging host가 호출할 machine-readable
layout/compatibility metadata와 dependency-free CLI/state machine을 제공한다. 기본 scope는
`%LOCALAPPDATA%\Programs\Kodex`의 per-user 설치다. Admin elevation, Windows service, system-wide install,
registry/shortcut 변경과 packaging code removal은 adapter 경계이며 이 Phase에서 실행하지 않는다.

`config/windows-installer-layout.json`은 `releases/`와 `.installer-state/`, pointer/journal/lock/receipt 파일,
최대 release 수와 외부 데이터 분류를 고정한다. JSON Schema와 executable exact-key parser가 함께 있으며
state record도 `config/windows-installer-state.schema.json`의 pointer/transaction/lock/trust receipt 네 계약만
허용한다. Release에는 signed tree의
`resources/app/metadata/installer-compatibility.json`이 들어간다. Phase 31 당시 metadata는 migration `0012`와
forward-only, readable schema `12..12`를 선언하고 runtime bundle 단계에서 실제 migration ledger와 다시
대조했다. Phase 32의 forward-only migration `0013`은 ADR 0031에서 current/readable schema를 `13..13`으로 올린다.

Candidate는 어떤 install-root mutation보다 먼저 Phase 30 external versioned trust-store verifier를 통과해야
한다. 그 뒤 Phase 29 release-input secret scan, path/regular-file/reparse 검사와 외부 Windows ACL verifier가
통과해야 한다. Trust store나 ACL verifier가 candidate/install root 안에 있거나 ACL adapter가 없거나 판단하지
못하면 실패한다. Installer는 승인한 trust-store version과 SHA-256만 state에 보존해 더 낮은 version과 같은
version의 다른 digest를 거부하며 public key/store 자체를 artifact에 복사하지 않는다.

## Side-by-side와 transaction

Release는 `releases/Kodex-<semver>-windows-x64-<commit12>`에만 존재한다. Stage는 같은 `releases/` 안의 무작위
temporary directory에 regular file만 exclusive copy하고 signature, full-tree checksum, secret, reparse와 ACL을
다시 검증한 뒤 같은 directory 안에서 rename한다. 기존 release directory를 덮어쓰지 않는다. 동일 digest의
중복 stage는 idempotent이고 같은 ID의 다른 내용은 collision이다.

Active pointer는 directory symlink가 아니라 canonical `.installer-state/current.json`이다. Pointer와 journal은
각 대상 파일과 같은 directory의 exclusive temporary file을 flush한 뒤 rename하므로 volume을 넘지 않는다.
Activation은 journal `prepared` → current pointer 교체 → `awaiting-health` 순서다. 외부 process adapter가 candidate를
시작하고 readiness/version/smoke와 실제 DB schema를 확인한 뒤에만 `confirm`한다. Confirm은 `confirming`을 먼저
기록하고 이전 confirmed release를 rollback candidate로, 새 release를 last-known-good로 승격한 다음 journal을
제거한다.

`recover`는 stale dead-process lock과 exact `.staging-*`/`.removed-*` root만 정리한다. `prepared`에서 pointer가
바뀌지 않았으면 transaction을 취소하고, health confirmation 전 candidate가 active면 이전 release로 자동
rollback한다. Confirm 기록 뒤 중단됐으면 promotion을 완성한다. 각 단계는 pointer/journal의 실제 조합을
확인하며 예상하지 않은 조합을 추측해 고치지 않는다. Live lock은 깨지 않고 `installer_busy`로 실패한다.

## Forward-only DB와 rollback

Activation journal의 schema 위험값은 candidate가 선언한 latest schema다. 이전 release의 signed readable range가
이 값을 포함할 때만 health 실패 후 binary 자동 rollback이 허용된다. Manual rollback도 operator가 제공한 현재
schema 또는 active release의 보수적 latest schema가 target range 안에 있어야 시작한다. 범위를 벗어나면 pointer를
되돌리지 않고 `operator_recovery_required`를 반환한다.

이 상태는 retry 가능한 updater 오류와 구분된다. Operator는 migration ledger를 삭제하거나 down SQL을 만들지
않고 candidate 수정 재배포 또는 검증된 backup을 새 빈 DB/data root에 복원한 뒤 compatible binary를 선택해야
한다. Installer는 migration, DB query, process start/stop을 직접 수행하지 않는다.

## Retention, uninstall과 비목표

Confirmed current, last-known-good, rollback candidate와 진행 transaction이 참조하는 release를 보호하고 나머지
direct child release만 created-at 순서로 최대 3개까지 정리한다. 대상 basename/parent, tree type/reparse와 ACL을
다시 검증한 뒤 같은 `releases/`의 tombstone으로 rename하고 정확한 root만 제거한다. Unknown entry나 unsafe tree는
정리를 멈춘다.

`uninstall-code-boundary`는 packaging adapter가 제거할 code root 수와 필요한 process/shortcut action만
payload-free로 계획한다. 실제 삭제, service/registry/shortcut 변경은 하지 않는다. Tenant data, tenant별
`CODEX_HOME`, `kodex.env`, PostgreSQL data와 operator backup은 install root 밖의 자산이며 installer/uninstaller가
삭제하지 않는다.

Dependency-free fixture는 OS temp directory와 ephemeral Ed25519 key/release만 사용해 중복 stage/activate/confirm/
rollback, live lock 경합, interrupted journal recovery, trust-store rollback, tamper/unknown key/reparse, forward-only
downgrade 차단과 exact-root retention을 검증한다. Vitest는 strict state, ACL precondition, trust receipt와
payload-free CLI parser를 별도로 검증한다. 실제 installer binary, Authenticode, service/registry/shortcut,
admin/system-wide install, process health adapter와 DB migration orchestration은 비목표다.
