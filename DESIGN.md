---
name: PrintForge
description: 3D print farm operations tool — focused, fast, reliable
colors:
  primary: "#2563eb"
  primary-hover: "#1d4ed8"
  primary-subtle: "#eff6ff"
  primary-nav-active: "#dbeafe"
  surface: "#ffffff"
  surface-raised: "#f8fafc"
  foreground: "#0f172a"
  foreground-muted: "#64748b"
  border: "#e2e8f0"
  destructive: "#dc2626"
  success: "#16a34a"
  warning: "#d97706"
  surface-dark: "#0a0e1f"
  surface-card-dark: "#111827"
  border-dark: "#1f2937"
typography:
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "0.05em"
  mono:
    fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  full: "9999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground-muted}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  nav-item-active:
    backgroundColor: "{colors.primary-nav-active}"
    textColor: "{colors.primary-hover}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  badge-default:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.foreground-muted}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
---

# Design System: PrintForge

## 1. Overview

**Creative North Star: "The Operator's Ledger"**

PrintForge is not a dashboard that announces itself. It is a ledger: a precise, unadorned record of operational truth. Every screen exists to answer one question faster than the operator could ask it. The visual system takes its cue from Linear's light-mode variant: white surfaces, a single authoritative blue accent, monospaced numerics, and negative space used only where it helps the eye navigate, never as decoration.

The interface disappears. The data remains. A production status, a filament weight, a cost in OMR — these are the things that matter. Typography is system-native (no custom font load delays in a workshop environment). Color is restrained to one role: the brand blue marks what is interactive or selected. Everything else is neutral.

This system explicitly rejects the aesthetic families listed in PRODUCT.md: no SaaS cream, no dark-neon print-farm aesthetic, no enterprise navy, no glassmorphism, no hero-metric template, no entrance animations or data loading choreography. When something feels decorative rather than functional, remove it.

