import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
export class State {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'agent.sqlite'));
    chmodSync(path.join(directory, 'agent.sqlite'), 0o600);
    this.db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
  }

  get(key) {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }

  put(key, value) {
    this.db
      .prepare(
        'INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  close() {
    this.db.close();
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
