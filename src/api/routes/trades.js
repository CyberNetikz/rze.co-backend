/**
 * RZE Trading Platform - Trade Routes
 * 
 * API endpoints for trade execution and management.
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const database = require('../../config/database');
const AlpacaService = require('../../services/AlpacaService');
const TradeExecutionService = require('../../services/TradeExecutionService');
const logger = require('../../utils/logger');

/**
 * GET /api/trades
 * Get all trades (with optional filters)
 */
router.get('/', async (req, res) => {
  try {
    const db = database.getDb();
    const { status, limit = 50, offset = 0 } = req.query;
    
    let query = db('trades')
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    
    if (status) {
      query = query.where('status', status);
    }
    
    const trades = await query;
    
    // Get phases for each trade
    const tradesWithPhases = await Promise.all(trades.map(async (trade) => {
      const phases = await db('trade_phases')
        .where('trade_id', trade.id)
        .orderBy('phase_number');
      
      return {
        ...trade,
        phases,
        entry_price: parseFloat(trade.entry_price),
        position_size: parseFloat(trade.position_size),
        realized_pnl: trade.realized_pnl ? parseFloat(trade.realized_pnl) : null,
        realized_pnl_pct: trade.realized_pnl_pct ? parseFloat(trade.realized_pnl_pct) : null
      };
    }));
    
    res.json(tradesWithPhases);
    
  } catch (error) {
    logger.error('Error fetching trades:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/trades/active
 * Get active trades only
 */
router.get('/active', async (req, res) => {
  try {
    const db = database.getDb();
    
    const trades = await db('trades')
      .whereIn('status', ['pending', 'active'])
      .orderBy('entry_time', 'desc');
    
    // Get phases and current prices for each trade
    const tradesWithDetails = await Promise.all(trades.map(async (trade) => {
      const phases = await db('trade_phases')
        .where('trade_id', trade.id)
        .orderBy('phase_number');
      
      // Get current price
      let currentPrice = parseFloat(trade.entry_price);
      let unrealizedPnl = 0;
      let unrealizedPnlPct = 0;
      
      try {
        const latestTrade = await AlpacaService.getLatestTrade(trade.symbol);
        currentPrice = latestTrade.price;
        unrealizedPnl = (currentPrice - parseFloat(trade.entry_price)) * trade.remaining_shares;
        unrealizedPnlPct = ((currentPrice - parseFloat(trade.entry_price)) / parseFloat(trade.entry_price)) * 100;
      } catch (e) {
        // Use entry price if we can't get current price
      }
      
      // Get current phase details
      const currentPhaseData = phases.find(p => p.phase_number === trade.current_phase);
      
      return {
        id: trade.id,
        trade_uuid: trade.trade_uuid,
        symbol: trade.symbol,
        company_name: trade.company_name,
        status: trade.status,
        entry_price: parseFloat(trade.entry_price),
        current_price: currentPrice,
        total_shares: trade.total_shares,
        remaining_shares: trade.remaining_shares,
        position_size: parseFloat(trade.position_size),
        current_value: currentPrice * trade.remaining_shares,
        current_phase: trade.current_phase,
        unrealized_pnl: unrealizedPnl,
        unrealized_pnl_pct: unrealizedPnlPct,
        stop_loss: currentPhaseData ? parseFloat(currentPhaseData.stop_loss_price) : null,
        next_target: currentPhaseData ? parseFloat(currentPhaseData.take_profit_price) : null,
        entry_time: trade.entry_time,
        phases: phases.map(p => ({
          phase_number: p.phase_number,
          status: p.status,
          take_profit_price: parseFloat(p.take_profit_price),
          stop_loss_price: parseFloat(p.stop_loss_price),
          shares_to_sell: p.shares_to_sell,
          phase_pnl: p.phase_pnl ? parseFloat(p.phase_pnl) : null
        }))
      };
    }));
    
    res.json(tradesWithDetails);
    
  } catch (error) {
    logger.error('Error fetching active trades:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/trades/:id
 * Get trade by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const db = database.getDb();
    const { id } = req.params;
    
    const trade = await db('trades').where('id', id).first();
    
    if (!trade) {
      return res.status(404).json({ error: 'Trade not found' });
    }
    
    const phases = await db('trade_phases')
      .where('trade_id', id)
      .orderBy('phase_number');
    
    const orders = await db('orders')
      .where('trade_id', id)
      .orderBy('created_at', 'desc');
    
    const events = await db('order_events')
      .where('trade_id', id)
      .orderBy('event_time', 'desc')
      .limit(50);
    
    res.json({
      ...trade,
      entry_price: parseFloat(trade.entry_price),
      position_size: parseFloat(trade.position_size),
      realized_pnl: trade.realized_pnl ? parseFloat(trade.realized_pnl) : null,
      phases,
      orders,
      events
    });
    
  } catch (error) {
    logger.error('Error fetching trade:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/trades
 * Execute a new trade
 */
router.post('/',
  [
    body('symbol').notEmpty().withMessage('Symbol is required'),
    body('entryPrice').isFloat({ gt: 0 }).withMessage('Entry price must be a positive number'),
    body('positionSize').optional().isFloat({ gt: 0 }),
    body('templateId').optional().isInt()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const { symbol, entryPrice, positionSize, templateId } = req.body;
      
      logger.trade('New trade request', { symbol, entryPrice, positionSize, templateId });
      
      const result = await TradeExecutionService.executeTrade({
        symbol,
        entryPrice: parseFloat(entryPrice),
        positionSize: positionSize ? parseFloat(positionSize) : null,
        templateId: templateId ? parseInt(templateId) : null
      });
      
      res.status(201).json(result);
      
    } catch (error) {
      logger.error('Error executing trade:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/trades/:id/cancel
 * Cancel an active trade
 */
router.post('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await TradeExecutionService.cancelTrade(parseInt(id));
    res.json(result);
    
  } catch (error) {
    logger.error('Error cancelling trade:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/trades/:id/orders
 * Get orders for a trade
 */
router.get('/:id/orders', async (req, res) => {
  try {
    const db = database.getDb();
    const { id } = req.params;
    
    const orders = await db('orders')
      .where('trade_id', id)
      .orderBy('created_at', 'desc');
    
    res.json(orders);
    
  } catch (error) {
    logger.error('Error fetching trade orders:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/trades/quote/:symbol
 * Get quote for a symbol
 */
router.get('/quote/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    
    const [asset, quote, latestTrade] = await Promise.all([
      AlpacaService.getAsset(symbol.toUpperCase()),
      AlpacaService.getLatestQuote(symbol.toUpperCase()).catch(() => null),
      AlpacaService.getLatestTrade(symbol.toUpperCase()).catch(() => null)
    ]);
    
    res.json({
      symbol: asset.symbol,
      name: asset.name,
      exchange: asset.exchange,
      tradable: asset.tradable,
      bid: quote?.bid_price,
      ask: quote?.ask_price,
      last: latestTrade?.price,
      timestamp: latestTrade?.timestamp
    });
    
  } catch (error) {
    logger.error('Error fetching quote:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/trades/calculate
 * Calculate trade details (shares, position size) before execution
 */
router.post('/calculate',
  [
    body('symbol').notEmpty(),
    body('entryPrice').isFloat({ gt: 0 })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const { symbol, entryPrice, positionSize: customPositionSize, templateId } = req.body;
      const db = database.getDb();
      
      // Get account and settings
      const account = await AlpacaService.getAccount();
      const settings = await db('settings').select('*');
      const settingsMap = {};
      settings.forEach(s => {
        settingsMap[s.key] = s.type === 'number' ? parseFloat(s.value) : s.value;
      });
      
      const startingCapital = settingsMap.starting_capital || account.portfolio_value;
      const tradeSizePercent = settingsMap.trade_size_percent || 20;
      const positionSize = customPositionSize || (startingCapital * (tradeSizePercent / 100));
      
      // Get template
      let template;
      if (templateId) {
        template = await db('templates').where('id', templateId).first();
      } else {
        template = await db('templates').where('is_active', true).first();
      }
      
      const phases = template ? (typeof template.phases === 'string' ? JSON.parse(template.phases) : template.phases) : [];
      
      // Calculate shares
      const price = parseFloat(entryPrice);
      const totalShares = Math.floor(positionSize / price);
      const actualPositionSize = totalShares * price;
      
      // Calculate phase details
      let sharesAllocated = 0;
      const phaseDetails = phases.map((phase, idx) => {
        const sharesToSell = idx === phases.length - 1
          ? totalShares - sharesAllocated
          : Math.floor(totalShares * (phase.sell_pct / 100));
        sharesAllocated += sharesToSell;
        
        return {
          phase: phase.phase,
          take_profit_price: price * (1 + phase.take_profit_pct / 100),
          stop_loss_price: price * (1 + phase.stop_loss_pct / 100),
          shares_to_sell: sharesToSell,
          sell_pct: phase.sell_pct
        };
      });
      
      // Calculate max risk and max reward
      const maxRisk = phases.length > 0 ? phases[0].stop_loss_pct : -2;
      const maxReward = phases.length > 0 ? phases[phases.length - 1].take_profit_pct : 12;
      
      res.json({
        symbol: symbol.toUpperCase(),
        entry_price: price,
        position_size: actualPositionSize,
        total_shares: totalShares,
        starting_capital: startingCapital,
        trade_size_percent: tradeSizePercent,
        buying_power: account.buying_power,
        can_afford: actualPositionSize <= account.buying_power,
        template: template ? {
          id: template.id,
          name: template.name
        } : null,
        phases: phaseDetails,
        max_risk_pct: maxRisk,
        max_reward_pct: maxReward,
        max_risk_amount: actualPositionSize * (Math.abs(maxRisk) / 100),
        max_reward_amount: actualPositionSize * (maxReward / 100)
      });
      
    } catch (error) {
      logger.error('Error calculating trade:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
