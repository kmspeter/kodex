# ADR 0035: Durable long-run acceptance와 fail-closed final release evidence

- 상태: 승인
- 날짜: 2026-09-05
- 구현 Phase: Phase 36

## 배경과 범위

Phase 1~35의 개별 unit, browserless, Electron, PostgreSQL, backup/recovery, signing/installer 검증은 각 경계를
짧고 재현 가능하게 확인하지만 12~72시간 동안 반복되는 reconnect/restart, resource growth와 crash 이후 재개를
증명하지 않는다. 또한 과거 또는 다른 commit에서 통과한 결과를 현재 release의 증거로 오인하지 않도록 전체
불변식과 증거를 하나의 versioned release decision으로 묶을 필요가 있다.

Phase 36은 제품 schema나 runtime API를 바꾸지 않는다. Migration `0001`~`0013`, vendor/generated source,
upstream pin/manifest도 그대로 둔다. 실제 Product/Local/Electron/PostgreSQL, cloud/provider drill, release build와
installer 생성, 12~72시간 실행은 승인된 운영 acceptance 환경의 후속 작업이며 이 변경에서 실행하거나 통과로
표시하지 않는다.

## Long-run state machine 결정

`config/long-run-acceptance-scenarios.json`은 production scenario와 고정 action ID → npm script 매핑의 원본이다.
`config/long-run-acceptance.example.json`은 12시간 기본, 72시간 최대의 시작 config다. Scenario/config/state/receipt는
각각 version 1이며 JSON Schema와 executable exact-key parser를 함께 둔다. Production scenario의 최소 실행 시간은
43,200초, 최대는 259,200초다.

Plan digest는 scenario catalog digest, exact config, ordered step와 allowlisted command metadata를 canonical JSON으로
묶은 SHA-256이다. Run ID와 lease owner는 UUID다. State는 run/plan/scenario, canonical timestamps/deadline, 현재
iteration/step/attempt/phase, monotonic completed count, aggregate counters와 resource sample만 보존한다. Tenant/user/
workspace ID, email, prompt/tool payload, credential, token, DB URL, filesystem path와 raw error는 state/receipt/CLI
출력에 없다.

Checkpoint는 target과 같은 directory의 owner-only 임시 regular file을 flush한 뒤 rename하고 가능한 filesystem에서
directory도 flush한다. 매 invocation 전에 `invoking` phase와 attempt를 먼저 checkpoint하므로 crash 뒤 같은
idempotency key로 at-least-once 재시도한다. Adapter가 이미 완료한 호출을 dedupe하면 `duplicate=true` aggregate만
반영한다. Result의 invocation/iteration/step이 현재 position과 다르면 `unordered_result`로 종료한다.

State file 옆 exclusive lease directory는 canonical owner/run/acquired/heartbeat/expiry record를 가진다. 살아 있는
lease에는 `duplicate_runner`, 만료된 lease만 atomic rename 후 제한된 exact-root cleanup으로 회수한다. Heartbeat,
step timeout, retry 수, exponential backoff, 전체 deadline과 iteration limit은 모두 config hard bound 안에 있다.
SIGINT/SIGTERM은 현재 adapter signal을 취소하고 `aborted` receipt를 만든 뒤 cleanup을 수행한다. Cleanup 요청도
run/plan만 가진 고정 contract이며 adapter는 같은 요청을 idempotent하게 처리해야 한다.

## Adapter와 chaos 안전 경계

Runner는 임의 shell string, argv fragment, path, payload를 받지 않는다. Repository catalog의 action ID만 사용하며
built-in process adapter는 source에 고정된 `npm run <known-script>` argv를 `shell=false`로 시작한다. Workload는 기존
Product/Local/browserless, Electron, PostgreSQL history/RAG/auth/email/lifecycle, backup/recovery, release/security
acceptance를 조합한다.

Chaos ID는 `chaos.websocket-reconnect`, `chaos.runtime-restart-recovery`, `chaos.postgres-session-recovery`,
`chaos.update-restart-recovery` 네 개뿐이다. 각각 자체 격리와 cleanup을 검증하는 기존 acceptance command를 다시
실행하는 reversible adapter action이다. `delete`, `destroy`, `drop`, Docker daemon/volume, approval auto-approve,
policy bypass를 나타내는 action이나 catalog 밖 command는 parser가 거부한다. 운영 DB/data/user 파일 삭제나
Docker daemon/volume 조작은 이 state machine의 기능이 아니다.

