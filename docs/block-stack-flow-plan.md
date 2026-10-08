# Block Stack Flow — visualisation plan

Guided, presentable walk-through of FLD-69 inside the 3D viewer: from the stock-mix
policies on the zones, through a putaway that the hash gate filters, an allocation
that names a pallet nobody can reach, to the pick with pallet substitution
(SwapAllocation) and the completed pick. A forklift performs the physical moves; the
audience clicks the two decisions a real operator makes (where to put the pallet
away, which pallet to scan) and sees the system's answer each time.

Source of truth for every rule shown: `Task/FLD-69/block-stack.md` (HLD),
`block-stack-how-it-decides.md`, the two Hinglish Part 3 documents and, since
2026-10-08, `FLD-68 Block Stack - Change List.md` (Que 1/2/3/5 + the acceptance fix)
and the same-kind swap plan. Nothing invented; where the docs leave a choice open (e.g.
empty lane vs part-filled lane on putaway) the flow says so.

## 1. Storyline (12 steps, 5 stages)

| # | Stage | Step | What the audience sees | Interaction |
|---|---|---|---|---|
| 0 | Policies | Zones and policies | Zones BSD/BSE/BSF glow; panel lists each zone's policy and its hash keys (1 zone ↔ 1 policy) | — |
| 1 | Policies | What counts as the same stock | Each BSD lane glows in its class colour; table lane → pods → class → hash. BSD vs BSE contrast (B7 & B9 two classes vs one) | — |
| 2 | Putaway | A pallet arrives | Forklift appears at goods-in (front cross-aisle at the BS3 mouth) carrying 40 × 4471 Cola B7; panel shows its hash under each policy in play | — |
| 3 | Putaway | Rule → zone BSD, the stock-mix gate filters lanes | Lanes light green (OK: empty or same class) or red (dropped: other class / full); the engine's own choice is outlined — the first lane that passes in the zone's putaway order (lane number, as in the local test data), BSD01, which already holds the class | **Click a lane.** Wrong class → refusal styled on error 1942 with the reason; Next = engine's choice |
| 4 | Putaway | Reserve → move → confirm | Truck drives down BS3, squares up, lifts to the top of the stack, drives into the lane, sets the pallet ON TOP of the existing pallets, backs out, returns to the mouth | auto |
| 5 | Putaway | Putaway confirmed | Ledger: lane pods n→n+1, hash null→H1 (stamped) or unchanged; the upsert-trigger gate explained | — |
| 6 | Allocation | An order arrives | ORD-1001 · 40 × 4471 · rule R-12 (zone BSD, oldest first, pallet substitution on); all AVAILABLE 4471 pallets in BSD flash as candidates | — |
| 7 | Allocation | Engine names the bottom pallet (no depth model) | Oldest first lands on the first pallet put into the topped-up lane (BSD01-01), which turns amber; camera drops to the lane face so the audience sees the pallets standing on it; ledger AVAILABLE→ALLOCATED, job J-501 created with allowPodSubstitution | — |
| 8 | Picking | Start-pick | J-501 RESERVED; substitutable set table (zone BSD, same class and policy; the job's own lane first, then fewest pallets, then nearest; cap 10); truck drives out to BSD01 | auto |
| 9 | Picking | At the lane: pick what you can reach | The top pallet of the stack (the one just put away) glows green; BSD02's face amber (it belongs to ORD-1002); the bottom pallet amber | **Click a pallet.** Verdict in the backend's order: substitution off (2815) / outside the permitted set (2814: other zone, other class) / Case A / Case B / refused (2818: reserved holder, not enough stock) / order line (2817). Default = the top pallet → Case A, no relocation |
| 10 | Picking | Confirm — swap, then pick | Ledger of the swap (X, Y, job re-point, displaced order for Case B); truck relocates if needed, lifts the scanned pallet, backs out, drives to the mouth | auto (after Confirm) |
| 11 | Complete | Pick complete | Final ledger, lane states, T = A + L invariant; Restart | — |

Auto-play runs the whole thing hands-free (engine's lane at step 3, the Case A
pallet at step 9) with a read pause per step; Pause stops it anywhere; the user can
still click during an interaction step.

## 2. Fixture (the FLD-69 worked example, made live)

The story lanes come first in the zone's putaway order (lane number, as in the local test
data where putawayPreference = lane number), so the engine's own putaway choice is truthful:

