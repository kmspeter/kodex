# Kodex 통합 threat model

- 기준: Phase 36, 2026-09-05
- 대상: Electron/React, Product API, Local Server, 공식 Codex App Server, PostgreSQL/pgvector,
  tenant filesystem, build/vendor/release, Windows installer state, managed PostgreSQL recovery evidence,
  long-run acceptance state와 final release readiness evidence
- 검증 entrypoint: `npm run security:validate`, `npm run test:security`, `npm run test:release-signing`,
  `npm run test:backup-encryption`, `npm run recovery:validate`, `npm run test:recovery`, `npm run test:installer`,
  `npm run acceptance:validate`, `npm run test:long-run-acceptance`, `npm run test:release-acceptance`

## 자산과 공격자

보호 자산은 Product session/CSRF proof, password hash와 verification/invitation token hash, email delivery와
provider/operations secret, private History/RAG content, tenant별 `CODEX_HOME`과 outbox, approval 결정,
release/source provenance, offline signing private key, backup passphrase와 encrypted backup, public trust-store 상태,
active/last-known-good/rollback pointer와 installer journal, production database recovery policy digest와 signed
provider drill receipt의 trust version/readiness, long-run checkpoint/lease/receipt와 final acceptance catalog/evidence
provenance다. 공격자는
인증되지 않은 네트워크 client, 다른 user/workspace의 인증 사용자, 악성 repository content, 변조된 dependency/
vendor/runtime input, 과도한 DB 역할, stale/forged recovery evidence와 로컬의 다른 비관리 process를 포함한다. 운영 host/secret manager와 승인된
release maintainer 자체가 완전히 장악된 경우, PostgreSQL host 관리자, 서명 key 탈취는 이 모델 밖의 상위 신뢰
실패다.

## 데이터 흐름과 검증 가능한 경계

```text
Browser/Electron renderer
  | Product HttpOnly session + exact Origin + CSRF
  v
Product API -- application DB role --> PostgreSQL/pgvector
  | HTTPS bearer webhook, transient fragment-only token
  +-----------------------------------------------> Email provider
  ^                                      ^
  | session/membership revalidation      | separate migration role (deploy only)
Local Server (127.0.0.1) ----------------+
  | authenticated (user, workspace), bounded/redacted JSONL
  v
official Codex App Server --> per-user/per-workspace CODEX_HOME

quiesced PostgreSQL + KODEX_DATA_ROOT
  | verified inner manifest/archive stream
  v
scrypt + AES-256-GCM envelope -- canonical digest --> external Ed25519 signer
  |                                                    |
  +------ encrypted backup file <---- signature -------+
                         |
external public trust store -> verify/decrypt/temp validate -> empty DB + new data root

external managed PostgreSQL operator -- provider drill --> payload-free recovery receipt
  | WAL/PITR/base backup/replica/snapshot controls                |
  +--> versioned recovery policy digest/trust version -----------+--> external Ed25519 trust store --> deployment readiness gate

allowlisted Product/Local/Electron/PostgreSQL acceptance commands
  --> atomic checkpoint + exclusive heartbeat lease --> payload-free 12~72h soak receipt

clean HEAD + catalog/policy/migration/vendor provenance + signed evidence + verified source artifacts
  --> external Ed25519 trust store --> fail-closed final release readiness
```

