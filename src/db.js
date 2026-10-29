const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');

class Database {
  constructor(filename) {
    this.raw = new sqlite3.Database(filename);
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.raw.run(sql, params, function onRun(error) {
        if (error) reject(error);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.raw.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.raw.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
  }

  exec(sql) {
    return new Promise((resolve, reject) => {
      this.raw.exec(sql, error => error ? reject(error) : resolve());
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      this.raw.close(error => error ? reject(error) : resolve());
    });
  }

  async transaction(work) {
    await this.exec('BEGIN IMMEDIATE');
    try {
      const result = await work(this);
      await this.exec('COMMIT');
      return result;
    } catch (error) {
      await this.exec('ROLLBACK').catch(() => {});
      throw error;
    }
  }
}

async function createDatabase(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.exec(schema);
  await db.run('INSERT OR IGNORE INTO application_result(result) VALUES (?)', ['waiting']);
  await db.run('INSERT OR IGNORE INTO application_result(result) VALUES (?)', ['rejected']);
  return db;
}

module.exports = { createDatabase };
