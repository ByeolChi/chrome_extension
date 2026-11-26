# ssoda cURL 실행 도우미 시험

ssoda 의 cURL 실행 도우미(`ssoda/native-host/ssoda-host.ps1`, `ssoda-host.py`)를 Chrome 과 같은 방식(4바이트 길이 + JSON)으로 직접 띄워, 실제 curl·ssh 와 함께 확인합니다. 외부 Node 패키지는 쓰지 않습니다.

| 시험 | 확인하는 것 |
|---|---|
| `helper.mjs` | 확장을 거치지 않고 도우미에 위험한 인자를 직접 보내도 막히는지: `--proxy-header @파일`·`-H @파일`·`-F x=@파일`(PC 파일 유출), `file://` 주소, `--next`, `-o` 경로 바꾸기(파일 덮어쓰기), 묶음 옵션 `-sSo`, `--unix-socket`, `--config`. 정상 요청(raw body, form-data)은 그대로 실행되는지. 도우미 버전이 확장이 기대하는 버전과 같은지. 설치 파일에 도우미 스크립트가 깨지지 않고 들어가는지 |
| `session.mjs` | 도우미 2.0 (켜 둔 도우미, SSH 서버 없이): 첫 메시지 `{type:'ping', session:true}` 에 `session:true` 로 답하고 끝나지 않는지, 요청 번호(`id`)로 동시에 보낸 요청이 섞이지 않고 먼저 끝난 요청이 먼저 오는지(요청마다 따로 받은 파일), 취소한 요청만 멈추는지(curl 끊김), 막힌 인자는 그 요청만 오류인지, 파일을 못 받은 요청은 보내지 않는지, 서버 키 가져오기(`ssh-keyscan`)를 기다리는 동안에도 다른 요청이 나가는지, 연결을 끊으면 받는 중이던 curl 까지 멈추고 끝나는지, 요청마다 새로 띄우는 방식보다 빠른지(가운데값). Windows 의 ps1 은 강제로 끝난 도우미가 남긴 작업 폴더의 ssh 만 정리하는지(가짜 `ssh.exe` 로) |
| `curl-path.mjs` | 확장 모듈(`parseCurl` → `prepareRequest` → `runCurl`)에서 실제 도우미와 curl 까지: 공유받은 요청의 추가 인자나 붙여넣은 cURL 에 `--proxy-header @파일` 이 있어도 파일 내용이 프록시로 나가지 않는지, `file://` 주소와 `@` 로 시작하는 헤더 이름을 거부하는지, 정상 요청은 그대로 가는지, SSE 를 받다가 `--max-time` 에 걸리면(종료 코드 28) 오류 대신 받은 이벤트까지 응답으로 남는지. 도우미 2.0: 요청들이 켜 둔 도우미 하나로 가는지, 동시 요청·취소, 도우미가 갑자기 끝나면 기다리던 요청은 오류이고 다음 요청 때 다시 켜는지, 옛 도우미(git 기록 `fa81dfb` 의 1.3.2)면 예전처럼 요청마다 띄우는지, 새 도우미를 확인하면 다시 켜 둔 도우미로 돌아가는지 |
| `ssh.mjs` | 시험용 SSH 서버(`ssh_server.py`, paramiko)에 접속해, 서버 키 파일 경로에 공백이 있어도(macOS 기본 설치 경로, `Hong Gildong` 같은 Windows 사용자 폴더) 저장한 서버 키를 읽고 접속하는지, 터널로 보낸 요청이 서버 너머 주소에 도착하는지. 켜 둔 도우미: 같은 서버로 보낸 둘째 요청은 열어 둔 연결을 쓰는지(서버 로그인 한 번), 동시 요청도 한 연결로, 유지 시간이 지나면·유지 시간 0 이면 닫는지, 연결 테스트는 새로 접속하고 그 연결을 다음 요청이 쓰는지, 서버를 다시 시작해 끊긴 연결은 다음 요청 때 새로 접속하는지, 서버 키를 초기화하면 열어 둔 연결도 닫히는지, 도우미가 끝나면 ssh 도 끝나는지 |
| `machine.mjs` | PC 전체 등록 스크립트(`scripts/install-ssoda-helper-machine.ps1`): 사용자 설치 파일과 같은 도우미 파일 세 개를 만드는지, 인터넷에서 받은 표시(Zone.Identifier)를 설치본에서 지우는지, 만든 도우미를 브라우저와 같은 방식(`cmd.exe` 로 bat 실행)으로 띄웠을 때 응답하는지. Windows 전용이며, 관리자 권한이 필요한 레지스트리 등록은 빼고 임시 폴더에 설치합니다 |

