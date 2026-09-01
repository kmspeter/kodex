# ADR 0006: Desktop Product API와 tenant runtime 수명주기

- 상태: 승인
- 날짜: 2026-08-31

## 배경

source `npm run dev`/`npm start`는 Product API, Local Server와 UI를 함께 실행했지만 Electron과 portable launcher는 Local Server만 소유했다. built renderer는 Product API `47832`를 정적으로 가정했고 Electron `userData`는 repository 밖이어서 기존 RuntimeManager의 repository 내부 tenant-root 규칙과 충돌했다. portable bundle에는 Product API, product DB/contract, migration과 `pg`/`argon2` runtime도 없었다.

## 결정

Desktop main process가 Product API와 Local Server 두 child의 단일 coordinator가 된다. 외부 `DATABASE_URL`은 필수 dependency이며 PostgreSQL binary/container를 bundle하거나 자동 기동하지 않는다. 설정은 process environment 또는 `%APPDATA%\Kodex\kodex.env`에서 읽되 environment가 우선한다. 설정 파일과 `%APPDATA%\Kodex\data`는 OS 사용자 전용 ACL로 보호해야 한다. immutable `resources/app`에는 config, credential, tenant state를 쓰지 않는다.

시작 순서는 다음과 같다.

1. 설정 파일을 읽고 `DATABASE_URL` 형식 및 서로 다른 loopback port를 확인한다.
2. Product API를 `127.0.0.1` exact Host/Origin allowlist로 시작한다.
3. `GET /api/health/ready`가 DB `SELECT 1`까지 성공할 때까지 bounded wait한다.
4. Local Server를 같은 두 port와 exact Product API CSP origin으로 시작한다.
5. `GET /api/health` 성공 후에만 BrowserWindow를 만들고 UI를 load한다.

Product API는 migration을 listen 전에 완료하는 의미를 유지한다. `/api/health/live`와 `/api/health/ready`는 인증 없이 Host 및 기존 Origin 검사를 통과한 요청에만 최소 no-store JSON을 반환한다. readiness 오류는 DB URL, credential, schema 또는 driver message를 반환하지 않는다.

어느 child든 예상 밖에 종료하면 coordinator는 renderer를 닫고 나머지 child를 종료한다. 정상 quit은 Local Server, Product API 역순으로 `kodex-shutdown` IPC를 보내며, 각 child는 server/runtime/DB를 닫은 뒤 parent IPC를 disconnect한다. IPC가 없거나 bounded wait를 넘기면 signal을 거쳐 Windows `taskkill /T /F`로 남은 process tree를 정리한다. source `npm start`의 SIGINT/SIGTERM 경로도 유지한다. child stdout/stderr는 launcher에 전달하지 않는다. cleanup할 smoke data는 신뢰한 temp base 내부의 고정 prefix child인지 다시 검사한다.

## Origin과 renderer 설정

Desktop은 Local Server와 Product API에 각각 격리 가능한 loopback port를 사용하고 hostname은 항상 `127.0.0.1`로 맞춘다. Local Server는 검증된 origin 집합에서 UI 요청 Host와 동일 hostname인 Product API origin이 정확히 하나일 때만 built `index.html`의 `kodex-product-api-origin` meta에 주입하고, CSP `connect-src`에는 전체 allowlist를 유지한다. preload/global에는 runtime config나 secret을 노출하지 않는다. renderer는 production loopback에서 UI와 Product API protocol/hostname이 모두 같고 port만 다른 경우만 허용하며, non-loopback production은 exact same-origin만 허용한다. production UI는 build-time `VITE_PRODUCT_API_URL`에 의존하지 않는다.

Desktop Product API는 원격 production server가 아니라 exact `127.0.0.1` HTTP endpoint다. 따라서 launcher는 loopback에서 `Secure` cookie를 사용할 수 없는 이유로 `PRODUCT_API_NODE_ENV=development`를 명시하지만, Product API Host/Origin allowlist, Local Server CSP와 renderer runtime-origin 검증은 별도로 엄격하게 유지한다.

## Writable tenant 경계

RuntimeManager는 `repositoryRoot`와 별개로 명시적인 trusted `dataRoot`를 받는다. `tenantRoot`는 반드시 `dataRoot`의 strict descendant여야 한다. drive root, home, repository/source root 또는 repository를 포함하는 ancestor는 data root가 될 수 없다. tenant path는 DB 인증 결과의 UUID user/workspace segment만 사용하고 계산 후 containment를 다시 검사한다. source 기본은 `<repository>/.kodex-data`, desktop 기본은 `%APPDATA%\Kodex\data`다. instance lock과 tenant별 `CODEX_HOME` 분리는 유지한다.

## Portable bundle과 검증

Windows x64 bundle은 Product API dist, Local Server/UI, product contract/DB dist, migration 0001~0005, declared `pg`/`argon2` runtime dependency closure와 Argon2 Windows prebuild를 복사한다. root `node_modules`, env/config 파일, credential과 tenant data는 복사하지 않는다. bundle 생성은 required file, 금지 config/data path, Product API server module import, migration directory 해석과 5개 migration load를 검증한다.

기본 smoke는 실제 DB/Docker/OpenAI를 사용하지 않는 명시적 fixture로 Product readiness → Local readiness → runtime origin → 로그인 UI를 확인한다. 실제 PostgreSQL desktop smoke는 `DATABASE_URL`을 주입한 별도 opt-in 명령이다.

## 한계

Portable 결과는 installer, code signing, auto-update나 PostgreSQL 운영 도구를 제공하지 않는다. 외부 DB의 설치, extension 관리, backup, TLS와 upgrade는 배포 운영자의 책임이다. fixture smoke는 lifecycle/UI wiring 검증이며 실제 인증 SQL 검증을 대신하지 않는다.
