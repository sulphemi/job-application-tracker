const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createDatabase } = require('../src/db');
const { createApp } = require('../src/app');

describe('job application tracker', () => {
  let tempDir;
  let storageDir;
  let db;
  let app;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'job-tracker-'));
    storageDir = path.join(tempDir, 'storage');
    await fsp.mkdir(storageDir);
    db = await createDatabase(':memory:');
    app = createApp({
      db,
      storageDir,
      captureService: async url => {
        const storagePath = 'generated.pdf';
        await fsp.writeFile(path.join(storageDir, storagePath), 'generated PDF');
        return { name: `Captured ${new URL(url).hostname}`, mimeType: 'application/pdf', bytes: 13, storagePath };
      }
    });
  });

  afterEach(async () => {
    await db.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('seeds statuses and renders the main page', async () => {
    const response = await request(app).get('/').expect(200);
    expect(response.text).toContain('Applications');
    expect(response.text).toContain('No applications yet');
    const statuses = await db.all('SELECT result FROM application_result ORDER BY result');
    expect(statuses.map(row => row.result)).toEqual(['rejected', 'waiting']);
  });

  it('rejects non-HTTP application URLs', async () => {
    const response = await request(app).post('/applications').type('form').send({ link: 'file:///etc/passwd' }).expect(400);
    expect(response.text).toContain('Enter a valid HTTP or HTTPS URL.');
    expect(await db.get('SELECT COUNT(*) AS count FROM application_entry')).toEqual({ count: 0 });
  });

  it('captures a page and creates a waiting application', async () => {
    await request(app).post('/applications').type('form').send({ link: 'https://example.com/job' }).expect(302);
    const entry = await db.get(`SELECT a.*, r.result AS status FROM application_entry a JOIN application_result r ON r.id = a.status_id`);
    expect(entry.name).toBe('Captured example.com');
    expect(entry.status).toBe('waiting');
    expect(entry.snapshot_id).not.toBeNull();
    expect(entry.created_at).toBe(entry.last_updated);
  });

  it('shows a recovery form when browser capture fails', async () => {
    const failingApp = createApp({ db, storageDir, captureService: async () => { throw new Error('Capture timed out.'); } });
    const response = await request(failingApp).post('/applications').type('form').send({ link: 'https://example.com/job' }).expect(422);
    expect(response.text).toContain('Capture timed out.');
    expect(response.text).toContain('Finish saving this application');
    expect(response.text).toContain('example.com');
  });

  it('saves a manual fallback with a validated snapshot', async () => {
    await request(app)
      .post('/applications/manual')
      .field('name', 'Backend Engineer')
      .field('link', 'https://example.com/job')
      .attach('snapshot', Buffer.from('%PDF-1.7 test'), { filename: 'listing.pdf', contentType: 'application/pdf' })
      .expect(302);
    const entry = await db.get('SELECT name, snapshot_id FROM application_entry');
    const file = await db.get('SELECT * FROM file_entry WHERE id = ?', [entry.snapshot_id]);
    expect(entry.name).toBe('Backend Engineer');
    expect(file.storage_path).not.toContain('listing.pdf');
    expect(fs.existsSync(path.join(storageDir, file.storage_path))).toBe(true);
    const download = await request(app).get(`/files/${file.id}`).expect(200);
    expect(download.headers['content-type']).toMatch(/^application\/pdf/);
  });

  it('adds and renames statuses and refuses to delete one in use', async () => {
    await request(app).post('/statuses').type('form').send({ result: 'interviewing' }).expect(302);
    const status = await db.get('SELECT * FROM application_result WHERE result = ?', ['interviewing']);
    await request(app).post(`/statuses/${status.id}/rename`).type('form').send({ result: 'offer' }).expect(302);
    expect(await db.get('SELECT result FROM application_result WHERE id = ?', [status.id])).toEqual({ result: 'offer' });

    await request(app).post('/applications').type('form').send({ link: 'https://example.com/job' }).expect(302);
    const waiting = await db.get('SELECT id FROM application_result WHERE result = ?', ['waiting']);
    const response = await request(app).post(`/statuses/${waiting.id}/delete`).expect(302);
    expect(response.headers.location).toContain('cannot%20be%20deleted');
    expect(await db.get('SELECT id FROM application_result WHERE id = ?', [waiting.id])).toBeTruthy();
    await request(app).post(`/statuses/${status.id}/delete`).expect(302);
    expect(await db.get('SELECT id FROM application_result WHERE id = ?', [status.id])).toBeUndefined();
  });

  it('replaces a linked file and safely removes the old file', async () => {
    await request(app).post('/applications').type('form').send({ link: 'https://example.com/job' }).expect(302);
    const original = await db.get('SELECT * FROM application_entry');
    const oldFile = await db.get('SELECT * FROM file_entry WHERE id = ?', [original.snapshot_id]);
    const waiting = await db.get('SELECT id FROM application_result WHERE result = ?', ['waiting']);

    await request(app)
      .post(`/applications/${original.id}/edit`)
      .field('name', 'Updated role')
      .field('link', 'https://example.com/job-updated')
      .field('created_at', '2026-10-20T10:30')
      .field('status_id', String(waiting.id))
      .field('comments', 'Recruiter screen booked')
      .attach('snapshot', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('new image')]), { filename: 'screen.png', contentType: 'image/png' })
      .expect(302);

    const updated = await db.get('SELECT * FROM application_entry WHERE id = ?', [original.id]);
    const newFile = await db.get('SELECT * FROM file_entry WHERE id = ?', [updated.snapshot_id]);
    expect(updated.name).toBe('Updated role');
    expect(updated.comments).toBe('Recruiter screen booked');
    expect(updated.snapshot_id).not.toBe(original.snapshot_id);
    expect(newFile.mime_type).toBe('image/png');
    expect(fs.existsSync(path.join(storageDir, oldFile.storage_path))).toBe(false);
    expect(await db.get('SELECT id FROM file_entry WHERE id = ?', [oldFile.id])).toBeUndefined();
  });

  it('rejects unsupported snapshot types', async () => {
    const response = await request(app)
      .post('/applications/manual')
      .field('name', 'Unsafe')
      .field('link', 'https://example.com/job')
      .attach('snapshot', Buffer.from('hello'), { filename: 'payload.txt', contentType: 'text/plain' })
      .expect(400);
    expect(response.text).toContain('Upload a PDF, PNG, JPEG, GIF, or WebP file.');
  });

  it('rejects a file whose contents do not match its claimed MIME type', async () => {
    const response = await request(app)
      .post('/applications/manual')
      .field('name', 'Spoofed')
      .field('link', 'https://example.com/job')
      .attach('snapshot', Buffer.from('not really a pdf'), { filename: 'listing.pdf', contentType: 'application/pdf' })
      .expect(400);
    expect(response.text).toContain('file contents do not match');
    expect(await db.get('SELECT COUNT(*) AS count FROM application_entry')).toEqual({ count: 0 });
  });
});
