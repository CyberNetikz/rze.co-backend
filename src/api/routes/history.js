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
 * Get trade history with filters (ALL STATUSES)
 */
router.get('/', async (req, res) => {
  try {
    const db = database.getDb();
    const {
      status,
      result,
      symbol,
      startDate,
      endDate,
      limit = 50,
      offset = 0,
      sortBy = 'updated_at',
      sortOrder = 'desc'
    } = req.query;

    let query = db('trades');

    // Trade status filter (optional)
    if (status) {
      query = query.where('status', status);
    }

    // Result filter only applies to completed trades
    if (result === 'win') {
      query = query
        .where('status', 'completed')
        .where('realized_pnl', '>', 0);
    } else if (result === 'loss') {
      query = query
        .where('status', 'completed')
        .where('realized_pnl', '<=', 0);
    }

    // Symbol filter
    if (symbol) {
      query = query.where('symbol', symbol.toUpperCase());
    }

    // Date filters
    if (startDate) {
      query = query.where('updated_at', '>=', startDate);
    }
    if (endDate) {
      query = query.where('updated_at', '<=', endDate);
    }

    // Sorting
    const validSortColumns = [
      'exit_time',
      'entry_time',
      'updated_at',
      'realized_pnl',
      'symbol'
    ];

    const sortColumn = validSortColumns.includes(sortBy)
      ? sortBy
      : 'updated_at';

    const order = sortOrder === 'asc' ? 'asc' : 'desc';

    // Total count
    const [{ count }] = await query.clone().count('* as count');

    // Fetch trades
    const trades = await query
      .orderBy(sortColumn, order)
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    /**
     * Attach comprehensive data per trade
     */
    const formattedTrades = await Promise.all(trades.map(async (trade) => {
      // Get order statistics
      const orderStats = await db('orders')
        .where('trade_id', trade.id)
        .select('status');

      const orderSummary = {
        total: orderStats.length,
        filled: 0,
        open: 0,
        canceled: 0
      };

      orderStats.forEach(o => {
        if (o.status === 'filled') orderSummary.filled++;
        else if (['canceled', 'cancelled', 'rejected', 'expired'].includes(o.status)) {
          orderSummary.canceled++;
        } else {
          orderSummary.open++;
        }
      });

      // Get phase journey
      const phases = await db('trade_phases')
        .where('trade_id', trade.id)
        .orderBy('phase_number', 'asc')
        .select('*');

      // Format phase journey
      const phaseJourney = phases.map(phase => {
        const phasePnl = phase.phase_pnl ? parseFloat(phase.phase_pnl) : null;
        const exitPrice = phase.exit_price ? parseFloat(phase.exit_price) : null;
        
        return {
          phase: phase.phase_number,
          status: phase.status, // pending, active, completed
          
          // Target prices
          take_profit_price: parseFloat(phase.take_profit_price),
          stop_loss_price: parseFloat(phase.stop_loss_price),
          take_profit_pct: parseFloat(phase.take_profit_pct),
          stop_loss_pct: parseFloat(phase.stop_loss_pct),
          
          // Execution details
          shares_to_sell: phase.shares_to_sell,
          exit_price: exitPrice,
          exit_type: phase.exit_type, // take_profit, stop_loss, or null if pending
          
          // P&L for this phase
          phase_pnl: phasePnl,
          phase_pnl_pct: phasePnl && phase.shares_to_sell && trade.entry_price
            ? ((phasePnl / (parseFloat(trade.entry_price) * phase.shares_to_sell)) * 100).toFixed(4)
            : null,
          
          // Timestamps
          started_at: phase.started_at,
          completed_at: phase.completed_at,
          
          // Duration if completed
          duration_minutes: phase.started_at && phase.completed_at
            ? Math.round((new Date(phase.completed_at) - new Date(phase.started_at)) / 60000)
            : null
        };
      });

      // Calculate trade summary
      const isCompleted = trade.status === 'completed';
      const realizedPnl = parseFloat(trade.realized_pnl || 0);
      const entryPrice = parseFloat(trade.entry_price);
      const positionSize = parseFloat(trade.position_size);

      // Get current active phase info
      const currentPhase = phases.find(p => p.status === 'active') || null;
      
      return {
        // Trade identification
        id: trade.id,
        trade_uuid: trade.trade_uuid,
        symbol: trade.symbol,
        company_name: trade.company_name,

        // Trade status
        trade_status: trade.status, // active, completed, cancelled
        current_phase: trade.current_phase,

        // Entry details
        entry_price: entryPrice,
        position_size: positionSize,
        total_shares: trade.total_shares,
        remaining_shares: trade.remaining_shares,

        // Exit details (for completed trades)
        exit_phase: trade.exit_phase,
        exit_reason: trade.exit_reason, // stopped_out, manual, etc.

        // P&L (only for completed trades)
        realized_pnl: isCompleted ? realizedPnl : null,
        realized_pnl_pct: isCompleted
          ? parseFloat(trade.realized_pnl_pct)
          : null,

        // Result classification
        result: isCompleted
          ? (realizedPnl > 0 ? 'win' : 'loss')
          : null,

        // Unrealized P&L for active trades (if you track current price)
        // This would require current market price - you'd need to add this logic
        unrealized_pnl: trade.status === 'active' && currentPhase
          ? `Calculate based on current market price vs entry_price * remaining_shares`
          : null,

        // Timing
        entry_time: trade.entry_time,
        exit_time: trade.exit_time,
        duration_minutes: trade.entry_time && trade.exit_time
            ? Math.round((new Date(trade.exit_time) - new Date(trade.entry_time)) / 60000)
            : null,

        // Template used
        template_id: trade.template_id,
        template_name: trade.template_snapshot?.name || null,

        // Order statistics
        orders: orderSummary,

        // Phase journey - complete history of all phases
        journey: {
          total_phases: phases.length,
          completed_phases: phases.filter(p => p.status === 'completed').length,
          current_phase_details: currentPhase ? {
            phase: currentPhase.phase_number,
            shares_to_sell: currentPhase.shares_to_sell,
            take_profit_price: parseFloat(currentPhase.take_profit_price),
            stop_loss_price: parseFloat(currentPhase.stop_loss_price),
            started_at: currentPhase.started_at
          } : null,
          phases: phaseJourney,
          
          // Quick stats from journey
          phases_won: phases.filter(p => p.exit_type === 'take_profit').length,
          phases_stopped: phases.filter(p => p.exit_type === 'stop_loss').length,
          total_shares_sold: phases
            .filter(p => p.status === 'completed')
            .reduce((sum, p) => sum + p.shares_to_sell, 0)
        }
      };
    }));

    res.json({
      trades: formattedTrades,
      pagination: {
        total: parseInt(count),
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + formattedTrades.length < parseInt(count)
      },
      summary: {
        // Optional: Add summary statistics
        total_trades: formattedTrades.length,
        wins: formattedTrades.filter(t => t.result === 'win').length,
        losses: formattedTrades.filter(t => t.result === 'loss').length,
        active: formattedTrades.filter(t => t.trade_status === 'active').length,
        total_pnl: formattedTrades
          .filter(t => t.realized_pnl !== null)
          .reduce((sum, t) => sum + t.realized_pnl, 0)
          .toFixed(2)
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

    if (events.length > 0) {
      return res.json(events);
    }

    // Fallback to order state (important for open trades)
    const orders = await db('orders')
      .where('trade_id', tradeId)
      .orderBy('updated_at', 'desc');

    res.json({
      source: 'orders',
      data: orders
    });

  } catch (error) {
    logger.error('Error fetching trade events:', error);
    res.status(500).json({ error: error.message });
  }
});


module.exports = router;
