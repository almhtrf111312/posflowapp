---
name: flowpos-release-github-memory
description: Release, version, GitHub push, project memory, and architecture-record protocol for FlowPOS Pro. Governs the mandatory sequence after every modification: build gate, audit, memory update, version and build bookkeeping, professional commit message, push to the development branch, verification, and the Arabic release summary. Also defines the specification and architecture decision record templates.
version: 2.0.0
---

# FlowPOS Pro — Release, GitHub Push, Memory, and Versioning

## 1. Purpose

Every completed modification must leave the repository in a state that is built, documented, versioned, committed with a clear message, pushed to the correct branch, and summarized for the owner. This skill defines that sequence and the records it produces.

## 2. Repository identity (verify before use)

| Item | Value | Source |
| :--- | :--- | :--- |
| Product name | FlowPOS Pro | Project documents |
| Package name | `vite_react_shadcn_ts` | `.xgrok/project.json`, `AGENTS.md` |
| Current version | `v1.3.2 (Build 345)` | `.agent/PROJECT_MEMORY.md`, last updated 2026-10-28 |
| Production branch | `main` | `PROJECT_RULES.md` |
| Development branch (pushes go here) | `event-or-artifact` | `PROJECT_RULES.md` |
| Last recorded commit | `35745fd4` | `.agent/PROJECT_MEMORY.md` |
| GitHub repository name or URL | Not present in the uploaded bundle. The owner must confirm it. | Not available |

Before pushing, confirm the remote with `git remote -v`. If the remote URL differs from the owner's repository, stop and ask.

Note: `AGENTS.md` still shows version `v1.1.9 (Build 339)`. That line is stale. `.agent/PROJECT_MEMORY.md` is the authoritative version source. Report the discrepancy until the owner updates `AGENTS.md`.

## 3. The mandatory post-modification sequence

Execute these steps in order. Stop at the first failure.

1. **Scope check:** confirm that only the files required by the task changed (`git status`, `git diff --stat`).
2. **Audit:** run the checklist in `flowpos-domain-audit`.
3. **Build gate:** run `npm run build`. The exit code must be 0 with no build or type errors. This is a hard gate.
4. **Memory update:** update `.agent/PROJECT_MEMORY.md` as described in section 5.
5. **Version bookkeeping:** apply section 4.
6. **Stage:** `git add` only the intended files. Never stage keystores, `.env` files with real values, build logs, or generated output.
7. **Commit:** write a commit message in the format in section 6.
8. **Push:** push to the development branch only, as described in section 7.
9. **Verify:** confirm the push result, the remote branch head, and the new commit hash.
10. **Report:** produce the Arabic release summary in section 8.

## 4. Versioning rules

- The displayed version has two parts: a semantic version (`MAJOR.MINOR.PATCH`) and a build number. The current display format is `vX.Y.Z (Build N)`.
- Build number: the repository's version scripts and the pre-commit hook may increment it automatically when `src/` files are staged. Before manually bumping, check whether the hook already did so, and never bump twice for one commit.
- Semantic version rules:
  - `PATCH`: fixes that do not change behavior beyond the defect.
  - `MINOR`: new user-visible capability or meaningful redesign.
  - `MAJOR`: breaking change to data, storage format, or public contracts. Requires owner approval.
- Use the project's version scripts (`npm run version:bump`, `npm run version:bump:minor`, `npm run version:bump:major`, `npm run version:set`) rather than editing version fields by hand.
- Documentation-only or skill-only changes that do not touch application code do not change the application version. Record them with a bundle version in their own changelog instead.

## 5. Project memory update (`.agent/PROJECT_MEMORY.md`)

Update these sections, and only these sections, each time:

1. **Last Updated** and **Current Version** in the header.
2. **Recent Implementations & Changelog Log:** a new entry at the top, containing the date, version and build, commit hash, a title, a bullet list of the behavior changes, the files changed, and the verification result.
3. **Active System State:** only when new storage keys, sync queue operation types, tables, or UI components were added.
4. **Known Technical Debt & Edge Cases:** only when a deferred item or caveat was discovered.
5. **Next Logical Milestones:** check off completed milestones and add new ones only when they follow from the work.

