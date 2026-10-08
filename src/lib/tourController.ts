import * as THREE from 'three';
import type { RailControls } from './railControls';

// Virtual-tour autopilot. Rather than baking a separate camera path, this
// scripts the exact parameters a human drives by hand — the active aisle, the
// distance along its centreline, and the look yaw — and lets RailControls
// render them (so the camera keeps the rail's rack-collision guarantee). The
// only off-rail move is the turn between aisles: a wide curved U-turn the camera
// walks along in the CONNECT state, rounding the rack ends into the next aisle.
//
// Serpentine route: aisles are visited in sorted order, entered from alternating
// ends, so the camera zig-zags out of one aisle mouth and into the next. After the
// last aisle the scan LOOPS — it returns around the OUTSIDE of the rack block, on
// the open floor, back to the first aisle (A) and runs the whole sequence again,
// instead of reflecting (ping-pong) back through every aisle. Adjacent transitions
// are wide U-turns; the wrap (last -> A) is that perimeter walk. Runs until stop().

export interface TourOptions {
  speed?: number;           // cruise (top) travel speed along an aisle (world units / s)
  accel?: number;           // walk acceleration/deceleration (world units / s^2)
  stopsPerAisle?: number;   // evenly-spaced showcase pauses per aisle
  panAngle?: number;        // peak yaw swing at a showcase stop (radians); ~pi/2 faces the rack
  pitchAngle?: number;      // peak vertical tilt at a stop (radians); + looks up, - looks down
  turnDuration?: number;    // seconds to ease between look positions
  upHold?: number;          // seconds to hold while tilted up to the high levels
  downHold?: number;        // seconds to hold while tilted down to the low levels
  centerWait?: number;      // seconds to pause facing forward between the two looks
  liftPerUnit?: number;     // vertical arc per unit of horizontal hop distance (loop-restart hop)
  maxLift?: number;         // cap on the connector's vertical arc (world units)
}

