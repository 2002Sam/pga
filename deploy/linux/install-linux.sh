#!/usr/bin/env bash
# One-command Linux installer for PGA (Ubuntu/Debian/Fedora/Arch).
# Works directly on a brand-new Linux machine via curl | bash (auto-installs missing system dependencies).
#
# Direct remote install (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/2002Sam/pga/main/deploy/linux/install-linux.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/2002Sam/pga/main/deploy/linux/install-linux.sh | bash -s -- --headless --port 8010
#   curl -fsSL https://raw.githubusercontent.com/2002Sam/pga/main/deploy/linux/install-linux.sh | bash -s -- --docker
#
# Local checkout usage:
#   bash deploy/linux/install-linux.sh                      # Native install + systemd + desktop shortcut (if GUI)
#   bash deploy/linux/install-linux.sh --headless           # Server mode (no desktop shortcut)
#   bash deploy/linux/install-linux.sh --install-clis       # Also install Claude/Codex/Gemini CLIs via npm
#   bash deploy/linux/install-linux.sh --docker             # Full-stack Docker Compose deployment
#   bash deploy/linux/install-linux.sh --port 8010          # Custom port
set -euo pipefail

PGA_REPO_URL="${PGA_REPO_URL:-https://github.com/2002Sam/pga.git}"
PGA_BRANCH="${PGA_BRANCH:-main}"
PGA_DIR="${PGA_DIR:-$HOME/PGA/pga}"

