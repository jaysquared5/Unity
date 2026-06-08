
// ====================================================================
// ELECTRON NATIVE BRIDGE
// --------------------------------------------------------------------
// The original was a single browser file that used localStorage, the File
// System Access API, blob downloads, navigator.clipboard, and
// <a target="_blank"> links. In this Electron port those all route through
// the `window.avAPI` preload bridge instead.
//
// `LS` is a synchronous facade over the main-process JSON store. It is
// hydrated once at startup (see boot()) so the rest of the code keeps
// reading/writing synchronously exactly as it did with localStorage, while
// writes persist to disk asynchronously through IPC.
// ====================================================================
const LS = {
  _cache: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._cache, k) ? this._cache[k] : null; },
  setItem(k, v) { const s = String(v); this._cache[k] = s; window.avAPI.store.set(k, s); },
  removeItem(k) { delete this._cache[k]; window.avAPI.store.remove(k); },
};

// ====================================================================
// CONFIG — edit in source as needed
// ====================================================================
const AGENTS = [
  {slug: 'julian',  label: 'Julian Juro',     ohr: '750037063'},
  {slug: 'coworker', label: '(add your coworker)', ohr: ''},      // TODO: fill in
];

const CSV_FILENAME = 'nyc-av-readiness-audit-log.csv';

// ====================================================================
// SERVICENOW — pre-filled catalog ticket for any test marked Fail
// --------------------------------------------------------------------
// We CAN'T submit directly from this file (file:// → SN cross-origin is
// blocked). Instead we open the catalog item in the user's existing SN
// session with as many fields pre-populated as URL params allow, the
// user clicks Submit, and pastes the resulting ticket # back into the
// checklist (📋 Paste button is provided).
//
// CATALOG ITEM (Genpact ESC):
//   "IT Administrative Activities"
//   sys_id: f543715b1bfc3010cbcea8afe54bcbb2
//
// CONSTANT FIELDS (same for every NYC AV-readiness ticket):
//   • Request type:                       Health Check / Testing
//   • Where health check / testing is …:  Asset Health Check
//   • Different location:                 3409-G-LLC: 14th Flr, 521 Fifth Avenue, New York
//
// PER-TICKET FIELDS:
//   • How many assets:                    1  (one failed asset per ticket)
//   • Share details about the request:    auto-built from test name, room,
//                                         agent, validation/failpath, agent note.
//
// VARIABLE NAMES: Service Portal accepts URL query-params keyed by each
// variable's *backend* name. The labels in the form translate to backend
// names that may not be guessable. The names below are first-pass guesses
// (label → lowercase_with_underscores). After the first real submission,
// open the catalog item's Variables tab in SN and swap any that didn't
// pre-fill — only the keys change, structure stays the same.
// ====================================================================
const SN_CATALOG = {
  base: 'https://genpactindprod.service-now.com/esc',
  itemSysId: 'f543715b1bfc3010cbcea8afe54bcbb2',
  // Variable name guesses — see comment above. Swap if a field fails to pre-fill.
  vars: {
    requestType:  'request_type',
    details:      'share_details_about_the_request',
    quantity:     'how_many_assets_do_you_wish_to_raise_this_request_for_maximum_25',
    location:     'where_health_check_testing_is_required',
    assignToSelf: 'assign_to_self',
    // Reference fields ('Request For' user, 'Different location') typically
    // need a sys_id to pre-fill — SN usually auto-populates them from the
    // logged-in user's profile anyway, so we leave them blank here.
  },
  constants: {
    requestType:  'Health Check / Testing',
    location:     'Asset Health Check',
    quantity:     '1',
    assignToSelf: 'true',
  },
};

// Default order rooms appear in. User can reorder via the 🔀 button; persists in localStorage.
// "Site-wide" is the catch-all pseudo-room for items whose Room/Office = "All" in the spreadsheet.
// User-set order (May 27 2026): walking route Queens → ... → Grand Central.
// CLO + COS are listed but have no SCHEMA items yet — they'll appear when items are added for them.
const DEFAULT_ROOM_ORDER = [
  'Queens','CFO','CSO','GBL','CEO','CLO','COS',
  'Chief Tech & Innovation','CGO','Compliance',
  'Bronx','Bryant Park','Boardroom','Grand Central',
  // Trailing rooms not explicitly placed — appear after the listed walking route.
  'Brooklyn','Media Studio','Site-wide',
];

// Rooms renamed (or merged) during the May 27 batch. Used by loadRoomOrder() to migrate
// stored orders from previous naming, and applied throughout the SCHEMA below.
//   - GBO → GBL: the GBO office became GBL on-site.
//   - CEO Suite → CEO: shortened.
//   - General Counsel → CLO: CLO took over from General Counsel as the function name.
// Removed (no longer a real space): Compliance.
const ROOM_RENAMES = {
  'GBO': 'GBL',
  'CEO Suite': 'CEO',
  'General Counsel': 'CLO',
};
// (Compliance was removed May 27 then reinstated May 28 — currently nothing is retired.)
const REMOVED_ROOMS = new Set();

// ====================================================================
// SCHEMA — every checklist item. `title` is the prominent test name in
// the UI. `steps` is the action expanded into a numbered list.
// Source: Checklist Items & Cadence.xlsx
// ====================================================================
function vcDailySteps() { return [
  'Start a Teams meeting at the table/wall touch panel',
  'Call the far-end participant',
  'Verify audio coming out of the speakers',
  'Verify audio transmitted to the far end',
  'Verify expected video transmission',
  'Verify the touch screen responds',
]; }
function vcCertSteps() { return [
  'Run Teams call end-to-end (audio, video, touch)',
  'Run Zoom call end-to-end',
  'Run Google Meet call end-to-end',
  'Any other VC platform the site uses',
  'Verify A/V on every leg',
]; }