| 경계 | 주요 위협 | 강제 통제와 증거 |
| --- | --- | --- |
| Renderer → Product API | session 탈취, CSRF, secret bundle 유출 | HttpOnly/Secure cookie, exact Origin, HMAC double-submit CSRF, Vite env 제거; auth/security unit 및 full-stack tests |
| Workspace recovery → lifecycle | IDOR, non-owner 복구, password/name/phrase 우회, permanent deletion 취소, worker 경합 | account-bound archived cursor, generic forbidden, current Argon2 credential, exact confirmations, transaction row locks와 NOWAIT conflict, purge/job/target/tombstone/hold fail-closed; restore unit/API/PostgreSQL tests |
| Renderer → Local | loopback의 임의 client, stale membership | exact origin/bootstrap, 매 요청 DB authorization, WS bounded 재인가, loopback bind; local security/runtime tests |
| Product/Local → DB | cross-tenant 조회, schema/ledger 변조, superuser 사용 | repository scope, production application role posture와 exact ledger read-only 검증; `privileges.ts`, `test/unit/product-db.test.ts` |
| Product API → Email provider | bearer/recipient/token 유출, redirect/slow body, replay와 provider 장애 | opt-in HTTPS, server-only distinct bearer, redirect 거부, timeout/response bound, payload-free leased retry, attempt별 token rotation; email delivery unit/PostgreSQL tests |
| Migration → DB | application credential로 DDL, cluster-wide 권한 | 별도 `PRODUCT_DB_MIGRATION_URL`, database-scoped owner이되 superuser/CREATEDB/CREATEROLE/replication/BYPASSRLS 거부; Compose init + migration CLI |
| Local → filesystem | path traversal, tenant 공유/삭제 | UUID segment 재검증, immutable/runtime와 writable root 분리, `(user, workspace)` root, exact lifecycle deletion; storage/runtime/data-lifecycle tests |
| Local → App Server | 비공식 state read, approval 우회, secret over-forward | 공식 stdio App Server만 사용, 공개 notification/snapshot, 선택 provider secret만 전달, approval server-request 보존; reproducibility/history tests |
| History/RAG | payload log, 다른 사용자 content, 무동의 외부 전송 | payload-free fixed logs, creator scope, repository preview→select→consent→confirm, bounded sanitizer/outbox; history/RAG/observability tests |
| Source/dependency → build | lock drift, vendor 추가/변경, pin/metadata mismatch | lockfile v3 closure, strict vendored manifest/pin, Cargo lock/build/protocol linkage; `security:validate`, `codex:verify-source` |
| Build → seal | stale runtime, secret/tenant 혼입, artifact tamper | clean HEAD, tracked+release-input secret scan, repository/runtime provenance equality, canonical full file manifest; release tests/integrity gate |
| Seal → offline signer | private key 유출, 바뀐 manifest 서명, 재서명 | repo/artifact 밖 explicit key file 또는 bounded non-interactive stdin, sign 전 integrity/secret scan, exclusive detached Ed25519 envelope; signing fixture/tests |
| DB/data root → encrypted backup | plaintext 유출, weak KDF/nonce reuse, symlink/path traversal, partial archive | offline maintenance lock, 64 KiB archive/gzip/GCM stream, fixed scrypt policy와 fresh salt/nonce, restricted exact temp root, inner path/size/SHA-256; backup encryption fixture |
| Backup → restore | forged/revoked artifact, wrong passphrase, truncation/trailing, decompression bomb/content, release mismatch, validation 뒤늦은 mutation | external Phase 30 trust store, signature-before-decrypt, GCM AAD/tag, sealed archive length/count/footer, inner manifest, exact version/commit/migration/Codex/vendor check 뒤 empty DB/new root mutation |
| Provider recovery evidence → deployment | forgeable verified boolean, semantic tamper, unknown/revoked/wrong key, trust-store/version substitution, weak/disabled control, stale/failed/다른-policy receipt | signature field 외 모든 semantics의 domain-separated canonical JSON, Phase 30 external trust-store active-key Ed25519 verification, exact loaded/receipt store version과 policy minimum/ref, strict policy/receipt schema; `recovery:validate`, `test:recovery` |
| Operator → backup secret input | argv/env/log/key bundle 유출, broad file ACL, TTY prompt와 oversized input | passphrase/private key는 bounded pipe 또는 dedicated file만 허용, POSIX mode/Windows owner+DACL/SID 검사, symlink/special/race 거부와 payload-free stable result code |
| Artifact → install/run/update | 위조/unsigned release, key substitution/revocation 우회, trust-store rollback | artifact 밖 versioned public trust store, strict canonical parsers, unknown/revoked key와 unsigned fail-closed, digest/signature/full-tree verify; release CLI/packaged verifier |
| Installer state → active code | in-place overwrite, path escape/reparse, unsafe ACL, concurrent/crashed pointer 전환 | signed-first verification, Phase 29 secret scan, external ACL adapter, side-by-side roots, same-directory atomic pointer+journal, exclusive lock, exact-root cleanup; installer fixture/unit |
| DB schema → binary rollback | forward-only migration 뒤 incompatible binary 자동 downgrade | signed readable-schema metadata, conservative candidate latest-schema journal, incompatible rollback의 `operator_recovery_required`; installer fixture/ADR 0030 |
| Uninstall → persistent data | tenant/CODEX_HOME/DB/backup 동반 삭제 | per-user code root와 외부 데이터 분리, plan-only uninstall adapter boundary, exact direct-child deletion; layout schema/runbook |
| Long-run runner → acceptance target | duplicate runner, stale/crash replay, PATH npm substitution, unbounded retry, destructive chaos, resource leak, zero-filled 미관측값/recovery 위조, payload/state 유출 | atomic pre-invocation checkpoint, stable operation/fresh attempt invocation digest, expiring heartbeat lease, bounded deadline/retry/backoff, fixed reversible action IDs, absolute npm-cli.js+current Node, external canonical result identity/freshness/symlink checks, observed/null coverage와 aggregate threshold; Phase 36 fake fixture/runbook |
| Acceptance evidence → release decision | 과거/다른 commit receipt, forged boolean, unsigned/tampered/unknown/revoked evidence, missing source artifact, dirty tree, process/fake soak 승격 | exact current HEAD/version/catalog/policy/migration/vendor match, external Ed25519 trust store, Phase 30/31/35 source verifier, Phase 36 full operational metric/reconnect/restart coverage, all-requirement fail-closed matrix; `acceptance:validate`, `release:readiness` |