INSTALL_DESKTOP="auto"
INSTALL_CLIS=0
USE_DOCKER=0
AUTO_DEPS=1
CHECK_ONLY=0
SKIP_DOCKER_DEP=0
PORT_OVERRIDE=""
FORWARD_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --desktop)       INSTALL_DESKTOP="yes"; shift ;;
        --headless)      INSTALL_DESKTOP="no"; shift ;;
        --install-clis)  INSTALL_CLIS=1; shift ;;
        --docker)        USE_DOCKER=1; shift ;;
        --no-auto-deps)  AUTO_DEPS=0; shift ;;
        --check)
            CHECK_ONLY=1
            AUTO_DEPS=0
            FORWARD_ARGS+=("$1")
            shift
            ;;
        --database)
            [[ $# -ge 2 ]] || { echo "--database 需要指定 auto/docker/existing" >&2; exit 2; }
            [[ "$2" == "existing" ]] && SKIP_DOCKER_DEP=1
            FORWARD_ARGS+=("$1" "$2")
            shift 2
            ;;
        --database-url)
            [[ $# -ge 2 ]] || { echo "--database-url 需要指定数据库连接串" >&2; exit 2; }
            SKIP_DOCKER_DEP=1
            export PGA_DATABASE_URL="$2"
            FORWARD_ARGS+=("--database" "existing")
            shift 2
            ;;
        --dir)
            [[ $# -ge 2 ]] || { echo "--dir 需要指定安装目录路径" >&2; exit 2; }
            PGA_DIR="$2"
            shift 2
            ;;
        --port)
            [[ $# -ge 2 ]] || { echo "--port 需要指定端口号" >&2; exit 2; }
            PORT_OVERRIDE="$2"
            FORWARD_ARGS+=("$1" "$2")
            shift 2
            ;;
        -h|--help)
            cat <<'EOF'
PGA Linux 一键安装器（支持在新 Linux 电脑上通过 curl | bash 一行直接部署）

远程一行部署（新机器直接粘贴）:
  curl -fsSL https://raw.githubusercontent.com/2002Sam/pga/main/deploy/linux/install-linux.sh | bash
  curl -fsSL https://raw.githubusercontent.com/2002Sam/pga/main/deploy/linux/install-linux.sh | bash -s -- --docker
  curl -fsSL https://raw.githubusercontent.com/2002Sam/pga/main/deploy/linux/install-linux.sh | bash -s -- --headless --port 8010

本地仓库用法:
  bash deploy/linux/install-linux.sh [选项]

选项:
  --docker          使用 Docker 全栈部署（PostgreSQL + PGA 容器，零本机 Python 依赖）
  --dir PATH        指定源码克隆/安装目录（默认 ~/PGA/pga，也可用 PGA_DIR 环境变量）
  --desktop         强制安装 Linux 桌面图标 (~/.local/share/applications/pga.desktop) 与 pga-desktop 命令
  --headless        纯服务器模式（不注册桌面图标）
  --install-clis    顺手通过 npm 安装官方 CLI（claude / codex / gemini）
  --port PORT       指定监听端口（默认 8000）
  --no-service      仅安装与迁移数据库，不注册 systemd 服务
  --no-auto-deps    不自动调用系统包管理器安装缺失依赖
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

run_root() {
    if [[ "$(id -u)" -eq 0 ]]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        echo "需要 root 或 sudo 权限来自动安装系统依赖，请先以 root 执行或安装 sudo。" >&2
        return 1
    fi
}

distro_hint() {
    if command -v apt-get >/dev/null 2>&1; then
        echo "  sudo apt-get update && sudo apt-get install -y python3 python3-venv python3-pip git docker.io docker-compose-v2 libnotify-bin poppler-utils"
    elif command -v dnf >/dev/null 2>&1; then
        echo "  sudo dnf install -y python3 python3-pip git docker docker-compose-plugin libnotify poppler-utils"
    elif command -v pacman >/dev/null 2>&1; then
        echo "  sudo pacman -S --needed python git docker docker-compose libnotify poppler"
    else
        echo "  请通过系统包管理器安装 Python 3.11+（含 venv/pip）、Git 与 Docker Compose。"
    fi
}

find_python_ready() {
    local cand
    for cand in "${PGA_PYTHON:-}" python3 /usr/bin/python3 python3.13 python3.12 python3.11; do
        [[ -n "$cand" ]] || continue
        if command -v "$cand" >/dev/null 2>&1 &&
            "$cand" -c 'import sys, venv, ensurepip; sys.exit(sys.version_info < (3, 11))' >/dev/null 2>&1; then
            command -v "$cand"
            return 0
        fi
    done
    return 1
}

has_python_ready() {
    local found
    if found="$(find_python_ready)"; then
        export PGA_PYTHON="$found"
        return 0
    fi
    return 1
}

has_docker_compose() {
    command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

need_docker() {
    [[ $USE_DOCKER -eq 1 ]] && return 0
    [[ $SKIP_DOCKER_DEP -eq 0 && -z "${PGA_DATABASE_URL:-}" ]]
}

auto_install_deps() {
    echo "==> 检测到缺失系统依赖，正在自动安装（可能需要输入 sudo 密码）…"
    if command -v apt-get >/dev/null 2>&1; then
        if ! run_root apt-get update; then
            echo "警告：部分第三方 apt 源更新失败（如缺失公钥），已忽略并继续从可用源安装依赖…" >&2
        fi
        local pkgs=(git curl ca-certificates libnotify-bin poppler-utils)
        if [[ $USE_DOCKER -eq 0 ]]; then
            pkgs+=(python3 python3-venv python3-pip)
        fi
        if need_docker; then
            if apt-cache show docker-compose-v2 >/dev/null 2>&1; then
                pkgs+=(docker.io docker-compose-v2)
            elif apt-cache show docker-compose-plugin >/dev/null 2>&1; then
                pkgs+=(docker.io docker-compose-plugin)
            else
                pkgs+=(docker.io)
            fi
        fi
        run_root apt-get install -y "${pkgs[@]}"
        if need_docker && ! has_docker_compose; then
            echo "==> 当前 apt 源未包含 docker compose v2 插件，尝试通过官方脚本补装 Docker Compose…"
            curl -fsSL https://get.docker.com | run_root sh
        fi
    elif command -v dnf >/dev/null 2>&1; then
        local pkgs=(git curl libnotify poppler-utils)
        if [[ $USE_DOCKER -eq 0 ]]; then
            pkgs+=(python3 python3-pip)
        fi
        if need_docker; then
            pkgs+=(docker docker-compose-plugin)
        fi
        run_root dnf install -y "${pkgs[@]}"
    elif command -v pacman >/dev/null 2>&1; then
        local pkgs=(git curl libnotify poppler)
        if [[ $USE_DOCKER -eq 0 ]]; then
            pkgs+=(python)
        fi
        if need_docker; then
            pkgs+=(docker docker-compose)
        fi
        run_root pacman -Sy --noconfirm --needed "${pkgs[@]}"
    else
        echo "无法识别当前 Linux 包管理器，请手动安装依赖：" >&2
        distro_hint >&2
        return 1
    fi
}

ensure_docker_running() {
    if ! need_docker; then
        return 0
    fi
    if ! docker info >/dev/null 2>&1; then
        if command -v systemctl >/dev/null 2>&1; then
            run_root systemctl enable --now docker >/dev/null 2>&1 || true
        elif command -v service >/dev/null 2>&1; then
            run_root service docker start >/dev/null 2>&1 || true
        fi
    fi
    if [[ "$(id -u)" -ne 0 ]] && ! docker info >/dev/null 2>&1 && run_root docker info >/dev/null 2>&1; then
        if ! id -nG "$USER" | grep -qw docker; then
            echo "==> 将当前用户 $USER 加入 docker 组…"
            run_root usermod -aG docker "$USER"
        fi
    fi
}

# Detect local repo checkout vs curl | bash remote execution
REPO_DIR=""
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_SOURCE" && -f "$SCRIPT_SOURCE" ]]; then
    CANDIDATE_DIR="$(cd -- "$(dirname -- "$SCRIPT_SOURCE")/../.." && pwd)"
    if [[ -f "$CANDIDATE_DIR/install.sh" && -f "$CANDIDATE_DIR/pyproject.toml" ]]; then
        REPO_DIR="$CANDIDATE_DIR"
    fi
fi

echo "==> [1/3] 检查 Linux 基础依赖…"
NEED_INSTALL=0
if ! command -v git >/dev/null 2>&1; then
    NEED_INSTALL=1
fi
if [[ $USE_DOCKER -eq 0 ]] && ! has_python_ready; then
    NEED_INSTALL=1
fi
if need_docker && ! has_docker_compose; then
    NEED_INSTALL=1
fi

if [[ $NEED_INSTALL -eq 1 && $AUTO_DEPS -eq 1 ]]; then
    auto_install_deps
fi

if [[ $CHECK_ONLY -eq 0 ]]; then
    ensure_docker_running
fi

MISSING=0
if ! command -v git >/dev/null 2>&1; then
    echo "缺少 git" >&2
    MISSING=1
fi
if [[ $USE_DOCKER -eq 0 ]] && ! has_python_ready; then
    echo "缺少 Python 3.11+（含 python3-venv 与 pip）" >&2
    MISSING=1
fi
if need_docker && ! has_docker_compose; then
    echo "缺少 docker 或 docker compose v2 插件" >&2
    MISSING=1
fi
if [[ $MISSING -ne 0 ]]; then
    echo "可运行以下命令补齐依赖：" >&2
    distro_hint >&2
    exit 1
fi

if [[ -z "$REPO_DIR" ]]; then
    echo "==> 获取 PGA 源码到 $PGA_DIR …"
    if [[ -d "$PGA_DIR/.git" ]]; then
        git -C "$PGA_DIR" pull --ff-only
    else
        mkdir -p "$(dirname -- "$PGA_DIR")"
        git clone --branch "$PGA_BRANCH" "$PGA_REPO_URL" "$PGA_DIR"
    fi
    REPO_DIR="$PGA_DIR"
fi

# Helper to run a command with docker group access even if usermod was just applied in this session
run_with_docker_access() {
    if docker info >/dev/null 2>&1; then
        "$@"
    elif [[ "$(id -u)" -ne 0 ]] && command -v sg >/dev/null 2>&1 && getent group docker 2>/dev/null | grep -qw "$USER"; then
        local cmd_str
        cmd_str="$(printf '%q ' "$@")"
        sg docker -c "$cmd_str"
    else
        run_root "$@"
    fi
}

if [[ $USE_DOCKER -eq 1 ]]; then
    echo "==> [2/3] 准备 Docker 全栈配置…"
    ENV_FILE="$REPO_DIR/deploy/linux/.env"
    if [[ ! -f "$ENV_FILE" ]]; then
        RAND_PW="$(openssl rand -hex 16 2>/dev/null || dd if=/dev/urandom bs=16 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')"
        RAND_PW="${RAND_PW:-pga_change_me_now}"
        cat > "$ENV_FILE" <<EOF
PGA_PORT=${PORT_OVERRIDE:-8000}
POSTGRES_USER=pga
POSTGRES_PASSWORD=${RAND_PW}
POSTGRES_DB=pga
PGA_LLM_PROVIDER=fake
DEEPSEEK_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
EOF
        chmod 600 "$ENV_FILE"
    elif [[ -n "$PORT_OVERRIDE" ]]; then
        if grep -q '^PGA_PORT=' "$ENV_FILE"; then
            sed -i.bak "s/^PGA_PORT=.*/PGA_PORT=${PORT_OVERRIDE}/" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
        else
            echo "PGA_PORT=${PORT_OVERRIDE}" >> "$ENV_FILE"
        fi
    fi

    echo "==> [3/3] 启动 PostgreSQL + PGA Docker 全栈服务…"
    run_with_docker_access docker compose --env-file "$ENV_FILE" -f "$REPO_DIR/deploy/linux/docker-compose.yml" up -d --build
    FINAL_PORT="$(grep -E '^PGA_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || echo "${PORT_OVERRIDE:-8000}")"
    FINAL_PORT="${FINAL_PORT:-8000}"
    echo "Docker 全栈部署完成！"
    echo "  网页访问：http://127.0.0.1:${FINAL_PORT}"
    echo "  模型与 API 配置：http://127.0.0.1:${FINAL_PORT}/#model-settings"
    echo "  查看日志：docker compose -f \"$REPO_DIR/deploy/linux/docker-compose.yml\" logs -f pga"
    exit 0
fi

echo "==> [2/3] 安装 PGA 后端、数据库与 systemd 服务…"
if need_docker && ! docker info >/dev/null 2>&1 && [[ "$(id -u)" -ne 0 ]] && command -v sg >/dev/null 2>&1; then
    CMD_STR="$(printf '%q ' bash "$REPO_DIR/install.sh" ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"})"
    sg docker -c "$CMD_STR"
else
    bash "$REPO_DIR/install.sh" ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}
fi

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
    echo "==> [3/3] 服务器/无界面模式，跳过桌面快捷方式（需要时可随时运行 bash \"$REPO_DIR/desktop-linux/install-desktop.sh\"）。"
fi
