import fs from 'fs';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const sql = fs.readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log('Running migration...');
    await client.query(sql);
    console.log('Migration finished.');
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