## Threat 처리

- Spoofing: Product session은 hash-only DB record와 HttpOnly cookie로, operations API와 email provider는 서로 다른
  server-only bearer로 식별한다. 미확인 email session은 verification status/resend/logout 외 권한을 얻지 못하며
  Local bootstrap은 verified Product session과 active membership 없이 발급되지 않는다. Workspace restore는 현재
  verified session의 owner membership과 Argon2 password를 transaction 안에서 다시 확인한다.
- Tampering: migration checksum ledger, strict vendor manifest, package lock closure, Codex binary build metadata와
  release full-tree SHA-256이 불일치를 거부한다. Exact canonical manifest bytes의 detached Ed25519 signature와
  external trust store가 manifest/artifact 동시 변조와 key substitution을 거부한다. Installer는 signed tree를
  먼저 검증하고 side-by-side copy를 다시 검증하며 pointer/journal record의 extra/non-canonical field를 거부한다.
  Backup은 header+ciphertext digest+GCM tag canonical representation을 같은 trust primitive로 서명하며, authenticated
  decryption 뒤에도 inner manifest와 current release provenance를 exact 비교한다. Phase 35 receipt는 signature field
  자체를 제외한 timestamp/result/policy digest/objectives/protections/trust ref/version/key ID 전체를 domain-separated
  canonical JSON으로 봉인한다. Phase 30 external trust-store의 active key로 실제 Ed25519 검증하고 loaded store
  version exact match 뒤에만 stale/future/failed/RPO/RTO/protection mismatch를 production promotion 전에 평가한다.
  Phase 36 evidence도 signature field를 제외한 requirement/command/result/timestamps/current provenance/count/artifact
  metadata 전체를 별도 domain으로 봉인한다. Release readiness는 wrapper signature뿐 아니라 release artifact,
  confirmed installer state, Phase 35 recovery receipt와 12~72시간 completed soak source를 다시 검증한다. Soak는
  exit status가 아니라 모든 resource sample의 operational observation과 required reconnect/restart recovery evidence가
  완전해야 한다.
- Repudiation: audit에는 bounded operation/ID/status만 남긴다. Delivery log도 kind/outcome/attempt만 가진다. Prompt,
  response, email, token, URL, 경로와 provider/DB 오류문은 일반 log에 남기지 않는다. Recovery validate/status도
  stable code, policy digest, coarse age bucket/count만 출력하고 resource ID, WAL LSN/timeline, snapshot ID와
  evidence payload, key ID나 signature bytes를 출력하지 않는다. Signing private key와
  signature bytes는 signer 성공/실패 log에
  출력하지 않으며 key를 환경 변수나 CLI 값으로 받지 않는다. Restore audit는 stable `workspace.restored`와
  payload-free operation만 남기고 password, Workspace 이름과 confirmation을 기록하지 않는다.
  Long-run state/receipt는 run/plan/scenario와 monotonic aggregate만, readiness는 stable code/catalog digest/pending
  category/count만 출력하며 child stdout/stderr, state/evidence path와 key/signature를 출력하지 않는다.
- Information disclosure: Verification은 domain-separated hash-only이고 delivery queue에는 target FK와 고정 상태만
  둔다. Raw token/fragment URL은 provider 호출 순간 외 DB/log/audit에 없으며 React bootstrap 전 URL에서 제거한다.
  History/RAG는 `(workspace_id, created_by_user_id)` private scope이고 renderer env, operational status, release scan
  진단에 secret 값이나 payload를 넣지 않는다. Backup passphrase/private key는 argv/env/manifest/log에 없고 tenant
  path/content는 encrypted inner archive에만 있다. Archived Workspace 목록은 owner에게만 보이며 cursor를 account에
  암호화해 묶고 lifecycle 상태를 public DTO에 포함하지 않는다. Secret scan은 path/rule/line/fingerprint만 출력한다.
  Acceptance receipt에는 tenant/user/workspace/email, prompt/tool payload, filesystem path, DB URL, token/secret와 raw
  error가 없고 external trust store/private key는 repository/runtime/UI와 분리한다.