const SCHEMA = [
  // ===== Daily VC checks (13 rooms) =====
  ...['Boardroom','Bryant Park','Grand Central','Bronx','CGO','Compliance','Chief Tech & Innovation','CLO','CEO','GBL','CSO','CFO','Queens'].map(room => ({
    cadence:'daily', domain:'Video Conferencing', room,
    title:'Daily VC check',
    steps: vcDailySteps(),
    validation:'All items functioning',
    failpath:'Ticket creation and troubleshooting with VC',
  })),
  // ===== Daily Physical Space (4 rooms) =====
  ...['Boardroom','Bryant Park','Grand Central','Queens'].map(room => ({
    cadence:'daily', domain:'Physical Space', room,
    title:'Physical space check',
    steps:['Remove unneeded technical accessories','Verify chair placement is correct'],
    validation:'Accessories cleared, chairs in correct position',
    failpath:'Remove extras / return chairs to correct location',
  })),
  // ===== Daily site-wide =====
  {cadence:'daily', domain:'Visual Inspection', room:'Site-wide',
    title:'Visual inspection',
    steps:[
      'Visually inspect each space',
      'Check cleanliness',
      'Look for physical damage',
      'Note incorrect furniture placement',
      'Note missing supplies',
    ],
    validation:'No issues found',
    failpath:'Messy → notify I&L · Damage → notify I&L · Furniture displaced → return or notify I&L · Missing supplies → restock'},
  {cadence:'daily', domain:'Network', room:'Site-wide',
    title:'Network connectivity',
    steps:['Validate site-wide connectivity (ping, traceroute, sample load)'],
    validation:'Traffic flowing normally',
    failpath:'Business Critical for Network Issue'},
  {cadence:'daily', domain:'Video Conferencing', room:'Media Studio',
    title:'Media Studio VC check',
    steps:[
      'Activate Earnings Call mode on the wall panel',
      'Call far end from the laptop via puck dock',
      'Verify A/V both directions',
      'Activate Townhall mode → Middle Camera',
      'Start a Teams meeting from the room tap',
      'Verify A/V both directions',
      'Activate Townhall mode → Interview Style',
      'Verify A/V again and camera switching behavior',
    ],
    validation:'All items functioning, cameras switching correctly',
    failpath:'Ticket creation and troubleshooting with VC or Vendor'},
  {cadence:'daily', domain:'Physical Space', room:'Site-wide',
    title:'Return analog whiteboard',
    steps:['Return the analog whiteboard to its correct space (commonly displaced into the BP conf room)'],
    validation:'Whiteboard in correct location',
    failpath:'Relocate to correct space'},
  {cadence:'daily', domain:'Printing', room:'Site-wide',
    title:'Floor printing test',
    steps:['Send a test print to Printer 1','Send a test print to Printer 2','Send a test print to the I&L printer'],
    validation:'All three print successfully',
    failpath:'Troubleshoot — network, paper, jams'},

  // ===== Every Monday =====
  {cadence:'monday', domain:'Technical Concierge', room:'CEO',
    title:'Charger swap (keyboard ↔ trackpad)',
    steps:['Move the charger between keyboard and trackpad','Confirm the receiving accessory charges'],
    validation:'Cable charges accessory',
    failpath:'Exchange cable or accessory depending on failure point'},
  {cadence:'monday', domain:'Technical Concierge', room:'CEO',
    title:'Printer paper check',
    steps:['Open paper tray','Confirm paper is loaded'],
    validation:'Paper present',
    failpath:'Refill paper'},
  {cadence:'monday', domain:'Technical Concierge', room:'CEO',
    title:'Printer ink check',
    steps:['Check ink/toner levels via printer panel or app','Note any low cartridges'],
    validation:'Ink levels healthy',
    failpath:'Replace and/or order replacement ink'},
  {cadence:'monday', domain:'Technical Concierge', room:'GBL',
    title:'PBI touch display',
    steps:['Activate the PBI touch display','Confirm touch is responsive'],
    validation:'Touch responsive',
    failpath:'Check power; if powered but non-responsive, contact EUC'},
  {cadence:'monday', domain:'Network', room:'Site-wide',
    title:'Outdoor Wi-Fi range',
    steps:['Test Wi-Fi range from outdoor positions','Confirm connection holds and traffic flows'],
    validation:'Power on, network connection outside',
    failpath:'Notify I&L / contact Network team'},

  // ===== Every Friday =====
  {cadence:'friday', domain:'Technical Concierge', room:'CEO',
    title:'Charger swap (keyboard ↔ trackpad)',
    steps:['Move the charger between keyboard and trackpad','Confirm the receiving accessory charges'],
    validation:'Cable charges accessory',
    failpath:'Exchange cable or accessory'},
  {cadence:'friday', domain:'Printing', room:'CEO',
    title:'Printer paper check',
    steps:['Open paper tray','Confirm paper is loaded'],
    validation:'Paper present',
    failpath:'Refill paper'},
  {cadence:'friday', domain:'Printing', room:'CEO',
    title:'Printer ink check',
    steps:['Check ink/toner levels','Note any low cartridges'],
    validation:'Ink levels healthy',
    failpath:'Replace and/or order ink'},
  {cadence:'friday', domain:'Technical Concierge', room:'GBL',
    title:'PBI touch display',
    steps:['Activate the PBI touch display','Confirm touch is responsive'],
    validation:'Touch responsive',
    failpath:'Check power; if powered but non-responsive, contact EUC'},
  {cadence:'friday', domain:'Physical Space', room:'Site-wide',
    title:'Equipment physical inspection',
    steps:['Walk each room','Wipe away fingerprints and smudges','Inspect for visible damage'],
    validation:'No physical damage',
    failpath:'Notify correct vendor or team for repair'},
  {cadence:'friday', domain:'Printers', room:'Site-wide',
    title:'All-printer cleaning cycle',
    steps:['Run the cleaning cycle on each floor printer','Inspect physically for issues'],
    validation:'Cleaning cycles complete without error',
    failpath:'Open ticket with SOS'},
  {cadence:'friday', domain:'Printing', room:'CLO',
    title:'Personal printer cleaning',
    steps:['Run cleaning cycle on the CLO personal printer','Inspect physically for issues'],
    validation:'Cleaning cycle complete',
    failpath:'Troubleshoot and/or replace; contact Manager'},
  {cadence:'friday', domain:'Printing', room:'Brooklyn',
    title:'Personal printer cleaning',
    steps:['Run cleaning cycle on the Brooklyn personal printer','Inspect physically for issues'],
    validation:'Cleaning cycle complete',
    failpath:'Troubleshoot and/or replace; contact Manager'},
  {cadence:'friday', domain:'Printing', room:'CEO',
    title:'Personal printer cleaning',
    steps:['Run cleaning cycle on the CEO Suite personal printer','Inspect physically for issues'],
    validation:'Cleaning cycle complete',
    failpath:'Troubleshoot and/or replace; contact Manager'},

  // ===== Bi-weekly =====
  ...['Boardroom','Bryant Park','CEO','Queens','Grand Central'].map(room => ({
    cadence:'biweekly', domain:'Video Conferencing', room,
    title:'Full VC certification',
    steps: vcCertSteps(),
    validation:'All calls complete without issue; A/V verified',
    failpath:'Troubleshoot with VC team; vendor alignment if VC team unable to resolve',
  })),
  {cadence:'biweekly', domain:'Network', room:'Site-wide',
    title:'Continuous ping walk',
    steps:[
      'Start a continuous ping',
      'Walk the entire site, noting drops/latency',
      'Document specific locations with repeated issues',
    ],
    validation:'No excessive drops, range issues, or repeated latency',
    failpath:'Network ticket or BC depending on impact'},

  // ===== Monthly =====
  {cadence:'monthly', domain:'Asset Management', room:'Site-wide',
    title:'In-stock inventory review',
    steps:['Review in-stock inventory levels','Identify items that need restocking','Order replacements'],
    validation:'Inventory levels current',
    failpath:'Order replacements'},

  // ===== Quarterly =====
  {cadence:'quarterly', domain:'Video Conferencing', room:'Site-wide',
    title:'Quarterly vendor maintenance (AV Services)',
    steps:['Coordinate visit with AV Services vendor','Observe maintenance','Confirm rooms returned to working state'],
    validation:'Maintenance complete',
    failpath:'Escalate to vendor'},
  {cadence:'quarterly', domain:'Asset Management', room:'Site-wide',
    title:'HAM-to-onsite inventory validation',
    steps:['Pull current HAM records','Walk the site validating each asset','File correction tickets for discrepancies'],
    validation:'Inventory matches HAM',
    failpath:'Research and submit tickets to correct'},
];

// ====================================================================
// CADENCE MATH
// ====================================================================
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}
function dayName(d) { return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]; }
function defaultCadences(date) {
  const dn = dayName(date), wk = isoWeek(date);
  const layers = new Set();
  if (dn !== 'Sat' && dn !== 'Sun') layers.add('daily');
  if (dn === 'Mon') layers.add('monday');
  if (dn === 'Fri') layers.add('friday');
  if (wk % 2 === 0) layers.add('biweekly');
  if (wk % 4 === 0) layers.add('monthly');
  if (wk % 12 === 0) layers.add('quarterly');
  return layers;
}
const CADENCE_ORDER = ['daily','monday','friday','biweekly','monthly','quarterly'];
const CADENCE_LABEL = {daily:'Daily', monday:'Monday', friday:'Friday', biweekly:'Bi-weekly', monthly:'Monthly', quarterly:'Quarterly'};

