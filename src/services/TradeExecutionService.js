/**
 * RZE Trading Platform - Trade Execution Service
 *
 * This is the core service that handles the phased exit strategy.
 * It manages trade entry, phase transitions, and order placement.
 */

const { v4: uuidv4 } = require("uuid");
const database = require("../config/database");
const AlpacaService = require("./AlpacaService");
const NotificationService = require("./NotificationService");
const logger = require("../utils/logger");

class TradeExecutionService {
  /**
   * Execute a new trade with phased exit strategy
   *
   * @param {Object} params - Trade parameters
   * @param {string} params.symbol - Stock symbol (e.g., 'AAPL')
   * @param {number} params.entryPrice - Entry price per share
   * @param {number} params.positionSize - Total position size in dollars (optional, uses default)
   * @param {number} params.templateId - Template ID to use (optional, uses active template)
   */
  async executeTrade({
    symbol,
    entryPrice,
    positionSize = null,
    templateId = null,
  }) {
    const db = database.getDb();
    const tradeUuid = uuidv4();

    logger.trade("Starting new trade execution", {
      symbol,
      entryPrice,
      tradeUuid,
    });

    try {
      // 1. Validate the symbol
      const asset = await AlpacaService.getAsset(symbol.toUpperCase());
      if (!asset.tradable) {
        throw new Error(`${symbol} is not tradable`);
      }

      // 2. Get account info
      const account = await AlpacaService.getAccount();

      // 3. Get settings
      const settings = await this._getSettings();

      // 4. Calculate position size
      const startingCapital =
        settings.starting_capital || account.portfolio_value;
      const tradeSizePercent = settings.trade_size_percent || 20;
      const calculatedPositionSize =
        positionSize || startingCapital * (tradeSizePercent / 100);

      // 5. Calculate number of shares
      const totalShares = Math.floor(calculatedPositionSize / entryPrice);
      if (totalShares < 1) {
        throw new Error("Position size too small for even 1 share");
      }

      // 6. Check buying power
      if (calculatedPositionSize > account.buying_power) {
        throw new Error(
          `Insufficient buying power. Need $${calculatedPositionSize.toFixed(
            2
          )}, have $${account.buying_power.toFixed(2)}`
        );
      }

      // 7. Get template
      const template = await this._getTemplate(templateId);
      if (!template) {
        throw new Error("No trading template found");
      }

      // 8. Create trade record
      const [{ id: tradeId }] = await db("trades")
        .insert({
          trade_uuid: tradeUuid,
          symbol: symbol.toUpperCase(),
          company_name: asset.name,
          entry_price: entryPrice,
          total_shares: totalShares,
          position_size: calculatedPositionSize,
          remaining_shares: totalShares,
          current_phase: 0, // Will be set to 1 after entry fills
          status: "pending",
          template_id: template.id,
          template_snapshot: JSON.stringify(template),
        })
        .returning("id");

      logger.trade("Trade record created", { tradeId, tradeUuid });

      // 9. Create phase records
      const phases =
        typeof template.phases === "string"
          ? JSON.parse(template.phases)
          : template.phases;

      let sharesAllocated = 0;
      for (const phase of phases) {
        const sharesToSell =
          phase.phase === 4
            ? totalShares - sharesAllocated // Last phase gets remaining shares
            : Math.floor(totalShares * (phase.sell_pct / 100));

        sharesAllocated += sharesToSell;

        const tpPrice = entryPrice * (1 + phase.take_profit_pct / 100);
        const slPrice = entryPrice * (1 + phase.stop_loss_pct / 100);

        await db("trade_phases").insert({
          trade_id: tradeId,
          phase_number: phase.phase,
          status: "pending",
          take_profit_pct: phase.take_profit_pct,
          stop_loss_pct: phase.stop_loss_pct,
          sell_pct: phase.sell_pct,
          take_profit_price: tpPrice,
          stop_loss_price: slPrice,
          shares_to_sell: sharesToSell,
        });
      }

      logger.trade("Phase records created", { tradeId, phases: phases.length });

      // 10. Place entry order (limit buy at entry price)
      const clientOrderId = `RZE-ENTRY-${tradeUuid.substring(0, 8)}`;
      let entryOrder = null;

      try {
        entryOrder = await AlpacaService.placeLimitBuyOrder(
          symbol.toUpperCase(),
          totalShares,
          Number(entryPrice),
          clientOrderId
        );

        logger.trade("Entry order placed successfully", {
          orderId: entryOrder.id,
          status: entryOrder.status,
          submittedAt: entryOrder.submitted_at,
        });
      } catch (err) {
        console.log(err);
        logger.error("Error placing Alpaca order", {
          message: err?.response?.data?.message || err.message,
          raw: err?.response?.data || err,
        });

        throw new Error(
          err?.response?.data?.message || "Failed to place entry order"
        );
      }

      // 11. Record entry order
      await db("orders").insert({
        trade_id: tradeId,
        alpaca_order_id: entryOrder.id,
        client_order_id: clientOrderId,
        symbol: symbol.toUpperCase(),
        side: "buy",
        order_type: "limit",
        order_class: "simple",
        qty: totalShares,
        limit_price: entryPrice,
        time_in_force: "gtc",
        extended_hours: false,
        phase: 0,
        purpose: "entry",
        status: entryOrder.status,
        alpaca_response: JSON.stringify(entryOrder),
      });

      // 12. Log event
      await this._logOrderEvent(null, tradeId, "entry_order_placed", {
        orderId: entryOrder.id,
        symbol,
        shares: totalShares,
        price: entryPrice,
      });

      // 13. Send notification
      await NotificationService.send({
        type: "trade",
        title: `📈 New Trade: ${symbol}`,
        message: `Entry order placed for ${totalShares} shares at $${entryPrice.toFixed(
          2
        )}\nPosition Size: $${calculatedPositionSize.toFixed(2)}\nTemplate: ${
          template.name
        }`,
        tradeId: tradeId,
      });

      logger.trade("Trade execution complete", {
        tradeId,
        tradeUuid,
        symbol,
        shares: totalShares,
        entryPrice,
      });

      return {
        success: true,
        tradeId,
        tradeUuid,
        symbol: symbol.toUpperCase(),
        shares: totalShares,
        entryPrice,
        positionSize: calculatedPositionSize,
        template: template.name,
        entryOrderId: entryOrder.id,
      };
    } catch (error) {
      logger.error("Trade execution failed:", error);

      // Update trade status if we created one
      if (tradeUuid) {
        await db("trades")
          .where("trade_uuid", tradeUuid)
          .update({ status: "error" });
      }

      throw error;
    }
  }

