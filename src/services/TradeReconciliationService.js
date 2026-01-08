/**
 * Trade Reconciliation System
 * 
 * Detects and fixes missed order fill events by comparing:
 * 1. What we think we own (database)
 * 2. What we actually own (Alpaca positions)
 * 3. What Alpaca says happened (order history)
 */

const Alpaca = require("@alpacahq/alpaca-trade-api");
const database = require("../config/database");
const TradeExecutionService = require("./TradeExecutionService");
const NotificationService = require("./NotificationService");
const logger = require("../utils/logger");

class TradeReconciliationService {
  constructor() {
    this.isReconciling = false;
  }

  /**
   * Main reconciliation function - call this periodically
   */
  async reconcileAllTrades() {
    if (this.isReconciling) {
      logger.warn("Reconciliation already in progress, skipping...");
      return;
    }

    this.isReconciling = true;
    logger.info("🔄 Starting trade reconciliation...");

    try {
      const db = database.getDb();
      const AlpacaService = require("./AlpacaService");

      // Get all active trades
      const activeTrades = await db("trades")
        .where("status", "active")
        .select("*");

      if (activeTrades.length === 0) {
        logger.info("No active trades to reconcile");
        return;
      }

      // Get actual positions from Alpaca
      const positions = await AlpacaService.getPositions();
      const positionMap = new Map(positions.map(p => [p.symbol, p]));

      logger.info(`Found ${activeTrades.length} active trades to reconcile`);

      for (const trade of activeTrades) {
        await this.reconcileTrade(trade, positionMap);
      }

      logger.success("✅ Trade reconciliation completed");
    } catch (error) {
      logger.error("❌ Trade reconciliation failed:", error);
    } finally {
      this.isReconciling = false;
    }
  }

  /**
   * Reconcile a single trade
   */
  async reconcileTrade(trade, positionMap) {
    const db = database.getDb();
    const AlpacaService = require("./AlpacaService");

    logger.info(`🔍 Reconciling ${trade.symbol} (Trade ID: ${trade.id})`);

    // What do we think we own?
    const dbRemainingShares = parseInt(trade.remaining_shares);

    // What do we actually own?
    const actualPosition = positionMap.get(trade.symbol);
    const actualShares = actualPosition ? parseInt(actualPosition.qty) : 0;

    // Check for discrepancy
    if (dbRemainingShares === actualShares) {
      logger.info(`✅ ${trade.symbol}: DB matches reality (${actualShares} shares)`);
      return;
    }

    logger.warn(
      `⚠️ DISCREPANCY FOUND: ${trade.symbol}
      Database says: ${dbRemainingShares} shares
      Actually own: ${actualShares} shares
      Missing: ${dbRemainingShares - actualShares} shares`
    );

    // Find what happened
    await this.findMissedEvents(trade, dbRemainingShares, actualShares);
  }

