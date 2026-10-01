# Ssoda (쏘다) — API를 쏘는 Chrome 확장 프로그램

cURL 명령을 붙여넣어 바로 호출하고, **헤더 · 쿠키 · 파라미터 · Body · 인증**을 설정해 테스트한 뒤 **컬렉션으로 저장**해 다시 쓰는 Chrome 확장 프로그램입니다.

---

## 설치 방법 (압축 해제 확장 프로그램 로드)

1. `ssoda.zip` 파일의 압축을 풉니다. 폴더 안에 `manifest.json`이 바로 보여야 합니다.
2. Chrome 주소창에 `chrome://extensions` 를 입력합니다.
3. 오른쪽 위 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누르고, 압축을 푼 `ssoda` 폴더를 선택합니다.
5. 툴바의 퍼즐 아이콘에서 **Ssoda** 옆 핀 아이콘을 눌러 고정합니다.
6. 아이콘을 클릭하거나 단축키 **Alt + Shift + U** 를 누르면 전용 탭이 열립니다.

### 이전 버전(cURL Studio)을 쓰고 있었다면
- **저장된 데이터 유지**: 컬렉션·환경·히스토리는 확장 프로그램 ID에 묶여 있습니다. ID를 그대로 유지하려면 두 방법 중 하나를 쓰세요.
  - 새 파일을 **기존 폴더에 덮어쓰기** 한 뒤 `chrome://extensions` 에서 새로고침(⟳)을 누릅니다.
  - 또는 이전 버전의 **설정 → 전체 백업 내보내기** 로 백업하고, 새 버전에서 **백업에서 복원** 합니다. 예전 백업 파일도 그대로 불러올 수 있습니다.
- **cURL 실행 도우미**: 도우미 이름이 `com.ssoda.runner` 로 바뀌었습니다. cURL 탭에서 설치 파일을 다시 받아 한 번 실행하세요. 예전 도우미는 설치할 때 자동으로 정리됩니다.

> Chrome 116 이상이 필요합니다. Edge, Whale 같은 Chromium 기반 브라우저에서도 같은 방법으로 설치할 수 있습니다.
> 폴더를 옮기거나 지우면 확장 프로그램이 사라지므로 고정된 위치에 두세요.

---

## 주요 기능

### cURL 호출
- **URL 입력창에 cURL 명령 붙여넣기** → 메소드, URL, 헤더, 쿠키, Body, 인증이 자동으로 채워집니다.
- 첫 화면의 **cURL 바로 실행** 상자에 붙여넣고 `Ctrl + Enter` 를 누르면 즉시 호출합니다.
- 웹페이지(API 문서 등)에서 cURL 명령을 드래그로 선택한 뒤 **우클릭 → "Ssoda로 열기"** 로 바로 가져옵니다.
- 지원 형식:
  - Chrome 개발자도구의 **Copy as cURL (bash)** 와 **Copy as cURL (cmd)**
  - `$'...'` 문자열, 여러 줄로 이어 쓴 `\` 줄바꿈, PowerShell의 `` ` `` 줄바꿈
- 지원 옵션: `-X` `-H` `-d` `--data-raw` `--data-binary` `--data-urlencode` `--json` `-F` `-b` `-u` `-A` `-e` `-G` `-I` `-L` `-m` `--oauth2-bearer` `--url`, 그리고 `-sSL` 같은 묶음 옵션
- 현재 요청을 **cURL로 복사**할 수 있습니다 (탭 우클릭 또는 Save ▾ 메뉴).

### 실제 curl 로 실행 (v1.1)
브라우저 대신 **PC에 설치된 curl** 로 요청을 실행할 수 있습니다. 터미널에서 curl 을 실행한 것과 결과가 같습니다.

- **Send 옆 ▾** 에서 실행 방식을 고릅니다: `브라우저로 보내기` / `cURL로 실행`. 이 선택은 요청마다 저장됩니다. `이번만 …` 메뉴는 이번 한 번만 다른 방식으로 실행합니다.
- **cURL 탭**:
  - 실행 방식을 바꿉니다.
  - 추가 옵션을 켭니다: `-v (Verbose)`, `-k (SSL 무시)`, `-s (Silent)`, `-i (Response 헤더 포함)`, `--compressed`, `-L`, HTTP 버전.
  - 추가 인자를 넣습니다. 예: `--proxy`, `--resolve`, `--cacert`
  - 생성된 명령어를 바로 확인하고 복사하거나 실행합니다.
