#!/usr/bin/env bash
# ---- Ssoda: cURL 실행 도우미 제거 (macOS / Linux) ----
HOST_NAME='com.ssoda.runner'
if [ "$(uname)" = "Darwin" ]; then
  DIR="$HOME/Library/Application Support/Ssoda"
  BASES=("$HOME/Library/Application Support/Google/Chrome" "$HOME/Library/Application Support/Microsoft Edge" "$HOME/Library/Application Support/Naver/Whale" "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" "$HOME/Library/Application Support/Chromium")
else
  DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ssoda"
  CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
  BASES=("$CFG/google-chrome" "$CFG/microsoft-edge" "$CFG/naver-whale" "$CFG/BraveSoftware/Brave-Browser" "$CFG/chromium")
fi
for base in "${BASES[@]}"; do rm -f "$base/NativeMessagingHosts/$HOST_NAME.json" "$base/NativeMessagingHosts/com.curlstudio.runner.json"; done
rm -rf "$HOME/Library/Application Support/cURLStudio" "${XDG_DATA_HOME:-$HOME/.local/share}/curl-studio" 2>/dev/null || true
rm -rf "$DIR"
echo "Ssoda 의 cURL 실행 도우미를 제거했습니다."
