# Kodex offline artifact signing runbook

이 절차는 Phase 29 provenance/secret gate와 Phase 25 sealed release 위에 Phase 30 authenticity를 추가한다.
Production private key는 repository, artifact, release record, 일반 환경 변수/로그나 온라인 build host에 두지
않는다. 승인된 offline signer 또는 HSM에서 이미 provision된 Ed25519 key만 사용한다.

## Trust store 준비

Trust store는 artifact와 다른 신뢰 경로로 verifier host에 배포한다. 저장소의
`config/release-trust-store.json`은 key가 없는 fail-closed bootstrap 예시이며 production trust anchor가 아니다.
형식 원본은 `config/release-trust-store.schema.json`이다. Executable parser는 UTF-8, exact key set, 최대 256개
정렬 entry, canonical padded base64와 Ed25519 SPKI DER를 추가 검증한다.

```json
{
  "format": "kodex-release-trust-store",
  "formatVersion": 1,
  "storeVersion": 2,
  "keys": [
    {
      "keyId": "release-2026-q3",
      "algorithm": "Ed25519",
      "status": "trusted",
      "publicKey": "<canonical-base64-DER-SPKI-public-key>"
    }
  ]
}
```

Entry는 `keyId` 오름차순이고 위 field 순서/2-space indentation/trailing LF를 유지한다. 실제 public key를 넣은
뒤 review host에서 다음을 실행하고 승인된 `storeVersion`, file SHA-256과 배포 대상을 release record에 남긴다.

```powershell
npm run release:trust-store:validate
node scripts/kodex-release.mjs trust-store-validate --trust-store D:\kodex-trust\release-trust-store.json
```

두 번째 명령은 external production store 검증 예시다. Artifact 안이나 candidate와 함께 쓸 수 있는 위치에 trust
store를 복사하지 않는다. Parser 자체는 이전 상태를 기억하지 않으므로 배포기는 승인 기록보다 낮은
`storeVersion`이나 다른 digest의 동일 version을 거부해야 한다.

## Seal과 offline sign

1. 승인된 clean commit에서 `security:validate`, source provenance와 release build를 수행한다. `release:build`의
   결과 kind는 `kodex_release_sealed_unsigned`이며 아직 배포할 수 없다.
2. Candidate를 write-restricted transport로 offline signer에 전달하고 다시 전체 release-input scan/integrity를
   통과시킨다.
3. Private key는 repository와 artifact 밖의 ACL-protected secret file 또는 비대화형 stdin 중 하나로만 전달한다.

```powershell
npm run release:sign -- --path D:\releases\Kodex-0.2.0-windows-x64-<commit12> --key-id release-2026-q3 --key-file E:\offline-secrets\release-2026-q3.pem
```

File path조차 signer invocation에 남기지 않아야 하는 운영 환경은 승인된 secret reader의 stdout을 직접 pipe하고
중간 파일/환경 변수를 만들지 않는다.

```powershell
Get-Content -Raw -LiteralPath E:\offline-secrets\release-2026-q3.pem | npm run release:sign -- --path D:\releases\Kodex-0.2.0-windows-x64-<commit12> --key-id release-2026-q3 --key-stdin
```

Interactive terminal stdin은 거부된다. Key 내용을 인자나 `KODEX_*` 환경 변수에 넣지 않으며 shell trace, transcript,
CI command echo와 일반 환경 dump를 끈다. Signer는 repository/release 안 key file, symlink, 64 KiB 초과 key,
non-Ed25519 key와 기존 signature 덮어쓰기를 거부한다. 성공 record에는 algorithm, key ID, manifest digest와
signature format version만 남긴다.

## Independent verification과 배치

온라인 publish/storage로 옮긴 뒤 signer와 다른 host에서 external trust store로 검증한다.

```powershell
npm run release:verify -- --path D:\releases\Kodex-0.2.0-windows-x64-<commit12> --trust-store D:\kodex-trust\release-trust-store.json
D:\releases\Kodex-0.2.0-windows-x64-<commit12>\Kodex-Release-Verify.cmd --trust-store D:\kodex-trust\release-trust-store.json
```

출력의 version/commit/keyId/manifestSha256/trustStoreVersion을 승인 record와 exact 비교한다. 설치, 최초 실행,
rollback candidate 활성화와 모든 upgrade/update 단계 전에 같은 verifier를 호출한다. Unsigned, unknown/revoked key,
malformed envelope/store, non-canonical manifest, digest/signature mismatch, artifact checksum mismatch와 unlisted file은
배포하지 않는다.

## Rotation과 incident revocation

- Rotation: 새 offline key의 public SPKI와 새 key ID를 더 높은 store version에 추가하고 verifier fleet에 먼저
  배포한다. 양쪽 key가 `trusted`인 overlap 동안 새 key로만 새 release를 서명한다.
- 정상 폐기: 지원해야 할 과거 artifact 기간을 결정한 뒤 이전 key를 `revoked`로 바꾸고 store version을 올린다.
- 침해: 즉시 `revoked` store를 out-of-band 배포하고 해당 key의 모든 과거 artifact를 격리한다. Entry를 삭제해
  사건 상태를 숨기지 않는다. 새 key로 기존 directory를 덮어쓰지 않고 새 candidate/release record를 만든다.
- Private key 손실/의심 시 key 값, PEM, 환경 dump 또는 HSM 진단 payload를 incident ticket에 복사하지 않는다.

이 runbook은 HSM/KMS 제품 선정, key ceremony quorum, OS code signing, timestamp authority와 transparency log를
제공하지 않는다. 조직의 offline key custody와 trust-store 배포/rollback 방지 통제가 별도로 필요하다.
