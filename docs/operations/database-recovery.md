# Managed PostgreSQL database recovery 운영 runbook

이 문서는 Phase 35의 production WAL/PITR/replica/provider snapshot 정책과 배포 전 readiness gate를 운영하는
절차다. 결정은 [ADR 0034](../adr/0034-managed-postgresql-recovery-policy.md), 기본 정책은
`config/database-recovery-policy.json`, 구조 계약은 `config/database-recovery-policy.schema.json`과
`config/database-recovery-receipt.schema.json`이 기준이다.

## Shared responsibility

Kodex는 managed PostgreSQL/cloud를 생성·설정·삭제하지 않는다. `recovery:cli`와 `recovery:validate`는
`validate-only`이며 DB 접속, cloud API, WAL/base backup/snapshot 생성, replica promotion/fencing, restore 또는
physical deletion을 실행하지 않는다. Provider operator가 별도 change control에서 실제 통제를 구성하고 provider
drill을 수행한 뒤, 승인된 evidence signer/verifier 경계가 payload-free receipt를 발행해야 한다.

정책, command output과 ticket에는 tenant/user/workspace ID, DB URL, hostname/IP, filesystem/object path,
WAL LSN/timeline, snapshot/replica ID, SQL/content payload, signature bytes, provider/DB error text, credential/token/
secret을 넣지 않는다. Receipt에는 schema가 요구하는 canonical signature만 있으며 evidence payload나 private key는
없다. Key와 trust material 자체 대신 승인 registry의 `keyref:`, `trustref:`, `opsref:`만 쓴다.

## 정책 검토

Production 변경자는 schema의 exact field와 다음 관계를 함께 검토한다.

| 영역 | 필수 검토 |
| --- | --- |
| 복구 목표 | `rpoMinutes`, `rtoMinutes`, `pitrWindowHours` |
| WAL/PITR | continuous/enabled, archive maximum delay ≤ RPO, retention ≥ PITR, encryption, WORM |
| Base backup | enabled, cadence/retention, encryption, WORM, retention ≥ PITR |
| Transport/isolation | TLS `verify-full`, failure domain/region/account 각각 2 이상, separate credential |
| Replica | cross-region hot standby, lag ≤ RPO, slot monitor와 retained-WAL bound, promotion ≤ RTO, fencing/runbook refs |
| Provider snapshot | cadence/retention, encryption, WORM, deletion protection, retention ≥ PITR |
| Rotation/hold | key/trust ref와 rotation days, WAL/base backup/snapshot/replica legal-hold 전파 |
| Drill/deletion | cadence와 evidence max age, trust minimum version, 모든 physical copy의 maximum residual days |

`maximumResidualDays`는 application의 logical deletion 뒤 일반 정책에서 copy가 남을 수 있는 상한이다. WAL/base
backup/snapshot retention이 이 값을 넘으면 정책이 실패한다. Active legal hold만 명시된 예외이며 hold 해제 뒤
원래 expiration 계산과 삭제 evidence를 다시 확인한다. Hold를 먼저 provider copy에 전파하지 않은 상태에서
online lifecycle 삭제를 진행하지 않는다.

정책과 repository 연결은 배포 전 다음으로 검사한다.

```powershell
npm run recovery:validate
npm run recovery:cli -- validate
npm run recovery:cli -- drill-plan
```

첫 명령은 policy/schema/parser/package/docs drift를, 둘째는 default production policy 의미를 검사한다. 셋째는
정확히 12개의 고정 step code와 count만 출력하며 아무 restore도 수행하지 않는다. Development/acceptance policy는
구조 검증에 성공할 수 있지만 `promotionEligible=false`이며 production drill plan/status에 사용할 수 없다.

## External provider drill과 receipt

승인된 격리 환경에서 운영자는 plan의 step code 순서에 따라 provider control attestation, isolated restore target,
base backup/WAL replay, RPO/RTO 측정, replica promotion과 old-primary fencing, snapshot recovery, legal hold 전파,
logical deletion 뒤 expiry를 확인한다. Kodex 명령은 이 절차를 실행하지 않는다. Target 식별자와 raw provider
evidence는 restricted evidence system에만 둔다.

Receipt v1은 다음 exact key만 가진다.

- top level: `format`, `formatVersion`, `performedAt`, `resultCode`, `policyDigest`, `artifactSignature`, `objectives`,
  `protections`
- `artifactSignature`: `algorithm=Ed25519`, policy의 `trustRef`, integer `trustVersion`, `keyId`, canonical 64-byte
  Ed25519 `signature`
- `objectives`: `rpoMet`, `rtoMet`, 관측 recovery-point age와 recovery time의 분 단위 integer
- `protections`: WAL archive, base backup, replica, snapshot, legal-hold propagation, physical-deletion bound의
  result boolean

`verified=true` 자기신고 field는 허용하지 않는다. 서명 payload는 다음 semantic structure를 canonical JSON으로
직렬화한 bytes다. Signature field 자체는 제외되지만 그 밖의 receipt field는 모두 포함된다.

```text
{
  domain: kodex-database-recovery-drill-receipt-signature-v1,
  receipt: { format, formatVersion, performedAt, resultCode, policyDigest,
             artifactSignature: { algorithm, trustRef, trustVersion, keyId },
             objectives, protections }
}
```