- Denial of service: request/body/page/outbox/file/count/byte/time/provider-response bounds와 PostgreSQL 공유 limiter를
  사용한다. Verification resend는 account/address, consume은 address/token bucket을 공유한다. Local
  runtime 수와 reconciliation, release tree/state JSON/retained release 수를 제한한다. Live installer lock을 깨지
  않고 stale dead-process lock만 recover한다. Backup은 header/signature/record/count/path bounds, fixed scrypt cost와
  signed uncompressed length를 사용하되 실제 대용량 backup의 disk/time capacity planning은 운영자 책임이다. Edge
  DDoS/WAF도 운영자 책임이다.
  Long-run runner는 72시간/iteration/step timeout/attempt/backoff, JSON/file/count와 모든 resource absolute/growth
  threshold를 제한하고 live heartbeat lease로 duplicate runner를 막는다.
- Elevation of privilege: workspace role과 creator scope를 매 경계에서 다시 확인한다. Production application DB
  역할은 DB/schema owner와 broad role attribute/DDL을 가질 수 없고 migration 역할은 application과 달라야 한다.
  Restore는 admin/member 권한으로 승격되지 않으며 다른 tenant와 없는 Workspace를 같은 forbidden 경계로 처리한다.

## 불변식과 변경 규칙

Payload-free logging, HttpOnly/CSRF, private History/RAG, tenant filesystem, 공식 App Server 및 approval 경계는
Phase 34 backup, Phase 35 recovery policy나 Phase 36 acceptance 작업으로 완화되지 않는다. `recovery:cli status`와
`release:readiness`는 HTTP operations status에 연결되지 않으며 기존 operations bearer/Origin/default-404 계약을
바꾸지 않는다. Allowlist는 `.secret-scanner-allowlist.json`의 exact path/rule/fingerprint와
사유만 허용하며 stale entry도 실패한다. 새 데이터 흐름, credential, 외부 provider, filesystem root, DB 권한,
release input, signing key boundary나 trust anchor가 생기면 이 문서와 ADR, 해당 executable validation/test를
함께 갱신한다.

Acceptance chaos는 allowlisted reversible fixture action만 사용한다. DB/data/user file 삭제, Docker daemon/volume
mutation, approval auto-approve, policy bypass는 허용하지 않는다. Fake fixture receipt와 과거 CI 결과를 production
evidence로 승격하지 않는다.

## 잔여 위험

Production key ceremony/HSM과 custody, backup passphrase escrow/recovery, trust-store authenticated distribution,
transparency/timestamp,
Authenticode, 실제 installer packaging binary와 process/service/registry/shortcut adapter, admin/system-wide install,
SBOM/registry attestation, host hardening, managed PostgreSQL TLS/HA/WAL·backup/replica/snapshot 통제의 실제 구성과
provider attestation, email provider의 mailbox/deliverability/body handling과 remote MCP/Web Search는 별도 통제다. Provider가
요청을 받은 뒤 응답이 유실되면 retry rotation 때문에 먼저 전달된 링크가 무효화될 수 있다. Offline signing
host나 현재 trusted private
key가 장악되면 공격자는 유효한 release/backup artifact를 서명할 수 있으므로 즉시 store version을 올려 revoke하고
해당 key의 과거 artifact도 격리해야 한다. Backup encryption은 WAL/PITR, incremental/deduplication, retention
scheduler, cryptographic erasure나 crash residue secure deletion을 제공하지 않는다. Phase 35 WAL/PITR/replica/provider snapshot
policy는 구성과 cryptographically signed evidence를 fail-closed 검증할 뿐 provider control plane, 실제 restore/
promotion/fencing이나 signer custody/service를 제공하지 않는다. External trust store의 authenticated distribution과
anti-rollback도 운영 control plane 책임이다. Passphrase와 모든 승인된
recovery material을 잃으면 GCM payload를 복구할 수 없다. Self-service restore는 out-of-band로 사라진 application row/file을 증명하거나
복구하지 않으며 backup/forensic recovery가 아니다. Local trust-store receipt는 낮은 version과 같은 version의 다른 digest를
거부하지만 trust store 자체의 인증된 배포를 대신하지 않는다. ACL adapter가 손상되면 unsafe root를 승인할 수
있으므로 packaging trust base에서 보호해야 한다. 현재 checkout의 `bin/codex.exe` 부재로 binary를
요구하는 runtime/release gate는 실행할 수 없지만, 그 경로는 누락을 성공으로 간주하지 않는다.
Phase 36 state machine은 승인된 acceptance command를 반복 실행하고 결과를 판정하지만 production capacity planning,
host-level process-tree accounting, provider 진실성, external evidence issuer/HSM custody와 release 승인 권한을 제공하지
않는다. 실제 build/Electron/PostgreSQL/installer/provider drill/12~72시간 soak를 실행하지 않은 checkout은
`release_evidence_pending`으로 blocked다.
