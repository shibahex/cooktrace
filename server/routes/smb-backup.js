// ourfamily fork: settings for copying full backups to an SMB share.
//
//   GET  /api/backup-smb              settings + last upload status
//   PUT  /api/backup-smb              save settings
//   POST /api/backup-smb/test         try the settings in the body (unsaved
//                                     fields fall back to the saved ones)
//   POST /api/backup-smb/copy/:name   copy one backup on disk to the share
//
// Admin only, like the backups themselves.
import express from 'express';
import path from 'node:path';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getSmbConfig, setSmbConfig, testSmb, copyBackupToSmb } from '../lib/smb-backup.js';
import { backupFilePath } from './full-backup.js';

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/', (req, res) => res.json(getSmbConfig()));

router.put('/', (req, res) => {
  try { res.json(setSmbConfig(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/test', async (req, res) => {
  try { res.json(await testSmb(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/copy/:name', async (req, res) => {
  const file = backupFilePath(path.basename(req.params.name));
  if (!file) return res.status(404).json({ error: 'Not found' });
  try { res.json({ ...(await copyBackupToSmb(file)), status: getSmbConfig() }); }
  catch (e) { res.status(400).json({ error: e.message, status: getSmbConfig() }); }
});

export default router;