// ====================================================================
// STATE
// ====================================================================
const ROOM_ORDER_KEY = 'nyc-checklist.room-order';
const AUDIT_KEY      = 'nyc-checklist.audit-log';
const TODAY_KEY = () => {
  const d = state.date;
  const ymd = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  return 'nyc-checklist.session.' + ymd + '.' + state.agent.slug;
};

const state = {
  date: new Date(),
  agent: AGENTS[0],
  cadences: new Set(),
  confirmed: false,
  responses: {},                                                  // {testKey: {status, note, ticket}}
  expanded: new Set(),                                            // which test cards are expanded
  roomOrder: null,                                                // loaded from localStorage on init
  reorderMode: false,
};

function testKey(item, idx) { return item.cadence + '::' + item.room + '::' + idx; }

function loadSession() {
  try {
    const raw = LS.getItem(TODAY_KEY());
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj.cadences) state.cadences = new Set(obj.cadences);
    if (obj.responses) state.responses = obj.responses;
    if (obj.confirmed) state.confirmed = obj.confirmed;
    if (obj.expanded) state.expanded = new Set(obj.expanded);
  } catch {}
}
function saveSession() {
  const snap = {
    cadences: Array.from(state.cadences),
    responses: state.responses,
    confirmed: state.confirmed,
    expanded: Array.from(state.expanded),
    ts: Date.now(),
  };
  try { LS.setItem(TODAY_KEY(), JSON.stringify(snap)); } catch {}
}
function loadRoomOrder() {
  try {
    const raw = LS.getItem(ROOM_ORDER_KEY);
    if (raw) {
      let order = JSON.parse(raw);
      if (Array.isArray(order) && order.length) {
        // Migrate old room names → new room names (handles GBO→GBL, CEO Suite→CEO, General Counsel→CLO).
        order = order.map(r => ROOM_RENAMES[r] || r);
        // Drop any rooms that have been retired from the site.
        order = order.filter(r => !REMOVED_ROOMS.has(r));
        // Dedupe in case the rename collided with an existing entry.
        order = [...new Set(order)];
        // Append any rooms from DEFAULT that aren't in stored order (fresh additions like COS).
        const set = new Set(order);
        DEFAULT_ROOM_ORDER.forEach(r => { if (!set.has(r)) order.push(r); });
        // Save the migrated order back so we don't redo this on every load.
        try { LS.setItem(ROOM_ORDER_KEY, JSON.stringify(order)); } catch {}
        return order;
      }
    }
  } catch {}
  return [...DEFAULT_ROOM_ORDER];
}
function saveRoomOrder() {
  try { LS.setItem(ROOM_ORDER_KEY, JSON.stringify(state.roomOrder)); } catch {}
}

// ====================================================================
// FILE STORAGE — FSA on Edge desktop, download fallback elsewhere
// ====================================================================
// In Electron, saving goes through the main process via a native Save dialog
// (preload bridge `avAPI.saveFile`) instead of the File System Access API or a
// blob download. Returns the chosen absolute path, or null if the user cancels.
async function saveTextFile(defaultName, text, kind) {
  const filters = kind === 'csv'
    ? [{ name: 'CSV', extensions: ['csv'] }]
    : [{ name: 'HTML', extensions: ['html'] }];
  const res = await window.avAPI.saveFile({ defaultPath: defaultName, contents: text, filters });
  return res && !res.canceled ? res.filePath : null;
}

