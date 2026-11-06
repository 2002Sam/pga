<div align="center">

[English](README.md) · **简体中文**

<img src="src/pga/web/icons/logo.png" width="160" alt="PGA 魔女猫 Logo" />

# PGA

**个人多智能体工作台 · Personal Multi-Agent Workspace**

在一个工作台里，与多个 AI 一起持续推进你的项目。

[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?style=flat-square)](pyproject.toml)
[![License](https://img.shields.io/badge/License-Apache--2.0-8b5b78?style=flat-square)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/部署-自托管-c39453?style=flat-square)](#quick-start)

[功能预览](#features) · [快速开始](#quick-start) · [支持的 Agent](#agents) · [开发与贡献](#development)

</div>

![PGA 工作台：按项目组织对话，与多个 Agent 并排工作](docs/media/screenshots/01-workspace.png)

PGA 把项目、对话、文件和多个 AI 接到同一张台面上。你可以自己指定 Agent，也可以把需求交给项目管理员拆分和分配；工作结束后，对话、资料和知识仍留在项目里，方便下一次接着做。

适合同时使用多个 AI、长期推进代码或研究项目，以及需要反复对照资料和结果的人。

> **当前阶段：早期版本，持续迭代。** 网页工作台支持自托管，macOS 另有原生浮窗。本文截图均由当前前端在浏览器中直接采集，使用公开演示数据；不包含个人账号、私人对话，也不代表真实模型调用或性能测试。截图脚本见 [scripts/capture-readme.cjs](scripts/capture-readme.cjs)。

<a id="features"></a>

## 从一段对话，到一个持续工作的项目

### 多窗口工作台

每段对话都有自己的窗口，可以并排阅读、调整宽度、折叠和恢复。左侧按项目收纳对话，顶部小地图提供快速跳转；窗口里的输入、阅读位置和工作目录各自独立。

- **横向浏览**：`Shift` + 滚轮移动台面；点击小地图定位窗口。
- **收起与恢复**：折叠单个窗口、整个分类或全部窗口。
- **引用资料**：把文件、笔记和相关对话接到工作窗口，明确要参考什么。
- **保存页面**：将当前排布存成页面，切换项目时恢复窗口、阅读位置和草稿。页面快照保存在服务端。

<details>
<summary>查看页面管理截图</summary>

![页面管理：保存当前台面，切换到另一组工作](docs/media/screenshots/02-pages.png)

</details>

### 项目管理员

把一段需求写进管理员文档，系统将它拆成任务，再结合 Agent 的偏好排序、可用额度和当前负载分配。任务进度以批注呈现，点击可以进入对应的处理对话。

![项目管理员：需求写在正文，任务进度显示在右侧](docs/media/screenshots/07-manager.png)

- 连按两次 `Enter` 发送一个段落，`⌘/Ctrl + Enter` 发送整篇草稿。
- 从管理员顶部进入知识图谱、项目对话检索和文档视图。
- 需要已有背景的任务，可引用本分类相关对话的最近记录。
- 工具执行或请求明显失败时，按备选顺序尝试其他 Agent；这不等于自动判断每个答案是否正确。

### 第二意见：同一问题，两种思路

两个 Agent 在同一个窗口并排作答。分屏前共享背景，分屏后各自延续上下文；后续输入可以同时发给两侧，也可以只选其中一侧。

![第二意见：在同一窗口对比两个 Agent 的回答](docs/media/screenshots/03-second-opinion.png)

**「从这里继续」是另一项功能**：从选定位置创建独立会话，保留截至该位置的上下文。需要更多视角时，还可以使用评审与合成工作流。

### 文件就放在对话旁边

打开 AI 生成的文件，不必离开工作台。文件面板支持多个标签页，可以一边读回答，一边查看和修改成果。

![文件工作区：对话与 Markdown 文档并排显示](docs/media/screenshots/06-files.png)

- Markdown、代码和文本支持预览或编辑；代码编辑器使用本地 Monaco。
- 支持图片、PDF、Word、表格、幻灯片和网页阅读，具体格式依赖可选转换工具。
- 保存文件时检查外部修改冲突；编辑器资源不可用时回退到基础文本编辑。
- 回答里的本地图片和生成图片可直接显示，点击查看大图。

### 世界树与项目记忆

把不断增长的对话组织成主题，逐层查看摘要，再回到具体讨论。世界树提供 **3D 星空、2D 层级、关系网** 三种视图。

![世界树：主题、子主题与对话的层级关系](docs/media/screenshots/04-world-tree.png)

还包括文档知识库、带时间与来源的事实图谱、Obsidian 导出，以及需逐条确认的归类和归档建议。生成主题摘要、事实抽取等操作会调用配置的模型。

### 你的工作方式，你的外观

六套内置外观支持深色、浅色和跟随系统；字体大小、间距、圆角和动效也能调整。Agent 有自己的资料页，可设置头像、简介、固定要求、擅长领域和并发上限。

<details>
<summary>查看外观设置截图</summary>

![外观设置：六套风格与可调整的界面参数](docs/media/screenshots/05-appearance.png)

</details>

**macOS 浮窗**：用 `⌥ + Space` 打开悬浮对话，`⌥ + ⇧ + Space` 在浮窗和工作台之间切换。支持从 Finder 拖入文件。构建方式见 [desktop/README.md](desktop/README.md)。

<a id="quick-start"></a>

## 快速开始

需要 **macOS 或 Linux、Python 3.11+、Git**，以及已启动且包含 Compose 的 **Docker**。Docker 在这条安装路径中只用于 PostgreSQL；也可以使用已有数据库。

```bash
git clone https://github.com/2002Sam/pga.git
cd pga
bash install.sh
```

安装器会检查环境、创建虚拟环境、安装依赖、初始化 PostgreSQL、执行数据库迁移，并尝试注册后台服务。默认访问地址：**http://127.0.0.1:8000**。

1. 打开网页，在「设置」中配置模型 API，或在「Agent 与连接」中接入已经安装并登录的本机 Agent。
2. 新建一个项目分类，选择工作文件夹和权限。
3. 打开一段对话开始工作；需要分工时，从分类旁的 `◎` 进入管理员。

新安装默认使用离线 `fake` 模型，可以先熟悉界面；真实问答需要连接 Agent 或配置模型服务。管理员的模型拆分使用 DeepSeek，未配置或超时时会回退到整段任务分配。

> **远程部署**：当前 API 尚未实现访问鉴权。默认仅监听本机，远程使用请通过 SSH 隧道访问，勿直接将服务端口暴露到公网。
>
> ```bash
> ssh -N -L 8000:127.0.0.1:8000 user@server
> ```

<details>
<summary>安装参数、更新与后台服务</summary>

| 命令 | 作用 |
|---|---|
| `bash install.sh --check` | 只检查环境 |
| `bash install.sh --port 8080 --db-port 55433` | 首次安装指定端口 |
| `bash install.sh --no-service` | 安装但不注册后台服务 |
| `PGA_PYTHON=/path/to/python3.12 bash install.sh` | 指定 Python 解释器 |
| `PGA_DATABASE_URL='postgresql+psycopg://user:pass@host:5432/pga' bash install.sh --database existing` | 使用已创建的 PostgreSQL 数据库 |

安装器生成 `.env`、`agents.yaml` 和 `.pga-install/`，再次运行会沿用配置。请把源码目录放在固定位置。

| 操作 | macOS | Linux 用户服务 |
|---|---|---|
| 停止 | `launchctl bootout gui/$(id -u)/local.pga.agent` | `systemctl --user stop pga` |
| 重启 | `launchctl kickstart -k gui/$(id -u)/local.pga.agent` | `systemctl --user restart pga` |
| 日志 | `tail -f ../logs/pga.log` | `journalctl --user -u pga -f` |

macOS 后台服务在用户登录后启动，Docker 也需要就绪。Linux 需要有效的用户服务会话；若要退出登录后继续运行，可配置 `loginctl enable-linger`。没有可用服务管理器时，使用 `--no-service`，再运行安装器生成的 `.pga-install/run`。

**更新**：先备份数据库和配置，停止服务，运行 `git pull --ff-only`，然后重新执行 `bash install.sh`。

</details>

<a id="agents"></a>

## 支持的 Agent

PGA 负责组织协作，执行能力来自你连接的 Agent 和模型。账号、订阅或 API 用量仍按对应服务计费。

| 接入 | 方式 |
|---|---|
| Claude Code | 本机命令行、常驻会话、多账号 |
| Codex / ChatGPT | 本机 Codex app-server、多账号与额度读取 |
| Gemini CLI | 本机命令行、多账号 |
| Hermes Agent | 本地 API 或命令行 |
| WorkBuddy / CodeBuddy | 本机命令行、常驻会话 |
| OpenCode | 本机命令行 |
| 自定义 Agent | 命令行进程或 HTTP 接口 |

模型服务支持 Anthropic、OpenAI、DeepSeek、OpenRouter、Kimi、通义千问、智谱 GLM、Ollama，以及 OpenAI 兼容接口。可用模型和具体能力以所连接服务及本机工具版本为准。

<details>
<summary>主要配置与数据位置</summary>

| 配置 | 用途 |
|---|---|
| `.env` | 数据库连接、模型凭证、监听地址 |
| `agents.yaml` | Agent 类型、命令、工作目录、偏好排序与并发设置 |
| `models.yaml` | 模型目录与服务配置 |
| `PGA_HOST` / `PGA_PORT` | 监听地址 / 端口 |
| `PGA_DATABASE_URL` | PostgreSQL 连接串 |
| `PGA_LLM_PROVIDER` | 内部模型提供者；支持 `fake` 离线模式 |
| `DEEPSEEK_API_KEY` | DeepSeek 与管理员拆分 |
| `PGA_AGENTS_FILE` / `PGA_MODELS_FILE` | 自定义配置文件位置 |

默认安装将工作区、状态、笔记、快照、日志放在仓库同级的 `workspaces/`、`state/`、`notes/`、`snapshots/`、`logs/`。部分账号、上传与预览数据位于 `~/Documents/PGA`；Obsidian 导出默认位于 `~/PGA Vault`。备份应包含数据库、配置和这些目录。

**可选依赖**：LibreOffice 用于部分 Office 格式转换；Poppler 的 `pdftotext` 用于读取 PDF 附件；各 Agent 的命令行工具需单独安装。

</details>

## 边界与当前限制

- 数据保存在自己的机器或服务器上；调用远程模型、搜索或 Agent 时，相关内容会交给对应服务。网页还会加载部分 CDN 资源。
- 项目上下文限定与执行器的文件权限是两层机制。项目范围限制不等同于磁盘沙箱；请按任务选择只读、自动或完全批准权限。
- 页面恢复的是排布、阅读位置和草稿，不是回滚数据库或已执行的文件操作。
- 安装器支持 macOS / Linux，日常验证以 macOS 为主。原生浮窗仅支持 macOS；Windows 尚未验证。
- 当前发布的是源码安装方式。根目录 Compose 只提供基础设施，不是完整应用的一键 Docker 部署；DMG 安装包与访问鉴权仍在计划中。

<a id="development"></a>

## 开发与贡献

后端是 Python / FastAPI / SQLAlchemy，数据库使用 PostgreSQL。网页由原生 HTML、CSS 和 JavaScript 组成；macOS 桌面壳使用 Swift、AppKit、WebKit 与 Svelte。

```text
src/pga/
├── agents/              # Agent 接入、调度、额度与评审
├── manager_dispatch.py  # 管理员拆分和分配任务
├── project_context.py   # 项目上下文
├── worldtree.py         # 主题层级
├── kg/ memory/ vault/   # 事实图谱、记忆和知识导出
├── api/                 # HTTP API
└── web/                 # 网页界面与魔女猫图标
desktop/                 # macOS 浮窗
migrations/              # 数据库迁移
tests/                   # Python 与 JavaScript 测试
scripts/                 # 安装、图标生成和 README 截图
```

<details>
<summary>本地开发与测试</summary>

```bash
docker compose up -d postgres
docker compose exec postgres createdb -U postgres pga_test
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
cp .env.example .env
alembic upgrade head
python -m pga
```

```bash
pytest
node --test tests/*.mjs
```

Python 测试需要独立的 PostgreSQL 测试数据库，可用 `PGA_TEST_DATABASE_URL` 指定。真实模型测试默认跳过。接口文档位于 `/docs`。

桌面构建：

```bash
cd desktop
./build.sh
```

生成 `desktop/build/PGA 浮窗.app`；加 `--install` 会复制到 `~/Applications` 并启动。

</details>

欢迎通过 [Issues](https://github.com/2002Sam/pga/issues) 反馈问题，或提交 Pull Request。报告问题时请附复现步骤、系统和工具版本；分享日志、截图前去掉凭证和私人内容。

## Logo 与截图素材

PGA 使用魔女猫作为品牌形象：**应用图标采用猫头与魔女帽的大头照，全身形象作为吉祥物。**

- [大头照源图](docs/media/pga-witch-cat-head.png) · [完整角色图](docs/media/pga-witch-cat.png)
- [网页与桌面图标](src/pga/web/icons) · [截图说明与复现方法](docs/media/README.md)
- `bash scripts/build-icons.sh` 从头像源图生成 favicon、PWA、Apple Touch 与 macOS ICNS 图标（需要 macOS）。

## 许可证与致谢

PGA 采用 [Apache License 2.0](LICENSE)。第三方组件保留各自许可证；复制或修改的代码来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

感谢 Graphiti、Mixture-of-Agents、FastChat，以及提供界面、编辑器和可视化能力的开源项目。

<div align="center">
<sub>用 PGA 构建 PGA。</sub>
</div>
