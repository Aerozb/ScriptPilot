# ScriptPilot

ScriptPilot 是一个 Windows 绿色便携版 NodeJS 脚本调度器，用来本机管理脚本、定时任务、环境变量、配置文件、订阅、依赖和运行日志。

## 直接使用

下载发布包后解压，目录结构应为：

```text
ScriptPilot.exe
app/
```

双击外层 `ScriptPilot.exe` 启动。程序数据、日志、缓存和依赖都会写入 `app/data`。

## 开发构建

```powershell
npm install
npm run dist:dir
```

构建产物位于：

```text
release/win-unpacked/
  ScriptPilot.exe
  app/
```

更多维护、API、验收和数据目录说明见 `docs/README.md`。