Provider evidence signer는 exported `signDatabaseRecoveryReceipt` helper를 격리 signer 안에서 호출할 수 있다.
Helper는 Phase 30 `signEd25519Payload`를 재사용한다. Private key bytes는 그 호출의 bounded memory input일 뿐 config,
receipt, environment, argument, artifact나 log에 저장하지 않는다. Validator는 Phase 30
`verifyTrustedEd25519Payload`로 artifact 밖의 canonical release trust-store v1을 읽는다. Artifact/receipt가 제공한
public key나 trust store를 신뢰하지 않는다.

Receipt를 release artifact나 repository에 상시 commit하지 않는다. 승인된 receipt의 absolute path와 명시적
canonical UTC 평가 시각을 배포 job에 전달한다.

```powershell
npm run recovery:cli -- receipt-validate --receipt <absolute-receipt-path> --trust-store <absolute-trust-store-path> --at 2026-09-05T00:00:00.000Z
npm run recovery:cli -- status --receipt <absolute-receipt-path> --trust-store <absolute-trust-store-path> --at 2026-09-05T00:00:00.000Z
```

다른 policy를 검증할 때만 `--policy <absolute-policy-path>`를 추가한다. `--at`을 현재 승인된 deployment evaluation
timestamp로 갱신하되 receipt timestamp를 다시 쓰지 않는다. Receipt와 trust store path는 모두 absolute여야 한다.
Store에서 `keyId`가 `trusted`이고 signature가 유효하며 실제 loaded `storeVersion`이 receipt `trustVersion`과 정확히
같고 policy `trustVersionMinimum` 이상이며 receipt/policy `trustRef`가 일치해야 freshness/objectives를 평가한다.
Unknown/revoked key, wrong key/signature, malformed/non-canonical store와 version/ref mismatch는 readiness 전에
fail-closed한다. 성공 status는 `recovery_ready`, policy digest,
`ready`, production promotion flag와 coarse evidence age bucket만 반환한다.

## Fail-closed 처리

| Stable code | 조치 |
| --- | --- |
| `policy_input_invalid` / `policy_contract_invalid` / `policy_reference_invalid` | 파일 type/size와 versioned exact contract를 고친다. 원문 값을 log에 복사하지 않는다. |
| `policy_weak` / `policy_inconsistent` | provider 통제 또는 목표 조합을 강화한다. production profile을 낮춰 우회하지 않는다. |
| `policy_profile_not_promotable` | development/acceptance evidence를 폐기하고 production 정책으로 새 drill을 수행한다. |
| `receipt_input_invalid` / `receipt_contract_invalid` | signer/verifier pipeline이 payload-free v1 receipt를 다시 발행하게 한다. |
| `receipt_stale` / `receipt_from_future` | 승인 시간 기준의 새 provider drill evidence를 만든다. timestamp를 임의 수정하지 않는다. |
| `receipt_failed` / `receipt_objectives_missed` / `receipt_protection_failed` | 배포를 중단하고 해당 provider control/RPO/RTO를 복구한 뒤 새 drill을 수행한다. |
| `receipt_policy_mismatch` | 변경된 exact policy digest로 새 drill을 수행한다. |
| `receipt_trust_store_invalid` | 누락·상대 경로·비정규·non-canonical external store를 고치고 authenticated 배포를 확인한다. |
| `receipt_key_untrusted` / `receipt_key_revoked` | 승인된 active key로 evidence를 다시 발행하고 store custody를 조사한다. |
| `receipt_signature_invalid` | Wrong key 또는 semantic tamper로 처리하고 receipt를 수정하지 말고 격리 signer에서 다시 발행한다. |
| `receipt_trust_version_mismatch` / `receipt_trust_reference_mismatch` | 실제 loaded store version과 policy trust registry를 맞춘 새 receipt를 발행한다. |

실패 JSON에는 stable code 외 원인이 없다. 상세 조사는 restricted provider evidence에서 수행하며 일반 CI log에
경로, 식별자, payload/error text를 추가하지 않는다. `security:validate` 실패를 release flag나 non-production
profile로 우회하지 않는다.

## 배치와 사고 대응

Deployment gate는 Phase 34 encrypted/signed offline backup 검증과 Phase 35 recovery readiness를 서로 대체하지
않고 둘 다 통과시킨다. Policy/receipt 검증 뒤에도 release authenticity, migration role/ledger와 application
readiness를 기존 runbook대로 검사한다. Evidence가 배치 도중 max age를 넘거나 policy가 바뀌면 status를 다시
평가하고 실패 시 promotion을 중지한다.

실제 장애에서는 이 CLI가 promotion/restore/fencing을 실행한다고 가정하지 않는다. 승인된 `opsref:` 절차로
incident commander가 provider action을 수행하며 split-brain 방지를 위해 old primary fencing 확인 전 write
endpoint를 공개하지 않는다. 복구 뒤 새 provider drill/receipt로 readiness를 다시 닫고, legal hold와 lifecycle
ticket을 복원 시점의 physical copy 전체에 재조정한다.
