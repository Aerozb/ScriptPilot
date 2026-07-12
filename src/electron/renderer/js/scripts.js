// 脚本管理页：树形列表、编辑器、批量操作；树构建工具同时被任务脚本选择器复用。
import { api, els, state } from './context.js';
import { clamp, escapeAttr, escapeHtml, formatBytes, formatError, keepExistingSelection, readValue, toggleSet } from './utils.js';
import { confirmAction, openPortableDirectory, renderMetrics, toast } from './ui.js';
import { refreshTasksAndRuns } from './data.js';
import { renderRuns, showRunLog } from './runs.js';
import { showPage } from './app.js';

export const SCRIPT_FILE_EXTENSIONS = ['.js', '.mjs', '.cjs'];

let scriptSplitResize;

export function bindScripts() {
  els.newScriptButton.addEventListener('click', () => newScript());
  els.openScriptsDirButton.addEventListener('click', () => openPortableDirectory('data/scripts'));
  els.openCurrentScriptDirButton.addEventListener('click', () => openCurrentScriptDirectory());
  els.saveScriptButton.addEventListener('click', () => saveCurrentScript());
  els.runScriptFileButton.addEventListener('click', () => runCurrentScript());
  els.deleteScriptButton.addEventListener('click', () => deleteCurrentScript());
  els.selectAllScriptsInput.addEventListener('change', () => toggleAllScripts(els.selectAllScriptsInput.checked));
  els.scriptList.addEventListener('click', handleScriptListClick);
  els.scriptList.addEventListener('change', handleScriptListChange);
  els.batchRunScriptsButton.addEventListener('click', () => batchRunScripts());
  els.batchDeleteScriptsButton.addEventListener('click', () => batchDeleteScripts());
  els.clearScriptSelectionButton.addEventListener('click', () => clearScriptSelection());
  initScriptSplitResize();
}

function initScriptSplitResize() {
  if (!els.scriptSplit || !els.scriptSplitResizer) return;
  const savedWidth = Number(localStorage.getItem('scriptPilot.scriptListWidth'));
  if (Number.isFinite(savedWidth) && savedWidth >= 220) {
    setScriptListWidth(savedWidth);
  }

  els.scriptSplitResizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const rect = els.scriptSplit.getBoundingClientRect();
    scriptSplitResize = {
      pointerId: event.pointerId,
      left: rect.left,
      width: rect.width
    };
    els.scriptSplitResizer.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-script-list');
  });

  els.scriptSplitResizer.addEventListener('pointermove', (event) => {
    if (!scriptSplitResize || scriptSplitResize.pointerId !== event.pointerId) return;
    const nextWidth = clamp(event.clientX - scriptSplitResize.left, 220, Math.min(620, scriptSplitResize.width - 360));
    setScriptListWidth(nextWidth);
  });

  const finishResize = (event) => {
    if (!scriptSplitResize || scriptSplitResize.pointerId !== event.pointerId) return;
    const width = Number.parseInt(getComputedStyle(els.scriptSplit).getPropertyValue('--script-list-width'), 10);
    if (Number.isFinite(width)) localStorage.setItem('scriptPilot.scriptListWidth', String(width));
    scriptSplitResize = undefined;
    document.body.classList.remove('resizing-script-list');
  };
  els.scriptSplitResizer.addEventListener('pointerup', finishResize);
  els.scriptSplitResizer.addEventListener('pointercancel', finishResize);
}

function setScriptListWidth(width) {
  els.scriptSplit.style.setProperty('--script-list-width', `${Math.round(width)}px`);
}

export async function refreshScripts() {
  const scripts = await api.listScripts();
  state.scripts = scripts.items || [];
  state.selectedScriptPaths = keepExistingSelection(state.selectedScriptPaths, state.scripts.map((item) => item.path));
  renderMetrics();
  renderScripts();
}

export function renderScripts() {
  updateScriptButtons();
  if (!state.scripts.length) {
    els.scriptList.innerHTML = '<div class="empty">暂无脚本文件</div>';
    if (els.selectAllScriptsInput) {
      els.selectAllScriptsInput.checked = false;
      els.selectAllScriptsInput.indeterminate = false;
    }
    return;
  }
  const allSelected = state.scripts.length > 0 && state.scripts.every((item) => state.selectedScriptPaths.has(item.path));
  const tree = buildScriptTree(state.scripts);
  expandScriptParents(state.currentScriptPath);
  syncVisibleScriptDirectories(tree);
  els.scriptList.innerHTML = `<div class="script-tree">${renderScriptTreeChildren(tree, 0)}</div>`;
  els.selectAllScriptsInput.checked = allSelected;
  els.scriptList.querySelectorAll('[data-script-dir-check]').forEach((checkbox) => {
    checkbox.indeterminate = checkbox.dataset.indeterminate === 'true';
  });
}