// ====================================================================
// AUDIT LOG + CSV
// ====================================================================
function loadAudit() { try { return JSON.parse(LS.getItem(AUDIT_KEY)) || []; } catch { return []; } }
function saveAudit(rows) { try { LS.setItem(AUDIT_KEY, JSON.stringify(rows)); } catch {} }
function exportCSV(allRows) {
  const cols = ['timestamp_iso','agent_slug','agent_label','date','day_of_week','iso_week','cadence','domain','room','title','action','status','note','ticket'];
  const esc = c => { const s = (c == null) ? '' : String(c); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; };
  const lines = [cols.join(',')];
  for (const r of allRows) lines.push(cols.map(c => esc(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// ====================================================================
// REPORT — self-contained, printable, leadership-ready HTML
// One file per day per agent. Light theme (prints clean to PDF).
// Includes per-room visual breakdown PLUS the raw CSV embedded at
// the bottom for chain-of-custody / spreadsheet import.
// ====================================================================
function buildReportHtml(rows, when, agent) {
  const esc = escapeHtml;
  const ymd = when.getFullYear() + '-' + String(when.getMonth()+1).padStart(2,'0') + '-' + String(when.getDate()).padStart(2,'0');
  const wk = isoWeek(when);
  const dateLong = when.toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  // Group rows by room, preserving the user's room order
  const byRoom = new Map();
  for (const r of rows) { if (!byRoom.has(r.room)) byRoom.set(r.room, []); byRoom.get(r.room).push(r); }
  const ordered = [];
  for (const r of state.roomOrder) if (byRoom.has(r)) ordered.push([r, byRoom.get(r)]);
  for (const r of [...byRoom.keys()].sort()) if (!state.roomOrder.includes(r)) ordered.push([r, byRoom.get(r)]);
  // Summary stats
  const totalTests = rows.length;
  const passCount  = rows.filter(r => r.status === 'pass').length;
  const failCount  = rows.filter(r => r.status === 'fail').length;
  const ticketCount = rows.filter(r => r.ticket && r.ticket.trim()).length;
  const totalRooms = byRoom.size;
  const cadenceLabel = [...state.cadences].map(c => CADENCE_LABEL[c]).join(' + ') || '—';
  const generatedAt = new Date().toLocaleString('en-US');
  // Per-room sections
  const roomsHtml = ordered.map(([roomName, rRows]) => {
    const rPass = rRows.filter(r => r.status === 'pass').length;
    const rFail = rRows.filter(r => r.status === 'fail').length;
    const cls = rFail > 0 ? 'is-has-fail' : 'is-all-pass';
    const badge = rFail > 0
      ? '<span class="badge fail">' + rFail + ' fail · ' + rPass + ' pass</span>'
      : '<span class="badge pass">All pass (' + rPass + ')</span>';
    const testsHtml = rRows.map(r => {
      const ico = r.status === 'pass' ? '<span class="ico pass">✓</span>' : '<span class="ico fail">✕</span>';
      const note = (r.status === 'fail' && r.note) ? '<div class="note">' + esc(r.note) + '</div>' : '';
      // Ticket goes inline with the title row (saves a line per failed test)
      const ticket = (r.ticket && r.ticket.trim()) ? '<span class="ticket">' + esc(r.ticket) + '</span>' : '';
      const cadLbl = CADENCE_LABEL[r.cadence] || r.cadence || '';
      return '<li>' + ico +
        '<div class="test-name">' +
          '<div class="title-row">' +
            '<span class="title">' + esc(r.title) + '</span>' +
            '<span class="cad">' + esc(cadLbl) + '</span>' +
            ticket +
          '</div>' +
          note +
        '</div>' +
      '</li>';
    }).join('');
    return '<div class="room ' + cls + '">' +
      '<div class="room-head"><h3>' + esc(roomName) + '</h3>' + badge + '</div>' +
      '<ul class="room-tests">' + testsHtml + '</ul>' +
    '</div>';
  }).join('');
  const rawCsv = exportCSV(rows);
  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>NYC AV Readiness · ' + esc(dateLong) + '</title>' +
    '<style>' +
      ':root{--ink:#1a1f2e;--muted:#5b6477;--line:#d8dde8;--bg:#fff;' +
      '--pass:#1f7a3a;--pass-bg:#e9f5ed;--fail:#b3261e;--fail-bg:#fbe9e7;--accent:#1858c9;}' +
      '*{box-sizing:border-box;}' +
      'html,body{margin:0;background:#f4f6fa;color:var(--ink);font-family:-apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.5;}' +
      // Page: tighter padding, narrower body font for density
      '.page{max-width:820px;margin:18px auto;background:var(--bg);box-shadow:0 1px 3px rgba(0,0,0,0.08);padding:22px 28px;border-radius:6px;}' +
      // Header: condensed, all meta items on one row inline
      'header h1{margin:0;font-size:18px;letter-spacing:-0.01em;line-height:1.2;}' +
      'header .sub{color:var(--muted);font-size:11.5px;margin-top:1px;}' +
      'header .meta{display:grid;grid-template-columns:repeat(4,1fr);gap:4px 18px;margin:10px 0 4px;padding:8px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:11.5px;}' +
      'header .meta div strong{color:var(--muted);font-weight:600;display:block;font-size:9px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:1px;}' +
      // Section headings: smaller, less margin
      'section h2{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin:12px 0 6px;font-weight:700;}' +
      // Summary stat cards: 5 across, compact
      '.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;}' +
      '.stat{padding:7px 10px;border:1px solid var(--line);border-radius:5px;background:#fafbfd;}' +
      '.stat .num{font-size:17px;font-weight:700;line-height:1;display:block;}' +
      '.stat .lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-top:3px;display:block;font-weight:600;}' +
      '.stat.pass{border-color:var(--pass);background:var(--pass-bg);}' +
      '.stat.pass .num{color:var(--pass);}' +
      '.stat.fail{border-color:var(--fail);background:var(--fail-bg);}' +
      '.stat.fail .num{color:var(--fail);}' +
      // Rooms in 2-column grid; each room atomic (no internal page-break)
      '.rooms-grid{columns:2;column-gap:10px;column-fill:balance;}' +
      '.room{border:1px solid var(--line);border-radius:5px;margin-bottom:6px;overflow:hidden;break-inside:avoid;page-break-inside:avoid;display:inline-block;width:100%;}' +
      '.room.is-all-pass{border-color:var(--pass);}' +
      '.room.is-all-pass .room-head{background:var(--pass-bg);}' +
      '.room.is-has-fail{border-color:var(--fail);}' +
      '.room.is-has-fail .room-head{background:var(--fail-bg);}' +
      '.room-head{display:flex;justify-content:space-between;align-items:center;padding:5px 9px;border-bottom:1px solid var(--line);gap:6px;}' +
      '.room-head h3{margin:0;font-size:12px;}' +
      '.badge{font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;letter-spacing:0.02em;white-space:nowrap;}' +
      '.badge.pass{background:var(--pass);color:#fff;}' +
      '.badge.fail{background:var(--fail);color:#fff;}' +
      '.room-tests{margin:0;padding:0;list-style:none;}' +
      '.room-tests li{padding:4px 9px;border-top:1px solid var(--line);display:flex;align-items:flex-start;gap:6px;}' +
      '.room-tests li:first-child{border-top:0;}' +
      '.ico{flex:0 0 12px;font-weight:900;font-size:11px;line-height:14px;text-align:center;}' +
      '.ico.pass{color:var(--pass);}' +
      '.ico.fail{color:var(--fail);}' +
      '.test-name{flex:1;min-width:0;}' +
      '.title-row{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;line-height:1.3;}' +
      '.title{font-weight:500;font-size:11px;}' +
      '.cad{font-size:8.5px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;}' +
      '.note{margin-top:2px;padding:3px 7px;background:var(--fail-bg);border-left:2px solid var(--fail);font-size:10px;color:var(--ink);white-space:pre-wrap;border-radius:0 2px 2px 0;line-height:1.3;}' +
      '.ticket{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#fff;border:1px solid var(--fail);color:var(--fail);font-size:9px;padding:1px 5px;border-radius:2px;font-weight:600;}' +
      // Raw section: visible on screen for CSV extract, hidden on print
      'section.raw{margin-top:18px;padding-top:12px;border-top:1px solid var(--line);}' +
      '.raw-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px;}' +
      '.raw-head h2{margin:0;}' +
      '.dl-btn{background:#fff;border:1px solid var(--accent);color:var(--accent);font-weight:600;padding:5px 12px;font-size:11.5px;border-radius:4px;cursor:pointer;font-family:inherit;letter-spacing:0.01em;}' +
      '.dl-btn:hover{background:var(--accent);color:#fff;}' +
      '.dl-btn:active{transform:scale(0.97);}' +
      'section.raw p{font-size:11px;color:var(--muted);margin:0 0 6px;}' +
      'section.raw code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f6fa;padding:1px 4px;border-radius:3px;font-size:10.5px;}' +
      'section.raw pre{background:#f4f6fa;border:1px solid var(--line);padding:8px;font-size:9.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto;border-radius:4px;white-space:pre;line-height:1.35;max-height:200px;}' +
      'footer{margin-top:14px;padding-top:8px;border-top:1px solid var(--line);font-size:10px;color:var(--muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;}' +
      // PRINT — kill raw section, remove screen-only padding, tighten further
      '@media print{' +
        'html,body{background:#fff;}' +
        '.page{box-shadow:none;max-width:none;margin:0;padding:12px 18px;border-radius:0;}' +
        'section.raw{display:none !important;}' +
        '.dl-btn{display:none;}' +
        'header h1{font-size:16px;}' +
        '.rooms-grid{columns:2;column-gap:10px;}' +
        '.room{break-inside:avoid;page-break-inside:avoid;}' +
        'footer{margin-top:8px;}' +
      '}' +
      // SCREEN (mobile portrait): single column, larger touch targets
      '@media (max-width:600px){' +
        '.page{margin:0;padding:14px 14px;border-radius:0;}' +
        'header h1{font-size:16px;}' +
        'header .meta{grid-template-columns:1fr 1fr;gap:6px 12px;}' +
        '.stats{grid-template-columns:1fr 1fr 1fr;gap:5px;}' +
        '.rooms-grid{columns:1;}' +
      '}' +
    '</style></head><body><div class="page">' +
    '<header>' +
      '<h1>NYC Daily AV Readiness Report</h1>' +
      '<div class="sub">Executive Support · NYC Midtown</div>' +
      '<div class="meta">' +
        '<div><strong>Date</strong>' + esc(dateLong) + '</div>' +
        '<div><strong>Agent</strong>' + esc(agent.label) + (agent.ohr ? ' · OHR ' + esc(agent.ohr) : '') + '</div>' +
        '<div><strong>ISO Week</strong>' + wk + '</div>' +
        '<div><strong>Cadence layers</strong>' + esc(cadenceLabel) + '</div>' +
      '</div>' +
    '</header>' +
    '<section class="summary"><h2>Summary</h2><div class="stats">' +
      '<div class="stat"><span class="num">' + totalRooms + '</span><span class="lbl">Rooms checked</span></div>' +
      '<div class="stat"><span class="num">' + totalTests + '</span><span class="lbl">Tests completed</span></div>' +
      '<div class="stat pass"><span class="num">' + passCount + '</span><span class="lbl">Pass</span></div>' +
      '<div class="stat fail"><span class="num">' + failCount + '</span><span class="lbl">Fail</span></div>' +
      '<div class="stat"><span class="num">' + ticketCount + '</span><span class="lbl">Tickets opened</span></div>' +
    '</div></section>' +
    '<section class="rooms"><h2>Details by Room</h2><div class="rooms-grid">' + roomsHtml + '</div></section>' +
    '<section class="raw">' +
      '<div class="raw-head"><h2>Raw audit data</h2>' +
        '<button type="button" id="dl-csv" class="dl-btn">📊 Download CSV</button>' +
      '</div>' +
      '<p>Spreadsheet-importable rows for this day. Tap <strong>Download CSV</strong> to extract as a standalone <code>.csv</code> file.</p>' +
      '<pre id="csv-data">' + esc(rawCsv) + '</pre>' +
    '</section>' +
    '<footer><div>Generated ' + esc(generatedAt) + '</div><div>NYC Daily Checklist</div></footer>' +
  '</div>' +
  // Inline script — handles the in-report "Download CSV" button. Runs in the
  // report's own document context, so its a.click() download is a first-party
  // user gesture (mobile-safe, no popup-blocker conflict).
  '<script>(function(){' +
    'var btn=document.getElementById("dl-csv");' +
    'if(!btn)return;' +
    'btn.addEventListener("click",function(){' +
      'var text=document.getElementById("csv-data").textContent;' +
      'var blob=new Blob([text],{type:"text/csv"});' +
      'var a=document.createElement("a");' +
      'a.href=URL.createObjectURL(blob);' +
      'a.download="nyc-av-readiness-' + ymd + '-' + esc(agent.slug) + '.csv";' +
      'document.body.appendChild(a);a.click();document.body.removeChild(a);' +
      'setTimeout(function(){URL.revokeObjectURL(a.href);},1000);' +
    '});' +
  '})();<\/script>' +
  '</body></html>';
}
async function downloadReport(html, ymd, agentSlug) {
  const filename = 'nyc-av-readiness-' + ymd + '-' + agentSlug + '.html';
  const savedPath = await saveTextFile(filename, html, 'html');
  return savedPath ? filename : null;
}

// ====================================================================
// QUERY HELPERS
// ====================================================================
function activeItems() {
  const out = [];
  SCHEMA.forEach((it, idx) => { if (state.cadences.has(it.cadence)) out.push({...it, idx}); });
  return out;
}
function groupedByRoom() {
  const items = activeItems();
  const byRoom = new Map();
  for (const it of items) {
    if (!byRoom.has(it.room)) byRoom.set(it.room, []);
    byRoom.get(it.room).push(it);
  }
  // Order according to state.roomOrder; rooms not in the order list go at the end alphabetically
  const ordered = [];
  for (const r of state.roomOrder) if (byRoom.has(r)) ordered.push([r, byRoom.get(r)]);
  for (const r of [...byRoom.keys()].sort()) if (!state.roomOrder.includes(r)) ordered.push([r, byRoom.get(r)]);
  return ordered;
}
function progress() {
  const items = activeItems();
  let done = 0;
  for (const it of items) {
    const r = state.responses[testKey(it, it.idx)];
    if (r && r.status) done++;
  }
  // Room-level completion: a room is "done" when every test in it has a status.
  const groups = groupedByRoom();
  let roomsDone = 0;
  for (const [, gItems] of groups) {
    const allAnswered = gItems.every(it => {
      const r = state.responses[testKey(it, it.idx)];
      return r && r.status;
    });
    if (allAnswered && gItems.length > 0) roomsDone++;
  }
  return {done, total: items.length, roomsDone, roomsTotal: groups.length};
}

// ====================================================================
// RENDER
// ====================================================================
function renderProgress() {
  const {done, total, roomsDone, roomsTotal} = progress();
  const pct = (total === 0 ? 0 : 100 * done / total);
  const fill = document.getElementById('pf');
  fill.style.width = pct + '%';
  fill.classList.toggle('complete', total > 0 && done === total);
  document.getElementById('pt').textContent = done + ' / ' + total + ' tests';
  const roomsLabel = document.getElementById('rooms-done');
  if (roomsLabel) roomsLabel.textContent = roomsDone + ' of ' + roomsTotal + ' rooms completed';
  const btn = document.getElementById('save-btn');
  btn.disabled = total === 0 || done === 0;
  btn.textContent = (done === total && total > 0) ? '📄 All done — Save & generate report' : '📄 Save & generate report';
}
function renderHeader() {
  const d = state.date;
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  document.getElementById('date-pill').textContent =
    days[d.getDay()] + ' · ' + (d.getMonth()+1) + '/' + d.getDate() + '/' + d.getFullYear() + ' · ISO wk ' + isoWeek(d);
  const sel = document.getElementById('agent-select');
  sel.innerHTML = AGENTS.map(a => '<option value="' + a.slug + '"' + (a.slug === state.agent.slug ? ' selected' : '') + '>' + escapeHtml(a.label) + '</option>').join('');
}
function renderConfirmCard(main) {
  const auto = defaultCadences(state.date);
  const labels = Array.from(auto).map(c => CADENCE_LABEL[c]).join(' + ') || '(weekend — nothing scheduled)';
  const itemCount = SCHEMA.filter(it => auto.has(it.cadence)).length;
  const card = document.createElement('div');
  card.className = 'confirm-card';
  card.innerHTML =
    '<h2>Confirm today\'s cadence</h2>' +
    '<p>Auto-detected: <strong>' + escapeHtml(labels) + '</strong> — ' + itemCount + ' item' + (itemCount === 1 ? '' : 's') + '.</p>' +
    '<p>Tap <em>Confirm</em> to start. Tap <em>Adjust</em> to add/remove cadence layers before starting.</p>' +
    '<div class="row">' +
      '<button class="btn primary" id="cad-confirm">Confirm</button>' +
      '<button class="btn" id="cad-adjust">Adjust…</button>' +
    '</div>';
  main.appendChild(card);
  card.querySelector('#cad-confirm').addEventListener('click', () => {
    state.cadences = auto; state.confirmed = true; saveSession(); render();
  });
  card.querySelector('#cad-adjust').addEventListener('click', () => {
    state.cadences = new Set(auto); state.confirmed = true; saveSession(); render();
    document.querySelector('.cad-bar').scrollIntoView({behavior:'smooth', block:'center'});
  });
}
function renderCadenceChips(main) {
  const bar = document.createElement('div');
  bar.className = 'cad-bar';
  for (const cad of CADENCE_ORDER) {
    const chip = document.createElement('button');
    chip.className = 'cad-chip' + (state.cadences.has(cad) ? ' on' : '');
    chip.textContent = CADENCE_LABEL[cad];
    chip.addEventListener('click', () => {
      if (state.cadences.has(cad)) state.cadences.delete(cad); else state.cadences.add(cad);
      saveSession(); render();
    });
    bar.appendChild(chip);
  }
  // Spacer + reorder toggle
  const sep = document.createElement('span'); sep.className = 'sep'; bar.appendChild(sep);
  const reorder = document.createElement('button');
  reorder.className = 'btn tiny' + (state.reorderMode ? ' on' : '');
  reorder.textContent = state.reorderMode ? '✓ Done' : '🔀 Reorder rooms';
  reorder.addEventListener('click', () => {
    state.reorderMode = !state.reorderMode;
    document.body.classList.toggle('reorder-mode', state.reorderMode);
    render();
  });
  bar.appendChild(reorder);
  // Collapse-all / expand-all
  const collapseAll = document.createElement('button');
  collapseAll.className = 'btn tiny';
  collapseAll.textContent = '⊟ Collapse all';
  collapseAll.title = 'Collapse every test card';
  collapseAll.addEventListener('click', () => { state.expanded.clear(); saveSession(); render(); });
  bar.appendChild(collapseAll);
  main.appendChild(bar);
}
function renderHealRow(main) {
  const row = document.createElement('div');
  row.className = 'heal-row';
  const ymd = state.date.getFullYear() + '-' + String(state.date.getMonth()+1).padStart(2,'0') + '-' + String(state.date.getDate()).padStart(2,'0');
  row.innerHTML =
    'Backfill / heal: ' +
    '<input type="date" id="heal-date" value="' + ymd + '" max="' + ymd + '"> ' +
    '<a id="heal-reset">reset to today</a>';
  main.appendChild(row);
  row.querySelector('#heal-date').addEventListener('change', e => {
    const v = e.target.value; if (!v) return;
    const [y,m,dd] = v.split('-').map(n => parseInt(n,10));
    state.date = new Date(y, m-1, dd);
    state.confirmed = false; state.cadences = new Set(); state.responses = {}; state.expanded.clear();
    loadSession(); render();
  });
  row.querySelector('#heal-reset').addEventListener('click', () => {
    state.date = new Date();
    state.confirmed = false; state.cadences = new Set(); state.responses = {}; state.expanded.clear();
    loadSession(); render();
  });
}

// ====================================================================
// TICKET QUEUE — end-of-walk batch ticket creation
// --------------------------------------------------------------------
// Rationale: opening a SN tab mid-walk interrupts the rhythm and the
// browser tab is awkward to dismiss on mobile. Defer ALL ticket creation
// to a single queue at the bottom of the page. When the agent is back
// at their desk, they scroll down once, tap through each "Open in SN"
// link, submit, paste the ticket #, repeat. Visible only when there's
// at least one failed test in the current session.
// ====================================================================
function renderTicketQueue(main) {
  const items = activeItems();
  const failures = [];
  for (const it of items) {
    const key = testKey(it, it.idx);
    const r = state.responses[key];
    if (r && r.status === 'fail') failures.push({it, key, resp: r});
  }
  if (!failures.length) return;
  const openCount = failures.filter(f => !(f.resp.ticket && f.resp.ticket.trim())).length;
  const doneCount = failures.length - openCount;

  const section = document.createElement('section');
  section.className = 'ticket-queue' + (openCount === 0 ? ' all-done' : '');
  const headTitle = openCount === 0
    ? '🎟 Tickets — all ' + doneCount + ' submitted ✓'
    : '🎟 Tickets — ' + openCount + ' to create' + (doneCount ? ', ' + doneCount + ' done' : '');
  section.innerHTML =
    '<div class="tq-head">' +
      '<h2>' + escapeHtml(headTitle) + '</h2>' +
      '<p class="tq-hint">' + (openCount === 0
        ? 'All failures have tickets. Save &amp; generate report when ready.'
        : 'Open each ticket below in ServiceNow, submit it there, then paste the resulting ticket # back into the field. Order: top to bottom.') + '</p>' +
    '</div>';

  for (const {it, key, resp} of failures) {
    const hasTicket = !!(resp.ticket && resp.ticket.trim());
    const row = document.createElement('div');
    row.className = 'tq-row' + (hasTicket ? ' is-done' : '');
    row.innerHTML =
      '<div class="tq-meta">' +
        '<span class="tq-room">' + escapeHtml(it.room) + '</span>' +
        '<span class="tq-sep">·</span>' +
        '<span class="tq-test">' + escapeHtml(it.title || it.action || '(test)') + '</span>' +
        (hasTicket
          ? '<span class="tq-status done">✓ ' + escapeHtml(resp.ticket) + '</span>'
          : '<span class="tq-status open">Needs ticket</span>') +
      '</div>' +
      (resp.note
        ? '<div class="tq-note">' + escapeHtml(resp.note) + '</div>'
        : '<div class="tq-note empty">No note recorded — SN ticket description will be sparse.</div>') +
      '<div class="tq-actions">' +
        '<a class="btn primary tq-open" target="_blank" rel="noopener" href="' + escapeHtml(snTicketUrl(it, resp)) + '" data-key="' + escapeHtml(key) + '">📤 Open in ServiceNow</a>' +
        '<input type="text" class="tq-ticket" placeholder="RITM… / SCTASK… / INC…" value="' + escapeHtml(resp.ticket || '') + '" data-key="' + escapeHtml(key) + '">' +
        '<button class="btn tiny tq-paste" data-key="' + escapeHtml(key) + '" title="Paste ticket # from clipboard">📋 Paste</button>' +
      '</div>';
    section.appendChild(row);
  }
  main.appendChild(section);

  // Wire up handlers
  const failureMap = new Map(failures.map(f => [f.key, f]));

  section.querySelectorAll('.tq-open').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    const k = e.currentTarget.dataset.key;
    const f = failureMap.get(k);
    if (!f) return;
    const respNow = state.responses[k] || {status: 'fail'};
    // Rebuild the URL so the latest note text lands in the SN description.
    const url = snTicketUrl(f.it, respNow);
    respNow.status = 'fail';
    respNow.snOpenedAt = new Date().toISOString();
    state.responses[k] = respNow;
    saveSession();
    // Open the pre-filled ServiceNow catalog form in the default browser.
    window.avAPI.openExternal(url);
  }));

  section.querySelectorAll('.tq-ticket').forEach(inp => inp.addEventListener('input', e => {
    const k = e.currentTarget.dataset.key;
    const cur = state.responses[k] || {status:'fail'};
    cur.ticket = e.currentTarget.value;
    state.responses[k] = cur;
    saveSession();
    // In-place status badge update so the agent sees done/open state shift
    // without losing input focus (avoids a full re-render).
    const row = e.currentTarget.closest('.tq-row');
    const badge = row.querySelector('.tq-status');
    const v = cur.ticket.trim();
    if (v) {
      row.classList.add('is-done');
      badge.className = 'tq-status done';
      badge.textContent = '✓ ' + v;
    } else {
      row.classList.remove('is-done');
      badge.className = 'tq-status open';
      badge.textContent = 'Needs ticket';
    }
  }));

  section.querySelectorAll('.tq-paste').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const k = e.currentTarget.dataset.key;
    const row = e.currentTarget.closest('.tq-row');
    const inp = row.querySelector('.tq-ticket');
    await pasteTicketFromClipboard(inp, k);
    // Trigger the input event handler manually to update the badge
    inp.dispatchEvent(new Event('input', {bubbles: true}));
  }));
}

