# PGA Linux 部署与使用指南

支持 **一行命令远程一键部署**，提供两种开箱即用的运行方式：**本机一键版（推荐，最方便调用本机 CLI 与桌面窗口）** 和 **Docker 全栈版（适合云服务器 / 零本机 Python 依赖）**。

## 一行命令直接部署（无需手动 clone）

```bash
# 本机版（自动拉取到 ~/PGA/pga + PostgreSQL + systemd + 桌面图标）
curl -fsSL https://raw.githubusercontent.com/2002Sam/pga/main/deploy/linux/install-linux.sh | bash

# Docker 全栈版（零 Python/Node 环境依赖，适合云服务器）
curl -fsSL https://raw.githubusercontent.com/2002Sam/pga/main/deploy/linux/install-linux.sh | bash -s -- --docker

# 纯命令行服务器 + 自定义端口 + 顺手装官方 CLI
curl -fsSL https://raw.githubusercontent.com/2002Sam/pga/main/deploy/linux/install-linux.sh | bash -s -- --headless --port 8010 --install-clis
```

---

## 方式一：本地仓库一键安装（Ubuntu / Debian / Fedora / Arch）

前置依赖：Python 3.11+（含 `venv`/`pip`）、Git、Docker Compose（或已有 PostgreSQL）。

```bash
cd pga

# 1. 标准安装（含 PostgreSQL + 数据库迁移 + systemd 后台服务 + 桌面快捷方式）
bash deploy/linux/install-linux.sh

# 可选：安装的同时顺手装好 Claude Code / Codex / Gemini 官方 CLI
bash deploy/linux/install-linux.sh --install-clis

# 可选：纯命令行服务器模式（不装桌面图标，并指定端口）
bash deploy/linux/install-linux.sh --headless --port 8010
```

安装完成后：
- **网页访问**：`http://127.0.0.1:8000`（首次使用可直达 `http://127.0.0.1:8000/#model-settings` 配置 API Key 或一键接入 Gemini / Claude CLI）。
- **Linux 桌面独立窗口**：在应用菜单搜索 **PGA**，或终端执行 `pga-desktop`（详见 [desktop-linux/README.md](../../desktop-linux/README.md)）。
- **常用 systemd 命令**：
  ```bash
  systemctl --user status pga
  systemctl --user restart pga
  journalctl --user -u pga -f
  ```

---

## 方式二：Linux Docker 全栈一键部署（零 Python/Node 环境配置）

只需要本机装有 Docker Compose：

```bash
cd pga
docker compose -f deploy/linux/docker-compose.yml up -d --build
```

- 默认监听 `http://127.0.0.1:8000`（可通过 `PGA_PORT=8010 docker compose ...` 改端口）。
- 如需在容器里直接使用官方 CLI，可进入容器安装并登录：
  ```bash
  docker compose -f deploy/linux/docker-compose.yml exec pga npm install -g @google/gemini-cli @anthropic-ai/claude-code @openai/codex
  ```
- 所有工作区、数据库、笔记、快照和用户配置都保存在命名 Docker Volume 中，重建镜像不会丢数据。

---

## Linux 专属兼容说明
- **桌面通知**：已内置 `linux` 通知通道（基于 `notify-send`，安装 `libnotify-bin` / `libnotify` 即可）。
- **文档预览**：自动识别 Linux `soffice` / `libreoffice` 并直接使用系统 `fontconfig` 字体（如需中文 PDF/PPT 预览，建议安装 `libreoffice fonts-noto-cjk`）。
- **代码编辑器**：自动探测 `code-tunnel` / `code`（或通过环境变量 `PGA_CODE_CLI` 指定路径）。
- **独立 CLI 探测**：自动扫描 `PATH` 与 `/usr/local/bin`、`~/.local/bin`、`~/.npm-global/bin`，无需任何 macOS 桌面应用。
