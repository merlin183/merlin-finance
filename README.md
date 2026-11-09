# Merlin Finance · 멀린 자금관리

여러 사업자의 통장 거래, 현재 잔액, 지출 실적과 남은 예산을 함께 관리하는 한국어 웹앱입니다. Next.js, React, Supabase를 사용하며 각 설치자가 자신의 데이터베이스와 외부 서비스 계정을 연결합니다. 은행 이체나 실제 세금 납부를 실행하지 않습니다.

## 주요 기능

- XLSX/XLS/CSV 및 Google Sheets 거래 가져오기, 원본 보존과 중복·충돌 검사
- 계정과목 검색, 개별·일괄 분류, 사용자 규칙, 거래처 메모와 이체 수수료 분리
- 사업자·계좌별 잔액, 거래 달력, 통합분석과 월간 보고
- 현재 잔액과 남은 지출에 따른 가용자금·필요자금 계산, 실제 출금과 예정 달력
- 월 반복 고정비, 종료월이 있는 할부, 카드대금, 세금 일정과 계속 제외 설정
- 사업자간 대여·상환 공동 기록, 선택적인 Google Sheets 동기화
- Google 로그인과 관리자 초대·해제, RLS와 버전 충돌 검사
- 선택적인 Clobe 통장·잔액·카드 청구 연결과 Toss Payments 정산 조회
- 전 탭의 금액·비율·계좌번호·차트 숨기기와 브라우저별 표시 설정 유지

## 공개 범위

앱 코드, DB 마이그레이션, 합성 테스트, 설치·개발 문서를 제공합니다. 기존 설치의 재무자료, 개인별 분류·급여 규칙, 관리자 명부, 로그인 세션, 운영 계정·프로젝트 설정과 비밀키는 포함하지 않습니다. 저장소를 내려받아도 다른 설치의 자료나 서비스 권한이 주어지지 않습니다. 초기 DB에는 사업자·계좌·거래 샘플이 자동 생성되지 않습니다.

## 금액 숨기기

상단 **금액 표시 ON/OFF**로 사업자·계좌별 금액, 비율, 차트, 팝업과 금융정보가 있는 알림을 함께 가립니다. 여러 구간으로 나뉜 계좌번호도 전체를 가리고 날짜·거래 건수·품목은 읽을 수 있게 유지합니다. 숨긴 금액 입력란과 금융 메모는 읽기 전용으로 표시하며, 다시 켜면 기존 입력값을 이어서 수정합니다.

표시 설정은 같은 브라우저의 탭과 새로고침에 유지합니다. 저장된 설정을 읽기 전에는 금액을 가려 OFF 상태에서 초기 화면에 원문이 노출되지 않도록 합니다. 이 기능은 화면 공유와 주변 시선을 위한 표시 보호입니다. 실제 자료와 내보내기 파일의 접근은 기존 관리자 인증·DB 권한으로 관리합니다. 변경 내용은 [버전 기록](CHANGELOG.md)에서 확인합니다.

## 설치

Node.js **22.x**, npm과 Git을 준비하고 이 저장소를 clone하거나 다운로드합니다.

```sh
git clone https://github.com/merlin183/merlin-finance.git
cd merlin-finance
npm ci
```

`.env.example`을 `.env.local`로 복사하고 **자신의 Supabase 프로젝트**의 URL과 publishable key를 설정합니다. service-role 키는 사용하지 않습니다. 선택 연동은 비워 두어도 됩니다.

```sh
npm run doctor
npm test
npm run build
npm run dev
```