Windows 에서는 ps1·py 도우미를 모두, macOS·Linux 에서는 py 도우미만 시험합니다. `curl-path.mjs` 는 Windows 에서 ps1, 그 밖에서는 py 도우미를 씁니다.

## 준비

- Node 22 이상
- curl (Windows 10 1803 이상은 기본으로 들어 있음)
- Windows: Windows PowerShell (`powershell.exe`)
- Python 3 (py 도우미용, `PYTHON` 으로 실행 파일 지정 가능)
- `ssh.mjs` 만: OpenSSH 클라이언트(`ssh`, `ssh-keygen`)와 **paramiko 가 설치된 Python**. 저장소 밖에 가상 환경을 만들어 지정하는 것을 권합니다.

  ```
  python -m venv <저장소 밖 폴더>
  <폴더>\Scripts\pip install paramiko          (macOS·Linux: <폴더>/bin/pip install paramiko)
  set SSH_TEST_PYTHON=<폴더>\Scripts\python.exe (PowerShell: $env:SSH_TEST_PYTHON = '…')
  ```

  paramiko 가 없으면 `ssh.mjs` 는 실패가 아니라 "준비 안 됨"(종료 코드 2)으로 끝납니다.

## 실행

```
npm run test:helper                         # 모두 차례로
node tests/ssoda-helper/run.mjs helper      # 하나만 (helper / session / curl-path / ssh / machine)
```

하나라도 실패하면 종료 코드 1 입니다. 시험용 파일(비밀 파일, 호스트 키, known_hosts, 도우미 사본)은 OS 임시 폴더에 만들고 끝나면 지웁니다. 서버는 모두 127.0.0.1 의 빈 포트를 씁니다.

| 환경 변수 | 뜻 |
|---|---|
| `SSODA_DIR` | 저장소 `ssoda` 폴더 대신 시험할 사본 (예: 수정 전 버전을 풀어 둔 폴더와 비교) |
| `PYTHON` | py 도우미를 실행할 Python |
| `SSH_TEST_PYTHON` | 시험용 SSH 서버를 실행할, paramiko 가 있는 Python |

## 알아 둘 점

- 이 시험은 PC 에 설치된 도우미가 아니라 저장소(또는 `SSODA_DIR`)의 도우미 파일을 직접 실행합니다. 설치·레지스트리는 건드리지 않습니다. `machine.mjs` 도 임시 폴더에만 설치합니다.
- Windows 의 py 도우미는 PATH 의 ssh 와 sh 스크립트(SSH_ASKPASS)로 로그인하므로, Git for Windows 의 ssh 가 없으면 로그인이 실패할 수 있습니다. 그래서 Windows 에서 py 도우미의 SSH 시험은 "서버 키 확인 통과"까지만 요구합니다.
- 실제 사내 SSH 서버, OTP 같은 추가 인증, 실제 Chrome 의 Native Messaging 연결은 시험하지 않습니다.
  - 도우미 2.0 은 2026-11-26 에 한 번, 레지스트리 `HKCU\Software\Chromium\NativeMessagingHosts\com.ssoda.runner` 를 시험용 도우미 사본으로 잠시 바꿔 Playwright Chromium 131 로 확인했습니다(9/9, 끝난 뒤 원래 값으로 되돌림): 요청들이 도우미 하나로 감, 동시 요청·취소, 연결을 닫거나 Ssoda 탭을 닫으면 도우미와 열어 둔 SSH 연결이 끝남, SSH 처음 접속 때 서버 지문 확인 뒤 둘째 요청은 열어 둔 연결, 옛 도우미(1.3.2)면 예전 방식. 요청 한 번(가운데값) 옛 도우미 795ms → 켜 둔 도우미 74ms. 사용자 레지스트리를 바꾸므로 이 저장소의 시험에는 넣지 않았습니다.
- Windows 11(Windows PowerShell 5.1, OpenSSH 9.5p2, curl 8.22.0, Python 3.9, paramiko 5.1.0)에서 확인했습니다. 도우미 2.0 의 Python 도우미는 이 PC(Windows)에서만 돌려 보았고, macOS·Linux 에서는 확인하지 않았습니다. 특히 강제로 끝난 도우미가 남긴 ssh 정리(`clear_stale`)는 macOS·Linux 에서만 동작해 시험하지 못했습니다.
