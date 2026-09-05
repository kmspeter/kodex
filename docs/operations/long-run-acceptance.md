# Long-run Product/Local/Electron/PostgreSQL acceptance runbook

## 목적과 실행 승인

이 절차는 Phase 36의 12~72시간 soak/chaos state machine을 승인된 격리 acceptance host에서 실행한다. 기본 scenario는
`full-system-soak`, 좁은 scenario는 `product-local-postgresql-soak`이다. 둘 다 최소 12시간이며 72시간을 넘길 수 없다.
이 문서의 명령은 실제 build, Electron, PostgreSQL/Docker와 filesystem fixture를 반복 실행하므로 현재 checkout의
짧은 코드 gate와 별개다. Capacity, Docker image/network, `bin/codex.exe`, Node/npm dependencies와 각 기존 harness의
전제를 먼저 승인하고 준비한다.

Harness는 Docker daemon/volume, 운영 DB/data/user file, approval policy나 provider control plane을 chaos 대상으로
조작하지 않는다. 각 allowlisted command가 만든 disposable resource만 그 command의 기존 `finally` 경계에서 정리한다.
긴 실행을 위해 실제 production tenant, 사용자 email, 실제 prompt/repository payload나 운영 credential을 재사용하지
않는다.

## Config와 state 위치

Tracked example을 운영자가 관리하는 repository 밖의 restricted directory로 복사하고 숫자 bound만 변경한다. Field나
action ID를 추가하지 않는다. State/receipt도 repository, tenant data root, backup, release artifact, 사용자 home root가
아닌 별도 restricted absolute path에 둔다.

```powershell
Copy-Item config/long-run-acceptance.example.json C:\acceptance-control\phase36-config.json
npm run acceptance:validate
```

Config의 `durationSeconds`는 43,200~259,200, lease heartbeat는 lease duration의 절반 미만, attempt는 최대 10,
step timeout/backoff/iteration은 schema와 executable parser 범위여야 한다. Threshold는 heap/handle/socket/DB pool/
outbox/lease/temp/disk 각각의 absolute maximum과 baseline 대비 maximum growth를 모두 둔다.

## 시작, 중단과 재개

새 run ID는 생략하면 안전한 UUID로 생성된다. 재현 가능한 운영 추적이 필요하면 UUID만 직접 지정할 수 있다.

```powershell
npm run acceptance:long-run -- start `
  --config C:\acceptance-control\phase36-config.json `
  --state C:\acceptance-control\phase36-state.json `
  --receipt C:\acceptance-control\phase36-receipt.json
```

`SIGINT`/`SIGTERM`은 graceful abort다. Runner는 현재 child에 terminate signal을 전달하고 bounded timeout 뒤 cleanup,
terminal checkpoint와 `aborted` receipt를 기록한다. Process kill, power loss나 host crash 뒤에는 lease expiry를 기다린 뒤
동일 config/state/receipt로만 재개한다.

```powershell
npm run acceptance:long-run -- resume `
  --config C:\acceptance-control\phase36-config.json `
  --state C:\acceptance-control\phase36-state.json `
  --receipt C:\acceptance-control\phase36-receipt.json
```

Plan digest가 바뀐 config/scenario로 resume하면 `checkpoint_plan_mismatch`, live lease와 겹치면 `duplicate_runner`,
corrupt/non-canonical state는 `checkpoint_corrupt`로 실패한다. Lease directory나 checkpoint를 수동 편집/삭제해 경쟁을
우회하지 않는다. 만료 lease만 runner가 atomic rename 후 exact cleanup한다.

## Workload와 chaos adapter

`config/long-run-acceptance-scenarios.json`의 command ID만 실행된다. CLI는 npm script 이름이나 shell string을 받지
않고 `shell=false` argv를 사용한다. Workload는 browserless Product/Local/WebSocket/history/reconciliation/RAG,
Electron lifecycle, PostgreSQL auth/invitation/password reset/email/data lifecycle, backup/recovery, release/installer와
security/recovery contract를 조합한다.

Chaos는 다음 reversible fixture action만 허용한다.

- `chaos.websocket-reconnect`
- `chaos.runtime-restart-recovery`
- `chaos.postgres-session-recovery`
- `chaos.update-restart-recovery`

새 chaos가 필요하면 source allowlist, scenario/schema/ADR/threat model과 fake fixture를 함께 변경하고 별도 review한다.
DB/data/user file deletion, Docker daemon/volume mutation, approval auto-approve, policy bypass action은 추가하지 않는다.

## 판정과 receipt

각 step 전 attempt와 `invoking` phase가 atomic checkpoint된다. Crash 뒤 같은 invocation digest로 at-least-once
재시도하므로 adapter는 중복을 dedupe해야 한다. Iteration/step/result 순서가 어긋나면 `unordered_result`, retry가
소진되면 `retry_exhausted`, 전체 기한 전에 iteration limit이 끝나면 `iteration_limit_reached`다. 한 번이라도 absolute
또는 growth bound를 넘으면 `resource_threshold_exceeded`다.

State와 receipt에는 run/plan/scenario ID, canonical 시간, monotonic counters, payload-free aggregate metrics와 stable
result code만 남는다. Tenant/user/workspace ID, email, prompt/tool payload, path, DB URL, token/secret, raw child output와
raw error를 복사하지 않는다. 실패 분석은 해당 격리 harness의 승인된 redacted diagnostics에서 별도로 수행하고
state/receipt를 확장하지 않는다.

성공은 `completed` receipt, 12~72시간 실제 elapsed time, 모든 threshold와 exact cleanup을 뜻한다. 이 receipt만으로
release readiness가 되지 않는다. 별도 승인 signer가 현재 release provenance를 넣은 Phase 36 acceptance evidence를
발행하고 external trust store로 검증해야 한다. Fake adapter fixture 결과는 production evidence로 서명하지 않는다.

## 빠른 코드 검증

긴 서비스를 띄우지 않는 dependency-free 검증만 수행하려면 다음을 사용한다.

```powershell
npm run test:long-run-acceptance
npm run acceptance:validate
```

Fixture는 lease competition/duplicate, crash-resume, corrupt/stale checkpoint, timeout/retry, leak, unordered result,
abort, deterministic receipt와 cleanup을 검사하며 `productionEvidenceCreated`를 만들지 않는다.
