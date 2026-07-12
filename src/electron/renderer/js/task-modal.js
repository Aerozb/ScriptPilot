// 任务编辑弹窗：表单读写、脚本来源切换、树形脚本选择器、cron 未来执行预览。
import { api, els, state } from './context.js';
import { escapeAttr, escapeHtml, formatBytes, formatDateTime, formatError, readInteger, readJsonObject, readLines, readValue } from './utils.js';
import { findUpcomingRuns, formatRelativeTime, isValidCronExpressionText } from './cron.js';
import { renderMetrics, toast } from './ui.js';
import { refreshTasksAndRuns } from './data.js';
import { renderTasks } from './tasks.js';
import { SCRIPT_FILE_EXTENSIONS, buildScriptTree, collectScriptDirPaths, collectScriptPaths, expandScriptParents, findScriptTreeNode, syncVisibleScriptDirectories } from './scripts.js';

let taskScriptPickerRenderFrame;
let cronPreviewTimer;

export function bindTaskModal() {
  els.taskForm.addEventListener('submit', handleTaskSubmit);
  els.taskScriptSourceInput.addEventListener('change', () => syncTaskScriptSourceFields());
  els.taskScriptPathInput.addEventListener('click', () => {
    if (els.taskScriptSourceInput.value === 'existing') openTaskScriptPicker();
  });
  els.chooseTaskScriptButton.addEventListener('click', () => openTaskScriptPicker());
  els.taskScriptPickerSearchInput.addEventListener('input', () => scheduleTaskScriptPickerRender());
  els.taskScriptPickerList.addEventListener('click', handleTaskScriptPickerClick);
  els.taskScriptPickerList.addEventListener('change', handleTaskScriptPickerChange);
  els.clearTaskScriptPickerButton.addEventListener('click', () => {
    state.taskScriptPickerSelectedPaths.clear();
    renderTaskScriptPicker();
  });
  els.confirmTaskScriptPickerButton.addEventListener('click', () => confirmTaskScriptPicker());
  els.taskScheduleTypeInput.addEventListener('change', () => syncScheduleTypeFields());
  els.taskCronInput.addEventListener('input', () => scheduleCronPreview());
  els.taskExtraSchedulesInput.addEventListener('input', () => scheduleCronPreview());
}

async function handleTaskSubmit(event) {
  event.preventDefault();
  try {
    const input = readTaskForm();
    const scriptPaths = input.scriptPaths || [];
    delete input.scriptPaths;
    if (input.taskId) {
      await api.updateTask(input);
    } else if (scriptPaths.length > 1) {
      for (const scriptPath of scriptPaths) {
        await api.createTask({
          ...input,
          name: createTaskNameForScript(input.name, scriptPath, scriptPaths.length),
          scriptPath,
          scriptContent: undefined
        });
      }
    } else {
      if (scriptPaths.length === 1) input.scriptPath = scriptPaths[0];
      await api.createTask(input);
    }
    els.taskModal.close();
    await refreshTasksAndRuns();
    renderMetrics();
    renderTasks();
    toast(input.taskId ? '任务已更新' : scriptPaths.length > 1 ? `已创建 ${scriptPaths.length} 个任务` : '任务已保存');
  } catch (error) {
    toast(formatError(error));
  }
}

function readTaskForm() {
  const scheduleType = els.taskScheduleTypeInput.value;
  const source = els.taskScriptSourceInput.value;
  const scriptPaths = source === 'existing' ? normalizeSelectedTaskScriptPaths() : [];
  if (source === 'existing' && !scriptPaths.length) {
    throw new Error('请选择至少一个已有脚本，或切换为“填写新脚本内容”');
  }
  const scriptContent = source === 'inline' ? readValue('taskScriptContentInput') : '';
  if (source === 'inline' && !scriptContent) {
    throw new Error('请填写脚本内容，或切换为“选择已有脚本”');
  }

  return {
    taskId: els.taskIdInput.value || undefined,
    name: readValue('taskNameInput'),
    scriptPath: source === 'inline' ? readValue('taskScriptPathInput') || undefined : scriptPaths[0],
    scriptPaths,
    scriptContent: scriptContent || undefined,
    cronExpression: scheduleType === 'boot' ? '@boot' : scheduleType === 'once' ? '@once' : readValue('taskCronInput') || undefined,
    cwd: readValue('taskCwdInput') || 'data',
    args: readLines('taskArgsInput'),
    params: readJsonObject('taskParamsInput', '结构化参数 JSON'),
    dependencies: readLines('taskDependenciesInput'),
    extraSchedules: readLines('taskExtraSchedulesInput'),
    labels: readLines('taskLabelsInput'),
    allowMultipleInstances: els.taskInstanceModeInput.value === 'multiple',
    logName: readValue('taskLogNameInput') || undefined,
    beforeScript: readValue('taskBeforeInput') || undefined,
    afterScript: readValue('taskAfterInput') || undefined,
    remark: readValue('taskRemarkInput') || undefined,
    enabled: els.taskEnabledInput.checked,
    timeoutMs: readInteger('taskTimeoutInput', 30000)
  };
}

