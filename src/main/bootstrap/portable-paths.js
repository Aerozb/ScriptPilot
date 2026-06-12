import path from 'node:path';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AppError } from '../shared/errors/app-error.js';

const DATA_README = `# ScriptPilot data 目录说明

这个目录是 ScriptPilot 绿色版的全部数据目录。程序控制的数据、配置、日志、缓存、依赖和 Electron 会话数据都写在这里，移动或备份整个软件目录时请一起保留本目录。

## 目录用途

| 路径 | 用途 | 是否可清理 |
| --- | --- | --- |
| configs/ | 配置文件，例如 config.sh、extra.sh、notify.js、.npmrc。 | 不建议随意删除，会影响脚本配置。 |
| scripts/ | 用户脚本、任务脚本和订阅拉取后可执行的脚本。 | 不建议删除，除非确认脚本不再需要。 |
| scripts/tasks/ | 从定时任务弹窗里直接填写内容时自动保存的脚本。 | 不建议删除，对应任务会找不到脚本。 |
| scripts/api/ | 通过本机 API 传入 scriptContent 时临时落盘的脚本。 | 可按需清理历史接口脚本。 |
| repo/ | 按青龙 ql repo 方式保存内置 Git clone 后的订阅仓库缓存。 | 可清理，之后重新运行订阅会再次拉取。 |
| raw/ | 按青龙 ql raw 方式保存单文件订阅的原始文件。 | 可清理，之后重新运行订阅会再次下载。 |
| logs/ | 运行日志和应用日志总目录。 | 可清理旧日志。 |
| logs/tasks/ | 定时任务、手动运行、API 运行产生的 stdout/stderr 日志。 | 可清理旧日志，但日志管理里将无法查看。默认会定期清理超过 30 天的运行日志。 |
| logs/app/ | Electron 应用日志。 | 可清理旧日志。 |
| state/ | 任务、运行记录、设置、环境变量、订阅和依赖历史等 JSON 数据。 | 不建议删除，会重置业务数据。 |
| state/settings.json | 外观、分页、视图等设置。默认亮色青龙绿。 | 删除后会恢复默认设置。 |
| state/tasks.json | 定时任务列表。 | 删除后任务会丢失。 |
| state/runs.json | 运行记录索引。 | 删除后日志列表会丢失历史记录。 |
| state/log-cleanup-state.json | 最近一次日志清理结果，包括清理时间、截止时间、删除数量。 | 可清理，下次清理会重新生成。 |
| state/envs.json | 环境变量。 | 删除后环境变量会丢失。 |
| state/subscriptions.json | 订阅管理数据。 | 删除后订阅会丢失。 |
| state/dependency-history.json | 手动安装/卸载依赖的记录。 | 可清理。 |
| node_modules/ | 自动安装和手动安装的 npm 依赖。 | 可清理，脚本下次需要时会重新安装。 |
| package.json / package-lock.json | data/node_modules 对应的 npm 依赖清单。 | 可清理，但依赖版本锁定会丢失。 |
| cache/npm/ | npm 下载缓存。 | 可清理，会影响下次安装速度。 |
| cache/xdg/ | 脚本运行环境的 XDG 缓存。 | 可清理。 |
| tmp/ | 临时文件目录，脚本进程的 TEMP/TMP/TMPDIR 都指向这里。 | 可清理。 |
| home/ | 脚本进程的 HOME/USERPROFILE 重定向目录。 | 可清理前先确认脚本是否保存过数据。 |
| profile/ | 脚本进程的 APPDATA/LOCALAPPDATA 重定向目录。 | 可清理前先确认脚本是否保存过数据。 |
| electron-user-data/ | Electron 的 userData 目录。 | 可清理，会重置部分窗口/内部状态。 |
| session/ | Electron 会话、缓存、Local Storage、网络状态。 | 可清理，会重建缓存。 |
| crash-dumps/ | Electron 崩溃转储。 | 可清理。 |

## 绿色版约定

- ScriptPilot 自身只把数据写入安装目录下的 data。
- 脚本运行时会把 TEMP、TMP、TMPDIR、HOME、USERPROFILE、APPDATA、LOCALAPPDATA、XDG_CACHE_HOME、npm 缓存和 npm 安装前缀重定向到本目录。
- 路径选择和脚本执行会拒绝安装目录外的脚本路径或工作目录。
- 日志清理默认启用，每 3 天检查一次，清理超过 30 天的运行日志；系统设置里修改后会自动保存并实时生效，也可手动立即清理。
- 如果用户脚本主动写入外部绝对路径，例如 C:\\\\temp\\\\x.txt，Windows 不会自动拦截；这属于脚本自身行为。
`;

