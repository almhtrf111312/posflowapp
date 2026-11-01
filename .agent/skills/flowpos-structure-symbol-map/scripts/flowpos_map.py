#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
flowpos_map.py - Structure, symbol and number mapper for large project files.

Purpose: let an editing agent read only what it needs from large files.
Python standard library only. Read-only: this script never modifies files.

Commands:
  outline  <file>                 Symbols/headings/keys with line numbers.
  window   <file> <start> <end>   Numbered lines in a range (max 300 lines).
  symbol   <file> <name>          Line range of one symbol (brace/paren matched).
  numbers  <file> [--all]         Numeric literals grouped by line (money-sensitive first).
  imports  <file>                 Imports and re-exports, plus a Mermaid dependency diagram.
  map      <file>                 Compact summary: size, outline count, numbers count, imports.

Supported outline types: JS/TS/TSX/JSX (.js .jsx .ts .tsx .mjs .cjs), SQL (.sql),
Markdown (.md), JSON (.json). Other text files: use window or numbers.
"""

import json
import os
import re
import sys

MAX_WINDOW = 300
MAX_NUMBERS_DEFAULT = 200
MONEY_HINTS = re.compile(
    r"(price|cost|tax|discount|profit|rate|exchange|total|amount|round|decimal|"
    r"precision|margin|debt|paid|balance|share|percent|wac|qty|quantity|usd|currency)",
    re.IGNORECASE,
)
JS_EXTS = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"}

JS_DECL_PATTERNS = [
    ("function", re.compile(r"^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)")),
    ("class", re.compile(r"^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)")),
    ("interface", re.compile(r"^\s*(export\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)")),
    ("const", re.compile(r"^\s*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)")),
]
JS_METHOD = re.compile(r"^(\s{2,})(public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*(<[^>]*>)?\s*\([^;]*$")
SQL_DECL = re.compile(
    r"^\s*(CREATE\s+(OR\s+REPLACE\s+)?(TABLE|FUNCTION|VIEW|POLICY|INDEX|TRIGGER|TYPE)|ALTER\s+TABLE)\s+(IF\s+NOT\s+EXISTS\s+)?([\"\w.]+)",
    re.IGNORECASE,
)
MD_HEADING = re.compile(r"^(#{1,6})\s+(.*)")
IMPORT_RE = re.compile(r"^\s*import\s+(?:type\s+)?(?:[^'\"]*?\s+from\s+)?['\"]([^'\"]+)['\"]")
REEXPORT_RE = re.compile(r"^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['\"]([^'\"]+)['\"]")
NUMBER_RE = re.compile(r"(?<![\w.$])(\d+(?:\.\d+)?)(?![\w.])")


def read_lines(path):
    if not os.path.isfile(path):
        sys.exit(f"ERROR: file not found: {path}")
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return handle.read().splitlines()


def ext_of(path):
    return os.path.splitext(path)[1].lower()


def cmd_outline(path):
    lines = read_lines(path)
    ext = ext_of(path)
    entries = []
    if ext in JS_EXTS:
        for index, line in enumerate(lines, start=1):
            matched = False
            for kind, pattern in JS_DECL_PATTERNS:
                match = pattern.match(line)
                if match:
                    name = match.group(match.lastindex)
                    entries.append((index, kind, name))
                    matched = True
                    break
            if not matched:
                method = JS_METHOD.match(line)
                if method and method.group(3) not in {"if", "for", "while", "switch", "catch", "return", "function"}:
                    entries.append((index, "method", method.group(3)))
    elif ext == ".sql":
        for index, line in enumerate(lines, start=1):
            match = SQL_DECL.match(line)
            if match:
                entries.append((index, "sql", match.group(5)))
    elif ext == ".md":
        for index, line in enumerate(lines, start=1):
            match = MD_HEADING.match(line)
            if match:
                entries.append((index, "h" + str(len(match.group(1))), match.group(2).strip()))
    elif ext == ".json":
        try:
            data = json.loads("\n".join(lines))
        except json.JSONDecodeError as error:
            sys.exit(f"ERROR: invalid JSON: {error}")
        if isinstance(data, dict):
            for key, value in data.items():
                kind = type(value).__name__
                size = len(value) if isinstance(value, (list, dict)) else ""
                entries.append((0, kind, f"{key}{' (' + str(size) + ' items)' if size != '' else ''}"))
        else:
            entries.append((0, type(data).__name__, f"{len(data)} items"))
    else:
        sys.exit("Unsupported type for outline. Use: window, numbers, or imports.")

    if not entries:
        print("No declarations found.")
        return
    width = max(len(str(e[0])) for e in entries)
    for line_no, kind, name in entries:
        shown = str(line_no) if line_no else "-"
        print(f"{shown.rjust(width)}  {kind:<10} {name}")
    print(f"-- {len(entries)} entries, {len(lines)} lines total")


def cmd_window(path, start, end):
    lines = read_lines(path)
    if start < 1:
        start = 1
    if end > len(lines):
        end = len(lines)
    if end - start + 1 > MAX_WINDOW:
        end = start + MAX_WINDOW - 1
        print(f"(window capped at {MAX_WINDOW} lines)")
    for index in range(start, end + 1):
        print(f"{index:>6}  {lines[index - 1]}")


def cmd_symbol(path, name):
    lines = read_lines(path)
    start = None
    for index, line in enumerate(lines, start=1):
        for _, pattern in JS_DECL_PATTERNS:
            match = pattern.match(line)
            if match and match.group(match.lastindex) == name:
                start = index
                break
        if start:
            break
        method = JS_METHOD.match(line)
        if method and method.group(3) == name:
            start = index
            break
    if start is None:
        sys.exit(f"Symbol not found: {name}")

    depth = 0
    opened = False
    in_block_comment = False
    end = start
    for index in range(start, len(lines) + 1):
        text = lines[index - 1]
        i = 0
        quote = None
        while i < len(text):
            ch = text[i]
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if in_block_comment:
                if ch == "*" and nxt == "/":
                    in_block_comment = False
                    i += 2
                    continue
                i += 1
                continue
            if quote:
                if ch == "\\":
                    i += 2
                    continue
                if ch == quote:
                    quote = None
                i += 1
                continue
            if ch == "/" and nxt == "/":
                break
            if ch == "/" and nxt == "*":
                in_block_comment = True
                i += 2
                continue
            if ch in "'\"`":
                quote = ch
            elif ch in "({[":
                depth += 1
                opened = True
            elif ch in ")}]":
                depth -= 1
            i += 1
        if opened and depth <= 0:
            end = index
            break
        end = index
        if not opened and text.rstrip().endswith(";"):
            end = index
            break
    print(f"{name}: lines {start}-{end} ({end - start + 1} lines). Approximate match; verify with window.")


def cmd_numbers(path, show_all):
    lines = read_lines(path)
    rows = []
    for index, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith(("//", "*", "/*")):
            continue
        found = [m.group(1) for m in NUMBER_RE.finditer(line)]
        found = [value for value in found if value not in {"0", "1"}]
        if not found:
            continue
        money = bool(MONEY_HINTS.search(line))
        rows.append((0 if money else 1, index, found, stripped[:140]))
    if not rows:
        print("No significant numeric literals found.")
        return
    rows.sort(key=lambda row: (row[0], row[1]))
    limit = len(rows) if show_all else MAX_NUMBERS_DEFAULT
    for priority, index, found, snippet in rows[:limit]:
        tag = "[MONEY]" if priority == 0 else "       "
        print(f"{index:>6} {tag} {','.join(found):<18} {snippet}")
    if len(rows) > limit:
        print(f"-- showing {limit} of {len(rows)} lines (use --all for everything)")
    else:
        print(f"-- {len(rows)} lines with numeric literals")


def cmd_imports(path):
    lines = read_lines(path)
    edges = []
    for index, line in enumerate(lines, start=1):
        match = IMPORT_RE.match(line) or REEXPORT_RE.match(line)
        if match:
            edges.append((index, match.group(1)))
    if not edges:
        print("No imports found.")
        return
    for index, module in edges:
        print(f"{index:>6}  {module}")
    print("")
    print("```mermaid")
    print("flowchart LR")
    print(f'    F["{os.path.basename(path)}"]')
    for position, (_, module) in enumerate(edges[:60]):
        print(f'    F --> M{position}["{module}"]')
    print("```")
    if len(edges) > 60:
        print(f"-- diagram limited to 60 of {len(edges)} imports")


def cmd_map(path):
    lines = read_lines(path)
    size = os.path.getsize(path)
    ext = ext_of(path)
    outline_count = 0
    if ext in JS_EXTS or ext in {".sql", ".md"}:
        for line in lines:
            if any(p.match(line) for _, p in JS_DECL_PATTERNS) or SQL_DECL.match(line) or MD_HEADING.match(line):
                outline_count += 1
    import_count = sum(1 for line in lines if IMPORT_RE.match(line) or REEXPORT_RE.match(line))
    money_lines = sum(1 for line in lines if NUMBER_RE.search(line) and MONEY_HINTS.search(line))
    print(f"file: {path}")
    print(f"size: {size} bytes | lines: {len(lines)}")
    print(f"declarations/headings: {outline_count}")
    print(f"imports/re-exports: {import_count}")
    print(f"lines with money-related numbers: {money_lines}")
    print("next: outline -> symbol -> window (read only the range you need)")


def main(argv):
    if len(argv) < 3 or argv[1] in {"-h", "--help", "help"}:
        print(__doc__)
        return 0
    command, path = argv[1], argv[2]
    rest = argv[3:]
    if command == "outline":
        cmd_outline(path)
    elif command == "window":
        if len(rest) != 2 or not all(item.isdigit() for item in rest):
            sys.exit("Usage: flowpos_map.py window <file> <start> <end>")
        cmd_window(path, int(rest[0]), int(rest[1]))
    elif command == "symbol":
        if len(rest) != 1:
            sys.exit("Usage: flowpos_map.py symbol <file> <name>")
        cmd_symbol(path, rest[0])
    elif command == "numbers":
        cmd_numbers(path, "--all" in rest)
    elif command == "imports":
        cmd_imports(path)
    elif command == "map":
        cmd_map(path)
    else:
        sys.exit(f"Unknown command: {command}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
