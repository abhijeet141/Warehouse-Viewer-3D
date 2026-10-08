import { seededRng } from './rng';

// Pod label preview for the demo stock. Clicking an occupied pallet generates
// deterministic pod details (so the same pallet always shows the same label),
// fills them into the FloWMS ZPL template, and renders that ZPL to a PNG via the
// Labelary public API (https://labelary.com) for an on-screen preview.
//
// NOTE: rendering POSTs the (demo-only) ZPL to the third-party Labelary service.
// No real/sensitive data leaves the app — every value here is synthetic.

export interface PodData {
  PodUuid: string;
  PodUuidShort: string;
  AccountName: string;
  WarehouseName: string;
  BreakPod: string;
  PodCreated: string;
}

// Deterministic pod details for a location, keyed by its name so a given pallet
// is stable across clicks/reloads. Seeded independently of the goods builder's
// own draws (distinct salt) — it only needs to be repeatable, not aligned.
export function generatePodData(fullName: string): PodData {
  const r = seededRng('pod:' + fullName);

  // UUID v4-style 8-4-4-4-12 hex; the short form is the first block (chars 0..8).
  let hex = '';
  for (let i = 0; i < 32; i++) hex += Math.floor(r() * 16).toString(16);
  const PodUuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const PodUuidShort = hex.slice(0, 8); // PodUuid[0:8]

  const AccountName = `Account ${1 + Math.floor(r() * 10)}`; // Account 1..10

  // A created date strictly before today (1 day to ~2 years back). Different
  // pallets land on different days, but collisions are fine and do happen.
  const daysBack = 1 + Math.floor(r() * 720);
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  const PodCreated = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;

  return {
    PodUuid,
    PodUuidShort,
    AccountName,
    WarehouseName: 'Sundance',
    BreakPod: 'No', // fixed "No" for all demo pods for now
    PodCreated,
  };
}

// The FloWMS pod label, with Go-template-style {{ .Field}} placeholders.
const ZPL_TEMPLATE = String.raw`^XA^CI28~JSN~TA000
^FX ***** XA = Start ZPL. Options: JS = Change Backfeed Sequence to Normal. TA = Tear Off Adjustment Position to 0. *****

^FX ***************************************
^FX ***** Start of Label Config Reset *****
^FX ***************************************

^FX ***** Label Top = 10. This prevents the label from being sucked back into the printer to far. *****
^LT10

^FX ***** Print Mode = Tear-Off. *****
^MMT

^FX ***** Media Tracking = Non-Continuous Media Web Sensing. *****
^MNW

^FX ***** LR = Label Reverse Print. This tells the printer to act normally and print Black lines on White media. *****
^LRN

^FX ***************************************
^FX ****** End of Label Config Reset ******
^FX ***************************************

^FX ***** Set the Label Home Position *****
^LH64,32
^FS

^FX ***** Draw the Main Box *****
^FO0,0
^GB672,1116,4,B,0
^FS

^FX ***************************************

^FX Pod UUID (Short) Box
^FO0,0
^GB476,200,4
^FS

^FO16,16
^A0N,40,40
^FDPod UUID (Short)
^FS

^FO16,88
^A0N,90,100
^FH
^FD{{ .PodUuidShort}}
^FS

^FX ***************************************

^FX FloWMS Logo Box
^FO472,0
^GB200,200,100
^FS

^FX FloWMS Title
^FO504,84
^A0N,40,40
^FR
^FDFloWMS
^FS

^FX ***************************************

^FX Code128 Box
^FO0,196
^GB256,920,4
^FS

^FO16,226
^A0R,32,46
^FH
^FD{{ .PodUuid}}
^FS

^FX Code 128 Barcode
^FO72,226
^BY2
^BCR,134,N,N,N,N
^A0N,32,46
^FH
^FD{{ .PodUuid}}
^FS

^FX ***************************************

^FX Data Matrix Box
^FO252,196
^GB420,420,4
^FS

^FX Datamatrix Barcode
^FO296,236
^BY,,340
^BXN,,200,,,3,,1
^FH
^FD{{ .PodUuid}}
^FS

^FX ***************************************

^FX Account Code Box
^FO252,612
^GB420,129,4
^FS

^FO268,628
^A0N,40,40
^FDAccount
^FS

^FO268,676
^A0N,60,60
^FH
^FD{{ .AccountName}}
^FS

^FX ***************************************

^FX Warehouse Code Box
^FO252,737
^GB420,129,4
^FS

^FO268,753
^A0N,40,40
^FDWarehouse
^FS

^FO268,801
^A0N,60,60
^FH
^FD{{ .WarehouseName}}
^FS

^FX ***************************************

^FX Break Pod Box
^FO252,862
^GB420,129,4
^FS

^FO268,878
^A0N,40,40
^FDBreak Pod?
^FS

^FO268,926
^A0N,60,60
^FH
^FD{{ .BreakPod}}
^FS

^FX ***************************************

^FX Pod Created Date Time Box
^FO252,987
^GB420,129,4
^FS

^FO268,1003
^A0N,40,40
^FDPod Created (Y/M/D)
^FS

^FO268,1051
^A0N,60,60
^FH
^FD{{ .PodCreated}}
^FS

^FX ***************************************

^FX ***************************************
^FX ******* Lets be good and Reset ********
^FX ***************************************

^FX ***** Label Top = 0. *****
^LT0

^FX ***** LR = Label Reverse Print. This tells the printer to act normally and print Black lines on White media. *****
^LRN

^FX ***** Set the Label Home Position *****
^LH0,0
^FS

^FX ***************************************
^FX ******* Lets be good and Reset ********
^FX ***************************************

^XZ`;