- **명령어 형식**: `bash` (Linux·macOS·Git Bash) 또는 `Windows cmd`. `줄바꿈으로 정렬` 도 켜고 끌 수 있습니다.
- **응답 패널**: curl 로 실행한 결과는 `Terminal` 탭에 나옵니다. 실행한 명령과 `-v` 상세 출력, `-i` 헤더, 본문, 종료 코드가 터미널과 같은 모양으로 표시됩니다. 응답 시간은 DNS·연결·TLS·서버 대기·다운로드로 나눠서 보여줍니다.
- **브라우저로는 안 되는 것**도 curl 실행에서는 됩니다:
  - `-k` 로 자체 서명 인증서 서버 호출
  - 프록시, `--resolve`
  - Body 가 있는 GET
  - curl 의 기본 헤더 그대로 전송 (`User-Agent: curl/x.y`)
- 붙여넣은 cURL 명령의 `-k -v -i -s --compressed --proxy --resolve …` 옵션도 cURL 탭에 그대로 옮겨집니다.

#### cURL 실행 도우미 설치 (한 번만)
크롬 확장 프로그램은 보안상 PC 프로그램을 직접 실행할 수 없습니다. 그래서 Chrome 공식 기능인 **Native Messaging** 으로 이 확장 프로그램만 호출할 수 있는 작은 도우미를 설치해야 합니다.

1. **cURL 탭 → 설치하기**, 또는 **Send ▾ → cURL 실행 도우미 설정** 에서 **설치 파일 다운로드** 를 누릅니다.
   - 파일에 이 확장 프로그램의 ID가 들어 있습니다.
