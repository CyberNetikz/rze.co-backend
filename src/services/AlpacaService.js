/**
 * RZE Trading Platform - Alpaca Service
 *
 * Handles all interactions with the Alpaca Trading API.
 * Supports both paper and live trading modes.
 */

const Alpaca = require("@alpacahq/alpaca-trade-api");
const logger = require("../utils/logger");

class AlpacaService {
  constructor() {
    this.client = null;
    this.mode = null;
    this.account = null;
    this.isInitialized = false;
  }

  /**
   * Initialize the Alpaca client
   */
  async initialize() {
    try {
      this.mode = process.env.TRADING_MODE || "paper";

      const config = {
        keyId:
          this.mode === "live"
            ? process.env.ALPACA_LIVE_API_KEY
            : process.env.ALPACA_PAPER_API_KEY,
        secretKey:
          this.mode === "live"
            ? process.env.ALPACA_LIVE_SECRET_KEY
            : process.env.ALPACA_PAPER_SECRET_KEY,
        baseUrl:
          this.mode === "live"
            ? process.env.ALPACA_LIVE_BASE_URL
            : process.env.ALPACA_PAPER_BASE_URL,
        paper: this.mode === "paper",
      };

      if (!config.keyId || !config.secretKey) {
        throw new Error(
          `Alpaca API credentials not configured for ${this.mode} mode`
        );
      }

      this.client = new Alpaca(config);

      // Verify connection by fetching account
      this.account = await this.client.getAccount();

      logger.info(`Alpaca initialized in ${this.mode} mode`);
      logger.info(`Account Status: ${this.account.status}`);
      logger.info(
        `Buying Power: $${parseFloat(
          this.account.buying_power
        ).toLocaleString()}`
      );
      logger.info(
        `Portfolio Value: $${parseFloat(
          this.account.portfolio_value
        ).toLocaleString()}`
      );

      this.isInitialized = true;
      return this.account;
    } catch (error) {
      logger.error("Failed to initialize Alpaca:", error);
      throw error;
    }
  }

  /**
   * Get connection status
   */
  async getConnectionStatus() {
    try {
      if (!this.client) return "disconnected";
      await this.client.getAccount();
      return "connected";
    } catch (error) {
      return "error";
    }
  }

  /**
   * Disconnect from Alpaca
   */
  async disconnect() {
    this.client = null;
    this.isInitialized = false;
    logger.info("Alpaca client disconnected");
  }

  // ===========================================
  // ACCOUNT METHODS
  // ===========================================

  /**
   * Get account information
   */
  async getAccount() {
    try {
      this.account = await this.client.getAccount();
      return {
        id: this.account.id,
        status: this.account.status,
        currency: this.account.currency,
        cash: parseFloat(this.account.cash),
        portfolio_value: parseFloat(this.account.portfolio_value),
        buying_power: parseFloat(this.account.buying_power),
        equity: parseFloat(this.account.equity),
        last_equity: parseFloat(this.account.last_equity),
        long_market_value: parseFloat(this.account.long_market_value),
        short_market_value: parseFloat(this.account.short_market_value),
        initial_margin: parseFloat(this.account.initial_margin),
        maintenance_margin: parseFloat(this.account.maintenance_margin),
        daytrade_count: this.account.daytrade_count,
        pattern_day_trader: this.account.pattern_day_trader,
        trading_blocked: this.account.trading_blocked,
        transfers_blocked: this.account.transfers_blocked,
        account_blocked: this.account.account_blocked,
        trade_suspended_by_user: this.account.trade_suspended_by_user,
        trading_mode: this.mode,
      };
    } catch (error) {
      logger.error("Error fetching account:", error);
      throw error;
    }
  }

  /**
   * Get current positions
   */
  async getPositions() {
    try {
      const positions = await this.client.getPositions();
      return positions.map((p) => ({
        symbol: p.symbol,
        qty: parseInt(p.qty),
        side: p.side,
        market_value: parseFloat(p.market_value),
        cost_basis: parseFloat(p.cost_basis),
        unrealized_pl: parseFloat(p.unrealized_pl),
        unrealized_plpc: parseFloat(p.unrealized_plpc),
        current_price: parseFloat(p.current_price),
        avg_entry_price: parseFloat(p.avg_entry_price),
        change_today: parseFloat(p.change_today),
      }));
    } catch (error) {
      logger.error("Error fetching positions:", error);
      throw error;
    }
  }

