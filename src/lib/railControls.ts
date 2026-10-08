import * as THREE from 'three';
import type { Segment } from '../types';

// One walkway, reduced to a straight centerline on the floor (Three-space X/Z).
export interface Aisle {
  name: string;
  start: THREE.Vector3; // floor point, y = 0
  end: THREE.Vector3;   // floor point, y = 0
  dir: THREE.Vector3;   // normalized start -> end
  length: number;
  height: number;       // the aisle volume's height (Three Y); caps the eye height in low aisles
}

export interface RailControlsOptions {
  eyeHeight?: number;     // starting camera height in world units (Three Y)
  moveSpeed?: number;     // world units / second along the rail
  verticalSpeed?: number; // world units / second for rising / descending
  keyYawSpeed?: number;   // radians / second for A / D turning
  dragLookSpeed?: number; // radians / pixel for mouse-drag look
  wheelSpeed?: number;    // world units per wheel notch
  minHeight?: number;     // lowest the camera may descend (Three Y)
  maxHeight?: number;     // highest the camera may rise; defaults to tallest segment
  minPitch?: number;      // look-down clamp (radians)
  maxPitch?: number;      // look-up clamp (radians)
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Keys that count as a manual takeover (movement, look, vertical, aisle switch).
const NAV_CODES = new Set([
  'KeyW', 'ArrowUp', 'KeyS', 'ArrowDown', 'KeyA', 'KeyD',
  'KeyE', 'PageUp', 'KeyQ', 'PageDown', 'ArrowLeft', 'ArrowRight',
]);

/**
 * Rail navigation: camera X/Z is locked to an aisle centerline (so it can never
 * enter a rack), while orientation is free (drag to look, A/D to turn) and the
 * user can ride straight up / down the aisle to inspect higher rack levels.
 * Switch between aisles with prevAisle() / nextAisle() (or the arrow keys).
 */
export class RailControls {
  enabled = false;
  aisles: Aisle[] = [];
  index = 0;
  topY = 0; // tallest segment top, in Three Y

  // Fires whenever the active aisle changes, so Svelte UI can update.
  onChange: ((info: { index: number; name: string; total: number }) => void) | null = null;

  // When true, update() ignores keyboard/pointer movement so an external driver
  // (the virtual tour autopilot) can script dist/yaw/pitch/height via setPose();
  // the camera is still rendered from that state each frame.
  autopilot = false;

  // Fires on any manual movement / look / aisle-switch input while enabled, so
  // the tour can hand control back to the user (it stops itself on first input).
  onUserInput: (() => void) | null = null;

  private dist = 0;    // distance traveled along the current aisle
  private height = 0;  // current camera Y
  private yaw = 0;     // around world Y
  private pitch = 0;   // around local X
  private opts: Required<Omit<RailControlsOptions, 'maxHeight'>> & { maxHeight: number };
  private keys = { fwd: false, back: false, left: false, right: false, up: false, down: false, strafeL: false, strafeR: false };
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    segments: Segment[],
    options: RailControlsOptions = {},
  ) {
    this.aisles = this.buildAisles(segments);
    this.topY = this.computeTopY(segments);

    this.opts = {
      eyeHeight: options.eyeHeight ?? 1700,
      moveSpeed: options.moveSpeed ?? 6000,
      verticalSpeed: options.verticalSpeed ?? 4000,
      keyYawSpeed: options.keyYawSpeed ?? 1.6,
      dragLookSpeed: options.dragLookSpeed ?? 0.005,
      wheelSpeed: options.wheelSpeed ?? 1500,
      minHeight: options.minHeight ?? 200,
      maxHeight: options.maxHeight ?? this.topY,
      minPitch: options.minPitch ?? -Math.PI / 2.1,
      maxPitch: options.maxPitch ?? Math.PI / 2.1,
    };
    this.height = this.opts.eyeHeight;

    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onWheel = this.onWheel.bind(this);
  }