2. **Windows**: 받은 `ssoda-helper-install.bat` 파일을 더블클릭합니다.
   - 관리자 권한은 필요 없습니다.
   - "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행** 을 누릅니다.
   - Windows 10(1803 이상)과 11에 기본으로 들어 있는 `curl.exe` 를 사용합니다.
   - 설치 위치: `%LOCALAPPDATA%\Ssoda\helper`
   - 레지스트리 등록 위치: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ssoda.runner`. Edge·Whale·Brave 에도 함께 등록합니다.
3. **macOS / Linux**: `bash ~/Downloads/ssoda-helper-install.sh` 를 실행합니다 (python3 필요).
4. 도우미 창에서 **연결 확인** 을 누릅니다. 브라우저를 다시 시작할 필요는 없습니다.

제거하려면 같은 창에서 **제거 파일 다운로드** 를 받아 실행하세요.

- 확장 프로그램 폴더를 옮기거나 다시 설치하면 ID가 바뀝니다. 이때는 설치 파일을 다시 받아 실행해야 합니다.
- 회사 PC에서 PowerShell 실행이 정책으로 막혀 있으면 도우미가 동작하지 않을 수 있습니다.
- 도우미는 요청할 때마다 PowerShell 을 새로 띄웁니다. 그래서 curl 실행은 브라우저 전송보다 0.3~1초 정도 더 걸릴 수 있습니다.

### 요청 편집
| 탭 | 내용 |
|---|---|
| Params | 쿼리 파라미터 표 (URL과 양방향 동기화, 체크박스로 끄고 켜기, Bulk Edit) |
| Authorization | Inherit(상위 상속) / No Auth / Bearer Token / Basic Auth / API Key (헤더 또는 쿼리) |
| Headers | 헤더 표, 헤더 이름·값 자동완성, Bulk Edit, **자동 헤더 보기**(인증/Body/쿠키로 추가되는 헤더) |
| Body | none / form-data(파일 업로드) / x-www-form-urlencoded / raw(JSON·Text·JavaScript·HTML·XML, 강조·Beautify) / binary |
| Cookies | 요청별 쿠키 표, **Chrome 쿠키 가져오기**, 쿠키 관리자 쿠키 / Chrome 로그인 쿠키 함께 보내기 옵션, 실제 전송될 Cookie 헤더 미리보기 |
| cURL | 실행 방식(브라우저/curl), -v -k -s -i --compressed -L HTTP 버전, 추가 인자, 명령어 미리보기(bash/cmd, 줄바꿈 정렬), 복사/실행 |
| Settings | 리다이렉트 따라가기(-L), 타임아웃(--max-time), 설명 |

- **Cookie, Origin, Referer, User-Agent** 처럼 일반 웹페이지에서는 바꿀 수 없는 헤더도 그대로 전송합니다.
- 기본값은 curl처럼 **Origin 헤더를 보내지 않습니다**. 설정에서 바꿀 수 있습니다.
- 브라우저 확장 권한으로 호출하므로 **CORS 제약 없이** 어떤 서버든 호출할 수 있습니다.

### 응답 보기
- 상태 코드, 응답 시간(대기/다운로드 분리), 크기
- **Body**: Pretty(JSON·XML·HTML 강조), Raw, Preview(HTML 렌더링, 이미지, PDF), 줄바꿈, 복사, 파일로 저장
- **Cookies**: 응답 `Set-Cookie` 목록
- **Headers**: `Set-Cookie`를 포함한 원본 응답 헤더
- **Timeline**: 실제로 전송된 요청 헤더, 리다이렉트 경로, 원격 IP 등 `curl -v`와 비슷한 상세 정보
- 네트워크 오류(DNS 실패, 연결 거부, 인증서 오류 등)는 원인과 해결 방법을 한국어로 안내합니다.

### 저장과 재사용
- **컬렉션 / 폴더**로 요청을 저장합니다 (`Ctrl + S`). 드래그 앤 드롭으로 정렬하고, 이름 변경·복제·삭제할 수 있습니다.
- **환경 변수**: dev / staging / prod 같은 환경을 만들고 오른쪽 위에서 전환합니다. `{{baseUrl}}`, `{{token}}` 처럼 사용합니다.
  - 우선순위: 환경 > 컬렉션 변수 > 글로벌
  - `{{`를 입력하면 변수 자동완성이 뜹니다. 정의된 변수는 주황색, 없는 변수는 빨간색으로 표시됩니다.
  - 동적 변수: `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$guid}}`, `{{$randomInt}}`, `{{$randomEmail}}` 등
- **컬렉션 인증 / 변수**: 컬렉션·폴더에 인증을 설정하면 "Inherit" 요청이 자동으로 사용합니다.
- **히스토리**: 보낸 요청이 날짜별로 자동 기록되고, 클릭하면 다시 열립니다.
- **쿠키 관리자 (Cookie Jar)**: 응답의 `Set-Cookie`를 자동 저장해 같은 도메인 요청에 자동으로 보냅니다. Chrome에 저장된 쿠키와는 분리되어 있습니다.
- **요청 탭**: 여러 요청을 탭으로 열어 두고 작업합니다. 변경사항 표시(●), 닫을 때 저장 확인, 새로고침 후에도 탭이 복원됩니다.

### 코드 내보내기
오른쪽 `</>` 버튼을 누르면 현재 요청을 다음 코드로 보여줍니다. 변수·인증·쿠키가 적용된 상태입니다.
- cURL
- JavaScript Fetch
- Node.js Axios
- Python Requests
- HTTPie
- PowerShell
- Go

### 컬렉션 가져오기 · 내보내기
- **가져오기**: Postman Collection v2.0 / v2.1, Postman Environment, Globals (JSON 붙여넣기 또는 파일 드래그)
- **내보내기**: 컬렉션 → Postman Collection v2.1, 환경 → Postman Environment
- 설정 → **전체 백업 내보내기 / 백업에서 복원** (컬렉션, 환경, 히스토리, 쿠키, 설정 전체)

---

## 단축키

| 키 | 동작 |
|---|---|
| `Ctrl + Enter` | 요청 보내기 (URL 입력창에서는 `Enter`) |
| `Ctrl + S` / `Ctrl + Shift + S` | 저장 / 다른 이름으로 저장 |
| `Alt + N` / `Alt + W` | 새 요청 탭 / 탭 닫기 |
| `Alt + ← / →` | 이전 / 다음 탭 |
| `Alt + I` | 가져오기 |
| `Ctrl + K` | 요청 검색 |
| `Alt + Shift + U` | Ssoda 열기 (`chrome://extensions/shortcuts`에서 변경) |

