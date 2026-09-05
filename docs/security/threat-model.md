# Kodex 통합 threat model

- 기준: Phase 31, 2026-09-05
- 대상: Electron/React, Product API, Local Server, 공식 Codex App Server, PostgreSQL/pgvector,
  tenant filesystem, build/vendor/release와 Windows installer state 경로
- 검증 entrypoint: `npm run security:validate`, `npm run test:security`, `npm run test:release-signing`,
  `npm run test:installer`

## 자산과 공격자

보호 자산은 Product session/CSRF proof, password hash와 token hash, provider/operations secret, private
History/RAG content, tenant별 `CODEX_HOME`과 outbox, approval 결정, release/source provenance, offline signing
private key, public trust-store 상태, active/last-known-good/rollback pointer와 installer journal이다. 공격자는
인증되지 않은 네트워크 client, 다른 user/workspace의 인증 사용자, 악성 repository content, 변조된 dependency/
vendor/runtime input, 과도한 DB 역할, 로컬의 다른 비관리 process를 포함한다. 운영 host/secret manager와 승인된
release maintainer 자체가 완전히 장악된 경우, PostgreSQL host 관리자, 서명 key 탈취는 이 모델 밖의 상위 신뢰
실패다.

## 데이터 흐름과 검증 가능한 경계

```text
Browser/Electron renderer
  | Product HttpOnly session + exact Origin + CSRF
  v
Product API -- application DB role --> PostgreSQL/pgvector
  ^                                      ^
  | session/membership revalidation      | separate migration role (deploy only)
Local Server (127.0.0.1) ----------------+
  | authenticated (user, workspace), bounded/redacted JSONL
  v
official Codex App Server --> per-user/per-workspace CODEX_HOME
```

| 경계 | 주요 위협 | 강제 통제와 증거 |
| --- | --- | --- |
| Renderer → Product API | session 탈취, CSRF, secret bundle 유출 | HttpOnly/Secure cookie, exact Origin, HMAC double-submit CSRF, Vite env 제거; auth/security unit 및 full-stack tests |
| Renderer → Local | loopback의 임의 client, stale membership | exact origin/bootstrap, 매 요청 DB authorization, WS bounded 재인가, loopback bind; local security/runtime tests |
| Product/Local → DB | cross-tenant 조회, schema/ledger 변조, superuser 사용 | repository scope, production application role posture와 exact ledger read-only 검증; `privileges.ts`, `test/unit/product-db.test.ts` |
| Migration → DB | application credential로 DDL, cluster-wide 권한 | 별도 `PRODUCT_DB_MIGRATION_URL`, database-scoped owner이되 superuser/CREATEDB/CREATEROLE/replication/BYPASSRLS 거부; Compose init + migration CLI |
| Local → filesystem | path traversal, tenant 공유/삭제 | UUID segment 재검증, immutable/runtime와 writable root 분리, `(user, workspace)` root, exact lifecycle deletion; storage/runtime/data-lifecycle tests |
| Local → App Server | 비공식 state read, approval 우회, secret over-forward | 공식 stdio App Server만 사용, 공개 notification/snapshot, 선택 provider secret만 전달, approval server-request 보존; reproducibility/history tests |
| History/RAG | payload log, 다른 사용자 content, 무동의 외부 전송 | payload-free fixed logs, creator scope, repository preview→select→consent→confirm, bounded sanitizer/outbox; history/RAG/observability tests |
| Source/dependency → build | lock drift, vendor 추가/변경, pin/metadata mismatch | lockfile v3 closure, strict vendored manifest/pin, Cargo lock/build/protocol linkage; `security:validate`, `codex:verify-source` |
| Build → seal | stale runtime, secret/tenant 혼입, artifact tamper | clean HEAD, tracked+release-input secret scan, repository/runtime provenance equality, canonical full file manifest; release tests/integrity gate |
| Seal → offline signer | private key 유출, 바뀐 manifest 서명, 재서명 | repo/artifact 밖 explicit key file 또는 bounded non-interactive stdin, sign 전 integrity/secret scan, exclusive detached Ed25519 envelope; signing fixture/tests |
| Artifact → install/run/update | 위조/unsigned release, key substitution/revocation 우회, trust-store rollback | artifact 밖 versioned public trust store, strict canonical parsers, unknown/revoked key와 unsigned fail-closed, digest/signature/full-tree verify; release CLI/packaged verifier |
| Installer state → active code | in-place overwrite, path escape/reparse, unsafe ACL, concurrent/crashed pointer 전환 | signed-first verification, Phase 29 secret scan, external ACL adapter, side-by-side roots, same-directory atomic pointer+journal, exclusive lock, exact-root cleanup; installer fixture/unit |
| DB schema → binary rollback | forward-only migration 뒤 incompatible binary 자동 downgrade | signed readable-schema metadata, conservative candidate latest-schema journal, incompatible rollback의 `operator_recovery_required`; installer fixture/ADR 0030 |
| Uninstall → persistent data | tenant/CODEX_HOME/DB/backup 동반 삭제 | per-user code root와 외부 데이터 분리, plan-only uninstall adapter boundary, exact direct-child deletion; layout schema/runbook |