type State = 'travel' | 'dwell' | 'connect';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Quintic smoothstep: zero velocity AND zero acceleration at both ends, so eased
// moves start and stop without the faint "kick" cubic easing leaves. Used for
// head turns and the aisle-to-aisle corner so rotations feel human, not robotic.
const smootherstep = (t: number) => {
  t = clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

const ARRIVE_EPS = 2; // snap onto a travel target within this distance

// Aisle-to-aisle connector (the U-turn around the rack ends). The camera keeps
// walking past the aisle mouth, follows a wide curved path through the cross
// aisle, and comes back in facing the next aisle — no sharp pivots. Tuned in
// world units (mm).
const CONN_STEP_PAST = 3200;       // min handle length ≈ a few steps past the aisle end before turning
const CONN_HANDLE_FRAC = 0.62;     // handle length as a fraction of the cross-aisle distance
const CONN_HANDLE_MAX = 9000;      // cap so the loop-restart wrap doesn't bulge absurdly
const CONN_WRAP_FAR = 60000;       // only a gap this wide is walked round the outside instead of U-turned

interface Leg {
  index: number;        // aisle index in rail.aisles
  enterFromEnd: boolean; // false = enter at start (dist 0), true = enter at end (dist length)
}

export class TourController {
  active = false;
  // Paused but still "active": autopilot is handed back to the rail so the user
  // can roam and inspect stock by hand, while the tour chrome stays up. resume()
  // re-seeds the route from wherever the camera ends up. Distinct from stop(),
  // which tears the tour down entirely.
  paused = false;
  // True while the camera is turned toward a rack at a showcase stop, so the
  // scene can auto-highlight the stock the camera is facing (no cursor needed).
  showcasing = false;
  // Fires when the tour stops itself (e.g. the user grabbed the controls), so
  // the UI toggle can update.
  onStop: (() => void) | null = null;
  // Rail aisle indices the tour visits, in order (null = every aisle). The scene
  // puts the block-stack drive aisles first, nearest the racking last, so the final
  // one U-turns straight into racking aisle A and the lap continues through the racks.
  route: number[] | null = null;
  private routeIdx: number[] = [];

  private opts: Required<TourOptions>;
  // Serpentine as a reflecting (ping-pong) scan over the sorted aisles: at the
  // last aisle it bounces back into the previous one rather than wrapping to the
  // first, so every transition stays an adjacent U-turn — no long jump.
  private aisleCount = 0;
  private startIdx = 0;
  private firstFromEnd = false; // in-aisle walk direction of the very first leg
  private seqPos = 0;           // monotonic visit counter; parity drives the U-turn end
  private curLeg: Leg = { index: 0, enterFromEnd: false };
  private state: State = 'travel';
  // Captured at pause(). If the user never actually walks (same aisle, same
  // distance) the whole state machine is still intact — update() just stops
  // running while paused — so resume() continues it exactly, mid head-turn /
  // rack inspection and all. Only once they've moved does resume() re-seed a
  // fresh leg from the new spot (pausedSign keeps the prior heading when the
  // camera's facing is too perpendicular to disambiguate).
  private pausedAisle = -1;
  private pausedDist = 0;
  private pausedSign = 0;

  // Active leg.
  private exitDist = 0;
  private travelSign = 1; // +1 travelling start->end, -1 end->start
  private baseYaw = 0;
  private dist = 0;
  private vel = 0;        // current walking speed along the aisle (world units / s)
  private stops: number[] = []; // dwell distances, ordered along travel direction
  private stopPos = 0;

  // Showcase dwell state machine: turn to a rack, inspect its shelves level by
  // level (stepping pitch through each), turn back, pause, then the other side.
  private dwellPhase: 'turnIn' | 'inspect' | 'turnOut' | 'wait' = 'turnIn';
  private dwellSide = 1;        // +1 = left rack first, -1 = right
  private dwellLeftDone = false;
  private phaseT = 0;           // seconds elapsed in the current phase
  // Each shelf of the faced bay + the pitch elevation to look at it (ascending).
  private vplan: { pitch: number; level: string }[] = [];
  private vTop = 0;            // pitch to the top shelf
  private vBottom = 0;         // pitch to the bottom shelf
  private pitchFrom = 0;       // pitch at the start of turn-out
  private pitchCur = 0;        // current applied pitch
  // The shelf the showcase is currently inspecting; the scene highlights it.
  inspectLevel: string | null = null;

  // Supplied by the scene: every shelf of the bay the camera currently faces with
  // the pitch to look at it. The tour sweeps the pitch smoothly across them and
  // reports the nearest as inspectLevel, so the highlight follows shelf by shelf.
  planVertical: (() => { pitch: number; level: string }[] | null) | null = null;

  // Supplied by the scene: bay-centre distances along an aisle. Showcase stops
  // snap to the nearest one so the camera halts on a bay (faced rack centred).
  bayCenters: ((aisleIndex: number) => number[]) | null = null;

  // Connect state: a path the camera walks along (carrying its momentum) to round
  // the rack ends into the next aisle — a straight run to align with the next
  // aisle's end, then a U-turn curve (or a single arc for the loop-restart hop).
  private connCurve: THREE.Curve<THREE.Vector3> | null = null;
  private connLen = 1;  // arc length of the active connector
  private connU = 0;    // distance walked along it, normalised to [0,1]
  private connLift = 0; // vertical arc height (unused now the wrap stays grounded)
  private connFromY = 0; // eye height leaving the aisle …
  private connToY = 0;   // … and the next aisle's own eye height, eased to on the way
  private connSpeedMul = 1; // cruise multiplier for the active connector (>1 for the perimeter wrap)
  private scratch = new THREE.Vector3();
  private scratchTan = new THREE.Vector3();
  private scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(
    private rail: RailControls,
    private camera: THREE.PerspectiveCamera,
    options: TourOptions = {},
  ) {
    this.opts = {
      speed: options.speed ?? 2800,          // brisk but still natural walking pace
      accel: options.accel ?? 6000,          // ~0.5 s to reach cruise; eases each start/stop
      stopsPerAisle: options.stopsPerAisle ?? 5,
      panAngle: options.panAngle ?? Math.PI / 2, // ~90deg: look straight at the rack face
      pitchAngle: options.pitchAngle ?? 0.70,    // ~54deg up/down: inspect the full rack height
      turnDuration: options.turnDuration ?? 1.1, // a touch slower = more relaxed head turn
      upHold: options.upHold ?? 3.2,
      downHold: options.downHold ?? 3.2,
      centerWait: options.centerWait ?? 0.8,
      liftPerUnit: options.liftPerUnit ?? 0.2,
      maxLift: options.maxLift ?? 12000,
    };
  }

  start() {
    if (this.rail.aisles.length === 0) return;
    this.active = true;
    // Keep the last travel direction as the fallback heading. When the tour is
    // stopped and restarted mid-showcase the camera is turned ~90° to a rack, so
    // its along-aisle facing is ~0 and `facing >= 0` would pick a direction off
    // numerical noise — flipping the route the opposite way at random. Passing the
    // prior travelSign resolves that the same way resume() does. On a fresh launch
    // the camera faces straight down the aisle (facing ≈ 1, unambiguous), so this
    // fallback is never consulted and the start direction is unchanged.
    this.seedFromCamera(this.travelSign);
  }

  // Seed (or re-seed) the serpentine route from the camera's CURRENT position and
  // heading, then take the wheel. Used both to begin a tour and to resume one
  // after a free-look pause — in either case the scan picks up from wherever the
  // camera is standing rather than snapping to a fixed start.
  //
  // preferSign (+1/-1) is a fallback travel direction: when the camera is turned
  // nearly perpendicular to the aisle its forward dot is ~0 and can't tell which
  // way to walk, so we keep the supplied heading instead of letting noise pick.
  private seedFromCamera(preferSign = 0) {
    // Positions below index the ROUTE (rail indices in visiting order), not the
    // rail directly, so excluded aisles are simply never stepped onto.
    this.routeIdx = this.route && this.route.length > 0 ? this.route : this.rail.aisles.map((_, i) => i);
    this.aisleCount = this.routeIdx.length;
    // Start at the aisle the camera is parked in so the tour picks up from here; if
    // it's standing in an aisle the route skips, begin from the route's first aisle.
    const pos = this.routeIdx.indexOf(this.rail.index);
    this.startIdx = pos >= 0 ? pos : 0;
    // Begin in the direction the user is currently facing along this aisle, so the
    // tour continues their walk instead of spinning them around. leg 0's exit end
    // sets the serpentine; the alternation flows from there.
    const cur = this.rail.aisles[this.routeIdx[this.startIdx]];
    const forward = this.scratch.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const facing = forward.dot(cur.dir); // >0 faces the aisle's end, <0 its start
    const AMBIGUOUS = 0.2; // |dot| below this ≈ looking across the aisle, not along it
    const towardEnd = preferSign !== 0 && Math.abs(facing) < AMBIGUOUS
      ? preferSign > 0
      : facing >= 0;
    this.firstFromEnd = !towardEnd; // exit at the end we're heading toward
    this.paused = false;
    this.rail.autopilot = true;
    this.seqPos = 0;
    this.vel = 0;
    // Begin the first leg from the camera's exact position along the aisle, not
    // its start, so the tour picks up right where the user is standing.
    this.beginLeg(this.legAt(0), pos >= 0 ? this.rail.currentDist : undefined);
  }

  // The aisle + entry end visited at the given step of the looping scan. Aisles
  // are walked in order and, after the last, the scan WRAPS back to the first and
  // runs again. Adjacent steps are valid same-end U-turns (each leg exits the end
  // the next leg enters); the one big jump — last aisle back to the first — is the
  // perimeter return built in beginConnect.
  private legAt(pos: number): Leg {
    const n = this.aisleCount;
    const offset = (((this.startIdx + pos) % n) + n) % n;
    // The scan visits aisles in index order and the one big jump is always the
    // perimeter seam V(last)→A(first). The first time we reach A (offset 0) is
    // `posFirstA` steps in. Before that is the OPENING run from wherever the tour
    // started — keep the camera-determined serpentine direction. From A onward
    // every lap is anchored by aisle INDEX so A is ALWAYS entered from the FRONT
    // (offset 0 → enter at the start mouth) and the rest alternate from there —
    // which also keeps each adjacent transition a clean same-end U-turn.
    const posFirstA = (((n - this.startIdx) % n) + n) % n;
    const enterFromEnd = pos < posFirstA
      ? pos % 2 === 0 ? this.firstFromEnd : !this.firstFromEnd
      : offset % 2 === 1;
    return { index: this.routeIdx[offset], enterFromEnd };
  }

  // Pausing/stopping mid-connector (the off-rail U-turn between aisles): the curve
  // sweeps the camera through the cross aisle, where it can sit right beside the
  // NEXT aisle's centreline — so syncing the rail from that position snaps the
  // camera sideways into that aisle, facing the turn. Instead, settle back into the
  // aisle we were actually touring (curLeg): the rail still holds its clean
  // end-of-aisle pose, so place the camera there — in the aisle, facing down it —
  // and rewind the connector so a later resume re-runs the turn from that point
  // (the curve starts at this exact pose, so resume is seamless). No-op off-connect.
  private settleConnectIntoAisle() {
    if (this.state !== 'connect') return;
    this.connU = 0;
    this.rail.setAisle(this.curLeg.index, false);
    this.rail.setPose({ dist: this.exitDist, yaw: this.baseYaw, pitch: 0 });
    this.rail.update(0); // apply the pose to the camera now, before syncFromCamera reads it
  }

  // Pause: stay "active" (the UI keeps its tour chrome) but hand manual control
  // back to the rail at the current camera pose, so the user can walk forward,
  // ride up/down and look around to inspect stock without the tour being torn
  // down. The view holds its current frame until they move it. No-op unless the
  // tour is actively running.
  pause() {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.showcasing = false;
    this.inspectLevel = null;
    this.vel = 0;
    this.settleConnectIntoAisle(); // mid-turn: drop cleanly into the toured aisle, not the next one
    this.pausedAisle = this.curLeg.index; // remember the leg + spot so resume can
    this.pausedDist = this.rail.currentDist; // tell apart "looked around" vs "walked"
    this.pausedSign = this.travelSign;
    this.rail.syncFromCamera(); // adopt the frozen frame as the manual start pose
    this.rail.autopilot = false; // the rail drives from user input again
  }

  // Resume and take the wheel back. If the user only looked around (same aisle,
  // same distance) the frozen state machine is untouched, so just let it run
  // again — the tour picks up at the exact point it paused, mid head-turn or
  // mid rack-inspection. Only once they've actually walked do we re-seed a fresh
  // leg from the new position (keeping the prior heading when the camera's facing
  // can't disambiguate it).
  resume() {
    if (!this.active || !this.paused) return;
    const RESUME_MOVE_EPS = 50; // world units (mm); a real step dwarfs this
    const moved =
      this.rail.index !== this.pausedAisle ||
      Math.abs(this.rail.currentDist - this.pausedDist) > RESUME_MOVE_EPS;
    this.paused = false;
    this.rail.autopilot = true; // resume scripting the camera
    if (moved) this.seedFromCamera(this.pausedSign);
    // else: leave every field as it was — update() continues exactly where it left off
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.paused = false;
    this.showcasing = false;
    // Mid-turn between aisles, settle back into the aisle we were touring (facing
    // down it) rather than syncing from the off-rail curve, which could leave the
    // view snapped sideways into the next aisle. On an aisle already, syncFromCamera
    // hands control back exactly where the camera is and is looking.
    this.settleConnectIntoAisle();
    this.rail.syncFromCamera();
    this.rail.autopilot = false;
    this.onStop?.();
  }

  dispose() {
    this.stop();
  }

  update(dt: number) {
    if (!this.active || this.paused) return; // paused: hold the current frame
    switch (this.state) {
      case 'travel': this.updateTravel(dt); break;
      case 'dwell': this.updateDwell(dt); break;
      case 'connect': this.updateConnect(dt); break;
    }
  }

  // --- leg setup -----------------------------------------------------------

  // Yaw that faces along the aisle in the given travel direction. Mirrors the
  // convention in RailControls.setAisle (forward = -Z in the camera's frame).
  private facingYaw(dir: THREE.Vector3, towardEnd: boolean): number {
    return towardEnd
      ? Math.atan2(-dir.x, -dir.z) // face toward 'end'
      : Math.atan2(dir.x, dir.z);  // face toward 'start'
  }

  private beginLeg(leg: Leg, entryOverride?: number) {
    this.curLeg = leg;
    const a = this.rail.aisles[leg.index];
    const defaultEntry = leg.enterFromEnd ? a.length : 0;
    const entryDist =
      entryOverride === undefined ? defaultEntry : clamp(entryOverride, 0, a.length);
    this.exitDist = leg.enterFromEnd ? 0 : a.length;
    this.travelSign = leg.enterFromEnd ? -1 : 1; // not exit>=entry: that reads +1 when both are 0
    this.baseYaw = this.facingYaw(a.dir, !leg.enterFromEnd);
    this.dist = entryDist;
    // Velocity carries over from the connector so the walk into the aisle is
    // continuous; start() zeroes it for the very first leg (a standing start).

    // Evenly-spaced interior stops, then snapped onto the nearest bay centre so
    // the camera always halts on a bay (the faced rack ends up centred), never
    // straddling two bays. Ordered along the travel direction.
    const n = this.opts.stopsPerAisle;
    const raw: number[] = [];
    for (let k = 0; k < n; k++) raw.push(((k + 0.5) / n) * a.length);
    const bays = this.bayCenters?.(leg.index);
    let ascending = raw;
    if (bays && bays.length > 0) {
      const snapped = raw.map((d) =>
        bays.reduce((best, b) => (Math.abs(b - d) < Math.abs(best - d) ? b : best), bays[0]),
      );
      ascending = [...new Set(snapped)].sort((p, q) => p - q); // unique, in order
    }
    this.stops = this.travelSign > 0 ? ascending : ascending.slice().reverse();
    this.stopPos = 0;
    // Skip any showcase stops already behind the entry point (only happens when
    // entering mid-aisle from the camera's current position), so the tour never
    // snaps backward to a stop it has effectively already passed.
    while (this.stopPos < this.stops.length && this.reachedTarget(this.stops[this.stopPos])) {
      this.stopPos++;
    }

    this.rail.setAisle(leg.index, false); // sets index + fires UI onChange
    this.rail.setPose({ dist: this.dist, yaw: this.baseYaw, pitch: 0 });
    this.state = 'travel';
  }

  // --- states --------------------------------------------------------------

  private reachedTarget(target: number): boolean {
    return this.travelSign > 0 ? this.dist >= target : this.dist <= target;
  }

  private updateTravel(dt: number) {
    this.showcasing = false; // only highlight stock while paused and facing a rack

    // Walk toward the next waypoint (the next showcase stop, or the aisle end),
    // accelerating up to cruise speed and decelerating so we arrive at a near
    // standstill — the natural ease-in/ease-out of a person starting to walk and
    // slowing to a halt, instead of a constant-velocity slide.
    const hasStop = this.stopPos < this.stops.length;
    const target = hasStop ? this.stops[this.stopPos] : this.exitDist;
    const remaining = Math.abs(target - this.dist);

    // A showcase stop is a halt — decelerate so we arrive at rest. The aisle end
    // is NOT a stop: keep cruising and carry the momentum into the U-turn, so the
    // walker rounds the corner instead of pausing at every aisle mouth.
    const brakeCap = hasStop ? Math.sqrt(2 * this.opts.accel * remaining) : this.opts.speed;
    const desired = Math.min(this.opts.speed, brakeCap);
    if (this.vel < desired) this.vel = Math.min(desired, this.vel + this.opts.accel * dt);
    else this.vel = Math.max(desired, this.vel - this.opts.accel * dt);

    const step = this.vel * dt;
    const arrived = step >= remaining || remaining <= ARRIVE_EPS;
    this.dist = arrived ? target : this.dist + this.travelSign * step;

    this.rail.setPose({ dist: this.dist, yaw: this.baseYaw });
    this.rail.update(dt);

    if (arrived) {
      if (hasStop) {
        this.stopPos++;
        this.vel = 0;
        // Reset the dwell state machine: inspect the left rack first.
        this.dwellPhase = 'turnIn';
        this.dwellSide = 1;
        this.dwellLeftDone = false;
        this.phaseT = 0;
        this.pitchCur = 0;
        this.state = 'dwell';
      } else {
        this.beginConnect(); // carries this.vel into the connector
      }
    }
  }

  // Showcase: turn to a rack, then inspect its shelves one level at a time —
  // stepping pitch up to the top level and back down to the bottom, pausing on
  // each so the scene's highlight + panel land on every level in turn. Then turn
  // back, pause at centre, and repeat for the other rack. PITCH is driven
  // directly (the value a mouse-drag controls, not the Q/E height); everything is
  // eased so it reads as a person deliberately scanning each shelf.
  private updateDwell(dt: number) {
    const turn = this.opts.turnDuration;
    this.phaseT += dt;
    let off = 0;                 // yaw fraction (-1..1, + = left)
    let pitch = this.pitchCur;   // absolute pitch (radians)

    if (this.dwellPhase === 'turnIn') {
      off = this.dwellSide * smootherstep(this.phaseT / turn);
      pitch = 0;
      this.pitchCur = 0;
      this.inspectLevel = null;
      if (this.phaseT >= turn) {
        // Facing the rack now — capture every shelf's look-pitch for the sweep.
        const plan = this.planVertical?.() ?? null;
        this.vplan = plan && plan.length > 0 ? plan : [];
        this.vTop = this.vplan.length ? Math.max(...this.vplan.map((i) => i.pitch)) : this.opts.pitchAngle;
        this.vBottom = this.vplan.length ? Math.min(...this.vplan.map((i) => i.pitch)) : -this.opts.pitchAngle;
        this.dwellPhase = 'inspect';
        this.phaseT = 0;
      }
    } else if (this.dwellPhase === 'inspect') {
      off = this.dwellSide;
      // One smooth, continuous pitch sweep — level up to the top shelf (over
      // upHold), then down to the bottom shelf (over downHold). The highlight
      // follows whichever shelf the view is nearest, so every level lights up in
      // turn without any stop-start stepping.
      const up = this.opts.upHold;
      const down = this.opts.downHold;
      if (this.phaseT >= up + down) {
        this.dwellPhase = 'turnOut';
        this.phaseT = 0;
        this.pitchFrom = this.pitchCur;
        this.inspectLevel = null;
        pitch = this.pitchCur;
      } else {
        if (this.phaseT < up) {
          pitch = this.vTop * smootherstep(this.phaseT / up);
        } else {
          pitch = this.vTop + (this.vBottom - this.vTop) * smootherstep((this.phaseT - up) / down);
        }
        this.pitchCur = pitch;
        this.inspectLevel = this.nearestLevel(pitch);
      }
    } else if (this.dwellPhase === 'turnOut') {
      const s = smootherstep(this.phaseT / turn);
      off = this.dwellSide * (1 - s);
      pitch = this.pitchFrom * (1 - s); // ease pitch back to level
      this.pitchCur = pitch;
      if (this.phaseT >= turn) {
        if (!this.dwellLeftDone) {
          this.dwellLeftDone = true;
          this.dwellPhase = 'wait';
          this.phaseT = 0;
        } else {
          this.rail.setPose({ yaw: this.baseYaw, pitch: 0 });
          this.state = 'travel';
          return;
        }
      }
    } else { // 'wait' — pause facing forward, then turn to the right rack
      off = 0;
      pitch = 0;
      this.pitchCur = 0;
      if (this.phaseT >= this.opts.centerWait) {
        this.dwellSide = -1;
        this.dwellPhase = 'turnIn';
        this.phaseT = 0;
      }
    }

    if (this.dwellPhase !== 'inspect') this.inspectLevel = null;
    this.showcasing = this.dwellPhase === 'inspect'; // highlight only while scanning a rack
    this.rail.setPose({ yaw: this.baseYaw + this.opts.panAngle * off, pitch });
    this.rail.update(dt);
  }

  // The shelf whose look-pitch is closest to the current pitch — what the camera
  // is presently inspecting during the sweep.
  private nearestLevel(pitch: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const it of this.vplan) {
      const d = Math.abs(it.pitch - pitch);
      if (d < bestD) { bestD = d; best = it.level; }
    }
    return best;
  }

  // Loop wrap: an open-floor path AROUND the outside of the rack block, from this
  // aisle's exit end to the target (first) aisle's entry end — never cutting back
  // through the aisle's own corridor. Both the lane we leave on and the lane we
  // approach on are chosen from the ACTUAL exit/entry ends (front = low X, back =
  // high X), so it works whether A is re-entered from the front OR the back:
  //   • same end  → step out to that end's lane and run straight along it to A.
  //   • opposite  → round the outside via the block's near side edge.
  // The final leg into A is along the aisle axis, so the tangent matches the next
  // leg's heading and the hand-off doesn't snap. Corners use a centripetal
  // Catmull-Rom (won't cusp/overshoot) for a smooth, natural lap back to the start.
  private buildPerimeterReturn(
    from: THREE.Vector3,
    to: THREE.Vector3,
    exitDir: THREE.Vector3,
    enterDir: THREE.Vector3,
    eyeY: number,
  ): THREE.Curve<THREE.Vector3> {
    const M = 9000; // clearance beyond the rack block, out on the open floor (mm)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    // The block to walk around is the ROUTED (racking) aisles; the block-stack
    // drive aisles off to the side must not widen it.
    for (const i of this.routeIdx) {
      const a = this.rail.aisles[i];
      minX = Math.min(minX, a.start.x, a.end.x);
      maxX = Math.max(maxX, a.start.x, a.end.x);
      minZ = Math.min(minZ, a.start.z, a.end.z);
      maxZ = Math.max(maxZ, a.start.z, a.end.z);
    }
    const frontLaneX = minX - M;   // open lane beyond the front mouths (low X)
    const backLaneX = maxX + M;    // open lane beyond the back ends (high X)
    const exitLaneX = exitDir.x < 0 ? frontLaneX : backLaneX;  // lane V leaves on (clears its end)
    // Approach A at ITS OWN mouth — one clearance step outside the entry end — not
    // the global front/back lane. A is a short aisle whose mouth sits well inside
    // the block, so heading to the global lane would overshoot and double back; we
    // round the clear side edge straight to the mouth and turn in there instead.
    const entryApproachX = to.x - enterDir.x * M; // enterDir points INTO the aisle
    // Round the outside via whichever side edge the target aisle is nearer.
    const sideZ = (to.z - minZ) <= (maxZ - to.z) ? minZ - M : maxZ + M;
    // Does the exit lane sit on the SAME side the target mouth opens toward? The
    // mouth opens opposite enterDir; the exit lane is on the exitDir side. When
    // they match (exitDir and enterDir point opposite ways along the aisle axis),
    // the lane runs straight past the mouth — we can drop down it to the target
    // row and turn directly in, no detour. When they DON'T match (exit on the far
    // side), we still have to round the block's near Z edge to reach the mouth.
    // Without this, a front-side exit was routed around the bottom edge anyway —
    // dipping BELOW the target row and doubling back up, an S-shaped zig-zag into
    // the mouth instead of a clean turn-in.
    const directApproach = exitDir.x * enterDir.x < 0;

    const pts: THREE.Vector3[] = [];
    const push = (x: number, z: number) => {
      const v = new THREE.Vector3(x, eyeY, z);
      if (pts.length === 0 || pts[pts.length - 1].distanceToSquared(v) > 1) pts.push(v);
    };

    push(from.x, from.z);            // our exit, on the rail
    push(exitLaneX, from.z);         // step straight out to the exit-side lane
    if (directApproach) {
      // Exit lane already faces the mouth: run straight down it to the target's
      // row, then turn directly into the mouth — one continuous spiral, no dip.
      push(exitLaneX, to.z);
    } else {
      if (Math.abs(exitLaneX - entryApproachX) > 1) {
        // Cross around the clear side edge directly to A's own mouth, instead of
        // running to the global lane and doubling back along A's row.
        push(exitLaneX, sideZ);
        push(entryApproachX, sideZ);
      }
      push(entryApproachX, to.z);    // come up to A's row, just outside the mouth
    }
    push(to.x, to.z);                // turn straight into A's mouth

    // Straight runs joined by rounded Bézier corners (same idea as the aisle
    // U-turns), so the heading stays tangent-continuous and the camera turns
    // smoothly — no left/right tilt the way a Catmull-Rom through these corners
    // would swing.
    return this.roundedPath(pts, 8000);
  }

  // Turn a polyline into a smooth path: straight LineCurve3 runs with each corner
  // replaced by a quadratic Bézier whose endpoints sit `radius` back along the two
  // edges and whose control point is the corner. The Bézier's start/end tangents
  // equal the incoming/outgoing edge directions, so the joins are tangent-
  // continuous (C1) — the heading never reverses, so no wobble.
  private roundedPath(pts: THREE.Vector3[], radius: number): THREE.Curve<THREE.Vector3> {
    if (pts.length <= 2) {
      return new THREE.LineCurve3(
        (pts[0] ?? new THREE.Vector3()).clone(),
        (pts[pts.length - 1] ?? pts[0] ?? new THREE.Vector3()).clone(),
      );
    }
    const path = new THREE.CurvePath<THREE.Vector3>();
    let cursor = pts[0].clone();
    for (let i = 1; i < pts.length - 1; i++) {
      const cur = pts[i];
      const inDir = cur.clone().sub(pts[i - 1]);
      const outDir = pts[i + 1].clone().sub(cur);
      const inLen = inDir.length();
      const outLen = outDir.length();
      if (inLen < 1 || outLen < 1) continue; // skip a degenerate / colinear vertex
      inDir.divideScalar(inLen);
      outDir.divideScalar(outLen);
      const r = Math.min(radius, inLen * 0.5, outLen * 0.5);
      const cutIn = cur.clone().addScaledVector(inDir, -r);
      const cutOut = cur.clone().addScaledVector(outDir, r);
      if (cursor.distanceToSquared(cutIn) > 1) path.add(new THREE.LineCurve3(cursor.clone(), cutIn.clone()));
      path.add(new THREE.QuadraticBezierCurve3(cutIn.clone(), cur.clone(), cutOut.clone()));
      cursor = cutOut;
    }
    const last = pts[pts.length - 1];
    if (cursor.distanceToSquared(last) > 1) path.add(new THREE.LineCurve3(cursor.clone(), last.clone()));
    return path.curves.length ? path : new THREE.LineCurve3(pts[0].clone(), last.clone());
  }

  // Build a wide curved path that rounds the rack ends into the next aisle. The
  // camera leaves the aisle along its travel heading (so it walks a few steps
  // past the mouth first), bulges out into the cross aisle, and arrives aligned
  // with the next aisle's heading — a smooth U-turn, never a sharp pivot.
  private beginConnect() {
    const a = this.rail.aisles[this.curLeg.index];
    const nextLeg = this.legAt(this.seqPos + 1);
    const nb = this.rail.aisles[nextLeg.index];
    const entryDist = nextLeg.enterFromEnd ? nb.length : 0;
    const eyeY = this.camera.position.y;
    // A low drive aisle and a tall racking aisle want different eye heights: ease
    // between them along the connector so the hand-off never steps.
    this.connFromY = eyeY;
    this.connToY = this.rail.targetHeightFor(nextLeg.index);

    // Endpoints on the centrelines (at eye height).
    const from = this.camera.position.clone();
    const to = nb.start.clone().addScaledVector(nb.dir, entryDist);
    to.y = eyeY;

    // Travel heading leaving the current aisle, and the heading we must be on to
    // enter the next. Both horizontal, normalised.
    const exitDir = a.dir.clone().multiplyScalar(this.travelSign).setY(0).normalize();
    const enterDir = nb.dir.clone().multiplyScalar(nextLeg.enterFromEnd ? -1 : 1).setY(0).normalize();

    // Split the gap to the next entry into the component ALONG our exit heading
    // (how much further the next aisle reaches ahead — we walk this off first) and
    // the PERPENDICULAR cross-aisle component (the gap the U-turn steps across).
    const delta = to.clone().sub(from);
    delta.y = 0;
    const along = delta.dot(exitDir);
    const perp = delta.clone().addScaledVector(exitDir, -along).length();

    // The loop restart (back to the route's first aisle) walks AROUND the outside of
    // the block on the open floor. Every other step is a neighbour U-turn however wide
    // the cross aisle: the block-stack drive aisles sit 12.6 m apart (18.9 m in the
    // depth-stretched world) and round their bank ends exactly like the racks do.
    const n = this.aisleCount;
    const nextOffset = (((this.startIdx + this.seqPos + 1) % n) + n) % n;
    const wrapping = nextOffset === 0 || perp > CONN_WRAP_FAR;
    this.connSpeedMul = wrapping ? 3 : 1; // the long perimeter lap moves briskly

    // Width of the U-turn curve: smooth and wide enough for the cross gap.
    const turn = clamp(perp * CONN_HANDLE_FRAC, CONN_STEP_PAST, CONN_HANDLE_MAX);

    if (wrapping) {
      // Loop wrap: a perimeter walk around the outside of the rack block, on the
      // floor, from this aisle's exit end round to the next aisle's mouth.
      this.connCurve = this.buildPerimeterReturn(from, to, exitDir, enterDir, eyeY);
      this.connLift = 0;
    } else {
      // Walk straight forward along the current heading until level with the next
      // aisle's end (covering the empty floor where this aisle stops short), THEN
      // make the U-turn. The pivot is that alignment point on our centreline.
      const pivot = from.clone().addScaledVector(exitDir, Math.max(0, along));
      pivot.y = eyeY;
      // U-turn: leave the pivot still on our heading, round the rack end, and come
      // back onto the next aisle's heading. Control points share the pivot/entry
      // tangents so the join from the straight run is seamless.
      const c1 = pivot.clone().addScaledVector(exitDir, turn);
      const c2 = to.clone().addScaledVector(enterDir, -turn);
      c1.y = eyeY;
      c2.y = eyeY;
      const uturn = new THREE.CubicBezierCurve3(pivot, c1, c2, to);

      if (pivot.distanceToSquared(from) > 1) {
        const path = new THREE.CurvePath<THREE.Vector3>();
        path.add(new THREE.LineCurve3(from.clone(), pivot));
        path.add(uturn);
        this.connCurve = path;
      } else {
        this.connCurve = uturn; // already aligned (same-end turn): just the U
      }
      this.connLift = 0;
    }

    this.connLen = Math.max(1, this.connCurve.getLength());

    this.connU = 0;
    this.state = 'connect';
  }

  private updateConnect(dt: number) {
    this.showcasing = false;
    if (!this.connCurve) { this.advanceLeg(); return; }

    // Keep walking through the turn, easing up toward cruise (momentum carried in
    // from the aisle). Advancing by arc length keeps the pace steady on the curve.
    // The perimeter wrap uses a higher cruise (connSpeedMul) so the long lap back to
    // the first aisle doesn't drag.
    this.vel = Math.min(this.opts.speed * this.connSpeedMul, this.vel + this.opts.accel * dt);
    this.connU = Math.min(1, this.connU + (this.vel * dt) / this.connLen);
    const t = this.connU;

    this.connCurve.getPointAt(t, this.scratch);
    this.scratch.y = this.connFromY + (this.connToY - this.connFromY) * smootherstep(t) + this.connLift * Math.sin(Math.PI * t);
    this.camera.position.copy(this.scratch);

    // Face along the path tangent so the view turns gradually with the curve —
    // the gentle, accelerating-then-decelerating swing of a real U-turn.
    this.connCurve.getTangentAt(t, this.scratchTan);
    this.scratchEuler.set(0, Math.atan2(-this.scratchTan.x, -this.scratchTan.z), 0);
    this.camera.quaternion.setFromEuler(this.scratchEuler);

    if (this.connU >= 1) this.advanceLeg();
  }

  private advanceLeg() {
    this.seqPos += 1;
    this.beginLeg(this.legAt(this.seqPos));
  }
}
