#!/bin/sh
# macOS / Linux 启动器（Windows 用 start.bat）
set -e
cd "$(dirname "$0")"

# bash 下也能跑；没装依赖时给一句人话，别上来就是报错
if [ ! -d node_modules/electron ]; then
  echo "还没装依赖，先跑：npm install"
  exit 1
fi

./node_modules/electron/dist/electron . 2>/dev/null || npx --no-install electron . 2>/dev/null || {
  echo "Electron 没起来。装一下：npm install"
  exit 1
}