  /**
   * Handle entry order fill - initiates Phase 1
   */
  async handleEntryFill(tradeId, fillPrice, filledQty) {
    const db = database.getDb();

    logger.phase("Entry filled, initiating Phase 1", {
      tradeId,
      fillPrice,
      filledQty,
    });

    try {
      // Get trade details
      const trade = await db("trades").where("id", tradeId).first();
      if (!trade) {
        throw new Error(`Trade ${tradeId} not found`);
      }

      // Update trade with actual fill price
      await db("trades").where("id", tradeId).update({
        entry_price: fillPrice,
        status: "active",
        current_phase: 1,
        updated_at: db.fn.now(),
      });

      // Recalculate phase prices based on actual fill price
      const phases = await db("trade_phases")
        .where("trade_id", tradeId)
        .orderBy("phase_number");

      for (const phase of phases) {
        const tpPrice = fillPrice * (1 + phase.take_profit_pct / 100);
        const slPrice = fillPrice * (1 + phase.stop_loss_pct / 100);

        await db("trade_phases").where("id", phase.id).update({
          take_profit_price: tpPrice,
          stop_loss_price: slPrice,
        });
      }

      // Place Phase 1 orders
      await this.placePhaseOrders(tradeId, 1);

      // Log event
      await this._logOrderEvent(null, tradeId, "entry_filled", {
        fillPrice,
        filledQty,
      });

      // Notify
      await NotificationService.send({
        type: "trade",
        title: `✅ Entry Filled: ${trade.symbol}`,
        message: `${filledQty} shares filled at $${fillPrice.toFixed(
          2
        )}\nPhase 1 orders placed`,
        tradeId,
      });
    } catch (error) {
      logger.error("Error handling entry fill:", error);
      throw error;
    }
  }