function handleScriptListClick(event) {
  const toggle = event.target.closest('[data-script-dir-toggle]');
  if (toggle) {
    event.stopPropagation();
    toggleScriptDirectory(toggle.dataset.scriptDirToggle);
    return;
  }

  const dirRow = event.target.closest('[data-script-dir-row]');
  if (dirRow && !event.target.closest('input,button')) {
    toggleScriptDirectory(dirRow.dataset.scriptDirRow);
    return;
  }

  const scriptRow = event.target.closest('[data-script-path]');
  if (scriptRow && !event.target.closest('input')) {
    loadScript(scriptRow.dataset.scriptPath);
  }
}

function handleScriptListChange(event) {
  const dirCheckbox = event.target.closest('[data-script-dir-check]');
  if (dirCheckbox) {
    toggleScriptDirectorySelection(dirCheckbox.dataset.scriptDirCheck, dirCheckbox.checked);
    renderScripts();
    return;
  }

  const scriptCheckbox = event.target.closest('[data-script-check]');
  if (scriptCheckbox) {
    toggleSet(state.selectedScriptPaths, scriptCheckbox.dataset.scriptCheck, scriptCheckbox.checked);
    renderScripts();
  }
}

export function buildScriptTree(scripts) {
  const root = createScriptTreeNode('data/scripts', 'data/scripts');
  const sorted = [...scripts].toSorted((a, b) => a.path.localeCompare(b.path));
  for (const item of sorted) {
    const relativePath = item.path.replace(/^data\/scripts\/?/, '');
    if (!relativePath) continue;
    const parts = relativePath.split('/').filter(Boolean);
    const fileName = parts.pop();
    let current = root;
    let currentPath = 'data/scripts';
    for (const dirName of parts) {
      currentPath = `${currentPath}/${dirName}`;
      if (!current.dirs.has(dirName)) {
        current.dirs.set(dirName, createScriptTreeNode(dirName, currentPath));
      }
      current = current.dirs.get(dirName);
    }
    current.files.push({ ...item, name: fileName || item.name });
  }
  return root;
}

function createScriptTreeNode(name, nodePath) {
  return {
    name,
    path: nodePath,
    dirs: new Map(),
    files: []
  };
}

function renderScriptTreeChildren(node, depth) {
  const dirs = [...node.dirs.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].toSorted((a, b) => a.name.localeCompare(b.name));
  return [
    ...dirs.map((dir) => renderScriptDirectory(dir, depth)),
    ...files.map((file) => renderScriptFile(file, depth))
  ].join('');
}

export function syncVisibleScriptDirectories(tree, expandedDirs = state.expandedScriptDirs) {
  const dirs = collectScriptDirPaths(tree);
  const nextDirSet = new Set(['data/scripts', ...dirs]);
  for (const dirPath of [...expandedDirs]) {
    if (!nextDirSet.has(dirPath)) expandedDirs.delete(dirPath);
  }
}

export function collectScriptDirPaths(node) {
  return [...node.dirs.values()].flatMap((dir) => [
    dir.path,
    ...collectScriptDirPaths(dir)
  ]);
}

function renderScriptDirectory(node, depth) {
  const expanded = state.expandedScriptDirs.has(node.path);
  const paths = collectScriptPaths(node);
  const selectedCount = paths.filter((scriptPath) => state.selectedScriptPaths.has(scriptPath)).length;
  const checked = paths.length > 0 && selectedCount === paths.length;
  const indeterminate = selectedCount > 0 && !checked;
  return `
    <div class="script-tree-node">
      <div class="script-tree-row script-tree-dir" style="--depth:${depth}" data-script-dir-row="${escapeAttr(node.path)}">
      <button class="script-tree-toggle" type="button" data-script-dir-toggle="${escapeAttr(node.path)}">${expanded ? '▾' : '▸'}</button>
      <input type="checkbox" data-script-dir-check="${escapeAttr(node.path)}" data-indeterminate="${indeterminate}" ${checked ? 'checked' : ''}>
      <span class="script-tree-name">
        <strong>${escapeHtml(node.name)}</strong>
        <small>${paths.length} 个脚本</small>
      </span>
      </div>
      ${expanded ? `<div class="script-tree-children">${renderScriptTreeChildren(node, depth + 1)}</div>` : ''}
    </div>
  `;
}

