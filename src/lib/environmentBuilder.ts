import * as THREE from 'three';
import type { Segment } from '../types';
import type { RackRow } from './rackBuilder';
import { mulberry32 } from './rng';

export const ENV = {
  MARGIN_END: 40000,    // clear floor at the aisle-entrance ends (X) — sets building length
  MARGIN_SIDE: 70000,  // clear floor flanking the outer rack rows (Z) — sets building width
  EAVE_ABOVE_RACKS: 10000,
  COLUMN: 300,          // wall column cross-section
  COLUMN_SPACING: 8000, // per the building elevation drawing
  RAFTER: { w: 250, h: 500 },
  LIGHT_SPACING: 12000,
  LIGHT_DROP: 1800,     // fixture hangs this far below the rafters
};

export const ENV_COLORS = {
  floor: 0xa8a8a4, // concrete grey, matching the -changes build's floor texture base

  cladding: 0xeef1f3,
  dado: 0xb9bfc4,
  ceiling: 0xf7f9fa,
  steel: 0x2a5ca8,
  marking: 0xd9a514,
  lightFixture: 0xfff7df,
  lightRod: 0x8d949b,
};

// Subtle vertical-rib steel cladding with a darker dado band at the bottom.
function makeCladdingTexture(repeats: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#eef1f3';
  ctx.fillRect(0, 0, 256, 256);
  for (let x = 0; x < 256; x += 32) {
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    ctx.fillRect(x, 0, 5, 256);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(x + 5, 0, 3, 256);
  }
  ctx.fillStyle = '#b9bfc4';
  ctx.fillRect(0, 256 - 30, 256, 30);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(repeats, 1);
  tex.anisotropy = 4;
  return tex;
}