  /**
   * Place orders for a specific phase
   */
  async placePhaseOrders(tradeId, phaseNumber) {
    const db = database.getDb();

    logger.phase("Placing phase orders", { tradeId, phaseNumber });

    try {
      const trade = await db("trades").where("id", tradeId).first();
      const phase = await db("trade_phases")
        .where({ trade_id: tradeId, phase_number: phaseNumber })
        .first();

      if (!trade || !phase) {
        throw new Error(
          `Trade or phase not found: ${tradeId}, phase ${phaseNumber}`
        );
      }

      // Update phase status
      await db("trade_phases").where("id", phase.id).update({
        status: "active",
        started_at: db.fn.now(),
      });

      const tradeUuidShort = trade.trade_uuid.substring(0, 8);

      // Place OCO order for this phase's shares (TP + SL)
      const ocoClientOrderId = `RZE-P${phaseNumber}-OCO-${tradeUuidShort}`;
      const ocoOrder = await AlpacaService.placeOCOSellOrder(
        trade.symbol,
        phase.shares_to_sell,
        phase.take_profit_price,
        phase.stop_loss_price,
        ocoClientOrderId
      );

      // Record OCO order
      await db("orders").insert({
        trade_id: tradeId,
        alpaca_order_id: ocoOrder.id,
        client_order_id: ocoClientOrderId,
        symbol: trade.symbol,
        side: "sell",
        order_type: "limit",
        order_class: "oco",
        qty: phase.shares_to_sell,
        limit_price: phase.take_profit_price,
        stop_price: phase.stop_loss_price,
        time_in_force: "gtc",
        extended_hours: false,
        phase: phaseNumber,
        purpose: "phase_tp",
        status: ocoOrder.status,
        alpaca_response: JSON.stringify(ocoOrder),
      });

      // If Phase 1, also place stop loss for remaining shares
      if (phaseNumber === 1) {
        const remainingShares = trade.total_shares - phase.shares_to_sell;
        if (remainingShares > 0) {
          const slClientOrderId = `RZE-P${phaseNumber}-SL-${tradeUuidShort}`;
          const slOrder = await AlpacaService.placeStopLossSellOrder(
            trade.symbol,
            remainingShares,
            phase.stop_loss_price,
            slClientOrderId
          );

          await db("orders").insert({
            trade_id: tradeId,
            alpaca_order_id: slOrder.id,
            client_order_id: slClientOrderId,
            symbol: trade.symbol,
            side: "sell",
            order_type: "stop",
            order_class: "simple",
            qty: remainingShares,
            stop_price: phase.stop_loss_price,
            time_in_force: "gtc",
            extended_hours: false,
            phase: phaseNumber,
            purpose: "remaining_sl",
            status: slOrder.status,
            alpaca_response: JSON.stringify(slOrder),
          });
        }
      }

      // Log event
      await this._logOrderEvent(null, tradeId, "phase_orders_placed", {
        phase: phaseNumber,
        shares: phase.shares_to_sell,
        takeProfitPrice: phase.take_profit_price,
        stopLossPrice: phase.stop_loss_price,
      });

      logger.phase("Phase orders placed", {
        tradeId,
        phaseNumber,
        shares: phase.shares_to_sell,
        tp: phase.take_profit_price,
        sl: phase.stop_loss_price,
      });
    } catch (error) {
      logger.error("Error placing phase orders:", error);
      throw error;
    }
  }