**Key Characteristics:**
- White-dominant surfaces with a subtle cool-gray hierarchy
- Single blue accent (#2563eb), used only on interactive and active states
- Monospaced numerics for all quantities, weights, costs, and temperatures
- Flat elevation at rest; shadow only as a state response (hover, focus)
- Table-first layout: information density over empty-state padding
- Light mode primary; dark mode matches fidelity, not just inverts

## 2. Colors: The Ledger Palette

One accent. The rest is structure.

### Primary
- **Instrument Blue** (#2563eb / oklch(54.6% 0.246 264)): The single interactive accent. Used on primary buttons, active navigation items, focus rings, links, and selected states. Appears on less than 15% of any given screen; its rarity is the signal.
- **Instrument Blue Deep** (#1d4ed8 / oklch(47.5% 0.243 264)): Hover and pressed state for primary interactive elements only.
- **Instrument Blue Subtle** (#eff6ff): Background tint on active navigation items in the sidebar. Never used as a content background.
- **Instrument Blue Nav** (#dbeafe): Active nav item background in combination with the deep blue text. Communicates location without weight.

### Neutral
- **Ledger White** (#ffffff): Default surface for cards, panels, the topbar, and the sidebar. Not pure white in spirit: keep it paired with the cool-gray border so it reads as structured, not empty.
- **Page Gray** (#f8fafc): Table header backgrounds, muted section backgrounds, skeleton loading states. One step off white.
- **Ink** (#0f172a): Primary text. All headings, table cell values, form labels. Never use for decorative elements.
- **Margin Gray** (#64748b): Secondary text, placeholder text, muted metadata, icon fills at rest. Must still pass WCAG AA against white.
- **Rule Gray** (#e2e8f0): Borders, dividers, table row separators. Lightweight; visible but not dominant.

### Semantic
- **Fault Red** (#dc2626): Destructive actions (delete buttons), error states, low-stock alerts. Never used decoratively.
- **Stock Green** (#16a34a): Success states, "in stock" indicators, job completed badges.
- **Queue Amber** (#d97706): Warning states, low-stock warnings, queued job status.

### Dark Mode Surfaces
- **Forge Dark** (#0a0e1f): Dark mode page background. Tinted toward blue, not pure black.
- **Panel Dark** (#111827): Dark mode card and sidebar surface.
- **Line Dark** (#1f2937): Dark mode borders and dividers.

**The One Voice Rule.** The primary blue is the only color that signals interactivity or selection. Do not introduce secondary accent colors for status badges, chart series, or section differentiation. Status uses semantic colors (red/green/amber). Charts use tonal steps of the neutral scale.

## 3. Typography

**Body Font:** system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif (system stack)
**Mono Font:** ui-monospace, 'Cascadia Code', 'Fira Code', monospace (system monospace stack)

**Character:** No custom font is loaded. The system stack eliminates a network round-trip in a workshop environment and inherits the OS's screen-optimized hinting. The mono stack carries all numeric data: weights, costs, temperatures, durations. The contrast between the proportional sans and the monospaced numerics is the typographic personality.

### Hierarchy
- **Title** (semibold 600, 1.125rem/18px, -0.01em tracking, lh 1.25): Card titles, section headers, dialog titles, page headings. Not used for decorative text.
- **Body** (regular 400, 0.875rem/14px, normal, lh 1.5): All table cell content, form field values, description text. Max line length 70ch on reading surfaces.
- **Label** (medium 500, 0.75rem/12px, 0.05em tracking, lh 1.25): Table column headers (uppercase), badge text, form field labels, tag-style metadata.
- **Mono** (regular 400, 0.875rem/14px, monospace, lh 1.5): All numeric output — grams, minutes, OMR values, temperatures, filament lengths, job IDs. Monospace locks numeric columns to consistent width.

**The Mono Ledger Rule.** Every quantity, measurement, or currency value uses the monospace stack. Not just `font-variant-numeric: tabular-nums` on a proportional font — the full monospace family. This applies to table cells, KPI readouts, input fields showing numeric values, and inline cost displays. OMR values always show 3 decimal places (e.g., 1.250 OMR, not 1.25).

## 4. Elevation

Flat by default. This system does not use decorative shadows to make surfaces feel "elevated." Depth is conveyed through background color steps (white surface on page-gray background), borders, and whitespace. The shadow vocabulary is reserved for state responses only.

### Shadow Vocabulary
- **Ambient Low** (`box-shadow: 0 1px 2px 0 rgba(15,23,42,0.05)`): Cards and containers at rest. So subtle it is almost invisible; its job is to lift the card off the page-gray background, not to announce itself. Used on `<Card>` components.
- **Interactive Lift** (`box-shadow: 0 1px 3px 0 rgba(15,23,42,0.10), 0 1px 2px -1px rgba(15,23,42,0.10)`): Primary buttons at rest (shadow-sm). Communicates that the element is pressable.
- **Modal Presence** (`box-shadow: 0 10px 15px -3px rgba(15,23,42,0.10), 0 4px 6px -4px rgba(15,23,42,0.10)`): Dialog panels only. Separates the modal from the dimmed backdrop.

**The Flat-By-Default Rule.** Surfaces are flat at rest. A shadow on a table row, a sidebar, or a stat cell is not in this system. If you feel the need to add a shadow to a non-interactive surface, the layout needs fixing, not a shadow.

## 5. Components

### Buttons
Clean, readable, no rounded extremes. Shape communicates solidity.

- **Shape:** Gently rounded (8px radius) — not pill, not sharp. Reads as functional, not playful.
- **Primary:** #2563eb background, white text, `shadow-sm`. Padding 8px 16px (md). Hover shifts to #1d4ed8 with `transition-colors`.
- **Secondary:** #f8fafc background, #0f172a text, no shadow. Hover to gray-200. Used for non-destructive secondary actions alongside a primary.
- **Outline:** White background, #e2e8f0 border, #374151 text. Used for import/export, upload triggers, and actions that don't compete with a primary.
- **Ghost:** Transparent, #64748b text. Used in toolbars, icon-button rows, the topbar logout, and anywhere space is tight.
- **Destructive:** #dc2626 background, white text. Used only for permanent or dangerous operations (delete product, remove component). Never used for warnings.
- **Focus:** 2px ring, #3b82f6, 2px offset. Visible on keyboard nav; never suppressed.
- **Disabled:** 50% opacity, pointer-events none. No alternative disabled styling.

### Badges / Status Chips
Compact semantic labels. Pill-shaped (9999px radius), 12px text, medium weight.

- **Default (gray):** #f8fafc background, #64748b text. For neutral metadata, role labels.
- **Success (green):** #dcfce7 background (green-100), #15803d text (green-700). Job complete, in-stock.
- **Warning (amber):** #fef9c3 background, #a16207 text. Low stock, queued status.
- **Error (red):** #fee2e2 background, #b91c1c text. Failed job, out of stock.
- **Info (blue):** #dbeafe background, #1d4ed8 text. In-progress, informational state.

Dark mode: all badge backgrounds shift to 30% opacity tints (e.g., `bg-green-900/30 text-green-400`).

### Cards / Containers
Cards are used to group related data sections — BOM, cost breakdown, printer stats. They are not used as navigation affordances or link targets.

- **Corner Style:** Gently rounded (12px, one step up from buttons). Consistent across all card sizes.
- **Background:** White (#ffffff light / #111827 dark).
- **Shadow:** Ambient Low at rest.
- **Border:** 1px #e2e8f0 (light) / 1px #1f2937 (dark).
- **Header Padding:** 24px (p-6). Title is 1.125rem semibold.
- **Content Padding:** 24px top removed (p-6 pt-0) — header provides the top space.

**The No Nested Cards Rule.** Cards are never placed inside cards. If a section within a card needs grouping, use a border-top separator, a background-tinted row, or a plain heading. Nested cards add elevation noise with no informational payoff.

### Tables
The primary layout pattern for operational data: jobs, orders, materials, products, spools.

- **Header:** #f8fafc background (dark: #1f2937/50), 10px text, medium weight, uppercase, 0.05em tracking, #64748b color. 40px row height. Border-bottom divides header from body.
- **Row:** Border-bottom #e2e8f0 (dark: #1f2937). Hover: #f8fafc (dark: #1f2937/50). 12px vertical padding per cell, 16px horizontal.
- **Numeric cells:** Always mono font stack. Right-aligned when in a column with other numerics.
- **Status cells:** Badge component, never raw text color.
- **Actions column:** Ghost buttons or icon buttons, right-aligned, revealed on row hover in dense tables.

**The Table-First Rule.** When in doubt, use a table. Cards feel lighter but hide columns on mobile and break scan patterns. Use a table with overflow-x scroll over a card grid for any list of more than 3 items with more than 2 attributes.

### Inputs / Fields
- **Style:** 40px height, 8px radius, 1px #e2e8f0 border, white background. 14px text. 12px horizontal padding.
- **Focus:** 2px ring #3b82f6, border becomes transparent. The ring is the focus indicator; the border disappears to avoid double-outline.
- **Error:** Border shifts to #dc2626. Error message below in 12px red text.
- **Disabled:** 50% opacity, `cursor-not-allowed`.
- **Label:** Above the input, 14px medium, #374151. Required asterisk in red if applicable.

### Navigation Sidebar
256px fixed width. Border-right separates it from content. White background (dark: #111827).

- **Logo:** 20px bold, brand blue (#2563eb light / #60a5fa dark). Top-left, 64px header row with border-bottom.
- **Nav items:** 14px medium, rounded-md, 8px vertical 12px horizontal padding, 4px gap-1 spacing between items (space-y-1). Icon 20px, flex-shrink-0.
- **Active:** #dbeafe background, #1d4ed8 text (dark: #172554 background, #93c5fd text). No side-stripe. No bold weight change. Background tint is the sole active indicator.
- **Inactive hover:** #f8fafc background, #111827 text (dark: #1f2937 hover, #f1f5f9 text).
- **Skeleton loading:** Pulsing gray blocks while `/auth/me` resolves. 7 placeholder items at varied widths.
- **Mobile:** Off-canvas. Translates in 200ms ease-out. Black/50 backdrop overlay.

### Dialog / Modal
Used for create/edit/delete confirmations. Not used for inline expansions or detail views.

- **Overlay:** `bg-black/50`, full-screen, dismisses on click.
- **Panel:** Max 512px wide (max-w-lg), 24px padding, 12px radius, white (dark: #111827), Modal Presence shadow. Centered both axes.
- **Header:** Title 18px semibold + close icon-button (X, 20px, ghost style), 16px gap-between, 16px margin-bottom.
- **ARIA:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to a unique ID (generated with `useId()`, not hardcoded).
- **Focus trap:** Active when open. Escape key closes. Focus returns to trigger on close.

### Topbar
64px fixed header. White background (dark: #111827). Border-bottom. 16px horizontal padding (24px on md+).

Right side: theme toggle (icon-button ghost), notification bell with red badge count, user name + role chip, logout ghost button. Left side: hamburger on mobile only.

## 6. Do's and Don'ts

### Do:
- **Do** use `font-family: ui-monospace` for every numeric value: grams, minutes, temperatures, OMR costs, spool weights, job IDs.
- **Do** display OMR currency to exactly 3 decimal places on every user-facing surface (table cells, cards, PDF invoices).
- **Do** use the 2px brand-blue focus ring on every interactive element. Never use `outline: none` without providing a visible alternative.
- **Do** use `role="dialog"` and `aria-modal="true"` on all dialog panels, with `aria-labelledby` pointing to a `useId()`-generated ID.
- **Do** wrap all data tables in an `overflow-x-auto` container so they scroll horizontally on mobile rather than breaking layout.
- **Do** use background tint (not side-stripe border) to indicate the active navigation item.
- **Do** use semantic badge colors: green for success/in-stock, amber for low/queued, red for error/out-of-stock. Never use raw text color alone to convey state.
- **Do** transition colors only (`transition-colors`), not layout properties. Keep transitions to 150-200ms ease-out.
- **Do** design light mode first at full fidelity; dark mode must match, not merely invert.

### Don't:
- **Don't** use `border-left` greater than 1px as a colored accent stripe on any card, list item, alert, or callout. Rewrite with a background tint or full border.
- **Don't** use `background-clip: text` with a gradient. All text is a single solid color.
- **Don't** use glassmorphism (`backdrop-filter: blur`) decoratively. It is not in this system.
- **Don't** build a hero-metric template: big number, small label underneath, gradient accent. This is the shadcn SaaS starter cliche this system explicitly rejects.
- **Don't** build identical card grids: same-sized cards with an icon, heading, and text body, repeated. If you have a list, use a table.
- **Don't** add entrance animations, counter animations, or loading choreography to data. Data appears; it does not perform.
- **Don't** use dark neon, cyberpunk, or any aesthetic that reads as "3D printing brand". This is a business operations tool.
- **Don't** use enterprise navy (#0a1f5e family) or gold as accent colors.
- **Don't** add a second accent color. The one-voice rule is absolute: brand blue is the only accent.
- **Don't** nest cards inside cards. Group content within a card using border-top separators or headings, not a sub-card.
- **Don't** use a modal as the first thought for editing data. For single-field edits, prefer inline editing. For multi-field edits, prefer a slide-in panel or an edit section on the detail page.
- **Don't** suppress focus rings. Every keyboard-navigable element must have a visible 2px focus indicator.
