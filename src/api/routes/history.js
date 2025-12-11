/**
 * RZE Trading Platform - History Routes
 * 
 * API endpoints for trade history and analytics.
 */

const express = require('express');
const router = express.Router();
const database = require('../../config/database');
const logger = require('../../utils/logger');


/**
 * GET /api/history
 * Get trade history with filters
 */
router.get('/', async (req, res) => {
  try {
    const db = database.getDb();
    const { 
      status = 'completed',
      result, // 'win' or 'loss'
      symbol,
      startDate,
      endDate,
      limit = 50,
      offset = 0,
      sortBy = 'exit_time',
      sortOrder = 'desc'
    } = req.query;
    
    let query = db('trades').where('status', status);
    
    // Filter by result (win/loss)
    if (result === 'win') {
      query = query.where('realized_pnl', '>', 0);
    } else if (result === 'loss') {
      query = query.where('realized_pnl', '<=', 0);
    }
    
    // Filter by symbol
    if (symbol) {
      query = query.where('symbol', symbol.toUpperCase());
    }
    
    // Filter by date range
    if (startDate) {
      query = query.where('exit_time', '>=', startDate);
    }
    if (endDate) {
      query = query.where('exit_time', '<=', endDate);
    }
    
    // Sorting
    const validSortColumns = ['exit_time', 'entry_time', 'realized_pnl', 'symbol'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'exit_time';
    const order = sortOrder === 'asc' ? 'asc' : 'desc';
    
    // Get total count
    const countQuery = query.clone();
    const [{ count }] = await countQuery.count('* as count');
    
    // Get paginated results
    const trades = await query
      .orderBy(sortColumn, order)
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    
    // Format results
    const formattedTrades = trades.map(trade => ({
      id: trade.id,
      trade_uuid: trade.trade_uuid,
      symbol: trade.symbol,
      company_name: trade.company_name,
      entry_price: parseFloat(trade.entry_price),
      position_size: parseFloat(trade.position_size),
      total_shares: trade.total_shares,
      exit_phase: trade.exit_phase,
      exit_reason: trade.exit_reason,
      realized_pnl: parseFloat(trade.realized_pnl),
      realized_pnl_pct: parseFloat(trade.realized_pnl_pct),
      result: parseFloat(trade.realized_pnl) > 0 ? 'win' : 'loss',
      entry_time: trade.entry_time,
      exit_time: trade.exit_time,
      duration_minutes: trade.entry_time && trade.exit_time
        ? Math.round((new Date(trade.exit_time) - new Date(trade.entry_time)) / 60000)
        : null
    }));
    
    res.json({
      trades: formattedTrades,
      pagination: {
        total: parseInt(count),
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + formattedTrades.length < parseInt(count)
      }
    });
    
  } catch (error) {
    logger.error('Error fetching history:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/history/summary
 * Get summary statistics
 */
router.get('/summary', async (req, res) => {
  try {
    const db = database.getDb();
    const { startDate, endDate } = req.query;
    
    let query = db('trades').where('status', 'completed');
    
    if (startDate) {
      query = query.where('exit_time', '>=', startDate);
    }
    if (endDate) {
      query = query.where('exit_time', '<=', endDate);
    }
    
    const trades = await query;
    
    if (trades.length === 0) {
      return res.json({
        total_trades: 0,
        wins: 0,
        losses: 0,
        win_rate: 0,
        total_pnl: 0,
        avg_pnl: 0,
        avg_win: 0,
        avg_loss: 0,
        profit_factor: 0,
        best_trade: null,
        worst_trade: null,
        avg_duration_minutes: 0
      });
    }
    
    const wins = trades.filter(t => parseFloat(t.realized_pnl) > 0);
    const losses = trades.filter(t => parseFloat(t.realized_pnl) <= 0);
    
    const totalWinAmount = wins.reduce((sum, t) => sum + parseFloat(t.realized_pnl), 0);
    const totalLossAmount = Math.abs(losses.reduce((sum, t) => sum + parseFloat(t.realized_pnl), 0));
    const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.realized_pnl), 0);
    
    // Calculate durations
    const durations = trades
      .filter(t => t.entry_time && t.exit_time)
      .map(t => (new Date(t.exit_time) - new Date(t.entry_time)) / 60000);
    
    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;
    
    // Find best and worst trades
    const sortedByPnl = [...trades].sort((a, b) => 
      parseFloat(b.realized_pnl) - parseFloat(a.realized_pnl)
    );
    
    res.json({
      total_trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      win_rate: (wins.length / trades.length) * 100,
      total_pnl: totalPnl,
      avg_pnl: totalPnl / trades.length,
      avg_win: wins.length > 0 ? totalWinAmount / wins.length : 0,
      avg_loss: losses.length > 0 ? -totalLossAmount / losses.length : 0,
      profit_factor: totalLossAmount > 0 ? totalWinAmount / totalLossAmount : (totalWinAmount > 0 ? Infinity : 0),
      best_trade: {
        symbol: sortedByPnl[0].symbol,
        pnl: parseFloat(sortedByPnl[0].realized_pnl),
        date: sortedByPnl[0].exit_time
      },
      worst_trade: {
        symbol: sortedByPnl[sortedByPnl.length - 1].symbol,
        pnl: parseFloat(sortedByPnl[sortedByPnl.length - 1].realized_pnl),
        date: sortedByPnl[sortedByPnl.length - 1].exit_time
      },
      avg_duration_minutes: Math.round(avgDuration)
    });
    
  } catch (error) {
    logger.error('Error fetching summary:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/history/by-phase
 * Get statistics grouped by exit phase
 */
router.get('/by-phase', async (req, res) => {
  try {
    const db = database.getDb();
    
    const phaseStats = await db('trades')
      .where('status', 'completed')
      .groupBy('exit_phase')
      .select('exit_phase')
      .count('* as count')
      .sum('realized_pnl as total_pnl')
      .avg('realized_pnl as avg_pnl');
    
    // Format results
    const formatted = phaseStats.map(ps => ({
      phase: ps.exit_phase,
      count: parseInt(ps.count),
      total_pnl: parseFloat(ps.total_pnl) || 0,
      avg_pnl: parseFloat(ps.avg_pnl) || 0
    }));
    
    // Sort by phase
    formatted.sort((a, b) => (a.phase || 0) - (b.phase || 0));
    
    res.json(formatted);
    
  } catch (error) {
    logger.error('Error fetching phase stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/history/by-symbol
 * Get statistics grouped by symbol
 */
router.get('/by-symbol', async (req, res) => {
  try {
    const db = database.getDb();
    const { limit = 20 } = req.query;
    
    const symbolStats = await db('trades')
      .where('status', 'completed')
      .groupBy('symbol')
      .select('symbol')
      .count('* as count')
      .sum('realized_pnl as total_pnl')
      .avg('realized_pnl as avg_pnl');
    
    // Calculate win rate for each symbol
    const formattedStats = await Promise.all(symbolStats.map(async (ss) => {
      const wins = await db('trades')
        .where({ status: 'completed', symbol: ss.symbol })
        .where('realized_pnl', '>', 0)
        .count('* as count')
        .first();
      
      return {
        symbol: ss.symbol,
        count: parseInt(ss.count),
        wins: parseInt(wins.count),
        losses: parseInt(ss.count) - parseInt(wins.count),
        win_rate: (parseInt(wins.count) / parseInt(ss.count)) * 100,
        total_pnl: parseFloat(ss.total_pnl) || 0,
        avg_pnl: parseFloat(ss.avg_pnl) || 0
      };
    }));
    
    // Sort by total trades and limit
    formattedStats.sort((a, b) => b.count - a.count);
    
    res.json(formattedStats.slice(0, parseInt(limit)));
    
  } catch (error) {
    logger.error('Error fetching symbol stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/history/daily
 * Get daily P&L for charting
 */
router.get('/daily', async (req, res) => {
  try {
    const db = database.getDb();
    const { days = 30 } = req.query;
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const trades = await db('trades')
      .where('status', 'completed')
      .where('exit_time', '>=', startDate.toISOString())
      .orderBy('exit_time', 'asc');
    
    // Group by day
    const dailyData = {};
    trades.forEach(trade => {
      const date = new Date(trade.exit_time).toISOString().split('T')[0];
      if (!dailyData[date]) {
        dailyData[date] = {
          date,
          trades: 0,
          wins: 0,
          pnl: 0
        };
      }
      dailyData[date].trades++;
      dailyData[date].pnl += parseFloat(trade.realized_pnl);
      if (parseFloat(trade.realized_pnl) > 0) {
        dailyData[date].wins++;
      }
    });
    
    // Convert to array and calculate cumulative
    const result = Object.values(dailyData);
    let cumulative = 0;
    result.forEach(day => {
      cumulative += day.pnl;
      day.cumulative_pnl = cumulative;
      day.win_rate = day.trades > 0 ? (day.wins / day.trades) * 100 : 0;
    });
    
    res.json(result);
    
  } catch (error) {
    logger.error('Error fetching daily stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/history/events/:tradeId
 * Get order events for a specific trade
 */
router.get('/events/:tradeId', async (req, res) => {
  try {
    const db = database.getDb();
    const { tradeId } = req.params;
    
    const events = await db('order_events')
      .where('trade_id', tradeId)
      .orderBy('event_time', 'desc');
    
    res.json(events);
    
  } catch (error) {
    logger.error('Error fetching trade events:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