  /**
   * Handle phase take profit hit - advance to next phase
   */
  async handlePhaseTakeProfitHit(tradeId, phaseNumber, fillPrice) {
    const db = database.getDb();

    logger.phase("Take profit hit", { tradeId, phaseNumber, fillPrice });

    try {
      const trade = await db("trades").where("id", tradeId).first();
      const currentPhase = await db("trade_phases")
        .where({ trade_id: tradeId, phase_number: phaseNumber })
        .first();

      // Calculate phase P&L
      const phasePnl =
        (fillPrice - trade.entry_price) * currentPhase.shares_to_sell;

      // Update current phase as completed
      await db("trade_phases").where("id", currentPhase.id).update({
        status: "completed",
        exit_price: fillPrice,
        exit_type: "take_profit",
        phase_pnl: phasePnl,
        completed_at: db.fn.now(),
      });

      // Update remaining shares
      const newRemainingShares =
        trade.remaining_shares - currentPhase.shares_to_sell;
      await db("trades").where("id", tradeId).update({
        remaining_shares: newRemainingShares,
        updated_at: db.fn.now(),
      });

      // Cancel old stop loss for remaining shares
      const oldSlOrders = await db("orders").where({
        trade_id: tradeId,
        phase: phaseNumber,
        purpose: "remaining_sl",
      });

      for (const order of oldSlOrders) {
        if (order.status !== "cancelled" && order.status !== "filled") {
          await AlpacaService.cancelOrder(order.alpaca_order_id);
          await db("orders")
            .where("id", order.id)
            .update({ status: "cancelled" });
        }
      }

      // Check if this was the last phase
      if (phaseNumber >= 4 || newRemainingShares <= 0) {
        await this.completeTrade(tradeId, "phase_4_complete");
      } else {
        // Advance to next phase
        const nextPhase = phaseNumber + 1;
        await db("trades")
          .where("id", tradeId)
          .update({ current_phase: nextPhase });

        await this.placePhaseOrders(tradeId, nextPhase);

        // Notify
        await NotificationService.send({
          type: "phase",
          title: `🎯 Phase ${phaseNumber} Complete: ${trade.symbol}`,
          message: `Take profit hit at $${fillPrice.toFixed(
            2
          )}\nP&L: $${phasePnl.toFixed(2)}\nAdvancing to Phase ${nextPhase}`,
          tradeId,
        });
      }

      // Log event
      await this._logOrderEvent(null, tradeId, "phase_tp_hit", {
        phase: phaseNumber,
        fillPrice,
        phasePnl,
        remainingShares: newRemainingShares,
      });
    } catch (error) {
      logger.error("Error handling phase take profit:", error);
      throw error;
    }
  }

  /**
   * Handle phase stop loss hit - close remaining position
   */
  async handlePhaseStopLossHit(tradeId, phaseNumber, fillPrice, filledQty) {
    const db = database.getDb();

    logger.phase("Stop loss hit", {
      tradeId,
      phaseNumber,
      fillPrice,
      filledQty,
    });

    try {
      const trade = await db("trades").where("id", tradeId).first();

      // Cancel all remaining orders for this trade
      const openOrders = await db("orders")
        .where({ trade_id: tradeId })
        .whereNotIn("status", ["filled", "cancelled"]);

      for (const order of openOrders) {
        try {
          await AlpacaService.cancelOrder(order.alpaca_order_id);
        } catch (e) {
          // Order might already be cancelled
        }
        await db("orders")
          .where("id", order.id)
          .update({ status: "cancelled" });
      }

      // Update phase
      const phasePnl = (fillPrice - trade.entry_price) * filledQty;
      await db("trade_phases")
        .where({ trade_id: tradeId, phase_number: phaseNumber })
        .update({
          status: "completed",
          exit_price: fillPrice,
          exit_type: "stop_loss",
          phase_pnl: phasePnl,
          completed_at: db.fn.now(),
        });

      // Complete the trade
      await this.completeTrade(tradeId, "stopped_out");

      // Log event
      await this._logOrderEvent(null, tradeId, "phase_sl_hit", {
        phase: phaseNumber,
        fillPrice,
        filledQty,
      });
    } catch (error) {
      logger.error("Error handling phase stop loss:", error);
      throw error;
    }
  }