function renderRooms(main) {
  const groups = groupedByRoom();
  if (!groups.length) {
    main.insertAdjacentHTML('beforeend',
      '<div class="empty"><h2>Nothing to check.</h2><p>Toggle a cadence chip above, or use Backfill to pick a different date.</p></div>');
    return;
  }
  for (const [roomName, items] of groups) {
    main.appendChild(renderRoom(roomName, items));
  }
}

function renderRoom(roomName, items) {
  // Compute room status
  let pass = 0, fail = 0, unanswered = 0;
  for (const it of items) {
    const r = state.responses[testKey(it, it.idx)];
    if (!r || !r.status) unanswered++;
    else if (r.status === 'pass') pass++;
    else fail++;
  }
  const roomEl = document.createElement('div');
  roomEl.className = 'room' + (pass === items.length ? ' is-all-pass' : '') + (fail > 0 ? ' is-has-fail' : '');

  const head = document.createElement('div');
  head.className = 'room-head';
  head.innerHTML =
    '<div class="room-name">' +
      '<span class="completion-dot" aria-hidden="true"></span>' +
      escapeHtml(roomName) +
      '<span class="room-meta">' + items.length + ' test' + (items.length === 1 ? '' : 's') +
      ' · ' + pass + ' pass · ' + fail + ' fail · ' + unanswered + ' open</span>' +
    '</div>' +
    '<div class="room-actions">' +
      '<span class="reorder-controls">' +
        '<button class="btn tiny" data-act="up" title="Move up">↑</button>' +
        '<button class="btn tiny" data-act="down" title="Move down">↓</button>' +
      '</span>' +
      '<button class="btn tiny pass-all" data-act="pass-all" title="Mark every unanswered test in this room as Pass">✓ Pass all (' + unanswered + ')</button>' +
      '<button class="btn tiny ghost room-collapse" data-act="toggle-room" title="Collapse / expand all tests in this room">⇕</button>' +
    '</div>';
  roomEl.appendChild(head);

  const body = document.createElement('div');
  body.className = 'room-body';
  for (const it of items) body.appendChild(renderTest(it));
  roomEl.appendChild(body);

  // Wiring
  head.querySelector('[data-act=up]').addEventListener('click', e => { e.stopPropagation(); moveRoom(roomName, -1); });
  head.querySelector('[data-act=down]').addEventListener('click', e => { e.stopPropagation(); moveRoom(roomName, +1); });
  head.querySelector('[data-act=pass-all]').addEventListener('click', e => { e.stopPropagation(); passAllInRoom(items); });
  head.querySelector('[data-act=toggle-room]').addEventListener('click', e => {
    e.stopPropagation();
    // If any test in this room is collapsed, expand all; else collapse all
    const allExpanded = items.every(it => state.expanded.has(testKey(it, it.idx)));
    for (const it of items) {
      const k = testKey(it, it.idx);
      if (allExpanded) state.expanded.delete(k); else state.expanded.add(k);
    }
    saveSession(); render();
  });

  return roomEl;
}

