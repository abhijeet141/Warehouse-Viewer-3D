# Warehouse-Viewer-BlockStack-Demo

Copy of `Warehouse-Viewer` (the Sundance 3D racking demo) extended with FloWMS
**block-stack floor storage** (FLD-69): 12 zones of single-ended lanes on the open slab
beside the racking, shrink-wrapped pallets stacked five or six high, white floor
markings, walkable drive aisles, a virtual tour that starts in the block stack and
carries on through the racking, and a guided walk-through of the FLD-69 flow —
policies → putaway → allocation → picking with pallet substitution — with a forklift.

Everything is seeded demo data. Nothing to connect to: no backend, no token.

## Run it

Requirements: Node.js 18 or newer.

```bash
npm install
npm run dev      # http://localhost:5179
```

The pallet labels are rendered by api.labelary.com; without internet access everything
else works and the labels stay blank.

## Where things are

- `src/data/blockStack.ts` — zones, lanes, drive aisles and the seeded pallets
  (stock classes, batches, allocations) that stand in them.
- `src/lib/blockStackBuilder.ts` — floor markings/stencils and the instanced pallets,
  loads, labels and ALLOCATED tags; `src/lib/blockStackTextures.ts` — the textures.
- `src/lib/blockStackFlow.ts`, `src/lib/FlowPanel.svelte`, `src/lib/forklift.ts` — the
  guided walk-through (plan and status in `docs/block-stack-flow-plan.md`).
- `src/lib/WarehouseScene.svelte`, `src/App.svelte` — the scene and the header.

Sharing the folder: zip it without `node_modules` and `dist`; the recipient runs
`npm install`.
