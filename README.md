# Chrome Extensions

직접 만든 Chrome 확장 프로그램 모음입니다. 각 폴더가 독립된 확장 프로그램이며, 폴더마다 자세한 사용법이 담긴 README가 있습니다.

| 폴더 | 이름 | 버전 | 설명 |
| --- | --- | --- | --- |
| [`cleanshot-picker`](./cleanshot-picker) | CleanShot Picker | 1.0.0 | 웹페이지의 임시 요소를 클릭으로 지우고 현재 화면을 PNG로 캡처 |
| [`click-guide`](./click-guide) | ClickGuide | 0.1.7 | 클릭·입력 과정을 자동 캡처해 단계별 매뉴얼 생성 |
| [`jira-weekly-report`](./jira-weekly-report) | Jira 주간보고 생성기 | 1.0.0 | 이번 주 Jira 스프린트 작업·진척률을 주간보고 양식으로 정리 |
| [`ssoda`](./ssoda) | Ssoda (쏘다) - API Client | 1.2.1 | cURL을 붙여넣어 바로 호출하고 컬렉션으로 저장하는 API 클라이언트 |

## 설치 (공통)

1. 이 저장소를 내려받습니다. (`git clone` 또는 **Code → Download ZIP**)
2. Chrome 주소창에 `chrome://extensions` 를 입력합니다.
3. 오른쪽 위 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누르고, 설치할 확장 프로그램 폴더(`manifest.json`이 들어 있는 폴더)를 선택합니다.

확장 프로그램별 권한, 설정, 사용법은 각 폴더의 README를 참고하세요.
