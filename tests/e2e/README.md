# 브라우저 시험 (e2e)

확장을 Playwright 의 Chromium 에 실제로 올리고, Chrome DevTools Protocol(CDP)로 페이지를 조작해 동작을 확인합니다. 외부 패키지 없이 Node 내장 기능(WebSocket, http)만 씁니다.

| 시험 | 항목 | 주요 내용 |
|---|---|---|
| `ssoda/e2e.mjs` | 33 | 가져오기(가져오기 창의 주소 칸으로 OpenAPI YAML 을 받아 컬렉션·{{baseUrl}}·Path Variables, 표의 값을 바꿔 보내면 그 주소로 감, HAR 붙여넣기는 fetch 만), 러너(데이터 파일 CSV 를 화면의 파일 칸으로 넣어 행마다 컬렉션 실행, 앞 요청이 꺼낸 토큰·데이터 값이 뒤 요청에 쓰임, 실패 모음, JUnit 개수, 보고서에 토큰·데이터 값 없음, 히스토리에 안 남음, 실패하면 멈춤), Tests 탭(로그인 응답의 토큰·19자리 ID 를 변수로 꺼내 다음 요청에 씀, 확인 결과·히스토리 표시, 표 조작, 응답을 못 받으면 실행 안 함), JSON Beautify·응답 Pretty 에서 큰 정수 보존, 끝나지 않는 SSE 응답이 다음 요청을 막지 않음, 같은 서버 대기 표시와 타임아웃, 히스토리(보낸 시점 기록, 컬렉션 인증·변수 유지), 백업 복원 확인창, 도우미 업데이트 안내, 설정의 SSH 연결 유지(분)(처음 10분, 0·최대 120분, 켜 둔 도우미 설정에 바로 반영), 다른 서버로 리다이렉트될 때 그 서버 차례를 기다려 헤더가 섞이지 않음(서버가 받은 헤더로 판정), 리다이렉트 메서드·본문(303·307·308·302)과 20번 한도, SSE 받는 중 화면·멈춤·타임아웃·Events 보기, 기본 타임아웃 60초와 예전 설정(0) 옮기기, 비밀 변수(🔒 로 표시하면 값이 보관함으로 옮겨지고 환경 저장값·히스토리·전체 백업·Postman 내보내기에 없음, 서버는 값을 받음, 코드 창·cURL 복사·cURL 탭 미리 보기·자동 헤더·자동완성은 가림, 직접 쓴 Authorization 은 히스토리에서 뺌, Tests 탭이 꺼낸 accessToken 은 비밀로, 비밀번호 암호화 뒤 저장소에 평문 없음·다시 열어도 세션 동안 묻지 않음, 잠근 뒤 보내면 비밀번호를 묻고 틀리면 다시, 환경 복제 시 값을 따로·지우면 정리), 환경 비교(Send ▾ 에서 열어 세 환경에 한꺼번에 보냄, 상태·머리글·JSON 경로 차이와 날짜·요청 ID 머리글 빼기, 목록의 "빼기"·키 이름으로 빼면 다시 견줌, 본문 나란히의 같은 경로 한 행, 차이 복사에서 응답에 되돌아온 비밀 값까지 가림, 기준을 바꾸거나 칩을 빼면 다시 보내지 않고 다시 견줌, 히스토리·변수 그대로, POST 는 묻고 취소하면 안 보냄, 응답을 못 받은 환경은 견주지 못함, 요청 탭에서 고친 내용으로 다시 보냄, 사이드바에서 열어도 열린 요청 탭의 내용으로·탭을 닫으면 저장된 요청으로·이름 바꾸기 따라감), 앱 탭 두 개 |
| `click-guide/e2e.mjs` | 65 | 녹화 대상 탭 한정, 기록 버리기, 이동 단계 스크린샷 가리기, SPA 화면 전환, iframe 좌표·값 전달, AI 로 보내는 내용, 녹화 바(closed shadow root) 조작, 설정값 보정, 속도 진단, 뒤로 가기 캐시, API 키가 웹페이지 쪽 스크립트도 읽는 storage.local 에 없음(예전 키 옮기기, 확장 재시작 뒤 유지), 로컬 파일(file://) 녹화(파일 URL 접근 허용에 따름, 단계 문장·페이지 제목·가이드 이름에 폴더 경로 없음) |
| `click-guide/redact.mjs` | 15 | 공용 가리기 코어(`shared/redact-core.js`)로 스크린샷을 가림. 화면 글자 속 휴대폰·주민번호·이메일·계좌번호는 검정으로 칠하고 비슷한 숫자는 그대로 둠, 클릭한 뒤에 뜬 모달과 클릭과 촬영 사이에 움직인 영역, 클릭하지 않은 다른 출처 iframe 안, shadow root 안(웹 컴포넌트의 닫힌 것 포함), 개인정보 모양의 입력값(`●●●●` 기록과 칸 가리기), 흐리게 설정, 화면 개인정보 자동 가리기 끄기 |
| `click-guide/editor.mjs` | 24 | 편집기 그리기와 단계 다루기, 내보내기를 실제 마우스·키보드 입력으로 확인. 녹화를 끝내면 입력란 클릭 단계를 빼고 입력 단계만 남김, 박스·화살표·번호·글자 그리기와 좌표, Ctrl+Z·Ctrl+Shift+Z·되돌리기 단추, 고른 그림 Delete, 녹화 때 하이라이트 옮기기, 가리기·확대·자르기(자르기로 그림이 밀리지 않음), 겹친 곳 고르는 순서(확대 원본 안쪽은 아래 가림, 테두리는 확대), 내보내기 이미지 픽셀(자른 크기, 박스 테두리 색, 확대 안도 가린 검정), 자르기 해제·Esc, 새로고침 뒤 유지, 닫힌 메뉴·그리기 막대가 실제로 안 보임, 단계 지우기와 알림의 되돌리기(스크린샷까지), ⠿ 끌어서 옮기기, 위 단계와 합치기·나누기·메모와 차례로 되돌리기, 개정 이력 줄 추가·저장, 내보낼 이미지 크기(설정에 남고 그 폭으로 줄임), 편집기에서 내려받은 Word(단계 제목·목차·개정 이력·그림·머리글 로고)와 PowerPoint(표지 + 단계마다 한 장, 로고·머리글·쪽 번호) |
| `click-guide/backup.mjs` | 13 | 확장 ID 고정(manifest `key` → 고정 ID), `key` 를 뺀 이전 버전에서 전체 백업 내려받기 → 새 프로필의 고정 ID 확장으로 가져오기. 가이드·단계·스크린샷 바이트 일치, API 키 제외·유지, 가져온 뒤에도 API 키가 storage.local 에 없음, 손상된 백업 거부, 다시 가져와도 겹치지 않음 |
| `cleanshot-picker/e2e.mjs` | 187 | 가리기 박스가 요소를 따라감(고정·sticky·내부 스크롤·iframe·영역), 캡처 PNG 에 검정이 칠해졌는지 픽셀로 판정, dialog·popover 위 표시, 텍스트 되돌리기, shadow DOM·iframe 안 요소 선택, 대체 저장, 전체 페이지 캡처(문서·안쪽 스크롤 영역, 저장된 PNG 의 세로줄 전체를 문서와 대조, 고정 머리글·바닥글·sticky 한 번씩, 장마다 가리기, `Esc` 로 멈춤, 다른 탭 전환, 긴 페이지 자르기, 확대 150%), 클립보드에 복사(C·한글 ㅊ 키, 막히면 정리 상태를 두고 알림, 클립보드 PNG 크기와 가리기 픽셀, 파일은 만들지 않음), 영역 도구(끈 영역·누른 요소만 -area.png 로, 잘라 낸 그림의 가리기와 영역 표시가 찍히지 않음, Ctrl+Z, 복사도 그 부분만), 강조·스포트라이트(테두리가 요소 바깥에 찍힘, 스포트라이트 바깥만 어둡게, Ctrl+Z, 영역으로 잘라도 테두리 포함), 화살표·번호·글상자(끈 방향의 꼬리·머리, 그냥 누르면 누른 곳을 가리킴, 번호 1·2, 한글 입력 상태의 ㅅ 키로 글상자·Shift+Enter 줄바꿈·Enter 끝, 쓰는 동안 키가 페이지 keydown 에 닿지 않음, 캡처 PNG 픽셀), 그린 것 고르기(강조 테두리를 끌어 옮김·8방향 핸들로 크기·Ctrl+Z 로 다시 요소를 감쌈, 안쪽 클릭은 요소 고르기, 화살표 두 끝 핸들, 방향키·Delete·Esc 는 고르기만, 글상자 다시 쓰기, 옮긴 가리기가 PNG 새 자리에 검정·고른 표시는 안 찍힘), 전체 페이지에 주석(장 이음매에 걸친 강조에 가짜 줄 없음, 아래쪽 번호는 제자리에 한 번, 머리글 안 강조는 첫 장에만, 스포트라이트는 구멍 없는 장도 어둡게), 저장 설정(JPEG·WebP 파일과 그 안의 가리기, 크기 1배·2배와 전체 페이지, 파일 이름 양식·쓸 수 없는 글자, 주소·시각 띠와 주소의 ? 뒤 빼기, 저장 위치 창을 닫으면 저장 안 함, 복사는 늘 PNG, 설정 화면과 툴바 "설정" 단추), 작업 흐름(정리한 것이 있으면 Esc 두 번, 찍고 계속, Space 를 누른 채 페이지 메뉴 열기와 그 메뉴를 Enter 로 찍기, 스크롤 막대 빼기 켬·끔). 화면 배율 1·2 에서 각각 실행 |

## 준비

1. Node 22 이상
2. 확장을 올릴 수 있는 Chromium
   - 일반 Google Chrome(137 이상)은 명령줄로 확장을 올리는 `--load-extension` 을 받지 않아 쓸 수 없습니다.
   - `npx playwright install chromium` 으로 Playwright 의 Chromium 을 내려받으면 시험이 알아서 찾습니다. 저장소에 패키지는 추가하지 않습니다.
   - 다른 곳에 있는 실행 파일을 쓰려면 `CHROMIUM_PATH` 에 경로를 지정합니다.

## 실행

```
npm run test:e2e                          # 전부 차례로 (이 PC 에서 약 5분)
node tests/e2e/run.mjs ssoda              # 하나만 (ssoda / click-guide / cleanshot-picker)
node tests/e2e/click-guide/e2e.mjs --only=tabs,discard   # 구역 일부만
```

하나라도 실패하면 종료 코드 1 로 끝납니다. 브라우저 프로필·다운로드·시험용 확장 사본은 OS 임시 폴더에 만들고, 끝나면 지웁니다.

| 환경 변수 | 뜻 |
|---|---|
| `CHROMIUM_PATH` | 쓸 Chromium 실행 파일 |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright 브라우저를 기본 위치가 아닌 곳에 설치했을 때 그 폴더 |
| `SSODA_EXT`, `CG_EXT`, `CLEANSHOT_EXT` | 저장소 폴더 대신 시험할 확장 폴더 (예: 수정 전 버전을 풀어 둔 폴더와 비교) |
| `DPR` | cleanshot-picker 를 실행할 화면 배율 (기본 1) |
| `ONLY` | cleanshot-picker 에서 실행할 구역 (쉼표로 구분). `ONLY=screens` 는 눈으로 볼 화면만 임시 폴더에 저장 |
| `CDP_PORT` | 브라우저 디버깅 포트 |

- click-guide 는 `--headed` 를 붙이면 창을 띄워 실행합니다. `--only=` 구역: `tabs` `iframe` `spa` `navredact` `discard` `width` `speed` `editor` `bar` `bfcache` `apikey` `file`
  - `file` 구역은 chrome://extensions 에서 "파일 URL에 대한 액세스 허용"을 껐다 켜며 확장을 두 번 다시 시작하므로 맨 끝에 돕니다.
- cleanshot-picker 의 `ONLY` 구역: `overlay` `fixedScroll` `stickyScroll` `layoutShift` `innerScroll` `regionDoc` `iframeText` `zoom` `regions` `picking` `iframeMask` `textUndo` `dialog` `popoverBurn` `fallback` `clipboard` `region` `notes` `annotate` `grab` `output` `outputFull` `optionsPage` `workflow` `fullCapture` `fullPageDoc` `fullPagePanel` `fullPageNotes` `fullPageCancel` `fullPageSwitchSim` `fullPageSwitch` `fullPageTruncate` `fullPageZoom` `timing` `screens`
  - `fullCapture` 는 가리기 여러 개를 보이는 화면 한 장으로 찍는 시험이고, 전체 페이지 캡처는 `fullPage…` 구역입니다. 시험 페이지는 `site/full.html`(문서 스크롤, `?bands=N` 으로 길이 조절)과 `site/panel.html`(안쪽 영역만 스크롤)입니다.

## 알아 둘 점

- 쓰는 포트: 브라우저 디버깅 9301(click-guide, 네 시험이 차례로 씀)·9302(cleanshot-picker)·9303(ssoda), 시험용 웹 서버 18931·18932(click-guide)·8930(cleanshot-picker). ssoda 는 빈 포트를 골라 씁니다.
- cleanshot-picker 는 아이콘을 눌러야 생기는 activeTab 권한을 CDP 로 줄 수 없습니다. 그래서 manifest 에 `host_permissions` 만 더한 시험용 사본을 임시 폴더에 만들어 올립니다. 코드는 같습니다.
- ssoda 시험은 브라우저 전송 경로만 확인합니다. PC 의 curl·cURL 실행 도우미·SSH 터널 경로는 [tests/ssoda-helper](../ssoda-helper/README.md) 의 시험(`npm run test:helper`)이 확인합니다.
- Windows 11 과 Playwright Chromium 131(headless)에서 확인했습니다. 다른 OS 와 실제 Chrome·Edge 에서 아이콘을 눌러 보는 확인은 하지 않았습니다.
