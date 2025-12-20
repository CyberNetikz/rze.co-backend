/**
 * RZE Trading Platform - Trade Monitor
 *
 * This service monitors active trades using Alpaca WebSocket
 * and handles order fill events to trigger phase transitions.
 */

const Alpaca = require("@alpacahq/alpaca-trade-api");
const database = require("../config/database");
const TradeExecutionService = require("./TradeExecutionService");
const NotificationService = require("./NotificationService");
const WebSocketManager = require("../websocket/WebSocketManager");
const logger = require("../utils/logger");

class TradeMonitor {
  constructor() {
    this.alpacaWs = null;
    this.isRunning = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
  }

  /**
   * Start the trade monitor
   */
  async start() {
    if (this.isRunning) {
      logger.warn("Trade monitor is already running");
      return;
    }

    logger.info("Starting trade monitor...");

    try {
      await this.connectWebSocket();
      this.isRunning = true;

      // Also start periodic sync as backup
      this.startPeriodicSync();

      logger.info("Trade monitor started successfully");
    } catch (error) {
      logger.error("Failed to start trade monitor:", error);
      throw error;
    }
  }

  /**
   * Stop the trade monitor
   */
  async stop() {
    logger.info("Stopping trade monitor...");

    this.isRunning = false;

    if (this.alpacaWs) {
      this.alpacaWs.disconnect();
      this.alpacaWs = null;
    }

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    logger.info("Trade monitor stopped");
  }

  /**
   * Connect to Alpaca WebSocket for trade updates
   */
  async connectWebSocket() {
    const mode = process.env.TRADING_MODE || "paper";

    const config = {
      keyId:
        mode === "live"
          ? process.env.ALPACA_LIVE_API_KEY
          : process.env.ALPACA_PAPER_API_KEY,
      secretKey:
        mode === "live"
          ? process.env.ALPACA_LIVE_SECRET_KEY
          : process.env.ALPACA_PAPER_SECRET_KEY,
      paper: mode === "paper",
    };

    this.alpacaWs = new Alpaca(config);

    // Subscribe to trade updates
    const tradeUpdates = this.alpacaWs.trade_ws;

    tradeUpdates.onConnect(() => {
      logger.info("Connected to Alpaca trade updates WebSocket");
      this.reconnectAttempts = 0;

      // Subscribe to trade updates
      tradeUpdates.subscribe(["trade_updates"]);
    });

    tradeUpdates.onDisconnect(() => {
      logger.warn("Disconnected from Alpaca trade updates WebSocket");
      this.handleDisconnect();
    });

    tradeUpdates.onError((error) => {
      logger.error("Alpaca WebSocket error:", error);
    });

    tradeUpdates.onOrderUpdate((update) => {
      this.handleOrderUpdate(update);
    });

    // Connect
    tradeUpdates.connect();
  }

