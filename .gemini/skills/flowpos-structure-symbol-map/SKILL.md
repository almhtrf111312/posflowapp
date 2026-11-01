---
name: flowpos-structure-symbol-map
description: Structure, symbol, and number mapping skill for large FlowPOS Pro files. Produces outlines, symbol line ranges, Mermaid dependency diagrams, and numeric or financial-value maps so an editing agent can reach the exact lines it needs. Use before editing any file over 150 lines and whenever a task requires locating code, constants, or money-related numbers.
version: 2.0.0
---

# FlowPOS Pro — Structure, Symbol, and Number Map

## 1. Purpose

Large files are expensive to read and easy to misread. This skill replaces blind reading with a map: first the structure, then the exact range, then the exact lines. It also produces diagrams of module structure and a register of numeric values, with financial values flagged so they receive extra care.

## 2. The bundled tool

- Location: `scripts/flowpos_map.py` inside this skill folder.
- Requirements: Python 3, standard library only. No installation and no network access.
- Read-only: the tool never modifies a file.
- Invocation (replace `<skill>` with this skill's folder path):

```
python3 <skill>/scripts/flowpos_map.py <command> <file> [arguments]
```

On Windows, use `python` instead of `python3`.

## 3. Commands

| Command | Arguments | What it returns | When to use |
| :--- | :--- | :--- | :--- |
| `map` | `<file>` | Size, line count, declaration count, import count, count of money-related number lines | First look at any unfamiliar file |
| `outline` | `<file>` | Every declaration, method, SQL object, Markdown heading, or top-level JSON key, with its line number | Before reading any file over 150 lines |
| `symbol` | `<file> <name>` | Start and end line of one symbol, found by matching braces and parentheses | Before reading or replacing one function, component, or constant |
| `window` | `<file> <start> <end>` | Numbered lines in the range (maximum 300 lines) | Reading the exact code to edit |
| `numbers` | `<file> [--all]` | Numeric literals by line, with money-related lines tagged `[MONEY]` first | Auditing constants, rates, formulas, rounding |
| `imports` | `<file>` | Import and re-export lines, plus a Mermaid dependency diagram | Understanding a module's dependencies |

Supported file types for `outline` and `symbol`: JavaScript, TypeScript, JSX and TSX, SQL, Markdown, and JSON. For other text files, use `window` and `numbers`.

## 4. Map-first workflow (mandatory for files over 150 lines)

1. Run `map` to learn the size and the complexity.
2. Run `outline` and identify the target section by name and line number.
3. Run `symbol` for the target to get its exact range, or use `window` with the range from `outline`.
4. Read only that range (plus the context needed for a correct edit).
5. After editing, read only the edited range again to confirm.

## 5. Diagrams

- Produce a structure diagram only when the owner asks for an architecture view, or when a large module's dependencies must be explained.
- Use the output of `imports` as the basis for a Mermaid `flowchart LR`. Keep diagrams to about 60 nodes. Group the rest under a single node labeled with the count.
- Draw flows and sequences only from information that was actually read. Never invent a flow from memory.
- Mermaid blocks render in the published pages and in Markdown files that use a fenced `mermaid` block.

## 6. Number map and financial values

- Lines tagged `[MONEY]` by the tool contain financial keywords (price, cost, tax, discount, profit, rate, exchange, total, amount, round, decimal, precision, margin, debt, paid, balance, share, percent, WAC, quantity, currency). Treat every such line as financially sensitive.
- Never change a `[MONEY]` line unless the task is explicitly about that calculation. Before changing one, apply `flowpos-financial-calculations` and `flowpos-domain-audit`.
- Keep a short register in the report when a task touches numbers: value, line, meaning, and whether it changed.
- Ignore `0` and `1` in the output; they are structural, not meaningful constants.

## 7. Output format for maps shown to the owner

- Show the outline as a compact list: line number, kind, name. Do not repeat the file contents.
- Show a diagram only when it adds information the list cannot.
- Keep the whole map under fifteen lines unless the owner asks for the full map.

## 8. Limits and verification rules

- The tool is pattern-based. Its `symbol` ranges are approximate; always confirm with `window` before editing.
- The tool does not understand JSX structure deeply and may miss unusual declaration styles. When a symbol is not found, fall back to a single exact search for its name.
- Results describe the file as it is on disk right now. Re-run `outline` after any external change.
- Do not persist maps to the repository unless the owner asks. Keep them in the session to protect the diff and keep the repository clean.

## 9. Relation to other skills

- `flowpos-surgical-editing` decides what to read and how to edit. This skill supplies the map that makes those reads small.
- `flowpos-domain-audit` decides whether a changed `[MONEY]` line or a changed storage line is safe.