  // Reduce each AISLE box to its centerline. Mapping matches WarehouseScene:
  // Three X <- segment X, Three Z <- segment Y. Long footprint axis = travel dir.
  private buildAisles(segments: Segment[]): Aisle[] {
    const out: Aisle[] = [];
    for (const s of segments) {
      if (s.type !== 'AISLE') continue;
      const cx = s.coordinateX + s.dimensionX / 2; // Three X center
      const cz = s.coordinateY + s.dimensionY / 2; // Three Z center
      let start: THREE.Vector3;
      let end: THREE.Vector3;
      if (s.dimensionX >= s.dimensionY) {
        start = new THREE.Vector3(s.coordinateX, 0, cz);
        end = new THREE.Vector3(s.coordinateX + s.dimensionX, 0, cz);
      } else {
        start = new THREE.Vector3(cx, 0, s.coordinateY);
        end = new THREE.Vector3(cx, 0, s.coordinateY + s.dimensionY);
      }
      const dir = end.clone().sub(start);
      const length = dir.length();
      if (length < 1) continue;
      dir.normalize();
      out.push({ name: s.fullName, start, end, dir, length, height: s.dimensionZ });
    }
    // Single-letter racking aisles first (A, B, … V), then longer-named zones such
    // as the block-stack drive aisle (BS) — so prev/next and the picker walk the
    // rack block in order and the block stack comes at the end.
    out.sort((a, b) =>
      (a.name.length - b.name.length) || a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    return out;
  }

  // Tallest point of the model: segment Z is Three's up axis.
  private computeTopY(segments: Segment[]): number {
    let top = 0;
    for (const s of segments) top = Math.max(top, s.coordinateZ + s.dimensionZ);
    return top;
  }

  enable() {
    if (this.enabled || this.aisles.length === 0) return;
    this.enabled = true;
    this.height = this.opts.eyeHeight;
    this.setAisle(this.nearestAisle(), true);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('wheel', this.onWheel, { passive: false });
    this.dom.style.cursor = 'grab';
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.style.cursor = '';
    this.keys = { fwd: false, back: false, left: false, right: false, up: false, down: false, strafeL: false, strafeR: false };
    this.dragging = false;
  }

  dispose() {
    this.disable();
  }

  get aisleNames(): string[] {
    return this.aisles.map((a) => a.name);
  }

  // Current distance along the active aisle's centreline, so the tour can pick
  // up from exactly where the user is standing rather than the aisle's start.
  get currentDist(): number {
    return this.dist;
  }

  setAisle(index: number, faceForward = true) {
    if (this.aisles.length === 0) return;
    const n = this.aisles.length;
    this.index = ((index % n) + n) % n;
    const a = this.aisles[this.index];
    this.dist = 0; // drop in at the start of the aisle, beside the first rack
    // A low aisle (the block-stack drive aisle runs under nothing, ~4 m) drops the
    // eye to a human-ish height so the stacks are seen from the floor rather than
    // from the rack-level eye height the racking aisles use.
    const cap = a.height * 0.5;
    if (this.height > cap) this.height = Math.max(this.opts.minHeight, cap);
    if (faceForward) {
      this.yaw = Math.atan2(-a.dir.x, -a.dir.z); // face down the aisle toward 'end'
      this.pitch = 0;
    }
    this.onChange?.({ index: this.index, name: a.name, total: n });
  }

  nextAisle() {
    this.setAisle(this.index + 1);
  }

  prevAisle() {
    this.setAisle(this.index - 1);
  }

  // Programmatic drive for the autopilot. dist is clamped to the active aisle;
  // height to its travel limits. Only provided fields change.
  setPose(p: { dist?: number; yaw?: number; pitch?: number; height?: number }) {
    const a = this.aisles[this.index];
    if (p.dist !== undefined && a) this.dist = clamp(p.dist, 0, a.length);
    if (p.yaw !== undefined) this.yaw = p.yaw;
    if (p.pitch !== undefined) this.pitch = p.pitch;
    if (p.height !== undefined) {
      this.height = clamp(p.height, this.opts.minHeight, this.opts.maxHeight);
    }
  }

  seek(dist: number) {
    this.setPose({ dist });
  }

  // Adopt the camera's current world pose into the rail's own state (active aisle,
  // distance along it, yaw/pitch, eye height). Used when the virtual tour hands
  // control back: the camera may be mid-turn between aisles where the rail's
  // stored state is stale, so re-derive it from where the camera actually is/looks
  // to avoid snapping or flipping the view.
  syncFromCamera() {
    if (this.aisles.length === 0) return;
    this.index = this.nearestAisle();
    const a = this.aisles[this.index];
    const rel = this.camera.position.clone().sub(a.start);
    this.dist = clamp(rel.dot(a.dir), 0, a.length);
    this.height = this.camera.position.y;
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
    this.onChange?.({ index: this.index, name: a.name, total: this.aisles.length });
  }

  // The aisle the camera is actually standing in: the one whose centreline runs
  // closest to it, measured to the NEAREST POINT on the segment (not the midpoint).
  // Using the midpoint mis-fires when aisles differ in length/offset — walking far
  // along a long aisle could land nearer a neighbour's midpoint and snap the camera
  // sideways into that aisle on pause/stop. Distance to the closest point on the
  // centreline is ~0 for the aisle you're in (you're on its line) and at least the
  // lateral gap for any parallel aisle, so the right one always wins. (Height is a
  // shared constant across all centrelines, so it doesn't affect the argmin.)
  private nearestAisle(): number {
    const p = this.camera.position;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.aisles.length; i++) {
      const a = this.aisles[i];
      const t = clamp(p.clone().sub(a.start).dot(a.dir), 0, a.length);
      const closest = a.start.clone().addScaledVector(a.dir, t);
      const d = closest.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private onKeyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    // Any recognised navigation key is a manual takeover — let the tour bail out.
    if (NAV_CODES.has(e.code)) this.onUserInput?.();
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        // Facing a rack, "forward" crosses through it to that side's aisle (one
        // hop per press); facing down the aisle, it glides along the rail as usual.
        if (this.facingAcrossAisle()) { if (!e.repeat) this.stepAcrossToward(true); break; }
        this.keys.fwd = true;
        break;
      case 'KeyS':
      case 'ArrowDown':
        if (this.facingAcrossAisle()) { if (!e.repeat) this.stepAcrossToward(false); break; }
        this.keys.back = true;
        break;
      case 'KeyA':
        this.keys.left = true;
        break;
      case 'KeyD':
        this.keys.right = true;
        break;
      case 'KeyE':
      case 'PageUp':
        this.keys.up = true;
        break;
      case 'KeyQ':
      case 'PageDown':
        this.keys.down = true;
        break;
      case 'ArrowLeft':
        // Turned toward a rack, screen-left runs along the aisle → strafe the
        // camera down the rail; facing down the aisle, hop to the prev aisle.
        if (this.facingAcrossAisle()) this.keys.strafeL = true;
        else this.prevAisle();
        break;
      case 'ArrowRight':
        if (this.facingAcrossAisle()) this.keys.strafeR = true;
        else this.nextAisle();
        break;
      default:
        return;
    }
    if (e.code.startsWith('Arrow') || e.code === 'PageUp' || e.code === 'PageDown') {
      e.preventDefault();
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keys.fwd = false;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.keys.back = false;
        break;
      case 'KeyA':
        this.keys.left = false;
        break;
      case 'KeyD':
        this.keys.right = false;
        break;
      case 'KeyE':
      case 'PageUp':
        this.keys.up = false;
        break;
      case 'KeyQ':
      case 'PageDown':
        this.keys.down = false;
        break;
      case 'ArrowLeft':
        this.keys.strafeL = false;
        break;
      case 'ArrowRight':
        this.keys.strafeR = false;
        break;
    }
  }

