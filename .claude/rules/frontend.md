# Frontend rules
- The store (apps/web/src/store.ts) is the source of truth; the scene renders state. Aircraft, gates and the storm are functions of the event-time cursor (packages/domain/src/sim.ts); no business logic in animation callbacks.
- Motion communicates state, time, causality or structure. Honor prefers-reduced-motion and the P (pause) key: every fact must be reachable with motion off, and the list view (ui/ListView.tsx) must carry it.
- Keep deep links (url.ts) round-tripping: a state worth sharing is in the query string and restored on load.
- WebGL is optional: the app must complete every task with webgl === "unsupported" or after context loss. Dynamic Points/InstancedMesh need frustumCulled={false}.
- After editing: `cd apps/web && npx tsc --noEmit -p .`, then the affected Playwright spec.
