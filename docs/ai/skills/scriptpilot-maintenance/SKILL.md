---
name: scriptpilot-maintenance
description: Maintain ScriptPilot, a Windows portable Electron NodeJS script scheduler. Use when changing ScriptPilot code, UI behavior, QingLong-style subscriptions/logs/tasks, local API behavior, portable data paths, build/release artifacts, GitHub Release packaging, or repository documentation and AI instructions.
---

# ScriptPilot Maintenance

Use this skill for ScriptPilot implementation, validation, and release work.

## Workflow

1. Read `AGENTS.md` first.
2. Identify the change area: UI renderer, Electron main/preload/API, main modules, build/release, or docs.
3. Read only the relevant reference files below.
4. Implement with minimal, targeted changes.
5. Validate the touched path and release copy when applicable.

## References

- `references/project-standards.md`: architecture, data paths, UI behavior, runtime assumptions.
- `references/code-generation.md`: coding style, renderer patterns, backend patterns, validation rules.
- `references/release-artifacts.md`: build, release layout, icon, GitHub Release and packaging rules.

## Non-negotiables

- Keep `README.md` user-facing.
- Keep `AGENTS.md` as the only canonical AI maintenance entry.
- Keep `CLAUDE.md` as a pointer to `AGENTS.md`.
- Do not create a second canonical AI entry file.
- Do not overwrite or package `release/win-unpacked/app/data/`.
- Do not commit `release/`, `.tools/`, `node_modules/`, local data, logs, CK, or cache.
- Sync changed app resources into `release/win-unpacked/app/resources/app/` when the existing portable EXE should see the change after restart.
- Increment `package.json`, `package-lock.json`, the Git tag, zip name, and release title for every new published artifact.
