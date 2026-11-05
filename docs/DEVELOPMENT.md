# 설치와 개발 가이드

각 설치는 자신의 Supabase, Google OAuth, 호스팅과 선택 외부 서비스 계정을 사용합니다. 기존 설치의 DB·계정·로그인 세션은 공개 저장소에 포함되지 않습니다. 요구 환경은 Node.js 22.x이며 잠금 파일을 사용합니다.

## 로컬 개발

```sh
npm ci
```

`.env.example`을 `.env.local`로 복사하고 자신의 Supabase URL과 publishable key를 설정합니다. 레거시 anon 키도 지원합니다. `NEXT_PUBLIC_` 변수는 브라우저에 공개되므로 서버 비밀키를 설정하지 않습니다. 환경 파일·도구 상태·DB dump·금융자료는 Git 밖에서 관리합니다.

```sh
npm run doctor
npm test
npm run build
npm run dev
```

`doctor`는 네트워크 요청 없이 로컬 의존성과 공개 Supabase 설정을 검사합니다. 자신의 hosted HTTPS URL 또는 로컬 Supabase의 localhost HTTP URL을 사용할 수 있습니다. URL의 계정정보·경로·query와 공개 위치의 secret/service-role 키는 거부합니다. 키·환경 파일 전체·원격 인증정보를 출력하지 않습니다. 설정이 없는 깨끗한 checkout에서는 경고가 정상이며 `--strict`를 추가하면 경고도 실패합니다.

## 새 Supabase와 Google 로그인

1. 다른 설치의 자료가 없는 자신의 Supabase 프로젝트를 만듭니다. `supabase/migrations/`의 SQL을 파일명 오름차순으로 모두 적용합니다. SQL Editor로 적용했다면 파일명과 결과를 자신의 비공개 운영 기록에 남겨 CLI 이력과 중복 실행하지 않게 합니다.
2. 자신의 Google Cloud OAuth 웹 클라이언트를 준비하고 Supabase의 Google provider 설정에 연결합니다. Google의 redirect URI는 해당 Supabase가 제공하는 Auth callback URL을 사용합니다.
3. Supabase Auth의 Site URL과 허용 redirect URL에 본인 앱 주소를 설정합니다. 로컬 callback은 `http://localhost:3000/auth/callback`, 배포 callback은 `https://finance.example.com/auth/callback`과 같은 **자신의 주소**입니다. 배포 예시는 실제 서비스가 아닙니다.
4. 본인이 최초 관리자로 지정할 Google 계정으로 앱에 한 번 로그인합니다. 로그인 성공만으로 관리자가 되지는 않습니다.
5. 해당 Supabase **Authentication → Users**에서 사용자의 UUID를 확인하고 의도한 Google 계정과 직접 대조합니다. [bootstrap_workspace.sql](../supabase/operations/bootstrap_workspace.sql)의 `REPLACE_WITH_INITIAL_ADMIN_AUTH_USER_UUID`를 그 UUID로 바꾼 뒤 같은 프로젝트의 SQL Editor에서 `postgres`로 전체를 실행합니다. 신뢰할 수 없는 브라우저 요청으로 받은 UUID를 사용하지 않습니다.
6. 앱을 새로고침합니다. 빈 대시보드의 **기본 과목 준비하고 사업자 등록** 또는 설정의 **처음 설정하기 → 표준 계정과목 준비**를 실행합니다. 표준 과목·별칭·일반 규칙만 준비되며 가상 사업자·통장·거래는 생성하지 않습니다.
7. **설정 → 사업자·계좌**(`/settings/businesses`)에서 **사업자 추가**, **계좌 추가**로 자신의 자료를 입력합니다. 통장 표시명·은행·끝번호(최대 3자리)·개시일·개시잔액을 확인한 후 거래를 가져옵니다.

bootstrap은 최초 한 번의 신뢰된 DB 작업입니다. 확인된 이메일과 일치하는 verified Google identity가 필요하고, 기존 workspace·관리자·감사 기록이 있거나 다른 소유자의 재무자료·업로드가 있으면 중단합니다. 공개 bootstrap API나 첫 방문자 자동 권한 부여는 없습니다. 브라우저에는 service-role 키를 주지 않습니다.

이후 관리자 초대·해제는 앱의 **설정 → 관리자**에서 수행합니다. 공유 `owner_id`는 첫 관리자의 안정적인 데이터 namespace이며 관리자 변경을 위해 Auth 사용자·원본 소유자를 삭제하거나 일괄 교체하지 않습니다. 한 설치의 관리자들은 같은 공동 재무자료를 관리하므로 서로 다른 조직에는 별도 DB와 배포를 사용합니다.

## 선택 연동

