# Warehouse-Viewer-BlockStack

Copy of `Warehouse-Viewer` (the Sundance 3D racking demo) extended with FloWMS
**block-stack floor storage** (FLD-69): zones of single-ended lanes on the open slab
beside the racking, shrink-wrapped pallets stacked in them, white floor markings,
walkable drive aisles, a guided walk-through of the FLD-69 flow (policies → putaway →
allocation → picking with pallet substitution, with a forklift), and **DB mode**, which
draws the real block stack from a local FloWMS estate instead of the seeded demo.

## Run it

Requirements: Node.js 18 or newer, and a shell. Nothing global to install.

```bash
npm install
npm run dev      # http://localhost:5178
```

`npm run dev` is the only way to run it: DB mode reaches the FloWMS services through the
dev server's proxy, so a static `npm run build` output shows the demo data only.

## DB mode

On load the viewer reads the block stack from the local FloWMS services and shows it;
the **DB mode** button in the header switches to the seeded demo and back. It is
read-only: only GET requests are made, and the proxy refuses anything else.

What the machine running it needs:

1. **The FloWMS backend running locally** (`Launch\launch.ps1`), reachable on
   localhost at the ports in `vite.config.ts`: locations 8002, pods 8003, products 8005,
   jobs 8018. Different ports or host → edit the `SERVICES` map there.
2. **A segment definition coded `SAX1-SD-BLOCK-STACK`** in that location_service, with
   its areas, lanes, zones and stock-mix policies. Another code → edit
   `DB_DEFINITION_CODE` in `src/data/dbBlockStack.ts`.
3. **An access token and its `atFingerprint` cookie** from that estate (log in through
   the FloWMS API, e.g. in Postman). Paste both into the dialog the viewer opens on
   first load; they stay in the browser tab's session storage and are never written to
   disk. To skip the dialog on this machine, put
   `{"token": "…", "fingerprint": "…"}` in `flowms-viewer-auth.json` in the OS temp folder
   (`%TEMP%` on Windows) or in the file `FLOWMS_VIEWER_AUTH` points at; the dev server
   then signs the requests itself.
4. **Internet access for the pallet labels** (they are rendered by api.labelary.com).
   Without it everything still works, the labels just stay blank.

Without the services the viewer falls back to the demo block stack and shows the error
in a toast. The walk-through button is available in demo mode only.

Everything about DB mode — endpoints called, how the floor plan is synthesised (the
DB holds no coordinates), tags, tooltips, the pick trail — is in `docs/db-mode.md`;
the walk-through is described in `docs/block-stack-flow-plan.md`.

## Where things are

- `src/data/blockStack.ts` — demo zones, lanes, drive aisles and the seeded pallets.
- `src/data/dbApi.ts`, `src/data/dbBlockStack.ts` — DB mode: the read-only client and
  the loader/layout for the real definition, zones, lanes, pallets and pick trail.
- `src/lib/blockStackBuilder.ts` — floor markings/stencils and the instanced pallets,
  loads, labels and status tags; `src/lib/blockStackTextures.ts` — the textures.
- `src/lib/blockStackFlow.ts`, `src/lib/FlowPanel.svelte`, `src/lib/forklift.ts` — the
  guided walk-through.
- `src/lib/WarehouseScene.svelte`, `src/App.svelte` — the scene and the header.
- `vite.config.ts` — port 5178 and the service proxy.

Sharing the folder: zip it **without** `node_modules` and `dist` (the recipient runs
`npm install`); the folder contains no credentials.
