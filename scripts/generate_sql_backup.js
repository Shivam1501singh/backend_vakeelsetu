import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../src/lib/prisma.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function exportBackup() {
  console.log('Connecting to database...');

  // Get all tables in public schema
  const tables = await prisma.$queryRaw`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '_prisma%'
    ORDER BY table_name ASC;
  `;

  console.log(`Found ${tables.length} tables to backup.`);

  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `backup_${dateStr}.sql`;
  const backupFilePath = path.join(__dirname, '..', backupFileName);

  const writeStream = fs.createWriteStream(backupFilePath, { encoding: 'utf8' });

  writeStream.write(`-- Vakeelsetu Database SQL Backup\n`);
  writeStream.write(`-- Generated at: ${new Date().toISOString()}\n`);
  writeStream.write(`-- Source: Neon PostgreSQL\n\n`);
  writeStream.write(`SET client_encoding = 'UTF8';\n`);
  writeStream.write(`SET standard_conforming_strings = on;\n`);
  writeStream.write(`SET check_function_bodies = false;\n`);
  writeStream.write(`SET client_min_messages = warning;\n`);
  writeStream.write(`SET row_security = off;\n\n`);
  writeStream.write(`-- Disable foreign key constraints during restore\n`);
  writeStream.write(`SET session_replication_role = 'replica';\n\n`);

  let totalRows = 0;

  for (const { table_name } of tables) {
    // Get column information
    const columns = await prisma.$queryRaw`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = ${table_name}
      ORDER BY ordinal_position ASC;
    `;

    const colMap = new Map();
    columns.forEach(c => colMap.set(c.column_name, c));

    // Fetch all rows
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${table_name}";`);
    console.log(`Table "${table_name}": ${rows.length} rows`);
    totalRows += rows.length;

    if (rows.length === 0) continue;

    writeStream.write(`-- --------------------------------------------------------\n`);
    writeStream.write(`-- Table data for: "${table_name}" (${rows.length} rows)\n`);
    writeStream.write(`-- --------------------------------------------------------\n`);

    const colNames = columns.map(c => `"${c.column_name}"`).join(', ');

    // Chunk inserts into batches of 100 for safety and efficiency
    const chunkSize = 100;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const valuesSqlList = [];

      for (const row of chunk) {
        const valStrs = columns.map(col => {
          const val = row[col.column_name];
          if (val === null || val === undefined) {
            return 'NULL';
          }
          if (typeof val === 'boolean') {
            return val ? 'TRUE' : 'FALSE';
          }
          if (typeof val === 'number') {
            return Number.isFinite(val) ? val.toString() : 'NULL';
          }
          if (typeof val === 'bigint') {
            return val.toString();
          }
          if (val instanceof Date) {
            return `'${val.toISOString()}'`;
          }
          if (Array.isArray(val)) {
            // Postgres array or JSON array
            if (col.data_type === 'ARRAY') {
              const elements = val.map(v => {
                if (v === null || v === undefined) return 'NULL';
                return `"${String(v).replace(/"/g, '\\"')}"`;
              }).join(',');
              return `'${('{' + elements + '}').replace(/'/g, "''")}'`;
            }
            return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
          }
          if (typeof val === 'object') {
            return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
          }
          // String or other
          const strVal = String(val).replace(/\0/g, '').replace(/'/g, "''");
          return `'${strVal}'`;
        });

        valuesSqlList.push(`(${valStrs.join(', ')})`);
      }

      writeStream.write(
        `INSERT INTO "${table_name}" (${colNames})\nVALUES\n  ${valuesSqlList.join(',\n  ')}\nON CONFLICT DO NOTHING;\n\n`
      );
    }
  }

  // Restore foreign key checks
  writeStream.write(`\n-- Re-enable foreign key constraints\n`);
  writeStream.write(`SET session_replication_role = 'DEFAULT';\n\n`);

  // Update sequences if needed
  writeStream.write(`-- Reset table sequences\n`);
  writeStream.write(`DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT table_name, column_name, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' 
          AND column_default LIKE 'nextval(%'
    ) LOOP
        EXECUTE 'SELECT setval(pg_get_serial_sequence(''' || quote_ident(r.table_name) || ''', ''' || quote_ident(r.column_name) || '''), COALESCE(MAX(' || quote_ident(r.column_name) || '), 1)) FROM ' || quote_ident(r.table_name);
    END LOOP;
END $$;
\n`);

  await new Promise(resolve => writeStream.end(resolve));

  console.log(`\nBackup completed successfully!`);
  console.log(`File: ${backupFilePath}`);
  console.log(`Total rows exported: ${totalRows}`);
}

exportBackup()
  .catch(err => {
    console.error('Error during backup:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

