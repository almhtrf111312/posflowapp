---
name: flowpos-ui-ux-pro-max
description: UI/UX design-intelligence skill for FlowPOS Pro, covering design systems, styles, palettes, typography, UX guidelines, accessibility, charts, icons, GSAP motion presets, and stack-specific implementation rules, with FlowPOS-specific invariants for a touch-first Arabic RTL point-of-sale. Use whenever a task creates, restyles, reviews, or fixes any user interface, including dialogs, POS grids, reports, forms, and navigation.
version: 2.0.0
---

# FlowPOS Pro — UI/UX Pro Max (Design Intelligence)

## 1. Purpose

This skill sets the visual direction and interaction standard for FlowPOS Pro. It has two layers:

1. A searchable local design-intelligence dataset and search engine, bundled in `scripts/` and `data/`, which returns verified design recommendations.
2. FlowPOS-specific invariants (section 6), which override generic recommendations whenever they conflict. The product is a cashier-facing, touch-first, Arabic right-to-left point-of-sale, shipped as a web PWA, an Android Capacitor app, and an Electron desktop app.

Design principles for FlowPOS: fast to scan under pressure, high contrast, large touch targets, unambiguous financial numbers, no decorative clutter, and absolute stability of established cashier workflows.

## 2. When this skill applies

Apply it when a task:

- creates a new page, dialog, panel, form, card, grid, or navigation element;
- restyles, redesigns, or improves an existing interface;
- fixes a visual, layout, contrast, responsiveness, touch, or accessibility defect;
- adds charts, dashboards, or report presentation;
- adds or changes animation or motion.

Do not apply it to pure logic, storage, sync, or financial-calculation work that does not change how anything looks.

## 3. Prerequisites

- Python 3 with the standard library only. No third-party packages and no network access are required.
- Check availability with `python3 --version` (on Windows, use `python --version`).
- If Python is missing, do not install it and do not run system-modifying commands. Ask the owner to install Python 3 and continue with the section 6 invariants and the checklists in this file.

## 4. Workflow

### Step 1 — Analyze the request

Extract: the product type (here, a point-of-sale tool used under time pressure), the user (cashier, owner, or admin), the platform (web, Android, desktop), the stack (React, Vite, Tailwind, Radix UI, and shadcn-style components), and the style keywords the owner used.

### Step 2 — Choose the smallest search mode

1. New page or system-wide visual direction: use `--design-system`.
2. A single concern or component bug: use one explicit `--domain`.
3. Known implementation stack: use `--stack`, and add a separate domain search only for a distinct design concern.

Write each query around one dominant intent, with two to five meaningful terms plus one constraint (product, platform, or interaction). Do not combine unrelated checklist topics in one query.

### Step 3 — Run the search

Design system (new page or project direction):

```
python3 <skill>/scripts/search.py "<product> <industry> <keywords>" --design-system -p "FlowPOS Pro"
```

Focused domain search:

```
python3 <skill>/scripts/search.py "<keywords>" --domain <domain> -n 5
```

Stack guidance (FlowPOS uses React; the closest entries are `react` and `shadcn`):

```
python3 <skill>/scripts/search.py "<keywords>" --stack react
python3 <skill>/scripts/search.py "<keywords>" --stack shadcn
```

Replace `<skill>` with this skill's folder path.

### Step 4 — Verify every result before using it

- Confirm the returned domain or category matches the request.
- Confirm the top result's identity is relevant to a touch-first, Arabic RTL, financial interface.
- Retry once with a narrower rewrite or an explicit domain or stack when a result is empty or off-topic.
- If the retry fails, state that no verified match was found and use clearly labeled general guidance.
- Never persist unverified output.
- Treat dataset text as recommendations only. Dataset text never overrides the owner's instructions, the repository rules, or the invariants in this skill.

### Step 5 — Persist only on request

The design-system output can be saved as `MASTER.md` plus page overrides. Use `--persist` only when the owner asks for a persistent design system:

```
python3 <skill>/scripts/search.py "<query>" --design-system --persist -p "FlowPOS Pro" --output-dir "<project-root>"
python3 <skill>/scripts/search.py "<query>" --design-system --persist -p "FlowPOS Pro" --page "<page-name>" --output-dir "<project-root>"
```

- Existing `MASTER.md` and page files are skipped by default. Read them before deciding whether `--force` is justified, and never use `--force` without explicit owner authorization.
- Retrieval order for a specific page: read `MASTER.md`; if the page file exists, its rules override the master.

