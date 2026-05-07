# PrintForge — Product Context

## Register

product

## Users

- **Primary**: Munther — sole operator and owner of a B2C 3D print farm (Oman, OMR currency). Uses the app throughout the day: quoting jobs, monitoring printers, managing filament stock, tracking orders.
- **Staff roles**: ADMIN, OPERATOR, ACCOUNTING, VIEWER — each sees a role-scoped sidebar. Staff are not always technical; the UI must not assume slicer knowledge.
- **Customers**: indirect beneficiaries of the ordering and quoting surfaces (invoice PDFs, QR spool tracking, customer portal). Customers do not use the staff dashboard.

## Product Purpose

PrintForge is a full-stack 3D print farm management system for small business operators. It tracks production jobs end-to-end, manages filament inventory by spool, handles customer orders and invoicing, runs material and time cost calculations, and provides live printer monitoring via Moonraker/Klipper WebSocket. The job is to remove operational friction: quoting faster, knowing stock without counting, seeing job status without checking the printer physically.

## Brand Personality

Focused. Fast. Reliable.

The closest reference is Linear (light-mode variant): clean surfaces, high information density, purposeful use of a single accent color, no decoration that doesn't carry data. The feeling should be a tool that an operator trusts instinctively — not impressive to look at, impressive to use.

## Anti-references

- Generic SaaS cream (Notion-style beige dashboards)
- Dark neon or cyberpunk 3D-printing aesthetic
- Enterprise navy and gold
- Glassmorphism
- Big-number hero metric template (shadcn SaaS starter)
- Over-animated dashboards: no entrance animations, no counter animations, no loading choreography on data tables

## Design Principles

1. **Information before aesthetics.** Every number must be visible at a glance: production status, temperatures, filament stock, costs. If a design choice makes a number harder to read, reverse it.
2. **Light mode primary.** The app defaults to light mode. Dark mode is a fully supported toggle, not the assumed environment. Design for light first; dark must match the same fidelity.
3. **Mobile works in the workshop.** The operator may check a job status with one hand, glancing at a phone near a running printer. Touch targets must be large enough, contrast must hold outdoors.
4. **OMR precision.** Currency is always displayed to 3 decimal places in OMR. No rounding in any user-facing output.
5. **Role-scoped, never ambiguous.** Each role sees exactly the surfaces they need. Missing permissions should be silent (hidden nav items), not locked-door error pages.

## Accessibility

WCAG AA minimum. Specific considerations: all interactive elements must have visible focus rings, color must not be the sole indicator of state (use labels or icons alongside), and font sizes must hold at 100% zoom without overflow on common mobile viewports.