  /**
   * Find missed fill events by analyzing order history
   */
  async findMissedEvents(trade, expectedShares, actualShares) {
    const db = database.getDb();
    const AlpacaService = require("./AlpacaService");

    try {
      // Get all orders for this trade from database
      const dbOrders = await db("orders")
        .where("trade_id", trade.id)
        .select("*");

      // Get all orders from Alpaca (last 500)
      const alpacaOrders = await AlpacaService.getOrders("all", 500);

      // Filter to our trade's orders
      const tradeOrderIds = dbOrders.map(o => o.alpaca_order_id);
      const relevantAlpacaOrders = alpacaOrders.filter(o => 
        tradeOrderIds.includes(o.id)
      );

      logger.info(`Found ${relevantAlpacaOrders.length} Alpaca orders for ${trade.symbol}`);

      // Look for fills we didn't record
      const missedFills = [];

      for (const alpacaOrder of relevantAlpacaOrders) {
        const dbOrder = dbOrders.find(o => o.alpaca_order_id === alpacaOrder.id);

        // Check parent order
        if (alpacaOrder.status === "filled" && dbOrder.status !== "filled") {
          missedFills.push({
            type: "parent",
            order: alpacaOrder,
            dbOrder: dbOrder
          });
        }

        // Check OCO legs
        if (alpacaOrder.order_class === "oco" && alpacaOrder.legs) {
          for (const leg of alpacaOrder.legs) {
            if (leg.status === "filled") {
              // Check if we recorded this leg fill
              const legRecorded = await this.isLegFillRecorded(
                trade.id,
                leg.id,
                dbOrder.phase
              );

              if (!legRecorded) {
                missedFills.push({
                  type: "oco_leg",
                  order: alpacaOrder,
                  leg: leg,
                  dbOrder: dbOrder
                });
              }
            }
          }
        }
      }

      if (missedFills.length === 0) {
        logger.warn(`No missed fills found in order history for ${trade.symbol}`);
        
        // Manual correction needed
        await this.flagForManualReview(trade, expectedShares, actualShares);
        return;
      }

      // Process missed fills
      logger.info(`Found ${missedFills.length} missed fill(s) for ${trade.symbol}`);
      
      for (const missed of missedFills) {
        await this.processMissedFill(trade, missed);
      }

    } catch (error) {
      logger.error(`Error finding missed events for ${trade.symbol}:`, error);
    }
  }

  /**
   * Check if an OCO leg fill was recorded
   */
  async isLegFillRecorded(tradeId, legId, phase) {
    const db = database.getDb();

    // Check order_events for this leg fill
    const event = await db("order_events")
      .where("trade_id", tradeId)
      .where(function() {
        this.where("event_type", "fill")
          .orWhere("event_type", "partial_fill");
      })
      .whereRaw("event_data::text LIKE ?", [`%${legId}%`])
      .first();

    return !!event;
  }

  /**
   * Process a missed fill event
   */
  async processMissedFill(trade, missedFill) {
    const db = database.getDb();

    logger.info(`📝 Processing missed fill for ${trade.symbol}`);

    const { type, order, leg, dbOrder } = missedFill;

    try {
      if (type === "parent") {
        // Parent order filled but not recorded
        logger.info(`Missed parent fill: Order ${order.id}`);

        // Update order in database
        await db("orders")
          .where("id", dbOrder.id)
          .update({
            status: "filled",
            filled_qty: order.filled_qty,
            filled_avg_price: order.filled_avg_price,
            filled_at: order.filled_at,
            updated_at: db.fn.now()
          });

        // Trigger the fill handler
        await this.handleMissedFillEvent(dbOrder, order);

      } else if (type === "oco_leg") {
        // OCO leg filled but not recorded
        logger.info(
          `Missed OCO leg fill: ${leg.type} @ ${leg.filled_avg_price} (${leg.filled_qty} shares)`
        );

        // Determine which leg filled
        const isStopLoss = leg.type === "stop";
        const isTakeProfit = leg.type === "limit";

        // Create a synthetic order object for the leg
        const legOrder = {
          ...dbOrder,
          filled_qty: leg.filled_qty,
          filled_avg_price: leg.filled_avg_price,
          filled_at: leg.filled_at,
          purpose: isStopLoss 
            ? (dbOrder.phase === 1 ? "remaining_sl" : "phase_sl")
            : "phase_tp"
        };

        // Trigger the appropriate handler
        await this.handleMissedFillEvent(legOrder, leg);

        // Log the missed event
        await db("order_events").insert({
          order_id: dbOrder.id,
          trade_id: trade.id,
          event_type: "fill",
          event_data: JSON.stringify({
            ...leg,
            reconciliation: true,
            original_fill_time: leg.filled_at,
            discovered_at: new Date().toISOString()
          }),
          description: `[RECONCILED] Missed ${leg.type} fill @ ${leg.filled_avg_price}`
        });
      }

      // Send notification
      await NotificationService.send({
        type: "warning",
        title: "🔄 Missed Fill Reconciled",
        message: `Found and processed missed fill for ${trade.symbol} Phase ${dbOrder.phase}: ${missedFill.type}`,
        tradeId: trade.id
      });

    } catch (error) {
      logger.error(`Error processing missed fill for ${trade.symbol}:`, error);
      
      await NotificationService.send({
        type: "error",
        title: "❌ Reconciliation Error",
        message: `Failed to process missed fill for ${trade.symbol}: ${error.message}`,
        tradeId: trade.id
      });
    }
  }

