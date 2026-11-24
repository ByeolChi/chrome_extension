# ssoda cURL 실행 도우미 시험

ssoda 의 cURL 실행 도우미(`ssoda/native-host/ssoda-host.ps1`, `ssoda-host.py`)를 Chrome 과 같은 방식(4바이트 길이 + JSON)으로 직접 띄워, 실제 curl·ssh 와 함께 확인합니다. 외부 Node 패키지는 쓰지 않습니다.

| 시험 | 확인하는 것 |
|---|---|
| `helper.mjs` | 확장을 거치지 않고 도우미에 위험한 인자를 직접 보내도 막히는지: `--proxy-header @파일`·`-H @파일`·`-F x=@파일`(PC 파일 유출), `file://` 주소, `--next`, `-o` 경로 바꾸기(파일 덮어쓰기), 묶음 옵션 `-sSo`, `--unix-socket`, `--config`. 정상 요청(raw body, form-data)은 그대로 실행되는지. 도우미 버전이 확장이 기대하는 버전과 같은지. 설치 파일에 도우미 스크립트가 깨지지 않고 들어가는지 |
| `curl-path.mjs` | 확장 모듈(`parseCurl` → `prepareRequest` → `runCurl`)에서 실제 도우미와 curl 까지: 공유받은 요청의 추가 인자나 붙여넣은 cURL 에 `--proxy-header @파일` 이 있어도 파일 내용이 프록시로 나가지 않는지, `file://` 주소와 `@` 로 시작하는 헤더 이름을 거부하는지, 정상 요청은 그대로 가는지 |
| `ssh.mjs` | 시험용 SSH 서버(`ssh_server.py`, paramiko)에 접속해, 서버 키 파일 경로에 공백이 있어도(macOS 기본 설치 경로, `Hong Gildong` 같은 Windows 사용자 폴더) 저장한 서버 키를 읽고 접속하는지, 터널로 보낸 요청이 서버 너머 주소에 도착하는지 |
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
node tests/ssoda-helper/run.mjs helper      # 하나만 (helper / curl-path / ssh / machine)
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
- Windows 11(Windows PowerShell 5.1, OpenSSH 9.5p2, curl 8.22.0, Python 3.9)에서 확인했습니다.
