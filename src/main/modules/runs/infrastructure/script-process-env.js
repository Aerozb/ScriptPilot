import { readFile } from 'node:fs/promises';
import path from 'node:path';

const VALID_ENV_NAME = /^[a-zA-Z_][0-9a-zA-Z_]*$/;

export async function loadEnabledScriptEnv(paths) {
  const rows = await readEnvRows(paths);
  const groups = new Map();

  for (const row of rows) {
    if (row?.status !== 'enabled') continue;
    const name = String(row.name || '').trim();
    if (!VALID_ENV_NAME.test(name)) continue;

    const values = groups.get(name) || [];
    values.push(String(row.value ?? '').trim());
    groups.set(name, values);
  }

  return Object.fromEntries(
    [...groups.entries()].map(([name, values]) => [name, values.join('&').trim()])
  );
}

async function readEnvRows(paths) {
  try {
    const filePath = path.join(paths.appStateRoot, 'envs.json');
    const rows = JSON.parse(await readFile(filePath, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