각 결과는 heap, handle, socket, DB pool, outbox, lease, temporary bytes와 disk bytes의 payload-free 정수 sample,
reconnect/restart recovery count만 반환한다. Runner는 baseline/last/peak와 absolute/growth threshold를 모두 검사한다.
Built-in command adapter의 child acceptance는 종료 시 자체 fixture resource를 exact cleanup하는 계약이고, 실제 장기
service adapter를 추가할 때는 대상별 observer가 모든 sample을 제공해야 한다. Missing metric이나 extra field는
adapter result 자체가 invalid다.

## Final catalog와 cryptographic evidence 결정

`config/release-acceptance-catalog.json`은 Phase 1~36을 `REL-001`~`REL-018`에 매핑한다. 각 requirement는 category,
ordered phase/environment, allowlisted command ID, evidence type과 freshness만 가진다. Fresh/upgrade migration,
Product/Local/browser boundary, Electron, PostgreSQL, filesystem, History/reconciliation, RAG, email/auth/recovery,
Workspace recovery, observability/security, backup/restore, production build, release signing, installer/updater,
managed provider drill과 long-run soak가 모두 mandatory다.

Evidence receipt version 1은 requirement/command/evidence type/result, canonical start/end timestamp, current release
version/commit, exact catalog/policy/migration-ledger/vendor digests, Codex upstream commit, aggregate test counts와
선택한 artifact evidence만 허용한다. Artifact evidence는 digest, signature digest/key ID와 trust-store version이며
long-run receipt는 자체 digest만 갖고 바깥 evidence signature로 봉인한다. `verified` boolean, resource identity,
경로, payload, URL, raw output/error, secret/credential과 extra key는 허용하지 않는다.

Receipt signature는 `kodex-release-acceptance-evidence-signature-v1` domain과 signature를 제외한 모든 semantic field의
canonical JSON을 Phase 30 `signEd25519Payload`로 서명한다. Readiness는 repository/artifact 밖의 절대 경로 external
trust store와 `verifyTrustedEd25519Payload`로 실제 Ed25519 signature를 확인한다. Unknown/revoked key, invalid 또는
unsigned signature, loaded/receipt trust version 불일치와 catalog trust reference 불일치는 모두 실패한다. Private
key나 production trust store는 repository/runtime/UI에 없다.

Readiness는 clean Git HEAD, package version, current `0001`~`0013` migration checksum ledger, recovery policy digest,
Codex upstream pin과 vendor manifest SHA-256를 다시 계산해 모든 receipt와 exact-match한다. Production build/signing은
Phase 30 signed release artifact verifier, installer는 Phase 31 confirmed active state와 같은 signed artifact,
provider drill은 Phase 35 signed recovery receipt validator, soak는 12~72시간 completed Phase 36 receipt가 별도 source
input으로 실제 검증되어야 한다. Signed wrapper만 있고 source artifact/receipt가 없으면
`evidence_source_unverified`다.

Missing/stale/future/failed/mismatched/unsigned/unknown/revoked/invalid evidence, dirty tree, unverified build/installer/
Electron/PostgreSQL/provider drill/soak 중 하나라도 있으면 release는 blocked다. Evidence가 아예 없을 때의 정상 결과는
`release_evidence_pending`이며 pending category와 count만 반환한다. Fake fixture는 ephemeral key/temp data로 parser와
crypto/fail-closed logic을 검증할 뿐 production evidence file을 만들지 않는다.

## 검증과 결과

`npm run acceptance:validate`는 두 catalog, 여섯 schema digest, npm script, migration count와 README/ADR/runbook/
matrix/threat/deployment/security/observability 문서 drift를 검사한다. `npm run security:validate`도 이 gate를 포함한다.
`npm run test:long-run-acceptance`는 lease 경쟁/duplicate runner, crash/restart resume, corrupt/stale checkpoint,
timeout/retry, leak threshold, unordered result, abort, deterministic receipt와 exact cleanup을 빠른 fake adapter로
검증한다. `npm run test:release-acceptance`는 deterministic signing, ready/pending/dirty/stale/failed/mismatch/unsigned/
tamper/unknown/revoked/source-missing을 ephemeral Ed25519 trust로 검증하고 `productionEvidenceCreated=false`를 출력한다.

운영 순서와 failure triage는 [long-run runbook](../operations/long-run-acceptance.md),
[final release checklist](../operations/final-release-checklist.md),
[acceptance matrix](../operations/release-acceptance-matrix.md)가 원본이다.