  /**
   * Complete a trade and calculate final P&L
   */
  async completeTrade(tradeId, exitReason) {
    const db = database.getDb();

    logger.trade("Completing trade", { tradeId, exitReason });

    try {
      const trade = await db("trades").where("id", tradeId).first();
      const phases = await db("trade_phases")
        .where("trade_id", tradeId)
        .whereNotNull("phase_pnl");

      // Calculate total realized P&L
      const totalPnl = phases.reduce(
        (sum, p) => sum + parseFloat(p.phase_pnl || 0),
        0
      );
      const pnlPct = (totalPnl / trade.position_size) * 100;

      // Find the exit phase
      const lastCompletedPhase = phases
        .filter((p) => p.status === "completed")
        .sort((a, b) => b.phase_number - a.phase_number)[0];

      // Update trade as completed
      await db("trades")
        .where("id", tradeId)
        .update({
          status: "completed",
          realized_pnl: totalPnl,
          realized_pnl_pct: pnlPct,
          exit_reason: exitReason,
          exit_phase: lastCompletedPhase?.phase_number || 1,
          exit_time: db.fn.now(),
          updated_at: db.fn.now(),
        });

      // Log event
      await this._logOrderEvent(null, tradeId, "trade_completed", {
        exitReason,
        totalPnl,
        pnlPct,
        exitPhase: lastCompletedPhase?.phase_number,
      });

      // Send notification
      const emoji = totalPnl >= 0 ? "💰" : "📉";
      await NotificationService.send({
        type: "trade",
        title: `${emoji} Trade Completed: ${trade.symbol}`,
        message: `Exit Reason: ${exitReason}\nExit Phase: ${
          lastCompletedPhase?.phase_number || 1
        }\nP&L: $${totalPnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`,
        tradeId,
      });

      logger.trade("Trade completed", {
        tradeId,
        symbol: trade.symbol,
        pnl: totalPnl,
        pnlPct,
        exitReason,
      });
    } catch (error) {
      logger.error("Error completing trade:", error);
      throw error;
    }
  }

  /**
   * Cancel an active trade
   */
  async cancelTrade(tradeId) {
    const db = database.getDb();

    logger.trade("Cancelling trade", { tradeId });

    try {
      const trade = await db("trades").where("id", tradeId).first();
      if (!trade) {
        throw new Error(`Trade ${tradeId} not found`);
      }

      if (trade.status === "completed" || trade.status === "cancelled") {
        throw new Error(`Trade ${tradeId} is already ${trade.status}`);
      }

      // Cancel all orders
      const orders = await db("orders")
        .where({ trade_id: tradeId })
        .whereNotIn("status", ["filled", "cancelled"]);

      for (const order of orders) {
        try {
          await AlpacaService.cancelOrder(order.alpaca_order_id);
        } catch (e) {
          logger.warn(
            `Failed to cancel order ${order.alpaca_order_id}:`,
            e.message
          );
        }
        await db("orders")
          .where("id", order.id)
          .update({ status: "cancelled" });
      }

      // Update trade
      await db("trades").where("id", tradeId).update({
        status: "cancelled",
        exit_reason: "manual",
        exit_time: db.fn.now(),
        updated_at: db.fn.now(),
      });

      // Notify
      await NotificationService.send({
        type: "trade",
        title: `❌ Trade Cancelled: ${trade.symbol}`,
        message: `Trade manually cancelled`,
        tradeId,
      });

      return { success: true };
    } catch (error) {
      logger.error("Error cancelling trade:", error);
      throw error;
    }
  }

  // ===========================================
  // HELPER METHODS
  // ===========================================

  async _getSettings() {
    const db = database.getDb();
    const rows = await db("settings").select("*");
    const settings = {};
    for (const row of rows) {
      if (row.type === "number") {
        settings[row.key] = parseFloat(row.value);
      } else if (row.type === "boolean") {
        settings[row.key] = row.value === "true";
      } else if (row.type === "json") {
        settings[row.key] = JSON.parse(row.value);
      } else {
        settings[row.key] = row.value;
      }
    }
    return settings;
  }

  async _getTemplate(templateId) {
    const db = database.getDb();
    if (templateId) {
      return db("templates").where("id", templateId).first();
    }
    return db("templates").where("is_active", true).first();
  }

  async _logOrderEvent(orderId, tradeId, eventType, eventData) {
    const db = database.getDb();
    await db("order_events").insert({
      order_id: orderId,
      trade_id: tradeId,
      event_type: eventType,
      event_data: JSON.stringify(eventData),
      description: `${eventType}: ${JSON.stringify(eventData)}`,
    });
  }
}

module.exports = new TradeExecutionService();