  /**
   * Get position for specific symbol
   */
  async getPosition(symbol) {
    try {
      const position = await this.client.getPosition(symbol);
      return {
        symbol: position.symbol,
        qty: parseInt(position.qty),
        side: position.side,
        market_value: parseFloat(position.market_value),
        cost_basis: parseFloat(position.cost_basis),
        unrealized_pl: parseFloat(position.unrealized_pl),
        unrealized_plpc: parseFloat(position.unrealized_plpc),
        current_price: parseFloat(position.current_price),
        avg_entry_price: parseFloat(position.avg_entry_price),
      };
    } catch (error) {
      if (error.statusCode === 404) {
        return null; // No position
      }
      logger.error(`Error fetching position for ${symbol}:`, error);
      throw error;
    }
  }

  // ===========================================
  // ASSET METHODS
  // ===========================================

  /**
   * Get asset information
   */
  async getAsset(symbol) {
    try {
      const asset = await this.client.getAsset(symbol);
      return {
        id: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        exchange: asset.exchange,
        asset_class: asset.class,
        tradable: asset.tradable,
        marginable: asset.marginable,
        shortable: asset.shortable,
        easy_to_borrow: asset.easy_to_borrow,
        fractionable: asset.fractionable,
        status: asset.status,
      };
    } catch (error) {
      logger.error(`Error fetching asset ${symbol}:`, error);
      throw error;
    }
  }

  /**
   * Check if asset is tradable during extended hours
   */
  async isOvernightTradable(symbol) {
    try {
      const asset = await this.client.getAsset(symbol);
      // Check if the asset supports extended hours trading
      return asset.tradable && !asset.status.includes("inactive");
    } catch (error) {
      logger.error(
        `Error checking overnight tradability for ${symbol}:`,
        error
      );
      return false;
    }
  }

  /**
   * Get latest quote for a symbol
   */
  async getLatestQuote(symbol) {
    try {
      const quote = await this.client.getLatestQuote(symbol);
      return {
        symbol: symbol,
        bid_price: parseFloat(quote.BidPrice),
        ask_price: parseFloat(quote.AskPrice),
        bid_size: quote.BidSize,
        ask_size: quote.AskSize,
        timestamp: quote.Timestamp,
      };
    } catch (error) {
      logger.error(`Error fetching quote for ${symbol}:`, error);
      throw error;
    }
  }

  /**
   * Get latest trade for a symbol
   */
  async getLatestTrade(symbol) {
    try {
      const trade = await this.client.getLatestTrade(symbol);
      return {
        symbol: symbol,
        price: parseFloat(trade.Price),
        size: trade.Size,
        timestamp: trade.Timestamp,
      };
    } catch (error) {
      logger.error(`Error fetching latest trade for ${symbol}:`, error);
      throw error;
    }
  }

  // ===========================================
  // ORDER METHODS
  // ===========================================

  /**
   * Place a market buy order (for entry)
   */
  async placeMarketBuyOrder(symbol, qty, clientOrderId = null) {
    try {
      const orderParams = {
        symbol: symbol,
        qty: qty,
        side: "buy",
        type: "market",
        time_in_force: "day",
        extended_hours: false,
      };

      if (clientOrderId) {
        orderParams.client_order_id = clientOrderId;
      }

      logger.order("Placing market buy order", orderParams);
      const order = await this.client.createOrder(orderParams);
      logger.order("Market buy order placed", {
        orderId: order.id,
        symbol,
        qty,
      });

      return this._formatOrder(order);
    } catch (error) {
      logger.error("Error placing market buy order:", error);
      throw error;
    }
  }