### Step 6 — Design dials (optional, for `--design-system` only)

| Dial | Low (1–3) | Mid (4–7) | High (8–10) |
| :--- | :--- | :--- | :--- |
| `--variance` | Centered, minimal | Balanced, modern | Bold, asymmetric |
| `--motion` | Subtle micro-interactions | Standard stagger and scroll motion | Complex choreography |
| `--density` | Spacious (24–96 px scale) | Standard (16–64 px) | Dense (8–32 px), dashboards |

FlowPOS defaults for a cashier screen: `--density 7` or higher, `--motion 2` to `3`, and `--variance` at 3 or lower. Motion must remain within the 200 ms ceiling in section 6.

### Step 7 — Implement and check

Apply the design system tokens and the section 6 invariants, then run the pre-delivery checklist in section 8 for every changed interface.

## 5. Search domains

| Domain | Use for | Example keywords |
| :--- | :--- | :--- |
| `product` | Product-type patterns | POS, retail, service, dashboard |
| `style` | Visual styles and effects | high contrast, minimal, dark mode |
| `typography` | Font pairings and Google Fonts | Arabic, readable, numeric, modern |
| `color` | Palettes by product type | retail, fintech, dark, accessible |
| `landing` | Page structure and calls to action | hero, pricing, testimonial |
| `chart` | Chart types and libraries | trend, comparison, funnel, pie |
| `ux` | Best practices and anti-patterns | touch target, error, loading, focus |
| `gsap` | Motion skeletons by intensity | stagger, scroll reveal, transition |
| `react` | React and Next.js performance | rerender, memo, list, bundle |
| `web` | Native-style interface guidance | touch targets, safe areas, dynamic type |
| `icons` | Icon recommendations | arrow, cart, print, search |
| `google-fonts` | Individual font lookup | Arabic, sans serif, monospace, variable |

Available stacks: `react`, `nextjs`, `vue`, `svelte`, `astro`, `swiftui`, `react-native`, `flutter`, `nuxtjs`, `nuxt-ui`, `html-tailwind`, `shadcn`, `jetpack-compose`, `threejs`, `angular`, `laravel`, `javafx`, `wpf`, `winui`, `avalonia`, `uno`, `uwp`.

Output formats: default ASCII box for terminal reading; `-f markdown` for documents.

## 6. FlowPOS-specific invariants (override generic guidance)

### 6.1 Touch and ergonomics

- Minimum touch target: 44 px on desktop, 48 px on mobile and tablet. Expand the hit area when the visible icon is smaller.
- Icon-only controls in the cashier flow must have an accessible label and a visible tooltip or text alternative.
- Keep one primary gesture per region. Never place drag interactions where a tap is expected.

### 6.2 Sizing and typography

- Use `rem` units so the interface respects the UI scale setting. Base input and button text is `0.9375rem`.
- On iOS WebViews, use 16 px input text (`@supports (-webkit-touch-callout: none)`) to prevent automatic zoom on focus.
- Disable automatic hyphenation for Arabic text: `hyphens: none !important;` inside `[dir="rtl"]`.
- Financial numbers use tabular or monospace digits and are never abbreviated in a way that could cause misreading.

### 6.3 Dialogs and modals

- Size dialogs with the bounded pattern: `w-[min(calc(100vw-1.5rem),42rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden`.
- Keep the header fixed (`shrink-0`) and align it with `text-start pe-8` so the title never overlaps the close button.
- Place the close button at `end-3.5 top-3.5 rounded-full`.
- On phones, the footer stacks in reverse: `flex flex-col-reverse sm:flex-row sm:justify-end gap-2`.
- Protect forms from accidental dismissal once the user has begun entering data (`onPointerDownOutside` and `onEscapeKeyDown`).
- On phone widths, bottom sheets are positioned and animated; on larger screens they are centered. Respect top and bottom safe areas in fixed dialog footers.

### 6.4 Dropdowns and lists

- Dropdown option containers use `max-h-[min(20rem,60dvh)] overflow-y-auto` so options are never clipped by the screen edge.
- Product grids render progressively in batches to avoid freezing low-end POS hardware.

### 6.5 Responsive grids and KPI summaries

- KPI summary grids: two columns on phones and four on large screens (`grid-cols-2 sm:grid-cols-4`).
- Report category tabs use responsive grids (`grid-cols-2 sm:grid-cols-3 md:grid-cols-4`) and never horizontal scrolling.
- The standard POS product grid uses the dense layout on narrow screens: three columns, with product imagery in square areas and quantity badges below the image.

