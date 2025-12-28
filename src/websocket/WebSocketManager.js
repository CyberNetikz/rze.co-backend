/**
 * RZE Trading Platform - WebSocket Manager
 *
 * Manages WebSocket connections to the frontend for real-time updates.
 * Uses Socket.io for reliable bidirectional communication.
 */

const { Server } = require("socket.io");
const logger = require("../utils/logger");

class WebSocketManager {
  constructor() {
    this.io = null;
    this.connectedClients = new Set();
  }

  /**
   * Initialize the WebSocket server
   */
  initialize(httpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: ["https://rze.co", "https://backend.rze.co"],
        methods: ["GET", "POST"],
        credentials: true,
      },
      transports: ["websocket", "polling"],
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    this.io.on("connection", (socket) => {
      logger.info(`WebSocket client connected: ${socket.id}`);
      this.connectedClients.add(socket.id);

      // Send connection confirmation
      socket.emit("connected", {
        message: "Connected to RZE Trading Platform",
        timestamp: new Date().toISOString(),
      });

      // Handle client subscribing to specific trades
      socket.on("subscribe_trade", (tradeId) => {
        socket.join(`trade_${tradeId}`);
        logger.debug(`Client ${socket.id} subscribed to trade ${tradeId}`);
      });

      // Handle client unsubscribing from trades
      socket.on("unsubscribe_trade", (tradeId) => {
        socket.leave(`trade_${tradeId}`);
        logger.debug(`Client ${socket.id} unsubscribed from trade ${tradeId}`);
      });

      // Handle ping (for connection testing)
      socket.on("ping", () => {
        socket.emit("pong", { timestamp: new Date().toISOString() });
      });

      // Handle disconnect
      socket.on("disconnect", (reason) => {
        logger.info(`WebSocket client disconnected: ${socket.id} (${reason})`);
        this.connectedClients.delete(socket.id);
      });

      // Handle errors
      socket.on("error", (error) => {
        logger.error(`WebSocket error for client ${socket.id}:`, error);
      });
    });

    logger.info("WebSocket server initialized");
  }

  /**
   * Check if WebSocket server is connected
   */
  isConnected() {
    return this.io !== null;
  }

  /**
   * Get number of connected clients
   */
  getClientCount() {
    return this.connectedClients.size;
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcast(event, data) {
    if (!this.io) {
      logger.warn("WebSocket not initialized, cannot broadcast");
      return;
    }

    this.io.emit(event, {
      ...data,
      timestamp: new Date().toISOString(),
    });

    logger.debug(`Broadcast ${event} to ${this.connectedClients.size} clients`);
  }

  /**
   * Send message to clients subscribed to a specific trade
   */
  sendToTrade(tradeId, event, data) {
    if (!this.io) {
      logger.warn("WebSocket not initialized, cannot send to trade");
      return;
    }

    this.io.to(`trade_${tradeId}`).emit(event, {
      ...data,
      timestamp: new Date().toISOString(),
    });

    logger.debug(`Sent ${event} to trade_${tradeId} room`);
  }

  /**
   * Send account update
   */
  sendAccountUpdate(accountData) {
    this.broadcast("account_update", accountData);
  }

  /**
   * Send trade update
   */
  sendTradeUpdate(tradeData) {
    this.broadcast("trade_update", tradeData);

    // Also send to trade-specific room
    if (tradeData.trade && tradeData.trade.id) {
      this.sendToTrade(tradeData.trade.id, "trade_update", tradeData);
    }
  }

  /**
   * Send order update
   */
  sendOrderUpdate(orderData) {
    this.broadcast("order_update", orderData);

    // Also send to trade-specific room
    if (orderData.tradeId) {
      this.sendToTrade(orderData.tradeId, "order_update", orderData);
    }
  }

  /**
   * Send phase update
   */
  sendPhaseUpdate(tradeId, phaseData) {
    const data = { tradeId, ...phaseData };
    this.broadcast("phase_update", data);
    this.sendToTrade(tradeId, "phase_update", data);
  }

  /**
   * Send notification
   */
  sendNotification(notification) {
    this.broadcast("notification", notification);
  }

  /**
   * Send market status update
   */
  sendMarketStatus(status) {
    this.broadcast("market_status", status);
  }

  /**
   * Shutdown WebSocket server
   */
  shutdown() {
    if (this.io) {
      // Notify all clients
      this.broadcast("server_shutdown", {
        message: "Server is shutting down",
      });

      // Close all connections
      this.io.close();
      this.io = null;
      this.connectedClients.clear();

      logger.info("WebSocket server shut down");
    }
  }
}

module.exports = new WebSocketManager();