  /**
   * Place a limit buy order (for entry)
   */
  async placeLimitBuyOrder(symbol, qty, limitPrice, clientOrderId = null) {
    try {
      const orderParams = {
        symbol: symbol,
        qty: qty,
        side: "buy",
        type: "limit",
        time_in_force: "gtc",
        limit_price: Number(limitPrice).toFixed(2),
        extended_hours: false,
      };

      if (clientOrderId) {
        orderParams.client_order_id = clientOrderId;
      }

      logger.order("Placing limit buy order", orderParams);
      const order = await this.client.createOrder(orderParams);
      logger.order("Limit buy order placed", {
        orderId: order.id,
        symbol,
        qty,
        limitPrice,
      });

      return this._formatOrder(order);
    } catch (error) {
      logger.error("Error placing limit buy order:", error);
      throw error;
    }
  }

  /**
   * Place an OCO (One-Cancels-Other) sell order
   * This is the primary order type for phased exits
   */
  async placeOCOSellOrder(
    symbol,
    qty,
    takeProfitPrice,
    stopLossPrice,
    clientOrderId = null
  ) {
    try {
      const tp = Number(takeProfitPrice);
      const sl = Number(stopLossPrice);

      if (Number.isNaN(tp) || Number.isNaN(sl)) {
        throw new Error("Invalid takeProfitPrice or stopLossPrice");
      }
      const orderParams = {
        symbol: symbol,
        qty: qty,
        side: "sell",
        type: "limit",
        time_in_force: "gtc",
        order_class: "oco",
        extended_hours: false,
        take_profit: {
          limit_price: tp.toFixed(2),
        },
        stop_loss: {
          stop_price: sl.toFixed(2),
        },
      };

      if (clientOrderId) {
        orderParams.client_order_id = clientOrderId;
      }

      logger.order("Placing OCO sell order", orderParams);
      const order = await this.client.createOrder(orderParams);
      logger.order("OCO sell order placed", {
        orderId: order.id,
        symbol,
        qty,
        tp,
        sl,
      });

      return this._formatOrder(order);
    } catch (error) {
      logger.error("Error placing OCO sell order:", error);
      throw error;
    }
  }

  /**
   * Place a stop loss sell order
   */
  async placeStopLossSellOrder(symbol, qty, stopPrice, clientOrderId = null) {
    try {
      const orderParams = {
        symbol: symbol,
        qty: qty,
        side: "sell",
        type: "stop",
        time_in_force: "gtc",
        stop_price: Number(stopPrice).toFixed(2),
        extended_hours: false,
      };

      if (clientOrderId) {
        orderParams.client_order_id = clientOrderId;
      }

      logger.order("Placing stop loss sell order", orderParams);
      const order = await this.client.createOrder(orderParams);
      logger.order("Stop loss sell order placed", {
        orderId: order.id,
        symbol,
        qty,
        stopPrice,
      });

      return this._formatOrder(order);
    } catch (error) {
      logger.error("Error placing stop loss sell order:", error);
      throw error;
    }
  }

  /**
   * Place a limit sell order
   */
  async placeLimitSellOrder(symbol, qty, limitPrice, clientOrderId = null) {
    try {
      const orderParams = {
        symbol: symbol,
        qty: qty,
        side: "sell",
        type: "limit",
        time_in_force: "gtc",
        limit_price: Number(limitPrice).toFixed(2),
        extended_hours: false,
      };

      if (clientOrderId) {
        orderParams.client_order_id = clientOrderId;
      }

      logger.order("Placing limit sell order", orderParams);
      const order = await this.client.createOrder(orderParams);
      logger.order("Limit sell order placed", {
        orderId: order.id,
        symbol,
        qty,
        limitPrice,
      });

      return this._formatOrder(order);
    } catch (error) {
      logger.error("Error placing limit sell order:", error);
      throw error;
    }
  }

  /**
   * Get order by ID
   */
  async getOrder(orderId) {
    try {
      const order = await this.client.getOrder(orderId);
      return this._formatOrder(order);
    } catch (error) {
      logger.error(`Error fetching order ${orderId}:`, error);
      throw error;
    }
  }

