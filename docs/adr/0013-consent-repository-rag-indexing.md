# ADR 0013: 명시적 동의 기반 private repository RAG 인덱싱

- 상태: 승인
- 날짜: 2026-09-03

## 결정

Repository RAG는 기존 private `KnowledgeService`와 pgvector 저장소를 재사용하되 파일 시스템 접근은
인증된 tenant Local Server에서만 수행한다. Product API와 browser는 absolute project root를 색인
요청에 싣거나 파일 내용을 preview하지 않는다. UI 흐름은 반드시 `preview → 파일 선택 → 외부
embedding/저장 동의 확인 → confirm` 순서이며 project 전체를 자동 색인하거나 background에서 다시
scan하지 않는다.

Preview token은 고엔트로피 일회용 UUID이고 `(user_id, workspace_id, active local project_id,
real project root)`에 10분 동안만 묶인다. workspace/user runtime이 바뀌거나 active project/root가
달라지면 사용할 수 없다. Confirm DTO는 token, active project UUID, preview에서 반환된 portable relative
path 배열만 받으며 exact-key, path 수, body와 문자열 상한을 적용한다. 서버는 allowlist membership,
중복, scope와 project를 다시 확인하고 모든 선택 파일의 link/type/realpath/size/metadata/UTF-8/문자 수를
재검증한 뒤에만 embedding을 시작한다. 하나라도 바뀌면 전체 confirm을 거부하고 새 preview를 요구한다.

## Trust boundary와 파일 정책

Active project root는 Local Server의 기존 tenant-scoped `ProjectStore`가 결정한다. 사용자가 request에
absolute path나 다른 project root를 주입할 수 없다. Walk는 root에서 직접 발견한 entry만 다루며
symlink, junction/reparse point, non-regular file을 따라가지 않는다. 각 파일은 `lstat`, `realpath`,
no-follow open(지원 플랫폼), open handle metadata와 read 후 metadata를 사용해 root 탈출과 일반적인
TOCTOU 교체를 fail-closed로 막는다. OS가 안전한 handle/metadata 의미를 제공하지 못하거나 검증에
실패하면 파일을 포함하지 않는다.

기본 제외는 `.git`, `node_modules`, `dist`, `build`, `coverage`, `.kodex-data`, symlink/junction,
non-file, 256 KiB 초과 파일, empty/binary/invalid UTF-8, `.env`/`.env.*`, 일반적인 credential·private-key
이름과 `.key/.pem/.p12/.pfx/.jks/.keystore`다. Git worktree이면 `git check-ignore`로 tracked 상태를
보존하면서 ignore rule을 적용한다. Git ignore 검증 자체가 실패하면 git repository preview를
fail-closed한다. 이름 기반 secret filter는 휴리스틱이라 잘못 이름 붙인 secret, source 안의 token,
생성된 credential을 모두 찾는 DLP가 아니다. 사용자는 후보 상대 경로를 검토할 책임이 있으며 파일
내용은 후보 preview, 오류, security/RAG log에 기록하지 않는다.

한 preview는 최대 5,000 entry를 살피고 최대 500개/16 MiB만 텍스트 eligibility 검사한다. Confirm은
최대 50개, 파일당 256 KiB, 합계 2 MiB/500,000 Unicode code point이며 각 파일은 기존
`KODEX_RAG_DOCUMENT_MAX_CHARACTERS`도 만족해야 한다. Preview는 상대 경로, bounded byte size,
eligibility, 제외 reason별 bounded count와 truncation만 browser에 반환한다.

## Identity, private scope와 삭제

Repository source identity는 private knowledge scope 안의 `repository:<local project UUID>`이고
`source_type=repository_file`이다. Document `source_document_id`는 preview에서 검증된 normalized relative
path라 `(user, workspace, project, relative path)`에 안정적으로 대응한다. 기존 content/config checksum과
advisory lock을 그대로 사용해 unchanged 파일은 embedding을 건너뛰고 변경 파일은 같은 document ID의
chunk를 원자 교체한다. 새 migration은 필요하지 않다.

모든 source/document/chunk/run/citation SQL은 계속 `(workspace_id, created_by_user_id)`를 요구한다.
Shared workspace owner/admin도 다른 사용자의 repository 문서, source/document UUID 또는 preview token을
사용할 수 없다. Citation은 `source_type`, bounded project label/relative-path title, document/chunk UUID만
추가 식별자로 사용하며 absolute local path를 저장하거나 모델/UI에 전달하지 않는다. Agent에는 검색된
bounded chunk만 기존 untrusted RAG block으로 전달하고 전체 파일을 첨부하지 않는다.

선택 해제 또는 디스크 삭제는 DB 삭제 요청으로 해석하지 않는다. 사용자가 다음 confirm에서 선택하지
않은 기존 문서는 계속 검색 가능하다. 제거는 Knowledge 문서 목록의 명시적 DELETE만 수행하며 document,
chunk와 기존 cascade citation을 private scope에서 삭제한다. 이 보수적 의미를 UI에 항상 표시한다.

## 실패와 취소

Browser는 preview/confirm 응답 대기를 취소할 수 있다. 이미 Local Server가 confirm을 받아 embedding을
시작한 뒤에는 provider/DB 작업이 완료될 수 있으므로 UI도 이를 취소 완료로 오해시키지 않고 문서 목록
재확인을 안내한다. Confirm token은 재사용 공격과 scope 전환 재사용을 막기 위해 첫 시도에 소비된다.
취소, 파일 변경, provider 실패 뒤에는 새 preview가 필요할 수 있다.
여러 파일의 filesystem validation은 embedding 전에 모두 끝나지만 파일별 embedding/DB 교체는 기존
document 단위 transaction이므로 중간 provider 실패 전 완료된 파일은 남을 수 있다. 결과는 파일별
indexed/unchanged와 chunk count를 반환하고 내용이나 secret은 반환하지 않는다.

## 검증

기본 test는 fake embedding과 임시 filesystem만 사용해 traversal/absolute path, junction, ignore,
binary/secret/size, preview tampering, user/workspace/project scope, TOCTOU, exact DTO, UI consent,
checksum skip/update/delete를 검증한다. 실제 PostgreSQL/pgvector source identity와 citation/private FK는
`npm run test:rag-postgres`의 격리 `--rm` container harness에서 opt-in 검증하고 `finally`에서 정리한다.