export function openTaskModal(task, options = {}) {
  els.taskForm.reset();
  const cloneMode = options.clone === true;
  const isEdit = Boolean(task?.id && !cloneMode);
  els.taskModalTitle.textContent = isEdit ? '编辑任务' : cloneMode ? '复制任务' : '新建定时任务';
  els.taskIdInput.value = isEdit ? task.id : '';
  els.taskNameInput.value = cloneMode ? `${task.name} - 副本` : task?.name || '我的脚本任务';
  state.taskFormScriptPaths = cloneMode ? [] : task?.scriptPath ? [task.scriptPath] : [];
  state.taskScriptPickerMulti = !isEdit;
  els.taskScriptSourceInput.value = task?.scriptContent ? 'inline' : 'existing';
  const scheduleType = task?.cronExpression === '@once' ? 'once' : task?.cronExpression === '@boot' ? 'boot' : 'normal';
  els.taskScheduleTypeInput.value = scheduleType;
  els.taskCronInput.value = scheduleType === 'normal' ? task?.cronExpression || '*/5 * * * *' : '';
  els.taskInstanceModeInput.value = task?.allowMultipleInstances ? 'multiple' : 'single';
  updateTaskScriptPathInput();
  els.taskScriptContentInput.value = task?.scriptContent || defaultTaskScript();
  els.taskArgsInput.value = (task?.args || []).join('\n');
  els.taskParamsInput.value = JSON.stringify(task?.params || { 来源: '定时任务' }, null, 2);
  els.taskCwdInput.value = task?.cwd || 'data';
  els.taskTimeoutInput.value = String(task?.timeoutMs ?? 30000);
  els.taskExtraSchedulesInput.value = (task?.extraSchedules || []).join('\n');
  els.taskLabelsInput.value = (task?.labels || []).join('\n');
  els.taskDependenciesInput.value = (task?.dependencies || []).join('\n');
  els.taskLogNameInput.value = task?.logName || '';
  els.taskRemarkInput.value = task?.remark || '';
  els.taskBeforeInput.value = task?.beforeScript || '';
  els.taskAfterInput.value = task?.afterScript || '';
  els.taskEnabledInput.checked = task?.enabled ?? true;
  syncScheduleTypeFields();
  syncTaskScriptSourceFields();
  els.taskModal.showModal();
  els.taskNameInput.focus();
}

function defaultTaskScript() {
  return [
    'const params = JSON.parse(process.env.SCRIPTPILOT_PARAMS || "{}");',
    'console.log("定时任务执行成功");',
    'console.log(JSON.stringify({ args: process.argv.slice(2), params, trigger: process.env.SCRIPTPILOT_TRIGGER }));'
  ].join('\n');
}

function syncScheduleTypeFields() {
  const isNormal = els.taskScheduleTypeInput.value === 'normal';
  els.taskCronInput.disabled = !isNormal;
  els.taskExtraSchedulesInput.disabled = !isNormal;
  updateCronPreview();
}

function syncTaskScriptSourceFields() {
  const source = els.taskScriptSourceInput.value;
  const isExisting = source === 'existing';
  els.chooseTaskScriptButton.hidden = !isExisting;
  els.taskScriptPathInput.readOnly = isExisting;
  els.taskScriptPathLabel.textContent = isExisting ? '脚本路径' : '保存路径，可留空';
  els.taskScriptPathInput.placeholder = isExisting
    ? '点击选择 data/scripts 下的脚本，可多选批量创建任务'
    : '留空自动保存到 data/scripts/tasks，也可填 data/scripts/custom.js';
  els.taskScriptPathHint.textContent = isExisting
    ? '选择已有脚本时，只保存路径，不会写入脚本内容；多选会批量创建任务。'
    : '填写新脚本内容时，会写入新脚本文件；如果填写保存路径，将写入该路径。';
  els.taskScriptContentField.hidden = isExisting;
  if (!isExisting) {
    state.taskFormScriptPaths = [];
    updateTaskScriptPathInput();
  }
}

