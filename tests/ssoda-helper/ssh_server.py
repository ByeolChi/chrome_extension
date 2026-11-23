# ssoda SSH 터널 시험용 SSH 서버 (paramiko): 비밀번호 인증 + direct-tcpip(포트 포워딩) 중계
# ssh.mjs 가 띄운다. 직접 쓸 때: python ssh_server.py <port(0=빈 포트)> <호스트 키 파일> <사용자> <비밀번호>
# 첫 줄에 "READY <port>" 를 출력하고, 접속마다 "AUTH ok …", "FORWARD (…)" 줄을 남긴다.
# 127.0.0.1 에서만 받는다. 시험용이므로 실제 서버로 쓰지 말 것.
import socket
import sys
import threading

import paramiko

port, keyfile, USER, PASSWORD = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
try:
    host_key = paramiko.Ed25519Key.from_private_key_file(keyfile)
except Exception:  # noqa: BLE001
    host_key = paramiko.RSAKey.from_private_key_file(keyfile)


class Server(paramiko.ServerInterface):
    def get_allowed_auths(self, username):
        return 'password,keyboard-interactive'

    def check_auth_password(self, username, password):
        ok = username == USER and password == PASSWORD
        print('AUTH', 'ok' if ok else 'fail', username, flush=True)
        return paramiko.AUTH_SUCCESSFUL if ok else paramiko.AUTH_FAILED

    def check_auth_interactive(self, username, submethods):
        return paramiko.InteractiveQuery('', '', ('Password: ', False))

    def check_auth_interactive_response(self, responses):
        ok = len(responses) == 1 and responses[0] == PASSWORD
        print('AUTH', 'ok' if ok else 'fail', '(kbd-interactive)', flush=True)
        return paramiko.AUTH_SUCCESSFUL if ok else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        print('FORWARD', destination, flush=True)
        try:
            s = socket.create_connection(destination, timeout=5)
        except OSError:
            return paramiko.OPEN_FAILED_CONNECT_FAILED
        self.pending[chanid] = s
        return paramiko.OPEN_SUCCEEDED

    def check_global_request(self, kind, msg):
        return False


def pump(a_recv, b_send, close):
    try:
        while True:
            d = a_recv(65536)
            if not d:
                break
            b_send(d)
    except Exception:  # noqa: BLE001
        pass
    finally:
        close()


def handle(client):
    t = paramiko.Transport(client)
    t.add_server_key(host_key)
    srv = Server()
    srv.pending = {}
    try:
        t.start_server(server=srv)
    except Exception as e:  # noqa: BLE001
        print('KEX-FAIL', e, flush=True)
        return
    while t.is_active():
        ch = t.accept(1)
        if ch is None:
            continue
        s = srv.pending.pop(ch.get_id(), None)
        if s is None:
            continue

        def closer(ch=ch, s=s):
            try:
                ch.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                s.close()
            except Exception:  # noqa: BLE001
                pass

        threading.Thread(target=pump, args=(ch.recv, s.sendall, closer), daemon=True).start()
        threading.Thread(target=pump, args=(s.recv, ch.sendall, closer), daemon=True).start()


ls = socket.socket()
ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
ls.bind(('127.0.0.1', port))
ls.listen(20)
print('READY', ls.getsockname()[1], flush=True)
while True:
    c, _ = ls.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