앱은 [localhost:3000](http://localhost:3000)에서 열립니다. `doctor`는 로컬 설치와 공개 설정의 형식을 검사하며 인증값을 출력하거나 외부 서비스에 연결하지 않습니다. 설정하지 않은 항목은 경고로 알리고, 잘못된 URL이나 공개 변수의 비밀키는 오류로 처리합니다. `npm run doctor -- --strict`는 경고도 실패로 처리합니다.

### 빈 DB와 최초 관리자

1. 자신의 빈 Supabase 프로젝트에 `supabase/migrations/*.sql`을 **파일명 순서대로 모두** 적용합니다. 기존 설치는 미적용 파일만 적용합니다.
2. 자신의 Google OAuth 클라이언트와 Supabase Google provider를 설정합니다. Google의 승인된 redirect URI는 Supabase가 안내하는 Auth callback이며, Supabase의 허용 redirect URL에는 앱의 `http://localhost:3000/auth/callback` 및 배포 주소의 `/auth/callback`을 등록합니다.
3. 앱에서 최초 관리자로 사용할 Google 계정으로 한 번 로그인합니다. 이 단계에서는 아직 재무자료 접근 권한이 없습니다.
4. **자신의 Supabase → Authentication → Users**에서 그 사용자의 UUID와 확인된 Google 계정을 직접 대조합니다. [bootstrap_workspace.sql](supabase/operations/bootstrap_workspace.sql)의 `REPLACE_WITH_INITIAL_ADMIN_AUTH_USER_UUID`를 그 UUID로 바꾼 뒤, 해당 프로젝트의 신뢰된 SQL Editor에서 `postgres`로 파일 전체를 실행합니다.
5. 앱을 새로고침하고 **기본 과목 준비하고 사업자 등록**을 누릅니다. 표준 계정과목만 준비하며 `/settings/businesses`에서 자신의 사업자와 계좌를 등록합니다. 설정을 먼저 열었다면 **처음 설정하기 → 표준 계정과목 준비**를 사용합니다.

첫 로그인 사용자를 자동 관리자로 만들거나 브라우저에서 bootstrap RPC를 호출하는 경로는 없습니다. bootstrap은 확인된 Google identity·이메일을 검사하고 초기화 재실행이나 다른 소유자의 자료·업로드가 있으면 거부합니다. 이후 관리자는 **설정 → 관리자**에서 초대합니다. 저장소·배포 권한과 앱 관리자 권한은 별개입니다. 상세 절차는 [개발 가이드](docs/DEVELOPMENT.md)에 있습니다.

## 선택 연동과 설치별 정책

| 연결 | 설치자가 준비할 것 | 안내 |
| --- | --- | --- |
| Google Sheets 거래 가져오기 | 읽을 수 있는 자신의 시트와 앱 계좌 연결 | [시트 연동](docs/SHEET_SYNC.md) |
| 사업자간 기록의 Sheets 쓰기 | 해당 문서에 권한을 준 자신의 Google 서비스 계정 | [개발 가이드](docs/DEVELOPMENT.md#선택-연동) |
| Clobe | 자신의 Clobe 계정 승인, 서버 암호화·서명 키와 callback URL | [Clobe](docs/CLOBE.md) |
| Toss Payments | 자신의 MID·라이브 시크릿 키, 사업자·수취 계좌 매핑 | [Toss](docs/TOSS.md) |

[설치별 정책 파일](lib/finance/installation-policy.ts)의 업종 비교, 추정 제외, 시트 사업자 별칭과 과거완료 기준일은 기본값이 비어 있습니다. 필요한 설치만 명시적으로 설정하고 다시 빌드합니다. 이 파일은 클라이언트 번들에 포함되므로 **공개해도 되는 표시명만** 사용하고 개인정보·계좌번호·비밀값을 넣지 않습니다.

## 가상 자료로 확인하기

별도의 테스트 설치에서 `예시 사업자 A`, `테스트 통장`을 만들고 [합성 CSV 예시와 사용법](examples/README.md)을 따라 거래를 업로드할 수 있습니다. 예시의 금액과 거래처는 가상 자료입니다. 업로드 미리보기에서 날짜·금액·입출금·잔액을 확인한 뒤 적용합니다.

자동 테스트는 합성 자료와 로컬 PGlite를 사용하며 실제 Supabase·Clobe·은행·Toss에 테스트 자료를 만들지 않습니다. 설치 확인을 위해 자신의 운영 금융자료를 공개 issue나 fixture에 첨부하지 마세요.

## 개발과 라이선스

[운영·계산 계약](docs/OPERATING_RULES.md), [개발 가이드](docs/DEVELOPMENT.md), [기여 안내](CONTRIBUTING.md), [보안 제보](SECURITY.md)를 참고하세요. 변경 후 관련 테스트와 `npm test`, `npm run doctor`, `npm run build`를 확인합니다. CI는 `main` push와 pull request에서 같은 검증을 실행합니다.

공개판의 독립 변경을 보존하며 공통 기능을 가져오는 절차와 한계는 [업스트림 동기화 안내](docs/UPSTREAM_SYNC.md)를 참고하세요.

프로젝트 자체 코드는 [MIT](LICENSE)로 제공합니다. 의존성과 포함된 외부 코드는 각자의 라이선스를 유지합니다. [서드파티 고지](THIRD_PARTY_NOTICES.md)와 [잠금 파일 기준 의존성 목록](docs/DEPENDENCY_LICENSES.md)을 함께 확인하세요.