## Threat 처리

- Spoofing: Product session은 hash-only DB record와 HttpOnly cookie로, operations API는 browser Origin을 거부하는
  별도 bearer로 식별한다. Local bootstrap은 Product session과 active membership 없이 발급되지 않는다.
- Tampering: migration checksum ledger, strict vendor manifest, package lock closure, Codex binary build metadata와
  release full-tree SHA-256이 불일치를 거부한다. Exact canonical manifest bytes의 detached Ed25519 signature와
  external trust store가 manifest/artifact 동시 변조와 key substitution을 거부한다. Installer는 signed tree를
  먼저 검증하고 side-by-side copy를 다시 검증하며 pointer/journal record의 extra/non-canonical field를 거부한다.
- Repudiation: audit에는 bounded operation/ID/status만 남긴다. Prompt, response, email, token, URL, 경로와 provider/
  DB 오류문은 일반 log에 남기지 않는다. Signing private key와 signature bytes는 signer 성공/실패 log에
  출력하지 않으며 key를 환경 변수나 CLI 값으로 받지 않는다.
- Information disclosure: History/RAG는 `(workspace_id, created_by_user_id)` private scope이며 renderer env, operational
  status, release scan 진단에 secret 값이나 payload를 넣지 않는다. Secret scan은 path/rule/line/fingerprint만 출력한다.
- Denial of service: request/body/page/outbox/file/count/byte/time bounds와 PostgreSQL 공유 limiter를 사용한다. Local
  runtime 수와 reconciliation, release tree/state JSON/retained release 수를 제한한다. Live installer lock을 깨지
  않고 stale dead-process lock만 recover한다. Edge DDoS/WAF는 운영자 책임이다.
- Elevation of privilege: workspace role과 creator scope를 매 경계에서 다시 확인한다. Production application DB
  역할은 DB/schema owner와 broad role attribute/DDL을 가질 수 없고 migration 역할은 application과 달라야 한다.

## 불변식과 변경 규칙

Payload-free logging, HttpOnly/CSRF, private History/RAG, tenant filesystem, 공식 App Server 및 approval 경계는
Phase 29 보안 작업으로 완화되지 않는다. Allowlist는 `.secret-scanner-allowlist.json`의 exact path/rule/fingerprint와
사유만 허용하며 stale entry도 실패한다. 새 데이터 흐름, credential, 외부 provider, filesystem root, DB 권한,
release input, signing key boundary나 trust anchor가 생기면 이 문서와 ADR, 해당 executable validation/test를
함께 갱신한다.

## 잔여 위험

Production key ceremony/HSM과 custody, trust-store authenticated distribution, transparency/timestamp,
Authenticode, 실제 installer packaging binary와 process/service/registry/shortcut adapter, admin/system-wide install,
SBOM/registry attestation, host hardening, PostgreSQL TLS/HA/WAL·backup
retention, external provider와 remote MCP/Web Search는 별도 통제다. Offline signing host나 현재 trusted private
key가 장악되면 공격자는 유효한 artifact를 서명할 수 있으므로 즉시 store version을 올려 revoke하고 해당 key의
과거 artifact도 격리해야 한다. Local trust-store receipt는 낮은 version과 같은 version의 다른 digest를
거부하지만 trust store 자체의 인증된 배포를 대신하지 않는다. ACL adapter가 손상되면 unsafe root를 승인할 수
있으므로 packaging trust base에서 보호해야 한다. 현재 checkout의 `bin/codex.exe` 부재로 binary를
요구하는 runtime/release gate는 실행할 수 없지만, 그 경로는 누락을 성공으로 간주하지 않는다.
