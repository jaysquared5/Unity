'use strict';

// Persistent key/value store for the AV-Readiness app.
//
// Replaces the browser `localStorage` the HTML tool relied on. Data is kept in a
// single JSON file under the OS-standard per-user app-data directory
// (`app.getPath('userData')`), e.g.
//   macOS:   ~/Library/Application Support/AV Readiness/av-readiness-data.json
//   Windows: %APPDATA%\AV Readiness\av-readiness-data.json
//
// The store is loaded once into memory and persisted on every write. Writes are
// atomic (temp file + rename) so a crash mid-write cannot corrupt the data.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(app.getPath('userData'), 'av-readiness-data.json');

let cache = null;

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    cache = JSON.parse(raw);
    if (typeof cache !== 'object' || cache === null) cache = {};
  } catch (err) {
    // Missing file or unreadable/corrupt JSON — start fresh.
    cache = {};
  }
  return cache;
}

function persist() {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

module.exports = {
  filePath: DATA_FILE,

  get(key) {
    const data = load();
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
  },

  set(key, value) {
    const data = load();
    data[key] = value;
    persist();
    return true;
  },

  remove(key) {
    const data = load();
    delete data[key];
    persist();
    return true;
  },

  getAll() {
    // Return a shallow copy so callers can't mutate the cache directly.
    return { ...load() };
  },

  clear() {
    cache = {};
    persist();
    return true;
  }
};
