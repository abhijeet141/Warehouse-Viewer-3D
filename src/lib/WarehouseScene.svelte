<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
  import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
  import { RailControls } from './railControls';
  import { TourController } from './tourController';
  import { buildRacks, buildAisleSigns, buildPallets, buildSafetyNets, groupBaysIntoRows } from './rackBuilder';
  import { buildEnvironment, type ShellBounds } from './environmentBuilder';
  import { buildGoods, isDemoOccupied } from './goodsBuilder';
  import { disposeGoodsTextures } from './goodsTextures';
  import { generatePodData, renderPodLabel, type PodData } from './podLabel';
  import { buildBlockStackStock, buildBlockStackMarkings, podBounds, makeCarriedPallet, type BlockStackStock, type PodBox } from './blockStackBuilder';
  import { buildForklift, ForkliftDriver, type ForkliftHandle } from './forklift';
  import { BlockStackFlow, flowState, type FlowHost } from './blockStackFlow';
  import FlowPanel from './FlowPanel.svelte';
  import { get } from 'svelte/store';
  import { disposeBlockStackTextures } from './blockStackTextures';
  import {
    BS, buildDemoLaneStock, describeClass, describeContents, describePodPosition, podStatus,
    type LanePod, type LaneStock, type PodStatus,
  } from '../data/blockStack';
  import type { Segment, SegmentType } from '../types';

  export let segments: Segment[];
  export let visibleTypes: Set<SegmentType>;
  // Demo stock toggle: when true, occupied bins are filled with pallets + box
  // stacks (seeded demo fill). Built lazily on first enable.
  export let showStock = false;
  // Building shell (roof, walls, columns, lights) visibility — toggled from the
  // App header. Off = open overview that can pull back past the walls.
  export let showShell = true;
  export let camera: {
    position: [number, number, number];
    fov?: number;
    near?: number;
    far?: number;
  // Default vantage (data mm): an elevated corner overview looking diagonally
  // across the rack block — the angled hero shot used on load and Reset. Scroll
  // in for individual spaces. fov 40 keeps a telephoto look (less perspective
  // shrink than the old 50). Parked high in the A-side margin, looking across the
  // block-stack banks (foreground) toward the rack block, so both storage types
  // read in the opening shot.
  } = { position: [-20000, 24500, -68000], fov: 40, near: 100, far: 800000 };
  export let orbit: {
    target: [number, number, number];
    minDistance: number;
    maxDistance: number;
  // maxDistance keeps zoom-out within the building; the shell clamp in
  // animate() hard-stops the camera at the walls/roof either way.
  } = { target: [60000, 0, 10000], minDistance: 1000, maxDistance: 160000 };
  export let floorY = 100;

  // eyeHeight: drop in at the third rack level (C: 5200–7700mm). fov 50 (≈80°
  // horizontal at 16:9) matches natural forward-focused human vision — the way
  // ahead stays the primary focus and the side racks sit toward the edges,
  // rather than the old 70 (≈100°+ horizontal) which showed too much periphery.
  // Ride down with Q to drop to floor level.
  export let walk: { eyeHeight: number; moveSpeed: number; fov: number } = { eyeHeight: 6450, moveSpeed: 6000, fov: 50 };

  const COLOR_MAP: Record<SegmentType, number> = {
    AISLE: 0x3b82f6,
    BAY:   0xf97316,
    LEVEL: 0x22c55e,
    SPACE: 0xef4444,
    BLOCK: 0x6366f1, // block-stack zone (the container of lanes)
    LANE:  0xec4899, // block-stack lane (the floor location)
  };

  const OPACITY_MAP: Record<SegmentType, number> = {
    AISLE: 0.06,
    BAY:   0.15,
    LEVEL: 0.30,
    SPACE: 0.15,
    BLOCK: 0.06,
    LANE:  0.15,
  };

  // Fixed draw order for the transparent tiers. Without this three.js sorts
  // them by camera distance per-object (not per-instance), so at low camera
  // angles the red SPACE mesh can be drawn after BAY/LEVEL and tint the racks.
  const TIER_ORDER: Record<SegmentType, number> = { AISLE: 0, SPACE: 0, BAY: 1, LEVEL: 2, BLOCK: 0, LANE: 0 };

  // Tier opacities while walking inside an aisle: aisle volume nearly gone,
  // bays/levels stronger for spatial orientation, spaces invisible (still
  // hoverable via raycast).
  const WALK_OPACITY: Record<SegmentType, number> = { AISLE: 0.04, BAY: 0.25, LEVEL: 0.55, SPACE: 0, BLOCK: 0.04, LANE: 0 };

  // Stock hover: a modern sky-blue accent — distinct from the blue UI chrome and
  // the yellow find boxes, and a clean contrast against the orange stock. A
  // translucent fill reads as a soft glow rather than a solid block, with a crisp
  // outline on top. Both fade in/out (see HOVER_FADE_* and updateHighlightFade).
  const SPACE_HOVER_COLOR        = 0x38bdf8;
  const SPACE_HOVER_FILL_OPACITY = 0.40;
  const SPACE_HOVER_EDGE_OPACITY = 0.95;
  const HOVER_FADE_IN  = 0.12; // seconds to fade a highlight in
  const HOVER_FADE_OUT = 0.20; // seconds to fade a highlight out

  // Search-hit marker: a vivid violet beacon. It pops against both the warm tan
  // stock and the cool blue racks (and is distinct from the sky-blue hover, the
  // green status chip and the red schematic tier), so a found location reads
  // instantly in a presentation. FIND_EDGE is a lighter violet for the outline.
  const FIND_COLOR = 0xa855f7;
  const FIND_EDGE  = 0xd8b4fe;

  // Find/search: only the 3D side lives here now (highlight boxes + camera
  // fly-to). The search input, suggestions and status UI live in the App header
  // and drive this via the exported findLocation()/clearFind() methods.
  let findGroup: THREE.Group | null = null;
  let findMatchSegs: Segment[] = [];

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let tooltipX = 0;
  let tooltipY = 0;
  // Near the right/bottom edges the tooltip anchors to the other side of the
  // cursor so the (taller) lane/pallet card never runs off the viewport.
  let tooltipFlipX = false;
  let tooltipFlipY = false;
  // Block-stack extras on the tooltip: the lane's capacity/class summary, and the
  // individual pallet under the cursor when there is one.
  interface LaneHoverInfo {
    block: string; policy: string | null; tracked: boolean;
    pods: number; maxPods: number; deep: number; tiers: number;
    classLabel: string | null; contents: string | null; face: string | null; allocated: number;
  }
  interface PodHoverInfo {
    code: string; position: string; product: string; batches: string; cases: string;
    status: PodStatus; order: string | null;
  }
  let hoverInfo: {
    fullName: string;
    type: SegmentType;
    coords: [number, number, number];
    dims:   [number, number, number];
    lane?: LaneHoverInfo;
    pod?: PodHoverInfo;
  } | null = null;
  // Source data is millimetres; show metres (more intuitive at warehouse scale),
  // trimmed to at most 2 decimals.
  const toMetres = (mm: number) => String(Math.round(mm / 10) / 100);

  const dispatch = createEventDispatcher<{ ready: void; tour: boolean; flow: boolean; stock: boolean }>();
  let firstRendered = false; // fires `ready` once the first frame is on screen

  let scene: THREE.Scene;
  let perspectiveCamera: THREE.PerspectiveCamera;
  let renderer: THREE.WebGLRenderer;
  let resizeObserver: ResizeObserver | null = null;
  let controls: OrbitControls;
  let raycaster: THREE.Raycaster;
  let pointer: THREE.Vector2;
  let rafId = 0;

  let rail: RailControls;
  let tour: TourController;
  let tourActive = false;
  let tourPaused = false; // tour running but frozen in place; resumes from here
  // Playback speed for the virtual tour: scales the time-step fed to the tour so
  // travel, dwells and head-turns all slow down / speed up together. 1 = current.
  const TOUR_SPEEDS = [0.25, 0.5, 1, 1.25, 1.5, 2];
  let tourSpeed = 1;
  let tourSpeedOpen = false; // speed-picker popover
  let tourEntering = false;  // mid cinematic fly-in from the overview into aisle 1
  let clock: THREE.Clock;
  let mode: 'orbit' | 'walk' = 'orbit';
  let aisleLabel = '';
  let aisleZones = ''; // block-stack drive aisle: the zones on its two sides
  let aisleIndex = 0;
  let aisleTotal = 0;
  let aislePickerOpen = false;

  const containerGroups = new Map<SegmentType, THREE.Group>();
  const tierInstancedMeshes = new Map<SegmentType, THREE.InstancedMesh>();
  const tierEdgeMeshes = new Map<SegmentType, THREE.LineSegments>();
  let spaceSegments: Segment[] = [];
  // Block-stack lanes (hoverable like spaces), the demo pallets standing in them,
  // and the built pallet meshes (shown/hidden with the demo stock).
  let laneSegments: Segment[] = [];
  const laneByName = new Map<string, Segment>();
  let laneStock = new Map<string, LaneStock>();
  let blockStock: BlockStackStock | null = null;
  let rackTopY = 0; // tallest segment top (world Y), for arcing flights over the racks
  let highlightGroup: THREE.Group | null = null;
  let highlightedKey: string | null = null; // what the current highlight is for (segment or pallet)
  // Highlights mid fade-out: kept alive each frame until their opacity hits 0,
  // then removed + disposed. Enables a smooth cross-fade between hovered items.
  let fadingHighlights: THREE.Group[] = [];
  // Tour showcase: the whole rack LEVEL (shelf) currently being inspected, plus
  // the list of storage locations on it for the floating panel.
  let tourLevel: string | null = null;
  // Block-stack drive aisles (floorStorage AISLE segments): the tour starts in them.
  const driveAisleNames = new Set<string>();
  let tourLevelInfo: { level: string; levelSeg: Segment; spaces: Segment[] } | null = null;
  // Block-stack showcase: the level of the faced three lanes the tour is looking at,
  // with the pallets standing on it — the drive-aisle counterpart of the level panel.
  interface StackLevelInfo {
    block: string; lanes: string[]; level: number; tiers: number; elevation: number;
    policy: string | null; layout: string;
    pods: { lane: string; code: string; product: string; batch: string; cases: number; status: PodStatus; order: string | null }[];
  }
  let tourStackInfo: StackLevelInfo | null = null;
  // Indices for resolving a space → its level + sibling locations, and a bay → its
  // shelves (bottom-to-top) for the tour's per-level inspection.
  const levelByName = new Map<string, Segment>();
  const spacesByLevel = new Map<string, Segment[]>();
  const levelsByBay = new Map<string, Segment[]>();
  const levelNameOf = (spaceName: string) => spaceName.replace(/\d+$/, ''); // "A25C03" → "A25C"
  const bayNameOf = (levelName: string) => levelName.replace(/[A-Za-z]+$/, ''); // "A25C" → "A25"
  const aisleLetterOf = (name: string) => (name.match(/^[A-Za-z]+/)?.[0] ?? name).toUpperCase();
  // Bay centre X positions per aisle letter — used to snap tour stops onto a bay.
  const bayXsByAisle = new Map<string, number[]>();
  let realisticDisposers: Array<() => void> = [];
  let goodsHandle: { group: THREE.Group; dispose: () => void } | null = null;
  let goodsEnv: THREE.Texture | null = null; // PMREM env map for realistic goods reflections
  // Pod-label preview: clicking an occupied demo pallet renders its ZPL label.
  // `loading` while Labelary renders; then `url` (a PNG object URL) or `error`.
  let podLabel: { name: string; data: PodData; loading: boolean; url: string | null; error: boolean } | null = null;
  let shellBounds: ShellBounds | null = null;
  // Building shell (controlled from the App header). When off, the roof deck,
  // walls, steel columns/rafters and hanging lights all hide together and the
  // ceiling cage lifts so the camera can pull back for a full open overview.
  let roofMesh: THREE.Mesh | null = null;
  let roofExtras: THREE.Object3D[] = [];

  // Arrow-key navigation in orbit mode: ↑/↓ glide forward/back along the view,
  // ←/→ strafe across the floor. Walk mode handles arrows via RailControls, so
  // these are only read while mode === 'orbit'. Held state is sampled per frame
  // in animate() for smooth, frame-rate-independent panning.
  const orbitKeys = { fwd: false, back: false, left: false, right: false };
  const _panFwd = new THREE.Vector3();
  const _panRight = new THREE.Vector3();

  // The rack rows are always spread apart slightly along the depth axis so the
  // tall, narrow canyons (esp. the 2.05m C/D/E aisles) read as more open,
  // walkable lanes. Rack height is kept true; only the across-aisle depth is
  // stretched (which also deepens the racks a little). Real coordinates and the
  // hover tooltip stay exact — this only affects how the model is drawn.
  let worldGroup: THREE.Group;
  const vScale: number = 1;     // vertical (height) scale — true height
  const hScale: number = 1.5;  // depth scale (across-aisle Z) — widens walkways

  // Clickable floor arrows at each aisle mouth: hover highlights, click drops
  // into walk mode for that aisle.
  let arrowGroup: THREE.Group | null = null;
  const arrowMeshes: THREE.Mesh[] = [];
  let hoveredArrow: THREE.Mesh | null = null;
  let arrowDispose: () => void = () => {};
  let pointerDownX = 0;
  let pointerDownY = 0;
  const ARROW_COLOR = 0x2563eb;
  const ARROW_HOVER = 0x60a5fa;

  function makeContainerMesh(seg: Segment): THREE.Group {
    const group = new THREE.Group();
    const geom = new THREE.BoxGeometry(seg.dimensionX, seg.dimensionZ, seg.dimensionY);
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_MAP[seg.type],
      transparent: true,
      opacity: OPACITY_MAP[seg.type],
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(
      seg.coordinateX + seg.dimensionX / 2,
      seg.coordinateZ + seg.dimensionZ / 2,
      seg.coordinateY + seg.dimensionY / 2,
    );
    mesh.raycast = () => {};
    group.add(mesh);

    const edgeGeom = new THREE.EdgesGeometry(geom);
    const edgeMat = new THREE.LineBasicMaterial({ color: COLOR_MAP[seg.type] });
    const edges = new THREE.LineSegments(edgeGeom, edgeMat);
    edges.position.copy(mesh.position);
    edges.scale.set(1.001, 1.001, 1.001);
    group.add(edges);

    return group;
  }

  // Build one InstancedMesh that draws every segment of a tier in a single draw call.
  function buildTierInstancedMesh(list: Segment[], type: SegmentType): THREE.InstancedMesh {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_MAP[type],
      transparent: true,
      opacity: OPACITY_MAP[type],
      depthWrite: false,
    });
    const inst = new THREE.InstancedMesh(geom, mat, list.length);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      dummy.position.set(
        s.coordinateX + s.dimensionX / 2,
        s.coordinateZ + s.dimensionZ / 2,
        s.coordinateY + s.dimensionY / 2,
      );
      dummy.scale.set(s.dimensionX, s.dimensionZ, s.dimensionY);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.computeBoundingBox();
    // Containers (BAY/LEVEL) shouldn't intercept pointer events; only the leaf
    // tiers (SPACE bins, block-stack LANEs) do.
    if (type !== 'SPACE' && type !== 'LANE') inst.raycast = () => {};
    return inst;
  }

  // Build a single LineSegments containing every cube's 12 edges (pre-transformed),
  // so one draw call covers all edge outlines for the tier.
  function buildTierEdgeMesh(list: Segment[], type: SegmentType): THREE.LineSegments {
    // 12 edges × 2 endpoints = 24 vertices per cube
    const unitEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const unitPositions = unitEdges.getAttribute('position') as THREE.BufferAttribute;
    const vertsPerCube = unitPositions.count;
    const allPositions = new Float32Array(list.length * vertsPerCube * 3);

    const v = new THREE.Vector3();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const cx = s.coordinateX + s.dimensionX / 2;
      const cy = s.coordinateZ + s.dimensionZ / 2;
      const cz = s.coordinateY + s.dimensionY / 2;
      const sx = s.dimensionX;
      const sy = s.dimensionZ;
      const sz = s.dimensionY;
      const offset = i * vertsPerCube * 3;
      for (let j = 0; j < vertsPerCube; j++) {
        v.fromBufferAttribute(unitPositions, j);
        allPositions[offset + j * 3 + 0] = v.x * sx + cx;
        allPositions[offset + j * 3 + 1] = v.y * sy + cy;
        allPositions[offset + j * 3 + 2] = v.z * sz + cz;
      }
    }
    unitEdges.dispose();

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(allPositions, 3));
    geom.computeBoundingSphere();
    geom.computeBoundingBox();

    const mat = new THREE.LineBasicMaterial({ color: COLOR_MAP[type] });
    const lines = new THREE.LineSegments(geom, mat);
    lines.raycast = () => {};
    return lines;
  }

  // outlineOnly: used when the segment is already shown as a yellow find match —
  // the red fill would fight with the yellow box, so only the wireframe is drawn.
  function makeHighlightGroup(seg: Segment, outlineOnly = false): THREE.Group {
    const group = new THREE.Group();
    const geom = new THREE.BoxGeometry(seg.dimensionX, seg.dimensionZ, seg.dimensionY);
    const center = new THREE.Vector3(
      seg.coordinateX + seg.dimensionX / 2,
      seg.coordinateZ + seg.dimensionZ / 2,
      seg.coordinateY + seg.dimensionY / 2,
    );

    // Overview: keep the highlight see-through (depthTest off) so a hovered
    // space stays visible through the front racks. Walkthrough: the camera is
    // inside the aisle, where a see-through box paints the whole red volume over
    // the rack frame in front of it and spills into the walkway ("displays out").
    // There, depth-test it so the structure ahead occludes it and it reads as
    // sitting in its slot; the polygon offset keeps the front face from
    // z-fighting the coplanar rack front.
    const seeThrough = mode !== 'walk';

    if (!outlineOnly) {
      const mat = new THREE.MeshStandardMaterial({
        color: SPACE_HOVER_COLOR,
        emissive: SPACE_HOVER_COLOR, // gentle self-lit glow so it reads at any angle
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: SPACE_HOVER_FILL_OPACITY,
        depthWrite: false,
        depthTest: !seeThrough,
        polygonOffset: !seeThrough,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      mat.userData.baseOpacity = SPACE_HOVER_FILL_OPACITY;
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.copy(center);
      mesh.renderOrder = 5; // above the tier boxes (0–2)
      mesh.raycast = () => {};
      group.add(mesh);
    }

    const edgeGeom = new THREE.EdgesGeometry(geom);
    const edgeMat = new THREE.LineBasicMaterial({
      color: SPACE_HOVER_COLOR, transparent: true, opacity: SPACE_HOVER_EDGE_OPACITY,
      depthTest: !seeThrough,
      polygonOffset: !seeThrough, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    edgeMat.userData.baseOpacity = SPACE_HOVER_EDGE_OPACITY;
    const edges = new THREE.LineSegments(edgeGeom, edgeMat);
    edges.position.copy(center);
    // Outline-only sits on top of the find box (scale 1.02), so push it out
    // a bit further to stay visible.
    const s = outlineOnly ? 1.04 : 1.001;
    edges.scale.set(s, s, s);
    edges.renderOrder = outlineOnly ? 7 : 5; // above find boxes (6) / tier boxes (0–2)
    group.add(edges);

    return group;
  }

  // True when the segment sits inside (or is) one of the yellow find boxes —
  // there the red hover fill would fight with the yellow, so only the
  // wireframe outline is drawn.
  function isInsideFind(seg: Segment): boolean {
    if (findMatchSegs.length === 0) return false;
    const cx = seg.coordinateX + seg.dimensionX / 2;
    const cy = seg.coordinateY + seg.dimensionY / 2;
    const cz = seg.coordinateZ + seg.dimensionZ / 2;
    return findMatchSegs.some((m) =>
      cx >= m.coordinateX && cx <= m.coordinateX + m.dimensionX &&
      cy >= m.coordinateY && cy <= m.coordinateY + m.dimensionY &&
      cz >= m.coordinateZ && cz <= m.coordinateZ + m.dimensionZ,
    );
  }

  // Exported: the App-header search clears its highlight through here.
  export function clearFind() {
    findMatchSegs = [];
    if (!findGroup) return;
    worldGroup.remove(findGroup);
    findGroup.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        Array.isArray(m) ? m.forEach((x) => x.dispose()) : m.dispose();
      }
    });
    findGroup = null;
  }

  function makeFindBox(seg: Segment): THREE.Group {
    const g = new THREE.Group();
    const geom = new THREE.BoxGeometry(seg.dimensionX, seg.dimensionZ, seg.dimensionY);
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        // A glowing, translucent fill rather than a heavy opaque block, so the
        // marked stock still shows through. depthTest ON so the structure in
        // front occludes it — it reads as sitting INSIDE its slot and stays
        // anchored there as the view orbits (depthTest off made it draw over
        // everything, so it looked like it floated in the aisle). polygonOffset
        // keeps the front face off the coplanar rack/stock face (no z-fighting).
        color: FIND_COLOR, emissive: FIND_COLOR, emissiveIntensity: 0.45,
        transparent: true, opacity: 0.5,
        depthWrite: false, depthTest: true, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      }),
    );
    mesh.position.set(
      seg.coordinateX + seg.dimensionX / 2,
      seg.coordinateZ + seg.dimensionZ / 2,
      seg.coordinateY + seg.dimensionY / 2,
    );
    mesh.renderOrder = 6; // above hover (5)
    mesh.raycast = () => {};
    g.add(mesh);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geom),
      new THREE.LineBasicMaterial({
        color: FIND_EDGE, transparent: true, depthTest: true,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      }),
    );
    edges.position.copy(mesh.position);
    edges.scale.set(1.02, 1.02, 1.02);
    edges.renderOrder = 6;
    g.add(edges);
    return g;
  }

  // Never frame closer than this (mm) — keeps the camera outside the rack even
  // when the framed box itself is a single small leaf segment, while landing
  // near enough that the found space fills a good part of the screen.
  const FIND_MIN_DIST = 6000;

  // Leaf segments (LEVEL/SPACE) are small boxes deep inside the rack; framing
  // them directly puts the camera inside the bay. Widen the framing box to the
  // containing BAY so a nested match gets the same overview a bay search does.
  function widenToBayContext(matches: Segment[], box: THREE.Box3): THREE.Box3 {
    const out = box.clone();
    if (matches.length > 50) return out; // many matches ⇒ box is already wide
    const bays = segments.filter((s) => s.type === 'BAY');
    for (const seg of matches) {
      if (seg.type !== 'LEVEL' && seg.type !== 'SPACE') continue;
      const cx = seg.coordinateX + seg.dimensionX / 2;
      const cy = seg.coordinateY + seg.dimensionY / 2;
      const cz = seg.coordinateZ + seg.dimensionZ / 2;
      const bay = bays.find((b) =>
        cx >= b.coordinateX && cx <= b.coordinateX + b.dimensionX &&
        cy >= b.coordinateY && cy <= b.coordinateY + b.dimensionY &&
        cz >= b.coordinateZ && cz <= b.coordinateZ + b.dimensionZ,
      );
      if (!bay) continue;
      out.expandByPoint(new THREE.Vector3(bay.coordinateX, bay.coordinateZ, bay.coordinateY));
      out.expandByPoint(new THREE.Vector3(
        bay.coordinateX + bay.dimensionX,
        bay.coordinateZ + bay.dimensionZ,
        bay.coordinateY + bay.dimensionY,
      ));
    }
    return out;
  }

  // In-flight camera animation toward a find result. Stepped each frame in
  // animate(); cancelled when the user grabs the controls or enters walk mode.
  // bow > 0 arcs the flight up and over the racks instead of cutting through.
  let camTween: {
    fromPos: THREE.Vector3; fromTarget: THREE.Vector3;
    toPos: THREE.Vector3; toTarget: THREE.Vector3;
    start: number; duration: number; bow: number;
    fromFov?: number; toFov?: number;  // optional fov ease (overview → walk)
    onDone?: () => void;               // fired once the flight completes
  } | null = null;

  const easeInOutCubic = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  function stepCamTween() {
    if (!camTween) return;
    const t = Math.min((performance.now() - camTween.start) / camTween.duration, 1);
    const e = easeInOutCubic(t);
    perspectiveCamera.position.lerpVectors(camTween.fromPos, camTween.toPos, e);
    perspectiveCamera.position.y += camTween.bow * Math.sin(Math.PI * e);
    controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, e);
    if (camTween.fromFov !== undefined && camTween.toFov !== undefined) {
      perspectiveCamera.fov = camTween.fromFov + (camTween.toFov - camTween.fromFov) * e;
      perspectiveCamera.updateProjectionMatrix();
    }
    if (t >= 1) {
      const done = camTween.onDone;
      camTween = null;
      done?.();
    }
  }

  // Straight flight path blocked by a rack? The SPACE instances fill every
  // rack volume, so one ray along the path is a cheap obstruction test
  // (raycast ignores visibility, so this works with the SPACE tier toggled off).
  function flightIsBlocked(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const spaceInst = tierInstancedMeshes.get('SPACE');
    if (!spaceInst) return false;
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1) return false;
    dir.normalize();
    raycaster.set(from, dir);
    raycaster.far = len;
    const blocked = raycaster.intersectObject(spaceInst, false).length > 0;
    raycaster.far = Infinity;
    return blocked;
  }

  function frameBox(box: THREE.Box3) {
    // Boxes are built from raw coords; bring their Y (height) and Z (depth)
    // into the possibly-scaled world before framing.
    if (vScale !== 1) { box.min.y *= vScale; box.max.y *= vScale; }
    if (hScale !== 1) { box.min.z *= hScale; box.max.z *= hScale; }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const fov = (perspectiveCamera.fov * Math.PI) / 180;
    let dist = (maxDim / 2) / Math.tan(fov / 2) * 2.5; // 2.5 = padding
    dist = Math.max(orbit.minDistance * 1.1, FIND_MIN_DIST, Math.min(orbit.maxDistance * 0.9, dist));

    const dir = new THREE.Vector3().subVectors(perspectiveCamera.position, controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.6, 0.5, 0.8);
    dir.normalize();

    const fromPos = perspectiveCamera.position.clone();
    const toPos = center.clone().addScaledVector(dir, dist);

    // If a rack sits between here and there, bow the path so the flight
    // crests just above the tallest rack instead of clipping through.
    let bow = 0;
    if (flightIsBlocked(fromPos, toPos)) {
      bow = Math.max(0, rackTopY * vScale + 3000 - (fromPos.y + toPos.y) / 2);
    }

    camTween = {
      fromPos,
      fromTarget: controls.target.clone(),
      toPos,
      toTarget: center.clone(),
      start: performance.now(),
      duration: bow > 0 ? 1200 : 850, // the over-the-top arc gets a bit more air time
      bow,
    };
  }

  // Exported: the App-header search calls this to fly to a location and draw the
  // yellow match boxes. Returns a status the header shows to the user.
  export function findLocation(query: string): { ok: boolean; message: string } {
    clearFind();
    const q = query.trim().toUpperCase();
    if (!q) return { ok: true, message: '' };
    if (mode === 'walk') exitWalk(); // searching is an overview action; pop out to orbit

    const exact = segments.filter((s) => s.fullName.toUpperCase() === q);
    const matches = exact.length ? exact : segments.filter((s) => s.fullName.toUpperCase().startsWith(q));

    if (matches.length === 0) return { ok: false, message: `"${query.trim()}" not found` };

    findGroup = new THREE.Group();
    const box = new THREE.Box3();
    for (const seg of matches) {
      findGroup.add(makeFindBox(seg));
      box.expandByPoint(new THREE.Vector3(seg.coordinateX, seg.coordinateZ, seg.coordinateY));
      box.expandByPoint(new THREE.Vector3(
        seg.coordinateX + seg.dimensionX,
        seg.coordinateZ + seg.dimensionZ,
        seg.coordinateY + seg.dimensionY,
      ));
    }
    worldGroup.add(findGroup);
    findMatchSegs = matches;
    frameBox(widenToBayContext(matches, box));
    return {
      ok: true,
      message: matches.length === 1 ? `Found ${matches[0].fullName}` : `Found ${matches.length} matches`,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Block-stack flow (FLD-69 walk-through). The engine in blockStackFlow.ts owns
  // the story and the stock mutations; this is its 3D host: glow boxes in data
  // coords, camera framing and the truck chase, the forklift and the pallet on
  // its forks, and stock rebuilds after a putaway or pick.
  // ────────────────────────────────────────────────────────────────────────────
  let flow: BlockStackFlow | null = null;
  let truck: ForkliftHandle | null = null;
  let driver: ForkliftDriver | null = null;
  let carried: { group: THREE.Group; dispose: () => void } | null = null;
  const flowGlows = new Map<string, THREE.Group>();
  let flowPulse = 0;
  const _truckPrev = new THREE.Vector3();
  const _carry = new THREE.Vector3();
  // While the truck works a lane, the camera is kept inside this drive aisle's
  // world-Z band so neither the chase nor the user's orbit ends up inside a bank
  // of stacks. Cleared by any non-aisle framing and when the flow closes.
  let chaseClamp: { zMin: number; zMax: number } | null = null;
  let lastChaseAisle: Segment | null = null; // the drive aisle the truck is working
  // Keep the App header button in step with the panel.
  $: dispatch('flow', $flowState.active);
  $: if (!$flowState.active) chaseClamp = null;
  function aisleBand(aisle: Segment): { zMin: number; zMax: number } {
    const pad = 1800;
    return { zMin: aisle.coordinateY * hScale + pad, zMax: (aisle.coordinateY + aisle.dimensionY) * hScale - pad };
  }

  function ensureTruck(): ForkliftDriver {
    if (!truck || !driver) {
      truck = buildForklift();
      truck.group.visible = false;
      scene.add(truck.group);
      driver = new ForkliftDriver(truck, hScale);
    }
    return driver;
  }

  // A glowing box round a pallet or lane (data coords, lives in worldGroup).
  // Depth-tested with a polygon offset so it hugs its object rather than painting
  // over the aisle; the pulse flag lets updateFlow breathe its opacity.
  function makeGlowBox(box: PodBox, color: number, fill: number, edge: number, pad = 30): THREE.Group {
    const g = new THREE.Group();
    const geom = new THREE.BoxGeometry(box.x1 - box.x0 + pad * 2, box.z1 - box.z0 + pad * 2, box.y1 - box.y0 + pad * 2);
    const center = new THREE.Vector3((box.x0 + box.x1) / 2, (box.z0 + box.z1) / 2, (box.y0 + box.y1) / 2);
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.5, transparent: true, opacity: fill,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    mat.userData.baseOpacity = fill;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(center);
    mesh.renderOrder = 6;
    mesh.raycast = () => {};
    g.add(mesh);
    const edgeMat = new THREE.LineBasicMaterial({
      color, transparent: true, opacity: edge, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    edgeMat.userData.baseOpacity = edge;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), edgeMat);
    edges.position.copy(center);
    edges.scale.setScalar(1.01);
    edges.renderOrder = 6;
    g.add(edges);
    g.userData.fade = 1;
    return g;
  }
  function dropGlow(key: string) {
    const g = flowGlows.get(key);
    if (!g) return;
    flowGlows.delete(key);
    disposeHighlightGroup(g);
  }

  // The cage animate() applies every frame, applied once to a flight's end point too, so a
  // flight never fights it mid-air (an end point outside the shell stalled the camera on the roof).
  function cageClampPos(p: THREE.Vector3): THREE.Vector3 {
    if (p.y < floorY) p.y = floorY;
    if (shellBounds && showShell) {
      const PAD = 1500;
      p.x = Math.min(Math.max(p.x, shellBounds.minX + PAD), shellBounds.maxX - PAD);
      p.y = Math.min(p.y, shellBounds.eaveH * vScale - 800);
      p.z = Math.min(Math.max(p.z, shellBounds.minZ * hScale + PAD), shellBounds.maxZ * hScale - PAD);
    }
    return p;
  }
  function cageClampTarget(t: THREE.Vector3): THREE.Vector3 {
    if (shellBounds && showShell) {
      const PAD = 1500;
      t.x = Math.min(Math.max(t.x, shellBounds.minX + PAD), shellBounds.maxX - PAD);
      t.z = Math.min(Math.max(t.z, shellBounds.minZ * hScale + PAD), shellBounds.maxZ * hScale - PAD);
    }
    return t;
  }

  // Frame a set of data-space boxes: fly the orbit camera to look at their centre
  // from the given direction, far enough back to fit them.
  function focusBoxes(boxes: PodBox[], opts: { dist?: number; dir?: [number, number, number]; duration?: number; aisle?: Segment } = {}) {
    if (!boxes.length || mode !== 'orbit') return;
    chaseClamp = opts.aisle ? aisleBand(opts.aisle) : null;
    const bb = new THREE.Box3();
    for (const b of boxes) {
      bb.expandByPoint(new THREE.Vector3(b.x0, b.z0 * vScale, b.y0 * hScale));
      bb.expandByPoint(new THREE.Vector3(b.x1, b.z1 * vScale, b.y1 * hScale));
    }
    const center = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const fov = (perspectiveCamera.fov * Math.PI) / 180;
    const dist = opts.dist ?? Math.max(FIND_MIN_DIST, ((maxDim / 2) / Math.tan(fov / 2)) * 1.35);
    const dir = new THREE.Vector3(...(opts.dir ?? [-0.45, 0.55, 0.7])).normalize();
    const toPos = center.clone().addScaledVector(dir, dist);
    if (chaseClamp) toPos.z = Math.min(Math.max(toPos.z, chaseClamp.zMin), chaseClamp.zMax);
    cageClampPos(toPos);
    cageClampTarget(center);
    // A long flight gets more time (60 m/s), so a hop across the floor never whips the view.
    const flight = toPos.distanceTo(perspectiveCamera.position);
    camTween = {
      fromPos: perspectiveCamera.position.clone(), fromTarget: controls.target.clone(),
      toPos, toTarget: center,
      start: performance.now(), duration: Math.max(opts.duration ?? 1300, Math.min(2600, flight / 60)), bow: 0,
    };
  }

  // Fly to a chase position on the truck: behind and a little to its right while
  // it drives along an aisle; when it has turned to face a lane, a three-quarter
  // view from the aisle side so the forks and the pallet stay in shot. With an
  // aisle given, the camera is kept inside that aisle's band.
  function flyToChase(duration = 900, aisle?: Segment) {
    if (aisle) lastChaseAisle = aisle;
    if (!truck || mode !== 'orbit' || !$flowState.follow) return;
    chaseClamp = aisle ? aisleBand(aisle) : null;
    const p = truck.group.position;
    const h = new THREE.Vector3(Math.cos(truck.group.rotation.y), 0, -Math.sin(truck.group.rotation.y));
    const right = new THREE.Vector3(-h.z, 0, h.x);
    const acrossAisle = Math.abs(h.z) > 0.7;
    const toPos = acrossAisle
      ? p.clone().add(new THREE.Vector3(-6500, 5200, 0)).addScaledVector(h, -3200)
      : p.clone().addScaledVector(h, -9500).addScaledVector(right, 2500).add(new THREE.Vector3(0, 5800, 0));
    if (chaseClamp) toPos.z = Math.min(Math.max(toPos.z, chaseClamp.zMin), chaseClamp.zMax);
    cageClampPos(toPos);
    const toTarget = cageClampTarget(p.clone().addScaledVector(h, acrossAisle ? 1800 : 2500).setY(1400));
    camTween = {
      fromPos: perspectiveCamera.position.clone(), fromTarget: controls.target.clone(),
      toPos, toTarget, start: performance.now(), duration, bow: 0,
    };
  }

  function rebuildBlockStock() {
    if (blockStock) {
      worldGroup.remove(blockStock.group);
      blockStock.dispose();
      blockStock = null;
    }
    if (laneSegments.length === 0) return;
    blockStock = buildBlockStackStock(laneSegments, laneStock, { y: vScale, z: hScale }, goodsEnv);
    blockStock.group.visible = showStock;
    worldGroup.add(blockStock.group);
  }

  const flowHost: FlowHost = {
    laneStock: () => laneStock,
    segment: (name) => laneByName.get(name) ?? segments.find((s) => s.fullName === name),
    hasStock: () => !!blockStock,
    requireStock() { if (!showStock) dispatch('stock', true); },
    glow(key, box, color, fill, edge, pulse = false) {
      dropGlow(key);
      const g = makeGlowBox(box, color, fill, edge);
      g.userData.pulse = pulse;
      worldGroup.add(g);
      flowGlows.set(key, g);
    },
    clearGlows(prefix) {
      for (const k of [...flowGlows.keys()]) if (!prefix || k.startsWith(prefix)) dropGlow(k);
    },
    focus: focusBoxes,
    chase: flyToChase,
    ensureTruck,
    truckVisible(v) { ensureTruck(); truck!.group.visible = v; },
    carry(pod) {
      if (carried) { carried.group.parent?.remove(carried.group); carried.dispose(); carried = null; }
      if (pod) { ensureTruck(); carried = makeCarriedPallet(pod, hScale, goodsEnv); truck!.carriage.add(carried.group); }
    },
    hidePod(pod) {
      const i = blockStock?.pods.indexOf(pod) ?? -1;
      if (i >= 0) blockStock!.hidePod(i);
    },
    rebuildStock: rebuildBlockStock,
    resetStock() { laneStock = buildDemoLaneStock(laneSegments); rebuildBlockStock(); },
  };

  // Picker's view: drop the walkthrough camera onto the drive aisle beside the
  // truck, at eye height, looking at the lane it faces (the rail keeps the camera
  // in the aisle; drag to look, W/S to walk). Toggling back returns to the chase.
  function togglePickerView() {
    if (mode === 'walk') {
      exitWalk(true);
      flyToChase(900, lastChaseAisle ?? undefined);
      return;
    }
    if (!truck || !truck.group.visible || !rail) return;
    const idx = rail.aisleNames.indexOf(lastChaseAisle?.fullName ?? 'BS3');
    if (idx < 0) return;
    enterWalk(idx);
    const a = rail.aisles[idx];
    const along = truck.group.position.clone().sub(a.start).dot(a.dir);
    const h = new THREE.Vector3(Math.cos(truck.group.rotation.y), 0, -Math.sin(truck.group.rotation.y));
    const dist = Math.max(0, Math.min(a.length, along - 2500));
    // Look at the spot just ahead of the forks, so the truck and the lane it works share the frame.
    const look = truck.group.position.clone().addScaledVector(h, 2500).sub(a.start.clone().addScaledVector(a.dir, dist));
    rail.setPose({ dist, yaw: Math.atan2(-look.x, -look.z), pitch: 0.12, height: 1700 });
  }

  // Exported for the App-header button: open the walk-through (from the overview;
  // a walk or tour is ended first) or close it.
  export function toggleFlow() {
    if (!flow) flow = new BlockStackFlow(flowHost);
    if (flow.active) { flow.stop(); return; }
    if (tourActive) stopTour();
    if (mode === 'walk') exitWalk(true);
    flow.start();
  }

  // Per frame: drive the truck, carry the orbit rig along with it (the user can
  // still orbit; only the displacement is added), and breathe the pulsing glows.
  function updateFlow(dt: number) {
    if (driver && truck && truck.group.visible && !$flowState.paused) {
      _truckPrev.copy(truck.group.position);
      driver.update(dt * $flowState.speed);
      if ($flowState.follow && !camTween && mode === 'orbit') {
        _carry.copy(truck.group.position).sub(_truckPrev);
        if (_carry.lengthSq() > 0) { perspectiveCamera.position.add(_carry); controls.target.add(_carry); }
      }
      if (chaseClamp && !camTween && mode === 'orbit') {
        const p = perspectiveCamera.position;
        p.z = Math.min(Math.max(p.z, chaseClamp.zMin), chaseClamp.zMax);
      }
    }
    if (flowGlows.size) {
      flowPulse += dt;
      const k = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(flowPulse * 4.5));
      for (const g of flowGlows.values()) if (g.userData.pulse) applyHighlightFade(g, k);
    }
  }

  // Esc closes the aisle picker first, then exits walk mode. Arrow keys drive
  // the orbit camera. ("/" to focus search is handled in the App header now.)
  function onWindowKeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === 'Escape') {
      if (podLabel) closePodLabel(); // close the pod label first
      else if (aislePickerOpen) aislePickerOpen = false;
      else if (mode === 'walk') exitOneLevel(); // tour → walkway → overview, one step
    } else if (e.code === 'Space' && mode === 'walk' && tourActive) {
      toggleTourPause(); // spacebar = hold / continue the tour (handy for a live demo)
      e.preventDefault();
    } else if (e.code === 'Space' && flow?.active && $flowState.busy) {
      flow.togglePause(); // spacebar freezes / releases the forklift mid-drive
      e.preventDefault();
    } else if (mode === 'orbit') {
      switch (e.code) {
        case 'ArrowUp':    orbitKeys.fwd = true; break;
        case 'ArrowDown':  orbitKeys.back = true; break;
        case 'ArrowLeft':  orbitKeys.left = true; break;
        case 'ArrowRight': orbitKeys.right = true; break;
        default: return;
      }
      camTween = null; // grabbing the keys cancels any in-flight search tween
      clearHighlight(); // navigating with the keys drops the cursor hover
      e.preventDefault();
    }
  }

  function onWindowKeyup(e: KeyboardEvent) {
    switch (e.code) {
      case 'ArrowUp':    orbitKeys.fwd = false; break;
      case 'ArrowDown':  orbitKeys.back = false; break;
      case 'ArrowLeft':  orbitKeys.left = false; break;
      case 'ArrowRight': orbitKeys.right = false; break;
    }
  }

  // Pan camera + orbit target together across the floor so the view direction
  // is preserved; the shell clamp in animate() keeps both inside the building.
  function applyOrbitPan(dt: number) {
    let f = 0;
    let s = 0;
    if (orbitKeys.fwd) f += 1;
    if (orbitKeys.back) f -= 1;
    if (orbitKeys.right) s += 1;
    if (orbitKeys.left) s -= 1;
    if (f === 0 && s === 0) return;

    _panFwd.subVectors(controls.target, perspectiveCamera.position);
    _panFwd.y = 0;
    if (_panFwd.lengthSq() < 1e-6) _panFwd.set(0, 0, -1);
    _panFwd.normalize();
    _panRight.set(-_panFwd.z, 0, _panFwd.x); // screen-right on the floor plane

    // Distance-scaled speed: feels consistent whether zoomed in on one bay or
    // pulled back across the warehouse.
    const dist = perspectiveCamera.position.distanceTo(controls.target);
    const step = Math.min(Math.max(dist * 0.9, 4000), 60000) * dt;
    const dx = (_panFwd.x * f + _panRight.x * s) * step;
    const dz = (_panFwd.z * f + _panRight.z * s) * step;
    perspectiveCamera.position.x += dx;
    perspectiveCamera.position.z += dz;
    controls.target.x += dx;
    controls.target.z += dz;
  }

  function disposeHighlightGroup(group: THREE.Group) {
    worldGroup.remove(group);
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        const mt = obj.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mt)) mt.forEach((m) => m.dispose());
        else mt.dispose();
      }
    });
  }

  // Scale every tagged material's opacity by f (0–1) so the whole group fades as
  // one. Stored baseOpacity keeps the fill/outline at their distinct strengths.
  function applyHighlightFade(group: THREE.Group, f: number) {
    group.userData.fade = f;
    group.traverse((obj) => {
      const mat = (obj as THREE.Mesh | THREE.LineSegments).material as THREE.Material | undefined;
      const base = mat?.userData?.baseOpacity;
      if (mat && base !== undefined) mat.opacity = base * f;
    });
  }

  // Send the current highlight into a fade-out instead of removing it instantly,
  // so it dissolves smoothly (and cross-fades with whatever comes next).
  function clearHighlight() {
    if (highlightGroup) {
      fadingHighlights.push(highlightGroup);
      highlightGroup = null;
    }
    highlightedKey = null;
    hoverInfo = null;
    tourLevel = null;
    tourLevelInfo = null;
    tourStackInfo = null;
  }

  // Block-stack showcase: the three faced lanes outlined as columns, the level
  // being looked at boxed across them, and the Block Stack Level panel listing the
  // pallets on it — the same shape as the racking's shelf showcase, no hover card.
  function applyStackLevelShowcase(laneName: string, tier: number, key: string) {
    if (key === tourLevel) return;
    const lane = laneByName.get(laneName);
    if (!lane) { clearHighlight(); return; }
    const triple = laneTriple(lane);
    const band = stackLevelBand(triple, tier);
    if (!band) { clearHighlight(); return; }
    if (highlightGroup) fadingHighlights.push(highlightGroup);
    highlightedKey = null;
    hoverInfo = null;
    tourLevel = key;
    tourLevelInfo = null;
    // One box around the pallet you can see at this level in each of the three lanes
    // (the one nearest the face; the ones behind it stay unboxed) — the same fill the
    // racking shelf gets — so nothing is ever drawn over empty air or through a stack.
    const group = new THREE.Group();
    if (band.pods.length) {
      const front = new Map<string, { lane: Segment; pod: LanePod }>();
      for (const it of band.pods) { const cur = front.get(it.lane.fullName); if (!cur || it.pod.column > cur.pod.column) front.set(it.lane.fullName, it); }
      for (const { lane: l, pod } of front.values()) group.add(makeHighlightGroup(podSegmentOf(pod, l)));
    } else {
      group.add(makeHighlightGroup({
        fullName: `${lane.fullName}:L${tier + 1}`, type: 'LANE',
        coordinateX: band.x0, coordinateY: band.y0, coordinateZ: band.z0,
        dimensionX: band.x1 - band.x0, dimensionY: band.y1 - band.y0, dimensionZ: band.z1 - band.z0,
        offsetX: 0, offsetY: 0, offsetZ: 0,
      }));
    }
    applyHighlightFade(group, 0);
    worldGroup.add(group);
    highlightGroup = group;
    const cfg = lane.lane!;
    tourStackInfo = {
      block: cfg.block,
      lanes: triple.map((l) => l.fullName),
      level: tier + 1,
      tiers: cfg.tiers,
      elevation: band.z0,
      policy: cfg.policy,
      layout: `${cfg.deep} deep × ${cfg.tiers} high`,
      pods: band.pods
        .sort((p, q) => p.lane.coordinateX - q.lane.coordinateX || p.pod.column - q.pod.column)
        .map(({ lane: l, pod: p }) => ({
          lane: l.fullName, code: p.code, product: `${p.product.code} ${p.product.name}`,
          batch: p.batches.join(' + '), cases: p.cases, status: podStatus(p), order: p.allocation ? p.allocation.order : null,
        })),
    };
  }

  // Tour showcase: highlight the whole rack LEVEL (shelf) being inspected and
  // surface every storage location on it. Deduped by level so it only rebuilds
  // (cross-fading) when the camera moves to a different shelf.
  function applyLevelShowcase(levelName: string) {
    if (levelName === tourLevel) return;
    const lvl = levelByName.get(levelName);
    if (!lvl) {
      const m = /^stack:(.+):(\d+)$/.exec(levelName);
      if (m) { applyStackLevelShowcase(m[1], Number(m[2]), levelName); return; }
      clearHighlight();
      return;
    }
    if (highlightGroup) fadingHighlights.push(highlightGroup); // cross-fade out the old shelf
    highlightedKey = null;
    hoverInfo = null;
    tourLevel = levelName;
    tourLevelInfo = { level: levelName, levelSeg: lvl, spaces: spacesByLevel.get(levelName) ?? [] };
    const group = makeHighlightGroup(lvl); // a box spanning the whole shelf
    applyHighlightFade(group, 0);          // start invisible, eases up via the fade loop
    worldGroup.add(group);
    highlightGroup = group;
  }

  // What the cursor (or the walk-mode centre ray) is over: a rack SPACE bin, a
  // block-stack LANE, or an individual pallet standing in a lane.
  type HoverTarget =
    | { kind: 'space'; seg: Segment }
    | { kind: 'lane'; seg: Segment }
    | { kind: 'pod'; seg: Segment; pod: LanePod };

  // Raycast everything hoverable from the current pointer and resolve the nearest
  // hit. A lane's box encloses its pallets, so when the nearest hit is a lane and
  // the ray goes on to strike a pallet in THAT lane, the pallet wins — the box is
  // only what you hover over the empty part of a lane. Pallets are only pickable
  // while the demo stock is shown.
  function pickHover(): HoverTarget | null {
    const spaceInst = tierInstancedMeshes.get('SPACE');
    const laneInst = tierInstancedMeshes.get('LANE');
    const podMesh = blockStock && showStock ? blockStock.podMesh : null;
    const targets: THREE.Object3D[] = [];
    if (spaceInst) targets.push(spaceInst);
    if (laneInst) targets.push(laneInst);
    if (podMesh) targets.push(podMesh);
    if (targets.length === 0) return null;
    raycaster.setFromCamera(pointer, perspectiveCamera);
    const hits = raycaster.intersectObjects(targets, false).filter((h) => h.instanceId !== undefined);
    if (hits.length === 0) return null;
    const first = hits[0];
    if (first.object === spaceInst) {
      const seg = spaceSegments[first.instanceId!];
      return seg ? { kind: 'space', seg } : null;
    }
    const podHit = podMesh ? hits.find((h) => h.object === podMesh) : undefined;
    if (first.object === laneInst) {
      const seg = laneSegments[first.instanceId!];
      if (!seg) return null;
      if (podHit && blockStock) {
        const pod = blockStock.pods[podHit.instanceId!];
        if (pod && pod.lane === seg.fullName) return { kind: 'pod', seg, pod };
      }
      return { kind: 'lane', seg };
    }
    if (podHit && blockStock) {
      const pod = blockStock.pods[podHit.instanceId!];
      const seg = pod ? laneByName.get(pod.lane) : undefined;
      if (pod && seg) return { kind: 'pod', seg, pod };
    }
    return null;
  }

  function laneInfoOf(seg: Segment): LaneHoverInfo | undefined {
    const cfg = seg.lane;
    if (!cfg) return undefined;
    const st = laneStock.get(seg.fullName);
    const pods = st?.pods ?? [];
    const face = pods.length ? pods[pods.length - 1] : null;
    return {
      block: cfg.block, policy: cfg.policy, tracked: cfg.trackStockMix,
      pods: pods.length, maxPods: cfg.maxPods, deep: cfg.deep, tiers: cfg.tiers,
      classLabel: st ? describeClass(st) : null,
      contents: st ? describeContents(st) : null,
      face: face ? face.code : null,
      allocated: pods.filter((p) => p.allocation).length,
    };
  }

  function podInfoOf(pod: LanePod, seg: Segment): PodHoverInfo {
    const cfg = seg.lane!;
    const count = laneStock.get(seg.fullName)?.pods.length ?? 0;
    return {
      code: pod.code,
      position: describePodPosition(pod, cfg, count),
      product: `${pod.product.code} ${pod.product.name}`,
      batches: pod.batches.join(' + ') + (pod.batches.length > 1 ? ' (mixed pod)' : ''),
      cases: `${pod.cases} / ${pod.product.casesPerPallet} cases`,
      status: podStatus(pod),
      order: pod.allocation ? `${pod.allocation.order} · ${pod.allocation.job} (job ${pod.allocation.jobStatus})` : null,
    };
  }

  // A pallet's footprint as a Segment-shaped box, so the highlight builder can
  // outline it inside its lane.
  function podSegmentOf(pod: LanePod, lane: Segment): Segment {
    const b = podBounds(pod, lane);
    return {
      fullName: pod.code, type: 'LANE',
      coordinateX: b.x0, coordinateY: b.y0, coordinateZ: b.z0,
      dimensionX: b.x1 - b.x0, dimensionY: b.y1 - b.y0, dimensionZ: b.z1 - b.z0,
      offsetX: 0, offsetY: 0, offsetZ: 0,
    };
  }

  function applyHighlight(target: HoverTarget) {
    const key = target.kind === 'pod' ? `pod:${target.pod.code}` : `${target.kind}:${target.seg.fullName}`;
    if (key === highlightedKey) return;
    if (highlightGroup) fadingHighlights.push(highlightGroup); // fade the previous one out
    highlightGroup = null;
    const seg = target.seg;
    highlightedKey = key;
    tourLevel = null;
    tourLevelInfo = null;
    const group = makeHighlightGroup(seg, isInsideFind(seg));
    // Hovering a pallet: glow the whole lane, and outline the pallet itself so it
    // reads which one (face / deep) is under the cursor.
    if (target.kind === 'pod') group.add(makeHighlightGroup(podSegmentOf(target.pod, seg), true));
    applyHighlightFade(group, 0); // start invisible, fade up in updateHighlightFade()
    worldGroup.add(group);
    highlightGroup = group;
    hoverInfo = {
      fullName: seg.fullName,
      type: seg.type,
      coords: [seg.coordinateX, seg.coordinateY, seg.coordinateZ],
      dims:   [seg.dimensionX, seg.dimensionY, seg.dimensionZ],
      lane: laneInfoOf(seg),
      pod: target.kind === 'pod' ? podInfoOf(target.pod, seg) : undefined,
    };
  }

  // Per-frame highlight fading: the active group eases toward full, queued groups
  // ease toward zero and are disposed once invisible. Capped so a fast cursor
  // sweep can't pile up unbounded fade-outs.
  function updateHighlightFade(dt: number) {
    if (highlightGroup) {
      const f = Math.min(1, (highlightGroup.userData.fade ?? 0) + dt / HOVER_FADE_IN);
      applyHighlightFade(highlightGroup, f);
    }
    while (fadingHighlights.length > 8) disposeHighlightGroup(fadingHighlights.shift()!);
    for (let i = fadingHighlights.length - 1; i >= 0; i--) {
      const g = fadingHighlights[i];
      const f = (g.userData.fade ?? 1) - dt / HOVER_FADE_OUT;
      if (f <= 0) {
        disposeHighlightGroup(g);
        fadingHighlights.splice(i, 1);
      } else {
        applyHighlightFade(g, f);
      }
    }
  }

  function onPointerMove(event: PointerEvent) {
    // While the tour is actively playing it drives its own showcase highlight, so
    // ignore cursor hover entirely (moving the mouse mustn't light up stock). When
    // PAUSED, though, the user is inspecting by hand — track the cursor and show
    // the level banner for the rack under it.
    if (tourActive && !tourPaused) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    tooltipX = event.clientX - rect.left;
    tooltipY = event.clientY - rect.top;
    tooltipFlipX = tooltipX > rect.width * 0.62;
    tooltipFlipY = tooltipY > rect.height * 0.52;
    if (tourActive && tourPaused) { updatePausedHover(); return; }

    // Aisle arrows take priority over space hover (they sit on the open floor).
    if (mode === 'orbit' && arrowMeshes.length > 0) {
      raycaster.setFromCamera(pointer, perspectiveCamera);
      const aHits = raycaster.intersectObjects(arrowMeshes, false);
      if (aHits.length > 0) {
        setArrowHover(aHits[0].object as THREE.Mesh);
        canvas.style.cursor = 'pointer';
        clearHighlight();
        return;
      }
      setArrowHover(null);
      if (canvas.style.cursor === 'pointer') canvas.style.cursor = '';
    }

    const target = pickHover();
    if (target) {
      applyHighlight(target);
      // Hint that a pallet is clickable (opens its pod label). Overview only — in
      // walk mode the rail owns the cursor (grab/grabbing).
      if (mode === 'orbit') {
        const clickable = target.kind === 'pod' ||
          (target.kind === 'space' && showStock && isDemoOccupied(target.seg.fullName));
        canvas.style.cursor = clickable ? 'pointer' : '';
      }
    } else {
      clearHighlight();
      if (mode === 'orbit' && canvas.style.cursor === 'pointer') canvas.style.cursor = '';
    }
  }

  function onPointerLeave() {
    clearHighlight();
    setArrowHover(null);
    canvas.style.cursor = '';
  }

  // Floor arrows on each aisle's walkway centreline, pointing down the aisle.
  // In worldGroup so they ride the depth-stretched walkway; flat on the slab.
  function buildAisleArrows() {
    arrowGroup = new THREE.Group();
    arrowGroup.name = 'AISLE_ARROWS';

    // Arrow outline pointing +X, drawn in XY then laid flat on the floor.
    const shape = new THREE.Shape();
    shape.moveTo(0, -350);
    shape.lineTo(1500, -350);
    shape.lineTo(1500, -850);
    shape.lineTo(3000, 0);
    shape.lineTo(1500, 850);
    shape.lineTo(1500, 350);
    shape.lineTo(0, 350);
    shape.closePath();
    const geom = new THREE.ShapeGeometry(shape);
    geom.rotateX(-Math.PI / 2); // lie flat; shape +Y → world −Z
    geom.center();              // centre at origin so hover-scale grows evenly

    for (const seg of segments) {
      if (seg.type !== 'AISLE') continue;
      const cz = seg.coordinateY + seg.dimensionY / 2;
      const mat = new THREE.MeshBasicMaterial({
        color: ARROW_COLOR, transparent: true, opacity: 0.9,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(seg.coordinateX + 4000, 60, cz);
      mesh.renderOrder = 3; // draw over the floor + grid
      mesh.userData.aisleName = seg.fullName;
      arrowMeshes.push(mesh);
      arrowGroup.add(mesh);
    }
    worldGroup.add(arrowGroup);
    arrowDispose = () => {
      geom.dispose();
      for (const m of arrowMeshes) (m.material as THREE.Material).dispose();
    };
  }

  function setArrowHover(mesh: THREE.Mesh | null) {
    if (mesh === hoveredArrow) return;
    if (hoveredArrow) {
      (hoveredArrow.material as THREE.MeshBasicMaterial).color.setHex(ARROW_COLOR);
      hoveredArrow.scale.setScalar(1);
    }
    hoveredArrow = mesh;
    if (mesh) {
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(ARROW_HOVER);
      mesh.scale.setScalar(1.12);
    }
  }

  function onCanvasPointerDown(e: PointerEvent) {
    aislePickerOpen = false;
    tourSpeedOpen = false;
    pointerDownX = e.clientX;
    pointerDownY = e.clientY;
  }

  // Click handling on the canvas: drags are ignored. With demo stock on, a click
  // on an occupied pallet opens its pod label (works in overview AND walk). In
  // overview, a click on an aisle arrow walks that aisle.
  function onCanvasClick(e: MouseEvent) {
    if (Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) > 6) return; // a drag, not a click
    if (flow && flow.acceptsClicks) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const t = pickHover();
      if (t) {
        flow.handleClick(t.kind === 'pod' ? { kind: 'pod', pod: t.pod, lane: t.seg } : t.kind === 'lane' ? { kind: 'lane', lane: t.seg } : { kind: 'other' });
        return;
      }
    }
    if (showStock && tryOpenPodLabel(e)) return;
    if (mode !== 'orbit' || arrowMeshes.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, perspectiveCamera);
    const hits = raycaster.intersectObjects(arrowMeshes, false);
    if (hits.length === 0) return;
    const name = (hits[0].object as THREE.Mesh).userData.aisleName as string;
    const idx = rail.aisleNames.indexOf(name);
    if (idx >= 0) { setArrowHover(null); enterWalk(idx); }
  }

  // Raycast the SPACE bins under the click; if the hit location holds a demo
  // pallet, open its pod label. Returns true when a label was opened (so the
  // click is consumed and doesn't also trigger aisle-arrow navigation).
  function tryOpenPodLabel(e: MouseEvent): boolean {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const target = pickHover();
    if (!target) return false;
    if (target.kind === 'pod') { openPodLabel(target.pod.code); return true; }
    if (target.kind === 'space' && isDemoOccupied(target.seg.fullName)) { openPodLabel(target.seg.fullName); return true; }
    return false;
  }

  // Generate the pod details, show the panel in its loading state, then render
  // the ZPL to a PNG (Labelary). Guarded so a stale render (the user clicked
  // another pallet, or closed the panel) can't overwrite the current one.
  async function openPodLabel(name: string) {
    if (podLabel?.url) URL.revokeObjectURL(podLabel.url);
    const data = generatePodData(name);
    podLabel = { name, data, loading: true, url: null, error: false };
    try {
      const url = await renderPodLabel(data);
      if (podLabel && podLabel.name === name) podLabel = { ...podLabel, loading: false, url };
      else URL.revokeObjectURL(url); // superseded while rendering — discard
    } catch {
      if (podLabel && podLabel.name === name) podLabel = { ...podLabel, loading: false, error: true };
    }
  }

  function closePodLabel() {
    if (podLabel?.url) URL.revokeObjectURL(podLabel.url);
    podLabel = null;
  }

  // Re-raycast each frame while walking: the camera moves without pointer
  // events, so hover has to track what slides under the (stationary) cursor.
  // Hover works regardless of the SPACE overlay toggle (raycast ignores visibility).
  function updateHover() {
    const target = pickHover();
    if (target) applyHighlight(target);
    else clearHighlight();
  }

  // Hover while the tour is paused: same as updateHover, but surfaces the whole
  // LEVEL of the rack under the cursor (the tour's level banner) instead of the
  // single-space tooltip. Re-raycast per frame since the camera moves under a
  // stationary cursor as the user walks/rides during the pause.
  function updatePausedHover() {
    const target = pickHover();
    if (!target) { clearHighlight(); return; }
    // Rack bins surface their whole shelf; block-stack lanes/pallets get the
    // regular lane tooltip (there is no shelf to showcase on the floor).
    if (target.kind === 'space') applyLevelShowcase(levelNameOf(target.seg.fullName));
    else applyHighlight(target);
  }

  // Tour showcase: cast from the centre of the view into the rack the camera is
  // inspecting, find the space in view, and highlight its whole LEVEL (shelf) +
  // list the locations on it. Only while paused and looking at a rack
  // (tour.showcasing); the far clamp keeps it to a close shelf.
  const TOUR_AIM = new THREE.Vector2(0, 0);
  function updateTourHover() {
    // The tour reports which shelf it's inspecting; highlight that directly (no
    // per-frame raycast, so steep top/bottom shelves still highlight reliably).
    if (tour.showcasing && tour.inspectLevel) applyLevelShowcase(tour.inspectLevel);
    else clearHighlight();
  }

  // For the tour: bay-centre distances along an aisle (so showcase stops land on a
  // bay, centring the faced rack rather than straddling two bays).
  function bayCentersForAisle(i: number): number[] {
    const a = rail?.aisles[i];
    if (!a) return [];
    const xs = bayXsByAisle.get(aisleLetterOf(a.name));
    if (!xs) return driveAisleNames.has(a.name) ? laneStopsForAisle(a) : [];
    const out = new Set<number>();
    for (const x of xs) {
      const d = (x - a.start.x) * a.dir.x; // distance along the aisle (runs along X)
      if (d >= 0 && d <= a.length) out.add(Math.round(d));
    }
    return [...out].sort((p, q) => p - q);
  }

  // "BSM BSN · BSP BSR": the zones whose lanes face a drive aisle, one group per side.
  function zoneLabelFor(name: string): string {
    const a = rail?.aisles.find((x) => x.name === name);
    if (!a || !driveAisleNames.has(name)) return '';
    const rows = new Map<number, Set<string>>();
    for (const l of lanesFacingAisle(a)) (rows.get(l.coordinateY) ?? rows.set(l.coordinateY, new Set()).get(l.coordinateY)!).add(l.lane!.block);
    return [...rows.entries()].sort((p, q) => q[0] - p[0]).map(([, set]) => [...set].sort().join(' ')).join(' · ');
  }

  // Lanes whose face opens onto a drive aisle, worked out once per aisle.
  const laneFaceCache = new Map<string, Segment[]>();
  function lanesFacingAisle(a: { name: string; start: THREE.Vector3 }): Segment[] {
    const cached = laneFaceCache.get(a.name);
    if (cached) return cached;
    const seg = segments.find((sg) => sg.fullName === a.name);
    const half = ((seg?.dimensionY ?? 5600) * hScale) / 2 + 300;
    const list = laneSegments.filter((l) => {
      const cfg = l.lane!;
      const faceZ = (cfg.faceDir > 0 ? l.coordinateY + l.dimensionY : l.coordinateY) * hScale;
      return Math.abs(faceZ - a.start.z) <= half;
    });
    laneFaceCache.set(a.name, list);
    return list;
  }

  // Block-stack drive aisle: three showcase stops spread along it, placed where the
  // three lanes in line hold stock on BOTH sides of the aisle (so each turn of the
  // head meets full columns), the densest such spot near each third of the aisle.
  // Falls back to one complete side, then to any stock, then to any lane.
  function laneStopsForAisle(a: { name: string; start: THREE.Vector3; dir: THREE.Vector3; length: number }): number[] {
    const count = (l: Segment) => laneStock.get(l.fullName)?.pods.length ?? 0;
    const byX = new Map<number, Segment[]>();
    for (const l of lanesFacingAisle(a)) {
      const x = Math.round(l.coordinateX + l.dimensionX / 2);
      (byX.get(x) ?? byX.set(x, []).get(x)!).push(l);
    }
    const scored = [...byX].map(([x, lanes]) => {
      let completeSides = 0;
      let pods = 0;
      let minPods = Infinity; // the shortest of the six columns: tall everywhere reads best
      for (const l of lanes) {
        const tri = laneTriple(l);
        if (tri.length === 3 && tri.every((t) => count(t) > 0)) completeSides++;
        for (const t of tri) { pods += count(t); minPods = Math.min(minPods, count(t)); }
      }
      return { d: (x - a.start.x) * a.dir.x, sides: lanes.length, completeSides, pods, minPods: Number.isFinite(minPods) ? minPods : 0 };
    }).filter((c) => c.d >= 0 && c.d <= a.length);
    if (scored.length === 0) return [];
    const both = scored.filter((c) => c.sides === 2 && c.completeSides === 2);
    const one = scored.filter((c) => c.completeSides >= 1);
    const any = scored.filter((c) => c.pods > 0);
    const pool = both.length ? both : one.length ? one : any.length ? any : scored;
    const out = new Set<number>();
    for (const frac of [1 / 6, 1 / 2, 5 / 6]) {
      const want = frac * a.length;
      const near = pool.filter((c) => Math.abs(c.d - want) <= a.length / 6);
      const pick = (near.length ? near : pool).reduce((b, c) =>
        c.minPods > b.minPods || (c.minPods === b.minPods && (c.pods > b.pods || (c.pods === b.pods && Math.abs(c.d - want) < Math.abs(b.d - want)))) ? c : b);
      out.add(Math.round(pick.d));
    }
    return [...out].sort((p, q) => p - q);
  }

  // A lane with its neighbour either side in the same row: the three columns the
  // showcase outlines together.
  function laneTriple(lane: Segment): Segment[] {
    return laneSegments
      .filter((l) => l.lane?.block === lane.lane?.block && l.coordinateY === lane.coordinateY && Math.abs(l.coordinateX - lane.coordinateX) <= lane.dimensionX * 1.5)
      .sort((p, q) => p.coordinateX - q.coordinateX);
  }

  // Block-stack showcase plan: the lane the camera faces across the aisle (never a
  // stack seen through an empty lane from the bank behind) and its neighbours either
  // side, one entry per level they stack to, floor to top — the drive-aisle
  // counterpart of a bay's shelves. An empty triple sweeps its nominal levels.
  function planStackInspection(): { pitch: number; level: string }[] | null {
    const laneInst = tierInstancedMeshes.get('LANE');
    const a = rail?.aisles[rail.index];
    if (!laneInst || !a) return null;
    const facing = new Set(lanesFacingAisle(a).map((l) => l.fullName));
    perspectiveCamera.updateMatrixWorld();
    raycaster.setFromCamera(TOUR_AIM, perspectiveCamera);
    const prevFar = raycaster.far;
    raycaster.far = 14000;
    const hits = raycaster.intersectObject(laneInst, false);
    raycaster.far = prevFar;
    const hit = hits.find((h) => h.instanceId !== undefined && facing.has(laneSegments[h.instanceId]?.fullName));
    if (!hit) return null;
    const lane = laneSegments[hit.instanceId!];
    const cfg = lane.lane!;
    const triple = laneTriple(lane);
    const cam = perspectiveCamera.position;
    // Levels every lane of the triple reaches read as one slab across three columns;
    // only when there are none do the partial levels get swept.
    const bands: { t: number; band: StackBand }[] = [];
    for (let t = 0; t < cfg.tiers; t++) {
      const band = stackLevelBand(triple, t);
      if (band) bands.push({ t, band });
    }
    const complete = bands.filter((b) => b.band.complete);
    const use = complete.length ? complete : bands;
    const plan = use.map(({ t, band }) => {
      const bx = (band.x0 + band.x1) / 2;
      const bz = ((band.y0 + band.y1) / 2) * hScale;
      const wy = ((band.z0 + band.z1) / 2) * vScale;
      return { pitch: Math.atan2(wy - cam.y, Math.hypot(bx - cam.x, bz - cam.z)), level: `stack:${lane.fullName}:${t}` };
    });
    return plan.length ? plan : null;
  }

  // One level across a lane triple: the box around the pallets standing at that
  // tier (any depth, any of the three lanes), and whether every lane reaches it. A
  // level nobody stacks to is skipped unless the whole triple is empty, in which
  // case the nominal tier heights are used.
  interface StackBand { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; complete: boolean; pods: { lane: Segment; pod: LanePod }[] }
  function stackLevelBand(triple: Segment[], tier: number): StackBand | null {
    const pods: { lane: Segment; pod: LanePod }[] = [];
    const lanesAt = new Set<string>();
    let any = false;
    for (const l of triple) {
      const st = laneStock.get(l.fullName);
      if (!st) continue;
      if (st.pods.length) any = true;
      for (const p of st.pods) if (p.tier === tier && showStock) { pods.push({ lane: l, pod: p }); lanesAt.add(l.fullName); }
    }
    if (pods.length) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const { lane, pod } of pods) {
        const b = podBounds(pod, lane);
        x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1);
        y0 = Math.min(y0, b.y0); y1 = Math.max(y1, b.y1);
        z0 = Math.min(z0, b.z0); z1 = Math.max(z1, b.z1);
      }
      return { x0, x1, y0, y1, z0, z1, complete: lanesAt.size === triple.length, pods };
    }
    if (any || !showStock) return null;
    const first = triple[0];
    const last = triple[triple.length - 1];
    return {
      x0: first.coordinateX, x1: last.coordinateX + last.dimensionX, y0: first.coordinateY, y1: first.coordinateY + first.dimensionY,
      z0: tier * BS.TIER_PITCH, z1: (tier + 1) * BS.TIER_PITCH, complete: false, pods: [],
    };
  }

  // For the tour: every shelf of the bay the camera currently faces, paired with
  // the pitch elevation to look at it (ascending, bottom→top). The tour sweeps the
  // pitch across these and highlights the nearest shelf as it goes.
  function planVerticalInspection(): { pitch: number; level: string }[] | null {
    // In a drive aisle the camera faces pallet stacks; the racking beyond them must
    // not be picked up through a stack.
    if (driveAisleNames.has(rail?.aisles[rail.index]?.name ?? '')) return planStackInspection();
    const spaceInst = tierInstancedMeshes.get('SPACE');
    if (!spaceInst) return null;
    raycaster.setFromCamera(TOUR_AIM, perspectiveCamera);
    const prevFar = raycaster.far;
    raycaster.far = 14000;
    const hits = raycaster.intersectObject(spaceInst, false);
    raycaster.far = prevFar;
    if (!hits.length || hits[0].instanceId === undefined) return planStackInspection(); // no rack ahead: a pallet stack?
    const seg = spaceSegments[hits[0].instanceId];
    if (!seg) return null;
    const levels = levelsByBay.get(bayNameOf(levelNameOf(seg.fullName)));
    if (!levels || levels.length === 0) return null;

    const cam = perspectiveCamera.position;
    // Pitch (elevation) to look at a level's world centre from the camera.
    return levels.map((lv) => {
      const wx = lv.coordinateX + lv.dimensionX / 2;
      const wy = (lv.coordinateZ + lv.dimensionZ / 2) * vScale;
      const wz = (lv.coordinateY + lv.dimensionY / 2) * hScale;
      return { pitch: Math.atan2(wy - cam.y, Math.hypot(wx - cam.x, wz - cam.z)), level: lv.fullName };
    });
  }

  // depthWrite stays false for every tier in both modes: writing depth from a
  // semi-transparent tier (the source repo set it for LEVEL at walk opacity)
  // makes the hover box fail depth tests against level faces and glitch.
  // TIER_ORDER + the hover's renderOrder already guarantee correct stacking.
  // The realistic rack/environment meshes are intentionally excluded: they
  // stay opaque in walk mode (the rail keeps the camera in the clear aisle).
  function setRackOpacity(on: boolean) {
    for (const [type, inst] of tierInstancedMeshes) {
      const m = inst.material as THREE.MeshStandardMaterial;
      m.opacity = on ? WALK_OPACITY[type] : OPACITY_MAP[type];
      m.needsUpdate = true;
    }
    for (const name of ['AISLE', 'BLOCK'] as const) {
      containerGroups.get(name)?.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const m = o.material as THREE.MeshStandardMaterial;
          if (m.transparent) { m.opacity = on ? WALK_OPACITY[name] : OPACITY_MAP[name]; m.needsUpdate = true; }
        }
      });
    }
  }

  // aisleIdx picks the aisle to drop into; omitted = nearest to the camera.
  function enterWalk(aisleIdx?: number) {
    aislePickerOpen = false;
    camTween = null;
    orbitKeys.fwd = orbitKeys.back = orbitKeys.left = orbitKeys.right = false;
    mode = 'walk';
    controls.enabled = false;
    clearHighlight();
    setArrowHover(null);
    if (arrowGroup) arrowGroup.visible = false;
    canvas.style.cursor = '';
    setRackOpacity(true);
    perspectiveCamera.fov = walk.fov;            // wider = more zoomed out
    perspectiveCamera.updateProjectionMatrix();
    rail.enable();
    if (aisleIdx !== undefined) rail.setAisle(aisleIdx);
  }

  // Virtual tour: an autopilot that drives the rail through every aisle in a
  // serpentine loop. Requires walk mode (it builds on the rail), so starting it
  // from orbit drops into walk first.
  function startTour() {
    if (mode !== 'walk') enterWalk();
    clearHighlight(); // drop any cursor hover box before suppressing hover for the tour
    tour.start();
    tourActive = true;
    tourPaused = false;
  }

  // Cinematic tour launch from the overview: smoothly fly the camera down from
  // wherever it's parked into the mouth of the first aisle — sweeping the look
  // from the whole rack block to straight down the aisle and easing the fov to
  // the walk lens — then hand off to walk mode and start the autopilot. The
  // handoff pose matches the rail's dist-0 pose exactly, so there's no snap.
  function startTourFromOverview() {
    if (!rail || rail.aisles.length === 0 || tourEntering) return;
    if (mode !== 'orbit') { startTour(); return; } // already inside — just start
    aislePickerOpen = false;
    tourSpeedOpen = false;
    tourEntering = true;

    const idx = tour.route?.[0] ?? 0; // the route's first aisle — the block stack
    const a = rail.aisles[idx];
    const eyeY = rail.targetHeightFor(idx); // the drive aisles are walked at ~2 m
    const dirH = a.dir.clone(); dirH.y = 0; dirH.normalize();

    // The fly-in is split into two legs so the camera always enters along the
    // aisle's own axis — never on a diagonal that skims a rack face on the way in.
    //  • STAGE_BACK: a staging point this far IN FRONT of the aisle mouth, out on
    //    the open cross-aisle floor, sitting on the walkway centreline.
    //  • ENTRY_OFFSET: where it comes to rest just inside the mouth.
    // Leg 1 descends from the overview to the staging point (looking straight down
    // the aisle); leg 2 then glides forward along the centreline into the mouth, so
    // the camera holds the middle of the walkway the whole time it passes the racks.
    const STAGE_BACK = 14000;
    const ENTRY_OFFSET = 3000;
    const stagePos = a.start.clone().addScaledVector(dirH, -STAGE_BACK); stagePos.y = eyeY;
    const entryPos = a.start.clone().addScaledVector(dirH, ENTRY_OFFSET); entryPos.y = eyeY;
    const lookTarget = a.start.clone().addScaledVector(dirH, 35000); lookTarget.y = eyeY; // down the aisle

    const fromPos = perspectiveCamera.position.clone();
    let bow = 0;
    // Leg 1 ends in front of the mouth (open floor), so it can only be blocked when
    // the overview is parked on the far side of the rack block — arc up and over then.
    if (flightIsBlocked(fromPos, stagePos)) {
      bow = Math.max(0, rackTopY * vScale + 4000 - (fromPos.y + stagePos.y) / 2);
    }

    // Leg 2: a straight, centred glide from the staging point into the walkway.
    const enterAlongAisle = () => {
      camTween = {
        fromPos: stagePos.clone(),
        fromTarget: lookTarget.clone(),
        toPos: entryPos,
        toTarget: lookTarget.clone(),
        start: performance.now(),
        duration: 2600, // a slow, deliberate glide in — lets the walkway read before the tour starts
        bow: 0, // pure axial move along the centreline — stays dead-centre, no arc
        onDone: () => {
          enterWalk(idx);        // walk mode at aisle 1, camera already at the entry pose
          // enterWalk → setAisle resets dist to 0. Re-derive it from the camera's actual
          // landing position so the tour seeds from the centre of the walkway.
          rail.syncFromCamera();
          clearHighlight();
          tour.start();          // seeds the serpentine from the synced dist
          tourActive = true;
          tourPaused = false;
          tourEntering = false;
        },
      };
    };

    // Leg 1: descend from wherever the overview is parked to the staging point,
    // easing the lens to the walk fov and swinging the look straight down the aisle.
    camTween = {
      fromPos,
      fromTarget: controls.target.clone(),
      toPos: stagePos,
      toTarget: lookTarget.clone(),
      start: performance.now(),
      duration: 2400, // slow, deliberate descent toward the aisle mouth
      bow,
      fromFov: perspectiveCamera.fov,
      toFov: walk.fov,
      onDone: enterAlongAisle,
    };
  }

  function stopTour() {
    if (tour) tour.stop();
    tourActive = false;
    tourPaused = false;
  }

  // Freeze / unfreeze the running tour in place (the camera holds its frame and
  // any inspected-level panel stays up); resuming continues from that point.
  function toggleTourPause() {
    if (!tourActive) return;
    if (tourPaused) { tour.resume(); tourPaused = false; }
    else { tour.pause(); tourPaused = true; }
  }

  // Exported for the App-header Virtual Tour button: start (cinematic launch from
  // the overview, or straight away if already walking) or stop the tour.
  export function toggleTour() {
    if (tourActive) { stopTour(); return; }
    // Walking an aisle the autopilot doesn't route (the block-stack drive aisle):
    // hand over to the overview camera IN PLACE and launch the cinematic fly-in
    // from there, rather than teleporting into aisle A.
    const routed = !tour.route || tour.route.includes(rail.index);
    if (mode === 'walk' && !routed) exitWalk(true);
    startTourFromOverview();
  }
  // Keep the header button's label/active state in sync with the tour.
  $: dispatch('tour', tourActive);

  // Reconcile the scene with the current mode + shell toggle: hide the shell and
  // relax the perspective zoom-out limit when the shell is off, and keep the floor
  // arrows shown only in orbit mode.
  function applyView() {
    if (roofMesh) roofMesh.visible = showShell;
    for (const o of roofExtras) o.visible = showShell;
    if (controls) {
      controls.maxDistance = showShell ? orbit.maxDistance : orbit.maxDistance * 3;
      controls.enabled = mode === 'orbit';
    }
    if (arrowGroup) arrowGroup.visible = mode === 'orbit';
  }

  // Re-apply when the App-header shell toggle flips (mirrors the showStock flow).
  $: if (scene && worldGroup) { showShell; applyView(); }

  // Glide the camera back to its home position/target. In walk mode this is
  // what Exit already does (instantly), so just delegate. Exported for the
  // App-header Reset button.
  export function resetView() {
    aislePickerOpen = false;
    if (mode === 'walk') { exitWalk(); return; }
    const fromPos = perspectiveCamera.position.clone();
    const toPos = new THREE.Vector3(...camera.position);
    toPos.y *= vScale; toPos.z *= hScale;
    const toTarget = new THREE.Vector3(...orbit.target);
    toTarget.y *= vScale; toTarget.z *= hScale;
    let bow = 0;
    if (flightIsBlocked(fromPos, toPos)) {
      bow = Math.max(0, rackTopY * vScale + 3000 - (fromPos.y + toPos.y) / 2);
    }
    camTween = {
      fromPos,
      fromTarget: controls.target.clone(),
      toPos,
      toTarget,
      start: performance.now(),
      duration: bow > 0 ? 1200 : 850,
      bow,
    };
  }

  // Staged exit for the three view levels: tour → walkway → overview. Esc and the
  // Exit button back out exactly one level — from the virtual tour they drop to
  // the walkway right where the camera is; from the walkway they pop out to the
  // overview. (exitWalk itself still ends a tour first, for the resetView path.)
  function exitOneLevel() {
    aislePickerOpen = false;
    if (tourActive) stopTour();        // tour → walkway, held at the current spot
    else if (mode === 'walk') exitWalk(); // walkway → overview
  }

  // keepPose: stay where the walk left the camera (orbiting about a point a little
  // way ahead) instead of snapping home — used when a flight takes over from here.
  function exitWalk(keepPose = false) {
    aislePickerOpen = false;
    stopTour();
    mode = 'orbit';
    clearHighlight(); // drop the walk-style (depth-tested) highlight so it rebuilds for orbit
    rail.disable();
    setRackOpacity(false);
    controls.enabled = true;
    perspectiveCamera.fov = camera.fov ?? 50;    // restore orbit FOV
    perspectiveCamera.updateProjectionMatrix();
    if (keepPose) {
      const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(perspectiveCamera.quaternion);
      controls.target.copy(perspectiveCamera.position).addScaledVector(ahead, 8000);
    } else {
      perspectiveCamera.position.set(...camera.position);
      perspectiveCamera.position.y *= vScale; perspectiveCamera.position.z *= hScale;
      controls.target.set(...orbit.target);
      controls.target.y *= vScale; controls.target.z *= hScale;
    }
    controls.update();
    applyView(); // re-enable orbit controls + arrows, reconcile the roof toggle
  }

  function onResize() {
    if (!container || !renderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    perspectiveCamera.aspect = w / h;
    perspectiveCamera.updateProjectionMatrix();
    renderer.setSize(w, h);
    // Repaint in the same tick so the freshly resized canvas is never shown blank
    // (otherwise the nav collapse/expand and initial load flash a blank frame).
    if (scene) renderer.render(scene, perspectiveCamera);
  }

  function applyVisibility() {
    for (const [type, group] of containerGroups) {
      group.visible = visibleTypes.has(type);
    }
    for (const [type, inst] of tierInstancedMeshes) {
      inst.visible = visibleTypes.has(type);
    }
    for (const [type, edges] of tierEdgeMeshes) {
      edges.visible = visibleTypes.has(type);
    }
  }

  // Demo stock: build the pallet/box goods on first enable (occupied=null →
  // seeded demo fill), then just flip visibility. Added under worldGroup so it
  // inherits the depth stretch and lines up with the racks.
  function applyStock() {
    if (!scene || !worldGroup) return;
    if (showStock && !goodsHandle) {
      goodsHandle = buildGoods(segments, null, { y: vScale, z: hScale }, goodsEnv);
      worldGroup.add(goodsHandle.group);
    }
    if (goodsHandle) goodsHandle.group.visible = showStock;
    // Block-stack pallets: same toggle, own builder (floor lanes, stacked two high).
    if (showStock && !blockStock && laneSegments.length > 0) {
      blockStock = buildBlockStackStock(laneSegments, laneStock, { y: vScale, z: hScale }, goodsEnv);
      worldGroup.add(blockStock.group);
    }
    if (blockStock) blockStock.group.visible = showStock;
  }

  $: if (scene && visibleTypes) applyVisibility();
  $: if (scene && worldGroup) { showStock; applyStock(); }
  // Turning demo stock off closes any open pod label (its pallet is now hidden).
  $: if (!showStock && podLabel) closePodLabel();

  // Rail aisle centrelines / eye height match the depth-stretched world so
  // walk mode stays aligned with the racks.
  function makeRail(): RailControls {
    // Feed the rail segments matching the (possibly scaled) world so the aisle
    // centrelines and ceiling clamp line up: depth axis (coordinateY→Z) widens
    // with hScale, height (coordinateZ) compresses with vScale, X is untouched.
    const segs = (vScale === 1 && hScale === 1) ? segments : segments.map((s) => ({
      ...s,
      coordinateY: s.coordinateY * hScale,
      dimensionY:  s.dimensionY  * hScale,
      coordinateZ: s.coordinateZ * vScale,
      dimensionZ:  s.dimensionZ  * vScale,
    }));
    const opts: { eyeHeight: number; moveSpeed: number } = {
      eyeHeight: walk.eyeHeight * vScale,
      moveSpeed: walk.moveSpeed,
    };
    const r = new RailControls(perspectiveCamera, canvas, segs, opts);
    r.onChange = (info) => { aisleIndex = info.index; aisleLabel = info.name; aisleTotal = info.total; aisleZones = zoneLabelFor(info.name); };
    return r;
  }

  function setupScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdde3ea);
    scene.fog = new THREE.Fog(0xdde3ea, 250000, 780000);

    // All data-built geometry hangs off this root, which carries the depth
    // stretch (hScale) in one step. Camera and lights stay at scene level.
    worldGroup = new THREE.Group();
    worldGroup.name = 'WORLD';
    worldGroup.scale.set(1, vScale, hScale);
    scene.add(worldGroup);

    perspectiveCamera = new THREE.PerspectiveCamera(
      camera.fov ?? 50,
      container.clientWidth / container.clientHeight,
      camera.near ?? 100,
      camera.far ?? 800000,
    );
    perspectiveCamera.position.set(...camera.position);
    perspectiveCamera.position.z *= hScale; // match the depth-stretched world

    // alpha:true so the canvas is transparent until the first frame paints — the
    // matching #dde3ea container shows through instead of an opaque white canvas,
    // avoiding a white flash on initial load while the scene builds.
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    // Cap at 1.5: beyond that the extra pixels cost fill rate with little
    // visible gain at this scene's scale (matters most on HiDPI displays).
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    // Pre-bake a soft indoor environment (PMREM) once, used as the env map for the
    // stock so kraft, cartons, pallet wood and stretch wrap pick up believable
    // reflections. One-time cost; nothing extra per frame.
    {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment(renderer); // renderer → correct (physical) light intensity
      goodsEnv = pmrem.fromScene(room, 0.04).texture;
      room.dispose?.();
      pmrem.dispose();
    }
    if (import.meta.env.DEV) {
      (window as any).__renderer = renderer;
      (window as any).__camera = () => perspectiveCamera;
      (window as any).__controls = () => controls;
      (window as any).__scene = () => scene;
      (window as any).__rail = () => rail;
      (window as any).__tour = () => tour;
      (window as any).__clickArrow = (name: string) => {
        const idx = rail.aisleNames.indexOf(name);
        if (idx >= 0) { setArrowHover(null); enterWalk(idx); }
        return { idx, mode };
      };
      (window as any).__laneStock = () => laneStock;
      (window as any).__flow = {
        open: () => { if (!flow || !flow.active) toggleFlow(); },
        close: () => { if (flow?.active) flow.stop(); },
        next: () => flow?.next(),
        restart: () => flow?.restart(),
        auto: () => flow?.toggleAuto(),
        pause: () => flow?.togglePause(),
        scenario: (id: string) => flow?.runScenario(id),
        pov: () => togglePickerView(),
        choose: (name: string) => flow?.chooseByName(name),
        state: () => get(flowState),
        stepId: () => flow?.stepId,
        // advance the truck by dt seconds without waiting for real frames
        step: (dt: number) => { updateFlow(dt); stepCamTween(); renderer.render(scene, perspectiveCamera); },
        truck: () => (truck ? { pos: truck.group.position.toArray().map(Math.round), rotY: +truck.group.rotation.y.toFixed(3), forkH: Math.round(truck.carriage.position.y), visible: truck.group.visible, carrying: !!carried, busy: driver?.busy } : null),
        glows: () => [...flowGlows.keys()],
      };
      (window as any).__blockStock = () => blockStock;
      (window as any).__rebuildBlockStock = rebuildBlockStock;
      // Hover/pick probe for headless checks: NDC coords → what's under that point.
      (window as any).__pickAt = (nx: number, ny: number) => {
        pointer.set(nx, ny);
        const t = pickHover();
        return t ? { kind: t.kind, seg: t.seg.fullName, pod: t.kind === 'pod' ? t.pod.code : null } : null;
      };
      (window as any).__tick = (dt: number, render = true) => {
        stepCamTween();
        if (mode === 'walk') {
          if (tourActive && !tourPaused) { tour.update(dt * tourSpeed); updateTourHover(); } else rail.update(dt);
        } else { applyOrbitPan(dt); controls.update(); }
        perspectiveCamera.updateMatrixWorld(); // raycasts read it; only a render refreshes it otherwise
        if (render) renderer.render(scene, perspectiveCamera);
      };
      (window as any).__renderFrame = () => {
        if (mode === 'walk') rail.update(1 / 60);
        else { applyOrbitPan(1 / 60); controls.update(); }
        renderer.render(scene, perspectiveCamera);
      };
    }

    controls = new OrbitControls(perspectiveCamera, canvas);
    controls.target.set(...orbit.target);
    controls.target.z *= hScale; // match the depth-stretched world
    controls.minDistance = orbit.minDistance;
    controls.maxDistance = orbit.maxDistance;
    // Unrestricted rotation; the floor-Y clamp in the animate loop keeps the
    // camera position itself from dipping below the floor, while still
    // allowing low/zoomed-in viewing angles.
    controls.maxPolarAngle = Math.PI;
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.update();
    // Grabbing the scene mid-flight hands control straight back to the user
    // (and aborts a pending tour fly-in without starting the tour).
    controls.addEventListener('start', () => { camTween = null; tourEntering = false; });

    clock = new THREE.Clock();
    rail = makeRail();
    tour = new TourController(rail, perspectiveCamera);
    tour.onStop = () => { tourActive = false; tourPaused = false; };
    tour.planVertical = planVerticalInspection; // per-level pitch plan for the showcase
    tour.bayCenters = bayCentersForAisle;       // snap showcase stops onto bay centres
    // The rail orders the aisles across the floor — BS4 → BS3 → BS2, then A → V — so
    // the tour walks them in turn: it starts in the block stack, the last drive aisle
    // U-turns straight into racking aisle A, and the lap back around the outside
    // returns to BS4.
    for (const sg of segments) if (sg.type === 'AISLE' && sg.floorStorage) driveAisleNames.add(sg.fullName);
    tour.route = rail.aisles.map((_, i) => i);
    // Grabbing the controls mid-playback takes over and ends the tour. While the
    // tour is PAUSED the user is meant to roam freely, so input is left alone —
    // resume continues from wherever they end up.
    rail.onUserInput = () => { if (tourActive && !tourPaused) stopTour(); };

    // High-bay rig: bright even hemisphere base, warm key from above, a front
    // fill aimed at the rack faces the default vantage looks at, and a faint
    // cool back fill so the shaded sides keep some shape.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xa7adb3, 1.0));
    const keyLight = new THREE.DirectionalLight(0xfff3e2, 0.85);
    keyLight.position.set(30000, 60000, 20000);
    scene.add(keyLight);
    const frontFill = new THREE.DirectionalLight(0xffffff, 0.5);
    frontFill.position.set(-60000, 30000, 25000);
    scene.add(frontFill);
    const backFill = new THREE.DirectionalLight(0xdde7f5, 0.25);
    backFill.position.set(40000, 45000, -30000);
    scene.add(backFill);

    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();

    populateSegments();
    applyVisibility();

    window.addEventListener('resize', onResize);
    // Keep the canvas matched to its container for ANY size change — not just
    // window resizes — e.g. the nav bar collapsing/expanding animates the
    // viewport height, which would otherwise leave a gap.
    resizeObserver = new ResizeObserver(() => onResize());
    resizeObserver.observe(container);
    window.addEventListener('keydown', onWindowKeydown);
    window.addEventListener('keyup', onWindowKeyup);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    animate();
  }

  function populateSegments() {
    const buckets = new Map<SegmentType, Segment[]>();
    for (const seg of segments) {
      const list = buckets.get(seg.type) ?? [];
      list.push(seg);
      buckets.set(seg.type, list);
    }

    // AISLE stays as plain meshes (only 18 of them; cheap, and may want per-aisle labels later)
    const aisleList = buckets.get('AISLE') ?? [];
    if (aisleList.length > 0) {
      const group = new THREE.Group();
      group.name = 'AISLE';
      for (const seg of aisleList) group.add(makeContainerMesh(seg));
      containerGroups.set('AISLE', group);
      worldGroup.add(group);
    }

    // BLOCK (block-stack zones) are containers like AISLE: a handful of plain meshes.
    const blockList = buckets.get('BLOCK') ?? [];
    if (blockList.length > 0) {
      const group = new THREE.Group();
      group.name = 'BLOCK';
      for (const seg of blockList) group.add(makeContainerMesh(seg));
      containerGroups.set('BLOCK', group);
      worldGroup.add(group);
    }

    // BAY, LEVEL, SPACE (and the block-stack LANEs) all use InstancedMesh for huge draw-call savings.
    // BAY/LEVEL also get a single LineSegments edge pass to preserve outline look.
    for (const type of ['BAY', 'LEVEL', 'SPACE', 'LANE'] as const) {
      const list = buckets.get(type) ?? [];
      if (list.length === 0) continue;

      const inst = buildTierInstancedMesh(list, type);
      inst.name = type;
      inst.renderOrder = TIER_ORDER[type];
      tierInstancedMeshes.set(type, inst);
      worldGroup.add(inst);

      if (type !== 'SPACE') {
        const edges = buildTierEdgeMesh(list, type);
        edges.name = `${type}_EDGES`;
        tierEdgeMeshes.set(type, edges);
        worldGroup.add(edges);
      }
    }

    spaceSegments = buckets.get('SPACE') ?? [];
    laneSegments = buckets.get('LANE') ?? [];
    for (const l of laneSegments) laneByName.set(l.fullName, l);
    laneStock = buildDemoLaneStock(laneSegments); // seeded demo pallets per lane
    for (const s of segments) rackTopY = Math.max(rackTopY, s.coordinateZ + s.dimensionZ);

    // Index levels and group each level's storage locations, for the tour's
    // level-showcase highlight + locations panel.
    for (const lv of buckets.get('LEVEL') ?? []) {
      levelByName.set(lv.fullName, lv);
      const bay = bayNameOf(lv.fullName);
      (levelsByBay.get(bay) ?? levelsByBay.set(bay, []).get(bay)!).push(lv);
    }
    // Each bay's shelves bottom-to-top, for stepping the tour through every level.
    for (const list of levelsByBay.values()) list.sort((a, b) => a.coordinateZ - b.coordinateZ);
    for (const sp of spaceSegments) {
      const lvl = levelNameOf(sp.fullName);
      (spacesByLevel.get(lvl) ?? spacesByLevel.set(lvl, []).get(lvl)!).push(sp);
    }
    // Order each level's locations by code (A25A01, A25A02, …) for the panel table.
    for (const list of spacesByLevel.values()) list.sort((a, b) => a.fullName.localeCompare(b.fullName));
    for (const b of buckets.get('BAY') ?? []) {
      const letter = aisleLetterOf(b.fullName);
      (bayXsByAisle.get(letter) ?? bayXsByAisle.set(letter, []).get(letter)!).push(b.coordinateX + b.dimensionX / 2);
    }

    // Realistic warehouse layer: upright frames, beams, signs, floor, shell.
    // Always visible and opaque; the tier boxes above act as optional overlays.
    const rows = groupBaysIntoRows(segments);
    const racks = buildRacks(segments, rows);
    const signs = buildAisleSigns(segments, rows);
    racks.group.add(signs.group);
    worldGroup.add(racks.group);
    // Size the building around the racking only: the block stack sits on the slab
    // the margins already provide, so it must not push the walls out.
    const env = buildEnvironment(segments, rows, goodsEnv, segments.filter((s) => !s.floorStorage));
    worldGroup.add(env.group);
    shellBounds = env.shell;
    roofMesh = env.roof;
    // Structure that hides alongside the roof for a clean open overview: the
    // cladding walls, the steel columns and rafters, and the hanging lights —
    // everything but the floor, racks and aisle markings.
    roofExtras = ['SHELL_WALLS', 'SHELL_COLUMNS', 'SHELL_RAFTERS', 'LIGHT_FIXTURES', 'LIGHT_RODS']
      .map((n) => env.group.getObjectByName(n))
      .filter((o): o is THREE.Object3D => !!o);
    applyView(); // keep the roof toggle state across rebuilds
    // const loads = buildPallets(spaceSegments);
    // worldGroup.add(loads.group);
    const nets = buildSafetyNets(rows);
    worldGroup.add(nets.group);
    buildAisleArrows();
    // Block-stack floor paint: lane outlines, lane numbers and zone codes.
    const marks = buildBlockStackMarkings(blockList, laneSegments, { y: vScale, z: hScale });
    worldGroup.add(marks.group);
    realisticDisposers = [racks.dispose, signs.dispose, env.dispose, nets.dispose, arrowDispose, marks.dispose];
  }

  function animate() {
    rafId = requestAnimationFrame(animate);
    const dt = clock ? Math.min(clock.getDelta(), 0.1) : 0; // a hidden tab must not leap the tour ahead on return
    updateHighlightFade(dt); // smooth hover fade in/out, runs in every mode
    updateFlow(dt); // the forklift keeps working whichever camera is in use
    if (mode === 'orbit') {
      stepCamTween();
      applyOrbitPan(dt);
      controls.update();
      // Hard cage: the camera stays above the floor and inside the shell whatever the
      // rotation, zoom or panning; with the shell hidden only the floor holds.
      cageClampPos(perspectiveCamera.position);
      cageClampTarget(controls.target); // so arrow panning can't drag the pivot through a wall
    } else {
      // The tour drives the rail itself (and steers directly during aisle
      // turns), so only one of the two runs per frame. Cursor hover is
      // suppressed while touring — the camera moves under a stationary cursor,
      // so racks would otherwise flash highlighted as they slide past.
      if (tourActive && !tourPaused) {
        tour.update(dt * tourSpeed); // playback-speed scaled time-step
        updateTourHover();
      } else {
        // Not touring, or paused mid-tour: the rail takes manual input. While
        // paused, hover surfaces the level banner; otherwise the usual tooltip.
        rail.update(dt);
        if (tourPaused) updatePausedHover();
        else updateHover();
      }
    }
    renderer.render(scene, perspectiveCamera);
    if (!firstRendered) {
      firstRendered = true;
      dispatch('ready'); // scene is on screen — the loading overlay can fade out
    }
  }

  onMount(() => {
    setupScene();
  });

  onDestroy(() => {
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', onResize);
    resizeObserver?.disconnect();
    window.removeEventListener('keydown', onWindowKeydown);
    window.removeEventListener('keyup', onWindowKeyup);
    if (tour) tour.dispose();
    if (rail) rail.dispose();
    if (canvas) {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    }
    for (const dispose of realisticDisposers) dispose();
    if (highlightGroup) disposeHighlightGroup(highlightGroup);
    for (const g of fadingHighlights) disposeHighlightGroup(g);
    if (goodsHandle) goodsHandle.dispose();
    if (blockStock) blockStock.dispose();
    flow?.stop();
    for (const k of [...flowGlows.keys()]) dropGlow(k);
    if (carried) { carried.group.parent?.remove(carried.group); carried.dispose(); }
    if (truck) { scene.remove(truck.group); truck.dispose(); }
    disposeBlockStackTextures();
    if (podLabel?.url) URL.revokeObjectURL(podLabel.url);
    disposeGoodsTextures();
    goodsEnv?.dispose();
    if (controls) controls.dispose();
    if (renderer) renderer.dispose();
  });
