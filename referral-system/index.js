// Isolated referral program — mounts at /referral on the main Express app.
// Owns its own tables (referral_users, referral_transactions). Does not touch
// existing tables, routes, or flows. Single integration point: mount(app, db).

const express = require('express');
const refDb = require('./db');
const utils = require('./utils');
const { LANDING_HTML, DASHBOARD_HTML } = require('./templates');

function buildReferralLink(req, referralId) {
  const base = (process.env.BASE_URL && process.env.BASE_URL.trim()) ||
    (req.protocol + '://' + req.get('host'));
  return base.replace(/\/$/, '') + '/start?ref=' + referralId;
}

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length !== 10) return null;
  return '+91' + digits;
}

function mount(app, dbModule) {
  const pool = dbModule.pool;
  const router = express.Router();

  // Initialize tables on boot (idempotent)
  refDb.init(pool)
    .then(() => console.log('[REFERRAL] Tables ready'))
    .catch(err => console.error('[REFERRAL] Table init error:', err));

  // Body parsing scoped to this router only — does not affect existing routes
  router.use(express.json({ limit: '64kb' }));

  router.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(LANDING_HTML);
  });

  router.get('/dashboard', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.send(DASHBOARD_HTML);
  });

  router.post('/api/login', async (req, res) => {
    try {
      const { name, phone_number } = req.body || {};
      const fullPhone = normalizePhone(phone_number);
      if (!fullPhone) {
        return res.status(400).json({ error: 'Phone number must be 10 digits' });
      }
      const cleanedName = String(name || '').trim().slice(0, 80);
      if (!cleanedName) {
        return res.status(400).json({ error: 'Name is required' });
      }
      const user = await refDb.findOrCreateReferralUser(pool, fullPhone, cleanedName);
      res.json({
        referral_id: user.referral_id,
        phone_number: user.phone_number,
        name: user.name,
        referral_link: buildReferralLink(req, user.referral_id),
      });
    } catch (err) {
      console.error('[REFERRAL] /api/login error:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  router.post('/api/stats', async (req, res) => {
    try {
      const { phone_number } = req.body || {};
      const fullPhone = normalizePhone(phone_number) ||
        (typeof phone_number === 'string' && phone_number.startsWith('+') ? phone_number : null);
      if (!fullPhone) return res.status(400).json({ error: 'phone_number required' });

      const stats = await refDb.getReferralStats(pool, fullPhone);
      if (!stats) return res.status(404).json({ error: 'User not found' });

      const rewards = utils.computeRewards(stats.count);
      res.json({
        referral_id: stats.referral_id,
        name: stats.name,
        referral_count: rewards.count,
        amount_earned: rewards.earned,
        next_milestone: rewards.next,
        max_possible: rewards.max_possible,
        bumper_at: rewards.bumper_at,
        bumper_amount: rewards.bumper_amount,
        bumper_unlocked: rewards.bumper_unlocked,
        referral_link: buildReferralLink(req, stats.referral_id),
      });
    } catch (err) {
      console.error('[REFERRAL] /api/stats error:', err);
      res.status(500).json({ error: 'Stats failed' });
    }
  });

  app.use('/referral', router);
  console.log('[REFERRAL] Module mounted at /referral');
}

module.exports = { mount };
