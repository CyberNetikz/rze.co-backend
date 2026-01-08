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
const TradeReconciliationService = require("./TradeReconciliationService");

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

      if (marketClock && marketClock.marketOpen === false) {
        logger.warn("📉 Market is CLOSED — orders may not fill");
      } else {
        logger.info("📈 Market is OPEN");
      }
      try {
        await this.syncOrders();
        await TradeReconciliationService.reconcileAllTrades();
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
      .whereIn("status", [
        "new",
        "accepted",
        "pending_new",
        "partially_filled",
        "filled",
      ])
      .select("*");

    if (dbOrders.length === 0) return;

    console.log(dbOrdersCount, "dbOrdersCount");

    // Get orders from Alpaca
    const alpacaOrders = await AlpacaService.getOrders("all", 500);
    const alpacaOrderMap = new Map(alpacaOrders.map((o) => [o.id, o]));
    console.log(alpacaOrdersCount, "alpacaOrdersCount");
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
        // if (alpacaOrder.status === "filled" && dbOrder.status !== "filled") {
        //   await this.handleOrderFill(dbOrder, alpacaOrder);
        // }
        if (alpacaOrder.status === "filled" && dbOrder.status !== "filled") {
          await this.handleOrderFill(dbOrder, alpacaOrder);
        }

        // 🆕 Handle canceled phase_tp orders - auto re-place them
        if (
          alpacaOrder.status === "canceled" &&
          dbOrder.purpose === "phase_tp" &&
          dbOrder.status !== "canceled"
        ) {
          logger.warn(
            `⚠️ Phase TP order canceled for ${dbOrder.symbol} Phase ${dbOrder.phase}`
          );
          await this.handleCanceledPhaseTakeProfit(dbOrder);
        }
      }
    }
  }

  // /**
  //  * 🆕 Handle canceled phase take-profit orders
  //  * Automatically re-places the order if the trade is still active
  //  */
  // async handleCanceledPhaseTakeProfit(dbOrder) {
  //   const db = database.getDb();

  //   try {
  //     // Get the trade
  //     const trade = await db("trades").where("id", dbOrder.trade_id).first();

  //     if (!trade) {
  //       logger.error(`Trade ${dbOrder.trade_id} not found`);
  //       return;
  //     }

  //     // Only re-place if trade is still active and in the same phase
  //     if (trade.status !== "active" || trade.current_phase !== dbOrder.phase) {
  //       logger.info(
  //         `Trade ${trade.symbol} no longer active or phase changed - not re-placing order`
  //       );
  //       return;
  //     }

  //     // Get the phase details
  //     const phase = await db("trade_phases")
  //       .where({
  //         trade_id: dbOrder.trade_id,
  //         phase_number: dbOrder.phase,
  //       })
  //       .first();

  //     if (!phase || phase.status !== "active") {
  //       logger.info(
  //         `Phase ${dbOrder.phase} for ${trade.symbol} is not active - not re-placing order`
  //       );
  //       return;
  //     }

  //     // Check if there's already a new order for this phase
  //     const existingOrder = await db("orders")
  //       .where({
  //         trade_id: dbOrder.trade_id,
  //         phase: dbOrder.phase,
  //         purpose: "phase_tp",
  //       })
  //       .whereIn("status", ["new", "accepted", "pending_new"])
  //       .first();

  //     if (existingOrder) {
  //       logger.info(
  //         `Phase ${dbOrder.phase} for ${trade.symbol} already has an active order - skipping`
  //       );
  //       return;
  //     }

  //     logger.info(
  //       `🔄 Re-placing Phase ${dbOrder.phase} TP order for ${trade.symbol}`
  //     );

  //     // Re-place the OCO order (TP + SL)
  //     await this.replacePhaseTakeProfitOrder(trade, phase);

  //     // Send notification
  //     await NotificationService.send({
  //       type: "info",
  //       title: "🔄 Order Auto-Replaced",
  //       message: `Phase ${phase.phase_number} take-profit order for ${trade.symbol} was canceled and has been automatically re-placed.`,
  //       tradeId: trade.id,
  //     });
  //   } catch (error) {
  //     logger.error(
  //       `Error handling canceled phase TP for order ${dbOrder.id}:`,
  //       error
  //     );

  //     // Send error notification
  //     await NotificationService.send({
  //       type: "error",
  //       title: "⚠️ Failed to Re-place Order",
  //       message: `Could not automatically re-place Phase ${dbOrder.phase} order for ${dbOrder.symbol}: ${error.message}`,
  //       tradeId: dbOrder.trade_id,
  //     });
  //   }
  // }

  // /**
  //  * 🆕 Re-place phase take-profit OCO order
  //  */
  // async replacePhaseTakeProfitOrder(trade, phase) {
  //   const db = database.getDb();
  //   const AlpacaService = require("./AlpacaService");

  //   const tpPrice = parseFloat(phase.take_profit_price);
  //   const slPrice = parseFloat(phase.stop_loss_price);
  //   const sharesToSell = phase.shares_to_sell;

  //   logger.order("Re-placing Phase TP OCO order", {
  //     tradeId: trade.id,
  //     symbol: trade.symbol,
  //     phase: phase.phase_number,
  //     tpPrice,
  //     slPrice,
  //     sharesToSell,
  //   });

  //   // Place OCO order (Take Profit + Stop Loss)
  //   const ocoOrder = await AlpacaService.placeOCOOrder({
  //     symbol: trade.symbol,
  //     qty: sharesToSell,
  //     takeProfitPrice: tpPrice,
  //     stopLossPrice: slPrice,
  //     clientOrderId: `RZE-P${phase.phase_number}-OCO-${trade.trade_uuid}`,
  //   });

  //   // Save the new order to database
  //   await db("orders").insert({
  //     trade_id: trade.id,
  //     alpaca_order_id: ocoOrder.id,
  //     client_order_id: ocoOrder.client_order_id,
  //     symbol: trade.symbol,
  //     side: "sell",
  //     order_type: "limit",
  //     order_class: "oco",
  //     qty: sharesToSell,
  //     limit_price: tpPrice,
  //     stop_price: slPrice,
  //     time_in_force: "gtc",
  //     phase: phase.phase_number,
  //     purpose: "phase_tp",
  //     status: ocoOrder.status,
  //     alpaca_response: JSON.stringify(ocoOrder),
  //   });

  //   logger.success(
  //     `✅ Re-placed Phase ${phase.phase_number} TP order for ${trade.symbol}`
  //   );
  // }

  // /**
  //  * 🆕 Additional helper: Check for orphaned phases
  //  * Finds active phases without corresponding orders and places them
  //  */
  // async checkOrphanedPhases() {
  //   const db = database.getDb();

  //   logger.info("🔍 Checking for orphaned phases (phases without orders)");

  //   // Get all active trades
  //   const activeTrades = await db("trades")
  //     .where("status", "active")
  //     .select("*");

  //   for (const trade of activeTrades) {
  //     // Get active phases for this trade
  //     const activePhases = await db("trade_phases")
  //       .where({
  //         trade_id: trade.id,
  //         status: "active",
  //       })
  //       .select("*");

  //     for (const phase of activePhases) {
  //       // Check if this phase has an active order
  //       const existingOrder = await db("orders")
  //         .where({
  //           trade_id: trade.id,
  //           phase: phase.phase_number,
  //           purpose: "phase_tp",
  //         })
  //         .whereIn("status", ["new", "accepted", "pending_new"])
  //         .first();

  //       if (!existingOrder) {
  //         logger.warn(
  //           `⚠️ Orphaned phase detected: ${trade.symbol} Phase ${phase.phase_number} has no active order`
  //         );

  //         // Re-place the order
  //         await this.replacePhaseTakeProfitOrder(trade, phase);

  //         // Send notification
  //         await NotificationService.send({
  //           type: "warning",
  //           title: "⚠️ Orphaned Phase Detected",
  //           message: `Phase ${phase.phase_number} for ${trade.symbol} had no active order. Order has been placed.`,
  //           tradeId: trade.id,
  //         });
  //       }
  //     }
  //   }

  //   logger.info("✅ Orphaned phase check complete");
  // }

  // /**
  //  * Enhanced syncOrders - Automatically re-places canceled phase_tp orders
  //  */
  // async syncOrders() {
  //   const db = database.getDb();
  //   const AlpacaService = require("./AlpacaService");

  //   // Get orders for active trades
  //   // Strategy: Sync ALL orders belonging to active trades (no time limit)
  //   // This ensures we catch all order states, including old canceled/filled OCO legs
  //   const activeTrades = await db("trades")
  //     .whereIn("status", ["active", "pending"])
  //     .select("id");

  //   const activeTradeIds = activeTrades.map((t) => t.id);

  //   if (activeTradeIds.length === 0) {
  //     logger.info("No active trades to sync");
  //     return;
  //   }

  //   // Get ALL orders for active trades (including filled/canceled)
  //   // This is crucial for detecting OCO legs that filled while parent was canceled
  //   const dbOrders = await db("orders")
  //     .whereIn("trade_id", activeTradeIds)
  //     .select("*");

  //   if (dbOrders.length === 0) return;

  //   logger.info(`🔄 Syncing ${dbOrders.length} orders`);

  //   // Get orders from Alpaca
  //   const alpacaOrders = await AlpacaService.getOrders("all", 500);
  //   const alpacaOrderMap = new Map(alpacaOrders.map((o) => [o.id, o]));

  //   // Check each DB order
  //   for (const dbOrder of dbOrders) {
  //     const alpacaOrder = alpacaOrderMap.get(dbOrder.alpaca_order_id);

  //     if (!alpacaOrder) {
  //       // Order not found in Alpaca - might be very old or an issue
  //       continue;
  //     }

  //     if (alpacaOrder.status !== dbOrder.status) {
  //       logger.info(
  //         `Sync: Order ${dbOrder.id} status changed from ${dbOrder.status} to ${alpacaOrder.status}`
  //       );

  //       // Update status in database
  //       await db("orders").where("id", dbOrder.id).update({
  //         status: alpacaOrder.status,
  //         filled_qty: alpacaOrder.filled_qty,
  //         filled_avg_price: alpacaOrder.filled_avg_price,
  //         updated_at: db.fn.now(),
  //       });

  //       // Handle fills that we might have missed
  //       if (alpacaOrder.status === "filled" && dbOrder.status !== "filled") {
  //         await this.handleOrderFill(dbOrder, alpacaOrder);
  //       }

  //       // 🆕 Handle canceled phase_tp orders - auto re-place them
  //       if (
  //         alpacaOrder.status === "canceled" &&
  //         dbOrder.purpose === "phase_tp" &&
  //         dbOrder.status !== "canceled"
  //       ) {
  //         logger.warn(
  //           `⚠️ Phase TP order canceled for ${dbOrder.symbol} Phase ${dbOrder.phase}`
  //         );
  //         await this.handleCanceledPhaseTakeProfit(dbOrder);
  //       }
  //     }

  //     // 🆕 CRITICAL: Check OCO legs for fills
  //     // OCO parent might show "canceled" but one leg could have filled
  //     if (
  //       alpacaOrder.order_class === "oco" &&
  //       alpacaOrder.legs &&
  //       alpacaOrder.legs.length > 0
  //     ) {
  //       for (const leg of alpacaOrder.legs) {
  //         if (leg.status === "filled") {
  //           logger.warn(
  //             `⚠️ OCO leg filled for ${dbOrder.symbol} Phase ${dbOrder.phase}: ${leg.type} @ ${leg.filled_avg_price}`
  //           );

  //           // Determine if this was the TP or SL leg that filled
  //           if (leg.type === "limit") {
  //             // Take profit leg filled
  //             await this.handleOrderFill(dbOrder, leg);
  //           } else if (leg.type === "stop") {
  //             // Stop loss leg filled - create a temporary order object
  //             const slOrder = {
  //               ...dbOrder,
  //               filled_avg_price: leg.filled_avg_price,
  //               filled_qty: leg.filled_qty,
  //               purpose: dbOrder.phase === 1 ? "remaining_sl" : "phase_sl",
  //             };
  //             await this.handleOrderFill(slOrder, leg);
  //           }
  //         }
  //       }
  //     }
  //   }
  // }

  // /**
  //  * 🆕 Handle canceled phase take-profit orders
  //  * Automatically re-places the order if the trade is still active
  //  */
  // async handleCanceledPhaseTakeProfit(dbOrder) {
  //   const db = database.getDb();

  //   try {
  //     // Get the trade
  //     const trade = await db("trades").where("id", dbOrder.trade_id).first();

  //     if (!trade) {
  //       logger.error(`Trade ${dbOrder.trade_id} not found`);
  //       return;
  //     }

  //     // Only re-place if trade is still active and in the same phase
  //     if (trade.status !== "active" || trade.current_phase !== dbOrder.phase) {
  //       logger.info(
  //         `Trade ${trade.symbol} no longer active or phase changed - not re-placing order`
  //       );
  //       return;
  //     }

  //     // Get the phase details
  //     const phase = await db("trade_phases")
  //       .where({
  //         trade_id: dbOrder.trade_id,
  //         phase_number: dbOrder.phase,
  //       })
  //       .first();

  //     if (!phase || phase.status !== "active") {
  //       logger.info(
  //         `Phase ${dbOrder.phase} for ${trade.symbol} is not active - not re-placing order`
  //       );
  //       return;
  //     }

  //     // Check if there's already a new order for this phase
  //     const existingOrder = await db("orders")
  //       .where({
  //         trade_id: dbOrder.trade_id,
  //         phase: dbOrder.phase,
  //         purpose: "phase_tp",
  //       })
  //       .whereIn("status", ["new", "accepted", "pending_new"])
  //       .first();

  //     if (existingOrder) {
  //       logger.info(
  //         `Phase ${dbOrder.phase} for ${trade.symbol} already has an active order - skipping`
  //       );
  //       return;
  //     }

  //     logger.info(
  //       `🔄 Re-placing Phase ${dbOrder.phase} TP order for ${trade.symbol}`
  //     );

  //     // Re-place the OCO order (TP + SL)
  //     await this.replacePhaseTakeProfitOrder(trade, phase);

  //     // Send notification
  //     await NotificationService.send({
  //       type: "info",
  //       title: "🔄 Order Auto-Replaced",
  //       message: `Phase ${phase.phase_number} take-profit order for ${trade.symbol} was canceled and has been automatically re-placed.`,
  //       tradeId: trade.id,
  //     });
  //   } catch (error) {
  //     logger.error(
  //       `Error handling canceled phase TP for order ${dbOrder.id}:`,
  //       error
  //     );

  //     // Send error notification
  //     await NotificationService.send({
  //       type: "error",
  //       title: "⚠️ Failed to Re-place Order",
  //       message: `Could not automatically re-place Phase ${dbOrder.phase} order for ${dbOrder.symbol}: ${error.message}`,
  //       tradeId: dbOrder.trade_id,
  //     });
  //   }
  // }

  // /**
  //  * 🆕 Re-place phase take-profit OCO order
  //  */
  // async replacePhaseTakeProfitOrder(trade, phase) {
  //   const db = database.getDb();
  //   const AlpacaService = require("./AlpacaService");

  //   const tpPrice = parseFloat(phase.take_profit_price);
  //   const slPrice = parseFloat(phase.stop_loss_price);
  //   const sharesToSell = phase.shares_to_sell;

  //   logger.order("Re-placing Phase TP OCO order", {
  //     tradeId: trade.id,
  //     symbol: trade.symbol,
  //     phase: phase.phase_number,
  //     tpPrice,
  //     slPrice,
  //     sharesToSell,
  //   });

  //   // Place OCO order (Take Profit + Stop Loss)
  //   const ocoOrder = await AlpacaService.placeOCOOrder({
  //     symbol: trade.symbol,
  //     qty: sharesToSell,
  //     takeProfitPrice: tpPrice,
  //     stopLossPrice: slPrice,
  //     clientOrderId: `RZE-P${phase.phase_number}-OCO-${trade.trade_uuid}`,
  //   });

  //   // Save the new order to database
  //   await db("orders").insert({
  //     trade_id: trade.id,
  //     alpaca_order_id: ocoOrder.id,
  //     client_order_id: ocoOrder.client_order_id,
  //     symbol: trade.symbol,
  //     side: "sell",
  //     order_type: "limit",
  //     order_class: "oco",
  //     qty: sharesToSell,
  //     limit_price: tpPrice,
  //     stop_price: slPrice,
  //     time_in_force: "gtc",
  //     phase: phase.phase_number,
  //     purpose: "phase_tp",
  //     status: ocoOrder.status,
  //     alpaca_response: JSON.stringify(ocoOrder),
  //   });

  //   logger.success(
  //     `✅ Re-placed Phase ${phase.phase_number} TP order for ${trade.symbol}`
  //   );
  // }

  // /**
  //  * 🆕 Additional helper: Check for orphaned phases
  //  * Finds active phases without corresponding orders and places them
  //  */
  // async checkOrphanedPhases() {
  //   const db = database.getDb();

  //   logger.info("🔍 Checking for orphaned phases (phases without orders)");

  //   // Get all active trades
  //   const activeTrades = await db("trades")
  //     .where("status", "active")
  //     .select("*");

  //   for (const trade of activeTrades) {
  //     // Get active phases for this trade
  //     const activePhases = await db("trade_phases")
  //       .where({
  //         trade_id: trade.id,
  //         status: "active",
  //       })
  //       .select("*");

  //     for (const phase of activePhases) {
  //       // Check if this phase has an active order
  //       const existingOrder = await db("orders")
  //         .where({
  //           trade_id: trade.id,
  //           phase: phase.phase_number,
  //           purpose: "phase_tp",
  //         })
  //         .whereIn("status", ["new", "accepted", "pending_new"])
  //         .first();

  //       if (!existingOrder) {
  //         logger.warn(
  //           `⚠️ Orphaned phase detected: ${trade.symbol} Phase ${phase.phase_number} has no active order`
  //         );

  //         // Re-place the order
  //         await this.replacePhaseTakeProfitOrder(trade, phase);

  //         // Send notification
  //         await NotificationService.send({
  //           type: "warning",
  //           title: "⚠️ Orphaned Phase Detected",
  //           message: `Phase ${phase.phase_number} for ${trade.symbol} had no active order. Order has been placed.`,
  //           tradeId: trade.id,
  //         });
  //       }
  //     }
  //   }

  //   logger.info("✅ Orphaned phase check complete");
  // }
}

module.exports = new TradeMonitor();
