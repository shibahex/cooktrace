// ourfamily fork: copy full backups to a Windows / Samba (SMB) share.
//
// Uses the `smbclient` command from Samba (SMB2/SMB3), which the Docker
// image installs. Settings live in app_config; the password is encrypted
// at rest (lib/token-crypto.js). The password reaches smbclient through
// a private temp file (-A), never the command line.
//
// Kept in its own files so `git merge upstream/main` rarely conflicts.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db from '../db.js';
import { logger } from '../logger.js';
import { encrypt, decrypt } from './token-crypto.js';

const K = {
  enabled:  'ourfamily_smb_enabled',
  share:    'ourfamily_smb_share',
  folder:   'ourfamily_smb_folder',
  username: 'ourfamily_smb_username',
  password: 'ourfamily_smb_password',
  domain:   'ourfamily_smb_domain',
  keep:     'ourfamily_smb_keep',
  lastAt:   'ourfamily_smb_last_upload_at',
  lastFile: 'ourfamily_smb_last_upload_file',
  lastErr:  'ourfamily_smb_last_error',
  // Its own schedule: every N days at a time of day (0 days = off).
  everyDays:   'ourfamily_smb_every_days',
  time:        'ourfamily_smb_time',
  lastRun:     'ourfamily_smb_last_scheduled_run',  // last scheduled success
  lastFail:    'ourfamily_smb_last_scheduled_fail', // last failed run, for retries
  pending:     'ourfamily_smb_pending_file',        // made, not yet copied
};
const DEFAULT_TIME = '03:00';

const BACKUP_NAME = /^cooktrace-backup-[\w-]+\.zip$/;

function _get(key) {
  return db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value ?? '';
}
function _set(key, value) {
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? '' : String(value));
}

// ── Checking what people type ──────────────────────────────────────────
// Everything ends up inside an smbclient command string, so quotes,
// semicolons and control characters are refused outright.
const UNSAFE = /["';\u0000-\u001f\u007f]/;

/** `\\nas\backups`, `//nas/backups` or `smb://nas/backups` → `//nas/backups`. */
export function normalizeShare(raw) {
  let s = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^smb:/i, '');
  if (!s) return '';
  if (!s.startsWith('//')) s = '//' + s.replace(/^\/+/, '');
  s = s.replace(/\/+$/, '');
  if (UNSAFE.test(s) || !/^\/\/[^/\s]+\/[^/]+$/.test(s)) {
    throw new Error('Share should look like \\\\server\\share (just the server and the share name)');
  }
  return s;
}

/** A folder inside the share: `CookTrace/backups`, or '' for the top. */
export function normalizeFolder(raw) {
  const s = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!s) return '';
  if (UNSAFE.test(s) || s.split('/').some(p => p === '.' || p === '..')) {
    throw new Error('Folder can\'t contain quotes, semicolons or ".."');
  }
  return s;
}

function _cleanText(raw, what) {
  const s = String(raw ?? '').trim();
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error(`${what} can't contain control characters`);
  return s;
}

// ── Settings ───────────────────────────────────────────────────────────
export function getSmbConfig() {
  const keep = parseInt(_get(K.keep), 10);
  return {
    enabled:        _get(K.enabled) === '1',
    share:          _get(K.share),
    folder:         _get(K.folder),
    username:       _get(K.username),
    domain:         _get(K.domain),
    has_password:   !!_get(K.password),
    keep:           Number.isFinite(keep) && keep >= 0 ? keep : 7,
    everyDays:      _everyDays(),
    time:           _time(),
    nextRun:        _nextRun(),
    lastUploadAt:   _get(K.lastAt) || null,
    lastUploadFile: _get(K.lastFile) || null,
    lastError:      _get(K.lastErr) || null,
  };
}

