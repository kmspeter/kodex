# Phase 1~36 release acceptance matrix

Machine-readable 원본은 `config/release-acceptance-catalog.json`, schema는
`config/release-acceptance-catalog.schema.json`과 `config/release-acceptance-evidence.schema.json`이다. 아래 표는 운영
review용 projection이며 command ID는 catalog의 allowlist다. Phase 1~36은 적어도 하나의 mandatory requirement에 모두
포함되고, `REL-018` long-run soak는 전체 Phase의 상호작용을 덮는다.

| Requirement | 핵심 Phase | Category / 환경 | 허용 command ID | 필요한 evidence |
| --- | --- | --- | --- | --- |
| `REL-001` | Phase 1, 28~30, 35~36 | repository | `acceptance.repository-contracts`, `acceptance.security` | repository receipt |
| `REL-002` | Phase 1~2, 5, 8, 15~16, 18~21, 25, 27, 31~36 | PostgreSQL fresh | `acceptance.database-migrations` | test receipt |
| `REL-003` | Phase 15~16, 18~21, 25, 27, 31~36 | PostgreSQL upgrade | `acceptance.database-migrations` | test receipt |
| `REL-004` | Phase 2~3, 6, 9~10, 12, 15~16, 19~23, 25~27, 31~33, 36 | Product/Local browser boundary | `acceptance.browserless-full-stack` | test receipt |
| `REL-005` | Phase 3, 6, 9, 12, 19, 21~23, 28, 36 | runtime isolation | `acceptance.browserless-full-stack` | test receipt |
| `REL-006` | Phase 4, 7, 10~11, 22~23, 36 | History/reconciliation | `acceptance.browserless-full-stack`, `acceptance.history-rag` | test receipt |
| `REL-007` | Phase 5, 8, 13~14, 36 | private RAG/filesystem/PostgreSQL | `acceptance.history-rag` | test receipt |
| `REL-008` | Phase 6, 11, 14, 17, 21, 26, 28, 31~33, 36 | Electron/browser boundary | `acceptance.electron` | test receipt |
| `REL-009` | Phase 2, 15~17, 19~20, 26, 32, 36 | email/auth recovery | `acceptance.email` | test receipt |
| `REL-010` | Phase 12, 18, 21~22, 28, 33, 36 | Workspace lifecycle/recovery | `acceptance.workspace-recovery` | test receipt |
| `REL-011` | Phase 3, 6, 13, 21, 24, 28, 33~34, 36 | filesystem/data lifecycle | `acceptance.filesystem-lifecycle` | test receipt |
| `REL-012` | Phase 27~29, 36 | payload-free observability/security | `acceptance.observability`, `acceptance.security` | test receipt |
| `REL-013` | Phase 24, 29~30, 34, 36 | backup/restore | `acceptance.backup-restore` | signed artifact receipt |
| `REL-014` | Phase 25, 29~31, 36 | production build | `operations.production-release-build` | build receipt + verified release artifact |
| `REL-015` | Phase 25, 29~31, 34, 36 | signing | `acceptance.release-deployment`, `acceptance.release-signing` | artifact receipt + verified release artifact |
| `REL-016` | Phase 30~31, 36 | installer/updater | `acceptance.installer-fixture`, `operations.installer-artifact` | artifact receipt + confirmed installer state |
| `REL-017` | Phase 24, 34~36 | managed PostgreSQL/provider | `operations.provider-recovery-drill` | Phase 35 provider-drill receipt |
| `REL-018` | Phase 1~36 | Product/Local/Electron/PostgreSQL/filesystem/release | `operations.soak` | signed wrapper + 12~72h completed soak receipt + full operational metric/reconnect/restart coverage |

## Evidence 해석

한 receipt는 정확히 한 requirement와 catalog가 허용한 command/evidence type에 결합된다. 모든 receipt는 같은 clean Git
HEAD, application version, catalog digest, recovery policy digest, immutable migration ledger digest와 vendor provenance를
가져야 한다. Test count는 `total = passed + failed + skipped`, passed는 1 이상, failed는 0이어야 한다. Freshness는
requirement별 `maximumAgeHours`를 사용한다.

Build/signing/installer/provider/soak는 signed acceptance wrapper만으로 통과하지 않는다. Final gate가 external source
artifact/receipt를 Phase 30 release verifier, Phase 31 installer state, Phase 35 recovery validator와 Phase 36 long-run
receipt parser로 다시 확인해야 한다. Soak receipt의 모든 sample은 heap/handle/socket/DB pool/outbox/lease/temp/disk를
실제 관측해야 하고 `processSampleCount=fixtureSampleCount=0`이어야 한다. 두 production scenario가 요구하는 reconnect와
restart action은 required=observed이고 recovery count가 required 이상이어야 한다. Electron/PostgreSQL처럼 이 실행에서
수행하지 않은 category는 pending으로 남는다.

`npm run acceptance:validate`가 이 문서의 first/last requirement와 Phase 범위, machine catalog/schema digest를 함께
검사한다. Requirement를 추가/변경하면 catalog, schema/parser, 이 matrix, checklist, ADR/threat model과 fixture를 같은
변경에서 갱신한다.