</script>

<div class="scene-container" bind:this={container}>
  <canvas bind:this={canvas} on:pointerdown={onCanvasPointerDown} on:click={onCanvasClick}></canvas>

  {#if podLabel}
    <!-- Pod label preview for the clicked demo pallet. Backdrop click / ✕ / Esc closes. -->
    <div class="pod-overlay" on:click|self={closePodLabel} on:keydown={() => {}} role="presentation" transition:fade={{ duration: 140 }}>
      <div class="pod-card" transition:scale={{ duration: 180, start: 0.94 }}>
        <div class="pod-head">
          <div class="pod-titles">
            <span class="pod-label">Pod Label</span>
            <span class="pod-loc">{podLabel.name}</span>
          </div>
          <button class="pod-close" on:click={closePodLabel} title="Close (Esc)" aria-label="Close">✕</button>
        </div>
        <div class="pod-body">
          {#if podLabel.loading}
            <div class="pod-state"><span class="pod-spinner" aria-hidden="true"></span>Rendering label…</div>
          {:else if podLabel.error}
            <div class="pod-state pod-err">
              Couldn’t render the label (Labelary unreachable).
              <button class="pod-retry" on:click={() => podLabel && openPodLabel(podLabel.name)}>Retry</button>
            </div>
          {:else if podLabel.url}
            <img class="pod-img" src={podLabel.url} alt="Pod label for {podLabel.name}" />
          {/if}
        </div>
      </div>
    </div>
  {/if}

  {#if hoverInfo}
    <div
      class="loc-banner"
      class:flip-x={tooltipFlipX}
      class:flip-y={tooltipFlipY}
      style="{tooltipFlipX ? `right: ${container.clientWidth - tooltipX + 16}px` : `left: ${tooltipX + 16}px`}; {tooltipFlipY ? `bottom: ${container.clientHeight - tooltipY + 16}px` : `top: ${tooltipY + 16}px`};"
      transition:fade={{ duration: 140 }}
    >
      <div class="loc-name">{hoverInfo.fullName}</div>
      <div class="loc-type">{hoverInfo.type}</div>
      <div class="loc-dims">
        <div class="dim"><span class="dim-axis">Width</span><span class="dim-val">{toMetres(hoverInfo.dims[0])}<span class="dim-u">m</span></span></div>
        <div class="dim"><span class="dim-axis">Depth</span><span class="dim-val">{toMetres(hoverInfo.dims[1])}<span class="dim-u">m</span></span></div>
        <div class="dim"><span class="dim-axis">Height</span><span class="dim-val">{toMetres(hoverInfo.dims[2])}<span class="dim-u">m</span></span></div>
      </div>
      <div class="loc-pos">
        <span class="loc-label">POS</span>{toMetres(hoverInfo.coords[0])}, {toMetres(hoverInfo.coords[1])}, {toMetres(hoverInfo.coords[2])}<span class="loc-unit">m</span>
      </div>
      {#if hoverInfo.lane}
        {@const ln = hoverInfo.lane}
        <!-- Block-stack lane: what it holds under its policy, how full, which pallet is at the face. -->
        <div class="loc-lane">
          <div class="ll-grid">
            <span class="ll-k">Block</span><span class="ll-v">{ln.block}</span>
            <span class="ll-k">Pods</span>
            <span class="ll-v">{ln.pods}<span class="ll-dim"> / {ln.maxPods}</span>{#if ln.allocated}<span class="ll-alloc">{ln.allocated} allocated</span>{/if}</span>
            <span class="ll-k">Layout</span><span class="ll-v">{ln.deep} deep × {ln.tiers} high</span>
            <span class="ll-k">Policy</span><span class="ll-v" class:ll-muted={!ln.tracked}>{ln.policy ?? 'untracked'}</span>
            <span class="ll-k">{ln.tracked ? 'Class' : 'Holds'}</span>
            <span class="ll-v" class:ll-muted={ln.pods === 0}>{(ln.tracked ? ln.classLabel : ln.contents) ?? 'empty'}</span>
            {#if ln.face}<span class="ll-k">{ln.deep === 1 ? 'Top' : 'Face'}</span><span class="ll-v">{ln.face}</span>{/if}
          </div>
        </div>
      {/if}
      {#if hoverInfo.pod}
        {@const pd = hoverInfo.pod}
        <div class="loc-pod" class:allocated={pd.status === 'ALLOCATED'}>
          <div class="pd-head"><span class="pd-code">{pd.code}</span><span class="pd-status">{pd.status}</span></div>
          <div class="pd-line">{pd.position}</div>
          <div class="pd-line">{pd.product}</div>
          <div class="pd-line">Batch {pd.batches} · {pd.cases}</div>
          {#if pd.order}<div class="pd-line pd-order">{pd.order}</div>{/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if $flowState.active}
    <FlowPanel
      on:next={() => flow?.next()}
      on:restart={() => flow?.restart()}
      on:auto={() => flow?.toggleAuto()}
      on:follow={() => flow?.toggleFollow()}
      on:pause={() => flow?.togglePause()}
      on:pov={togglePickerView}
      on:scenario={(e) => flow?.runScenario(e.detail)}
      pov={mode === 'walk'}
      on:speed={(e) => flow?.setSpeed(e.detail)}
      on:close={() => flow?.stop()}
    />
  {/if}

  {#if tourActive && tourLevelInfo}
    {@const lvl = tourLevelInfo.levelSeg}
    {@const n = tourLevelInfo.spaces.length}
    <div class="level-panel" transition:fade={{ duration: 180 }}>
      <div class="lp-head">
        <span class="lp-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M3 10h18M3 15h18" />
          </svg>
        </span>
        <div class="lp-title">
          <span class="lp-label">Rack Level</span>
          <span class="lp-name">{tourLevelInfo.level}</span>
        </div>
        <span class="lp-ctx">Aisle {aisleLetterOf(tourLevelInfo.level)} · Bay {bayNameOf(tourLevelInfo.level)}</span>
        <span class="lp-count">{n} location{n === 1 ? '' : 's'}</span>
      </div>

      <!-- Level summary: the requested level dimensions + coordinates, plus a few
           geometry-derived figures that help a client read the layout at a glance. -->
      <div class="lp-stats">
        <div class="lp-stat">
          <svg class="lp-sico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 21 7v10l-9 4.5L3 17V7z" /><path d="M3 7l9 4.5L21 7M12 11.5V21" /></svg>
          <div class="lp-sbody">
            <span class="lp-sk">Dimensions <i>W × D × H</i></span>
            <span class="lp-sv">{toMetres(lvl.dimensionX)} × {toMetres(lvl.dimensionY)} × {toMetres(lvl.dimensionZ)} <u>m</u></span>
          </div>
        </div>
        <div class="lp-stat">
          <svg class="lp-sico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18" /><circle cx="12" cy="12" r="2.4" /></svg>
          <div class="lp-sbody">
            <span class="lp-sk">Coordinates</span>
            <span class="lp-sv lp-coord">
              <span class="lp-ax">X</span>{toMetres(lvl.coordinateX)}
              <span class="lp-ax">Y</span>{toMetres(lvl.coordinateY)}
              <span class="lp-ax">Z</span>{toMetres(lvl.coordinateZ)} <u>m</u>
            </span>
          </div>
        </div>
        <div class="lp-stat">
          <svg class="lp-sico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v13M7 9l5-5 5 5M5 21h14" /></svg>
          <div class="lp-sbody">
            <span class="lp-sk">Elevation</span>
            <span class="lp-sv">{toMetres(lvl.coordinateZ)} <u>m</u></span>
          </div>
        </div>
      </div>

      <!-- Per-location breakdown: code, dimensions and coordinates for every
           storage position on the shelf. Scrolls if a level is unusually wide. -->
      <div class="lp-loc">
        <div class="lp-loc-row lp-loc-head">
          <span>Location</span>
          <span>Dimensions <i>m</i></span>
          <span>Coordinates <i>X · Y · Z, m</i></span>
        </div>
        <div class="lp-loc-body">
          {#each tourLevelInfo.spaces as s (s.fullName)}
            <div class="lp-loc-row">
              <span class="lp-code">{s.fullName}</span>
              <span class="lp-celldim">{toMetres(s.dimensionX)} × {toMetres(s.dimensionY)} × {toMetres(s.dimensionZ)}</span>
              <span class="lp-cellxyz">{toMetres(s.coordinateX)} · {toMetres(s.coordinateY)} · {toMetres(s.coordinateZ)}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if tourActive && tourStackInfo}
    {@const si = tourStackInfo}
    <div class="level-panel" transition:fade={{ duration: 180 }}>
      <div class="lp-head">
        <span class="lp-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="13" width="7" height="7" rx="1" /><rect x="3" y="4" width="7" height="7" rx="1" /><rect x="14" y="13" width="7" height="7" rx="1" /><rect x="14" y="4" width="7" height="7" rx="1" />
          </svg>
        </span>
        <div class="lp-title">
          <span class="lp-label">Block Stack Level</span>
          <span class="lp-name">{si.block} · level {si.level} of {si.tiers}</span>
        </div>
        <span class="lp-ctx">Segments {si.lanes.join(' · ')}</span>
        <span class="lp-count">{si.pods.length} pod{si.pods.length === 1 ? '' : 's'}</span>
      </div>
      <div class="lp-stats">
        <div class="lp-stat">
          <svg class="lp-sico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 21 7v10l-9 4.5L3 17V7z" /><path d="M3 7l9 4.5L21 7M12 11.5V21" /></svg>
          <div class="lp-sbody"><span class="lp-sk">Segment layout</span><span class="lp-sv">{si.layout}</span></div>
        </div>
        <div class="lp-stat">
          <svg class="lp-sico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v13M7 9l5-5 5 5M5 21h14" /></svg>
          <div class="lp-sbody"><span class="lp-sk">Elevation</span><span class="lp-sv">{toMetres(si.elevation)} <u>m</u></span></div>
        </div>
        <div class="lp-stat">
          <svg class="lp-sico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10" /></svg>
          <div class="lp-sbody"><span class="lp-sk">Stock-mix policy</span><span class="lp-sv">{si.policy ?? 'untracked'}</span></div>
        </div>
      </div>
      <div class="lp-loc">
        <div class="lp-loc-row lp-loc-head bs-row">
          <span>Pod</span>
          <span>Product · batch</span>
          <span>Cases</span>
          <span>Status</span>
        </div>
        <div class="lp-loc-body">
          {#if si.pods.length === 0}
            <div class="lp-loc-row bs-row"><span class="lp-code">—</span><span class="lp-cellxyz">nothing stacked to this level yet</span><span></span><span></span></div>
          {/if}
          {#each si.pods as p (p.code)}
            <div class="lp-loc-row bs-row">
              <span class="lp-code">{p.code}</span>
              <span class="lp-celldim">{p.product}{p.batch ? ` · ${p.batch}` : ''}</span>
              <span class="lp-cellxyz">{p.cases}</span>
              <span class="bs-status" class:allocated={p.status === 'ALLOCATED'}>{p.status}{p.order ? ` · ${p.order}` : ''}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if mode === 'walk' && !$flowState.active}
    <div class="aisle-badge" class:touring={tourActive} class:paused={tourPaused} transition:fade={{ duration: 160 }}>
      <div class="ab-head">
        <span class="ab-label">Aisle</span>
        {#if tourActive}<span class="ab-tour"><span class="ab-dot"></span>{tourPaused ? 'Paused' : 'Tour'}</span>{/if}
      </div>
      {#key aisleLabel}
        <div class="ab-letter" in:scale={{ duration: 220, start: 0.7 }}>{aisleLabel || '—'}</div>
      {/key}
      {#if aisleZones}<div class="ab-zones">{aisleZones}</div>{/if}
      <div class="ab-count">{aisleIndex + 1}<span class="ab-sep">/</span>{aisleTotal}</div>
    </div>
  {/if}

  <div class="nav-ui">
    {#if mode === 'walk'}
      <div class="walk-bar">
        <button
          class="walk-exit" on:click={exitOneLevel}
          title={tourActive ? 'Exit the tour — back to the walkway' : 'Exit the walkway — back to the overview'}
        >
          {tourActive ? '✕ Exit tour' : '✕ Exit'}
        </button>
        {#if tourActive}
          <button
            class="walk-tour on" class:paused={tourPaused}
            on:click={toggleTourPause}
            title={tourPaused ? 'Resume virtual tour' : 'Pause virtual tour'}
          >
            {tourPaused ? '▶ Resume' : '❚❚ Pause'}
          </button>
          <button class="tour-speed" class:open={tourSpeedOpen}
            on:click={() => (tourSpeedOpen = !tourSpeedOpen)} title="Tour speed">
            {tourSpeed}×
            <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        {/if}
        <button class="walk-arrow" on:click={() => { stopTour(); rail.prevAisle(); }} title="Previous aisle">‹</button>
        <button class="aisle-current" on:click={() => (aislePickerOpen = !aislePickerOpen)} title="Choose aisle">
          {aisleLabel} <span class="muted">{aisleIndex + 1}/{aisleTotal}</span>
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <button class="walk-arrow" on:click={() => { stopTour(); rail.nextAisle(); }} title="Next aisle">›</button>
      </div>
    {/if}

    {#if aislePickerOpen && rail}
      <div class="aisle-picker">
        <div class="picker-title">Jump to…</div>
        <ul>
          {#each rail.aisleNames as name, i}
            <li>
              <button
                class="aisle-item"
                class:current={i === aisleIndex}
                on:click={() => { stopTour(); rail.setAisle(i); aislePickerOpen = false; }}
              >
                <span class="dot"></span>{name}
                {#if i === aisleIndex}<span class="here">current</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if tourSpeedOpen && tourActive}
      <div class="speed-picker">
        <div class="picker-title">Tour speed</div>
        <div class="speed-row">
          {#each TOUR_SPEEDS as s}
            <button class="speed-item" class:current={s === tourSpeed}
              on:click={() => { tourSpeed = s; tourSpeedOpen = false; }}>
              {s}×
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
  {#if mode === 'walk'}
    <div class="walk-hint">
      {#if tourActive && tourPaused}paused · move/look to inspect stock · hover a rack for its level · Space or Resume to continue · Esc → walkway
      {:else if tourActive}touring · Space to pause · drag or any key to take over · Esc → walkway
      {:else}drag to look · W/S move · A/D turn · Q/E up·down · ←/→ aisle · ▶ Tour · Esc → overview{/if}
    </div>
  {:else}
    <div class="walk-hint">drag to orbit · scroll to zoom · ↑/↓ move · ←/→ strafe</div>
  {/if}
</div>

<style>
  .scene-container {
    position: relative;
    flex: 1;
    overflow: hidden;
    background: #dde3ea;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .aisle-badge {
    position: absolute;
    top: 14px;
    left: 14px;
    z-index: 10;
    pointer-events: none;
    transform: scale(0.82);
    transform-origin: top left;
    min-width: 78px;
    padding: 10px 14px 11px;
    text-align: center;
    color: #e2e8f0;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    background: rgba(11, 18, 32, 0.88);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1.5px solid #334155;
    border-radius: 14px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    transition: border-color 0.25s;
  }
  .aisle-badge.touring { border-color: rgba(56, 189, 248, 0.55); }
  .aisle-badge.touring.paused { border-color: rgba(245, 158, 11, 0.6); }
  .ab-head {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .ab-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: #94a3b8;
  }
  .ab-tour {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: #38bdf8;
  }
  .ab-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #38bdf8;
    animation: ab-pulse 1.4s ease-in-out infinite;
  }
  @keyframes ab-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
  /* Paused: amber, steady (no pulse) — a held frame, not active motion. */
  .aisle-badge.paused .ab-tour { color: #fbbf24; }
  .aisle-badge.paused .ab-dot { background: #fbbf24; animation: none; }
  .ab-letter {
    font-size: 34px;
    font-weight: 700;
    line-height: 1.05;
    color: #f8fafc;
    margin-top: 2px;
  }
  .ab-zones {
    margin-top: 3px; font-size: 9.5px; letter-spacing: 0.6px; white-space: nowrap;
    color: #94a3b8; font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }
  .ab-count {
    margin-top: 3px;
    font-size: 11px;
    color: #94a3b8;
  }
  .ab-sep { color: #475569; margin: 0 4px; }
  .loc-banner {
    position: absolute;
    z-index: 10;
    pointer-events: none;
    transform: scale(0.82);
    transform-origin: top left;
    min-width: 156px;
    padding: 13px 18px 14px;
    text-align: center;
    color: #e2e8f0;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    background: rgba(11, 18, 32, 0.9);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1.5px solid #334155;
    border-radius: 14px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  /* The scale must grow from whichever corner the banner is anchored to. */
  .loc-banner.flip-x { transform-origin: top right; }
  .loc-banner.flip-y { transform-origin: bottom left; }
  .loc-banner.flip-x.flip-y { transform-origin: bottom right; }

  /* Pod label preview: centred modal over a dimmed backdrop, showing the ZPL
     rendered to an image plus the key pod fields. */
  .pod-overlay {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(2, 6, 23, 0.62);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
  }
  .pod-card {
    display: flex;
    flex-direction: column;
    max-height: 100%;
    width: min(360px, 90vw);
    color: #e2e8f0;
    background: rgba(11, 18, 32, 0.96);
    border: 1.5px solid #334155;
    border-radius: 16px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    overflow: hidden;
  }
  .pod-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  }
  .pod-titles { display: flex; flex-direction: column; gap: 2px; }
  .pod-label {
    font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
    color: #7dd3fc; font-weight: 700;
  }
  .pod-loc {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 18px; font-weight: 700; color: #f1f5f9;
  }
  .pod-close {
    flex: none; width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
    color: #cbd5e1; background: rgba(148, 163, 184, 0.12);
    border: 1px solid rgba(148, 163, 184, 0.2); font-size: 13px; line-height: 1;
    transition: background 0.15s, color 0.15s;
  }
  .pod-close:hover { background: rgba(239, 68, 68, 0.2); color: #fecaca; }
  .pod-body {
    display: flex; align-items: center; justify-content: center;
    padding: 16px; min-height: 200px; overflow: auto;
    background: rgba(148, 163, 184, 0.05);
  }
  .pod-img {
    max-width: 100%; height: auto; border-radius: 6px;
    background: #fff; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  }
  .pod-state {
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; color: #94a3b8;
  }
  .pod-state.pod-err { flex-direction: column; color: #fca5a5; text-align: center; }
  .pod-spinner {
    width: 18px; height: 18px; border-radius: 50%;
    border: 2px solid rgba(148, 163, 184, 0.3); border-top-color: #7dd3fc;
    animation: pod-spin 0.7s linear infinite;
  }
  @keyframes pod-spin { to { transform: rotate(360deg); } }
  .pod-retry {
    cursor: pointer; padding: 5px 14px; border-radius: 8px; font-size: 12px;
    color: #e2e8f0; background: rgba(56, 189, 248, 0.15);
    border: 1px solid rgba(56, 189, 248, 0.35);
  }
  .pod-retry:hover { background: rgba(56, 189, 248, 0.25); }

  /* Tour level showcase: floating panel detailing the inspected shelf — a
     summary header, level-summary stat strip, and a per-location table. */
  .level-panel {
    position: absolute;
    left: 50%;
    bottom: 64px;
    transform: translateX(-50%) scale(0.82);
    transform-origin: bottom center;
    z-index: 11;
    pointer-events: none;
    width: min(720px, calc(100% - 40px));
    color: #e2e8f0;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.94), rgba(9, 14, 26, 0.94));
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1.5px solid #334155;
    border-radius: 16px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);
    overflow: hidden;
  }

  /* Header band */
  .lp-head {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px;
    background: linear-gradient(90deg, rgba(56, 189, 248, 0.12), rgba(56, 189, 248, 0));
    border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  }
  .lp-badge {
    flex: none; display: grid; place-items: center;
    width: 34px; height: 34px; border-radius: 9px;
    color: #38bdf8;
    background: rgba(56, 189, 248, 0.12);
    border: 1px solid rgba(56, 189, 248, 0.35);
  }
  .lp-badge svg { width: 19px; height: 19px; }
  .lp-title { display: flex; flex-direction: column; gap: 1px; }
  .lp-label {
    font-size: 9.5px; font-weight: 600; letter-spacing: 1.6px;
    text-transform: uppercase; color: #64748b;
  }
  .lp-name { font-size: 20px; font-weight: 700; letter-spacing: 0.6px; color: #f8fafc; line-height: 1; }
  .lp-ctx {
    margin-left: auto;
    font-size: 11px; letter-spacing: 0.3px; color: #94a3b8;
  }
  .lp-count {
    font-size: 11px; font-weight: 600; letter-spacing: 0.3px; color: #38bdf8;
    padding: 4px 10px; border-radius: 999px;
    background: rgba(56, 189, 248, 0.1);
    border: 1px solid rgba(56, 189, 248, 0.32);
  }

  /* Level-summary stat strip */
  .lp-stats {
    display: flex; flex-wrap: wrap;
    padding: 11px 8px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.14);
  }
  .lp-stat {
    display: flex; align-items: center; gap: 9px;
    flex: 1 1 auto; min-width: 0;
    padding: 3px 12px;
  }
  .lp-stat + .lp-stat { border-left: 1px solid rgba(148, 163, 184, 0.12); }
  .lp-sico { width: 17px; height: 17px; flex: none; color: #38bdf8; opacity: 0.95; }
  .lp-sbody { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .lp-sk {
    font-size: 9px; font-weight: 600; letter-spacing: 0.9px;
    text-transform: uppercase; color: #64748b; white-space: nowrap;
  }
  .lp-sk i { font-style: normal; color: #475569; letter-spacing: 0.4px; }
  .lp-sv { font-size: 13.5px; font-weight: 600; color: #f1f5f9; white-space: nowrap; }
  .lp-sv u { text-decoration: none; margin-left: 2px; font-size: 10px; color: #38bdf8; }
  .lp-coord { display: inline-flex; align-items: baseline; gap: 4px; }
  .lp-ax {
    font-size: 8.5px; font-weight: 700; letter-spacing: 0.4px; color: #64748b;
    padding: 0 1px;
  }
  .lp-ax:not(:first-child) { margin-left: 4px; }

  /* Per-location table */
  .lp-loc { padding: 4px 6px 8px; }
  .lp-loc-row {
    display: grid;
    grid-template-columns: minmax(86px, 1fr) minmax(150px, 1.3fr) minmax(150px, 1.3fr);
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border-radius: 8px;
  }
  .lp-loc-head span {
    font-size: 9px; font-weight: 600; letter-spacing: 1px;
    text-transform: uppercase; color: #64748b;
  }
  .lp-loc-head i { font-style: normal; color: #475569; letter-spacing: 0.4px; }
  .lp-loc-body { display: flex; flex-direction: column; gap: 2px; max-height: 168px; overflow-y: auto; }
  .lp-loc-body .lp-loc-row:nth-child(odd) { background: rgba(148, 163, 184, 0.05); }
  .lp-code {
    font-size: 13px; font-weight: 700; letter-spacing: 0.5px; color: #38bdf8;
  }
  .lp-celldim, .lp-cellxyz { font-size: 12px; color: #cbd5e1; white-space: nowrap; }
  .lp-cellxyz { color: #94a3b8; }
  /* Block Stack Level rows: pallet · product/batch · cases · status. */
  .bs-row { grid-template-columns: 96px 1fr 56px 150px; }
  .bs-status { font-size: 10px; font-weight: 700; letter-spacing: 0.6px; color: #38bdf8; white-space: nowrap; }
  .bs-status.allocated { color: #fbbf24; }
  .lp-loc-body::-webkit-scrollbar { width: 6px; }
  .lp-loc-body::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.3); border-radius: 3px; }

  .loc-name {
    font-size: 26px;
    font-weight: 700;
    line-height: 1.05;
    letter-spacing: 0.5px;
    color: #f8fafc;
  }
  .loc-type {
    margin-top: 4px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: #38bdf8;
  }
  /* Dimensions: the hero metric — three labelled columns (spelled out for any
     audience), each value in metres with the unit. */
  .loc-dims {
    margin-top: 11px;
    padding-top: 10px;
    border-top: 1px solid rgba(148, 163, 184, 0.18);
    display: flex;
    justify-content: center;
    gap: 16px;
    white-space: nowrap;
  }
  .dim { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .dim-axis {
    font-size: 9px; font-weight: 600; letter-spacing: 0.8px;
    text-transform: uppercase; color: #64748b;
  }
  .dim-val { font-size: 15px; font-weight: 600; color: #f1f5f9; }
  .dim-u { margin-left: 2px; font-size: 10px; font-weight: 600; color: #38bdf8; }
  /* Position: secondary line, also in metres. */
  .loc-pos {
    margin-top: 6px;
    font-size: 11px;
    color: #94a3b8;
    white-space: nowrap;
  }
  .loc-label {
    margin-right: 7px;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.8px;
    color: #64748b;
  }
  .loc-unit { margin-left: 5px; color: #64748b; }
  /* Block-stack lane summary + pallet detail on the tooltip. */
  .loc-lane {
    margin-top: 10px; padding-top: 9px;
    border-top: 1px solid rgba(148, 163, 184, 0.18);
    text-align: left;
  }
  .ll-grid {
    display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; align-items: baseline;
    font-size: 11px; white-space: nowrap;
  }
  .ll-k { font-size: 9px; font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; color: #64748b; }
  .ll-v { color: #e2e8f0; font-weight: 600; }
  .ll-dim { color: #64748b; font-weight: 500; }
  .ll-muted { color: #94a3b8; font-weight: 500; }
  .ll-alloc {
    margin-left: 8px; padding: 1px 7px; border-radius: 999px;
    font-size: 9px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase;
    color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.5);
  }
  .loc-pod {
    margin-top: 10px; padding: 8px 10px 9px; text-align: left;
    border-radius: 10px; background: rgba(56, 189, 248, 0.08);
    border: 1px solid rgba(56, 189, 248, 0.35);
  }
  .loc-pod.allocated { background: rgba(251, 191, 36, 0.08); border-color: rgba(251, 191, 36, 0.45); }
  .pd-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .pd-code { font-size: 13px; font-weight: 700; letter-spacing: 0.5px; color: #7dd3fc; }
  .loc-pod.allocated .pd-code { color: #fcd34d; }
  .pd-status {
    font-size: 9px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase;
    padding: 1px 7px; border-radius: 999px; color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.5);
  }
  .loc-pod.allocated .pd-status { color: #fbbf24; border-color: rgba(251, 191, 36, 0.5); }
  .pd-line { margin-top: 4px; font-size: 11px; color: #cbd5e1; white-space: nowrap; }
  .pd-order { color: #fcd34d; }
  .nav-ui {
    position: absolute; top: 14px; right: 14px; z-index: 10;
    transform: scale(0.82);
    transform-origin: top right;
    display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  }
  .chev { width: 13px; height: 13px; color: #64748b; flex: none; transition: transform 0.15s; }
  .walk-bar {
    display: flex; align-items: center; gap: 5px;
    background: rgba(11, 18, 32, 0.88);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1.5px solid #334155; border-radius: 999px;
    padding: 5px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.45);
  }
  .walk-exit {
    background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35);
    color: #f87171; padding: 6px 14px; border-radius: 999px; cursor: pointer;
    font-size: 12px; font-family: monospace; transition: background 0.15s;
  }
  .walk-exit:hover { background: rgba(239, 68, 68, 0.25); }
  .walk-tour {
    background: rgba(59, 130, 246, 0.14); border: 1px solid rgba(59, 130, 246, 0.4);
    color: #93c5fd; padding: 6px 14px; border-radius: 999px; cursor: pointer;
    font-size: 12px; font-family: monospace; transition: background 0.15s, color 0.15s;
  }
  .walk-tour:hover { background: rgba(59, 130, 246, 0.26); }
  .walk-tour.on {
    background: #2563eb; border-color: #2563eb; color: #fff;
  }
  .walk-tour.on:hover { background: #3b82f6; }
  /* Paused: amber so the frozen state reads at a glance during a demo. */
  .walk-tour.on.paused {
    background: rgba(245, 158, 11, 0.16); border-color: rgba(245, 158, 11, 0.5); color: #fbbf24;
  }
  .walk-tour.on.paused:hover { background: rgba(245, 158, 11, 0.28); }
  .walk-arrow {
    background: transparent; border: none; color: #94a3b8; cursor: pointer;
    width: 28px; height: 28px; border-radius: 50%; font-size: 17px; line-height: 1;
    display: grid; place-items: center; transition: background 0.15s, color 0.15s;
  }
  .walk-arrow:hover { background: #1e293b; color: #e2e8f0; }
  .aisle-current {
    background: transparent; border: none; color: #e2e8f0; cursor: pointer;
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 13px; font-family: monospace; padding: 5px 8px; border-radius: 999px;
    transition: background 0.15s;
  }
  .aisle-current:hover { background: #1e293b; }
  .muted { opacity: 0.55; }
  .tour-speed {
    display: inline-flex; align-items: center; gap: 3px;
    background: rgba(59, 130, 246, 0.14); border: 1px solid rgba(59, 130, 246, 0.4);
    color: #93c5fd; cursor: pointer;
    font-size: 12px; font-family: monospace; padding: 6px 8px 6px 11px; border-radius: 999px;
    transition: background 0.15s, color 0.15s;
  }
  .tour-speed:hover, .tour-speed.open { background: rgba(59, 130, 246, 0.26); color: #dbeafe; }
  .tour-speed .chev { width: 12px; height: 12px; color: currentColor; }
  .speed-picker {
    padding: 6px;
    background: rgba(11, 18, 32, 0.95);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid #334155; border-radius: 14px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  }
  .speed-row { display: flex; flex-wrap: wrap; gap: 5px; max-width: 184px; }
  .speed-item {
    background: transparent; border: 1px solid transparent; cursor: pointer;
    color: #cbd5e1; font-family: monospace; font-size: 12px;
    padding: 6px 10px; border-radius: 8px; transition: background 0.1s, color 0.1s;
  }
  .speed-item:hover { background: rgba(59, 130, 246, 0.16); color: #e2e8f0; }
  .speed-item.current {
    color: #fff; background: #2563eb; border-color: #2563eb;
  }
  .aisle-picker {
    width: 210px; padding: 6px;
    background: rgba(11, 18, 32, 0.95);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid #334155; border-radius: 14px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    max-height: 320px; overflow-y: auto;
  }
  .picker-title {
    font-size: 9px; font-family: monospace; letter-spacing: 1.2px; text-transform: uppercase;
    color: #64748b; padding: 5px 11px 7px;
  }
  .aisle-picker ul { margin: 0; padding: 0; list-style: none; }
  .aisle-picker li { margin: 0; padding: 0; }
  .aisle-item {
    width: 100%; display: flex; align-items: center; gap: 9px;
    background: transparent; border: none; cursor: pointer;
    padding: 7px 11px; border-radius: 8px; color: #cbd5e1;
    font-family: monospace; font-size: 12px; text-align: left;
    transition: background 0.1s;
  }
  .aisle-item:hover { background: rgba(59, 130, 246, 0.16); color: #e2e8f0; }
  .aisle-item.current { color: #60a5fa; }
  .aisle-item .dot {
    width: 7px; height: 7px; border-radius: 50%; flex: none;
    background: #3b82f6; opacity: 0.8;
  }
  .here {
    margin-left: auto; flex: none; font-size: 9px; font-style: normal;
    color: #60a5fa; border: 1px solid currentColor; border-radius: 999px; padding: 1px 7px;
  }
  /* Themed scrollbars for the dropdown panels (default white track clashes
     with the dark UI). */
  .aisle-picker {
    scrollbar-width: thin;                      /* Firefox */
    scrollbar-color: #334155 transparent;
  }
  .aisle-picker::-webkit-scrollbar { width: 8px; }
  .aisle-picker::-webkit-scrollbar-track { background: transparent; }
  .aisle-picker::-webkit-scrollbar-button { display: none; height: 0; }
  .aisle-picker::-webkit-scrollbar-thumb {
    background: #334155; border-radius: 999px;
    border: 2px solid transparent; background-clip: padding-box;
  }
  .aisle-picker::-webkit-scrollbar-thumb:hover {
    background: #475569; background-clip: padding-box; border: 2px solid transparent;
  }
  .walk-hint {
    position: absolute; bottom: 16px; left: 50%;
    transform: translateX(-50%) scale(0.82); transform-origin: bottom center;
    z-index: 10; background: rgba(0, 0, 0, 0.75); color: #e2e8f0;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border: 1px solid rgba(148, 163, 184, 0.25);
    padding: 9px 18px; border-radius: 999px; font-size: 14px;
    font-family: monospace; pointer-events: none; white-space: nowrap;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
</style>
