const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { createCaptureService } = require('./capture');

const ALLOWED_MIME = new Map([
  ['application/pdf', '.pdf'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp']
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

class UploadValidationError extends Error {}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function uploadMiddleware() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, callback) => {
      if (!ALLOWED_MIME.has(file.mimetype)) callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'snapshot'));
      else callback(null, true);
    }
  }).single('snapshot');
}

async function saveUpload(storageDir, file) {
  const bytes = file.buffer;
  const signatureMatches =
    (file.mimetype === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-') ||
    (file.mimetype === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (file.mimetype === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (file.mimetype === 'image/gif' && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) ||
    (file.mimetype === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
  if (!signatureMatches) throw new UploadValidationError('The file contents do not match the selected PDF or image type.');
  const storagePath = `${crypto.randomUUID()}${ALLOWED_MIME.get(file.mimetype)}`;
  await fs.writeFile(path.join(storageDir, storagePath), file.buffer, { flag: 'wx' });
  return { storagePath, mimeType: file.mimetype, bytes: file.size };
}

function createApp({ db, storageDir, captureService = createCaptureService(storageDir) }) {
  const app = express();
  const upload = uploadMiddleware();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { fallthrough: false }));

  const listApplications = () => db.all(`
    SELECT a.*, r.result AS status, f.mime_type AS snapshot_mime
    FROM application_entry a
    JOIN application_result r ON r.id = a.status_id
    LEFT JOIN file_entry f ON f.id = a.snapshot_id
    ORDER BY datetime(a.created_at) DESC, a.id DESC
  `);

  async function getWaitingStatus(tx) {
    let waiting = await tx.get('SELECT id FROM application_result WHERE result = ?', ['waiting']);
    if (!waiting) {
      await tx.run('INSERT OR IGNORE INTO application_result(result) VALUES (?)', ['waiting']);
      waiting = await tx.get('SELECT id FROM application_result WHERE result = ?', ['waiting']);
    }
    return waiting;
  }

  async function renderIndex(res, options = {}) {
    res.status(options.statusCode || 200).render('applications', {
      applications: await listApplications(),
      message: options.message || null,
      error: options.error || null,
      captureFailure: options.captureFailure || null
    });
  }

  app.get('/', async (_req, res, next) => {
    try { await renderIndex(res, { message: _req.query.message }); } catch (error) { next(error); }
  });

  app.post('/applications', async (req, res, next) => {
    const link = String(req.body.link || '').trim();
    if (!validHttpUrl(link)) return renderIndex(res, { statusCode: 400, error: 'Enter a valid HTTP or HTTPS URL.' }).catch(next);
    let captured;
    try {
      captured = await captureService(link);
      const now = new Date().toISOString();
      await db.transaction(async tx => {
        const waiting = await getWaitingStatus(tx);
        const file = await tx.run(
          'INSERT INTO file_entry(mime_type, created_at, bytes, storage_path) VALUES (?, ?, ?, ?)',
          [captured.mimeType, now, captured.bytes, captured.storagePath]
        );
        await tx.run(`INSERT INTO application_entry
          (name, created_at, last_updated, link, comments, status_id, snapshot_id)
          VALUES (?, ?, ?, ?, '', ?, ?)`, [captured.name, now, now, link, waiting.id, file.id]);
      });
      res.redirect('/?message=' + encodeURIComponent('Application saved.'));
    } catch (error) {
      if (captured?.storagePath) await fs.rm(path.join(storageDir, captured.storagePath), { force: true }).catch(() => {});
      await renderIndex(res, {
        statusCode: 422,
        error: error.message || 'The page could not be captured.',
        captureFailure: { link, name: (() => { try { return new URL(link).hostname; } catch { return ''; } })() }
      }).catch(next);
    }
  });

  app.post('/applications/manual', upload, async (req, res, next) => {
    const name = String(req.body.name || '').trim();
    const link = String(req.body.link || '').trim();
    if (!name || name.length > 300 || !validHttpUrl(link) || !req.file) {
      return renderIndex(res, {
        statusCode: 400,
        error: 'Provide a name, a valid HTTP or HTTPS URL, and a PDF or image snapshot.',
        captureFailure: { name, link }
      }).catch(next);
    }
    let saved;
    try {
      saved = await saveUpload(storageDir, req.file);
      const now = new Date().toISOString();
      await db.transaction(async tx => {
        const waiting = await getWaitingStatus(tx);
        const file = await tx.run('INSERT INTO file_entry(mime_type, created_at, bytes, storage_path) VALUES (?, ?, ?, ?)', [saved.mimeType, now, saved.bytes, saved.storagePath]);
        await tx.run(`INSERT INTO application_entry
          (name, created_at, last_updated, link, comments, status_id, snapshot_id)
          VALUES (?, ?, ?, ?, '', ?, ?)`, [name, now, now, link, waiting.id, file.id]);
      });
      res.redirect('/?message=' + encodeURIComponent('Application saved with your snapshot.'));
    } catch (error) {
      if (saved) await fs.rm(path.join(storageDir, saved.storagePath), { force: true }).catch(() => {});
      next(error);
    }
  });

  app.get('/applications/:id/edit', async (req, res, next) => {
    try {
      const application = await db.get('SELECT * FROM application_entry WHERE id = ?', [req.params.id]);
      if (!application) return res.status(404).render('error', { message: 'Application not found.' });
      const statuses = await db.all('SELECT * FROM application_result ORDER BY result COLLATE NOCASE');
      res.render('edit-application', { application, statuses, error: null });
    } catch (error) { next(error); }
  });

  app.post('/applications/:id/edit', upload, async (req, res, next) => {
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    const link = String(req.body.link || '').trim();
    const createdAt = String(req.body.created_at || '');
    const statusId = Number(req.body.status_id);
    const comments = String(req.body.comments || '');
    let saved;
    try {
      const application = await db.get('SELECT * FROM application_entry WHERE id = ?', [id]);
      const statuses = await db.all('SELECT * FROM application_result ORDER BY result COLLATE NOCASE');
      const status = await db.get('SELECT id FROM application_result WHERE id = ?', [statusId]);
      if (!application) return res.status(404).render('error', { message: 'Application not found.' });
      if (!name || name.length > 300 || !validHttpUrl(link) || !validTimestamp(createdAt) || !status || comments.length > 10000) {
        return res.status(400).render('edit-application', {
          application: { ...application, name, link, created_at: createdAt, status_id: statusId, comments },
          statuses,
          error: 'Check the name, URL, applied date, status, and comments.'
        });
      }
      if (req.file) saved = await saveUpload(storageDir, req.file);
      let oldStoragePath = null;
      await db.transaction(async tx => {
        let snapshotId = application.snapshot_id;
        if (saved) {
          const oldFile = snapshotId ? await tx.get('SELECT storage_path FROM file_entry WHERE id = ?', [snapshotId]) : null;
          const file = await tx.run('INSERT INTO file_entry(mime_type, created_at, bytes, storage_path) VALUES (?, ?, ?, ?)', [saved.mimeType, new Date().toISOString(), saved.bytes, saved.storagePath]);
          snapshotId = file.id;
          oldStoragePath = oldFile?.storage_path || null;
        }
        await tx.run(`UPDATE application_entry SET name = ?, link = ?, created_at = ?,
          last_updated = ?, status_id = ?, comments = ?, snapshot_id = ? WHERE id = ?`,
          [name, link, new Date(createdAt).toISOString(), new Date().toISOString(), statusId, comments, snapshotId, id]);
        if (saved && application.snapshot_id) await tx.run('DELETE FROM file_entry WHERE id = ?', [application.snapshot_id]);
      });
      if (oldStoragePath) await fs.rm(path.join(storageDir, oldStoragePath), { force: true }).catch(error => console.error('Could not remove replaced snapshot:', error));
      res.redirect('/?message=' + encodeURIComponent('Application updated.'));
    } catch (error) {
      if (saved) await fs.rm(path.join(storageDir, saved.storagePath), { force: true }).catch(() => {});
      next(error);
    }
  });

  app.get('/files/:id', async (req, res, next) => {
    try {
      const file = await db.get('SELECT * FROM file_entry WHERE id = ?', [req.params.id]);
      if (!file || path.basename(file.storage_path) !== file.storage_path) return res.status(404).render('error', { message: 'Snapshot not found.' });
      const fullPath = path.resolve(storageDir, file.storage_path);
      if (path.dirname(fullPath) !== path.resolve(storageDir)) return res.status(404).render('error', { message: 'Snapshot not found.' });
      res.type(file.mime_type).sendFile(fullPath, error => { if (error && !res.headersSent) next(error); });
    } catch (error) { next(error); }
  });

  app.get('/statuses', async (req, res, next) => {
    try {
      res.render('statuses', { statuses: await db.all(`SELECT r.*, COUNT(a.id) AS usage_count FROM application_result r LEFT JOIN application_entry a ON a.status_id = r.id GROUP BY r.id ORDER BY r.result COLLATE NOCASE`), error: req.query.error || null, message: req.query.message || null });
    } catch (error) { next(error); }
  });

  app.post('/statuses', async (req, res, next) => {
    const result = String(req.body.result || '').trim();
    if (!result || result.length > 100) return res.redirect('/statuses?error=' + encodeURIComponent('Status must be between 1 and 100 characters.'));
    try {
      await db.run('INSERT INTO application_result(result) VALUES (?)', [result]);
      res.redirect('/statuses?message=' + encodeURIComponent('Status added.'));
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT') return res.redirect('/statuses?error=' + encodeURIComponent('That status already exists.'));
      next(error);
    }
  });

  app.post('/statuses/:id/rename', async (req, res, next) => {
    const result = String(req.body.result || '').trim();
    if (!result || result.length > 100) return res.redirect('/statuses?error=' + encodeURIComponent('Status must be between 1 and 100 characters.'));
    try {
      const change = await db.run('UPDATE application_result SET result = ? WHERE id = ?', [result, req.params.id]);
      if (!change.changes) return res.redirect('/statuses?error=' + encodeURIComponent('Status not found.'));
      res.redirect('/statuses?message=' + encodeURIComponent('Status renamed.'));
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT') return res.redirect('/statuses?error=' + encodeURIComponent('That status already exists.'));
      next(error);
    }
  });

  app.post('/statuses/:id/delete', async (req, res, next) => {
    try {
      const usage = await db.get('SELECT COUNT(*) AS count FROM application_entry WHERE status_id = ?', [req.params.id]);
      if (usage.count > 0) return res.redirect('/statuses?error=' + encodeURIComponent('This status cannot be deleted because one or more applications use it.'));
      const change = await db.run('DELETE FROM application_result WHERE id = ?', [req.params.id]);
      res.redirect('/statuses?' + (change.changes ? 'message=' + encodeURIComponent('Status deleted.') : 'error=' + encodeURIComponent('Status not found.')));
    } catch (error) { next(error); }
  });

  app.use((error, req, res, _next) => {
    let message = 'Something went wrong. Please try again.';
    let status = 500;
    if (error instanceof multer.MulterError) {
      status = 400;
      message = error.code === 'LIMIT_FILE_SIZE'
        ? 'The snapshot is too large. The maximum size is 10 MB.'
        : 'Upload a PDF, PNG, JPEG, GIF, or WebP file.';
    }
    if (error instanceof UploadValidationError) {
      status = 400;
      message = error.message;
    }
    if (status === 500) console.error(error);
    if (req.path === '/' || req.path.startsWith('/applications')) {
      return renderIndex(res, { statusCode: status, error: message }).catch(() => res.status(status).render('error', { message }));
    }
    res.status(status).render('error', { message });
  });

  return app;
}

module.exports = { createApp, validHttpUrl, ALLOWED_MIME, MAX_UPLOAD_BYTES };