  // True when the view is turned far enough across the aisle (looking at a rack)
  // that screen left/right runs ALONG the aisle. Past ~45° off the centreline the
  // arrows strafe the camera down the rail instead of switching aisles.
  private facingAcrossAisle(): boolean {
    const a = this.aisles[this.index];
    if (!a) return false;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    return Math.abs(right.dot(a.dir)) > 0.5;
  }

  // While looking at a rack, hop to the neighbouring aisle the view points at —
  // i.e. "through" the rack you're facing (forward) or the one behind you (back).
  // Picks whichever adjacent aisle best lines up with the look direction across
  // the rail, and does nothing at the row's edge where there's no aisle that way.
  private stepAcrossToward(forward: boolean) {
    const a = this.aisles[this.index];
    if (!a) return;
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    look.y = 0;
    if (!forward) look.negate();
    if (look.lengthSq() < 1e-6) return;
    look.normalize();
    const here = a.start.clone().addScaledVector(a.dir, a.length / 2);
    let step = 0;
    let bestDot = 0.3; // require a fairly clear match so a glance doesn't jump aisles
    for (const s of [-1, 1]) {
      const b = this.aisles[this.index + s];
      if (!b) continue;
      const toB = b.start.clone().addScaledVector(b.dir, b.length / 2).sub(here);
      toB.y = 0;
      if (toB.lengthSq() < 1e-6) continue;
      const d = look.dot(toB.normalize());
      if (d > bestDot) { bestDot = d; step = s; }
    }
    if (step === 0) return;
    const target = this.index + step;
    const b = this.aisles[target];
    // Keep our spot along the rail and our gaze on the racks (faceForward = false),
    // so it reads as stepping straight across to the rack in front — not restarting
    // the neighbouring aisle from its mouth.
    const keepDist = clamp(this.camera.position.clone().sub(b.start).dot(b.dir), 0, b.length);
    this.setAisle(target, false);
    this.dist = keepDist;
  }