function renderTest(it) {
  const key = testKey(it, it.idx);
  const resp = state.responses[key] || {};
  const isOpen = state.expanded.has(key);
  const el = document.createElement('div');
  el.className = 'test' +
    (resp.status === 'pass' ? ' is-pass' : '') +
    (resp.status === 'fail' ? ' is-fail' : '') +
    (isOpen ? ' is-open' : '');

  el.innerHTML =
    '<div class="test-head" data-act="toggle">' +
      '<span class="test-check" aria-hidden="true"></span>' +
      '<span class="chev">▸</span>' +
      '<div class="title">' +
        '<div class="test-title">' +
          escapeHtml(it.title || it.action || '(test)') +
          '<span class="test-domain">' + escapeHtml(it.domain) + '</span>' +
          '<span class="test-cadence cad-' + it.cadence + '">' + CADENCE_LABEL[it.cadence] + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="test-toggle">' +
        '<button class="test-btn pass-btn' + (resp.status === 'pass' ? ' on' : '') + '" data-act="pass">Pass</button>' +
        '<button class="test-btn fail-btn' + (resp.status === 'fail' ? ' on' : '') + '" data-act="fail">Fail</button>' +
      '</div>' +
    '</div>' +
    '<div class="test-body">' +
      (Array.isArray(it.steps) && it.steps.length
        ? '<div class="test-section"><h4>Process</h4><ol class="test-steps">' +
            it.steps.map(s => '<li>' + escapeHtml(s) + '</li>').join('') +
          '</ol></div>'
        : '') +
      (it.validation ? '<div class="test-validation"><strong>✓ Pass when:</strong> ' + escapeHtml(it.validation) + '</div>' : '') +
      (it.failpath   ? '<div class="test-failpath"><strong>✗ If fail:</strong> '   + escapeHtml(it.failpath) + '</div>' : '') +
      '<div class="fail-extra">' +
        '<div class="test-section"><h4>What went wrong?</h4>' +
          '<textarea placeholder="Which sub-step failed? What did you see? What did you do? (this text becomes the SN ticket description)" data-fk="note">' + escapeHtml(resp.note || '') + '</textarea>' +
          // SN ticket creation moved to the bottom-of-page Ticket Queue. Keep an
          // optional ticket # input here for the rare case where the agent already
          // has a ticket number to attach mid-walk (e.g. a pre-existing incident).
          '<div class="ft-row ticket-row">' +
            '<label>Ticket #</label>' +
            '<input type="text" placeholder="(optional now — handle from queue at end of walk)" data-fk="ticket" value="' + escapeHtml(resp.ticket || '') + '">' +
            '<button class="btn tiny sn-paste" data-act="sn-paste" title="Read clipboard and auto-fill the ticket #">📋 Paste</button>' +
          '</div>' +
          '<div class="sn-defer-hint">📤 Open all SN tickets together from the queue at the bottom of the page when you finish the walk.</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Toggle expand on header tap (but NOT when tapping the Pass/Fail buttons)
  el.querySelector('[data-act=toggle]').addEventListener('click', e => {
    if (e.target.closest('[data-act=pass]') || e.target.closest('[data-act=fail]')) return;
    if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
    saveSession(); render();
  });
  // Pass / Fail buttons
  el.querySelector('[data-act=pass]').addEventListener('click', e => {
    e.stopPropagation();
    const cur = state.responses[key] || {};
    if (cur.status === 'pass') delete state.responses[key];
    else state.responses[key] = {...cur, status:'pass'};
    // Auto-collapse on Pass to clean the screen
    state.expanded.delete(key);
    saveSession(); render();
  });
  el.querySelector('[data-act=fail]').addEventListener('click', e => {
    e.stopPropagation();
    const cur = state.responses[key] || {};
    if (cur.status === 'fail') delete state.responses[key];
    else state.responses[key] = {...cur, status:'fail'};
    // Auto-expand on Fail so the user can fill in note + ticket
    if (state.responses[key]) state.expanded.add(key);
    saveSession(); render();
  });
  // Free-text inputs — don't re-render on every keystroke
  el.querySelectorAll('[data-fk]').forEach(inp => inp.addEventListener('input', e => {
    const fk = e.target.dataset.fk;
    const cur = state.responses[key] || {status:'fail'};
    cur[fk] = e.target.value;
    state.responses[key] = cur;
    saveSession();
  }));
  // SN ticket-create button removed from per-test (now lives in the bottom-of-page
  // Ticket Queue — see renderTicketQueue). Per-test only keeps the optional
  // ticket-# field + paste helper for the rare "I already have a number" case.
  // SN: Paste ticket # from clipboard
  const pasteBtn = el.querySelector('[data-act=sn-paste]');
  if (pasteBtn) pasteBtn.addEventListener('click', e => {
    e.stopPropagation();
    const tInput = el.querySelector('[data-fk=ticket]');
    if (tInput) pasteTicketFromClipboard(tInput, key);
  });
  return el;
}

