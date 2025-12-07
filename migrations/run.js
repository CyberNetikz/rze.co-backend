/**
 * RZE Trading Platform - Database Migrations
 */

require('dotenv').config();
const knex = require('knex');
const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');
const { URL } = require('url');

// ===========================================
// LOAD SSL CERTIFICATE
// ===========================================
let caCert;
const caPath = path.resolve(__dirname, '../src/config/certs/ca-certificate.crt');

if (fs.existsSync(caPath)) {
  caCert = fs.readFileSync(caPath).toString();
  console.log('🔐 Migration CA cert loaded, len=', caCert.length);
} else {
  console.warn('⚠️ CA cert missing at:', caPath);
}

// ===========================================
// DATABASE CONNECTION WITH SSL
// ===========================================
function getDbConfig() {
  if (process.env.DATABASE_URL) {
    const dbUrl = new URL(process.env.DATABASE_URL);

    return {
      host: dbUrl.hostname,
      port: Number(dbUrl.port),
      database: dbUrl.pathname.replace('/', ''),
      user: dbUrl.username,
      password: dbUrl.password,
      ssl: caCert
        ? { ca: caCert, rejectUnauthorized: true }
        : { rejectUnauthorized: false }
    };
  }

  return {
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT) || 5432,
    database: process.env.DATABASE_NAME || 'rze_trading',
    user: process.env.DATABASE_USER || 'rze_admin',
    password: process.env.DATABASE_PASSWORD,
    ssl: { rejectUnauthorized: false }
  };
}

const db = knex({
  client: 'pg',
  connection: getDbConfig()
});

// =====================================================
// SAFE CREATE TABLE UTIL
// =====================================================
async function createTableSafe(tableName, cb) {
  const exists = await db.schema.hasTable(tableName);
  if (!exists) {
    console.log('🆕 Creating table =>', tableName);
    return db.schema.createTable(tableName, cb);
  }

  console.log('✔ Table already exists =>', tableName);
}

async function migrate() {
  try {
    logger.info('Starting database migration...');

    // ===========================================
    // SETTINGS TABLE
    // ===========================================
    await createTableSafe('settings', (table) => {
      table.increments('id').primary();
      table.string('key').unique().notNullable();
      table.text('value');
      table.string('type').defaultTo('string');
      table.text('description');
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').defaultTo(db.fn.now());
    });

    // ===========================================
    // TEMPLATES TABLE
    // ===========================================
    await createTableSafe('templates', (table) => {
      table.increments('id').primary();
      table.string('name').notNullable();
      table.text('description');
      table.boolean('is_active').defaultTo(false);
      table.boolean('is_default').defaultTo(false);
      table.jsonb('phases').notNullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').defaultTo(db.fn.now());
    });

    // other tables (same pattern from your original code)
    // ----------------------------------------------------
    await createTableSafe('trades', (table) => {
      table.increments('id').primary();
      table.uuid('trade_uuid').unique().notNullable();
      table.string('symbol').notNullable();
      table.string('company_name');
      table.decimal('entry_price', 14, 4).notNullable();
      table.integer('total_shares').notNullable();
      table.decimal('position_size', 14, 2).notNullable();
      table.integer('remaining_shares').notNullable();
      table.integer('current_phase').defaultTo(1);
      table.enum('status', ['pending', 'active', 'completed', 'cancelled', 'error']).defaultTo('pending');
      table.integer('template_id');
      table.jsonb('template_snapshot');
      table.decimal('realized_pnl', 14, 2);
      table.decimal('realized_pnl_pct', 8, 4);
      table.string('exit_reason');
      table.integer('exit_phase');
      table.timestamp('entry_time').defaultTo(db.fn.now());
      table.timestamp('exit_time');
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').defaultTo(db.fn.now());
    });

    // -----------------------------------------------
    // INSERT DEFAULT SETTINGS
    // -----------------------------------------------
    logger.info('Inserting default data...');

    const defaultSettings = [
      { key: 'starting_capital', value: '0', type: 'number' },
      { key: 'trade_size_percent', value: '20', type: 'number' },
    ];

    for (const setting of defaultSettings) {
      const exists = await db('settings').where({ key: setting.key }).first();
      if (!exists) {
        await db('settings').insert(setting);
      }
    }

    logger.info('🎉 Migration completed successfully!');
  } catch (err) {
    logger.error('❌ Migration failed:', err);
    throw err;
  } finally {
    await db.destroy();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
