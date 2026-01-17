/**
 * Trade Reconciliation System - Enhanced
 *
 * Handles OCO leg fills that may not be recorded in orders table
 * Now includes detection of standalone OCO legs in Alpaca's order list
 */

const database = require("../config/database");
const TradeExecutionService = require("./TradeExecutionService");
const NotificationService = require("./NotificationService");

class TradeReconciliationService {
  constructor() {
    this.isReconciling = false;
    this.isRunning = false;
    this.reconcileInterval = null;
    this.intervalMs = 2 * 60 * 1000;
  }

  /* ===========================
   * ADMIN LIFECYCLE
   * =========================== */

  async start() {
    if (this.isRunning) {
      console.warn("Trade reconciliation already running");
      return;
    }

    console.log("🔄 Starting Trade Reconciliation Service...");
    this.isRunning = true;

    await this.safeReconcile();

    this.reconcileInterval = setInterval(
      () => this.safeReconcile(),
      this.intervalMs
    );

    console.log("✅ Trade Reconciliation Service started");
  }

  async stop() {
    console.log("🛑 Stopping Trade Reconciliation Service...");
    this.isRunning = false;

    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
      this.reconcileInterval = null;
    }

    console.log("🧹 Trade Reconciliation Service stopped");
  }

  async safeReconcile() {
    if (!this.isRunning) return;

    if (this.isReconciling) {
      console.warn("⏳ Reconciliation already in progress — skipping");
      return;
    }

    try {
      await this.reconcileAllTrades();
    } catch (error) {
      console.error("❌ Reconciliation failed:", error);

      await NotificationService.send({
        type: "error",
        title: "⚠️ Reconciliation Failure",
        message: error.message,
      });
    }
  }

  /* ===========================
   * CORE RECONCILIATION
   * =========================== */

  async reconcileAllTrades() {
    this.isReconciling = true;
    console.log("🔍 Running trade reconciliation...");

    try {
      const db = database.getDb();
      const AlpacaService = require("./AlpacaService");

      const activeTrades = await db("trades")
        .where("status", "active")
        .select("*");

      if (activeTrades.length === 0) {
        console.log("No active trades to reconcile");
        return;
      }

      const positions = await AlpacaService.getPositions();
      const positionMap = new Map(positions.map(p => [p.symbol, p]));

      for (const trade of activeTrades) {
        await this.reconcileTrade(trade, positionMap);
      }

      console.log("✅ Trade reconciliation cycle completed");
    } finally {
      this.isReconciling = false;
    }
  }

  async reconcileTrade(trade, positionMap) {
    console.log(`🔍 Reconciling ${trade.symbol} (Trade ${trade.id})`);

    const dbRemainingShares = parseInt(trade.remaining_shares);
    const actualPosition = positionMap.get(trade.symbol);
    const actualShares = actualPosition ? parseInt(actualPosition.qty) : 0;

    if (dbRemainingShares === actualShares) {
      console.log(`✔ ${trade.symbol} shares match (${actualShares})`);
      return;
    }

    console.warn(
      `⚠️ SHARE DISCREPANCY | ${trade.symbol} | DB: ${dbRemainingShares} | Alpaca: ${actualShares}`
    );

    await this.findMissedEvents(trade, dbRemainingShares, actualShares);
  }

  /* ===========================
   * MISS EVENT DETECTION - ENHANCED
   * =========================== */

  async findMissedEvents(trade, expectedShares, actualShares) {
    const db = database.getDb();
    const AlpacaService = require("./AlpacaService");

    try {
      console.log(`🔎 Scanning missed events for ${trade.symbol}`);

      const dbOrders = await db("orders")
        .where("trade_id", trade.id)
        .select("*");

      // Get ALL orders from Alpaca (including filled OCO legs)
      const alpacaOrders = await AlpacaService.getOrders("all", 500);
      
      const tradeOrderIds = dbOrders.map(o => o.alpaca_order_id);

      // Filter orders related to this trade
      const relevantOrders = alpacaOrders.filter(o =>
        tradeOrderIds.includes(o.id)
      );

      const missedFills = [];

      // Check parent orders
      for (const alpacaOrder of relevantOrders) {
        const dbOrder = dbOrders.find(
          o => o.alpaca_order_id === alpacaOrder.id
        );

        if (!dbOrder) continue;

        // Check parent order fills
        if (alpacaOrder.status === "filled" && dbOrder.status !== "filled") {
          console.log(`📍 Found unrecorded parent fill: ${alpacaOrder.id}`);
          missedFills.push({ type: "parent", order: alpacaOrder, dbOrder });
        }

        // Check OCO leg fills in parent's legs array
        if (alpacaOrder.order_class === "oco" && alpacaOrder.legs) {
          for (const leg of alpacaOrder.legs) {
            if (leg.status === "filled") {
              const legRecorded = await this.isLegFillRecorded(trade.id, leg.id);
              
              if (!legRecorded) {
                console.log(`📍 Found unrecorded OCO leg in parent: ${leg.id}`);
                missedFills.push({
                  type: "oco_leg",
                  order: alpacaOrder,
                  leg,
                  dbOrder,
                });
              }
            }
          }
        }
      }

      // CRITICAL: Check for standalone OCO legs in Alpaca's order list
      // These appear as separate orders, not nested in parent.legs
      console.log(`🔍 Searching for standalone OCO legs for ${trade.symbol}`);
      await this.findStandaloneOCOLegs(trade, alpacaOrders, dbOrders, missedFills);

      if (missedFills.length === 0) {
        console.error("🚨 No matching fills found — manual review required");
        await this.flagForManualReview(trade, expectedShares, actualShares);
        return;
      }

      // Process all missed fills
      for (const missed of missedFills) {
        await this.processMissedFill(trade, missed);
      }
    } catch (error) {
      console.error(`Missed event scan failed for ${trade.symbol}`, error);
    }
  }

  /**
   * NEW METHOD: Find standalone OCO legs
   * 
   * OCO legs sometimes appear as standalone orders in Alpaca's order list
   * instead of being nested in the parent order's legs array.
   * 
   * Example: IONQ Phase 2 stop-loss (c6507fce-9c14-4305-b9a7-46ea1d862ec7)
   * appears as a separate order with order_class="oco" but no parent reference
   */
  async findStandaloneOCOLegs(trade, alpacaOrders, dbOrders, missedFills) {
    const db = database.getDb();
    
    // Get all active/completed phases for this trade
    const phases = await db("trade_phases")
      .where("trade_id", trade.id)
      .whereIn("status", ["active", "completed"])
      .orderBy("phase_number", "asc");
    
    for (const phase of phases) {
      console.log(`📋 Checking phase ${phase.phase_number} for standalone OCO legs`);
      
      // Find all OCO orders for this phase
      const phaseOCOOrders = dbOrders.filter(
        o => o.phase === phase.phase_number && 
             o.order_class === "oco" &&
             o.purpose === "phase_tp"
      );
      
      for (const ocoOrder of phaseOCOOrders) {
        // Look for standalone OCO legs in Alpaca's order list
        // These will have order_class="oco" and match the symbol/qty
        const potentialLegs = alpacaOrders.filter(o => 
          o.symbol === trade.symbol &&
          o.order_class === "oco" &&
          o.side === "sell" &&
          o.status === "filled" &&
          // NOT the parent order itself
          o.id !== ocoOrder.alpaca_order_id
        );
        
        for (const potentialLeg of potentialLegs) {
          // Check if this leg matches the phase's expected qty/prices
          const isStopLeg = potentialLeg.type === "stop" && 
                           Math.abs(parseFloat(potentialLeg.stop_price) - parseFloat(ocoOrder.stop_price)) < 0.01;
          
          const isLimitLeg = potentialLeg.type === "limit" && 
                            Math.abs(parseFloat(potentialLeg.limit_price) - parseFloat(ocoOrder.limit_price)) < 0.01;
          
          if (isStopLeg || isLimitLeg) {
            // Check if already recorded
            const recorded = await this.isLegFillRecorded(trade.id, potentialLeg.id);
            
            if (!recorded) {
              console.log(`✨ Found standalone OCO ${potentialLeg.type} leg: ${potentialLeg.id}`);
              console.log(`   Phase ${phase.phase_number}, ${potentialLeg.filled_qty} shares @ ${potentialLeg.filled_avg_price}`);
              
              missedFills.push({
                type: "oco_leg",
                order: {
                  ...ocoOrder,
                  id: ocoOrder.alpaca_order_id,
                },
                leg: potentialLeg,
                dbOrder: ocoOrder,
              });
            }
          }
        }
      }
    }
  }

  async isLegFillRecorded(tradeId, legId) {
    const db = database.getDb();

    const event = await db("order_events")
      .where("trade_id", tradeId)
      .whereIn("event_type", ["fill", "partial_fill"])
      .whereRaw("event_data::text LIKE ?", [`%${legId}%`])
      .first();

    return !!event;
  }

  /* ===========================
   * MISS EVENT PROCESSING
   * =========================== */

  async processMissedFill(trade, missedFill) {
    const db = database.getDb();
    const { type, order, leg, dbOrder } = missedFill;

    console.log(`📝 Processing missed fill for ${trade.symbol}`);

    try {
      if (type === "parent") {
        await db("orders")
          .where("id", dbOrder.id)
          .update({
            status: "filled",
            filled_qty: order.filled_qty,
            filled_avg_price: order.filled_avg_price,
            filled_at: order.filled_at,
            updated_at: db.fn.now(),
          });

        // Create order event
        await db("order_events").insert({
          order_id: dbOrder.id,
          trade_id: trade.id,
          event_type: "fill",
          event_data: order,
          description: `Order fill: ${trade.symbol} ${order.side} ${order.filled_qty}/${order.qty} @ ${order.filled_avg_price}`,
          event_time: order.filled_at,
        });

        await this.handleMissedFillEvent(dbOrder, order);
      }

      if (type === "oco_leg") {
        // Determine purpose based on leg type
        const purpose = leg.type === "stop" ? "phase_sl" : "phase_tp";
        
        console.log(`🎯 OCO leg type: ${leg.type}, purpose: ${purpose}, phase: ${dbOrder.phase}`);

        // Create order event for the leg
        await db("order_events").insert({
          order_id: dbOrder.id,
          trade_id: trade.id,
          event_type: "fill",
          event_data: {
            ...leg,
            parent_order_id: order.id,
            leg_id: leg.id,
          },
          description: `OCO ${leg.type} leg fill: ${trade.symbol} ${leg.side} ${leg.filled_qty}/${leg.qty} @ ${leg.filled_avg_price}`,
          event_time: leg.filled_at,
        });

        const syntheticOrder = {
          ...dbOrder,
          filled_qty: leg.filled_qty,
          filled_avg_price: leg.filled_avg_price,
          filled_at: leg.filled_at,
          purpose: purpose,
        };

        await this.handleMissedFillEvent(syntheticOrder, leg);
      }

      console.log(`✅ Missed fill reconciled for ${trade.symbol}`);
    } catch (error) {
      console.error("❌ Failed processing missed fill", error);
      throw error;
    }
  }

  async handleMissedFillEvent(dbOrder, alpacaOrder) {
    const fillPrice = parseFloat(alpacaOrder.filled_avg_price);
    const filledQty = parseInt(alpacaOrder.filled_qty);

    console.log(
      `⚙️ Handling fill | Trade ${dbOrder.trade_id} | Phase ${dbOrder.phase} | Purpose ${dbOrder.purpose}`
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

      default:
        console.warn(`⚠️ Unknown order purpose: ${dbOrder.purpose}`);
    }
  }

  async flagForManualReview(trade, expectedShares, actualShares) {
    const db = database.getDb();

    console.error(`🚨 Manual review required for ${trade.symbol}`);

    await db("reconciliation_issues").insert({
      trade_id: trade.id,
      issue_type: "share_discrepancy",
      expected_shares: expectedShares,
      actual_shares: actualShares,
      discrepancy: expectedShares - actualShares,
      status: "pending_review",
      created_at: db.fn.now(),
    });
  }
}

module.exports = new TradeReconciliationService();