/**
 * RZE Trading Platform - Database Configuration
 * 
 * PostgreSQL database connection using Knex.js query builder.
 * Handles connection pooling and provides query methods.
 */

const knex = require('knex');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

let db = null;

// Load DO CA certificate if it exists
const caPath = path.resolve(__dirname, './certs/ca-certificate.crt');
let caCert;

if (fs.existsSync(caPath)) {
  caCert = fs.readFileSync(caPath).toString();
  console.log('✅ CA certificate loaded successfully. Length:', caCert.length);
} else {
  console.warn('⚠️ CA certificate not found at:', caPath);
}

// Knex configuration
const getKnexConfig = () => ({
  client: 'pg',
  connection: (() => {
    if (process.env.DATABASE_URL) {
      // Use connection string + SSL CA for DO managed DB
      return {
        connectionString: process.env.DATABASE_URL,
        ssl: caCert
          ? { ca: caCert, rejectUnauthorized: true } // secure connection
          : { rejectUnauthorized: false },          // fallback
      };
    }

    // Local or individual credentials
    return {
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT) || 5432,
      database: process.env.DATABASE_NAME || 'rze_trading',
      user: process.env.DATABASE_USER || 'rze_admin',
      password: process.env.DATABASE_PASSWORD,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false } // For production without CA
        : false
    };
  })(),
  pool: {
    min: 2,
    max: 10,
    acquireTimeoutMillis: 30000,
    createTimeoutMillis: 30000,
    destroyTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    reapIntervalMillis: 1000,
    createRetryIntervalMillis: 100
  },
  acquireConnectionTimeout: 10000
});

const database = {
  /**
   * Connect to the database
   */
  async connect() {
    try {
      db = knex(getKnexConfig());

      // Test the connection
      await db.raw('SELECT 1');
      logger.info('Database connection established');

      return db;
    } catch (error) {
      logger.error('Failed to connect to database:', error);
      throw error;
    }
  },

  /**
   * Get the database instance
   */
  getDb() {
    if (!db) {
      throw new Error('Database not initialized. Call connect() first.');
    }
    return db;
  },

  /**
   * Check if database is connected
   */
  async checkConnection() {
    try {
      if (!db) return false;
      await db.raw('SELECT 1');
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Disconnect from the database
   */
  async disconnect() {
    if (db) {
      await db.destroy();
      db = null;
      logger.info('Database connection closed');
    }
  },

  /**
   * Run a transaction
   */
  async transaction(callback) {
    return db.transaction(callback);
  }
};

module.exports = database;