- BSD01: two B7 pallets (class H1) — the putaway tops this stack up (3 pods), allocation
  names its bottom pallet, and the pick takes the top one (Case A, same lane).
- BSD02: five B7 pallets; the face (P5) is pre-booked to ORD-1002 / J-502 (job not
  started) — the Case B set-up.
- BSD03: 4 × B9 (H2) — another class: refused on putaway, never in the pick set.
- BSD04: one B7+B8 pallet (its own class H3).
- BSD05: three B7 pallets, face booked to ORD-1017 whose job is RESERVED (never moved).
- BSD06: three B7 pallets, 12-case face (part pallet).
- The other lanes keep the seeded fill (Cola only in the story zones), so the candidate
  table has real variety: empty lanes, same-class lanes, other classes, full lanes.

## 3. Architecture

| Piece | File | Role |
|---|---|---|
| Flow engine + copy | `src/lib/blockStackFlow.ts` | Step definitions, narrative text, putaway candidate logic, allocation, substitutable set, swap verdict (Q1–Q5, Case A/B), ledger; drives the host; publishes `flowState` (svelte store) |
| Panel | `src/lib/FlowPanel.svelte` | Stage rail, step text, facts, tables, ledger, notices, prompt, controls (Restart · Play/Pause · speed · Next). Reads `flowState`, emits events |
| Forklift | `src/lib/forklift.ts` | Procedural counterbalance truck (body, mast with extending inner section, carriage, forks); `ForkliftDriver` tween queue: move / turn / lift / wait / call in data mm |
| Scene glue | `src/lib/WarehouseScene.svelte` | Implements the host: glow boxes, camera focus + truck chase (orbit rig carried along, user can still orbit), truck placement/route, carried pallet, stock rebuild, click routing during interaction steps; header event `flow` |
| Stock | `src/data/blockStack.ts`, `src/lib/blockStackBuilder.ts` | Allocation model on pallets (order, job, qty, job status); ALLOCATED tags; hide-instance for the pallet on the forks; shared label texture |

Camera: every step has a framing (zone overview, lane face, chase behind the truck).
The chase adds the truck's displacement to the orbit rig each frame, so dragging to
look around never fights the follow.

## 4. Rules encoded (and where they come from)

- Putaway gate: untracked → accept; empty (hash NULL) → accept; same hash → accept;
  different hash → dropped; `currentPodCount + 1 ≤ maximumPods` (how-it-decides Q1,
  reservation_zone_rules). Engine's choice = first suitable in putawayPreference order
  (lane number, per the fixture SQL); the empty lane may win over the part-filled one —
  purity is guaranteed, density is not (Q3).
- Write gate: upsert trigger recomputes classes: 1 → stamp, 2 → refuse 1942, 0 → clear.
- Allocation: converts AVAILABLE→ALLOCATED, names a pallet, no depth model; job carries
  podSubstitution from the rule (HLD §6.7).
- Start-pick set: same zone, same hash, same policy, pickable, ORDER BY currentPodCount
  ASC, limit 10 (HLD §6.5.4).
- Confirm: Q1 scope (zone) → Q2 flag → Q3 hash → Q4 order-line attributes → Q5 quantity;
  Case A (enough AVAILABLE on Y) or Case B (displace other orders' AVAILABLE-status jobs
  onto X, each must accept X, no cascade); denials before any write (HLD §6.4, §6.6).
- Pick: ALLOCATED → PICKED; lane count down; empty lane → hash cleared.

## 5. Test plan

1. `svelte-check` and `vite build` clean.
2. Drive the flow headless through `window.__flow` (next / choose / step-time) and
   assert after each step: glows present, truck position, stock mutations, ledger text.
3. Screens for each of the 12 steps (panel + scene), including a Case B run and the
   three denials (deep pallet, hash mismatch, wrong lane on putaway).
4. Auto-play end to end at 4× with no user input.
5. Restart returns the fixture to its initial state; existing features (hover, pod
   label, walk, tour, search, overlays) unaffected.

## 6. Status — implemented and tested (2026-09-21)

Verified in the browser, driving the flow through the dev hooks (`window.__flow`) with the
truck animated by `__flow.step(dt)`:

- Policies: zone glows + per-lane class table with hashes (step 1, 2).
- Putaway: truck at goods-in with GI-2041; candidate table (2 empty lanes OK, 4 same-class OK,
  4 dropped); BSD05 refused with the 1942 wording, BSE01 refused as outside the rule's zones;
  engine's choice BSD01 → truck drove, set the pallet at position 1, hash stamped, returned.