// Polished-concrete floor: a smooth grey base with soft tonal blotches, fine
// speckle and faint polish streaks (colour map), plus a varying-gloss roughness
// map so some patches catch the light more — which, with the env map, gives the
// wet, reflective sheen of a real warehouse slab. No grid/tile lines.
function makeFloorTextures(): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const S = 512;
  const rnd = mulberry32(717);

  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#938b7a'; // warm beige-grey concrete (matches the reference photo)
  ctx.fillRect(0, 0, S, S);
  // large soft tonal blotches — the cloudy troweled/stained unevenness
  for (let i = 0; i < 56; i++) {
    const x = rnd() * S, y = rnd() * S, r = 50 + rnd() * 160;
    const lighter = rnd() > 0.5;
    const shade = lighter ? '208,201,186' : '146,138,122';
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${shade},${0.06 + rnd() * 0.11})`);
    g.addColorStop(1, `rgba(${shade},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // fine aggregate speckle
  for (let i = 0; i < 5000; i++) {
    const a = 0.03 + rnd() * 0.06;
    ctx.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(55,55,52,${a})`;
    ctx.fillRect(rnd() * S, rnd() * S, 1, 1);
  }
  // faint directional polish streaks
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(214,207,192,${0.015 + rnd() * 0.025})`;
    ctx.fillRect(0, rnd() * S, S, 1);
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;

  // Roughness: mid-grey base (≈0.7 reflectivity) with glossier patches, so the
  // sheen pools unevenly the way a polished slab does.
  const rc = document.createElement('canvas');
  rc.width = rc.height = S;
  const rx = rc.getContext('2d')!;
  rx.fillStyle = '#b4b4b4';
  rx.fillRect(0, 0, S, S);
  for (let i = 0; i < 44; i++) {
    const x = rnd() * S, y = rnd() * S, r = 60 + rnd() * 170;
    const v = 120 + Math.floor(rnd() * 110); // darker = glossier patch
    const g = rx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${v},${v},${v},0.5)`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    rx.fillStyle = g;
    rx.beginPath();
    rx.arc(x, y, r, 0, Math.PI * 2);
    rx.fill();
  }
  const rough = new THREE.CanvasTexture(rc);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  rough.anisotropy = 8;

  return { map, rough };
}

// Concrete slab, portal-frame building shell (inward-facing cladding walls,
// steel columns, roof rafters, flat deck), aisle markings and high-bay
// lights, all sized from the segment data bounding box. Walls/ceiling face
// inward only, so outside views stay unobstructed (dollhouse effect).
export interface ShellBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  eaveH: number;
}

// shellSegments: the segments the building is sized around (defaults to all).
// The scene passes the racking only, so block-stack floor storage laid out in
// the margins doesn't push the walls out.
export function buildEnvironment(
  segments: Segment[],
  rows: RackRow[],
  env: THREE.Texture | null = null,
  shellSegments: Segment[] = segments,
): { group: THREE.Group; shell: ShellBounds; roof: THREE.Mesh; dispose: () => void } {
  const group = new THREE.Group();
  group.name = 'ENVIRONMENT';
  const disposables: { dispose(): void }[] = [];

  // Bounds in three.js space: x ← coordinateX, y(up) ← coordinateZ, z ← coordinateY.
  const bounds = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const s of shellSegments) {
    bounds.expandByPoint(v.set(s.coordinateX, s.coordinateZ, s.coordinateY));
    bounds.expandByPoint(v.set(
      s.coordinateX + s.dimensionX,
      s.coordinateZ + s.dimensionZ,
      s.coordinateY + s.dimensionY,
    ));
  }
  const minX = bounds.min.x - ENV.MARGIN_END;
  const maxX = bounds.max.x + ENV.MARGIN_END;
  const minZ = bounds.min.z - ENV.MARGIN_SIDE;
  const maxZ = bounds.max.z + ENV.MARGIN_SIDE;
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const eaveH = bounds.max.y + ENV.EAVE_ABOVE_RACKS;

  const noRaycast = (m: THREE.Object3D) => { m.raycast = () => {}; };

  // Polished concrete slab — smooth, continuous, lightly reflective (no grid).
  const floorTex = makeFloorTextures();
  floorTex.map.repeat.set(Math.max(1, spanX / 26000), Math.max(1, spanZ / 26000));
  floorTex.rough.repeat.copy(floorTex.map.repeat);
  disposables.push(floorTex.map, floorTex.rough);
  const floorGeom = new THREE.PlaneGeometry(spanX, spanZ);
  floorGeom.rotateX(-Math.PI / 2);
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex.map,
    roughnessMap: floorTex.rough,
    roughness: 0.66,       // mostly matte concrete; the map adds glossier patches
    metalness: 0,
    envMap: env,
    envMapIntensity: 0.3,  // gentle sheen only, so the grey concrete colour reads
  });
  disposables.push(floorGeom, floorMat);
  const floor = new THREE.Mesh(floorGeom, floorMat);
  floor.position.set(centerX, 0, centerZ);
  noRaycast(floor);
  group.add(floor);

  // Cladding walls: front-side planes facing inward — culled from outside.
  // Grouped under one node so the roof toggle can hide all four walls for a
  // clean, open overview from any angle.
  const RIB_PITCH = 8000; // one texture tile (8 ribs) per 8m of wall
  const walls: Array<{ len: number; x: number; z: number; rotY: number }> = [
    { len: spanX, x: centerX, z: minZ, rotY: 0 },
    { len: spanX, x: centerX, z: maxZ, rotY: Math.PI },
    { len: spanZ, x: minX, z: centerZ, rotY: Math.PI / 2 },
    { len: spanZ, x: maxX, z: centerZ, rotY: -Math.PI / 2 },
  ];
  const wallGroup = new THREE.Group();
  wallGroup.name = 'SHELL_WALLS';
  for (const w of walls) {
    const geom = new THREE.PlaneGeometry(w.len, eaveH);
    const tex = makeCladdingTexture(w.len / RIB_PITCH);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.05 });
    disposables.push(geom, tex, mat);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(w.x, eaveH / 2, w.z);
    mesh.rotation.y = w.rotY;
    noRaycast(mesh);
    wallGroup.add(mesh);
  }
  group.add(wallGroup);

  // Roof deck: faces down, culled from above.
  const ceilGeom = new THREE.PlaneGeometry(spanX, spanZ);
  ceilGeom.rotateX(Math.PI / 2);
  const ceilMat = new THREE.MeshStandardMaterial({ color: ENV_COLORS.ceiling, roughness: 1, metalness: 0 });
  disposables.push(ceilGeom, ceilMat);
  const ceiling = new THREE.Mesh(ceilGeom, ceilMat);
  ceiling.name = 'ROOF_DECK';
  ceiling.position.set(centerX, eaveH, centerZ);
  noRaycast(ceiling);
  group.add(ceiling);

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(unitBox);
  const dummy = new THREE.Object3D();
  const setBox = (
    inst: THREE.InstancedMesh, i: number,
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
  ) => {
    dummy.position.set(x, y, z);
    dummy.scale.set(sx, sy, sz);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  };

  // Wall columns on the column grid; rafters span the depth at each grid line.
  const steelMat = new THREE.MeshStandardMaterial({ color: ENV_COLORS.steel, roughness: 0.55, metalness: 0.35 });
  disposables.push(steelMat);
  const nGridX = Math.max(1, Math.round(spanX / ENV.COLUMN_SPACING));
  const nGridZ = Math.max(1, Math.round(spanZ / ENV.COLUMN_SPACING));
  const gridX: number[] = [];
  for (let i = 0; i <= nGridX; i++) gridX.push(minX + (spanX * i) / nGridX);
  const gridZ: number[] = [];
  for (let i = 0; i <= nGridZ; i++) gridZ.push(minZ + (spanZ * i) / nGridZ);

  const inset = ENV.COLUMN / 2 + 20;
  const columnCount = gridX.length * 2 + Math.max(0, gridZ.length - 2) * 2;
  const rafterCount = gridX.length;
  // Vertical perimeter columns are their own mesh so they can stay standing when
  // the roof is hidden; only the overhead rafters drop away for the top view.
  const columns = new THREE.InstancedMesh(unitBox, steelMat, columnCount);
  columns.name = 'SHELL_COLUMNS';
  noRaycast(columns);
  let ci = 0;
  for (const x of gridX) {
    setBox(columns, ci++, x, eaveH / 2, minZ + inset, ENV.COLUMN, eaveH, ENV.COLUMN);
    setBox(columns, ci++, x, eaveH / 2, maxZ - inset, ENV.COLUMN, eaveH, ENV.COLUMN);
  }
  for (const z of gridZ.slice(1, -1)) {
    setBox(columns, ci++, minX + inset, eaveH / 2, z, ENV.COLUMN, eaveH, ENV.COLUMN);
    setBox(columns, ci++, maxX - inset, eaveH / 2, z, ENV.COLUMN, eaveH, ENV.COLUMN);
  }
  columns.count = ci;
  columns.instanceMatrix.needsUpdate = true;
  columns.computeBoundingSphere();
  group.add(columns);

  // Overhead rafters: spanning beams at eave level, part of the roof structure.
  const rafters = new THREE.InstancedMesh(unitBox, steelMat, rafterCount);
  rafters.name = 'SHELL_RAFTERS';
  noRaycast(rafters);
  let ri = 0;
  for (const x of gridX) {
    setBox(rafters, ri++, x, eaveH - ENV.RAFTER.h / 2, centerZ, ENV.RAFTER.w, ENV.RAFTER.h, spanZ);
  }
  rafters.count = ri;
  rafters.instanceMatrix.needsUpdate = true;
  rafters.computeBoundingSphere();
  group.add(rafters);

  // Yellow line along each rack row's aisle-facing edge. Which edge faces the
  // aisle is decided against the aisle volume's centerline.
  const aisleCenters = new Map<string, number>();
  const aisles: Segment[] = [];
  for (const s of segments) {
    if (s.type !== 'AISLE') continue;
    aisles.push(s);
    aisleCenters.set(s.fullName.toUpperCase(), s.coordinateY + s.dimensionY / 2);
  }
  const markMat = new THREE.MeshBasicMaterial({ color: ENV_COLORS.marking });
  disposables.push(markMat);
  const markings = new THREE.InstancedMesh(unitBox, markMat, rows.length);
  markings.name = 'AISLE_MARKINGS';
  noRaycast(markings);
  let mi = 0;
  for (const row of rows) {
    const aisleC = aisleCenters.get(row.aisle);
    if (aisleC === undefined || row.bays.length === 0) continue;
    const first = row.bays[0];
    const last = row.bays[row.bays.length - 1];
    const xMin = first.coordinateX - 100;
    const xMax = last.coordinateX + last.dimensionX + 100;
    const facesAisleFront = row.y + row.depth / 2 < aisleC;
    const z = facesAisleFront ? row.y + row.depth + 60 : row.y - 60;
    setBox(markings, mi++, (xMin + xMax) / 2, 6, z, xMax - xMin, 4, 100);
  }
  markings.count = mi;
  markings.instanceMatrix.needsUpdate = true;
  markings.computeBoundingSphere();
  group.add(markings);

  // High-bay light fixtures in rows down each aisle, hung from the rafter
  // level on drop rods (plain unlit material — no real lights, zero cost).
  const rodTop = eaveH - ENV.RAFTER.h;
  const fixtureY = rodTop - ENV.LIGHT_DROP;
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 16);
  disposables.push(unitCyl);
  const fixtureMat = new THREE.MeshBasicMaterial({ color: ENV_COLORS.lightFixture });
  const rodMat = new THREE.MeshStandardMaterial({ color: ENV_COLORS.lightRod, roughness: 0.6, metalness: 0.4 });
  disposables.push(fixtureMat, rodMat);

  let lightCount = 0;
  const aisleLights = aisles.map((a) => {
    const n = Math.max(2, Math.round(a.dimensionX / ENV.LIGHT_SPACING));
    lightCount += n;
    return n;
  });
  const fixtures = new THREE.InstancedMesh(unitCyl, fixtureMat, lightCount);
  fixtures.name = 'LIGHT_FIXTURES';
  noRaycast(fixtures);
  const rods = new THREE.InstancedMesh(unitCyl, rodMat, lightCount);
  rods.name = 'LIGHT_RODS';
  noRaycast(rods);
  let li = 0;
  aisles.forEach((a, ai) => {
    const n = aisleLights[ai];
    const step = a.dimensionX / n;
    const zC = a.coordinateY + a.dimensionY / 2;
    for (let i = 0; i < n; i++) {
      const x = a.coordinateX + step * (i + 0.5);
      dummy.position.set(x, fixtureY, zC);
      dummy.scale.set(230, 260, 230);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      fixtures.setMatrixAt(li, dummy.matrix);
      dummy.position.set(x, (fixtureY + 130 + rodTop) / 2, zC);
      dummy.scale.set(25, rodTop - fixtureY - 130, 25);
      dummy.updateMatrix();
      rods.setMatrixAt(li, dummy.matrix);
      li++;
    }
  });
  fixtures.instanceMatrix.needsUpdate = true;
  fixtures.computeBoundingSphere();
  rods.instanceMatrix.needsUpdate = true;
  rods.computeBoundingSphere();
  group.add(fixtures, rods);

  return {
    group,
    shell: { minX, maxX, minZ, maxZ, eaveH },
    roof: ceiling,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