function moveRoom(roomName, delta) {
  const i = state.roomOrder.indexOf(roomName);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= state.roomOrder.length) return;
  [state.roomOrder[i], state.roomOrder[j]] = [state.roomOrder[j], state.roomOrder[i]];
  saveRoomOrder();
  render();
}

function passAllInRoom(items) {
  let touched = 0;
  for (const it of items) {
    const k = testKey(it, it.idx);
    const cur = state.responses[k] || {};
    if (!cur.status) { state.responses[k] = {...cur, status:'pass'}; touched++; }
  }
  if (touched) {
    saveSession(); render();
    toast('Passed ' + touched + ' unanswered test' + (touched === 1 ? '' : 's'), 'ok');
  } else {
    toast('All tests in this room already have a status', 'err');
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ====================================================================
// SERVICENOW — open pre-filled catalog ticket + paste-back ticket #
// ====================================================================
function buildTicketDescription(it, resp) {
  const d = state.date;
  const dateStr = (d.getMonth()+1) + '/' + d.getDate() + '/' + d.getFullYear();
  const lines = [
    'NYC AV-readiness — failed test report',
    '',
    'Test:       ' + (it.title || it.action || '(test)'),
    'Room:       ' + (it.room || '(unspecified)'),
    'Domain:     ' + (it.domain || '(unspecified)'),
    'Cadence:    ' + (CADENCE_LABEL[it.cadence] || it.cadence || ''),
    'Date:       ' + dateStr,
    'Agent:      ' + (state.agent.label || state.agent.slug) + (state.agent.ohr ? ' (OHR ' + state.agent.ohr + ')' : ''),
    '',
    'Pass criteria:        ' + (it.validation || '(not documented)'),
    'Documented fail path: ' + (it.failpath   || '(not documented)'),
    '',
    'What the agent observed / tried:',
    (resp && resp.note ? resp.note : '(no note provided)'),
  ];
  return lines.join('\n');
}
function snTicketUrl(it, resp) {
  const p = new URLSearchParams();
  p.set('id', 'sc_cat_item');
  p.set('sys_id', SN_CATALOG.itemSysId);
  p.set(SN_CATALOG.vars.requestType,  SN_CATALOG.constants.requestType);
  p.set(SN_CATALOG.vars.location,     SN_CATALOG.constants.location);
  p.set(SN_CATALOG.vars.quantity,     SN_CATALOG.constants.quantity);
  p.set(SN_CATALOG.vars.assignToSelf, SN_CATALOG.constants.assignToSelf);
  p.set(SN_CATALOG.vars.details,      buildTicketDescription(it, resp));
  return SN_CATALOG.base + '?' + p.toString();
}
// (openSnTicket removed — navigation now happens via the <a target="_blank"> element
// itself, which mobile browsers don't block. The renderTest click handler refreshes
// the href and records snOpenedAt, then lets the anchor's default action fire.)
// Extract the first SN-style ticket number from arbitrary text. Order
// matters: RITM / SCTASK / CHG / PRB are checked before bare TASK / REQ
// because they're more specific and we want the most actionable one.
function extractTicketNumber(text) {
  if (!text) return null;
  const patterns = [/\b(RITM\d{4,})\b/i, /\b(SCTASK\d{4,})\b/i, /\b(INC\d{4,})\b/i, /\b(CHG\d{4,})\b/i, /\b(PRB\d{4,})\b/i, /\b(TASK\d{4,})\b/i, /\b(REQ\d{4,})\b/i];
  for (const re of patterns) { const m = text.match(re); if (m) return m[1].toUpperCase(); }
  return null;
}
async function pasteTicketFromClipboard(input, key) {
  try {
    const text = await window.avAPI.readClipboard();
    if (!text) { toast('Clipboard is empty', 'err'); return; }
    const ticket = extractTicketNumber(text) || text.trim();
    input.value = ticket;
    const cur = state.responses[key] || {status: 'fail'};
    cur.ticket = ticket;
    state.responses[key] = cur;
    saveSession();
    toast('Ticket # pasted: ' + ticket, 'ok');
  } catch (e) {
    // Common failure: iPad Safari requires a user-gesture-bound prompt; if blocked, fall back.
    toast('Clipboard access blocked — paste manually into the field', 'err');
    input.focus();
  }
}

function toast(msg, level) {
  const t = document.getElementById('toast');
  t.className = 'show' + (level ? ' ' + level : '');
  t.textContent = msg;
  setTimeout(() => { t.className = ''; }, 2400);
}

// ====================================================================
// SAVE FLOW
// ====================================================================
async function doSave() {
  const items = activeItems();
  if (!items.length) { toast('Nothing to save', 'err'); return; }
  const now = new Date();
  const tsIso = now.toISOString();
  const ymd = state.date.getFullYear() + '-' + String(state.date.getMonth()+1).padStart(2,'0') + '-' + String(state.date.getDate()).padStart(2,'0');
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][state.date.getDay()];
  const wk = isoWeek(state.date);
  const newRows = [];
  for (const it of items) {
    const r = state.responses[testKey(it, it.idx)];
    if (!r || !r.status) continue;
    const actionLine = Array.isArray(it.steps) ? it.steps.join(' • ') : (it.action || '');
    newRows.push({
      timestamp_iso: tsIso,
      agent_slug: state.agent.slug, agent_label: state.agent.label,
      date: ymd, day_of_week: dow, iso_week: wk,
      cadence: it.cadence, domain: it.domain, room: it.room,
      title: it.title || '',
      action: actionLine,
      status: r.status, note: r.note || '', ticket: r.ticket || '',
    });
  }
  if (!newRows.length) { toast('No responses recorded yet', 'err'); return; }
  // Soft warning: if there are any fail rows still missing a ticket #, ask
  // the agent to confirm. The save proceeds either way — empty ticket # is
  // valid in the audit log (means "ticket not filed yet" or "deferred").
  const failsNoTicket = newRows.filter(r => r.status === 'fail' && !(r.ticket && r.ticket.trim())).length;
  if (failsNoTicket > 0) {
    const ok = confirm(failsNoTicket + ' failure' + (failsNoTicket === 1 ? '' : 's') +
      ' without a ticket #. Save anyway? (You can use the Ticket Queue at the ' +
      'bottom of the page to file them, then Save again to capture the ticket #s.)');
    if (!ok) return;
  }
  // Persist to the cumulative localStorage audit (every day, every agent).
  // This data is what powers the 📊 cumulative export button — separate from
  // the per-day report below.
  const audit = loadAudit();
  const filtered = audit.filter(r => !(r.date === ymd && r.agent_slug === state.agent.slug));
  filtered.push(...newRows);
  saveAudit(filtered);
  // Single artifact: a self-contained daily HTML report. The CSV data for today
  // is embedded inside the report (in a <pre> block) AND the report has a
  // "📊 Download CSV" button that the user taps inside the report to extract
  // that CSV as a standalone .csv file. One save click → one download here.
  // Mobile-safe (no second a.click() during this gesture).
  try {
    const reportHtml = buildReportHtml(newRows, state.date, state.agent);
    const reportName = await downloadReport(reportHtml, ymd, state.agent.slug);
    if (reportName) toast('Saved ' + newRows.length + ' row(s) · ' + reportName, 'ok');
    else toast('Saved ' + newRows.length + ' row(s) to the audit log · report not written (canceled)', 'ok');
  } catch (e) {
    toast('Save failed: ' + (e.message || e), 'err');
  }
}

// Dedicated CSV export — single user gesture → single download, mobile-safe.
// Always exports the FULL cumulative audit log (every day, every agent stored
// in localStorage), not just today's rows.
async function doExportCsv() {
  const audit = loadAudit();
  if (!audit.length) { toast('No audit log entries yet', 'err'); return; }
  try {
    const csv = exportCSV(audit);
    const savedPath = await saveTextFile(CSV_FILENAME, csv, 'csv');
    if (savedPath) toast('Exported ' + audit.length + ' row(s) · ' + savedPath, 'ok');
    else toast('Export canceled', 'err');
  } catch (e) {
    toast('CSV export failed: ' + (e.message || e), 'err');
  }
}

// ====================================================================
// RENDER + WIRING
// ====================================================================
function render() {
  renderHeader();
  const main = document.getElementById('main');
  main.innerHTML = '';
  if (!state.confirmed) {
    renderConfirmCard(main);
    renderHealRow(main);
  } else {
    renderCadenceChips(main);
    renderHealRow(main);
    renderRooms(main);
    renderTicketQueue(main);
  }
  renderProgress();
}

function init() {
  state.roomOrder = loadRoomOrder();
  document.getElementById('agent-select').addEventListener('change', e => {
    const next = AGENTS.find(a => a.slug === e.target.value) || AGENTS[0];
    state.agent = next;
    state.responses = {}; state.cadences = new Set(); state.confirmed = false; state.expanded.clear();
    loadSession(); render();
  });
  document.getElementById('save-btn').addEventListener('click', doSave);
  document.getElementById('csv-btn').addEventListener('click', doExportCsv);
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (!confirm('Clear today\'s responses for ' + state.agent.label + '? (Audit log entries already saved are unaffected.)')) return;
    state.responses = {}; state.confirmed = false; state.cadences = new Set(); state.expanded.clear();
    saveSession(); render();
  });
  loadSession();
  render();
}
async function boot() {
  // Hydrate the synchronous LS cache from the native JSON store before init(),
  // so all subsequent reads behave exactly like the old localStorage reads.
  try { LS._cache = (await window.avAPI.store.getAll()) || {}; }
  catch (e) { LS._cache = {}; }
  init();
}
boot();