  /**
   * Handle WebSocket disconnection
   */
  async handleDisconnect() {
    if (!this.isRunning) return;

    this.reconnectAttempts++;

    if (this.reconnectAttempts <= this.maxReconnectAttempts) {
      logger.info(
        `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
      );

      setTimeout(() => {
        this.connectWebSocket();
      }, this.reconnectDelay * this.reconnectAttempts);
    } else {
      logger.error("Max reconnection attempts reached");

      await NotificationService.send({
        type: "error",
        title: "🚨 WebSocket Connection Lost",
        message:
          "Failed to reconnect to Alpaca after multiple attempts. Please check the system.",
      });
    }
  }

  /**
   * Handle order update events from Alpaca
   */
  async handleOrderUpdate(update) {
    const db = database.getDb();

    logger.alpaca("Order update received", update);

    try {
      const orderId = update.order.id;
      const event = update.event;
      const order = update.order;

      console.log("Trade Order[handleOrderUpdate] ", order);

      // Find our order record
      const dbOrder = await db("orders")
        .where("alpaca_order_id", orderId)
        .first();

      if (!dbOrder) {
        logger.debug(
          `Order ${orderId} not found in database (may be external order)`
        );
        return;
      }

      // Update order status
      await db("orders")
        .where("id", dbOrder.id)
        .update({
          status: order.status,
          filled_qty: parseInt(order.filled_qty) || 0,
          filled_avg_price: order.filled_avg_price
            ? parseFloat(order.filled_avg_price)
            : null,
          filled_at: order.filled_at || null,
          updated_at: db.fn.now(),
        });

      // Log the event
      await db("order_events").insert({
        order_id: dbOrder.id,
        trade_id: dbOrder.trade_id,
        event_type: event,
        event_data: JSON.stringify(update),
        description: `Order ${event}: ${order.symbol} ${order.side} ${
          order.filled_qty
        }/${order.qty} @ ${order.filled_avg_price || "N/A"}`,
      });

      // Broadcast to frontend
      WebSocketManager.broadcast("order_update", {
        tradeId: dbOrder.trade_id,
        orderId: dbOrder.id,
        event,
        order: {
          symbol: order.symbol,
          side: order.side,
          status: order.status,
          filledQty: parseInt(order.filled_qty) || 0,
          qty: parseInt(order.qty),
          filledAvgPrice: order.filled_avg_price
            ? parseFloat(order.filled_avg_price)
            : null,
        },
      });

      // Handle specific events
      switch (event) {
        case "fill":
          await this.handleOrderFill(dbOrder, order);
          break;

        case "partial_fill":
          logger.info(`Partial fill: ${order.filled_qty}/${order.qty} shares`);
          break;

        case "canceled":
          logger.info(`Order cancelled: ${orderId}`);
          break;

        case "rejected":
          logger.error(`Order rejected: ${orderId}`, order);
          await this.handleOrderRejection(dbOrder, order);
          break;

        case "expired":
          logger.warn(`Order expired: ${orderId}`);
          break;
      }
    } catch (error) {
      logger.error("Error handling order update:", error);
    }
  }

  /**
   * Handle a filled order
   */
  async handleOrderFill(dbOrder, alpacaOrder) {
    const fillPrice = parseFloat(alpacaOrder.filled_avg_price);
    const filledQty = parseInt(alpacaOrder.filled_qty);

    logger.order("Order filled", {
      orderId: dbOrder.id,
      purpose: dbOrder.purpose,
      phase: dbOrder.phase,
      fillPrice,
      filledQty,
    });

    switch (dbOrder.purpose) {
      case "entry":
        // Entry order filled - initiate Phase 1
        await TradeExecutionService.handleEntryFill(
          dbOrder.trade_id,
          fillPrice,
          filledQty
        );
        break;

      case "phase_tp":
        // Take profit hit for a phase
        await TradeExecutionService.handlePhaseTakeProfitHit(
          dbOrder.trade_id,
          dbOrder.phase,
          fillPrice
        );
        break;

      case "phase_sl":
      case "remaining_sl":
        // Stop loss hit
        await TradeExecutionService.handlePhaseStopLossHit(
          dbOrder.trade_id,
          dbOrder.phase,
          fillPrice,
          filledQty
        );
        break;
    }

    // Broadcast trade update
    await this.broadcastTradeUpdate(dbOrder.trade_id);
  }

  /**
   * Handle order rejection
   */
  async handleOrderRejection(dbOrder, alpacaOrder) {
    const db = database.getDb();

    logger.error("Order rejected", {
      orderId: dbOrder.id,
      reason: alpacaOrder.reject_reason || "Unknown",
    });

    // Update order with error
    await db("orders")
      .where("id", dbOrder.id)
      .update({
        status: "rejected",
        error_message: alpacaOrder.reject_reason || "Order rejected by Alpaca",
      });

    // Send notification
    await NotificationService.send({
      type: "error",
      title: "⚠️ Order Rejected",
      message: `Order for ${dbOrder.symbol} was rejected: ${
        alpacaOrder.reject_reason || "Unknown reason"
      }`,
      tradeId: dbOrder.trade_id,
    });
  }

  /**
   * Broadcast trade update to frontend
   */
  async broadcastTradeUpdate(tradeId) {
    const db = database.getDb();

    const trade = await db("trades").where("id", tradeId).first();
    if (!trade) return;

    const phases = await db("trade_phases")
      .where("trade_id", tradeId)
      .orderBy("phase_number");

    WebSocketManager.broadcast("trade_update", {
      trade: {
        id: trade.id,
        symbol: trade.symbol,
        status: trade.status,
        currentPhase: trade.current_phase,
        entryPrice: parseFloat(trade.entry_price),
        totalShares: trade.total_shares,
        remainingShares: trade.remaining_shares,
        realizedPnl: trade.realized_pnl ? parseFloat(trade.realized_pnl) : null,
        realizedPnlPct: trade.realized_pnl_pct
          ? parseFloat(trade.realized_pnl_pct)
          : null,
      },
      phases: phases.map((p) => ({
        phaseNumber: p.phase_number,
        status: p.status,
        takeProfitPrice: parseFloat(p.take_profit_price),
        stopLossPrice: parseFloat(p.stop_loss_price),
        sharesToSell: p.shares_to_sell,
        phasePnl: p.phase_pnl ? parseFloat(p.phase_pnl) : null,
      })),
    });
  }

  async logMarketStatus() {
    try {
      const mode = process.env.TRADING_MODE || "paper";

      const alpaca = new Alpaca({
        keyId:
          mode === "live"
            ? process.env.ALPACA_LIVE_API_KEY
            : process.env.ALPACA_PAPER_API_KEY,
        secretKey:
          mode === "live"
            ? process.env.ALPACA_LIVE_SECRET_KEY
            : process.env.ALPACA_PAPER_SECRET_KEY,
        paper: mode === "paper",
      });

      const clock = await alpaca.getClock();

      logger.info("⏰ Market Status Check (Periodic Sync)", {
        marketOpen: clock.is_open,
        serverTime: clock.timestamp,
        nextOpen: clock.next_open,
        nextClose: clock.next_close,
      });

      return clock;
    } catch (error) {
      logger.error("❌ Failed to fetch Alpaca market clock", {
        message: error.message,
        stack: error.stack,
      });
      return null;
    }
  }

  /**
   * Start periodic sync as backup to WebSocket
   */
  startPeriodicSync() {
    // Sync every 30 seconds as backup
    this.syncInterval = setInterval(async () => {
      logger.info("🔄 Periodic order sync triggered");
      // 👀 Log market open/close status
      const marketClock = await this.logMarketStatus();

      if (marketClock && marketClock.is_open === false) {
        logger.warn("📉 Market is CLOSED — orders may not fill");
      }
      try {
        await this.syncOrders();
      } catch (error) {
        logger.error("Periodic sync error:", error);
      }
    }, 30000);
  }

  /**
   * Sync orders with Alpaca (backup to WebSocket)
   */
  async syncOrders() {
    const db = database.getDb();
    const AlpacaService = require("./AlpacaService");

    // Get open orders from database
    const dbOrders = await db("orders")
      .whereIn("status", ["new", "accepted", "pending_new", "partially_filled"])
      .select("*");

    if (dbOrders.length === 0) return;

    console.log(dbOrders, "dbOrders");

    // Get orders from Alpaca
    const alpacaOrders = await AlpacaService.getOrders("all", 500);
    const alpacaOrderMap = new Map(alpacaOrders.map((o) => [o.id, o]));
    console.log(alpacaOrders, "alpacaOrders");
    // console.log(alpacaOrderMap, "alpacaOrderMap");
    // Check each DB order
    for (const dbOrder of dbOrders) {
      const alpacaOrder = alpacaOrderMap.get(dbOrder.alpaca_order_id);

      if (alpacaOrder && alpacaOrder.status !== dbOrder.status) {
        logger.info(
          `Sync: Order ${dbOrder.id} status changed from ${dbOrder.status} to ${alpacaOrder.status}`
        );

        // Update status
        await db("orders").where("id", dbOrder.id).update({
          status: alpacaOrder.status,
          filled_qty: alpacaOrder.filled_qty,
          filled_avg_price: alpacaOrder.filled_avg_price,
          updated_at: db.fn.now(),
        });

        // Handle fills that we might have missed
        if (alpacaOrder.status === "filled" && dbOrder.status !== "filled") {
          await this.handleOrderFill(dbOrder, alpacaOrder);
        }
      }
    }
  }
}

module.exports = new TradeMonitor();