  private onPointerDown(e: PointerEvent) {
    this.onUserInput?.(); // grabbing the view takes over from the tour
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.dom.style.cursor = 'grabbing';
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    // Grab-the-world drag, matching OrbitControls in the overview mode: dragging
    // moves the scene WITH the cursor (drag right -> scene swings right, drag
    // down -> scene tilts down), the same convention as Google Street View.
    // The previous FPS-style look (yaw -= dx) turned the opposite way from the
    // orbit view, so the drag direction flipped the moment you entered the
    // walkthrough — the contradictory behaviour reported on the exhibition demo.
    this.yaw += dx * this.opts.dragLookSpeed;
    this.pitch += dy * this.opts.dragLookSpeed;
    this.pitch = clamp(this.pitch, this.opts.minPitch, this.opts.maxPitch);
  }

  private onPointerUp() {
    this.dragging = false;
    this.dom.style.cursor = 'grab';
  }

  private onWheel(e: WheelEvent) {
    // Swallow the wheel event so the browser doesn't scroll/zoom the page, but
    // don't glide along the aisle — scroll is intentionally inert inside a walk.
    e.preventDefault();
    // const a = this.aisles[this.index];
    // this.dist = clamp(this.dist + Math.sign(e.deltaY) * this.opts.wheelSpeed, 0, a.length);
  }

  // Call once per frame from the render loop.
  update(dt: number) {
    if (!this.enabled || this.aisles.length === 0) return;
    const a = this.aisles[this.index];

    // Manual input is skipped under autopilot; the tour scripts dist/yaw/pitch
    // via setPose() and we still render from that state below.
    if (!this.autopilot) {
      if (this.keys.left) this.yaw += this.opts.keyYawSpeed * dt;
      if (this.keys.right) this.yaw -= this.opts.keyYawSpeed * dt;

      // Forward / back glides along the rail, in whichever direction we face.
      let move = 0;
      if (this.keys.fwd) move += 1;
      if (this.keys.back) move -= 1;
      if (move !== 0) {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const along = forward.dot(a.dir);
        const sign = Math.abs(along) < 0.1 ? 1 : Math.sign(along);
        this.dist = clamp(this.dist + move * sign * this.opts.moveSpeed * dt, 0, a.length);
      }

      // Strafe: when the view is turned toward a rack, ←/→ walk the camera ALONG
      // the aisle (screen-left / screen-right project onto the rail) rather than
      // switching aisles — so the keys match where you're actually looking.
      let strafe = 0;
      if (this.keys.strafeR) strafe += 1;
      if (this.keys.strafeL) strafe -= 1;
      if (strafe !== 0) {
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const along = right.dot(a.dir);
        if (Math.abs(along) > 1e-3) {
          this.dist = clamp(this.dist + strafe * Math.sign(along) * this.opts.moveSpeed * dt, 0, a.length);
        }
      }

      // Up / down rides straight up the aisle to inspect higher levels.
      let lift = 0;
      if (this.keys.up) lift += 1;
      if (this.keys.down) lift -= 1;
      if (lift !== 0) {
        this.height = clamp(
          this.height + lift * this.opts.verticalSpeed * dt,
          this.opts.minHeight,
          this.opts.maxHeight,
        );
      }
    }

    const pos = a.start.clone().addScaledVector(a.dir, this.dist);
    pos.y = this.height;
    this.camera.position.copy(pos);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }
}