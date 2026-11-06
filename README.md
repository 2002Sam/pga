<div align="center">

**English** · [简体中文](README.zh-CN.md)

<img src="src/pga/web/icons/logo.png" width="160" alt="PGA witch cat logo" />

# PGA

**Personal Multi-Agent Workspace**

Keep your projects moving with multiple AI agents in one workspace.

[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?style=flat-square)](pyproject.toml)
[![License](https://img.shields.io/badge/License-Apache--2.0-8b5b78?style=flat-square)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/Deployment-Self--hosted-c39453?style=flat-square)](#quick-start)

[Features](#features) · [Quick start](#quick-start) · [Supported agents](#agents) · [Development](#development)

</div>

![PGA workspace: organize conversations by project and work with agents side by side](docs/media/screenshots/01-workspace.png)

PGA brings projects, conversations, files, and AI agents onto a shared workbench. Choose an agent yourself, or let a project manager break down your request and assign the work. Conversations, materials, and knowledge stay with the project so you can pick up where you left off.

Built for people who use several AI tools, work on long-running coding or research projects, and regularly compare sources and results.

> **Early development: actively evolving.** The web workspace is self-hosted, with an additional native floating-window app for macOS. Screenshots are captured directly from the current frontend using public demo data and show the Chinese UI. They contain no personal accounts or private conversations and do not demonstrate live model calls or measured performance. See [scripts/capture-readme.cjs](scripts/capture-readme.cjs).

<a id="features"></a>

## From a conversation to an ongoing project

### A workbench with room for multiple conversations

Each conversation has its own window. Read them side by side, resize them, or fold them away. The sidebar groups conversations by project, and a minimap at the top lets you jump between windows. Each window keeps its own draft, reading position, and working directory.

- **Move around:** use `Shift` + scroll to pan across the workbench, or click the minimap to jump to a window.
- **Fold and restore:** collapse a window, a category, or the entire workbench.
- **Attach context:** connect files, notes, and related conversations to a working window.
- **Save pages:** save the current arrangement as a page and restore windows, reading positions, and drafts when switching projects. Page snapshots are stored on the server.

<details>
<summary>View page management</summary>

![Page management: save the current workbench and switch to another set of conversations](docs/media/screenshots/02-pages.png)

</details>

### A manager for each project

Write a request in the manager document. PGA breaks it into tasks and assigns them using your agent preferences, available quotas, and current workloads. Progress appears as comments; click one to open the corresponding task conversation.

![Project manager: requests in the document, task progress in comments on the right](docs/media/screenshots/07-manager.png)

- Press `Enter` twice to submit a paragraph, or `⌘/Ctrl + Enter` to submit the entire draft.
- Open the knowledge graph, project conversation search, and document view from the manager's toolbar.
- Tasks that need existing context can reference recent messages from related conversations in the same category.
- When a tool execution or request clearly fails, PGA tries another agent in the fallback order. This does not automatically determine whether every answer is correct.

### Second opinion: one question, two approaches

Two agents answer side by side in the same window. They share the conversation history before the split, then maintain separate contexts. Send follow-up messages to both sides or continue with just one.

![Second opinion: compare two agents' answers in one window](docs/media/screenshots/03-second-opinion.png)

**Continue from here** creates a separate conversation from a selected point, carrying over only the context up to that point. Review and synthesis workflows are also available when you need more perspectives.

### Files next to the conversation

Open files produced by an agent without leaving the workspace. The file panel supports tabs, so you can read a response while reviewing or editing the result.

![File workspace: a conversation beside a Markdown document](docs/media/screenshots/06-files.png)

- Preview or edit Markdown, code, and text. The code editor uses a locally bundled Monaco Editor.
- Read images, PDFs, Word documents, spreadsheets, slides, and web pages. Some formats require optional conversion tools.
- Saving checks for external changes to the file. A basic text editor is available if the full editor cannot load.
- Local and generated images appear directly in responses; click to enlarge them.

### World Tree and project memory

Organize growing conversation histories into topics, explore summaries at different levels, and return to the original discussions. World Tree offers **3D constellation, 2D hierarchy, and relationship network** views.

![World Tree: a hierarchy of topics, subtopics, and conversations](docs/media/screenshots/04-world-tree.png)

PGA also includes document knowledge stores, a fact graph with timestamps and sources, Obsidian export, and classification and archiving suggestions that require individual approval. Generating topic summaries and extracting facts use the models you configure.

### Make the workspace your own

Six built-in styles support dark, light, and system appearance. Adjust font size, spacing, corners, and motion. Each agent has a profile with an avatar, description, standing instructions, specialties, and concurrency limits.

<details>
<summary>View appearance settings</summary>

![Appearance settings: six styles and adjustable interface preferences](docs/media/screenshots/05-appearance.png)

</details>

**macOS floating windows:** press `⌥ + Space` to open a floating conversation and `⌥ + ⇧ + Space` to switch between floating windows and the workbench. Drag files in from Finder. Build instructions are in [desktop/README.md](desktop/README.md).

<a id="quick-start"></a>

## Quick start

You need **macOS or Linux, Python 3.11+, Git**, and a running **Docker installation with Compose**. This installation path uses Docker only for PostgreSQL; you can also connect an existing database.

```bash
git clone https://github.com/2002Sam/pga.git
cd pga
bash install.sh
```

The installer checks prerequisites, creates a virtual environment, installs dependencies, initializes PostgreSQL, runs database migrations, and attempts to register a background service. The default address is **http://127.0.0.1:8000**.

1. Open the web interface. Configure a model API in **Settings**, or connect an installed and authenticated local agent in **Agents & connections**.
2. Create a project category and choose its working directory and permissions.
3. Open a conversation to start working. To delegate tasks, open the manager using `◎` beside the category.

New installations use the offline `fake` model so you can explore the interface first. Real conversations require a connected agent or configured model service. The manager uses DeepSeek to break down requests; if it is unavailable or times out, the full request is assigned as one task.

> **Remote deployment:** the API does not yet implement access authentication. It listens on localhost by default. Use an SSH tunnel for remote access rather than exposing the service port directly to the internet.
>
> ```bash
> ssh -N -L 8000:127.0.0.1:8000 user@server
> ```

<details>
<summary>Installer options, updates, and background services</summary>

| Command | Purpose |
|---|---|
| `bash install.sh --check` | Check prerequisites only |
| `bash install.sh --port 8080 --db-port 55433` | Choose ports for the first installation |
| `bash install.sh --no-service` | Install without registering a background service |
| `PGA_PYTHON=/path/to/python3.12 bash install.sh` | Choose a Python interpreter |
| `PGA_DATABASE_URL='postgresql+psycopg://user:pass@host:5432/pga' bash install.sh --database existing` | Use an existing PostgreSQL database |

The installer creates `.env`, `agents.yaml`, and `.pga-install/` and reuses them on subsequent runs. Keep the source directory in a stable location.

| Action | macOS | Linux user service |
|---|---|---|
| Stop | `launchctl bootout gui/$(id -u)/local.pga.agent` | `systemctl --user stop pga` |
| Restart | `launchctl kickstart -k gui/$(id -u)/local.pga.agent` | `systemctl --user restart pga` |
| Logs | `tail -f ../logs/pga.log` | `journalctl --user -u pga -f` |

On macOS, the background service starts after login and requires Docker to be ready. Linux requires an active user service session; configure `loginctl enable-linger` if it should continue after logout. Without a supported service manager, use `--no-service` and run the generated `.pga-install/run` script.

**Updating:** back up the database and configuration, stop the service, run `git pull --ff-only`, and run `bash install.sh` again.

</details>

<a id="agents"></a>

## Supported agents

PGA organizes collaboration; the agents and models you connect do the work. Accounts, subscriptions, and API usage are billed by their respective providers.

| Integration | Connection |
|---|---|
| Claude Code | Local CLI, persistent sessions, multiple accounts |
| Codex / ChatGPT | Local Codex app-server, multiple accounts, quota reporting |
| Gemini CLI | Local CLI, multiple accounts |
| Hermes Agent | Local API or CLI |
| WorkBuddy / CodeBuddy | Local CLI, persistent sessions |
| OpenCode | Local CLI |
| Custom agents | CLI processes or HTTP endpoints |

Model providers include Anthropic, OpenAI, DeepSeek, OpenRouter, Kimi, Qwen, Zhipu GLM, Ollama, and OpenAI-compatible endpoints. Available models and capabilities depend on the connected services and installed tool versions.

<details>
<summary>Configuration and data locations</summary>

| Setting | Purpose |
|---|---|
| `.env` | Database connection, model credentials, and listening address |
| `agents.yaml` | Agent types, commands, working directories, preferences, and concurrency |
| `models.yaml` | Model catalog and provider settings |
| `PGA_HOST` / `PGA_PORT` | Listening address / port |
| `PGA_DATABASE_URL` | PostgreSQL connection string |
| `PGA_LLM_PROVIDER` | Internal model provider; supports offline `fake` mode |
| `DEEPSEEK_API_KEY` | DeepSeek and manager task decomposition |
| `PGA_AGENTS_FILE` / `PGA_MODELS_FILE` | Custom configuration file locations |

By default, the installer places `workspaces/`, `state/`, `notes/`, `snapshots/`, and `logs/` alongside the repository directory. Some account, upload, and preview data lives under `~/Documents/PGA`; Obsidian exports default to `~/PGA Vault`. Include the database, configuration, and these directories in backups.

**Optional dependencies:** LibreOffice for some Office format conversions; Poppler's `pdftotext` for PDF attachments. Install each agent's CLI separately.

</details>

## Boundaries and current limitations

- Data is stored on your machine or server. Requests to remote models, search services, or agents send relevant content to those services. The web interface also loads some CDN resources.
- Project context boundaries and executor file permissions are separate mechanisms. Restricting project context is not a filesystem sandbox; choose read-only, automatic, or full-approval permissions to suit the task.
- Restoring a page restores its layout, reading positions, and drafts. It does not roll back the database or completed file operations.
- The installer supports macOS and Linux, with most day-to-day validation on macOS. Native floating windows are macOS-only; Windows has not been validated.
- The current distribution is installed from source. The root Compose file provides infrastructure, not a complete application deployment. A DMG installer and access authentication are planned.

<a id="development"></a>

## Development and contributing

The backend uses Python, FastAPI, SQLAlchemy, and PostgreSQL. The web interface uses plain HTML, CSS, and JavaScript. The macOS desktop shell uses Swift, AppKit, WebKit, and Svelte.

```text
src/pga/
├── agents/              # Agent connections, scheduling, quotas, and review
├── manager_dispatch.py  # Manager task decomposition and assignment
├── project_context.py   # Project context
├── worldtree.py         # Topic hierarchy
├── kg/ memory/ vault/   # Fact graph, memory, and knowledge export
├── api/                 # HTTP API
└── web/                 # Web interface and witch cat icons
desktop/                 # macOS floating windows
migrations/              # Database migrations
tests/                   # Python and JavaScript tests
scripts/                 # Installation, icons, and README screenshots
```

<details>
<summary>Local development and testing</summary>

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

Python tests require a separate PostgreSQL test database, configurable with `PGA_TEST_DATABASE_URL`. Live model tests are skipped by default. API documentation is available at `/docs`.

Build the desktop app:

```bash
cd desktop
./build.sh
```

This creates `desktop/build/PGA 浮窗.app`. Add `--install` to copy it to `~/Applications` and launch it.

</details>

Report problems through [Issues](https://github.com/2002Sam/pga/issues) or submit a pull request. Include reproduction steps, your operating system, and relevant tool versions. Remove credentials and private content before sharing logs or screenshots.

## Logo and screenshot assets

PGA's mascot is a witch cat. **Application icons use a close-up of the cat's head and hat; the full character serves as the mascot.**

- [Headshot source](docs/media/pga-witch-cat-head.png) · [Full character](docs/media/pga-witch-cat.png)
- [Web and desktop icons](src/pga/web/icons) · [Asset notes and screenshot reproduction (Chinese)](docs/media/README.md)
- Run `bash scripts/build-icons.sh` to generate favicon, PWA, Apple Touch, and macOS ICNS assets from the headshot source. Requires macOS.

## License and acknowledgments

PGA is licensed under [Apache License 2.0](LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for copied or modified code and its origins.

Thanks to Graphiti, Mixture-of-Agents, FastChat, and the open-source projects behind the interface, editor, and visualization tools.

<div align="center">
<sub>Building PGA with PGA.</sub>
</div>
