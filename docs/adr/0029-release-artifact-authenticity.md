# ADR 0029: Offline Ed25519 release artifact authenticity

- 상태: 승인
- 날짜: 2026-09-05

## 배경과 결정

Phase 25의 `release-manifest.json`은 artifact 전체의 path/size/SHA-256을 봉인하지만, 공격자가 manifest와
artifact를 함께 바꾸면 출처를 증명하지 못한다. Phase 30은 Node 표준 `crypto`의 Ed25519로 manifest의
**exact canonical UTF-8 bytes**를 서명한다. 새 runtime dependency는 추가하지 않는다.

Release 생성은 계속 clean source와 Phase 29 provenance/secret gate를 통과한 뒤 tree와 canonical manifest를
봉인한다. 이 결과는 의도적으로 unsigned이며 trusted 결과가 아니다. 별도 `sign` 단계가 tree integrity와
release-input secret scan을 다시 통과한 candidate에 root-level `release-signature.json`을 exclusive create한다.
Manifest는 고정 field 순서, 2-space JSON indentation과 하나의 trailing LF로 직렬화하며 parser가 같은 bytes로
재구성되지 않는 duplicate key, field reorder, whitespace/encoding 변형을 거부한다. Signature envelope v1은
exact `format`, `formatVersion`, `algorithm`, `keyId`, `manifestSha256`, `signature`만 가지며 canonical padded
base64의 64-byte Ed25519 signature만 허용한다.

Signer는 명시적인 repository/artifact 밖 key file 또는 bounded non-interactive stdin으로 받은 PKCS#8 PEM
Ed25519 private key만 사용한다. Private key 환경 변수, CLI 값, repository 설정, artifact metadata와 UI bundle
경로는 지원하지 않는다. 오류와 성공 JSON에는 key material/signature를 넣지 않고 stdin/file buffer는 사용 뒤
best-effort로 지운다. 실제 production private key 생성·보관은 승인된 offline signer/HSM 운영 경계이며 이
저장소는 production private key를 생성하거나 보관하지 않는다.

Verifier는 artifact가 제공하는 key를 신뢰하지 않는다. 별도 관리·배포된 canonical trust store v1의 DER SPKI
Ed25519 public key를 `keyId`로 선택하고 `trusted`만 허용한다. `unknown`과 `revoked` key는 fail-closed다. Store는
별도 `storeVersion`을 가지며 key ID가 정렬된 최대 256개 entry만 허용한다. 저장소의
`config/release-trust-store.json`은 의도적으로 key가 없는 bootstrap 상태이므로 production trust store가
명시되기 전에는 어떤 signature도 신뢰되지 않는다. JSON Schema는
`config/release-trust-store.schema.json`, executable parser는 `release:trust-store:validate`가 제공한다.

공개 `verify`는 외부 trust store, canonical manifest/envelope, manifest digest, Ed25519 signature와 기존 전체
artifact tree/identity를 모두 검증한다. Signature가 없거나 trust store가 없으면 성공하지 않는다. Low-level
integrity 검사는 seal/sign 내부 구현에서만 별도 이름으로 사용하며 배치 승인 명령이 아니다.

## Rotation, revocation과 배치

Rotation은 새 public key를 더 높은 `storeVersion`의 trust store에 먼저 `trusted`로 추가·배포한 뒤 새 `keyId`로
candidate를 서명한다. 필요한 호환 기간에는 이전 key를 유지하고, 폐기나 침해 시 entry를 삭제하지 않고
`revoked`로 바꿔 store version을 올린다. Revocation은 해당 key로 서명한 과거 artifact까지 거부한다. Parser는
형식과 현재 파일만 검증하므로 trust-store rollback 방지는 배포 시스템이 이전 승인 `storeVersion`과 digest를
보존하고 더 낮은 version을 거부해야 한다.

운영 순서는 seal → offline sign → external trust store로 independent verify → immutable publish → 설치/최초 실행/
upgrade 전 verify다. Artifact 내부의 `Kodex-Release-Verify.cmd`도 `--trust-store <external-file>`을 필수로 전달받는다.
서명 파일을 덮어쓰거나 같은 directory를 in-place로 재서명하지 않는다. Rotation이 필요하면 새 candidate
directory와 release record를 만든다.

## 검증과 비목표

Dependency-free Node fixture와 Vitest는 ephemeral Ed25519 key와 temp directory만 사용해 unsigned, unknown/revoked
key, non-canonical JSON/base64, manifest/artifact tamper와 unlisted file을 거부하고 file/stdin signer 경계 및
packaged verifier 인자를 확인한다. 실제 production key, HSM/KMS, Authenticode, transparency log, timestamping,
installer/updater와 trust-store 배포 control plane은 이 결정의 범위가 아니다.
