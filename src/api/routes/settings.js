/**
 * RZE Trading Platform - Settings Routes
 * 
 * API endpoints for system settings.
 */

const express = require('express');
const router = express.Router();
const database = require('../../config/database');
const NotificationService = require('../../services/NotificationService');
const logger = require('../../utils/logger');

/**
 * GET /api/settings
 * Get all settings
 */
router.get('/', async (req, res) => {
  try {
    const db = database.getDb();
    
    const settings = await db('settings').select('*');
    
    // Convert to object format
    const settingsObj = {};
    settings.forEach(s => {
      if (s.type === 'number') {
        settingsObj[s.key] = parseFloat(s.value);
      } else if (s.type === 'boolean') {
        settingsObj[s.key] = s.value === 'true';
      } else if (s.type === 'json') {
        settingsObj[s.key] = JSON.parse(s.value);
      } else {
        settingsObj[s.key] = s.value;
      }
    });
    
    res.json(settingsObj);
    
  } catch (error) {
    logger.error('Error fetching settings:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/settings/:key
 * Get a specific setting
 */
router.get('/:key', async (req, res) => {
  try {
    const db = database.getDb();
    const { key } = req.params;
    
    const setting = await db('settings').where('key', key).first();
    
    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    
    let value = setting.value;
    if (setting.type === 'number') {
      value = parseFloat(value);
    } else if (setting.type === 'boolean') {
      value = value === 'true';
    } else if (setting.type === 'json') {
      value = JSON.parse(value);
    }
    
    res.json({
      key: setting.key,
      value,
      type: setting.type,
      description: setting.description
    });
    
  } catch (error) {
    logger.error('Error fetching setting:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/settings/:key
 * Update a setting
 */
router.put('/:key', async (req, res) => {
  try {
    const db = database.getDb();
    const { key } = req.params;
    const { value } = req.body;
    
    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }
    
    const setting = await db('settings').where('key', key).first();
    
    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    
    // Convert value to string for storage
    let stringValue;
    if (setting.type === 'json') {
      stringValue = JSON.stringify(value);
    } else {
      stringValue = String(value);
    }
    
    await db('settings')
      .where('key', key)
      .update({ 
        value: stringValue,
        updated_at: db.fn.now()
      });
    
    logger.info(`Updated setting: ${key} = ${stringValue}`);
    
    res.json({
      key,
      value,
      type: setting.type,
      message: 'Setting updated successfully'
    });
    
  } catch (error) {
    logger.error('Error updating setting:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/settings
 * Update multiple settings
 */
router.put('/', async (req, res) => {
  try {
    const db = database.getDb();
    const updates = req.body;
    
    const results = [];
    
    for (const [key, value] of Object.entries(updates)) {
      const setting = await db('settings').where('key', key).first();
      
      if (!setting) {
        results.push({ key, success: false, error: 'Setting not found' });
        continue;
      }
      
      let stringValue;
      if (setting.type === 'json') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }
      
      await db('settings')
        .where('key', key)
        .update({ 
          value: stringValue,
          updated_at: db.fn.now()
        });
      
      results.push({ key, success: true, value });
    }
    
    logger.info(`Updated ${results.filter(r => r.success).length} settings`);
    
    res.json({ results });
    
  } catch (error) {
    logger.error('Error updating settings:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/settings/notifications/test
 * Send a test notification
 */
router.post('/notifications/test', async (req, res) => {
  try {
    const { channel } = req.body;
    
    const result = await NotificationService.sendTest(channel || 'both');
    
    res.json(result);
    
  } catch (error) {
    logger.error('Error sending test notification:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/settings/notifications/status
 * Get notification service status
 */
router.get('/notifications/status', async (req, res) => {
  try {
    const status = {
      slack: {
        enabled: process.env.SLACK_ENABLED === 'true',
        configured: !!process.env.SLACK_BOT_TOKEN && !!process.env.SLACK_CHANNEL_ID
      },
      email: {
        enabled: process.env.EMAIL_ENABLED === 'true',
        configured: !!process.env.EMAIL_HOST && !!process.env.EMAIL_USER
      }
    };
    
    res.json(status);
    
  } catch (error) {
    logger.error('Error getting notification status:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