function normalizeSelectedTaskScriptPaths() {
  if (state.taskFormScriptPaths.length) return state.taskFormScriptPaths;
  return readValue('taskScriptPathInput')
    .split(/\r?\n|;|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function updateTaskScriptPathInput() {
  els.taskScriptPathInput.value = state.taskFormScriptPaths.join('\n');
  if (els.taskScriptSourceInput?.value === 'existing') {
    const count = state.taskFormScriptPaths.length;
    els.taskScriptPathHint.textContent = count > 1
      ? `已选择 ${count} 个脚本，保存后会批量创建 ${count} 个任务。`
      : '选择已有脚本时，只保存路径，不会写入脚本内容；多选会批量创建任务。';
  }
}

function createTaskNameForScript(baseName, scriptPath, count) {
  const scriptName = scriptPath.split('/').pop()?.replace(/\.(cjs|mjs|js)$/i, '') || '脚本任务';
  const trimmed = String(baseName || '').trim();
  if (!trimmed || trimmed === '我的脚本任务' || count > 1) return scriptName;
  return trimmed;
}

// ---------- 脚本选择器 ----------

async function openTaskScriptPicker() {
  if (els.taskScriptSourceInput.value !== 'existing') return;
  try {
    if (!state.scripts.length) {
      const scripts = await api.listScripts();
      state.scripts = scripts.items || [];
    }
    state.taskScriptPickerSelectedPaths = new Set(state.taskFormScriptPaths);
    state.taskScriptPickerExpandedDirs = new Set(['data/scripts']);
    state.taskScriptPickerVisibleTree = undefined;
    state.taskScriptPickerLastKeyword = '';
    state.taskFormScriptPaths.forEach((scriptPath) => expandScriptParents(scriptPath, state.taskScriptPickerExpandedDirs));
    els.taskScriptPickerSearchInput.value = '';
    els.taskScriptPickerTitle.textContent = state.taskScriptPickerMulti ? '选择脚本' : '选择一个脚本';
    els.taskScriptPickerHint.textContent = state.taskScriptPickerMulti
      ? '可多选脚本，保存后会为每个脚本创建一个任务。'
      : '编辑任务时只能选择一个脚本。';
    renderTaskScriptPicker();
    els.taskScriptPickerModal.showModal();
    els.taskScriptPickerSearchInput.focus();
  } catch (error) {
    toast(formatError(error));
  }
}

function renderTaskScriptPicker() {
  const keyword = els.taskScriptPickerSearchInput.value.trim().toLowerCase();
  const keywordChanged = keyword !== state.taskScriptPickerLastKeyword;
  state.taskScriptPickerLastKeyword = keyword;
  const rows = state.scripts
    .filter((item) => SCRIPT_FILE_EXTENSIONS.some((ext) => item.path.toLowerCase().endsWith(ext)))
    .filter((item) => {
      if (!keyword) return true;
      return item.path.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword);
    });

  els.taskScriptPickerSelectionText.textContent = `已选择 ${state.taskScriptPickerSelectedPaths.size} 个脚本`;
  els.clearTaskScriptPickerButton.disabled = state.taskScriptPickerSelectedPaths.size === 0;
  els.confirmTaskScriptPickerButton.disabled = state.taskScriptPickerSelectedPaths.size === 0;
  if (!rows.length) {
    state.taskScriptPickerVisibleTree = undefined;
    els.taskScriptPickerList.innerHTML = '<div class="empty">暂无可选脚本，请先在脚本管理或订阅管理中保存脚本。</div>';
    return;
  }

  const tree = buildScriptTree(rows);
  state.taskScriptPickerVisibleTree = tree;
  if (keyword && keywordChanged) {
    for (const dirPath of collectScriptDirPaths(tree)) {
      state.taskScriptPickerExpandedDirs.add(dirPath);
    }
  }
  const expandedDirs = state.taskScriptPickerExpandedDirs;
  syncVisibleScriptDirectories(tree, expandedDirs);
  els.taskScriptPickerList.innerHTML = `<div class="script-tree script-picker-tree">${renderTaskScriptPickerTreeChildren(tree, 0, expandedDirs)}</div>`;
  els.taskScriptPickerList.querySelectorAll('[data-task-script-picker-dir-check]').forEach((checkbox) => {
    checkbox.indeterminate = checkbox.dataset.indeterminate === 'true';
  });
}

function confirmTaskScriptPicker() {
  const selected = [...state.taskScriptPickerSelectedPaths];
  if (!selected.length) {
    toast('请先选择脚本');
    return;
  }
  state.taskFormScriptPaths = state.taskScriptPickerMulti ? selected : selected.slice(0, 1);
  updateTaskScriptPathInput();
  els.taskScriptPickerModal.close();
}

function scheduleTaskScriptPickerRender() {
  if (taskScriptPickerRenderFrame) cancelAnimationFrame(taskScriptPickerRenderFrame);
  taskScriptPickerRenderFrame = requestAnimationFrame(() => {
    taskScriptPickerRenderFrame = undefined;
    renderTaskScriptPicker();
  });
}

function renderTaskScriptPickerTreeChildren(node, depth, expandedDirs) {
  const dirs = [...node.dirs.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].toSorted((a, b) => a.name.localeCompare(b.name));
  return [
    ...dirs.map((dir) => renderTaskScriptPickerDirectory(dir, depth, expandedDirs)),
    ...files.map((file) => renderTaskScriptPickerFile(file, depth))
  ].join('');
}

function renderTaskScriptPickerDirectory(node, depth, expandedDirs) {
  const expanded = expandedDirs.has(node.path);
  const paths = collectScriptPaths(node);
  const selectedCount = paths.filter((scriptPath) => state.taskScriptPickerSelectedPaths.has(scriptPath)).length;
  const checked = paths.length > 0 && selectedCount === paths.length;
  const indeterminate = selectedCount > 0 && !checked;
  return `
    <div class="script-tree-node">
      <div class="script-tree-row script-tree-dir" style="--depth:${depth}" data-task-script-picker-dir-row="${escapeAttr(node.path)}">
        <button class="script-tree-toggle" type="button" data-task-script-picker-dir-toggle="${escapeAttr(node.path)}">${expanded ? '▾' : '▸'}</button>
        <input type="checkbox" data-task-script-picker-dir-check="${escapeAttr(node.path)}" data-indeterminate="${indeterminate}" ${checked ? 'checked' : ''} ${state.taskScriptPickerMulti ? '' : 'disabled'}>
        <span class="script-tree-name">
          <strong>${escapeHtml(node.name)}</strong>
          <small>${paths.length} 个脚本</small>
        </span>
      </div>
      ${expanded ? `<div class="script-tree-children">${renderTaskScriptPickerTreeChildren(node, depth + 1, expandedDirs)}</div>` : ''}
    </div>
  `;
}

function renderTaskScriptPickerFile(item, depth) {
  const selected = state.taskScriptPickerSelectedPaths.has(item.path);
  const inputType = state.taskScriptPickerMulti ? 'checkbox' : 'radio';
  return `
    <div class="file-item script-file-item ${selected ? 'selected' : ''}" style="--depth:${depth}" data-task-script-picker-file-row="${escapeAttr(item.path)}">
      <input type="${inputType}" name="taskScriptPickerFile" data-task-script-picker-file="${escapeAttr(item.path)}" ${selected ? 'checked' : ''}>
      <span class="script-file-meta">
        <strong title="${escapeAttr(item.path)}">${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.path)}</small>
      </span>
      <span class="script-file-size">${escapeHtml(formatBytes(item.size))}</span>
    </div>
  `;
}

function handleTaskScriptPickerClick(event) {
  const toggle = event.target.closest('[data-task-script-picker-dir-toggle]');
  if (toggle) {
    event.stopPropagation();
    toggleTaskScriptPickerDirectory(toggle.dataset.taskScriptPickerDirToggle);
    return;
  }

  const dirRow = event.target.closest('[data-task-script-picker-dir-row]');
  if (dirRow && !event.target.closest('input,button')) {
    toggleTaskScriptPickerDirectory(dirRow.dataset.taskScriptPickerDirRow);
    return;
  }

  const fileRow = event.target.closest('[data-task-script-picker-file-row]');
  if (fileRow && !event.target.closest('input')) {
    const scriptPath = fileRow.dataset.taskScriptPickerFileRow;
    setTaskScriptPickerFileSelected(scriptPath, !state.taskScriptPickerSelectedPaths.has(scriptPath));
    renderTaskScriptPicker();
  }
}

function handleTaskScriptPickerChange(event) {
  const fileInput = event.target.closest('[data-task-script-picker-file]');
  if (fileInput) {
    setTaskScriptPickerFileSelected(fileInput.dataset.taskScriptPickerFile, fileInput.checked);
    renderTaskScriptPicker();
    return;
  }

  const dirInput = event.target.closest('[data-task-script-picker-dir-check]');
  if (dirInput) {
    toggleTaskScriptPickerDirectorySelection(dirInput.dataset.taskScriptPickerDirCheck, dirInput.checked);
    renderTaskScriptPicker();
  }
}

function toggleTaskScriptPickerDirectory(dirPath) {
  if (state.taskScriptPickerExpandedDirs.has(dirPath)) state.taskScriptPickerExpandedDirs.delete(dirPath);
  else state.taskScriptPickerExpandedDirs.add(dirPath);
  renderTaskScriptPicker();
}

function setTaskScriptPickerFileSelected(scriptPath, selected) {
  if (selected) {
    if (!state.taskScriptPickerMulti) state.taskScriptPickerSelectedPaths.clear();
    state.taskScriptPickerSelectedPaths.add(scriptPath);
  } else {
    state.taskScriptPickerSelectedPaths.delete(scriptPath);
  }
}

function toggleTaskScriptPickerDirectorySelection(dirPath, checked) {
  if (!state.taskScriptPickerMulti) return;
  const visibleNode = findScriptTreeNode(state.taskScriptPickerVisibleTree, dirPath);
  const paths = visibleNode
    ? collectScriptPaths(visibleNode)
    : state.scripts
      .map((item) => item.path)
      .filter((scriptPath) => scriptPath.startsWith(`${dirPath}/`))
      .filter((scriptPath) => SCRIPT_FILE_EXTENSIONS.some((ext) => scriptPath.toLowerCase().endsWith(ext)));
  for (const scriptPath of paths) {
    setTaskScriptPickerFileSelected(scriptPath, checked);
  }
}

// ---------- cron 预览 ----------

function scheduleCronPreview() {
  clearTimeout(cronPreviewTimer);
  cronPreviewTimer = setTimeout(updateCronPreview, 250);
}

// 在任务弹窗里实时预览主规则+额外规则合并后的未来 5 次执行时间。
function updateCronPreview() {
  if (!els.cronPreview) return;
  const isNormal = els.taskScheduleTypeInput.value === 'normal';
  const mainCron = els.taskCronInput.value.trim();
  const extraSchedules = readLines('taskExtraSchedulesInput');
  if (!isNormal || (!mainCron && !extraSchedules.length)) {
    els.cronPreview.hidden = true;
    return;
  }

  const expressions = [];
  const invalid = [];
  const seen = new Set();
  const candidates = [
    ['主规则', mainCron],
    ...extraSchedules.map((expr, index) => [`附加 ${index + 1}`, expr])
  ];
  for (const [label, expr] of candidates) {
    if (!expr || seen.has(expr)) continue;
    seen.add(expr);
    if (isValidCronExpressionText(expr)) expressions.push({ label, expr });
    else invalid.push(expr);
  }

  els.cronPreview.hidden = false;
  els.cronPreviewBadge.textContent = expressions.length > 1
    ? `${expressions.length} 条规则合并`
    : expressions[0]?.expr || '';

  const upcoming = findUpcomingRuns(expressions, 5);
  if (upcoming.length) {
    const showSource = expressions.length > 1;
    els.cronPreviewList.innerHTML = upcoming.map((item, index) => `
      <li>
        <span class="cron-preview-index">${index + 1}</span>
        <span class="cron-preview-time">${escapeHtml(formatDateTime(item.date.toISOString()))}</span>
        <span class="cron-preview-relative">${escapeHtml(formatRelativeTime(item.date))}</span>
        ${showSource ? `<span class="tag amber">${escapeHtml(item.label)}</span>` : ''}
      </li>
    `).join('');
  } else if (expressions.length) {
    els.cronPreviewList.innerHTML = '<li class="cron-preview-empty">未来 60 天内没有匹配的执行时间</li>';
  } else {
    els.cronPreviewList.innerHTML = '';
  }

  els.cronPreviewError.hidden = !invalid.length;
  els.cronPreviewError.textContent = invalid.length
    ? `表达式无效：${invalid.join('、')}（格式：分 时 日 月 周）`
    : '';
}
