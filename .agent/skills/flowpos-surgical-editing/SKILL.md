---
name: flowpos-surgical-editing
description: Token-efficient surgical editing protocol for FlowPOS Pro. Use for every read and every edit of project files. Enforces zero repository scanning, outline-first reading of large files, symbol and line-range reads, minimal anchored diffs, preservation of untouched sections, reference checks before shared changes, and strict output economy.
version: 2.0.0
---

# FlowPOS Pro — Surgical Editing and Token Economy

## 1. Purpose

Change exactly the required target and nothing else, while reading and writing the smallest amount of text that correctly completes the task. Every rule below exists to protect three things: the owner's token budget, the stability of unrelated code, and the offline-first accounting logic.

## 2. Zero-scan targeting

1. Never run recursive scans (`find .`, `ls -R`, `tree`) or repository-wide searches when the task names a file, component, or module.
2. Open the named file directly by its path.
3. When only a symbol name is given, perform one exact lookup, either `rg -n "ExactName" src` or the `symbol` command of `flowpos-structure-symbol-map`, then open only the file that matches.
4. When a request is ambiguous or could touch unrelated layers (UI versus Supabase, for example), stop before reading more and ask one concrete question with options.

## 3. Reading protocol

Apply these steps to every file, in order:

1. Measure the file: line count and size (`wc -l`, or the `map` command of the structure mapper).
2. Files of 150 lines or fewer: read the whole file once.
3. Files over 150 lines: request the outline first (`outline` command). Do not read the body yet.
4. Read only the target range: a whole symbol (`symbol` command) or a window with at most 10 context lines above and below.
5. Read each range once per session. Reuse earlier output. Re-read only when the file changed outside the conversation.
6. Never read these by default: lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `bun.lock`, `deno.lock`), build outputs (`dist/`, `build/`, `android/` generated folders), binary assets, build logs (`build_log.txt`, `build_error.txt`, `build_out*.txt`, `deploy_log.txt`), and any file over 100 KB unless the owner names it explicitly.

## 4. Editing protocol

1. Prefer symbol-level edits when a symbol-aware toolset is available: `replace_symbol_body` for a function, method, or component body; `insert_after_symbol` and `insert_before_symbol` for helpers and imports; `find_referencing_symbols` before changing a shared signature; `rename_symbol` for renames.
2. Otherwise use targeted search-and-replace (`str_replace`) with the smallest unique anchor, normally three to five lines, copied exactly from a fresh read.
3. Never include line-number prefixes from the viewer in replacement text.
4. Several edits in one file: apply them bottom-to-top, or in one batch, so earlier edits do not shift later line numbers.
5. Never rewrite a whole file to change a few lines. Full-file writing is allowed only for new files, or when the owner explicitly requests a rewrite.
6. Never restate unchanged functions in the output.
7. Before changing a shared function signature, hook, store, Dexie helper, sync-queue type, or currency formatter, find every reference first and list the impact in the report.
8. Preserve, unless the comment is directly obsolete because of the change:
   - Arabic and English comments, JSDoc blocks, and architecture annotations;
   - logging calls (`console.error`, `logActivity`, `errorRadar`);
   - unrelated imports, props, and type annotations;
   - established button labels and UI text (the UI Consistency Lock in `flowpos-domain-audit`);
   - formatting of every line outside the changed section.
9. Add only the imports the change needs. Use `import type` for type-only imports. Guard native plugin imports as described in `flowpos-domain-audit`.
10. Keep UTF-8 without BOM. Never introduce mojibake. Prefer English anchors when the nearby text is Arabic, so encoding mismatches cannot break the replacement.
11. If an edit breaks the build or changes behavior unexpectedly, revert that exact edit immediately before attempting any correction (atomic rollback).

## 5. Section scope rule

- Each task names a section: a function, component, dialog, table block, or configuration entry. Change only that section.
- If correct completion requires touching another section, state the reason in one line in the report and touch only the minimum extra lines.
- Never tidy nearby code, reorder imports, rename variables, reformat, adjust styling, or update unrelated copy in untouched sections.

## 6. Tool-call budget

- Standard targeted fix: five to eight tool calls in total. Batch independent reads into one turn.
- Above twelve calls, the scope is probably too wide. Stop, summarize what was found, and ask the owner to narrow the scope.

## 7. Output economy

- Do not paste unchanged code, full files, or long diffs into the reply.
- Show a code excerpt only when the owner asks for it, and keep it to fifteen lines or fewer.
- Report using the mandatory report template in `flowpos-core-workflow`. Keep each field to one to three sentences.

## 8. Routing table: banned action versus required action

| Objective | Banned (high token cost or high risk) | Required |
| :--- | :--- | :--- |
| Understand a large file | Reading the entire file | Outline first, then the needed window |
| Locate a function or hook | Repository-wide `grep` or `find` | Symbol lookup in the named file |
| Find callers of a function | Opening every importing file | Reference search for that symbol |
| Change 20 lines in a 1,000-line file | Rewriting the file | Symbol replacement or anchored `str_replace` |
| Add a helper | Rewriting the module | Insert after an anchor symbol |
| Rename a symbol across files | Multi-file regex replacement | Symbol rename, or list references and edit each one by anchor |
| Read the same file again | Re-reading without reason | Reuse earlier output |
| Show a result | Printing unchanged code | Short report with file and symbol references |

## 9. Safety conditions for editing

- Frozen modules (listed in `flowpos-domain-audit`) are never opened, read, audited, or edited unless the owner explicitly asks to re-enable them.
- SQL, migrations, RPC definitions, and RLS policies are never executed. A proposal must be shown and approved first.
- Local storage and IndexedDB are never cleared by code, scripts, or debug helpers.

## 10. Outcome check

After an edit, confirm with a narrow read of the changed range only, not a full re-read. Then move to the verification gate in `flowpos-core-workflow`.
