/**
 * RZE Trading Platform - Main Server
 *
 * This is the entry point for the RZE Phased Exit Trading Platform.
 * It initializes all services and starts the Express server with WebSocket support.
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const logger = require("./utils/logger");
const database = require("./config/database");
const AlpacaService = require("./services/AlpacaService");
const TradeMonitor = require("./services/TradeMonitor");
const TradeReconciliationService = require("./services/TradeReconciliationService");

const WebSocketManager = require("./websocket/WebSocketManager");
const NotificationService = require("./services/NotificationService");

// Import routes
const accountRoutes = require("./api/routes/account");
const tradeRoutes = require("./api/routes/trades");
const templateRoutes = require("./api/routes/templates");
const settingsRoutes = require("./api/routes/settings");
const historyRoutes = require("./api/routes/history");

const app = express();
const server = http.createServer(app);

// ===========================================
// MIDDLEWARE CONFIGURATION
// ===========================================

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: false, // Disable for development, enable in production
  })
);

// CORS configuration
app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, true); // allow all origins
    },
    credentials: true,
  })
);

// Compression
app.use(compression());

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api/", limiter);

// Request logging
app.use((req, res, next) => {
  logger.http(`${req.method} ${req.path}`);
  next();
});

// ===========================================
// API ROUTES
// ===========================================

app.use("/api/account", accountRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/history", historyRoutes);

// Health check endpoint
app.get("/api/health", async (req, res) => {
  try {
    const alpacaStatus = await AlpacaService.getConnectionStatus();
    const dbStatus = await database.checkConnection();

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus ? "connected" : "disconnected",
        alpaca: alpacaStatus,
        websocket: WebSocketManager.isConnected()
          ? "connected"
          : "disconnected",
      },
      tradingMode: process.env.TRADING_MODE || "paper",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// ===========================================
// SERVICE INITIALIZATION
// ===========================================

async function initializeServices() {
  try {
    logger.info("🚀 Starting RZE Trading Platform...");

    // 1. Connect to database
    logger.info("📦 Connecting to database...");
    await database.connect();
    logger.info("✅ Database connected");

    // 2. Initialize Alpaca service
    logger.info("📈 Initializing Alpaca service...");
    await AlpacaService.initialize();
    logger.info("✅ Alpaca service initialized");

    // 3. Initialize WebSocket manager for real-time updates
    logger.info("🔌 Starting WebSocket manager...");
    WebSocketManager.initialize(server);
    logger.info("✅ WebSocket manager started");

    // 4. Initialize notification service
    logger.info("🔔 Initializing notification service...");
    await NotificationService.initialize();
    logger.info("✅ Notification service initialized");

    // 5. Start trade monitor (watches for phase transitions)
    logger.info("👁️ Starting trade monitor...");
    await TradeMonitor.start();
    logger.info("✅ Trade monitor started");

    //  // 6. Start trade Reconciliation Service (watches for missing trade events fill)
    // logger.info("👁️ Starting trade reconciliation...");
    // await TradeReconciliationService.start();
    // logger.info("✅ Trade reconciliation started");

    // 7. Start the server
    const PORT = process.env.PORT || 3001;
    server.listen(PORT, () => {
      logger.info(`✅ Server running on port ${PORT}`);
      logger.info(`📊 Trading Mode: ${process.env.TRADING_MODE || "paper"}`);
      logger.info("🎯 RZE Trading Platform is ready!");

      // Send startup notification
      NotificationService.send({
        type: "system",
        title: "RZE Trading Platform Started",
        message: `Platform is now running in ${
          process.env.TRADING_MODE || "paper"
        } mode.`,
      });
    });
  } catch (error) {
    logger.error("❌ Failed to initialize services:", error);
    process.exit(1);
  }
}

// ===========================================
// GRACEFUL SHUTDOWN
// ===========================================

async function shutdown(signal) {
  logger.info(`\n${signal} received. Starting graceful shutdown...`);

  try {
    // Stop accepting new connections
    server.close(() => {
      logger.info("✅ HTTP server closed");
    });

    // Stop trade monitor
    await TradeMonitor.stop();
    logger.info("✅ Trade monitor stopped");

    // Close WebSocket connections
    WebSocketManager.shutdown();
    logger.info("✅ WebSocket connections closed");

    // Disconnect from Alpaca
    await AlpacaService.disconnect();
    logger.info("✅ Alpaca disconnected");

    // Close database connection
    await database.disconnect();
    logger.info("✅ Database disconnected");

    logger.info("👋 Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("❌ Error during shutdown:", error);
    process.exit(1);
  }
}

// Handle shutdown signals
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  shutdown("UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// ===========================================
// START THE APPLICATION
// ===========================================

initializeServices();