function renderScriptFile(item, depth) {
  return `
    <div class="file-item script-file-item ${state.currentScriptPath === item.path ? 'active' : ''} ${state.selectedScriptPaths.has(item.path) ? 'selected' : ''}" style="--depth:${depth}" data-script-path="${escapeAttr(item.path)}">
      <input type="checkbox" data-script-check="${escapeAttr(item.path)}" ${state.selectedScriptPaths.has(item.path) ? 'checked' : ''}>
      <span class="script-file-meta">
        <strong title="${escapeAttr(item.path)}">${escapeHtml(item.name)}</strong>
      </span>
      <span class="script-file-size">${escapeHtml(formatBytes(item.size))}</span>
    </div>
  `;
}

function collectVisibleScriptPaths(node) {
  return [
    ...node.files.map((item) => item.path),
    ...[...node.dirs.values()].flatMap((child) => collectVisibleScriptPaths(child))
  ];
}

function updateSelectAllScriptsState() {
  if (!els.selectAllScriptsInput) return;
  const visiblePaths = collectVisibleScriptPaths(buildScriptTree(state.scripts));
  const selectedVisibleCount = visiblePaths.filter((item) => state.selectedScriptPaths.has(item)).length;
  els.selectAllScriptsInput.checked = visiblePaths.length > 0 && selectedVisibleCount === visiblePaths.length;
  els.selectAllScriptsInput.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visiblePaths.length;
}

export function collectScriptPaths(node) {
  return [
    ...node.files.map((item) => item.path),
    ...[...node.dirs.values()].flatMap((child) => collectScriptPaths(child))
  ];
}

export function findScriptTreeNode(node, dirPath) {
  if (!node) return undefined;
  if (node.path === dirPath) return node;
  for (const child of node.dirs.values()) {
    const match = findScriptTreeNode(child, dirPath);
    if (match) return match;
  }
  return undefined;
}

function toggleScriptDirectory(dirPath) {
  if (state.expandedScriptDirs.has(dirPath)) state.expandedScriptDirs.delete(dirPath);
  else state.expandedScriptDirs.add(dirPath);
  renderScripts();
}

function toggleScriptDirectorySelection(dirPath, checked) {
  const paths = state.scripts
    .map((item) => item.path)
    .filter((scriptPath) => scriptPath.startsWith(`${dirPath}/`));
  for (const scriptPath of paths) {
    toggleSet(state.selectedScriptPaths, scriptPath, checked);
  }
}

export function expandScriptParents(scriptPath, expandedDirs = state.expandedScriptDirs) {
  const normalized = String(scriptPath || '').replaceAll('\\', '/');
  if (!normalized.startsWith('data/scripts/')) return;
  const parts = normalized.split('/').slice(0, -1);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (current.startsWith('data/scripts')) expandedDirs.add(current);
  }
}

function updateScriptButtons() {
  const count = state.selectedScriptPaths.size;
  els.scriptBatchBar.hidden = state.scripts.length === 0;
  els.scriptSelectionText.textContent = `${count} 项`;
  els.batchRunScriptsButton.disabled = count === 0;
  els.batchDeleteScriptsButton.disabled = count === 0;
  els.clearScriptSelectionButton.disabled = count === 0;
  updateSelectAllScriptsState();
}

function toggleAllScripts(checked) {
  state.selectedScriptPaths = checked
    ? new Set(state.scripts.map((item) => item.path))
    : new Set();
  renderScripts();
}

function clearScriptSelection() {
  state.selectedScriptPaths.clear();
  renderScripts();
}

function newScript() {
  const fileName = `data/scripts/new-script-${Date.now()}.js`;
  state.currentScriptPath = fileName;
  els.scriptPathInput.value = fileName;
  els.scriptEditor.value = 'console.log("hello ScriptPilot");\n';
  expandScriptParents(fileName);
  renderScripts();
}

export async function loadScript(scriptPath) {
  try {
    const script = await api.getScript(scriptPath);
    state.currentScriptPath = script.path;
    els.scriptPathInput.value = script.path;
    els.scriptEditor.value = script.content;
    expandScriptParents(script.path);
    renderScripts();
  } catch (error) {
    toast(formatError(error));
  }
}

async function saveCurrentScript() {
  const scriptPath = readValue('scriptPathInput');
  if (!scriptPath) {
    toast('请输入脚本路径');
    return;
  }
  try {
    const result = await api.saveScript({ path: scriptPath, content: els.scriptEditor.value });
    state.currentScriptPath = result.path;
    els.scriptPathInput.value = result.path;
    const scripts = await api.listScripts();
    state.scripts = scripts.items || [];
    renderMetrics();
    renderScripts();
    toast('脚本已保存');
  } catch (error) {
    toast(formatError(error));
  }
}