Keep memory entries short, factual, and in Arabic, matching the existing style. Confirm the file remains valid Markdown and that no encoding corruption exists.

## 6. Commit message standard

- Language: English.
- Format: `<type>: <short imperative summary>`, lowercase type, no trailing period, at most 72 characters in the first line.
- Allowed types: `feat`, `fix`, `improve`, `refactor`, `docs`, `chore`, `style`, `perf`, `test`, `build`.
- Use a body only when the change needs explanation. Describe the behavior change, not the process.
- Examples:
  - `feat: add item-level profit detail dialog to POS cart`
  - `fix: keep historical invoice symbol when exchange rate changes`
  - `docs: consolidate agent skills into flowpos bundle v2.0.0`
- Never use vague messages such as "update", "changes", or "fix stuff".

## 7. Push policy

- Push target: `origin event-or-artifact` for every development change. The owner requested that changes be pushed to GitHub after each modification, and this branch is the approved development target.
- Never push to `main` without an explicit, unambiguous owner request in the current conversation. Never merge into `main` on your own.
- Never use `git push --force`, `git push --force-with-lease`, `git reset --hard`, or `--no-verify` unless the owner explicitly requests the exact command.
- If the push is rejected because the remote moved, run `git pull --rebase origin event-or-artifact`, resolve conflicts only in files that the task touched, rerun the build gate, and then push again. Report any conflict that involves a file outside the task.
- If no network or no credentials are available, do not claim a push. Report the exact commands the owner must run, and state the local commit hash.

## 8. Arabic release summary (mandatory after every push or attempted push)

Use this structure, in Arabic:

- **اسم المستودع:** the repository name or URL, or "غير متوفر في الجلسة — يُرجى تأكيده".
- **الفرع:** target branch and whether it was pushed.
- **رقم الالتزام:** the full or short commit hash, or "لم يُنشأ".
- **الإصدار الحالي:** version and build number after the change.
- **نتيجة البناء:** `npm run build` exit code.
- **الملفات المعدّلة:** list of paths.
- **أبرز التغييرات:** short bullets of behavior changes.
- **التحقق:** audit and build results, and any item not verified with the reason.
- **ملاحظات:** discrepancies, risks, and items for the owner to decide.

## 9. Architecture decision records (ADR)

Create an ADR only for a significant architectural decision, a database schema change, a sync-contract change, or a new platform bridge.

- Location: `.agent/docs/adr/NNNN-<kebab-case-slug>.md`, where `NNNN` is the next four-digit number.
- Use the structure in section 10. Include YAML frontmatter with `title`, `status`, `date`, `deciders`, and `tags`.
- Link related records with wikilinks such as `[[0001-offline-first-hybrid-architecture]]` or standard Markdown links.
- Include one Mermaid diagram when the decision concerns a data flow or sequence.
- Add the new ADR to the memory file's list of records.
- The `.agent/docs/` folder is designed to open directly as an Obsidian vault. Keep links relative.

## 10. Templates

### 10.1 Specification template (for a multi-file change when the owner requests a written plan)

```
# Spec: <title>
## Business intent
## Scope (files and symbols)
## Storage and schema impact (local, remote)
## Offline and sync behavior (queue types, idempotency, cancellation checks)
## Currency and accounting impact (USD base, snapshots, rounding)
## Platform matrix (web, Capacitor Android, Electron desktop)
## Visual and notification impact (RTL, SmartToast)
## Risks and mitigations
## Execution steps (atomic, verifiable)
## Verification (build exit code, audit result)
```

### 10.2 Architecture decision record template

```
---
title: <decision title>
status: proposed | accepted | superseded
date: YYYY-MM-DD
deciders: <roles>
tags: [flowpos, adr, <area>]
---
# NNNN — <decision title>
## Context
## Drivers
## Options considered
## Decision
## Consequences
## Diagram
```

## 11. Repository hygiene

- Keep the repository clean: no sensitive files, no build logs, no orphan components, no unused generated files.
- Never commit `.keystore`, `.jks`, `flowpos-release.keystore`, `.env` with real values, or any signing secret.
- Build logs such as `build_log.txt`, `build_error.txt`, `build_out*.txt`, and `deploy_log.txt` are local artifacts and must not be committed.
