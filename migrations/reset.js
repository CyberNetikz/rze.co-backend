/**
 * RZE Trading Platform - Reset Migration
 * WARNING: This will DROP ALL TABLES and DATA
 */

require('dotenv').config();
const knex = require('knex');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const readline = require('readline');

// ===========================================
// LOAD SSL CERTIFICATE
// ===========================================
let caCert;
const caPath = path.resolve(__dirname, '../src/config/certs/ca-certificate.crt');

if (fs.existsSync(caPath)) {
  caCert = fs.readFileSync(caPath).toString();
  console.log('🔐 Reset CA cert loaded, len=', caCert.length);
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
      ssl: { rejectUnauthorized: false }
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

// ===========================================
// CONFIRMATION PROMPT
// ===========================================
async function confirmReset() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    console.log('\n⚠️  WARNING: This will DELETE ALL DATA from the database!');
    console.log('📋 Tables to be dropped:');
    console.log('   - notifications');
    console.log('   - trade_phases');
    console.log('   - order_events');
    console.log('   - orders');
    console.log('   - trades');
    console.log('   - templates');
    console.log('   - settings');
    console.log('');
    
    rl.question('Are you sure you want to continue? (yes/no): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

// ===========================================
// RESET DATABASE
// ===========================================
async function resetDatabase() {
  try {
    console.log('\n🔄 Starting database reset...\n');
    
    // Drop tables in reverse order (respecting foreign key constraints)
    const tables = [
      'notifications',
      'trade_phases',
      'order_events',
      'orders',
      'trades',
      'templates',
      'settings'
    ];
    
    for (const table of tables) {
      const exists = await db.schema.hasTable(table);
      if (exists) {
        console.log(`🗑️  Dropping table: ${table}`);
        await db.schema.dropTable(table);
      } else {
        console.log(`⏭️  Table does not exist: ${table}`);
      }
    }
    
    console.log('\n✅ Database reset completed successfully!');
    console.log('💡 Run the migration script to recreate tables with default data.');
    
  } catch (error) {
    console.error('\n❌ Reset failed:', error.message);
    throw error;
  } finally {
    await db.destroy();
  }
}

// ===========================================
// MAIN EXECUTION
// ===========================================
async function main() {
  // Check if running in CI/test environment (skip confirmation)
  const skipConfirmation = process.argv.includes('--force') || 
                          process.env.CI === 'true' ||
                          process.env.NODE_ENV === 'test';
  
  if (skipConfirmation) {
    console.log('⚡ Force mode enabled, skipping confirmation...');
    await resetDatabase();
  } else {
    const confirmed = await confirmReset();
    
    if (confirmed) {
      await resetDatabase();
    } else {
      console.log('\n❌ Reset cancelled by user.');
      process.exit(0);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));