#!/usr/bin/env node
// watchdog.mjs — an always-on, supervised control plane for the multi-session bridge.
//
// WHY THIS EXISTS
// ---------------
// The "2nd Brain" hang was unrecoverable remotely because the only way in (the
// Cloudflare tunnel + HTML controller) ran *inside / alongside* the process that
// wedged. When that died, so did every path to fix it (Cloudflare error 1033).
//
// This watchdog is deliberately SEPARATE from the sessions it manages and is kept
// alive by launchd (KeepAlive). It is meant to be the thing the tunnel points at,
// so that even when a session is wedged you can still reach this and kill/restart it.
//
// It does three things:
//   1. /health  — liveness, so you (or an uptime monitor) can tell the host is up.
//   2. /sessions, /kill, /restart — remote control over registered sessions.
//   3. A background loop that AUTO-restarts sessions whose process has DIED, and
//      FLAGS sessions that look wedged (transcript stale while process alive) so a
//      human/remote operator can restart them. (Auto-restart of "wedged" is opt-in,
//      because an idle-waiting session also has a stale transcript.)
//
// All mutating endpoints require:  Authorization: Bearer <BRIDGE_TOKEN>
// because this is exposed on the public internet via the tunnel.
//
// Run:  BRIDGE_TOKEN=xxxx node watchdog.mjs   (normally launched by launchd, see ../launchd)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';

const PORT          = parseInt(process.env.BRIDGE_PORT || '8787', 10);
const TOKEN         = process.env.BRIDGE_TOKEN || '';
const STATE_FILE    = process.env.BRIDGE_STATE || path.join(os.homedir(), '.bridge-heal', 'sessions.json');
const LOG_DIR       = process.env.BRIDGE_LOGDIR || path.join(os.homedir(), '.bridge-heal', 'logs');
const STUCK_MINUTES = parseInt(process.env.BRIDGE_STUCK_MINUTES || '15', 10);
const AUTO_HEAL_STUCK = process.env.BRIDGE_AUTO_HEAL_STUCK === '1'; // off by default — see note above
const CHECK_EVERY_MS  = 30_000;

fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

if (!TOKEN) {
  console.error('[watchdog] FATAL: BRIDGE_TOKEN is not set. Refusing to expose an unauthenticated control plane.');
  process.exit(1);
}

/** @type {Map<string, {id:string,pid:number,jsonl?:string,relaunch?:string,cwd?:string,startedAt:number,flaggedStuck?:boolean,lastHeal?:number}>} */
const sessions = new Map();

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const s of raw) sessions.set(s.id, s);
    console.log(`[watchdog] loaded ${sessions.size} session(s) from ${STATE_FILE}`);
  } catch { /* first run */ }
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...sessions.values()], null, 2));
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Seconds since the session's transcript was last appended to. Infinity if unknown.
function staleSeconds(s) {
  if (!s.jsonl) return null;
  try { return (Date.now() - fs.statSync(s.jsonl).mtimeMs) / 1000; }
  catch { return null; }
}

function describe(s) {
  const alive = pidAlive(s.pid);
  const stale = staleSeconds(s);
  const stuck = alive && stale != null && stale > STUCK_MINUTES * 60;
  return {
    id: s.id, pid: s.pid, alive,
    transcriptStaleSecs: stale == null ? null : Math.round(stale),
    status: !alive ? 'dead' : stuck ? 'wedged?' : 'ok',
    cwd: s.cwd, startedAt: s.startedAt, lastHeal: s.lastHeal || null,
  };
}

function relaunch(s, reason) {
  if (!s.relaunch) { console.log(`[heal] ${s.id} ${reason} but no relaunch command — skipping`); return false; }
  if (pidAlive(s.pid)) { try { process.kill(s.pid, 'SIGKILL'); } catch {} }
  const out = fs.openSync(path.join(LOG_DIR, `${s.id}.log`), 'a');
  const child = spawn('/bin/sh', ['-c', s.relaunch], {
    cwd: s.cwd || os.homedir(), detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  s.pid = child.pid;
  s.startedAt = Date.now();
  s.lastHeal = Date.now();
  s.flaggedStuck = false;
  saveState();
  console.log(`[heal] ${s.id} ${reason} -> relaunched as pid ${child.pid}`);
  return true;
}

// Background supervision loop.
function tick() {
  for (const s of sessions.values()) {
    const alive = pidAlive(s.pid);
    if (!alive) { relaunch(s, 'process died'); continue; }
    const stale = staleSeconds(s);
    const wedged = stale != null && stale > STUCK_MINUTES * 60;
    if (wedged && !s.flaggedStuck) {
      s.flaggedStuck = true; saveState();
      console.warn(`[watchdog] ${s.id} looks WEDGED (no transcript activity for ${Math.round(stale/60)}m)`);
    }
    if (wedged && AUTO_HEAL_STUCK) relaunch(s, 'wedged (auto-heal)');
    if (!wedged && s.flaggedStuck) { s.flaggedStuck = false; saveState(); }
  }
}

// ---- HTTP control plane ----------------------------------------------------
function send(res, code, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(data);
}
function authed(req) {
  return (req.headers.authorization || '') === `Bearer ${TOKEN}`;
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // Public, unauthenticated: liveness only.
  if (p === '/health') {
    return send(res, 200, { ok: true, host: os.hostname(), uptimeSec: Math.round(process.uptime()), sessions: sessions.size });
  }

  // Everything else requires the bearer token.
  if (!authed(req)) return send(res, 401, { error: 'unauthorized' });

  if (p === '/sessions' && req.method === 'GET')
    return send(res, 200, { sessions: [...sessions.values()].map(describe) });

  if (p === '/ps' && req.method === 'GET') {
    let ps = '';
    try { ps = execSync("ps -axo pid,ppid,stat,etime,%cpu,command | grep -iE 'claude|cloudflared' | grep -v grep").toString(); } catch {}
    return send(res, 200, { ps });
  }

  if (p === '/register' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.id || !b.pid) return send(res, 400, { error: 'id and pid required' });
    sessions.set(b.id, {
      id: b.id, pid: b.pid, jsonl: b.jsonl, relaunch: b.relaunch,
      cwd: b.cwd, startedAt: Date.now(),
    });
    saveState();
    return send(res, 200, { ok: true, session: describe(sessions.get(b.id)) });
  }

  // /kill/<id>  and  /restart/<id>
  const m = p.match(/^\/(kill|restart)\/(.+)$/);
  if (m && req.method === 'POST') {
    const [, action, id] = m;
    const s = sessions.get(decodeURIComponent(id));
    if (!s) return send(res, 404, { error: `no session ${id}` });
    if (action === 'kill') {
      if (pidAlive(s.pid)) { try { process.kill(s.pid, 'SIGKILL'); } catch {} }
      sessions.delete(s.id); saveState();
      return send(res, 200, { ok: true, killed: s.id });
    }
    const ok = relaunch(s, 'manual restart');
    return send(res, ok ? 200 : 422, { ok, session: describe(s) });
  }

  return send(res, 404, { error: 'not found', try: ['/health', '/sessions', '/ps', 'POST /register', 'POST /kill/:id', 'POST /restart/:id'] });
});

loadState();
setInterval(tick, CHECK_EVERY_MS).unref?.();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[watchdog] listening on 127.0.0.1:${PORT}  (stuck threshold ${STUCK_MINUTES}m, auto-heal-stuck=${AUTO_HEAL_STUCK})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveState(); process.exit(0); });
