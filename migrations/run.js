/**
 * RZE Trading Platform - Database Migrations
 * 
 * Creates all necessary tables for the trading platform.
 * Run with: npm run migrate
 */

require('dotenv').config();

const knex = require('knex');
const logger = require('../src/utils/logger');

const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL || {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT) || 5432,
    database: process.env.DATABASE_NAME || 'rze_trading',
    user: process.env.DATABASE_USER || 'rze_admin',
    password: process.env.DATABASE_PASSWORD
  }
});

async function migrate() {
  try {
    logger.info('Starting database migration...');
    
    // ===========================================
    // SETTINGS TABLE
    // ===========================================
    logger.info('Creating settings table...');
    await db.schema.createTableIfNotExists('settings', (table) => {
      table.increments('id').primary();
      table.string('key').unique().notNullable();
      table.text('value');
      table.string('type').defaultTo('string'); // string, number, boolean, json
      table.text('description');
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').defaultTo(db.fn.now());
    });
    
    // ===========================================
    // TEMPLATES TABLE
    // ===========================================
    logger.info('Creating templates table...');
    await db.schema.createTableIfNotExists('templates', (table) => {
      table.increments('id').primary();
      table.string('name').notNullable();
      table.text('description');
      table.boolean('is_active').defaultTo(false);
      table.boolean('is_default').defaultTo(false);
      table.jsonb('phases').notNullable();
      /*
        phases structure:
        [
          { phase: 1, take_profit_pct: 2, stop_loss_pct: -2, sell_pct: 35 },
          { phase: 2, take_profit_pct: 5, stop_loss_pct: 0, sell_pct: 30 },
          { phase: 3, take_profit_pct: 8, stop_loss_pct: 2, sell_pct: 25 },
          { phase: 4, take_profit_pct: 12, stop_loss_pct: 5, sell_pct: 10 }
        ]
      */
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').defaultTo(db.fn.now());
    });
    
    // ===========================================
    // TRADES TABLE
    // ===========================================
    logger.info('Creating trades table...');
    await db.schema.createTableIfNotExists('trades', (table) => {
      table.increments('id').primary();
      table.uuid('trade_uuid').unique().notNullable();
      table.string('symbol').notNullable();
      table.string('company_name');
      
      // Entry details
      table.decimal('entry_price', 14, 4).notNullable();
      table.integer('total_shares').notNullable();
      table.decimal('position_size', 14, 2).notNullable();
      table.integer('remaining_shares').notNullable();
      
      // Current state
      table.integer('current_phase').defaultTo(1);
      table.enum('status', ['pending', 'active', 'completed', 'cancelled', 'error']).defaultTo('pending');
      
      // Template used
      table.integer('template_id').references('id').inTable('templates');
      table.jsonb('template_snapshot'); // Copy of template at time of trade
      
      // Results (filled when trade completes)
      table.decimal('realized_pnl', 14, 2);
      table.decimal('realized_pnl_pct', 8, 4);
      table.string('exit_reason'); // 'phase_4_complete', 'stopped_out', 'manual', 'cancelled'
      table.integer('exit_phase');
      
      // Timestamps
      table.timestamp('entry_time').defaultTo(db.fn.now());
      table.timestamp('exit_time');
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').defaultTo(db.fn.now());
      
      // Indexes
      table.index('symbol');
      table.index('status');
      table.index('entry_time');
    });
    
    // ===========================================
    // ORDERS TABLE
    // ===========================================
    logger.info('Creating orders table...');
    await db.schema.createTableIfNotExists('orders', (table) => {
      table.increments('id').primary();
      table.integer('trade_id').references('id').inTable('trades').onDelete('CASCADE');
      
      // Alpaca order details
      table.string('alpaca_order_id').unique();
      table.string('client_order_id');
      
      // Order details
      table.string('symbol').notNullable();
      table.enum('side', ['buy', 'sell']).notNullable();
      table.enum('order_type', ['market', 'limit', 'stop', 'stop_limit']).notNullable();
      table.enum('order_class', ['simple', 'oco', 'bracket']).defaultTo('simple');
      table.integer('qty').notNullable();
      table.decimal('limit_price', 14, 4);
      table.decimal('stop_price', 14, 4);
      table.string('time_in_force').defaultTo('gtc');
      table.boolean('extended_hours').defaultTo(true);
      
      // Phase info
      table.integer('phase');
      table.enum('purpose', [
        'entry',           // Initial buy order
        'phase_tp',        // Take profit order for a phase
        'phase_sl',        // Stop loss order for a phase
        'remaining_sl'     // Stop loss for remaining shares
      ]).notNullable();
      
      // Status
      table.enum('status', [
        'pending_new',
        'new',
        'accepted',
        'pending_cancel',
        'partially_filled',
        'filled',
        'cancelled',
        'rejected',
        'expired',
        'replaced'
      ]).defaultTo('pending_new');
      
      // Fill info
      table.integer('filled_qty').defaultTo(0);
      table.decimal('filled_avg_price', 14, 4);
      table.timestamp('filled_at');
      
      // Metadata
      table.text('error_message');
      table.jsonb('alpaca_response');
      
      // Timestamps
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').defaultTo(db.fn.now());
      
      // Indexes
      table.index('trade_id');
      table.index('alpaca_order_id');
      table.index('status');
    });
    
    // ===========================================
    // ORDER_EVENTS TABLE (Audit Log)
    // ===========================================
    logger.info('Creating order_events table...');
    await db.schema.createTableIfNotExists('order_events', (table) => {
      table.increments('id').primary();
      table.integer('order_id').references('id').inTable('orders').onDelete('CASCADE');
      table.integer('trade_id').references('id').inTable('trades').onDelete('CASCADE');
      
      table.string('event_type').notNullable(); // 'new', 'fill', 'partial_fill', 'cancelled', 'rejected', etc.
      table.jsonb('event_data');
      table.text('description');
      
      table.timestamp('event_time').defaultTo(db.fn.now());
      
      // Indexes
      table.index('order_id');
      table.index('trade_id');
      table.index('event_time');
    });
    
    // ===========================================
    // TRADE_PHASES TABLE (Phase History)
    // ===========================================
    logger.info('Creating trade_phases table...');
    await db.schema.createTableIfNotExists('trade_phases', (table) => {
      table.increments('id').primary();
      table.integer('trade_id').references('id').inTable('trades').onDelete('CASCADE');
      
      table.integer('phase_number').notNullable();
      table.enum('status', ['pending', 'active', 'completed', 'skipped']).defaultTo('pending');
      
      // Phase configuration (from template)
      table.decimal('take_profit_pct', 8, 4);
      table.decimal('stop_loss_pct', 8, 4);
      table.decimal('sell_pct', 8, 4);
      
      // Calculated prices
      table.decimal('take_profit_price', 14, 4);
      table.decimal('stop_loss_price', 14, 4);
      table.integer('shares_to_sell');
      
      // Results
      table.decimal('exit_price', 14, 4);
      table.enum('exit_type', ['take_profit', 'stop_loss']);
      table.decimal('phase_pnl', 14, 2);
      
      // Timestamps
      table.timestamp('started_at');
      table.timestamp('completed_at');
      table.timestamp('created_at').defaultTo(db.fn.now());
      
      // Indexes
      table.index('trade_id');
      table.index(['trade_id', 'phase_number']);
    });
    
    // ===========================================
    // NOTIFICATIONS TABLE
    // ===========================================
    logger.info('Creating notifications table...');
    await db.schema.createTableIfNotExists('notifications', (table) => {
      table.increments('id').primary();
      table.integer('trade_id').references('id').inTable('trades').onDelete('SET NULL');
      
      table.enum('type', ['trade', 'phase', 'error', 'system']).notNullable();
      table.string('title').notNullable();
      table.text('message');
      table.enum('channel', ['slack', 'email', 'both']).defaultTo('slack');
      table.boolean('sent').defaultTo(false);
      table.text('error_message');
      
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('sent_at');
      
      // Index
      table.index('sent');
    });
    
    // ===========================================
    // INSERT DEFAULT DATA
    // ===========================================
    logger.info('Inserting default settings...');
    
    // Default settings
    const defaultSettings = [
      { key: 'starting_capital', value: '0', type: 'number', description: 'Starting capital (synced from Alpaca account balance)' },
      { key: 'trade_size_percent', value: '20', type: 'number', description: 'Default trade size as percentage of starting capital' },
      { key: 'max_concurrent_positions', value: '10', type: 'number', description: 'Maximum number of concurrent open positions' },
      { key: 'trading_mode', value: 'paper', type: 'string', description: 'Current trading mode: paper or live' },
      { key: 'notifications_enabled', value: 'true', type: 'boolean', description: 'Whether notifications are enabled' },
      { key: 'slack_enabled', value: 'true', type: 'boolean', description: 'Whether Slack notifications are enabled' },
      { key: 'email_enabled', value: 'false', type: 'boolean', description: 'Whether email notifications are enabled' }
    ];
    
    for (const setting of defaultSettings) {
      const exists = await db('settings').where('key', setting.key).first();
      if (!exists) {
        await db('settings').insert(setting);
      }
    }
    
    logger.info('Inserting default templates...');
    
    // Default templates
    const defaultTemplates = [
      {
        name: 'Default',
        description: 'Balanced risk/reward for most market conditions',
        is_active: true,
        is_default: true,
        phases: JSON.stringify([
          { phase: 1, take_profit_pct: 2, stop_loss_pct: -2, sell_pct: 35 },
          { phase: 2, take_profit_pct: 5, stop_loss_pct: 0, sell_pct: 30 },
          { phase: 3, take_profit_pct: 8, stop_loss_pct: 2, sell_pct: 25 },
          { phase: 4, take_profit_pct: 12, stop_loss_pct: 5, sell_pct: 10 }
        ])
      },
      {
        name: 'Aggressive',
        description: 'Higher targets for trending markets',
        is_active: false,
        is_default: false,
        phases: JSON.stringify([
          { phase: 1, take_profit_pct: 3, stop_loss_pct: -1.5, sell_pct: 30 },
          { phase: 2, take_profit_pct: 6, stop_loss_pct: 0, sell_pct: 30 },
          { phase: 3, take_profit_pct: 10, stop_loss_pct: 3, sell_pct: 25 },
          { phase: 4, take_profit_pct: 15, stop_loss_pct: 6, sell_pct: 15 }
        ])
      },
      {
        name: 'Conservative',
        description: 'Tighter stops for volatile conditions',
        is_active: false,
        is_default: false,
        phases: JSON.stringify([
          { phase: 1, take_profit_pct: 1.5, stop_loss_pct: -1.5, sell_pct: 40 },
          { phase: 2, take_profit_pct: 4, stop_loss_pct: 0, sell_pct: 30 },
          { phase: 3, take_profit_pct: 6, stop_loss_pct: 1.5, sell_pct: 20 },
          { phase: 4, take_profit_pct: 9, stop_loss_pct: 4, sell_pct: 10 }
        ])
      },
      {
        name: 'Scalp',
        description: 'Quick exits for day trading',
        is_active: false,
        is_default: false,
        phases: JSON.stringify([
          { phase: 1, take_profit_pct: 1, stop_loss_pct: -1, sell_pct: 50 },
          { phase: 2, take_profit_pct: 2, stop_loss_pct: 0, sell_pct: 30 },
          { phase: 3, take_profit_pct: 3, stop_loss_pct: 1, sell_pct: 15 },
          { phase: 4, take_profit_pct: 5, stop_loss_pct: 2, sell_pct: 5 }
        ])
      }
    ];
    
    for (const template of defaultTemplates) {
      const exists = await db('templates').where('name', template.name).first();
      if (!exists) {
        await db('templates').insert(template);
      }
    }
    
    logger.info('✅ Migration completed successfully!');
    
  } catch (error) {
    logger.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await db.destroy();
  }
}

// Run migration
migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