export function getPortableRoot(explicitRoot = undefined) {
  const root = explicitRoot || process.env.SCRIPTPILOT_PORTABLE_ROOT || process.cwd();
  return path.resolve(root);
}

export function createPortablePaths(explicitRoot = undefined) {
  const portableRoot = getPortableRoot(explicitRoot);
  const dataRoot = path.join(portableRoot, 'data');

  return {
    portableRoot,
    dataRoot,
    runtimeRoot: path.join(portableRoot, 'runtime'),
    scriptsRoot: path.join(dataRoot, 'scripts'),
    repoRoot: path.join(dataRoot, 'repo'),
    rawRoot: path.join(dataRoot, 'raw'),
    logsRoot: path.join(dataRoot, 'logs'),
    taskLogsRoot: path.join(dataRoot, 'logs', 'tasks'),
    cacheRoot: path.join(dataRoot, 'cache'),
    tmpRoot: path.join(dataRoot, 'tmp'),
    homeRoot: path.join(dataRoot, 'home'),
    appDataRoot: path.join(dataRoot, 'profile', 'AppData', 'Roaming'),
    localAppDataRoot: path.join(dataRoot, 'profile', 'AppData', 'Local'),
    appStateRoot: path.join(dataRoot, 'state'),
    tasksJson: path.join(dataRoot, 'state', 'tasks.json'),
    runsJson: path.join(dataRoot, 'state', 'runs.json'),
    settingsJson: path.join(dataRoot, 'state', 'settings.json')
  };
}

export async function ensurePortableDirectories(paths) {
  const dirs = [
    paths.dataRoot,
    path.join(paths.dataRoot, 'configs'),
    paths.scriptsRoot,
    paths.repoRoot,
    paths.rawRoot,
    paths.logsRoot,
    paths.taskLogsRoot,
    paths.cacheRoot,
    paths.tmpRoot,
    paths.homeRoot,
    paths.appDataRoot,
    paths.localAppDataRoot,
    path.join(paths.cacheRoot, 'npm'),
    path.join(paths.cacheRoot, 'xdg'),
    paths.appStateRoot
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  await writeDataReadme(paths);
  await assertWritable(paths.dataRoot);
}

async function writeDataReadme(paths) {
  await writeFile(path.join(paths.dataRoot, 'README.md'), DATA_README, 'utf8');
}

export async function assertWritable(dir) {
  await access(dir, constants.W_OK);
}

export function resolvePortablePath(paths, inputPath, options = {}) {
  if (!inputPath || typeof inputPath !== 'string') {
    return undefined;
  }

  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(paths.portableRoot, inputPath);
  const root = options.root === 'data' ? paths.dataRoot : paths.portableRoot;

  assertInsidePath(root, resolved, options.label || '路径');
  return resolved;
}

export function toPortablePath(paths, absolutePath, options = {}) {
  const normalized = path.resolve(absolutePath);
  assertInsidePath(paths.portableRoot, normalized, options.label || '路径');
  const relative = path.relative(paths.portableRoot, normalized);

  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.replaceAll(path.sep, '/');
  }

  return normalized;
}

export function assertInsidePath(root, targetPath, label = '路径') {
  const relative = path.relative(path.resolve(root), path.resolve(targetPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('PATH_OUTSIDE_PORTABLE_ROOT', `${label}必须位于安装目录内`, {
      root: path.resolve(root),
      path: path.resolve(targetPath)
    });
  }
}

export function createPortableProcessEnv(paths, extraEnv = {}, baseEnv = process.env) {
  const cacheNpmRoot = path.join(paths.cacheRoot, 'npm');
  const cacheXdgRoot = path.join(paths.cacheRoot, 'xdg');
  const npmUserConfigPath = path.join(paths.dataRoot, 'configs', '.npmrc');
  return {
    ...baseEnv,
    ...(extraEnv || {}),
    SCRIPTPILOT_PORTABLE_ROOT: paths.portableRoot,
    SCRIPTPILOT_DATA_ROOT: paths.dataRoot,
    TMP: paths.tmpRoot,
    TEMP: paths.tmpRoot,
    TMPDIR: paths.tmpRoot,
    HOME: paths.homeRoot,
    USERPROFILE: paths.homeRoot,
    APPDATA: paths.appDataRoot,
    LOCALAPPDATA: paths.localAppDataRoot,
    XDG_CACHE_HOME: cacheXdgRoot,
    QL_DIR: paths.portableRoot,
    QL_DATA_DIR: paths.dataRoot,
    QL_NODE_GLOBAL_PATH: path.join(paths.dataRoot, 'node_modules'),
    npm_config_cache: cacheNpmRoot,
    npm_config_prefix: paths.dataRoot,
    npm_config_userconfig: npmUserConfigPath,
    npm_config_update_notifier: 'false'
  };
}
