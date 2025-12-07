/**
 * RZE Trading Platform - Logger Utility
 * 
 * Centralized logging with Winston.
 * Logs to console and optionally to file.
 */

const winston = require('winston');
const path = require('path');

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    
    // Add stack trace for errors
    if (stack) {
      log += `\n${stack}`;
    }
    
    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta)}`;
    }
    
    return log;
  })
);

// Console format with colors
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    let log = `${timestamp} ${level}: ${message}`;
    if (Object.keys(meta).length > 0 && !meta.stack) {
      log += ` ${JSON.stringify(meta)}`;
    }
    return log;
  })
);

// Create transports array
const transports = [
  // Console transport
  new winston.transports.Console({
    format: consoleFormat
  })
];

// Add file transport if LOG_FILE is specified
if (process.env.LOG_FILE) {
  const logDir = path.dirname(process.env.LOG_FILE);
  
  transports.push(
    // General log file
    new winston.transports.File({
      filename: process.env.LOG_FILE,
      format: logFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    }),
    // Error-only log file
    new winston.transports.File({
      filename: process.env.LOG_FILE.replace('.log', '-error.log'),
      level: 'error',
      format: logFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5
    })
  );
}

// Create the logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports,
  // Don't exit on error
  exitOnError: false
});

// Add custom methods for trade-specific logging
logger.trade = (action, data) => {
  logger.info(`[TRADE] ${action}`, { trade: data });
};

logger.order = (action, data) => {
  logger.info(`[ORDER] ${action}`, { order: data });
};

logger.phase = (action, data) => {
  logger.info(`[PHASE] ${action}`, { phase: data });
};

logger.alpaca = (action, data) => {
  logger.debug(`[ALPACA] ${action}`, { alpaca: data });
};

// HTTP request logging (for Morgan-style logging)
logger.http = (message) => {
  logger.log('http', message);
};

// Add HTTP level
winston.addColors({
  http: 'magenta'
});

module.exports = logger;
