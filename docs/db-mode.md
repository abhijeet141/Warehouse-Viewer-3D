# DB mode — the real block stack from location_service

`DB mode` is the startup mode: a reload reads the database first (stored credentials,
else the proxy's own; a rejection opens the connect dialog over the demo) and builds the
scene once with the result, while the page loader is still up. The header button
(emerald) toggles back to the seeded demo. DB mode swaps the demo block stack for the
block stack that actually exists in the local FloWMS databases: segment definition
`SAX1-SD-BLOCK-STACK`, its areas and lanes, the zone each lane belongs to, the
stock-mix policy that zone resolves to, the lanes' live `currentStockMixHash` /
`currentPodCount`, and every pallet (pod + pod lines) standing in a lane. The
Sundance racking stays as the backdrop; only the block stack changes.

**Read-only by construction.** The viewer issues GET requests only, and the dev
proxy refuses anything else (`bypass` returns a 404 for non-GET). Nothing is ever
inserted or updated.

## How the data gets in

```
browser ──/api/locations/…──▶ vite dev proxy (5178) ──▶ magma-locations :8002
        ──/api/pods/…───────▶                        ──▶ magma-pods      :8003
        ──/api/products/…───▶                        ──▶ magma-products  :8005
```

- The services come from `Launch\launch.ps1`; pyro routes live under
  `/api/<service>/v0/<resource>` and accept `field=v`, `field__in=a,b`,
  `recordsPerPage`, `page`.
- Auth is the FloWMS pair: `Authorization: Bearer <access token>` plus the
  `atFingerprint` cookie. The browser sends the fingerprint as an `X-At-Fingerprint`
  header and the proxy turns it into the cookie, so no cookie is ever written on the
  viewer origin (localhost cookies ignore the port and would clobber the FloWMS web
  app's own `atFingerprint`).
- Credentials are pasted into the connect dialog and kept in this tab's
  `sessionStorage` only. Alternatively a developer can drop
  `%TEMP%\flowms-viewer-auth.json` (`{"token": "…", "fingerprint": "…"}`, or the path
  in `FLOWMS_VIEWER_AUTH`) and the dev server signs requests itself — the dialog is
  then never shown. The file is read per request and is not part of the project.
- Production builds have no proxy: DB mode reports that it needs `npm run dev`.

Calls made, in order (`src/data/dbBlockStack.ts`):

| # | Endpoint | Why |
|---|---|---|
| 1 | `segment-definitions?code=SAX1-SD-BLOCK-STACK` | definition id |
| 2 | `definition-segment-type-matrix?segmentDefinition_id=` · `segment-types?id__in=` | area type (no parent) and lane type |
| 3 | `segments?definitionSegmentType_id__in=` | all areas + lanes, each with `segmentStatus`, `segmentMaxPodTypes`, `zones[]` (zoneAccount id, prefs), `trackStockMix`, `stockMixPolicy_id`, `currentStockMixHash`, `currentPodCount` |
| 4 | `zones?id__in=` · `zone-account-stock-mix-matrix?zoneAccountMatrix_id__in=` · `stock-mix-policies?id__in=` · `stock-mix-policy-keys?stockMixPolicy_id__in=` | zone names, the policy per zone (a lane's own `stockMixPolicy_id` overrides), its hash keys |
| 5 | `pod-and-lines?segment_id__in=` (40 lanes per call) | pallets with lines, batches, available/allocated quantities |
| 6 | `products?id__in=` · `units-of-measures?id__in=` · `pod-types?id__in=` | SKUs and titles, UOM codes, pod type names |

## Layout — synthesised, because the DB has none

Every block-stack segment in the local DB has coordinate/dimension 0, so the floor
plan is generated:

- Zones (areas) are sorted by `zonePreference` and dealt into eight rows: the corner
  slab either side of drive aisle BS1, then both sides of BS2, BS3 and BS4. BS1 is the
  demo's; BS2–BS4 are packed for the lane depth actually drawn, so each bank is a row,
  a 5.6 m drive aisle and a second row standing back to back with the next bank (the
  demo's geometry at 3.5 m lanes; at 1.6 m the whole bulk floor spans Y −4.5 m to
  −30.9 m instead of −42.3 m). Walk mode and the tour pick the aisles up as before.
  A zone goes into the first row with room for `lanes × 1.4 m`; zones in one row sit
  1.5 m apart. Lanes follow `putawayPreference` order (= lane number here).
- Lane shape follows `maximumPods` for the lane's current pod type (else the smallest
  declared): stack as high as allowed (max 6) first, then deep. `maximumPods = 5` →
  one column, five high, a 1.4 × 1.6 m lane. A 15-pod lane would be 3 deep × 5 high.
- Pallets stack in arrival order (`pods.dateCreated`, then uuid — the pods service
  keeps no putaway timestamp); the last one in is the top, reachable pallet.

## What is shown

- Load colour: hue per product (stable by product id), lightness per batch value — or
  per UOM in a zone whose policy keys on `unit-of-measure-id`. All DB pallets are drawn
  full height (quantities are in mixed UOMs and say nothing about height). Mixed-product
  pallets get their own hue.
- Lane tooltip adds: segment id + status, zone name/code, policy hash keys (and whether
  the lane overrides the zone's policy), the lane hash (first 16 hex), `currentPodCount`
  and pod type, zone/putaway/pick preferences, and a warning when the pallets found in
  the lane fall into more than one class under that policy.
- Face tags: every quantity type the pallet carries, summed per UOM from its pod line
  quantities — `AVAILABLE 100 UNIT`, `ALLOCATED 40 UNIT`, `HELD …`. A partly allocated
  pallet shows ALLOCATED on top and AVAILABLE beneath it; the FloWMS label sits below.
  One instanced mesh per distinct tag text (a few dozen for 1,285 pallets). The demo
  data keeps its single amber ALLOCATED tag.
- Pallet tooltip: pod uuid (last 12), position in the stack, the same quantity chips
  (status chip reads PART ALLOCATED when both are present), product, pod type, every
  pod line (`SKU × qty UOM · batch …`), allocations when present.
- Summary card (top-left, toggle with the ⓘ button): definition, warehouse, types,
  zones / lanes / lanes in use, pallets / pod lines, the policy table (code, scope,
  candidates, keys, zones), zones without stock, and two integrity checks:
  lanes whose `currentPodCount` differs from the pallets found, and lanes over capacity.
- The `Block-stack flow` walk-through is disabled in DB mode: it is scripted against
  the demo fixture lanes (BSA03–BSA10). Switch DB mode off to run it.
- `Refresh` (↻) re-reads everything; switching DB mode off and on again reuses the last
  read.

## The pick trail

A block-stack pallet leaves its lane when the pick is **confirmed**, not when it is
allocated: confirm-pick moves the pod into the picker's bucket (segment NULL,
`inTransit`), turns its stock PICKED and completes the job; drop-pick then moves the pod
to the job's `toSegment_id` and deletes the job. DB mode follows the pod:

- **In the lane, job raised**: the pallet keeps its quantity tags and gets a
  `PICKING → GO1` tag while the job is AVAILABLE / RESERVED / IN-TRANSIT; the tooltip
  names the job, its status, destination and order. Read from the jobs service
  (`pick-jobs?fromSegment_id__in=<lanes>` + `jobs?id__in=` for the status; proxy route
  `/api/jobs/` → :8018).
- **Picked, in a bucket**: confirm-pick normally splits the picked quantity into a NEW
  pod (in transit, in the picker's bucket) and the source pallet stays in its lane with
  less stock; only when the whole pallet moves does the source pod itself go. The job
  row does not name the new pod, but its PICKED quantity rows carry the job id, so the
  loader reads `pod-line-quantities?quantityType_id=<Picked>&job_id__in=<jobs>` →
  `pod-lines?uuid__in=` → `pod-and-lines?uuid__in=` (plus any source pod that vanished
  from its lane). Those pods stand washed out and tagged `IN BUCKET` on the pad of the
  location the job drops to; the tooltip names the source lane, job, status and order.
- **Dropped**: it stands on the pick location's pad with its PICKED / PACKED tags.
- **Pick locations** are the segments of this warehouse whose use type packs or
  despatches and never receives or puts away (SAX1: GO1, PACK1, PACK2), plus any
  `toSegment_id` a live job names. Everything physically on them is drawn — including
  older pallets — newest first. Pads stand left of the banks (X −14.5 m), rows of seven
  1.4 × 1.6 m slots, one pallet per slot, the location name stencilled in front; they
  appear only when the location holds something or a job targets it.
- The summary card's **Pick trail** line counts jobs by status, pallets in buckets and
  pallets per pick location.

## Verified 2026-09-23

Against launch.ps1 with the FLD-68/69 test stock: 16 zones · 320 lanes · 68 pallets
in 24 lanes · 80 pod lines; policies PRODUCT (A–E), BATCH (F–J), UOM (K–O), MIXED (P);
empty zones H, I, J, L, M, N, O — matching `Task/FLD-69/Test Block Stack/stock-summary.md`.
BSA01 tooltip: 5/5 pods, hash `917351ba8b6484a5…`, pallet A03 = 3 lines × 40 UNIT.
Proxy: 200 with credentials, 401 without, 404 for POST.

## Verified 2026-09-24

After the bulk floor was packed for the lane depth: rows BS2-south/BS3-north and
BS3-south/BS4-north now meet with a 0 mm seam, drive aisles stay 5.6 m, and the corner
rows keep BS1 between them. Loaded the refilled dataset: 16 zones · 320 lanes ·
1,285 pallets in 319 lanes · 1,790 pod lines; no console errors.