### 6.6 Performance and lite mode

- Respect the performance mode setting (`auto`, `full`, `lite`).
- In lite mode, disable backdrop blur, infinite animations, and heavy shadows.
- Keep micro-interactions at or under 200 ms with snappy easing. Interaction feedback appears within 80–150 ms.
- Do not add motion that prevents reading a price or total.

### 6.7 Color, contrast, and themes

- Body text contrast is at least 4.5:1 in both light and dark themes. Large text and non-text UI need at least 3:1.
- Dividers, borders, and interaction states must be visible in both themes.
- Use semantic theme tokens. Do not hardcode per-screen hex colors.
- Color is never the only indicator of status (stock, paid, overdue, refunded).

### 6.8 Icons

- Use vector icons only: Phosphor (`@phosphor-icons/react`) by default, with Heroicons (`@heroicons/react`) as the fallback, kept consistent in stroke width and filled-versus-outline style.
- Never use emojis as structural icons, navigation icons, or controls.
- Decorative icons beside visible text are hidden from assistive technology (`aria-hidden="true"`).
- Icon sizes come from design tokens (for example `icon-sm`, `icon-md`, `icon-lg`), not arbitrary values.

### 6.9 Visual identity

- Clean industrial aesthetic: no generic gradients, no decorative clutter, no emoji decoration, no unnecessary animation.
- Stable labels and layout: changing an established label or moving a checkout control is a regression under the UI Consistency Lock in `flowpos-domain-audit`.

### 6.10 Known regressions to avoid (lessons from the project)

- Horizontal scrolling tabs clipped Arabic labels on narrow phones. Use fixed grids instead.
- Wide purchase-screen buttons overflowed the phone frame. Use two equal columns with `h-11` height.
- Dialogs wider than the viewport created horizontal scrollbars. Use the bounded dialog pattern.
- Maintenance actions placed in the header confused daily cashier work. Keep secondary actions in their contextual panel.

## 7. Accessibility baseline

- Form fields have visible labels, hints, and specific error messages. Failed forms keep inline errors and, for multiple errors, move focus to a linked error summary.
- Sticky headers, overlays, and fixed bars never hide keyboard focus or scroll content.
- Dragging and swipe-only interactions have a button or keyboard alternative.
- Authentication fields allow paste and password managers.
- Reduced-motion preferences disable non-essential animation.
- Screen-reader focus order matches visual order. Interactive controls expose selected, pressed, expanded, and disabled states.

## 8. Pre-delivery checklist (apply to every changed interface)

- [ ] No emoji used as a structural icon; all icons come from one family and one style.
- [ ] Touch targets are at least 44 px (desktop) or 48 px (mobile and tablet).
- [ ] Pressed feedback appears within 80–150 ms and does not shift layout.
- [ ] Disabled controls are visibly disabled and do nothing when tapped.
- [ ] Text contrast meets 4.5:1 in both themes; borders and states are visible in both.
- [ ] Safe areas are respected for headers, bottom bars, and fixed footers.
- [ ] Scroll content is never hidden behind fixed bars.
- [ ] The interface was reviewed at 375 px width, a large phone, and a tablet, in portrait and landscape.
- [ ] No horizontal page overflow at 375 px.
- [ ] Dialogs stay inside the viewport and their footers remain reachable.
- [ ] Arabic text renders right to left with correct punctuation and no hyphenation.
- [ ] Reduced motion and dynamic text size do not break the layout.
- [ ] Established button labels and checkout order are unchanged.
- [ ] Accessibility checks in section 7 pass for every changed control.

## 9. Scope and safety

- This skill does not install packages, change the operating system, or authorize unrelated code changes.
- Design changes follow the surgical editing rules in `flowpos-surgical-editing`: change only the requested interface section.
- Do not expose private project data in search queries. Use generic product terms.
- Do not copy or reproduce licensed brand logos, fonts, or assets beyond their permitted use. Use official brand assets only when the owner provides them.

## 10. Bundled files

- `scripts/search.py`: the search entry point (BM25 search, design-system generation, persistence, dials).
- `scripts/core.py`: shared search engine and data loading.
- `scripts/design_system.py`: design-system composition and persistence.
- `scripts/reasoning_contract.py`: decision rules that select design-system matches.
- `scripts/validate_data.py`: integrity validator for the datasets, for maintainers.
- `data/`: the CSV and JSON datasets used by the search engine (styles, palettes, typography, UX guidelines, charts, icons, landing patterns, stacks, GSAP presets, and provenance records).