- Allocation: 50 eligible pallets flashed; P2 booked live (ledger AVAILABLE → ALLOCATED, J-501).
- Picking: J-501 RESERVED; set = BSD01 (1) · BSD04 (2) · BSD03 (5) · BSD09 (13), BSD05 excluded;
  denials verified for a deep pallet, a hash mismatch (BSD05-04) and another zone (BSF01-14);
  Case A (BSD04-02) and Case B (BSD03-05 → ORD-1002 displaced onto P2) both committed with the
  expected ledger; re-scanning before confirm switches the verdict; the truck lifted from level 2
  and from level 5 (inner mast extends) and drove the pallet out; lane counts and hashes updated.
- Complete: lane table + full ledger (11 lines); Restart resets the fixture (BSD01 empty, P2 free,
  4,040 pallets); hands-free auto-play reached Complete on its own.
- After closing: hover tooltips, walk mode (BS3) and Escape all work; no console errors;
  `svelte-check` 0 errors, `vite build` passes.

## 7. Demo extras (2026-09-23)

- **Scenario strip** on the scan step: Case A, Case B, hash mismatch, deep pallet, reserved
  elsewhere, pallet-directed job, part pallet. Each button scans the pallet that produces that
  outcome (the pallet-directed one flips the job's rule to R-40 for the scan, then restores it).
  Two fixture lanes make every scenario reachable: BSD05 (three B7 pallets, face booked to
  ORD-1017 whose job is RESERVED) and BSD06 (three B7 pallets, 12-case face).
- **Picker's view**: walk-mode camera beside the truck at 1.7 m, facing the lane; the forklift
  keeps working in either camera; Overview returns to the chase camera.
- **Pause/Resume** for the forklift (main button while it moves, or Space); the hands-free toggle
  is labelled Auto-play.

## Virtual tour through the block stack (2026-10-08)

The rail orders the aisles across the floor — BS1, BS2, BS3, then A … V — so ←/→, the
picker and the tour agree. The tour's fly-in lands in BS1, the serpentine walks BS1 →
BS2 → BS3 with three showcase stops per drive aisle — each placed where the three lanes
in line hold stock on both sides of the aisle, the tallest such columns near each third
of the aisle — the
last drive aisle U-turns straight into racking aisle A with the eye height eased from
~2 m to racking height on the way, the racking is walked A → V as before, and the lap
returns around the outside to BS1. Every neighbour transition is a U-turn, whatever
the gap (the drive aisles are 12.6 m apart); only the lap restart walks round the
outside. At a block-stack stop the camera sweeps the faced lane and its neighbours
either side level by level (the lane that really faces the aisle, never one seen
through an empty lane): the three columns are outlined, the level in view is boxed
across them, and a Block Stack Level panel at the foot of the view lists the pallets
on it — the drive-aisle counterpart of the racking's Rack Level panel. Hover stays
off while the tour runs, as in the racking. The rail remembers the eye height the user chose
and restores it per aisle (capped at half the aisle height).

## Copy aligned with the FLD-68 Part 3 backend (2026-10-08)

The panel text was rewritten for presentation (plain words, pallet/lane, one idea per
sentence) and checked against the backend as built on `ft-fld-68` (2026-10-07):

- Putaway: the engine's choice is the first lane that passes, in the zone's putaway order;
  it has no preference for a part-filled lane (how-it-decides Q3). The refusal quotes the
  magma-pods 1942 wording ("Segment may only hold stock matching on [...]").
- Allocation: oldest first (the local rules sort FIFO); the rule's flag reaches the job as
  `allowPodSubstitution`.
- Start-pick: the job's own lane first, then fewest pallets, then nearest, capped by the
  policy (Que 5); scope `segment` / `zone` / `warehouse` (Que 2).
- Scan verdicts carry the real codes: 2815 substitution off, 2814 outside the permitted
  set (other zone or other class), 2817 order line, 2818 displacement (reserved holder,
  not enough stock); the class is re-fingerprinted at confirm (2816).
- Confirm: release and claim are journalled as an exchange (operation types 40 / 39,
  Que 3); the re-point also writes the job format (Que 1).
- Complete: notes the same-kind rule for HELD / RECEIPTED jobs and the breakable-pallet
  rule for whole-pallet jobs.
- Picker's view now looks at the spot ahead of the forks, so the truck and its lane share
  the frame.
