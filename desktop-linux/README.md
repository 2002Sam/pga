# PGA Linux 桌面端

面向 Ubuntu / Debian / Fedora / Arch 等 Linux 桌面的轻量独立应用启动器：

- 启动时自动检测本机 PGA 服务（`/healthz`）；未运行时自动尝试 `systemctl --user start pga.service` 或 `.pga-install/run` 拉起；
- 按优先级用独立桌面窗口打开完整版 PGA 工作台：
  1. 原生 GTK / Qt WebView（若本机装了 `pip install pywebview`）
  2. Chrome / Chromium / Edge / Brave 独立无地址栏应用窗口（`--app=` + 独立 `StartupWMClass=PGA` 图标）
  3. 系统默认浏览器（`xdg-open`）
- 自动注册 `~/.local/share/applications/pga.desktop` 和 `~/.local/bin/pga-desktop`，可直接从 GNOME / KDE 应用菜单启动并固定到 Dock，右键菜单支持一键直达「模型与 API 设置」。

## 安装桌面图标与命令

```bash
bash desktop-linux/install-desktop.sh
```

## 常用命令

```bash
pga-desktop                  # 启动/呼出 PGA 独立窗口
pga-desktop --models         # 直接打开「模型与 API」配置弹窗
pga-desktop --port 8010      # 连接指定端口
pga-desktop --check          # 检查服务健康状态与窗口后端
pga-desktop --uninstall-desktop   # 卸载桌面图标与启动命令
```
