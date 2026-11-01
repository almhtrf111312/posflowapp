---
name: flowpos-core-workflow
description: Mandatory operating protocol for every session in the FlowPOS Pro repository, including greetings. Governs instruction compliance, authority order, scope control, planning, verification gates, failure handling, and the mandatory Arabic final report. Read this skill first and apply it together with all other flowpos-* skills in this bundle.
version: 2.0.0
---

# FlowPOS Pro — Core Workflow Protocol

## 1. Purpose

This skill defines how an AI agent must behave in the FlowPOS Pro repository from the first message of a session until the final report. It exists so that every task follows the owner's instructions exactly, changes only what was requested, avoids wasted tokens, keeps the offline-first accounting system safe, and ends with a verifiable, professional report.

## 2. Mandatory status of the skill bundle

- All seven skills in this bundle are mandatory. At session start, read every `SKILL.md` in the bundle in full (they are short by design).
- Load optional reference files (for example the financial formulas reference or the UI data catalog) only when the current task needs them.
- Every final report must state which mandatory skills were applied. Never claim a skill was applied when it was not.

## 3. Authority order when instructions conflict

Apply the first matching source in this order:

1. The owner's explicit instruction in the current conversation.
2. The skills in this bundle (`flowpos-*`).
3. `PROJECT_RULES.md` at the repository root and `.agent/PROJECT_MEMORY.md`.
4. `AGENTS.md`, `README.md`, and other documentation files.

When two sources conflict on a safety matter (frozen modules, production SQL, base currency, local data deletion, pushing to `main`), apply the stricter rule and state the conflict in one line in the report. The owner's explicit instruction for the current task overrides the other sources for that task only, and the exception must be recorded in the report.

## 4. Session start protocol

1. Run read-only checks: `git status` and `git branch --show-current`. Report the branch and whether the working tree is clean.
2. Read only the header of `.agent/PROJECT_MEMORY.md` (Current Version, Last Updated, active branch). Do not load the full changelog unless the task needs it.
3. Never run `git pull` while uncommitted changes exist. Report the state instead.
4. When the user only greets, answer in Arabic with a short status of three lines or fewer: branch, current version, last recorded change, and whether the working tree is clean.

## 5. Instruction compliance

1. Before acting, convert the request into a numbered checklist of every explicit requirement. Keep the checklist internal for simple requests. For multi-part requests, include it in the final report with the status of each item.
2. Do exactly what was requested. Do not add features, refactors, renames, reformatting, comment rewrites, or "improvements" outside the requested scope.
3. Ask a clarifying question only when a wrong guess could cause data loss, a financial error, a frozen-module change, or a production database change. Otherwise choose the most conservative interpretation, state it in one line, and proceed.
4. If one sub-task conflicts with a safety invariant, stop that sub-task only, explain the reason in one Arabic sentence, and complete the remaining sub-tasks.
5. Never claim that a check, build, test, commit, or push happened unless it actually happened and its result was observed.

## 6. Scope boundaries

- Default scope is the frontend (React, TypeScript, UI, Dexie or IndexedDB local stores, Capacitor and Electron integration points).
- Backend work (Supabase SQL, migrations, RLS policies, RPC functions, Edge Functions, schema types) is out of scope unless the owner explicitly requests it. Even when requested, SQL must be shown as a proposal and approved before any execution (see `flowpos-domain-audit`).
- Touch only the files and symbols required by the request. The final report lists "Files touched" and "Files intentionally not touched".

## 7. Planning protocol (replaces the older spec-gate rule)

- Single-file or single-symbol changes: implement directly.
- Multi-file or cross-cutting changes: write a plan of at most eight bullets in the reply before editing (files, symbols, storage impact, offline impact, currency impact, risks, verification). Then implement.
- Stop and wait for explicit confirmation only in these cases:
  - any SQL, schema, migration, RLS, or RPC change;
  - any touch to a frozen module;
  - any deletion of user data, local storage, IndexedDB, or sync-queue entries;
  - any push to the `main` branch.
- Each planning document, when the owner asks for one, follows the template in `flowpos-release-github-memory`, section "Specification template".

## 8. Execution style

- Implement directly. Do not run experiments, trial scripts, side tests, or exploratory builds.
- The only mandatory verification command is `npm run build` (exit code 0), plus the audit checklist in `flowpos-domain-audit`.
- Do not run package installations, system-level commands, or dependency upgrades unless the owner requests them.

## 9. Communication standards

- Write all user-facing summaries, questions, and reports in Arabic. Write commit messages, branch names, code identifiers, and file paths in English.
- Open with the result, not with praise or preamble. Do not close with generic pleasantries.
- Do not give unsolicited refactoring advice. If a real risk is observed outside the scope, add one line under the report heading "Observed, not changed".
- Keep formatting minimal. Use short headings and short lists only where the report template calls for them.

## 10. Verification gate (mandatory before every commit)

1. `npm run build` must finish with exit code 0 and no build or type errors.
2. The domain audit checklist in `flowpos-domain-audit` must pass, or every failed item must be explained.
3. If either gate fails, do not commit and do not push. Fix the cause with a surgical edit (one correction attempt). If the gate still fails, revert the change with an atomic rollback and report the failure precisely.

## 11. Failure handling

- Missing tool or environment (no git, no Node.js, no network): state exactly what is missing and provide the exact commands the owner can run. Never invent a commit hash, build result, or version number.
- Unexpected file content or conflicting state: stop, report the observed state, and ask one question with concrete options.
- Never use destructive git commands (`reset --hard`, `push --force`, `clean -fd`, `checkout --` on unknown changes) unless the owner explicitly requests them.

## 12. Mandatory final report (Arabic)

Every completed task ends with this structure. Omit a section only when it truly does not apply, and say so.

1. **الملخص** — one to three sentences on the result.
2. **الملفات المعدّلة** — each file path and the symbol or section changed.
3. **الملفات غير المعدّلة عمداً** — protected or out-of-scope files that were deliberately left alone.
4. **السلوك الجديد** — what behaves differently now, in user terms.
5. **التحقق** — build result (exit code), audit result, and any check that could not run and why.
6. **الفرع والالتزام** — branch, commit hash, and push result (or the exact reason it was not pushed).
7. **الإصدار** — current version and build number, and whether they changed.
8. **ملاحظات** — only when needed; includes "Observed, not changed" items.
