/**
 * RZE Trading Platform - Notification Service
 * 
 * Handles sending notifications via Slack and Email.
 * All trade events, phase transitions, and errors trigger notifications.
 */

const { WebClient } = require('@slack/web-api');
const nodemailer = require('nodemailer');
const database = require('../config/database');
const logger = require('../utils/logger');

class NotificationService {
  constructor() {
    this.slackClient = null;
    this.emailTransporter = null;
    this.isInitialized = false;
  }

  /**
   * Initialize notification services
   */
  async initialize() {
    try {
      // Initialize Slack
      if (process.env.SLACK_ENABLED === 'true' && process.env.SLACK_BOT_TOKEN) {
        this.slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
        
        // Test connection
        try {
          await this.slackClient.auth.test();
          logger.info('Slack notification service initialized');
        } catch (error) {
          logger.warn('Slack auth failed:', error.message);
          this.slackClient = null;
        }
      }

      // Initialize Email
      if (process.env.EMAIL_ENABLED === 'true' && process.env.EMAIL_HOST) {
        this.emailTransporter = nodemailer.createTransport({
          host: process.env.EMAIL_HOST,
          port: parseInt(process.env.EMAIL_PORT) || 587,
          secure: process.env.EMAIL_PORT === '465',
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD
          }
        });

        // Verify connection
        try {
          await this.emailTransporter.verify();
          logger.info('Email notification service initialized');
        } catch (error) {
          logger.warn('Email verification failed:', error.message);
          this.emailTransporter = null;
        }
      }

      this.isInitialized = true;
      
    } catch (error) {
      logger.error('Failed to initialize notification service:', error);
      // Don't throw - notifications are not critical
    }
  }

  /**
   * Send a notification
   * 
   * @param {Object} params - Notification parameters
   * @param {string} params.type - 'trade', 'phase', 'error', 'system'
   * @param {string} params.title - Notification title
   * @param {string} params.message - Notification message
   * @param {number} params.tradeId - Optional trade ID
   * @param {string} params.channel - 'slack', 'email', 'both' (default: from settings)
   */
  async send({ type, title, message, tradeId = null, channel = null }) {
    try {
      const db = database.getDb();
      
      // Determine channel
      const effectiveChannel = channel || 'slack';
      
      // Record notification
      const [{ id: notificationId }] = await db('notifications').insert({
        trade_id: tradeId,
        type,
        title,
        message,
        channel: effectiveChannel,
        sent: false
      }).returning('id');

      let sent = false;
      let errorMessage = null;

      // Send via Slack
      if ((effectiveChannel === 'slack' || effectiveChannel === 'both') && this.slackClient) {
        try {
          await this.sendSlack(type, title, message, tradeId);
          sent = true;
        } catch (error) {
          logger.error('Slack notification failed:', error);
          errorMessage = error.message;
        }
      }

      // Send via Email
      if ((effectiveChannel === 'email' || effectiveChannel === 'both') && this.emailTransporter) {
        try {
          await this.sendEmail(type, title, message, tradeId);
          sent = true;
        } catch (error) {
          logger.error('Email notification failed:', error);
          errorMessage = errorMessage ? `${errorMessage}; ${error.message}` : error.message;
        }
      }

      // Update notification record
      await db('notifications')
        .where('id', notificationId)
        .update({
          sent,
          sent_at: sent ? db.fn.now() : null,
          error_message: errorMessage
        });

      if (sent) {
        logger.info(`Notification sent: ${title}`);
      } else if (!this.slackClient && !this.emailTransporter) {
        logger.debug(`Notification logged (no channels configured): ${title}`);
      }

    } catch (error) {
      logger.error('Failed to send notification:', error);
    }
  }

  /**
   * Send Slack notification
   */
  async sendSlack(type, title, message, tradeId) {
    if (!this.slackClient) return;

    const channelId = process.env.SLACK_CHANNEL_ID;
    if (!channelId) {
      logger.warn('SLACK_CHANNEL_ID not configured');
      return;
    }

    // Build message blocks
    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: title,
          emoji: true
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: message.replace(/\n/g, '\n')
        }
      }
    ];

    // Add context
    const contextElements = [
      {
        type: 'mrkdwn',
        text: `*Type:* ${type}`
      },
      {
        type: 'mrkdwn',
        text: `*Time:* ${new Date().toLocaleString()}`
      }
    ];

    if (tradeId) {
      contextElements.push({
        type: 'mrkdwn',
        text: `*Trade ID:* ${tradeId}`
      });
    }

    blocks.push({
      type: 'context',
      elements: contextElements
    });

    // Add divider
    blocks.push({ type: 'divider' });

    // Color based on type
    const colorMap = {
      trade: '#00C805',
      phase: '#0066FF',
      error: '#FF5000',
      system: '#6B7280'
    };

    await this.slackClient.chat.postMessage({
      channel: channelId,
      text: `${title}: ${message}`,
      blocks,
      attachments: [{
        color: colorMap[type] || '#6B7280'
      }]
    });
  }

  /**
   * Send Email notification
   */
  async sendEmail(type, title, message, tradeId) {
    if (!this.emailTransporter) return;

    const to = process.env.EMAIL_TO;
    if (!to) {
      logger.warn('EMAIL_TO not configured');
      return;
    }

    // Build HTML email
    const colorMap = {
      trade: '#00C805',
      phase: '#0066FF',
      error: '#FF5000',
      system: '#6B7280'
    };

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: ${colorMap[type] || '#6B7280'}; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .content { background: #f9f9f9; padding: 20px; border-radius: 0 0 8px 8px; }
            .message { white-space: pre-wrap; line-height: 1.6; }
            .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2 style="margin: 0;">${title}</h2>
            </div>
            <div class="content">
              <div class="message">${message}</div>
              <div class="footer">
                <p>Type: ${type}${tradeId ? ` | Trade ID: ${tradeId}` : ''}</p>
                <p>RZE Trading Platform</p>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;

    await this.emailTransporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to,
      subject: `[RZE] ${title}`,
      text: `${title}\n\n${message}\n\nType: ${type}${tradeId ? ` | Trade ID: ${tradeId}` : ''}`,
      html
    });
  }

  /**
   * Send test notification
   */
  async sendTest(channel = 'both') {
    await this.send({
      type: 'system',
      title: '🧪 Test Notification',
      message: 'This is a test notification from RZE Trading Platform.\nIf you received this, notifications are working correctly!',
      channel
    });
    
    return { success: true, message: 'Test notification sent' };
  }
}

module.exports = new NotificationService();
