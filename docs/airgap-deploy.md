# 망분리·관리형 PC 배포 안내

이 저장소의 확장 세 개(Ssoda, ClickGuide, CleanShot Picker)를 인터넷이 막힌 PC나 회사가 정책으로 관리하는 PC에 설치하고 업데이트하는 방법입니다. 확장별 사용법은 각 폴더의 README 를 보세요.

브라우저 정책에 관한 내용은 2026-11-24 에 Chrome·Edge 공식 문서와 Chromium 소스로 확인했습니다. 도메인에 가입된 PC 가 없어 정책 설치 자체는 시험하지 못했습니다. 직접 시험한 것은 [시험한 것](#시험한-것)에 적었습니다.

## 한눈에 보기

| | 방법 1. 압축 해제 로드 | 방법 2. 정책으로 강제 설치 |
|---|---|---|
| 하는 사람 | 사용자 | PC 관리자 |
| 필요한 것 | 브라우저의 개발자 모드 | Active Directory 도메인에 가입된 PC([조건](#먼저-확인할-것)), 사내 웹 서버, 그룹 정책 |
| 설치 파일 | 배포 zip 을 푼 폴더 | 개인 키로 서명한 CRX 와 업데이트 XML |
| 업데이트 | 새 버전을 같은 폴더에 덮어쓰고 새로고침 | 서버의 CRX·XML 을 바꾸면 브라우저가 받아 감 |
| 못 쓰는 경우 | 정책으로 개발자 모드를 막거나 확장을 모두 막은 PC | 도메인에 가입되지 않은 PC |

각 README 가 안내하는 설치는 방법 1입니다. 방법 1이 막힌 PC 에서는 관리자가 방법 2로 배포합니다.

## 확장 ID 와 개인 키

| 확장 | 폴더 | 확장 ID | CRX 서명용 개인 키 |
|---|---|---|---|
| Ssoda | `ssoda` | `cnnlkogkbglbbbcefpaknbmebieabijo` | 이 저장소 작업 폴더에 없음. key 를 처음 만든 사람에게 받아야 함 |
| ClickGuide | `click-guide` | `aiageoiblanbjihfdogienmgjokgdhil` | `click-guide-key.pem` |
| CleanShot Picker | `cleanshot-picker` | `fdhmaehlpgpegiemhcfhffecnendgibe` | `cleanshot-picker-key.pem` |

- 확장 ID 는 manifest 의 `key`(공개 키)로 정해집니다. 방법 1은 `key` 만으로 어느 PC·폴더에서나 같은 ID 가 됩니다.
- 방법 2의 CRX 는 짝이 되는 개인 키(`.pem`)로 묶어야 같은 ID 가 됩니다. 개인 키는 git 에 올리지 않으므로(`.gitignore` 의 `*.pem`) 저장소 밖 안전한 곳에도 따로 보관하세요. 잃어버리면 같은 ID 의 CRX 를 만들 수 없습니다.
- 가이드·컬렉션 같은 저장 데이터는 확장 ID 에 묶여 있고, 확장을 삭제하면 함께 지워집니다.
- `npm test` 의 `tests/repo/extension-ids.test.mjs` 가 manifest 의 `key` 로 정해지는 ID 와 각 README, 이 문서, 도우미 등록 스크립트에 적힌 ID 가 같은지 확인합니다.

## 배포 파일 만들기 (인터넷 PC)

1. 저장소 최상위에서 배포 zip 을 만듭니다.
   ```
   pwsh scripts/build-zip.ps1 -Extension click-guide
   ```
   - 결과는 `click-guide/dist/click-guide-v<버전>.zip` 입니다. 허용 목록에 있는 파일만 들어가고, 개인 키(`.pem`)나 CRX 가 섞이면 만들지 않고 멈춥니다.
   - Windows PowerShell 5.1 에서도 됩니다: `powershell -ExecutionPolicy Bypass -File scripts/build-zip.ps1 -Extension click-guide`
2. 방법 2를 쓰려면 같은 PC 에서 CRX 도 만듭니다([CRX 만들기](#1-crx-만들기)).
3. Ssoda 도우미를 PC 전체에 등록하려면 `scripts/install-ssoda-helper-machine.ps1` 도 챙깁니다([PC 전체에 등록하기](#pc-전체에-등록하기-관리자)).
4. 만든 파일을 망연계 시스템이나 승인된 USB 로 옮깁니다.

## 방법 1. 압축 해제 로드 (개발자 모드)

1. zip 을 지우지 않을 고정 폴더에 풉니다. 예: `C:\Tools\click-guide`. 폴더를 열면 `manifest.json` 이 바로 보여야 합니다.
2. `chrome://extensions`(Edge 는 `edge://extensions`)에서 **개발자 모드**를 켜고, **압축해제된 확장 프로그램을 로드**로 그 폴더를 고릅니다.
3. 새 버전은 같은 폴더에 덮어쓰고 확장 목록에서 새로고침(⟳)을 누릅니다. ID 가 고정되어 있어 데이터가 그대로 남습니다.

- **개발자 모드는 켜 둔 채로 씁니다.** Chrome 134 부터는 개발자 모드를 끄면 압축 해제로 올린 확장이 꺼집니다. Edge 도 그런지는 확인하지 못했습니다.
- Edge 는 개발자 모드 확장이 있으면 알림을 띄우고, 이 알림은 닫을 수 없습니다.
- Edge 화면 안내는 [ssoda/EDGE.md](../ssoda/EDGE.md) 에 있습니다. 다른 두 확장도 순서가 같습니다.
- ID 를 고정하기 전 버전(ClickGuide 0.1.9 이하, CleanShot Picker 1.0.1 이하)에서 올릴 때는 각 README 의 "업데이트할 때" 순서를 따릅니다. ClickGuide 는 가이드를 백업해서 옮겨야 합니다.

### 방법 1이 막히는 경우

| 회사 정책 (Chrome·Edge 같은 이름) | 보이는 증상 |
|---|---|
| `ExtensionDeveloperModeSettings` = 1 (128 이상) | 개발자 모드가 꺼진 채 바꿀 수 없음 |
| `DeveloperToolsAvailability` = 2 (위 정책이 없을 때) | 개발자 모드가 꺼진 채 바꿀 수 없음. 개발자 도구도 막힘 |
| `ExtensionInstallBlocklist` = `*` | 압축 해제 로드가 "Extension installation is blocked by policy." 로 거부됨. 허용 목록(`ExtensionInstallAllowlist`)에 ID 를 넣어도 압축 해제 확장은 막힘 |

- Chrome 134 이상에서는 위 두 정책으로 개발자 모드가 꺼지면, 이미 올려 둔 압축 해제 확장도 꺼집니다(Chromium 소스 기준).
- 이런 PC 는 관리자가 방법 2로 배포합니다. 바로가기에 `--load-extension` 을 붙여 올리는 방법은 Chrome 137 부터 정식 Chrome 이 무시하므로 쓰지 않습니다.

## 방법 2. 정책으로 강제 설치 (관리자용)

### 먼저 확인할 것

- **PC 가 도메인에 가입되어 있어야 합니다.** Windows 에서 웹 스토어 밖의 확장을 정책으로 강제 설치하려면 다음 조건이 필요합니다.
  - Chrome: Active Directory 도메인 가입, Microsoft Entra ID(Azure AD) 가입, Chrome Enterprise Core 등록 중 하나
  - Edge: Active Directory 도메인 가입. Entra ID 는 Microsoft 문서마다 설명이 달라서(하이브리드 가입이어야 한다는 문서가 있음) Entra ID 만 가입한 PC 는 장담할 수 없습니다.
  - Intune 같은 MDM 에만 등록된 PC 는 공식 문서에 나오지 않습니다.
  - 망분리 사내망이라면 보통 AD 도메인 가입 PC 가 해당합니다. Chrome Enterprise Core 는 Google 클라우드에 연결해야 하므로 망분리망에서는 쓰기 어렵습니다.
- 조건이 맞지 않는 PC 에서는 정책을 넣어도 설치되지 않습니다. Chrome 은 `chrome://policy` 에 "This computer is not detected as enterprise managed so policy can only automatically install extensions hosted on the Chrome Webstore." 라고 표시하고 그 항목을 무시합니다.
- **사내 웹 서버**: PC 가 인증 없이 업데이트 XML 과 CRX 를 받을 수 있어야 합니다([서버에 올리기](#3-사내-웹-서버에-올리기)).
- **정책 배포 수단**: 그룹 정책(GPO). 시험할 때는 PC 한 대의 레지스트리에 직접 넣어도 됩니다.

### 1. CRX 만들기

1. 배포 zip 을 빈 폴더에 풉니다. 예: `C:\build\click-guide`. 저장소 폴더를 바로 묶으면 `dist` 처럼 배포에 넣지 않는 파일까지 들어가므로, 허용 목록만 담긴 zip 을 푼 폴더를 씁니다.
2. Chrome 으로 묶습니다. 개인 키는 확장 폴더 밖에 둡니다.
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=C:\build\pack-profile --no-message-box --pack-extension=C:\build\click-guide --pack-extension-key=C:\keys\click-guide-key.pem
   ```
   - `--user-data-dir` 는 묶기 전용 임시 프로필입니다. 이미 열려 있는 Chrome 과 섞이지 않게 해 주고, 끝나면 지워도 됩니다.
   - `--no-message-box` 는 결과를 창으로 띄우지 않게 합니다. CRX 가 생기지 않았으면 이 옵션을 빼고 다시 실행해 오류 내용을 봅니다.
3. 폴더 옆에 `C:\build\click-guide.crx` 가 생깁니다. 짝이 맞는 개인 키로 묶었으므로 CRX 의 ID 가 위 표와 같습니다.

- Edge 로도 같은 옵션으로 묶을 수 있습니다: `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --user-data-dir=... --no-message-box --pack-extension=... --pack-extension-key=...`. 결과는 같은 형식(CRX3)이고 확장 ID 도 같습니다.
- CRX 는 CRX3 형식이어야 합니다. Chrome 76 부터 CRX2 는 새로 설치되지 않고 업데이트도 멈춥니다. 최신 Chrome·Edge 로 묶으면 CRX3 가 됩니다.

### 2. 업데이트 XML 만들기

```xml
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='cnnlkogkbglbbbcefpaknbmebieabijo'>
    <updatecheck codebase='https://ext.intra.example.com/chrome/ssoda-1.3.6.crx' version='1.3.6' />
  </app>
  <app appid='aiageoiblanbjihfdogienmgjokgdhil'>
    <updatecheck codebase='https://ext.intra.example.com/chrome/click-guide-0.2.0.crx' version='0.2.0' />
  </app>
  <app appid='fdhmaehlpgpegiemhcfhffecnendgibe'>
    <updatecheck codebase='https://ext.intra.example.com/chrome/cleanshot-picker-1.1.0.crx' version='1.1.0' />
  </app>
</gupdate>
```

- `appid` 는 확장 ID, `codebase` 는 CRX 주소입니다. `version` 은 CRX 안 manifest 의 버전과 같아야 합니다. 브라우저는 이 값을 설치된 버전과 비교해 CRX 를 받을지 정합니다.
- 한 파일에 세 확장을 함께 적어도 되고 따로 둬도 됩니다.
- CRX 파일 이름에 버전을 넣으면, 중간 캐시가 옛 파일을 내주는 일을 피할 수 있습니다.

### 3. 사내 웹 서버에 올리기

- XML 과 CRX 를 서버에 둡니다. 예: `https://ext.intra.example.com/chrome/updates.xml`
- 로그인처럼 인증을 요구하는 곳에 두지 않습니다. 브라우저가 백그라운드에서 받아 갑니다.
- 정책에 적는 주소는 http·https·file 을 쓸 수 있습니다. https 를 권합니다.
- IIS 는 MIME 형식이 등록되지 않은 확장자를 내주지 않습니다(404.3). `.crx` 를 추가합니다. 예: 사이트의 `web.config`
  ```xml
  <configuration>
    <system.webServer>
      <staticContent>
        <mimeMap fileExtension=".crx" mimeType="application/x-chrome-extension" />
      </staticContent>
    </system.webServer>
  </configuration>
  ```
- 웹 서버가 없으면 `file:///` 주소도 정책 문서상 쓸 수 있습니다. 이 방법과 공유 폴더(UNC) 경로는 시험하지 않았습니다.

### 4. 정책 배포

`ExtensionSettings` 정책 하나로 세 확장을 강제 설치합니다. Chrome 62 이상, Edge 77 이상에서 쓸 수 있습니다.

```json
{
  "cnnlkogkbglbbbcefpaknbmebieabijo": {
    "installation_mode": "force_installed",
    "update_url": "https://ext.intra.example.com/chrome/updates.xml",
    "override_update_url": true
  },
  "aiageoiblanbjihfdogienmgjokgdhil": {
    "installation_mode": "force_installed",
    "update_url": "https://ext.intra.example.com/chrome/updates.xml",
    "override_update_url": true
  },
  "fdhmaehlpgpegiemhcfhffecnendgibe": {
    "installation_mode": "force_installed",
    "update_url": "https://ext.intra.example.com/chrome/updates.xml",
    "override_update_url": true
  }
}
```

- **`override_update_url` 을 꼭 넣습니다.** 이 값이 없으면 정책의 주소는 처음 설치에만 쓰이고, 그 뒤 업데이트는 manifest 의 `update_url` 을 따릅니다. 이 저장소의 확장들은 manifest 에 `update_url` 이 없어서, 이 값이 없으면 사내 서버의 새 버전을 받지 못합니다.
- `force_installed` 는 사용자가 지울 수 없습니다. 사용자가 끌 수는 있게 하려면 `normal_installed` 를 씁니다.
- 정책에서 빼면 브라우저가 확장을 지우고, 저장 데이터도 함께 사라집니다. 빼기 전에 사용자가 백업하게 합니다.
- 이미 `ExtensionSettings` 정책을 쓰고 있으면 덮어쓰지 말고 기존 JSON 에 세 항목을 더합니다. 이 정책은 값 하나라서 새로 넣으면 기존 설정이 사라집니다.
- 다른 확장을 모두 막는 `"*": {"installation_mode": "blocked"}` 와 함께 써도 위 세 확장은 설치됩니다. `"*"` 는 따로 설정하지 않은 확장에만 적용됩니다.
- `ExtensionInstallForcelist`(`ID;업데이트 주소`)로도 설치는 되지만, 그 주소도 처음 설치에만 쓰입니다. 업데이트까지 사내 서버에서 받으려면 `ExtensionSettings` 의 `override_update_url` 이 필요하므로 처음부터 `ExtensionSettings` 를 쓰는 편이 간단합니다.

**그룹 정책으로 넣기**

1. 인터넷 PC 에서 Chrome·Edge 의 관리 템플릿(ADMX)을 받아 도메인의 정책 저장소에 넣습니다.
2. 그룹 정책 관리 편집기에서 아래 정책을 **사용**으로 바꾸고, JSON 을 **한 줄로** 붙여 넣습니다. 이름은 영문 템플릿 기준이며, 한국어 템플릿에서는 번역된 이름으로 보입니다.
   - Chrome: 컴퓨터 구성 → 관리 템플릿 → Google → Google Chrome → Extensions → **Extension management settings**
   - Edge: 컴퓨터 구성 → 관리 템플릿 → Microsoft Edge → Extensions → **Configure extension management settings**
3. PC 에서 `gpupdate /force` 를 실행하고, `chrome://policy`(Edge 는 `edge://policy`)에서 **정책 새로고침**을 누릅니다.
4. `chrome://policy` 에 `ExtensionSettings` 가 오류 없이 보이는지, `chrome://extensions` 에 관리자가 설치한 확장으로 나오는지 봅니다.

한 줄 JSON:

```json
{"cnnlkogkbglbbbcefpaknbmebieabijo":{"installation_mode":"force_installed","update_url":"https://ext.intra.example.com/chrome/updates.xml","override_update_url":true},"aiageoiblanbjihfdogienmgjokgdhil":{"installation_mode":"force_installed","update_url":"https://ext.intra.example.com/chrome/updates.xml","override_update_url":true},"fdhmaehlpgpegiemhcfhffecnendgibe":{"installation_mode":"force_installed","update_url":"https://ext.intra.example.com/chrome/updates.xml","override_update_url":true}}
```

**PC 한 대에서 시험할 때 (레지스트리)**

- Chrome: `HKLM\SOFTWARE\Policies\Google\Chrome` 에 문자열 값(REG_SZ) `ExtensionSettings` 를 만들고 한 줄 JSON 을 넣습니다.
- Edge: `HKLM\SOFTWARE\Policies\Microsoft\Edge` 에 같은 값을 만듭니다.
- 실제 배포는 그룹 정책으로 합니다.

### 5. 새 버전 배포

1. 버전을 올린 배포 zip 을 만들고(`-Bump patch` 등), 같은 개인 키로 CRX 를 다시 묶습니다.
2. 새 CRX 를 서버에 올리고 XML 의 `version` 과 `codebase` 를 바꿉니다.
3. 브라우저는 시작할 때와 그 뒤 몇 시간마다(Chromium 기본값 약 5시간) 업데이트를 확인합니다. 받은 업데이트는 확장이 쉬고 있을 때(서비스 워커가 멈췄을 때) 적용되고, 그렇지 않으면 브라우저를 다시 시작할 때 적용됩니다.

- 버전을 올리지 않고 CRX 만 바꾸면 업데이트로 보지 않습니다. 버전은 올리기만 합니다.
- 바로 받게 하려면 브라우저를 다시 시작합니다. 개발자 모드를 쓸 수 있는 PC 라면 확장 페이지의 **업데이트** 버튼도 됩니다.

### 방법 1에서 방법 2로 옮길 때

같은 ID 라도 압축 해제로 설치한 확장을 지우면 그 데이터도 지워집니다. 먼저 백업하세요.

1. 사용자가 백업합니다.
   - ClickGuide: 설정 → 데이터 → **전체 백업 내보내기**. AI API 키는 백업에 들어가지 않으므로 옮긴 뒤 다시 넣습니다.
   - Ssoda: 설정 → **전체 백업 내보내기**. curl 실행 파일 경로는 복원되지 않으므로, 바꿔 썼다면 옮긴 뒤 다시 지정합니다.
   - CleanShot Picker: 저장하는 것이 설정 두 가지뿐이라 백업이 필요 없습니다.
2. 압축 해제로 설치한 확장을 삭제합니다.
3. 정책으로 설치되면 백업을 가져옵니다(ClickGuide **백업에서 가져오기**, Ssoda **백업에서 복원**).

## Ssoda cURL 실행 도우미 (관리형 PC)

Ssoda 가 내려 주는 설치 파일은 관리자 권한 없이 도우미를 설치합니다. 파일은 사용자 폴더 `%LOCALAPPDATA%\Ssoda\helper` 에 두고, 사용자 레지스트리 `HKCU\Software\<브라우저>\NativeMessagingHosts\com.ssoda.runner` 에 등록합니다. 방법 1·2 어느 쪽으로 설치해도 확장 ID 가 같으므로 도우미 등록도 같습니다.

회사 정책에 따라 다음처럼 막힐 수 있습니다.

| 회사 정책 | Ssoda 에 보이는 오류 | 해결 |
|---|---|---|
| `NativeMessagingUserLevelHosts` = 0 (사용자 수준 도우미 금지) | 설치했는데도 "cURL 실행 도우미가 설치되어 있지 않습니다." (도우미 설정 창에서는 "도우미가 아직 설치되지 않았습니다.") | 관리자가 [PC 전체에 등록](#pc-전체에-등록하기-관리자) |
| `NativeMessagingBlocklist` 에 `*` 또는 `com.ssoda.runner` | "cURL 실행 도우미와 통신할 수 없습니다: Access to the native messaging host was disabled by the system administrator." | `NativeMessagingAllowlist` 에 `com.ssoda.runner` 추가 |
| 그룹 정책의 PowerShell 실행 정책이 `AllSigned` 이거나 스크립트 실행을 끔 | "cURL 실행 도우미가 응답 없이 종료되었습니다." | 도우미 스크립트(`ssoda-host.ps1`)에 회사 코드 서명 인증서로 서명하거나 정책 예외. 도우미가 붙이는 `-ExecutionPolicy Bypass` 는 그룹 정책을 넘지 못합니다 |
| AppLocker·WDAC 스크립트 규칙 | "cURL 실행 도우미가 응답 없이 종료되었습니다." | 도우미 폴더를 허용 규칙에 넣습니다. AppLocker 기본 규칙은 `Program Files` 안의 스크립트를 허용하므로, 기본 위치가 `C:\Program Files\Ssoda\helper` 인 PC 전체 등록이 맞습니다 |

- 세 가지 Native Messaging 정책은 Chrome 과 Edge 에 같은 이름으로 있습니다(`HKLM\SOFTWARE\Policies\Google\Chrome`, `HKLM\SOFTWARE\Policies\Microsoft\Edge`).
- 허용 목록은 사용자 수준 금지를 풀지 않습니다. 두 정책이 함께 있으면 PC 전체 등록과 허용 목록이 모두 필요합니다.
- AppLocker·WDAC 가 허용하지 않은 PowerShell 스크립트는 제한 언어 모드(ConstrainedLanguage)로 실행됩니다. 도우미는 이 모드에서 첫 .NET 호출(`[Console]::OpenStandardInput()`)에서 멈추는 것을 확인했습니다.
- 실행 정책이 `RemoteSigned` 인 PC 에서는 인터넷에서 받은 표시(Zone.Identifier)가 붙은 스크립트가 막힙니다. Ssoda 설치 파일은 도우미를 새로 써서 표시가 없고, 아래 스크립트는 복사한 도우미의 표시를 지웁니다.
- **여러 사람이 한 Windows 서버에 원격으로 들어가 쓰는 환경(SBC 방식 망분리, 원격 데스크톱 서버)**: 도우미 v2.0.0 은 SSH 연결을 마지막 요청 뒤 10분(설정 → cURL 실행 → SSH 연결 유지) 동안 `127.0.0.1` 의 포트에 열어 둡니다. ssh 의 이 기능에는 비밀번호를 걸 수 없어, 그동안 같은 서버의 다른 사용자도 그 연결로 SSH 서버 너머에 접속할 수 있습니다. 이런 환경의 사용자에게는 이 설정을 0 으로 두도록 안내하세요. 확장의 설정이라 정책으로 정해 줄 수는 없습니다.

### PC 전체에 등록하기 (관리자)

`scripts/install-ssoda-helper-machine.ps1` 은 사용자 설치 파일과 같은 도우미 파일 세 개(`ssoda-host.ps1`, `ssoda-host.bat`, `com.ssoda.runner.json`)를 `C:\Program Files\Ssoda\helper` 에 두고, `HKLM\SOFTWARE\Google\Chrome` 과 `HKLM\SOFTWARE\Microsoft\Edge` 아래 `NativeMessagingHosts\com.ssoda.runner` 에 등록합니다. 그 PC 의 모든 사용자가 같이 씁니다.

1. Ssoda 배포 zip 을 풉니다. 예: `C:\Tools\ssoda`
2. 관리자 권한 PowerShell 에서 실행합니다.
   ```
   powershell -ExecutionPolicy Bypass -File .\install-ssoda-helper-machine.ps1 -SsodaDir C:\Tools\ssoda
   ```
3. Ssoda 의 **Send ▾ → cURL 실행 도우미 설정** 에서 **연결 확인**을 누릅니다. 브라우저를 다시 시작할 필요는 없습니다.

- 설치 폴더는 `-Dest` 로 바꿀 수 있습니다. 웨일·Brave 같은 다른 브라우저도 등록하려면 PowerShell 창 안에서 `-Browsers` 에 레지스트리 경로를 더해 실행합니다.
  ```
  Set-ExecutionPolicy -Scope Process Bypass -Force
  .\install-ssoda-helper-machine.ps1 -SsodaDir C:\Tools\ssoda -Browsers 'SOFTWARE\Google\Chrome','SOFTWARE\Microsoft\Edge','SOFTWARE\Naver\Whale'
  ```
- 지울 때는 관리자 권한 PowerShell 에서 다음을 실행합니다.
  ```
  Remove-Item 'HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.ssoda.runner', 'HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.ssoda.runner'
  Remove-Item "$env:ProgramFiles\Ssoda" -Recurse
  ```
- `npm run test:helper` 의 `machine` 시험이 이 스크립트를 레지스트리 없이 임시 폴더에 실행해, 사용자 설치 파일과 같은 파일을 만들고 도우미가 응답하는지 확인합니다.

## 문제 해결

| 증상 | 원인과 해결 |
|---|---|
| `chrome://policy` 에 "This computer is not detected as enterprise managed …" 가 보이고 확장이 설치되지 않음 | 도메인에 가입되지 않은 PC 입니다. 방법 2를 쓸 수 없으니 방법 1을 씁니다 |
| 정책은 보이는데 확장이 설치되지 않음 | 그 PC 의 브라우저로 XML 주소와 CRX 주소를 직접 열어 받아지는지 봅니다. 인증 요구, IIS 404.3(`.crx` MIME 형식 없음), XML 의 `appid` 오타, `version` 과 CRX 버전이 다른지 확인합니다 |
| 새 버전이 들어오지 않음 | XML 의 `version` 을 올렸는지, 정책에 `override_update_url` 이 있는지 봅니다. 확인 주기가 몇 시간이므로 브라우저를 다시 시작해 봅니다 |
| 개발자 모드를 켤 수 없음 | 회사 정책으로 막힌 것입니다([방법 1이 막히는 경우](#방법-1이-막히는-경우)). 관리자에게 방법 2를 요청합니다 |
| "Must be in developer mode to load unpacked extensions." | 개발자 모드를 켜고 다시 로드합니다 |
| 개발자 모드를 껐더니 확장이 꺼짐 | Chrome 134 부터의 동작입니다. 개발자 모드를 다시 켭니다 |
| CRX 를 확장 페이지에 끌어다 놓았더니 설치되지 않거나 꺼짐 | Windows 의 Chrome·Edge 는 정책이 허용하지 않은 스토어 밖 CRX 를 쓰지 못합니다. 방법 1 또는 방법 2로 설치합니다 |
| Edge 에 개발자 모드 확장 알림이 계속 뜸 | 방법 1로 설치한 확장이 있으면 Edge 가 띄우는 알림이며 닫을 수 없습니다. 없애려면 방법 2로 설치합니다 |
| Ssoda 에 "cURL 실행 도우미가 …" 오류 | [Ssoda 도우미](#ssoda-curl-실행-도우미-관리형-pc)의 표를 봅니다 |

## 시험한 것

- **CRX 묶기**: Chromium 131 로 ClickGuide·CleanShot Picker 를, Edge 158 로 CleanShot Picker 를 위 명령으로 묶었습니다. CRX3 머리말의 ID 와 서명 공개 키가 manifest 의 `key` 와 같았습니다.
- **PC 전체 도우미 등록 스크립트**: 레지스트리를 빼고 실행해 만든 도우미가 브라우저와 같은 방식(`cmd.exe` 로 bat 실행)으로 응답하는 것을 확인했습니다. 레지스트리 등록은 관리자 권한이 필요해 시험하지 않았습니다.
- **제한 언어 모드**: 도우미가 ConstrainedLanguage 에서 멈추는 것을 확인했습니다.
- **시험하지 못한 것**: 정책 설치·업데이트, 그룹 정책, 관리형 PC 에서의 동작. 아래 문서와 Chromium 소스로 확인한 내용입니다.

## 참고 문서

2026-11-24 에 확인했습니다.

- Chrome 정책: [ExtensionSettings](https://chromeenterprise.google/policies/#ExtensionSettings), [ExtensionInstallForcelist](https://chromeenterprise.google/policies/#ExtensionInstallForcelist), [ExtensionInstallBlocklist](https://chromeenterprise.google/policies/#ExtensionInstallBlocklist), [ExtensionDeveloperModeSettings](https://chromeenterprise.google/policies/#ExtensionDeveloperModeSettings), [DeveloperToolsAvailability](https://chromeenterprise.google/policies/#DeveloperToolsAvailability), [NativeMessagingUserLevelHosts](https://chromeenterprise.google/policies/#NativeMessagingUserLevelHosts), [NativeMessagingBlocklist](https://chromeenterprise.google/policies/#NativeMessagingBlocklist), [NativeMessagingAllowlist](https://chromeenterprise.google/policies/#NativeMessagingAllowlist)
- Chrome 도움말·문서: [ExtensionSettings 자세한 안내](https://support.google.com/chrome/a?p=Configure_ExtensionSettings_policy), [Windows 에서 확장 정책 설정](https://support.google.com/chrome/a/answer/7532015), [스토어 밖 배포(업데이트 XML·CRX 묶기)](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux), [확장 업데이트 시점](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle), [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- Chrome 변경 공지: [134 개발자 모드](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/cTdMVtxxooY), [137 `--load-extension`](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY), [76 CRX2 중단](https://cloud.google.com/blog/products/chrome-enterprise/admin-insider-whats-new-in-chrome-enterprise-release-76)
- Edge: [직접 호스팅한 확장 배포](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-manage-extensions-webstore), [ExtensionSettings](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/extensionsettings), [ExtensionInstallForcelist](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/extensioninstallforcelist), [ExtensionDeveloperModeSettings](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/extensiondevelopermodesettings), [NativeMessagingUserLevelHosts](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/nativemessaginguserlevelhosts), [Native messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging), [개발자 모드 확장 알림](https://support.microsoft.com/en-US/edge/developer-mode-extension-notification)
- Windows: [PowerShell 실행 정책](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-5.1), [PowerShell 언어 모드](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes?view=powershell-5.1), [AppLocker 스크립트 기본 규칙](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/script-rules-in-applocker)
