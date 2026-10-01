#!/usr/bin/env bash
# ---- Ssoda: cURL 실행 도우미 설치 (macOS / Linux) ----
# 이 파일은 Ssoda 확장 프로그램에서 생성되었습니다. sudo 가 필요 없습니다.
# 실행: bash ssoda-helper-install.sh
set -e
EXT_ID='__CS_EXT_ID__'
HOST_NAME='com.ssoda.runner'
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "python3 가 필요합니다. (macOS: xcode-select --install / Linux: 패키지 관리자로 설치)"
  exit 1
fi
if [ "$(uname)" = "Darwin" ]; then
  DIR="$HOME/Library/Application Support/Ssoda"
  BASES=("$HOME/Library/Application Support/Google/Chrome" "$HOME/Library/Application Support/Microsoft Edge" "$HOME/Library/Application Support/Naver/Whale" "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" "$HOME/Library/Application Support/Chromium")
else
  DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ssoda"
  CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
  BASES=("$CFG/google-chrome" "$CFG/microsoft-edge" "$CFG/naver-whale" "$CFG/BraveSoftware/Brave-Browser" "$CFG/chromium")
fi
mkdir -p "$DIR"
HOST="$DIR/ssoda-host.py"
{
  echo "#!$PY"
  cat <<'CS_HOST_EOF'
__CS_HOST_SCRIPT__
CS_HOST_EOF
} > "$HOST"
chmod 755 "$HOST"
MANIFEST="{
  \"name\": \"$HOST_NAME\",
  \"description\": \"Ssoda - runs curl for the browser extension\",
  \"path\": \"$HOST\",
  \"type\": \"stdio\",
  \"allowed_origins\": [\"chrome-extension://$EXT_ID/\"]
}"
# 이전 이름(cURL Studio)으로 설치된 도우미 정리
for base in "${BASES[@]}"; do rm -f "$base/NativeMessagingHosts/com.curlstudio.runner.json"; done
rm -rf "$HOME/Library/Application Support/cURLStudio" "${XDG_DATA_HOME:-$HOME/.local/share}/curl-studio" 2>/dev/null || true
first=1
for base in "${BASES[@]}" ${CS_EXTRA_PROFILE_DIRS:-}; do
  if [ -d "$base" ] || [ $first = 1 ]; then
    mkdir -p "$base/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$base/NativeMessagingHosts/$HOST_NAME.json"
    echo "  등록: $base/NativeMessagingHosts/$HOST_NAME.json"
  fi
  first=0
done
echo "  curl : $(curl --version 2>/dev/null | head -n1 || echo '찾을 수 없음')"
echo ""
echo "설치가 완료되었습니다. Ssoda 에서 [연결 확인] 을 눌러 주세요."