  /**
   * Handle missed fill event - call appropriate execution handler
   */
  async handleMissedFillEvent(dbOrder, alpacaOrder) {
    const fillPrice = parseFloat(alpacaOrder.filled_avg_price);
    const filledQty = parseInt(alpacaOrder.filled_qty);

    logger.info(
      `Handling missed ${dbOrder.purpose} fill: ${filledQty} @ ${fillPrice}`
    );

    switch (dbOrder.purpose) {
      case "entry":
        await TradeExecutionService.handleEntryFill(
          dbOrder.trade_id,
          fillPrice,
          filledQty
        );
        break;

      case "phase_tp":
        await TradeExecutionService.handlePhaseTakeProfitHit(
          dbOrder.trade_id,
          dbOrder.phase,
          fillPrice
        );
        break;

      case "phase_sl":
      case "remaining_sl":
        await TradeExecutionService.handlePhaseStopLossHit(
          dbOrder.trade_id,
          dbOrder.phase,
          fillPrice,
          filledQty
        );
        break;
    }
  }

  /**
   * Flag trade for manual review when we can't auto-fix
   */
  async flagForManualReview(trade, expectedShares, actualShares) {
    const db = database.getDb();

    logger.warn(`⚠️ Flagging ${trade.symbol} for manual review`);

    // Create a reconciliation record
    await db("reconciliation_issues").insert({
      trade_id: trade.id,
      issue_type: "share_discrepancy",
      expected_shares: expectedShares,
      actual_shares: actualShares,
      discrepancy: expectedShares - actualShares,
      status: "pending_review",
      details: JSON.stringify({
        symbol: trade.symbol,
        entry_price: trade.entry_price,
        current_phase: trade.current_phase
      }),
      created_at: db.fn.now()
    });

    await NotificationService.send({
      type: "error",
      title: "🚨 Manual Review Required",
      message: `${trade.symbol}: Share count mismatch. DB: ${expectedShares}, Actual: ${actualShares}. Could not auto-fix.`,
      tradeId: trade.id
    });
  }

  /**
   * Force reconcile a specific trade by ID
   */
  async reconcileTradeById(tradeId) {
    const db = database.getDb();
    const AlpacaService = require("./AlpacaService");

    const trade = await db("trades").where("id", tradeId).first();
    
    if (!trade) {
      throw new Error(`Trade ${tradeId} not found`);
    }

    const positions = await AlpacaService.getPositions();
    const positionMap = new Map(positions.map(p => [p.symbol, p]));

    await this.reconcileTrade(trade, positionMap);
  }

  /**
   * Generate reconciliation report
   */
  async generateReport() {
    const db = database.getDb();
    const AlpacaService = require("./AlpacaService");

    const activeTrades = await db("trades")
      .where("status", "active")
      .select("*");

    const positions = await AlpacaService.getPositions();
    const positionMap = new Map(positions.map(p => [p.symbol, p]));

    const report = {
      timestamp: new Date().toISOString(),
      trades: [],
      discrepancies: 0
    };

    for (const trade of activeTrades) {
      const dbShares = parseInt(trade.remaining_shares);
      const actualPosition = positionMap.get(trade.symbol);
      const actualShares = actualPosition ? parseInt(actualPosition.qty) : 0;
      const matches = dbShares === actualShares;

      if (!matches) report.discrepancies++;

      report.trades.push({
        id: trade.id,
        symbol: trade.symbol,
        phase: trade.current_phase,
        dbShares,
        actualShares,
        matches,
        discrepancy: dbShares - actualShares
      });
    }

    return report;
  }
}

module.exports = new TradeReconciliationService();