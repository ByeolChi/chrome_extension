# Chrome Extensions

직접 만든 Chrome 확장 프로그램 모음입니다. 각 폴더가 독립된 확장 프로그램이며, 폴더마다 자세한 사용법이 담긴 README가 있습니다.

| 폴더 | 이름 | 버전 | 설명 |
| --- | --- | --- | --- |
| [`cleanshot-picker`](./cleanshot-picker) | CleanShot Picker | 1.2.0 | 웹페이지의 임시 요소를 클릭으로 지우고 현재 화면이나 페이지 전체를 PNG로 캡처 |
| [`click-guide`](./click-guide) | ClickGuide | 0.3.1 | 클릭·입력 과정을 자동 캡처해 단계별 매뉴얼 생성 |
| [`jira-weekly-report`](./jira-weekly-report) | Jira 주간보고 생성기 | 1.0.0 | 이번 주 Jira 스프린트 작업·진척률을 주간보고 양식으로 정리 |
| [`ssoda`](./ssoda) | Ssoda (쏘다) - API Client | 1.7.0 | cURL을 붙여넣어 바로 호출하고 컬렉션으로 저장하는 API 클라이언트 |

## 설치 (공통)

1. 이 저장소를 내려받습니다. (`git clone` 또는 **Code → Download ZIP**)
2. Chrome 주소창에 `chrome://extensions` 를 입력합니다.
3. 오른쪽 위 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누르고, 설치할 확장 프로그램 폴더(`manifest.json`이 들어 있는 폴더)를 선택합니다.

확장 프로그램별 권한, 설정, 사용법은 각 폴더의 README를 참고하세요.

망분리 PC나 회사가 정책으로 관리하는 PC에 배포하려면 [docs/airgap-deploy.md](docs/airgap-deploy.md) 를 보세요. 개발자 모드를 쓸 수 없는 PC에 정책으로 설치하는 방법, 확장 ID 표, Ssoda 도우미를 PC 전체에 등록하는 방법이 있습니다.

## 개발

- **테스트**: 저장소 최상위에서 `npm test` (Node 22 이상, 설치할 패키지 없음). `tests/` 의 단위 테스트가 각 확장의 실제 모듈을 그대로 불러와 확인합니다.
- **브라우저 시험**: `npm run test:e2e` (약 5분). 확장을 Playwright 의 Chromium 에 실제로 올려 확인합니다. 준비와 시험 내용은 [tests/e2e/README.md](tests/e2e/README.md) 를 보세요.
- **ssoda 도우미 시험**: `npm run test:helper`. cURL 실행 도우미를 실제 curl·ssh 와 함께 직접 실행해 보안 검사, SSH 터널, PC 전체 등록 스크립트를 확인합니다. 준비는 [tests/ssoda-helper/README.md](tests/ssoda-helper/README.md) 를 보세요.
- **공용 코드**: `shared/redact-core.js`(가리기 코어)는 CleanShot Picker 와 ClickGuide 가 함께 씁니다. 확장은 폴더째 로드하므로 각 확장 폴더에 사본을 두는데, 원본을 고친 뒤 `node scripts/sync-shared.mjs` 로 복사합니다. 사본이 원본과 다르면 `npm test` 가 실패합니다.
- **배포 zip**: `pwsh scripts/build-zip.ps1 -Extension <폴더 이름>` (Windows PowerShell 5.1 도 가능). `-Bump patch` 를 붙이면 manifest 와 위 표의 버전을 함께 올립니다. manifest 에 `key`(확장 ID 고정)가 없는 확장은 `-AllowNoKey` 가 있어야 만듭니다.