async function openCurrentScriptDirectory() {
  const scriptPath = readValue('scriptPathInput') || state.currentScriptPath || 'data/scripts';
  const kind = scriptPath === 'data/scripts' ? 'directory' : 'file';
  await openPortableDirectory(scriptPath, kind);
}

async function runCurrentScript() {
  const scriptPath = readValue('scriptPathInput');
  if (!scriptPath) {
    toast('请输入脚本路径');
    return;
  }
  if (state.launchingScriptPaths.has(scriptPath)) {
    toast('该脚本正在启动，请在日志页查看实时输出');
    return;
  }
  try {
    state.launchingScriptPaths.add(scriptPath);
    els.runScriptFileButton.disabled = true;
    els.runScriptFileButton.textContent = '启动中';
    await saveCurrentScript();
    const result = await api.runScriptOnce({
      name: scriptPath.split('/').pop() || '脚本文件运行',
      scriptPath,
      cwd: 'data',
      waitForCompletion: false,
      timeoutMs: 30000
    });
    await refreshTasksAndRuns();
    renderRuns();
    await showPage('log');
    await showRunLog(result.runId || result.data?.runId);
    toast('脚本已开始运行，日志正在实时刷新');
  } catch (error) {
    toast(formatError(error));
  } finally {
    state.launchingScriptPaths.delete(scriptPath);
    els.runScriptFileButton.disabled = false;
    els.runScriptFileButton.textContent = '运行';
  }
}

async function deleteCurrentScript() {
  const scriptPath = readValue('scriptPathInput') || state.currentScriptPath;
  if (!scriptPath) return;
  if (!await confirmAction({
    title: '删除脚本',
    message: '确定删除当前脚本吗？删除后会从 data/scripts 中移除文件。',
    details: scriptPath,
    okText: '删除',
    tone: 'danger'
  })) return;
  try {
    await api.deleteScripts([scriptPath]);
    state.selectedScriptPaths.delete(scriptPath);
    state.currentScriptPath = '';
    els.scriptPathInput.value = '';
    els.scriptEditor.value = '';
    const scripts = await api.listScripts();
    state.scripts = scripts.items || [];
    renderMetrics();
    renderScripts();
    toast('脚本已删除');
  } catch (error) {
    toast(formatError(error));
  }
}

async function batchRunScripts() {
  const paths = [...state.selectedScriptPaths];
  if (!paths.length) return;
  if (!await confirmAction({
    title: '批量运行脚本',
    message: `确认按顺序运行选中的 ${paths.length} 个脚本吗？`,
    details: paths.join('\n'),
    okText: '批量运行'
  })) return;
  try {
    paths.forEach((scriptPath) => state.launchingScriptPaths.add(scriptPath));
    toast(`正在启动 ${paths.length} 个脚本`);
    let lastRunId;
    for (const scriptPath of paths) {
      const result = await api.runScriptOnce({
        name: scriptPath.split('/').pop() || '脚本批量运行',
        scriptPath,
        cwd: 'data',
        waitForCompletion: false,
        timeoutMs: 30000
      });
      lastRunId = result.runId || result.data?.runId || lastRunId;
    }
    await refreshTasksAndRuns();
    renderRuns();
    if (lastRunId) {
      await showPage('log');
      await showRunLog(lastRunId);
    }
    toast(`已启动 ${paths.length} 个脚本，日志正在实时刷新`);
  } catch (error) {
    toast(formatError(error));
  } finally {
    paths.forEach((scriptPath) => state.launchingScriptPaths.delete(scriptPath));
  }
}

async function batchDeleteScripts() {
  const paths = [...state.selectedScriptPaths];
  if (!paths.length) return;
  if (!await confirmAction({
    title: '批量删除脚本',
    message: `确定删除选中的 ${paths.length} 个脚本吗？`,
    details: paths.join('\n'),
    okText: '批量删除',
    tone: 'danger'
  })) return;
  try {
    await api.deleteScripts(paths);
    state.selectedScriptPaths.clear();
    if (paths.includes(state.currentScriptPath)) {
      state.currentScriptPath = '';
      els.scriptPathInput.value = '';
      els.scriptEditor.value = '';
    }
    await refreshScripts();
    toast(`已删除 ${paths.length} 个脚本`);
  } catch (error) {
    toast(formatError(error));
  }
}
