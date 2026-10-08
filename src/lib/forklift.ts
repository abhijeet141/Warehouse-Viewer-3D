import * as THREE from 'three';

// Counterbalance forklift built from primitives, so the viewer needs no model
// files. Local frame: origin at the fork heel on the floor, +X forward (the forks
// point along +X), +Y up. The carriage group rises with the forks and is where a
// carried pallet is parented. Sizes in mm (world units); the truck lives at scene
// level, not inside the depth-stretched worldGroup, so it can turn without shear.

export interface ForkliftHandle {
  group: THREE.Group;
  carriage: THREE.Group;
  setForkHeight(h: number): void;
  dispose(): void;
}

export function buildForklift(): ForkliftHandle {
  const group = new THREE.Group();
  group.name = 'FORKLIFT';
  const geoms: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const mat = (color: number, roughness: number, metalness: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
    mats.push(m);
    return m;
  };
  const yellow = mat(0xf2a516, 0.5, 0.15);
  const dark = mat(0x2b3036, 0.6, 0.45);
  const black = mat(0x15181c, 0.9, 0.05);
  const steel = mat(0x8a9099, 0.4, 0.75);
  const rubber = mat(0x111417, 0.95, 0);

  const box = (parent: THREE.Object3D, m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    geoms.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.raycast = () => {};
    parent.add(mesh);
    return mesh;
  };
  // cylinder with its axis along Z (wheels, hubs)
  const wheel = (m: THREE.Material, r: number, len: number, x: number, y: number, z: number) => {
    const g = new THREE.CylinderGeometry(r, r, len, 24);
    geoms.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.raycast = () => {};
    group.add(mesh);
  };

  // chassis, counterweight body, bumper stripe, hood in front of the driver
  box(group, dark, 2300, 260, 1200, -1350, 430, 0);
  box(group, yellow, 1500, 820, 1150, -1650, 970, 0);
  box(group, black, 1520, 110, 1160, -1650, 640, 0);
  box(group, yellow, 520, 480, 1100, -650, 790, 0);
  // four wheels
  for (const x of [-500, -1950]) {
    for (const z of [-620, 620]) {
      wheel(rubber, 320, 240, x, 320, z);
      wheel(steel, 150, 250, x, 320, z);
    }
  }
  // overhead guard
  for (const x of [-700, -2000]) for (const z of [-500, 500]) box(group, dark, 70, 950, 70, x, 1725, z);
  box(group, dark, 1500, 50, 1150, -1350, 2210, 0);
  // seat and backrest
  box(group, black, 420, 380, 480, -1650, 1580, 0);
  box(group, black, 120, 520, 480, -1830, 1900, 0);
  // outer mast: two uprights and three cross braces
  for (const z of [-430, 430]) box(group, dark, 120, 4300, 120, -200, 2150, z);
  for (const y of [900, 2400, 4250]) box(group, dark, 120, 90, 740, -200, y, 0);
  // inner mast: telescopes up once the forks go beyond the outer mast's reach
  const innerMast = new THREE.Group();
  group.add(innerMast);
  for (const z of [-330, 330]) box(innerMast, steel, 80, 3800, 80, -130, 1900, z);
  box(innerMast, steel, 80, 80, 580, -130, 3760, 0);
  // carriage: load backrest plus two forks
  const carriage = new THREE.Group();
  carriage.name = 'FORK_CARRIAGE';
  group.add(carriage);
  box(carriage, dark, 60, 950, 1000, -40, 475, 0);
  for (const z of [-300, 300]) box(carriage, steel, 1150, 45, 120, 575, 22, z);

  const handle: ForkliftHandle = {
    group,
    carriage,
    setForkHeight(h: number) {
      carriage.position.y = h;
      innerMast.position.y = Math.max(0, h - 3400);
    },
    dispose() {
      for (const g of geoms) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
  handle.setForkHeight(300);
  return handle;
}

// One scripted motion. Positions are DATA mm (X along the aisles, Y across); the
// driver converts to world (Y → Z × hScale) when it places the truck.
export type DriveStep =
  | { kind: 'move'; x: number; y: number; speed: number }           // straight line, eased
  | { kind: 'turn'; heading: [number, number]; duration: number }  // face this data-frame direction
  | { kind: 'lift'; height: number; speed: number }                // fork height, linear
  | { kind: 'wait'; duration: number }
  | { kind: 'call'; fn: () => void };                              // side effect, instant

const smooth = (t: number) => t * t * (3 - 2 * t);

// Plays DriveSteps in order. Movement is eased so the truck pulls away and stops
// like a real machine; turns take the shortest way round. onIdle fires once each
// time the queue drains, which is how the flow chains "drive there, then do this".
export class ForkliftDriver {
  pos = { x: 0, y: 0 };
  heading = 0;   // radians in the data frame: 0 = +X, π/2 = +Y
  forkH = 300;
  onIdle: (() => void) | null = null;

  private queue: DriveStep[] = [];
  private step: DriveStep | null = null;
  private t = 0;
  private T = 1;
  private from = { x: 0, y: 0, a: 0, da: 0, h: 0 };
  private wasBusy = false;

  constructor(private truck: ForkliftHandle, private hS: number) {}

  get busy(): boolean {
    return this.step !== null || this.queue.length > 0;
  }

  place(x: number, y: number, heading: [number, number]) {
    this.pos = { x, y };
    this.heading = Math.atan2(heading[1], heading[0]);
    this.apply();
  }

  enqueue(...steps: DriveStep[]) {
    this.queue.push(...steps);
    this.wasBusy = true;
  }

  clear() {
    this.queue = [];
    this.step = null;
    this.wasBusy = false;
  }

  update(dtIn: number) {
    let dt = dtIn;
    for (let guard = 0; guard < 24; guard++) {
      if (!this.step) {
        const next = this.queue.shift();
        if (!next) {
          if (this.wasBusy) {
            this.wasBusy = false;
            this.apply();
            this.onIdle?.();
          }
          return;
        }
        this.step = next;
        this.t = 0;
        this.begin(next);
        if (next.kind === 'call') { this.step = null; next.fn(); continue; }
        if (this.T <= 0) { this.finish(next); this.step = null; continue; }
      }
      if (dt <= 0) break;
      const s = this.step;
      const use = Math.min(dt, this.T - this.t);
      this.t += use;
      dt -= use;
      this.progress(s, Math.min(1, this.t / this.T));
      if (this.t >= this.T - 1e-6) { this.finish(s); this.step = null; }
    }
    this.apply();
  }

  private begin(s: DriveStep) {
    switch (s.kind) {
      case 'move': {
        this.from.x = this.pos.x;
        this.from.y = this.pos.y;
        const d = Math.hypot(s.x - this.pos.x, s.y - this.pos.y);
        this.T = d < 1 ? 0 : Math.max(0.35, d / s.speed);
        break;
      }
      case 'turn': {
        const to = Math.atan2(s.heading[1], s.heading[0]);
        let da = to - this.heading;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        this.from.a = this.heading;
        this.from.da = da;
        this.T = Math.abs(da) < 1e-3 ? 0 : s.duration;
        break;
      }
      case 'lift':
        this.from.h = this.forkH;
        this.T = Math.abs(s.height - this.forkH) / s.speed;
        break;
      case 'wait':
        this.T = s.duration;
        break;
      case 'call':
        this.T = 0;
        break;
    }
  }

  private progress(s: DriveStep, p: number) {
    const e = smooth(p);
    switch (s.kind) {
      case 'move':
        this.pos.x = this.from.x + (s.x - this.from.x) * e;
        this.pos.y = this.from.y + (s.y - this.from.y) * e;
        break;
      case 'turn':
        this.heading = this.from.a + this.from.da * e;
        break;
      case 'lift':
        this.forkH = this.from.h + (s.height - this.from.h) * p;
        break;
    }
  }

  private finish(s: DriveStep) {
    if (s.kind === 'move') { this.pos.x = s.x; this.pos.y = s.y; }
    else if (s.kind === 'turn') this.heading = this.from.a + this.from.da;
    else if (s.kind === 'lift') this.forkH = s.height;
  }

  private apply() {
    const g = this.truck.group;
    g.position.set(this.pos.x, 0, this.pos.y * this.hS);
    // world heading (dx, dz = dy) → rotation about Y that maps local +X onto it
    g.rotation.y = -this.heading;
    this.truck.setForkHeight(this.forkH);
  }
}
