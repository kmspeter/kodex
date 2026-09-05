# Kodex self-service Workspace recovery runbook

이 runbook은 soft-archived이면서 application row와 tenant file이 보존된 Workspace를 owner가 직접 복구하는
절차와 장애 대응을 설명한다. Permanent deletion, offline backup restore 또는 forensic recovery와 혼동하지
않는다. Password, Workspace 이름, session/CSRF, cursor, user/workspace ID, tenant path와 오류 원문을 log,
metric label, ticket 또는 screenshot에 복사하지 않는다.

## 사용자 복구 절차

1. Verified owner account로 로그인하고 **Workspace 관리 → Archived Workspaces**를 연다. 목록은 현재 account가
   owner이면서 Product가 복원 가능하다고 확인한 대상만 최대 100개씩 보여 준다.
2. 대상을 선택하고 화면에 표시된 Workspace 이름을 공백·대소문자까지 정확히 입력한다.
3. 현재 비밀번호와 exact phrase `RESTORE WORKSPACE`를 입력해 제출한다. UI는 제출 즉시 세 confirmation 값을
   메모리 state에서 지운다.
4. 성공 뒤 account를 다시 불러와 active Workspace 접근이 회복됐는지 확인한다. 취소된 invitation과 이미
   삭제된 row/file은 돌아오지 않는 것이 정상이다.
5. Restore는 runtime을 자동 시작하지 않는다. 필요할 때 사용자가 명시적으로 시작하고 새 Product/Local
   authorization과 membership revalidation을 통과시킨다.

## Eligibility와 운영 확인

Self-service 대상은 Workspace row/current owner membership/`deleted_at`이 있고 다음 영구 삭제 증거가 모두
없어야 한다: `purge_requested_at`, account 또는 Workspace lifecycle job/job-workspace tombstone, Local target,
active account/Workspace legal hold. API는 이 조건을 transaction에서 잠그고 다시 확인한다. 운영자가 incident를
조사할 때는 승인된 read-only DB session에서 aggregate 상태만 확인하고 row payload, credential 또는 tenant
absolute path를 ticket에 덤프하지 않는다.

`GET /api/workspaces/archived`에 대상이 없으면 client에서 ID를 추측해 restore를 호출하지 않는다. 특히 다음
상태를 수동 DB 편집으로 “복원 가능”하게 만들지 않는다.

- `purge_requested_at`이 설정됐거나 lifecycle job이 requested/running/terminal인 상태
- lifecycle job-workspace tombstone 또는 알려진 Local cleanup target이 남은 상태
- permanent deletion worker가 application row 또는 tenant root를 이미 제거한 상태
- active legal hold가 있어 삭제/복구 상태가 선형화된 상태

Job, target, tombstone 또는 hold row를 삭제해 restore를 강제로 통과시키는 것은 지원되지 않는다. 데이터가
사라졌다면 [offline backup/restore runbook](backup-restore.md)에 따라 새 빈 DB와 새 data root로 전체 백업을
복원하거나 별도 forensic incident로 처리한다. Self-service endpoint로 부분 row/file을 재구성하지 않는다.

## 응답과 경합 처리

- `204`: `workspaces.deleted_at`만 해제됐다. 일반 account/auth 요청으로 상태를 다시 확인한다.
- `403`: 대상 없음, 다른 tenant, non-owner 또는 더 이상 접근할 수 없는 상태의 공통 경계다. 존재를 추론하지
  않는다.
- `409 restore_confirmation_mismatch`: 정확한 이름 또는 phrase를 사용해 사용자가
  새로 입력한다. 입력값을 telemetry에 남기지 않는다.
- `403 credential_rejected`: 현재 비밀번호를 다시 확인한다. Password reset은 별도 account recovery 절차다.
- `409 restore_conflict`: duplicate 요청이거나 lifecycle worker가 관련 상태를 잠근 경합이다. Account를 다시
  조회한다. 대상이 여전히 목록에 있을 때만 한 번 새 요청하고 자동 무한 retry하지 않는다.
- `409 workspace_restore_unavailable` 또는 `423 legal_hold`: Product가 permanent deletion/보존 불완전/hold 증거를
  확인했다. Lifecycle row를 고치거나 삭제하지 말고 운영 escalation으로 전환한다.

## 배치와 검증

Phase 33은 migration이 없다. 기존 migration 0001~0013 checksum ledger를 그대로 유지하고 Product API/UI를
같은 signed release로 배치한다. 배치 전후 vendor/generated/source pin 또는 release manifest를 기능 변경에
섞지 않는다.

```powershell
npm test -- test/unit/data-lifecycle.test.ts test/unit/workspace-name-contract.test.ts test/unit/workspace-api.test.ts test/unit/product-auth-client.test.ts test/unit/workspace-management-ui.test.tsx test/unit/workspace-switching-ui.test.tsx
npm run test:workspace-postgres
npm run typecheck
npm run lint
npm run security:validate
git diff --check
```

PostgreSQL harness는 disposable database/container에서만 실행한다. 운영 DB에서 fixture를 만들거나
`DELETE`/`TRUNCATE`하지 않는다. Electron/full-stack acceptance는 별도 승인된 환경에서 실행하며 이 runbook의
source 검증과 혼동하지 않는다.

## Audit와 incident 증거

성공 audit action은 stable `workspace.restored`이고 details는 bounded operation만 가진다. 이름, password,
confirmation, cursor, tenant path, lifecycle error와 History/RAG payload가 없어야 한다. Restore 전후 다음을
확인한다.

- `deleted_at`만 해제되고 기존 `updated_at`과 application row가 바뀌지 않았다.
- Archive 때 revoked된 invitation은 revoked 상태다.
- 이미 삭제된 application row/file은 새로 생기지 않았다.
- 사용자 private History/RAG creator scope와 membership authorization이 그대로다.
- runtime은 사용자의 명시적 start 전까지 시작되지 않았다.

의심스러운 cross-tenant probe, 반복 password 실패 또는 worker 경합은 endpoint/action/status 같은 고정
cardinality만으로 조사한다. 원문 request, response body와 식별자를 일반 운영 로그에 추가하지 않는다.