macOS에서는 `Ctrl` 대신 `⌘` 를 사용합니다.

---

## 알아두면 좋은 점 (브라우저 제약)

- 브라우저 전송에서는 **GET / HEAD 요청에 Body를 보낼 수 없습니다.** cURL로 실행하면 보낼 수 있습니다.
- 브라우저 전송에서는 `-k / --insecure` 를 적용할 수 없습니다. **cURL로 실행**하면 적용됩니다.
- `Host`, `Content-Length`, `Connection` 헤더는 브라우저가 직접 관리하므로 바꿀 수 없습니다.
- 브라우저가 `Accept-Language`, `Sec-Fetch-*`, `sec-ch-ua` 헤더를 자동으로 추가합니다 (Timeline 탭에서 확인).
- 같은 서버로 보내는 요청은 헤더 규칙이 섞이지 않도록 **한 번에 하나씩** 처리합니다.
- 파일을 참조하는 cURL 옵션(`-d @file`, `-F file=@path`, `-T`)은 가져온 뒤 Body 탭에서 파일을 다시 선택해야 합니다.
- Pre-request / Test 스크립트는 지원하지 않습니다. 확장 프로그램 보안 정책상 임의 코드를 실행할 수 없습니다.
- 모든 데이터는 이 브라우저의 `chrome.storage.local` 에만 저장되고, 외부로 전송되지 않습니다.

---

## 권한 설명

| 권한 | 용도 |
|---|---|
| `<all_urls>` (호스트 권한) | 모든 서버에 CORS 제약 없이 요청 |
| `declarativeNetRequestWithHostAccess` | Cookie / Origin / Referer / User-Agent 헤더 설정 (이 확장이 보내는 요청에만 적용) |
| `webRequest` | 실제 전송된 헤더, `Set-Cookie`, 리다이렉트, 네트워크 오류 확인 (읽기 전용) |
| `cookies` | "Chrome 쿠키 가져오기 / 함께 보내기" 기능 |
| `storage`, `unlimitedStorage` | 컬렉션·환경·히스토리 저장 |
| `contextMenus` | 우클릭 "Ssoda로 열기" |
| `nativeMessaging` | 설치한 도우미를 통해 PC의 curl 실행 (도우미를 설치하지 않으면 사용되지 않음) |

---

## 폴더 구조

```
ssoda/
├─ manifest.json        확장 프로그램 설정 (Manifest V3)
├─ background.js        아이콘 클릭 → 앱 탭 열기, 우클릭 메뉴
├─ app.html             앱 화면
├─ css/app.css          테마 (라이트/다크)
├─ icons/               아이콘
├─ native-host/         cURL 실행 도우미 (Windows PowerShell / macOS·Linux Python) 와 설치 스크립트 템플릿
└─ js/
   ├─ main.js           레이아웃, 탭 바, 단축키
   ├─ app.js            탭·저장·전송·컬렉션·환경·히스토리 관리
   ├─ http.js           요청 전송 엔진 (fetch + 헤더 규칙 + webRequest 캡처)
   ├─ curl-runner.js    실제 curl 실행 엔진 (Native Messaging)
   ├─ helper-installer.js  도우미 설치 파일 생성
   ├─ curl-parser.js    cURL 파서
   ├─ prepare.js        변수·인증·쿠키 적용
   ├─ codegen.js        코드 스니펫 생성
   ├─ postman.js        Postman 형식 컬렉션·환경 가져오기/내보내기
   ├─ cookiejar.js      쿠키 관리자
   ├─ variables.js      {{변수}} 치환
   ├─ model.js / store.js / highlight.js / util.js
   └─ ui/               화면 컴포넌트
```
