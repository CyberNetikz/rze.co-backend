/**
 * RZE Trading Platform - Account Routes
 * 
 * API endpoints for account information and management.
 */

const express = require('express');
const router = express.Router();
const AlpacaService = require('../../services/AlpacaService');
const database = require('../../config/database');
const logger = require('../../utils/logger');

/**
 * GET /api/account
 * Get account information
 */
router.get('/', async (req, res) => {
  try {
    const account = await AlpacaService.getAccount();
    
    // Get settings for starting capital
    const db = database.getDb();
    const startingCapitalSetting = await db('settings')
      .where('key', 'starting_capital')
      .first();
    
    const startingCapital = startingCapitalSetting 
      ? parseFloat(startingCapitalSetting.value) 
      : account.portfolio_value;
    
    // Calculate stats
    const totalPL = account.equity - startingCapital;
    const totalPLPct = startingCapital > 0 ? (totalPL / startingCapital) * 100 : 0;
    const dayPL = account.equity - account.last_equity;
    const dayPLPct = account.last_equity > 0 ? (dayPL / account.last_equity) * 100 : 0;
    
    res.json({
      ...account,
      starting_capital: startingCapital,
      total_pl: totalPL,
      total_pl_pct: totalPLPct,
      day_pl: dayPL,
      day_pl_pct: dayPLPct
    });
    
  } catch (error) {
    logger.error('Error fetching account:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/account/positions
 * Get current positions
 */
router.get('/positions', async (req, res) => {
  try {
    const positions = await AlpacaService.getPositions();
    res.json(positions);
  } catch (error) {
    logger.error('Error fetching positions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/account/position/:symbol
 * Get position for specific symbol
 */
router.get('/position/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const position = await AlpacaService.getPosition(symbol.toUpperCase());
    
    if (!position) {
      return res.status(404).json({ error: 'No position found for symbol' });
    }
    
    res.json(position);
  } catch (error) {
    logger.error('Error fetching position:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/account/stats
 * Get trading statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const db = database.getDb();
    
    // Get completed trades
    const trades = await db('trades')
      .where('status', 'completed')
      .select('*');
    
    const wins = trades.filter(t => parseFloat(t.realized_pnl) > 0);
    const losses = trades.filter(t => parseFloat(t.realized_pnl) <= 0);
    
    const totalWinAmount = wins.reduce((sum, t) => sum + parseFloat(t.realized_pnl), 0);
    const totalLossAmount = Math.abs(losses.reduce((sum, t) => sum + parseFloat(t.realized_pnl), 0));
    
    const stats = {
      total_trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      win_rate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      avg_win: wins.length > 0 ? totalWinAmount / wins.length : 0,
      avg_loss: losses.length > 0 ? -totalLossAmount / losses.length : 0,
      profit_factor: totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? Infinity : 0,
      total_pnl: trades.reduce((sum, t) => sum + parseFloat(t.realized_pnl || 0), 0),
      best_trade: trades.length > 0 ? Math.max(...trades.map(t => parseFloat(t.realized_pnl))) : 0,
      worst_trade: trades.length > 0 ? Math.min(...trades.map(t => parseFloat(t.realized_pnl))) : 0
    };
    
    // Get phase distribution
    const phaseDistribution = await db('trades')
      .where('status', 'completed')
      .groupBy('exit_phase')
      .select('exit_phase')
      .count('* as count');
    
    stats.phase_distribution = phaseDistribution;
    
    res.json(stats);
    
  } catch (error) {
    logger.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/account/clock
 * Get market clock
 */
router.get('/clock', async (req, res) => {
  try {
    const clock = await AlpacaService.getClock();
    res.json(clock);
  } catch (error) {
    logger.error('Error fetching clock:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/account/starting-capital
 * Set starting capital
 */
router.post('/starting-capital', async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (amount === undefined || amount === null) {
      return res.status(400).json({ error: 'Amount is required' });
    }
    
    const db = database.getDb();
    
    await db('settings')
      .where('key', 'starting_capital')
      .update({ 
        value: amount.toString(),
        updated_at: db.fn.now()
      });
    
    res.json({ success: true, starting_capital: amount });
    
  } catch (error) {
    logger.error('Error setting starting capital:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/account/sync-capital
 * Sync starting capital with current Alpaca balance
 */
router.post('/sync-capital', async (req, res) => {
  try {
    const account = await AlpacaService.getAccount();
    const db = database.getDb();
    
    await db('settings')
      .where('key', 'starting_capital')
      .update({ 
        value: account.portfolio_value.toString(),
        updated_at: db.fn.now()
      });
    
    res.json({ 
      success: true, 
      starting_capital: account.portfolio_value,
      message: 'Starting capital synced with Alpaca account balance'
    });
    
  } catch (error) {
    logger.error('Error syncing capital:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