  /**
   * Get all orders
   */
  async getOrders(status = "open", limit = 500, symbols = null) {
    try {
      const params = {
        status: status,
        limit: limit,
      };

      if (symbols && symbols.length > 0) {
        params.symbols = symbols.join(",");
      }

      const orders = await this.client.getOrders(params);
      return orders.map((o) => this._formatOrder(o));
    } catch (error) {
      logger.error("Error fetching orders:", error);
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId) {
    try {
      logger.order("Cancelling order", { orderId });
      await this.client.cancelOrder(orderId);
      logger.order("Order cancelled", { orderId });
      return true;
    } catch (error) {
      if (error.statusCode === 404) {
        logger.warn(`Order ${orderId} not found for cancellation`);
        return false;
      }
      logger.error(`Error cancelling order ${orderId}:`, error);
      throw error;
    }
  }

  /**
   * Cancel all orders for a symbol
   */
  async cancelAllOrders(symbol = null) {
    try {
      if (symbol) {
        const orders = await this.getOrders("open", 500, [symbol]);
        for (const order of orders) {
          await this.cancelOrder(order.id);
        }
        logger.order(`Cancelled all orders for ${symbol}`, {
          count: orders.length,
        });
        return orders.length;
      } else {
        await this.client.cancelAllOrders();
        logger.order("Cancelled all open orders");
        return true;
      }
    } catch (error) {
      logger.error("Error cancelling orders:", error);
      throw error;
    }
  }

  /**
   * Replace an order (modify)
   */
  async replaceOrder(orderId, updates) {
    try {
      logger.order("Replacing order", { orderId, updates });
      const order = await this.client.replaceOrder(orderId, updates);
      logger.order("Order replaced", {
        oldOrderId: orderId,
        newOrderId: order.id,
      });
      return this._formatOrder(order);
    } catch (error) {
      logger.error(`Error replacing order ${orderId}:`, error);
      throw error;
    }
  }

  // ===========================================
  // MARKET METHODS
  // ===========================================

  /**
   * Get market clock
   */
  async getClock() {
    try {
      const clock = await this.client.getClock();
      return {
        timestamp: clock.timestamp,
        is_open: clock.is_open,
        next_open: clock.next_open,
        next_close: clock.next_close,
      };
    } catch (error) {
      logger.error("Error fetching market clock:", error);
      throw error;
    }
  }

  /**
   * Get calendar (trading days)
   */
  async getCalendar(start, end) {
    try {
      const calendar = await this.client.getCalendar({ start, end });
      return calendar.map((day) => ({
        date: day.date,
        open: day.open,
        close: day.close,
        session_open: day.session_open,
        session_close: day.session_close,
      }));
    } catch (error) {
      logger.error("Error fetching calendar:", error);
      throw error;
    }
  }

  // ===========================================
  // WEBSOCKET METHODS
  // ===========================================

  /**
   * Get the WebSocket for trade updates
   */
  getTradeUpdatesWebSocket() {
    return this.client.trade_ws;
  }

  /**
   * Get the WebSocket for data streaming
   */
  getDataWebSocket() {
    return this.client.data_ws;
  }

  // ===========================================
  // HELPER METHODS
  // ===========================================

  /**
   * Format order response
   */
  _formatOrder(order) {
    return {
      id: order.id,
      client_order_id: order.client_order_id,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      order_class: order.order_class,
      qty: parseInt(order.qty),
      filled_qty: parseInt(order.filled_qty || 0),
      limit_price: order.limit_price ? parseFloat(order.limit_price) : null,
      stop_price: order.stop_price ? parseFloat(order.stop_price) : null,
      filled_avg_price: order.filled_avg_price
        ? parseFloat(order.filled_avg_price)
        : null,
      status: order.status,
      time_in_force: order.time_in_force,
      extended_hours: order.extended_hours,
      created_at: order.created_at,
      updated_at: order.updated_at,
      submitted_at: order.submitted_at,
      filled_at: order.filled_at,
      expired_at: order.expired_at,
      cancelled_at: order.cancelled_at,
      failed_at: order.failed_at,
      legs: order.legs ? order.legs.map((leg) => this._formatOrder(leg)) : null,
    };
  }
}

// Export singleton instance
module.exports = new AlpacaService();
