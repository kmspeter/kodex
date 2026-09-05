# Final release checklist and readiness runbook

## Release decision 원칙

Phase 36 release readiness는 [acceptance catalog](../../config/release-acceptance-catalog.json)의 `REL-001`~`REL-018`
모두에 대해 현재 release와 exact-match하는 fresh, passed, Ed25519-signed evidence와 필요한 source artifact/receipt가
있을 때만 `release_ready`다. 과거 handoff의 통과 기록, CI green 표시, `verified=true`, fake fixture와 unsigned JSON은
evidence가 아니다. 현재 실제 acceptance를 실행하지 않은 checkout에서 `release_evidence_pending`은 올바른 결과다.

## 1. Repository code gate

Clean checkout에서 다음을 먼저 수행한다.

```powershell
git status --short --branch
git rev-parse HEAD
npm run acceptance:validate
npm run security:validate
npm run recovery:validate
npm run test:long-run-acceptance
npm run test:release-acceptance
```

그 다음 정책에 맞는 targeted Vitest, typecheck, lint와 `git diff --check`를 수행한다. 이 단계는 catalog/schema/docs와
검증 코드만 확인하며 production build, installer, Electron/PostgreSQL/provider/soak evidence를 만들지 않는다.

## 2. 승인된 acceptance 실행

[acceptance matrix](release-acceptance-matrix.md)의 command ID를 승인된 host/job에 고정 매핑하고 다음 범주를 모두
수행한다.

- immutable `0001`~`0013` fresh 및 대표 이전 ledger → latest upgrade
- Product/Local browserless HTTP/WebSocket, approval/abort/resume, History reconciliation와 RAG
- 실제 Electron renderer, PostgreSQL/pgvector, tenant filesystem lifecycle와 Workspace recovery
- email verification/invitation/password-reset delivery 경계
- offline encrypted/signed backup→restore와 recovery policy/provider drill
- clean production release build, external Ed25519 signing, installer/update/rollback 확인
- [long-run acceptance](long-run-acceptance.md)의 실제 12~72시간 completed long-run soak

각 command는 assertion/test count와 canonical start/end time만 수집한다. 사용자/tenant/workspace/email, prompt/tool
payload, DB URL, filesystem path, token/secret와 raw error/output는 receipt issuer로 보내지 않는다.

## 3. Evidence 발행

Evidence issuer는 repository/runtime/UI 밖의 격리 signer에서 `kodex-release-acceptance-evidence` version 1 exact contract를
만든다. 현재 Git HEAD/package version, catalog digest, Phase 35 policy digest, `0001`~`0013` ledger digest, upstream
commit/vendor manifest SHA-256와 requirement/command/evidence type을 넣고 aggregate count를 기록한다. Artifact 범주는
검증한 manifest/receipt digest, signature digest/key ID와 trust-store version을 포함한다.

Signature는 repository library의 domain-separated canonical payload와 Phase 30 Ed25519 primitive를 사용한다. Private
key를 argv, environment, repository, evidence directory, release/installer/backup, runtime/UI나 log에 넣지 않는다.
Receipt 파일명은 정확히 `<requirement-id>.json`이고 canonical JSON이어야 하며 directory는 repository 밖의 restricted
absolute path다. External trust store도 repository/artifact 밖에 두고 authenticated distribution과 anti-rollback을
운영 control plane에서 보장한다.

## 4. Source evidence와 readiness

Readiness는 signed wrapper 외에 다음 원본을 다시 검증한다.

- `--release-artifact`: Phase 30 full-tree/manifest/Ed25519 verifier와 current release/migration/vendor exact match
- `--install-root`: Phase 31 active=confirmed release, no pending transaction/operator recovery/staging, same trust version
- `--recovery-receipt`: Phase 35 production policy, external trust, freshness/RPO/RTO/protection exact validation
- `--soak-receipt`: Phase 36 `completed`, allowlisted scenario, 실제 elapsed 12~72시간, 모든 sample의 여덟 자원
  `operational-probe` coverage와 required reconnect/restart action의 명시적 observed/count

```powershell
npm run release:readiness -- `
  --evidence-dir C:\acceptance-evidence\current `
  --trust-store C:\release-trust\release-trust-store.json `
  --release-artifact C:\release-candidates\Kodex-<version>-windows-x64-<commit> `
  --install-root C:\acceptance-install\Kodex `
  --recovery-receipt C:\provider-evidence\recovery-receipt.json `
  --soak-receipt C:\acceptance-control\phase36-receipt.json `
  --at 2026-09-05T00:00:00.000Z
```

`--at`은 audit 재현용 canonical UTC evaluation time이며 생략 시 현재 시각이다. Output은 deterministic one-line JSON의
stable code, catalog digest, evidence/pending count와 category만 가진다. Path, key ID, signature bytes나 raw failure는
출력하지 않는다.

## Fail-closed checklist

다음 중 하나라도 있으면 publish/rollout/installer activation을 중단한다.

- dirty tree 또는 현재 HEAD/version/catalog/policy/migration/vendor provenance 불일치
- missing, stale, future, failed, aborted, mismatched, duplicate, malformed, non-canonical 또는 unknown evidence
- unsigned/tampered receipt, unknown/revoked key, trust reference/version mismatch, repository 내부 trust store
- source 검증이 없는 build/signing/installer/provider drill/soak wrapper
- unconfirmed installer, pending transaction/staging/operator recovery, current release와 다른 signed artifact
- 12시간 미만/72시간 초과, 실패/중단된 soak 또는 leak/retry/deadline/cleanup failure
- process/fixture sample, 미관측 자원, observed zero로 위장한 null, exit code에서 만든 recovery count 또는
  reconnect/restart required/observed/count 불일치

Stable code를 보존하고 해당 requirement를 새로 실행한다. Receipt를 수정하거나 trust/age/source check를 우회하지
않는다. 모든 항목이 성공해도 별도의 승인·publish 권한과 rollback/change-management 절차는 그대로 필요하다.