function _everyDays() {
  const n = parseInt(_get(K.everyDays), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function _time() {
  const t = _get(K.time);
  return /^\d{2}:\d{2}$/.test(t) ? t : DEFAULT_TIME;
}
function _cleanTime(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('Time must be HH:MM');
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** Save settings. `password`: undefined keeps the saved one, '' clears it. */
export function setSmbConfig(body = {}) {
  const next = _resolve(body);
  if (next.enabled && !next.share) throw new Error('Enter the share first');
  _set(K.enabled, next.enabled ? '1' : '0');
  _set(K.share, next.share);
  _set(K.folder, next.folder);
  _set(K.username, next.username);
  _set(K.domain, next.domain);
  _set(K.keep, String(next.keep));
  if (next.everyDays && !next.share) throw new Error('Enter the share first');
  _set(K.everyDays, String(next.everyDays));
  _set(K.time, next.time);
  _set(K.lastFail, ''); // new settings: try again on the next tick
  if (body.password !== undefined) _set(K.password, body.password ? encrypt(String(body.password)) : '');
  return getSmbConfig();
}

// Saved settings with `body` laid over them (for Test before Save).
function _resolve(body = {}) {
  const has = k => body[k] !== undefined;
  const keep = has('keep') ? parseInt(body.keep, 10) : getSmbConfig().keep;
  if (!Number.isFinite(keep) || keep < 0 || keep > 999) throw new Error('Keep must be 0 to 999 (0 keeps everything)');
  const everyDays = has('everyDays') ? parseInt(body.everyDays || 0, 10) : _everyDays();
  if (!Number.isFinite(everyDays) || everyDays < 0 || everyDays > 365) throw new Error('Every … days must be 0 to 365 (0 turns it off)');
  return {
    everyDays,
    time:     has('time') ? _cleanTime(body.time) : _time(),
    enabled:  has('enabled') ? !!body.enabled : _get(K.enabled) === '1',
    share:    normalizeShare(has('share') ? body.share : _get(K.share)),
    folder:   normalizeFolder(has('folder') ? body.folder : _get(K.folder)),
    username: _cleanText(has('username') ? body.username : _get(K.username), 'Username'),
    domain:   _cleanText(has('domain') ? body.domain : _get(K.domain), 'Domain'),
    password: has('password') ? String(body.password ?? '') : (decrypt(_get(K.password)) ?? ''),
    keep,
  };
}

// ── Running smbclient ──────────────────────────────────────────────────
const TIMEOUT_MS = 15 * 60 * 1000;

function _run(cfg, commands) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-smb-'));
  const authFile = path.join(tmp, 'auth');
  const args = [cfg.share];
  if (cfg.username) {
    const lines = [`username = ${cfg.username}`, `password = ${cfg.password}`];
    if (cfg.domain) lines.push(`domain = ${cfg.domain}`);
    fs.writeFileSync(authFile, lines.join('\n') + '\n', { mode: 0o600 });
    args.push('-A', authFile);
  } else {
    args.push('-N'); // no username: connect as guest
  }
  args.push('-c', commands);
  return new Promise(resolve => {
    execFile('smbclient', args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve({ err, out: `${stdout || ''}\n${stderr || ''}` });
    });
  });
}

const FRIENDLY = {
  NT_STATUS_LOGON_FAILURE:          'Wrong username or password',
  NT_STATUS_ACCESS_DENIED:          'No permission to write to that share or folder',
  NT_STATUS_BAD_NETWORK_NAME:       'The server has no share by that name',
  NT_STATUS_HOST_UNREACHABLE:       'Couldn\'t reach the server',
  NT_STATUS_NETWORK_UNREACHABLE:    'Couldn\'t reach the server',
  NT_STATUS_IO_TIMEOUT:             'Couldn\'t reach the server (timed out)',
  NT_STATUS_CONNECTION_REFUSED:     'The server refused the connection (is SMB on?)',
  NT_STATUS_UNSUCCESSFUL:           'Couldn\'t connect to the server',
  NT_STATUS_OBJECT_PATH_NOT_FOUND:  'That folder doesn\'t exist on the share',
  NT_STATUS_OBJECT_NAME_NOT_FOUND:  'That folder doesn\'t exist on the share',
  NT_STATUS_DISK_FULL:              'The share is full',
  NT_STATUS_ACCOUNT_DISABLED:       'That account is disabled',
  NT_STATUS_PASSWORD_EXPIRED:       'That account\'s password has expired',
  NT_STATUS_PASSWORD_MUST_CHANGE:   'That account must change its password first',
};

// The first real error in smbclient's output, or null. `ignore` lists
// codes that are fine here (a folder that already exists, an empty ls).
function _smbError(res, ignore = []) {
  if (res.err?.code === 'ENOENT') {
    return 'smbclient isn\'t installed on the server. Rebuild the Docker image, or install Samba\'s client.';
  }
  if (res.err?.killed) return 'Timed out talking to the share';
  const codes = [...res.out.matchAll(/NT_STATUS_[A-Z_]+/g)].map(m => m[0]).filter(c => !ignore.includes(c));
  if (codes.length) return FRIENDLY[codes[0]] || `SMB error: ${codes[0]}`;
  if (res.err) {
    const line = res.out.split('\n').map(l => l.trim()).filter(Boolean).pop();
    return line || res.err.message;
  }
  return null;
}

function _mkdirsCmd(folder) {
  if (!folder) return '';
  const parts = folder.split('/');
  return parts.map((_, i) => `mkdir "${_remote('', parts.slice(0, i + 1).join('/'))}"`).join('; ') + '; ';
}
// A path on the share, in the folder. Full paths (not `cd`) so a missing
// folder fails the command instead of writing to the top of the share.
const _remote = (folder, name) => (folder ? `${folder}/${name}` : name).replace(/\//g, "\\");
const EXISTS = ['NT_STATUS_OBJECT_NAME_COLLISION'];

async function _ensureFolder(cfg) {
  if (!cfg.folder) return;
  const res = await _run(cfg, _mkdirsCmd(cfg.folder));
  const e = _smbError(res, EXISTS);
  if (e) throw new Error(e);
}

/** Connect, make the folder, write and remove a small file. */
export async function testSmb(body = {}) {
  const cfg = _resolve(body);
  if (!cfg.share) throw new Error('Enter the share first');
  await _ensureFolder(cfg);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-smb-test-'));
  const probe = path.join(tmp, 'probe.txt');
  fs.writeFileSync(probe, `CookTrace backup test ${new Date().toISOString()}\n`);
  try {
    const name = '.cooktrace-write-test.txt';
    const res = await _run(cfg, `put "${probe}" "${_remote(cfg.folder, name)}"; del "${_remote(cfg.folder, name)}"`);
    const e = _smbError(res);
    if (e) throw new Error(e);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { ok: true, where: `${cfg.share}${cfg.folder ? '/' + cfg.folder : ''}` };
}

async function _prune(cfg) {
  if (!cfg.keep) return [];
  const res = await _run(cfg, `ls "${_remote(cfg.folder, 'cooktrace-backup-*.zip')}"`);
  const e = _smbError(res, ['NT_STATUS_NO_SUCH_FILE']);
  if (e) throw new Error(e);
  const names = [...res.out.matchAll(/^\s+(cooktrace-backup-[\w-]+\.zip)\s/gm)].map(m => m[1]);
  const old = [...new Set(names)].sort().reverse().slice(cfg.keep);
  if (!old.length) return [];
  const del = await _run(cfg, old.map(n => `del "${_remote(cfg.folder, n)}"`).join('; '));
  const de = _smbError(del);
  if (de) throw new Error(`Uploaded, but removing old backups failed: ${de}`);
  return old;
}

// One upload at a time; later ones wait their turn.
let _queue = Promise.resolve();

/** Copy one backup ZIP to the share, then trim old ones there. Records
 *  the outcome in settings either way. */
export function copyBackupToSmb(localPath) {
  const job = _queue.then(() => _copy(localPath));
  _queue = job.catch(() => {});
  return job;
}

async function _copy(localPath) {
  const filename = path.basename(localPath);
  try {
    if (!BACKUP_NAME.test(filename)) throw new Error('Not a CookTrace backup file');
    if (UNSAFE.test(localPath)) throw new Error('Backup folder path has characters smbclient can\'t take');
    if (!fs.existsSync(localPath)) throw new Error('Backup file not found');
    const cfg = _resolve();
    if (!cfg.share) throw new Error('No share set up');
    await _ensureFolder(cfg);
    const res = await _run(cfg, `put "${localPath}" "${_remote(cfg.folder, filename)}"`);
    const e = _smbError(res);
    if (e) throw new Error(e);
    _set(K.lastAt, new Date().toISOString());
    _set(K.lastFile, filename);
    _set(K.lastErr, '');
    const pruned = await _prune(cfg);
    logger.info?.(`[smb-backup] copied ${filename} to ${cfg.share}${cfg.folder ? '/' + cfg.folder : ''}${pruned.length ? `, removed ${pruned.length} old` : ''}`);
    return { ok: true, filename, pruned };
  } catch (e) {
    _set(K.lastErr, `${filename}: ${e.message}`);
    logger.warn?.(`[smb-backup] ${filename}: ${e.message}`);
    throw e;
  }
}

/** After a new backup: copy it if auto-copy is on. Never throws. */
export async function afterBackupCreated(localPath) {
  if (_get(K.enabled) !== '1') return null;
  try { return await copyBackupToSmb(localPath); }
  catch { return null; }
}

// ── Its own schedule ───────────────────────────────────────────────────
// Every N days at a time of day, make a full backup and copy it to the
// share. If the share can't be reached, the same backup is tried again
// every hour (no new backup each time) until it gets there.
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

function _slotToday(now = new Date()) {
  const [h, m] = _time().split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
}

function _isDue(now = new Date()) {
  const days = _everyDays();
  if (!days || !_get(K.share)) return false;
  if (now < _slotToday(now)) return false;
  const lastRun = Date.parse(_get(K.lastRun));
  // A couple of hours' slack so a run that went late doesn't push every
  // later one back by a day.
  if (Number.isFinite(lastRun) && now - lastRun < days * DAY_MS - 2 * 60 * 60 * 1000) return false;
  const lastFail = Date.parse(_get(K.lastFail));
  if (Number.isFinite(lastFail) && now - lastFail < RETRY_MS) return false;
  return true;
}

function _nextRun() {
  const days = _everyDays();
  if (!days || !_get(K.share)) return null;
  const now = new Date();
  const lastRun = Date.parse(_get(K.lastRun));
  let next = _slotToday(now);
  if (Number.isFinite(lastRun)) {
    const l = new Date(lastRun);
    const [h, m] = _time().split(':').map(Number);
    next = new Date(l.getFullYear(), l.getMonth(), l.getDate() + days, h, m, 0);
  }
  if (next < now) {
    next = _slotToday(now);
    if (next < now) {
      const lastFail = Date.parse(_get(K.lastFail));
      // Due now; the scheduler looks every 15 minutes (or waits out a retry).
      next = Number.isFinite(lastFail) && now - lastFail < RETRY_MS
        ? new Date(lastFail + RETRY_MS) : new Date(now.getTime() + 15 * 60 * 1000);
    }
  }
  return next.toISOString();
}

let _scheduledRunning = false;

/** Called by the scheduler every tick. */
export async function checkSmbSchedule() {
  if (_scheduledRunning || !_isDue()) return null;
  _scheduledRunning = true;
  try {
    const fb = await import('../routes/full-backup.js');
    let file = _get(K.pending) ? fb.backupFilePath(_get(K.pending)) : null;
    if (!file) {
      const made = fb.createBackup({ skipSmb: true });
      _set(K.pending, made.filename);
      file = fb.backupFilePath(made.filename);
    }
    const result = await copyBackupToSmb(file);
    _set(K.pending, '');
    _set(K.lastRun, new Date().toISOString());
    _set(K.lastFail, '');
    // Backups on the server's own disk follow Auto Backup's "Keep last".
    fb.pruneOldBackups(fb.getScheduleConfig().retention);
    return result;
  } catch (e) {
    _set(K.lastFail, new Date().toISOString());
    logger.warn?.(`[smb-backup] scheduled run failed, retrying in an hour: ${e.message}`);
    return null;
  } finally {
    _scheduledRunning = false;
  }
}
