const fs = require('node:fs');
const path = require('node:path');
const { createDatabase } = require('./db');
const { createApp } = require('./app');

async function start() {
  const root = path.join(__dirname, '..');
  const storageDir = process.env.STORAGE_DIR || path.join(root, 'storage');
  const databasePath = process.env.DATABASE_PATH || path.join(root, 'data', 'applications.sqlite');
  fs.mkdirSync(storageDir, { recursive: true });
  const db = await createDatabase(databasePath);
  const app = createApp({ db, storageDir });
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log(`Job application tracker: http://localhost:${port}`));
  const shutdown = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch(error => {
  console.error('Could not start the application:', error);
  process.exit(1);
});