// Substitute {{ .Field}} placeholders with the pod values.
export function fillZpl(data: PodData): string {
  const fields = data as unknown as Record<string, string>;
  return ZPL_TEMPLATE.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_m, key: string) =>
    key in fields ? String(fields[key]) : '',
  );
}

// Render any ZPL to a PNG object URL via Labelary, at the given label size (in
// inches, e.g. '4x6'). The caller owns the returned URL and must
// URL.revokeObjectURL() it when done. The ZPL is sent as a multipart `file`
// field (Labelary's documented form), so its ^/~ control chars and any special
// characters pass through untouched — a raw string body would be sent as
// text/plain, which Labelary rejects with HTTP 415.
async function renderZpl(zpl: string, size: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([zpl], { type: 'text/plain' }), 'label.zpl');
  const res = await fetch(`https://api.labelary.com/v1/printers/8dpmm/labels/${size}/0/`, {
    method: 'POST',
    headers: { Accept: 'image/png' },
    body: form,
  });
  if (!res.ok) throw new Error(`Labelary returned ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// Full per-pod label (UUID, barcode, data matrix, account, date) — the click-to-
// open detail popup. 4x6" fits the 672x1116-dot layout with the 64,32 home
// offset and a margin to spare.
export function renderPodLabel(data: PodData): Promise<string> {
  return renderZpl(fillZpl(data), '4x6');
}

// A simple branded FloWMS tag, identical on every pod — no per-pod data, so it's
// rendered ONCE and shared as a single texture across all pods (cheap, instanced).
// 2.5x1.5" landscape, sized to read as a sticker on the load's aisle-facing front.
export const BRANDED_LABEL_ZPL = String.raw`^XA^CI28
^LH16,16
^FX Outer border
^FO0,0
^GB476,272,3
^FS
^FX Black header bar
^FO0,0
^GB476,150,150
^FS
^FX FloWMS title (white, reversed out of the black bar), centred
^FO0,38
^A0N,80,80
^FR
^FB476,1,0,C
^FDFloWMS
^FS
^FX Subtitle
^FO0,178
^A0N,46,46
^FB476,1,0,C
^FDPOD LABEL
^FS
^FX Hint
^FO0,232
^A0N,28,28
^FB476,1,0,C
^FDClick for details
^FS
^XZ`;

// Render the shared branded FloWMS label once. Caller owns the returned URL.
export function renderBrandedLabel(): Promise<string> {
  return renderZpl(BRANDED_LABEL_ZPL, '2.5x1.5');
}
