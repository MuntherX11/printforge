# TODOS

Deferred work with enough context to pick up later. Add items from reviews; remove them when shipped.

## Slice on demand from the order plan dialog

- **What:** In `orders/[id]/PlanProductionDialog.tsx` (and `NewJobDialog`), when the planner cannot cover the ordered units with existing plates (e.g. 26 units, only x1 and x12 files), offer a "Slice x14 on <printer>" button that queues a `SliceRun` for the part and refreshes the plan when it finishes.
- **Why:** Removes the last manual step between an odd-quantity order and a job while the owner is away. The product page already offers "Slice a plate"; this puts the same action where the shortfall is discovered.
- **Pros:** Zero new backend concepts: reuses `POST /products/:id/components/:cid/slice`, the run status row and the planner's existing `noFile` warning path (`catalog-core/job-plate-suggestion.ts`).
- **Cons:** Second UI entry point to keep in step with the product page dialog; the plan dialog must wait for an async run (poll or websocket) before it can re-plan.
- **Context:** Added during the v2.18.0 in-app slicing engineering review (2026-10-11). Design doc `~/.gstack/projects/MuntherX11-printforge/MuntherX-release-v2.17.4-design-20261011-203000.md`; plan `MuntherX-release-v2.17.4-eng-plan-20261011.md`. The planner's shortfall computation lives in `catalog-core/plate-planner.ts` and `job-plate-suggestion.ts`; the dialog's plate editor is `components/production/PlatePlanEditor.tsx`.
- **Depends on / blocked by:** v2.18.0 slicing live and used on the product page first.