- **거래 시트:** [SHEET_SYNC.md](SHEET_SYNC.md)의 `FINANCE_SHEET_IMPORT_SOURCE`에 자신의 시트 URL과 실제 앱 계좌 UUID를 연결합니다. 기본은 인증된 관리자가 실행하는 신규 거래 추가입니다.
- **사업자간 대여·상환의 Sheets 쓰기:** 자신의 Google 서비스 계정을 만들고 필요한 문서에만 편집 권한을 줍니다. 전체 JSON을 서버 전용 `FINANCE_GOOGLE_SERVICE_ACCOUNT_JSON`에 보관합니다. 앱의 사업자간 현황에서 본인 원본을 연결하고 기준일·사업자·연동 ID를 검토합니다. 공동 DB 저장과 Sheets 기록 결과를 구분하고 쓰기 재시도는 동일 기록을 갱신합니다.
- **Clobe:** [CLOBE.md](CLOBE.md)에 따라 자신의 OAuth 연결과 서버 전용 암호화·서명 키를 준비합니다. Clobe 계정 승인과 Google 앱 로그인은 별개입니다.
- **Toss Payments:** [TOSS.md](TOSS.md)에 따라 자신의 MID·비밀키·수취 계좌를 연결합니다. 정산 조회는 실제 은행 이체를 실행하지 않습니다.
- **예약 시트 동기화:** 선택적인 서버·DB 운영 기능입니다. 기본 수동 가져오기와 변경 정책이 다르므로 [SHEET_SYNC.md](SHEET_SYNC.md)의 제한과 preview를 먼저 검증합니다. 설치만으로 Cron이나 외부 봇이 실행되지는 않습니다.

각 연동의 권한·구독·API 사용 조건은 설치자가 준비합니다. 공개 저장소에 연결정보나 인증된 금융자료가 들어 있지 않습니다.

## 설치별 정책

`lib/finance/installation-policy.ts`는 네 가지 선택 정책을 제공합니다.

| 필드 | 기본값과 의미 |
| --- | --- |
| `benchmarkIndustries` | `[]`; 확인한 사업자 표시명에 P85/J582 참고 업종을 명시적으로 연결 |
| `excludedCashEstimateCategories` | `[]`; 지정 사업자·과목의 미래 지출 추정만 제외, 저장된 실제 거래 유지 |
| `sheetBusinessAliases` | `[]`; 사업자 표시명과 시트 별칭을 명시적으로 연결 |
| `historicalCompletionBefore` | `null`; `과거완료` 과목이 있고 ISO 기준일도 설정한 경우에만 과거 미분류를 완료 처리 |

기본값은 업종·제외·과거 기준일을 추측하지 않습니다. 이 파일은 **클라이언트 번들에 포함**되므로 공개 가능한 비민감 표시명만 사용합니다. 개인별 규칙·급여 대상·이메일·계좌번호·금액·비밀값은 넣지 않습니다. 변경 후 테스트하고 다시 빌드·배포해야 합니다. 사용자별 분류와 실제 계획 편집은 DB에 저장된 기존 기능을 사용합니다.

## 개발과 검증

기능 변경 전 [OPERATING_RULES.md](OPERATING_RULES.md)의 관련 계약을 확인합니다. 원본 보존, 근거 기반 중복 판단, 현재 잔액에서 남은 지출만 차감, 실제·예정 분리, 계속 제외와 버전 충돌 방어를 유지합니다.

`npm test`는 모든 `tests/**/*.test.ts`와 `.test.mjs`를 실행합니다. SQL 테스트는 로컬 PGlite에서 합성 auth·storage와 자료를 사용하며 실제 Supabase에 접속하지 않습니다. 테스트 실행기는 shell의 Supabase 변수를 제거합니다. 변경에 맞는 검증을 추가하되 운영 인증값과 실제 금융 증거를 fixture에 복사하지 않습니다.

`npm run build`는 외부 연동 자격증명 없이 통과해야 합니다. CI는 `main`과 pull request에서 `npm ci`, `doctor`, 테스트와 build를 실행합니다. 설치형 앱의 실제 Google 로그인·연동 승인·권한 거부·동기화·화면 재조회는 설치자가 자신의 테스트 환경에서 별도로 확인합니다. 로컬 테스트 통과를 원격 배포·DB 적용 완료로 보고하지 않습니다.

## 배포와 DB 변경

Node.js 22를 지원하는 호스팅에 배포하고 `.env.example`의 필요한 값을 그 설치의 환경변수에 설정합니다. Vercel을 사용할 수 있지만 특정 팀·프로젝트·계정 연결은 필요하지 않습니다. 로컬 `.vercel`·`.openai` 상태를 공유하지 않습니다.

공개 Supabase 환경값은 빌드 시 반영됩니다. callback·Origin·키가 바뀌면 새 배포와 해당 외부 서비스 설정을 함께 확인합니다. Preview에는 격리된 테스트 DB·키를 사용합니다. 암호화 키 변경 전에는 저장된 연결을 다시 승인할 절차를 준비합니다.

기존 설치의 DB 변경은 백업과 적용 이력을 확인한 후 미적용 마이그레이션만 순서대로 적용합니다. RLS·함수 권한·소유자·서명·충돌 검사를 우회하지 않습니다. 배포 커밋, DB 적용, 호스팅 준비, 실제 사용자 흐름 검증은 각각 기록합니다. 백업에는 원본 업로드와 private 연동 표의 별도 복구 범위도 고려합니다. Clobe 관측 잔액 등 public JSON 백업에 없는 항목은 각 연동 문서를 참고합니다.
