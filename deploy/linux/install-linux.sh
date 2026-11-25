#!/usr/bin/env bash
# One-command Linux installer for PGA (Ubuntu/Debian/Fedora/Arch).
# Usage:
#   bash deploy/linux/install-linux.sh                      # Native install + systemd + desktop shortcut (if GUI)
#   bash deploy/linux/install-linux.sh --headless           # Server mode (no desktop shortcut)
#   bash deploy/linux/install-linux.sh --install-clis       # Also install Claude/Codex/Gemini CLIs via npm
#   bash deploy/linux/install-linux.sh --port 8010          # Custom port (forwarded to install.sh)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

INSTALL_DESKTOP="auto"
INSTALL_CLIS=0
FORWARD_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --desktop)       INSTALL_DESKTOP="yes"; shift ;;
        --headless)      INSTALL_DESKTOP="no"; shift ;;
        --install-clis)  INSTALL_CLIS=1; shift ;;
        -h|--help)
            cat <<'EOF'
PGA Linux 一键安装器

用法:
  bash deploy/linux/install-linux.sh [选项]

选项:
  --desktop         强制安装 Linux 桌面图标 (~/.local/share/applications/pga.desktop) 与 pga-desktop 命令
  --headless        纯服务器模式（不注册桌面图标）
  --install-clis    顺手通过 npm 安装官方 CLI（claude / codex / gemini）
  --port PORT       指定监听端口（默认 8000）
  --no-service      仅安装与迁移数据库，不注册 systemd 服务
  --database-url U  使用已有 PostgreSQL（跳过 Docker Postgres）
  --check           仅检查环境依赖，不修改文件
EOF
            exit 0
            ;;
        *)
            FORWARD_ARGS+=("$1")
            shift
            ;;
    esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "提示：当前系统不是 Linux（$(uname -s)）。如在 macOS 请直接运行 bash install.sh。" >&2
    exit 1
fi

distro_hint() {
    if command -v apt-get >/dev/null 2>&1; then
        echo "  sudo apt-get update && sudo apt-get install -y python3 python3-venv python3-pip git docker.io docker-compose-v2"
    elif command -v dnf >/dev/null 2>&1; then
        echo "  sudo dnf install -y python3 python3-pip git docker docker-compose-plugin"
    elif command -v pacman >/dev/null 2>&1; then
        echo "  sudo pacman -S --needed python git docker docker-compose"
    else
        echo "  请通过系统包管理器安装 Python 3.11+（含 venv/pip）、Git 与 Docker Compose。"
    fi
}

echo "==> [1/3] 检查 Linux 基础依赖…"
MISSING=0
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
    echo "缺少 Python 3.11+" >&2
    MISSING=1
fi
if ! command -v git >/dev/null 2>&1; then
    echo "缺少 git" >&2
    MISSING=1
fi
if [[ $MISSING -ne 0 ]]; then
    echo "可运行以下命令补齐依赖：" >&2
    distro_hint >&2
    exit 1
fi

echo "==> [2/3] 安装 PGA 后端、数据库与 systemd 服务…"
bash "$REPO_DIR/install.sh" "${FORWARD_ARGS[@]}"

if [[ $INSTALL_CLIS -eq 1 ]]; then
    echo "==> 正在安装官方 Agent CLI（claude / codex / gemini）…"
    if ! command -v npm >/dev/null 2>&1; then
        echo "未找到 npm，跳过 CLI 安装。请先安装 Node.js 20+ 后手动运行：" >&2
        echo "  npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli" >&2
    else
        NPM_PREFIX="${HOME}/.npm-global"
        mkdir -p "$NPM_PREFIX"
        npm config set prefix "$NPM_PREFIX" >/dev/null 2>&1 || true
        PATH="$NPM_PREFIX/bin:$PATH" npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli
        echo "CLI 已安装到 $NPM_PREFIX/bin（PGA 已内置自动探测该目录）。"
    fi
fi

SHOULD_DESKTOP=0
if [[ "$INSTALL_DESKTOP" == "yes" ]]; then
    SHOULD_DESKTOP=1
elif [[ "$INSTALL_DESKTOP" == "auto" && ( -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ) ]]; then
    SHOULD_DESKTOP=1
fi

if [[ $SHOULD_DESKTOP -eq 1 ]]; then
    echo "==> [3/3] 注册 Linux 桌面启动器与图标…"
    bash "$REPO_DIR/desktop-linux/install-desktop.sh"
    echo "安装完成！可在应用菜单搜索 PGA，或终端运行：~/.local/bin/pga-desktop"
else
    echo "==> [3/3] 服务器/无界面模式，跳过桌面快捷方式（需要时可随时运行 bash desktop-linux/install-desktop.sh）。"
fi
