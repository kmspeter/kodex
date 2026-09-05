# ADR 0034: Managed PostgreSQL 복구 정책과 fail-closed readiness evidence

- 상태: 승인
- 날짜: 2026-09-05
- 구현 Phase: Phase 35

## 배경과 책임 경계

Phase 34의 encrypted/signed offline backup은 Kodex application과 tenant data의 수동 전체 복구 artifact를
제공하지만 managed PostgreSQL/cloud의 WAL archive, PITR, replica, provider snapshot이나 삭제 일정을 제어하지
않는다. 반대로 provider 설정만 존재한다는 사실은 목표 RPO/RTO, legal hold 전파와 실제 restore 가능성을
증명하지 않는다.

Phase 35는 Kodex가 provider control plane을 호출하지 않는 shared-responsibility를 유지한다. Kodex의 역할은
`validate-only` policy-and-readiness gate이고 database operator는 `external-managed-provider`다. 운영자는
provider에서 통제를 구성하고 독립 provider drill을 수행한다. Kodex는 그 결과의 비식별 receipt만 배포 전에
검증한다. PostgreSQL, Docker, cloud API, WAL/base backup/snapshot/replica/promotion/restore를 이 코드가 실행하지
않으며 migration `0001`~`0013`, vendor, generated protocol과 upstream pin/manifest도 바꾸지 않는다.

## 버전드 정책 결정

`config/database-recovery-policy.json`과 구조 schema는 format
`kodex-database-recovery-policy`, version 1이다. 실행 parser가 exact key, 타입·수치 bound, reference 문법과
cross-field 의미를 권위 있게 검증한다. Production은 다음을 모두 요구한다.

- RPO/RTO/PITR window, continuous WAL archive의 maximum delay와 retention, base backup cadence/retention
- storage encryption, PostgreSQL TLS `verify-full`, WAL/base backup/snapshot WORM
- 둘 이상의 failure domain, region과 provider account 및 별도 credential
- cross-region hot standby의 bounded lag, slot monitoring/retained-WAL bound, promotion target/runbook과 fencing
- provider snapshot cadence/retention/encryption/WORM/deletion protection
- secret material이 아닌 `keyref:`, `trustref:`, `opsref:` 식별자와 rotation cadence
- WAL/base backup/snapshot/replica 전체에 대한 legal-hold propagation
- restore drill cadence, evidence freshness, signed-artifact trust minimum version
- logical deletion 뒤 WAL/base backup/snapshot/replica가 남을 수 있는 최대 일수와 legal-hold-only 예외

Production에서 disabled protection, `verify-full` 미만, single domain/region/account, non-cross-region topology,
retention보다 긴 PITR, RPO보다 느린 WAL archive, RPO보다 큰 replica lag, RTO보다 긴 promotion, retention보다 긴
cadence, 잔존 상한을 넘는 복사본, 너무 느슨한 evidence freshness는 실패한다. Development/acceptance profile은
격리 fixture 예외를 표현할 수 있지만 `promotionEligible=false`이고 status/drill-plan 경계에서 production 승격을
거부한다. URL, filesystem path, credential/token/secret처럼 보이는 inline 값과 extra key는 profile에 관계없이
거부한다.

## Drill plan, receipt와 출력

`recovery:cli drill-plan`은 12개의 고정 step code만 반환하는 bounded plan이다. 실제 restore나 provider mutation을
하지 않는다. External drill receipt v1은 canonical UTC timestamp, stable result code, exact policy SHA-256,
Ed25519 artifact trust reference/version/key ID/canonical 64-byte signature, 관측 RPO/RTO와 충족 여부, WAL/base backup/
replica/snapshot/legal hold/physical-deletion 검증 boolean만 허용한다. Forgeable `verified` boolean은 제거한다.
Tenant/user/workspace ID, DB URL, host/path, WAL LSN/timeline, snapshot ID, artifact payload, provider error text,
credential/token/secret와 extra key는 허용하지 않는다.

서명 payload는 domain `kodex-database-recovery-drill-receipt-signature-v1`과 signature field 자체를 제외한 receipt의
모든 semantic field를 canonical JSON object로 묶는다. Exported signing helper는 Phase 30의 `signEd25519Payload`를,
validator는 `verifyTrustedEd25519Payload`를 재사용한다. Private key bytes는 provider의 격리 signer 입력에만 있고
policy/receipt/config/log에는 없다. `receipt-validate`와 `status`는 explicit absolute external trust-store를 요구한다.
그 store의 `trusted` key로 signature가 유효하고 실제 loaded store version이 receipt `trustVersion`과 정확히 같으며
policy minimum 이상이고 `trustRef`가 policy와 일치한 뒤에만 freshness/objectives/protection을 평가한다.

Receipt가 stale/future/failed이거나 policy digest·trust reference/store/minimum version이 다르고, signature verification,
RPO/RTO 또는 보호 항목 하나라도 실패하면 readiness를 차단한다. 평가 시각은 `--at`의 canonical UTC 값으로
명시해 같은 입력의 결과가 항상 같다. 성공 JSON은 policy digest, format version, stable code,
profile/readiness, coarse age bucket, plan step count만 포함한다. 실패 JSON도 `kind`, stable `code`, `ok=false`만
포함하는 payload-free 계약이다.

## Gate와 결과

`npm run recovery:validate`는 default production policy, policy/receipt schema canonical digest, package script와 README/ADR/runbook/
threat/lifecycle/backup/deployment 문서 연결을 함께 확인한다. `security:validate`도 같은 검증을 호출하므로 정책이나
문서가 따로 drift하면 release gate가 닫힌다. Dependency-free fixture는 temp 파일만 사용해 weak 조합,
exact key/reference, legal hold, evidence freshness/result/digest/trust/objective/protection, semantic tamper, unknown/
revoked/wrong key, missing external store, trust version/ref, 결정성, byte bound와 symlink/special file을 검증한다.

이 결정은 provider의 진실성을 원격으로 조회하거나 receipt를 자동 발행하지 않는다. Signing helper는 provider
drill evidence pipeline이 호출하는 primitive일 뿐 private-key custody나 signer service가 아니다. HSM/key custody,
provider API attestation, 실제 production-scale restore timing과 disaster declaration은 운영자 통제다. Readiness
receipt는 그 외부 절차의 제한된 증거이며 backup 자체도 아니다.
