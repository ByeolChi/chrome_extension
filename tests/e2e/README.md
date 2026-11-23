# 브라우저 시험 (e2e)

확장을 Playwright 의 Chromium 에 실제로 올리고, Chrome DevTools Protocol(CDP)로 페이지를 조작해 동작을 확인합니다. 외부 패키지 없이 Node 내장 기능(WebSocket, http)만 씁니다.

| 시험 | 항목 | 주요 내용 |
|---|---|---|
| `ssoda/e2e.mjs` | 11 | JSON Beautify·응답 Pretty 에서 큰 정수 보존, 끝나지 않는 SSE 응답이 다음 요청을 막지 않음, 같은 서버 대기 표시와 타임아웃, 히스토리(보낸 시점 기록, 컬렉션 인증·변수 유지), 백업 복원 확인창, 도우미 업데이트 안내, 리다이렉트 헤더 섞임 경고, 앱 탭 두 개 |
| `click-guide/e2e.mjs` | 52 | 녹화 대상 탭 한정, 기록 버리기, 이동 단계 스크린샷 가리기, SPA 화면 전환, iframe 좌표·값 전달, AI 로 보내는 내용, 녹화 바(closed shadow root) 조작, 설정값 보정, 속도 진단, 뒤로 가기 캐시 |
| `cleanshot-picker/e2e.mjs` | 69 | 가리기 박스가 요소를 따라감(고정·sticky·내부 스크롤·iframe·영역), 캡처 PNG 에 검정이 칠해졌는지 픽셀로 판정, dialog·popover 위 표시, 텍스트 되돌리기, shadow DOM·iframe 안 요소 선택, 대체 저장. 화면 배율 1·2 에서 각각 실행 |

## 준비

1. Node 22 이상
2. 확장을 올릴 수 있는 Chromium
   - 일반 Google Chrome(137 이상)은 명령줄로 확장을 올리는 `--load-extension` 을 받지 않아 쓸 수 없습니다.
   - `npx playwright install chromium` 으로 Playwright 의 Chromium 을 내려받으면 시험이 알아서 찾습니다. 저장소에 패키지는 추가하지 않습니다.
   - 다른 곳에 있는 실행 파일을 쓰려면 `CHROMIUM_PATH` 에 경로를 지정합니다.

## 실행

```
npm run test:e2e                          # 전부 차례로 (이 PC 에서 약 3분)
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

- click-guide 는 `--headed` 를 붙이면 창을 띄워 실행합니다. `--only=` 구역: `tabs` `iframe` `spa` `navredact` `discard` `width` `speed` `editor` `bar` `bfcache`
- cleanshot-picker 의 `ONLY` 구역: `overlay` `fixedScroll` `stickyScroll` `layoutShift` `innerScroll` `regionDoc` `iframeText` `zoom` `regions` `picking` `iframeMask` `textUndo` `dialog` `popoverBurn` `fallback` `fullCapture` `timing` `screens`

## 알아 둘 점

- 쓰는 포트: 브라우저 디버깅 9301(click-guide)·9302(cleanshot-picker)·9303(ssoda), 시험용 웹 서버 18931·18932(click-guide)·8930(cleanshot-picker). ssoda 는 빈 포트를 골라 씁니다.
- cleanshot-picker 는 아이콘을 눌러야 생기는 activeTab 권한을 CDP 로 줄 수 없습니다. 그래서 manifest 에 `host_permissions` 만 더한 시험용 사본을 임시 폴더에 만들어 올립니다. 코드는 같습니다.
- ssoda 시험은 브라우저 전송 경로만 확인합니다. PC 의 curl·cURL 실행 도우미·SSH 터널 경로는 이 시험에 들어 있지 않습니다.
- Windows 11 과 Playwright Chromium 131(headless)에서 확인했습니다. 다른 OS 와 실제 Chrome·Edge 에서 아이콘을 눌러 보는 확인은 하지 않았습니다.
