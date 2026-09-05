# ADR 0033: Streaming encrypted and signed offline backup envelope

- 상태: 승인
- 날짜: 2026-09-05

## 배경과 결정

Phase 24의 directory backup은 PostgreSQL custom dump와 tenant data를 하나의 manifest로 검증했지만 저장 시
application-level confidentiality와 authenticity를 제공하지 않았다. Phase 34는 그 검증된 plaintext v1
directory를 내부 payload로 유지하고, 운영 CLI가 새 단일-file envelope v2만 생성·검증·복원하도록 바꾼다.
Migration은 추가하지 않으며 `0001`~`0013` checksum ledger를 그대로 사용한다.

Envelope는 고정 magic, bounded canonical JSON header, gzip-compressed ciphertext, 16-byte GCM tag, bounded
canonical Ed25519 signature envelope 순서다. Header는 다음 비밀이 아닌 검증 정보만 가진다.

- format/version과 생성 시각
- `scrypt` domain, fresh 32-byte salt, 고정 `N=32768, r=8, p=1`, 32-byte key length
- `AES-256-GCM`, fresh 12-byte nonce와 16-byte tag length
- archive format/compression, uncompressed archive length, ciphertext length와 file count
- exact application version/40-hex commit, ordered migration ledger, Codex upstream commit와 vendor manifest SHA-256

Tenant ID, 상대 path, DB dump, tenant payload와 내부 manifest는 모두 ciphertext 안에만 있다. GCM AAD는 magic,
header length와 exact canonical header bytes다. Salt에는 고정 `kodex-offline-backup-v2` domain을 NUL separator와
함께 붙여 scrypt input domain을 분리한다. Header의 KDF/algorithm 값은 협상하지 않고 위 고정 정책과 정확히
같아야 하므로 downgrade나 과도한 KDF parameter를 거부한다.

대용량 dump와 tenant file은 64 KiB 단위로 custom archive → gzip → AES-GCM 경계를 통과하며 전체 payload를
메모리에 올리지 않는다. Archive는 record count, canonical `{path,sizeBytes}` header, raw bytes와 exact footer를
가지며 path traversal, duplicate/unordered/unlisted record, truncation, decompression 오류와 trailing bytes를
거부한다. Decrypted plaintext는 mode-restricted UUID 임시 root에만 만들고 성공·실패 모두 그 exact root만
정리한다.

## Signature와 provenance

Phase 30의 canonical Ed25519 payload helper와 외부 `kodex-release-trust-store` parser를 그대로 재사용한다.
서명 대상은 canonical signing manifest v1이며 exact envelope header, streaming ciphertext SHA-256와 GCM tag를
포함한다. Artifact가 public key나 trust anchor를 제공할 수 없고, verify/restore는 artifact 밖 versioned trust
store의 `trusted` key만 허용한다. Unknown/revoked key, canonical JSON/base64 위반과 signature mismatch는 복호화
전에 실패한다.

복호화 뒤에는 내부 Phase 24 manifest의 timestamp, application version/commit와 migration ledger가 서명된
header와 같은지 확인한다. 이어 실행 중인 signed runtime/source checkout의 version/commit, packaged migration
checksums, Codex upstream commit와 vendor manifest digest에 exact-match해야 한다. 다른 release에서 만든 backup은
자동 호환으로 추정하지 않는다. 원래 exact release로 복원한 뒤 정상 forward upgrade 절차를 사용한다.

## Secret 입력과 CLI 정책

Passphrase와 Ed25519 private signing key bytes는 argv, 일반 environment, env file, artifact manifest와 log로 받지
않는다. 각각 bounded non-interactive stdin 또는 전용 regular file 하나만 허용한다. Create에서 하나의 stdin을 두
secret이 공유할 수 없으므로 적어도 하나는 restricted file이어야 한다. Passphrase는 optional terminal newline을
제외한 한 줄 16~4,096 bytes, private key는 최대 64 KiB Ed25519 PKCS#8이다. Empty/oversized/NUL/multiline input,
TTY stdin, symlink, directory/special file와 file replacement race를 거부하고 buffer는 사용 뒤 best-effort로 지운다.

POSIX는 group/other mode bit가 하나라도 있으면 실패한다. Windows는 PowerShell을 최소 environment로 실행해 owner와
모든 allow ACE를 SID로 확인하며 현재 사용자, SYSTEM, Administrators 외 read/write principal이 있거나 검사가
불가능하면 실패한다. Private signing key는 repository/runtime/artifact 안에 둘 수 없다. Production key custody,
HSM, quorum과 trust-store authenticated distribution은 계속 조직의 offline signing 경계다.

CLI `create|verify|restore`는 envelope v2 file만 취급한다. 기존 plaintext v1 library는 내부 archive 및 기존 Phase 24
acceptance 호환을 위해 남지만 production CLI fallback, auto-detection 또는 `--allow-plaintext`는 제공하지 않는다.
과거 plaintext backup은 격리된 legacy release로 검증·복원한 뒤 Phase 34에서 새 암호화·서명 artifact를 생성한다.
운영 출력은 count/size/duration/version/key/store version만 포함하고 실패는 payload/path/secret 없는 stable code와
exit `1..7`만 반환한다.

## Restore 순서와 실패 경계

Restore는 다음 순서를 바꾸지 않는다.

1. regular-file envelope framing, exact length와 trailing-byte 부재 확인
2. external trust store, key status, canonical signing manifest digest와 Ed25519 signature 확인
3. bounded scrypt와 AES-GCM authenticated decryption
4. bounded gzip/archive parse와 path/type/count/length 확인
5. 기존 inner manifest의 DB dump 및 모든 tenant file size/SHA-256와 unlisted content 확인
6. inner ↔ signed header ↔ current runtime provenance exact-match
7. 빈 PostgreSQL DB와 존재하지 않는 새 `KODEX_DATA_ROOT` 확인
8. 그 뒤에만 기존 `pg_restore`와 tenant copy 수행

1~6 실패는 target DB/data root에 쓰지 않는다. `pg_restore`가 시작된 뒤 실패한 DB는 기존 Phase 24 계약처럼
부분 상태일 수 있으므로 폐기하고 다른 빈 DB에서 다시 시작한다. WAL/PITR, backup retention scheduler,
cryptographic erasure, trust-store rollback 방지와 production key 생성은 이 Phase의 범위가 아니다.

## 검증

Dependency-free fixture는 임시 Ed25519 key/trust store와 64 KiB를 넘는 DB/tenant files로 round trip과
multi-chunk 처리를 실행한다. Wrong passphrase, header/nonce/ciphertext/tag/signature tamper, KDF 변경, 여러 truncation,
trailing bytes, unknown/revoked key, version/commit/migration/vendor mismatch, plaintext/unlisted input, malformed gzip,
path traversal, secret pipe/file/permission/size/symlink 제한, plaintext secret 부재, verification-before-callback과
exact temporary-root cleanup을 검증한다. 실제 PostgreSQL, Docker, Electron과 production key는 사용하지 않는다.
