/**
 * RZE Trading Platform - Template Routes
 * 
 * API endpoints for managing trade templates.
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const database = require('../../config/database');
const logger = require('../../utils/logger');

/**
 * GET /api/templates
 * Get all templates
 */
router.get('/', async (req, res) => {
  try {
    const db = database.getDb();
    
    const templates = await db('templates')
      .orderBy('is_default', 'desc')
      .orderBy('name');
    
    const formattedTemplates = templates.map(t => ({
      ...t,
      phases: typeof t.phases === 'string' ? JSON.parse(t.phases) : t.phases
    }));
    
    res.json(formattedTemplates);
    
  } catch (error) {
    logger.error('Error fetching templates:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/templates/active
 * Get the currently active template
 */
router.get('/active', async (req, res) => {
  try {
    const db = database.getDb();
    
    const template = await db('templates')
      .where('is_active', true)
      .first();
    
    if (!template) {
      return res.status(404).json({ error: 'No active template found' });
    }
    
    res.json({
      ...template,
      phases: typeof template.phases === 'string' ? JSON.parse(template.phases) : template.phases
    });
    
  } catch (error) {
    logger.error('Error fetching active template:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/templates/:id
 * Get template by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const db = database.getDb();
    const { id } = req.params;
    
    const template = await db('templates').where('id', id).first();
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json({
      ...template,
      phases: typeof template.phases === 'string' ? JSON.parse(template.phases) : template.phases
    });
    
  } catch (error) {
    logger.error('Error fetching template:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/templates
 * Create a new template
 */
router.post('/',
  [
    body('name').notEmpty().withMessage('Name is required'),
    body('phases').isArray({ min: 4, max: 4 }).withMessage('Must have exactly 4 phases'),
    body('phases.*.take_profit_pct').isFloat().withMessage('Take profit percentage required'),
    body('phases.*.stop_loss_pct').isFloat().withMessage('Stop loss percentage required'),
    body('phases.*.sell_pct').isFloat({ min: 0, max: 100 }).withMessage('Sell percentage must be 0-100')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const db = database.getDb();
      const { name, description, phases, is_active } = req.body;
      
      // Validate phases sum to 100%
      const totalSellPct = phases.reduce((sum, p) => sum + p.sell_pct, 0);
      if (Math.abs(totalSellPct - 100) > 0.01) {
        return res.status(400).json({ 
          error: `Sell percentages must sum to 100% (currently ${totalSellPct}%)` 
        });
      }
      
      // Add phase numbers if not present
      const formattedPhases = phases.map((p, idx) => ({
        phase: idx + 1,
        take_profit_pct: p.take_profit_pct,
        stop_loss_pct: p.stop_loss_pct,
        sell_pct: p.sell_pct
      }));
      
      // If setting as active, deactivate others
      if (is_active) {
        await db('templates').update({ is_active: false });
      }
      
      const [id] = await db('templates').insert({
        name,
        description: description || null,
        phases: JSON.stringify(formattedPhases),
        is_active: is_active || false,
        is_default: false
      }).returning('id');
      
      const template = await db('templates').where('id', id).first();
      
      logger.info(`Created template: ${name}`);
      
      res.status(201).json({
        ...template,
        phases: JSON.parse(template.phases)
      });
      
    } catch (error) {
      logger.error('Error creating template:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * PUT /api/templates/:id
 * Update a template
 */
router.put('/:id',
  [
    body('phases').optional().isArray({ min: 4, max: 4 })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const db = database.getDb();
      const { id } = req.params;
      const { name, description, phases } = req.body;
      
      const template = await db('templates').where('id', id).first();
      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }
      
      const updates = { updated_at: db.fn.now() };
      
      if (name) updates.name = name;
      if (description !== undefined) updates.description = description;
      
      if (phases) {
        // Validate phases sum to 100%
        const totalSellPct = phases.reduce((sum, p) => sum + p.sell_pct, 0);
        if (Math.abs(totalSellPct - 100) > 0.01) {
          return res.status(400).json({ 
            error: `Sell percentages must sum to 100% (currently ${totalSellPct}%)` 
          });
        }
        
        const formattedPhases = phases.map((p, idx) => ({
          phase: idx + 1,
          take_profit_pct: p.take_profit_pct,
          stop_loss_pct: p.stop_loss_pct,
          sell_pct: p.sell_pct
        }));
        
        updates.phases = JSON.stringify(formattedPhases);
      }
      
      await db('templates').where('id', id).update(updates);
      
      const updatedTemplate = await db('templates').where('id', id).first();
      
      logger.info(`Updated template: ${updatedTemplate.name}`);
      
      res.json({
        ...updatedTemplate,
        phases: JSON.parse(updatedTemplate.phases)
      });
      
    } catch (error) {
      logger.error('Error updating template:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/templates/:id/activate
 * Set a template as active
 */
router.post('/:id/activate', async (req, res) => {
  try {
    const db = database.getDb();
    const { id } = req.params;
    
    const template = await db('templates').where('id', id).first();
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Deactivate all templates
    await db('templates').update({ is_active: false });
    
    // Activate this one
    await db('templates').where('id', id).update({ 
      is_active: true,
      updated_at: db.fn.now()
    });
    
    logger.info(`Activated template: ${template.name}`);
    
    res.json({ 
      success: true, 
      message: `Template "${template.name}" is now active` 
    });
    
  } catch (error) {
    logger.error('Error activating template:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/templates/:id
 * Delete a template
 */
router.delete('/:id', async (req, res) => {
  try {
    const db = database.getDb();
    const { id } = req.params;
    
    const template = await db('templates').where('id', id).first();
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (template.is_default) {
      return res.status(400).json({ error: 'Cannot delete default templates' });
    }
    
    // Check if template is used by any active trades
    const activeTrades = await db('trades')
      .where('template_id', id)
      .whereIn('status', ['pending', 'active'])
      .count('* as count')
      .first();
    
    if (parseInt(activeTrades.count) > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete template that is in use by active trades' 
      });
    }
    
    await db('templates').where('id', id).delete();
    
    logger.info(`Deleted template: ${template.name}`);
    
    res.json({ success: true, message: 'Template deleted' });
    
  } catch (error) {
    logger.error('Error deleting template:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/templates/:id/duplicate
 * Duplicate a template
 */
router.post('/:id/duplicate', async (req, res) => {
  try {
    const db = database.getDb();
    const { id } = req.params;
    const { name } = req.body;
    
    const template = await db('templates').where('id', id).first();
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    const [newId] = await db('templates').insert({
      name: name || `${template.name} (Copy)`,
      description: template.description,
      phases: template.phases,
      is_active: false,
      is_default: false
    }).returning('id');
    
    const newTemplate = await db('templates').where('id', newId).first();
    
    logger.info(`Duplicated template: ${template.name} -> ${newTemplate.name}`);
    
    res.status(201).json({
      ...newTemplate,
      phases: JSON.parse(newTemplate.phases)
    });
    
  } catch (error) {
    logger.error('Error duplicating template:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
