# 品牌与 README 素材

## 正式素材

- `pga-witch-cat.png`：用户选定的完整魔女猫形象。
- `pga-witch-cat-head.png`：透明背景的大头照，作为应用 Logo 的源图。
- `../../src/pga/web/icons/`：各尺寸 PNG 与 macOS `PGA.icns`。

头像使用内置 imagegen 从获选角色图编辑得到。核心指令：保留原图黑猫、慵懒眼神、歪帽和手绘质感，只保留头部与完整帽子，去掉身体和背景。用 `bash scripts/build-icons.sh` 生成不同尺寸；调整品牌时先更新源图，再执行脚本。

## 骑扫帚加载动画

- `pga-witch-cat-broom.png`：保留原角色神态与服装的骑扫帚姿态，透明背景，由内置 imagegen 生成。[完整提示词](witch-cat-broom-prompt.md)。
- `../../src/pga/web/icons/witch-cat-broom.webp`：网页实际使用的 960 像素宽素材，约 80 KB。
- [动画预览](pga-loading-preview.gif)：从当前加载页 CSS 动画采集的 3.6 秒循环，54 帧；仅用于文档预览，应用不加载该 GIF。
- 动效位于 `../../src/pga/web/app.css`，加载页结构位于 `../../src/pga/web/app.html`。CSS 驱动起伏飞行、轻微转动、风线和星光尾迹；图片本身是一帧角色素材。
- 保留首屏就绪后淡出、至少 1.6 秒、10 秒兜底的加载逻辑；内嵌对话不显示或请求该素材。系统减少动态效果、应用关闭动效时，角色静止展示。

网页素材转换命令（需要 `cwebp`）：

```bash
cwebp -q 88 -alpha_q 100 -m 6 -resize 960 0 docs/media/pga-witch-cat-broom.png -o src/pga/web/icons/witch-cat-broom.webp
```

## 界面截图

`screenshots/` 中的 7 张 PNG 来自当前 `src/pga/web/` 前端的 Chromium 实际渲染，分辨率为 1600 × 1000。截图内容使用脚本中明确编写的公开演示数据，API 在隔离进程内响应；不读取生产数据库、不调用模型、不修改用户配置。它们用于展示 UI，不作为模型能力、调用结果或性能的证据。

| 图片 | 内容 |
|---|---|
| `01-workspace.png` | 项目列表与并排对话 |
| `02-pages.png` | 页面快照与切换 |
| `03-second-opinion.png` | 双 Agent 独立对话 |
| `04-world-tree.png` | 世界树 2D 层级 |
| `05-appearance.png` | 外观设置 |
| `06-files.png` | 文件面板与 Markdown 预览 |
| `07-manager.png` | 管理员文档和任务批注 |

在仓库根目录运行：

```bash
npm install --prefix /tmp/pga-readme-tools playwright
NODE_PATH=/tmp/pga-readme-tools/node_modules node scripts/capture-readme.cjs
```

脚本优先使用 macOS 的 Google Chrome；也可通过 `CHROME_PATH` 指定 Chromium 可执行文件，或安装 Playwright Chromium 后使用它。界面仍按应用本身的方式加载字体、Markdown 和图谱等 CDN 资源，因此采集时需要网络。

发布到 README 的截图应先检查可读性、资源加载、空状态，以及是否出现私人资料。不要用生成式图片冒充产品截图。
