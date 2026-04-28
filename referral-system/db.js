const { generateReferralId } = require('./utils');

async function init(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_users (
      id SERIAL PRIMARY KEY,
      phone_number VARCHAR(20) UNIQUE NOT NULL,
      name VARCHAR(255),
      referral_id VARCHAR(20) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_transactions (
      id SERIAL PRIMARY KEY,
      referral_id VARCHAR(20) NOT NULL,
      resume_transaction_id VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_referral_txn_referral_id ON referral_transactions(referral_id)`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_txn_resume
    ON referral_transactions(resume_transaction_id)
    WHERE resume_transaction_id IS NOT NULL
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_attributions (
      phone_number VARCHAR(20) PRIMARY KEY,
      referral_id VARCHAR(20) NOT NULL,
      attributed_at TIMESTAMPTZ DEFAULT NOW(),
      resume_request_id VARCHAR(64),
      converted_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_referral_attr_referral_id ON referral_attributions(referral_id)`);

  // Speed up the JOIN-through-payments queries used by /admin/referrals.
  // referral_attributions.phone_number is already PK (indexed). users.phone_number
  // is UNIQUE (indexed). We just need an index on payments.status to avoid a
  // full table scan when filtering for paid rows.
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)`);
  } catch (err) {
    // payments table may not exist yet on a fresh deploy — main db.initDb() creates it.
    // Safe to ignore; the index will be created on next boot.
  }
}

async function findOrCreateReferralUser(pool, phone, name) {
  const existing = await pool.query('SELECT * FROM referral_users WHERE phone_number = $1', [phone]);
  if (existing.rows[0]) return existing.rows[0];

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidateId = generateReferralId();
    try {
      const result = await pool.query(
        `INSERT INTO referral_users (phone_number, name, referral_id)
         VALUES ($1, $2, $3) RETURNING *`,
        [phone, name, candidateId]
      );
      return result.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        const refetch = await pool.query('SELECT * FROM referral_users WHERE phone_number = $1', [phone]);
        if (refetch.rows[0]) return refetch.rows[0];
        continue;
      }
      throw err;
    }
  }
  throw new Error('Could not allocate a unique referral_id after 5 attempts');
}

async function getReferralStats(pool, phone) {
  const userRes = await pool.query('SELECT * FROM referral_users WHERE phone_number = $1', [phone]);
  if (!userRes.rows[0]) return null;
  const user = userRes.rows[0];
  const countRes = await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM referral_transactions WHERE referral_id = $1',
    [user.referral_id]
  );
  return {
    referral_id: user.referral_id,
    name: user.name,
    phone_number: user.phone_number,
    count: countRes.rows[0].cnt,
  };
}

async function recordReferralTransaction(pool, referralId, resumeTxnId) {
  await pool.query(
    `INSERT INTO referral_transactions (referral_id, resume_transaction_id)
     VALUES ($1, $2)`,
    [referralId, resumeTxnId]
  );
}

async function validateReferralId(pool, referralId) {
  const r = await pool.query('SELECT 1 FROM referral_users WHERE referral_id = $1', [referralId]);
  return !!r.rows[0];
}

async function attributeReferral(pool, phoneNumber, referralId) {
  const ok = await pool.query('SELECT 1 FROM referral_users WHERE referral_id = $1', [referralId]);
  if (!ok.rows[0]) return false;
  await pool.query(
    `INSERT INTO referral_attributions (phone_number, referral_id) VALUES ($1, $2)
     ON CONFLICT (phone_number) DO NOTHING`,
    [phoneNumber, referralId]
  );
  return true;
}

async function recordConversion(pool, phoneNumber, resumeRequestId) {
  // Look up the FIRST referral attached to this phone. ON CONFLICT DO NOTHING
  // in attributeReferral ensures this never changes once set, so every future
  // payment by this user credits the original referrer.
  const lookup = await pool.query(
    'SELECT referral_id FROM referral_attributions WHERE phone_number = $1',
    [phoneNumber]
  );
  if (!lookup.rows[0]) return null;
  const referralId = lookup.rows[0].referral_id;

  // Stamp the first-conversion timestamp once (idempotent).
  await pool.query(
    `UPDATE referral_attributions
     SET converted_at = NOW(), resume_request_id = $2
     WHERE phone_number = $1 AND converted_at IS NULL`,
    [phoneNumber, resumeRequestId]
  );

  // Credit the referrer for THIS payment. Unique constraint on
  // resume_transaction_id makes Razorpay double-fires safe.
  try {
    const ins = await pool.query(
      `INSERT INTO referral_transactions (referral_id, resume_transaction_id)
       VALUES ($1, $2)
       ON CONFLICT (resume_transaction_id) DO NOTHING
       RETURNING id`,
      [referralId, resumeRequestId]
    );
    return { referral_id: referralId, credited: ins.rowCount > 0 };
  } catch (err) {
    console.error('[REFERRAL] insert txn error:', err);
    return { referral_id: referralId, credited: false };
  }
}

// ─── Admin queries ──────────────────────────────────────────────────────────

async function listReferralUsersForAdmin(pool, opts) {
  const search = (opts && opts.search ? String(opts.search).trim() : '');
  const sortBy = (opts && opts.sortBy) || 'created_at';
  const sortDir = (opts && opts.sortDir) === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(parseInt((opts && opts.limit) || 50, 10) || 50, 1), 200);
  const offset = Math.max(parseInt((opts && opts.offset) || 0, 10) || 0, 0);

  const allowedSort = {
    created_at: 'ru.created_at',
    tagged: 'tagged_count',
    txns: 'txn_count',
    phone: 'ru.phone_number',
  };
  const sortCol = allowedSort[sortBy] || allowedSort.created_at;

  const params = [];
  let where = '';
  if (search) {
    params.push('%' + search + '%');
    where = 'WHERE ru.phone_number ILIKE $' + params.length + ' OR ru.referral_id ILIKE $' + params.length + ' OR ru.name ILIKE $' + params.length;
  }

  // Count total rows for pagination (uses the same WHERE)
  const countSql =
    'SELECT COUNT(*)::int AS total FROM referral_users ru ' + where;
  const countRes = await pool.query(countSql, params);
  const total = countRes.rows[0].total;

  // tagged_count = distinct users in referral_attributions for this referral_id
  // txn_count    = COUNT successful payments (status='paid') for users tagged
  //                under this referral_id, joining referral_attributions →
  //                users → resume_requests → payments.
  params.push(limit);
  params.push(offset);
  const limitParamIdx = params.length - 1;
  const offsetParamIdx = params.length;

  const sql =
    'SELECT ' +
    '  ru.id, ru.phone_number, ru.name, ru.referral_id, ru.created_at, ' +
    '  COALESCE(tagged.cnt, 0)::int AS tagged_count, ' +
    '  COALESCE(txns.cnt, 0)::int AS txn_count ' +
    'FROM referral_users ru ' +
    'LEFT JOIN ( ' +
    '  SELECT referral_id, COUNT(DISTINCT phone_number) AS cnt ' +
    '  FROM referral_attributions GROUP BY referral_id ' +
    ') tagged ON tagged.referral_id = ru.referral_id ' +
    'LEFT JOIN ( ' +
    '  SELECT ra.referral_id, COUNT(*) AS cnt ' +
    '  FROM referral_attributions ra ' +
    '  JOIN users u ON u.phone_number = ra.phone_number ' +
    '  JOIN resume_requests rr ON rr.user_id = u.id ' +
    '  JOIN payments p ON p.resume_request_id = rr.id ' +
    '  WHERE p.status = \'paid\' ' +
    '  GROUP BY ra.referral_id ' +
    ') txns ON txns.referral_id = ru.referral_id ' +
    where + ' ' +
    'ORDER BY ' + sortCol + ' ' + sortDir + ' NULLS LAST ' +
    'LIMIT $' + limitParamIdx + ' OFFSET $' + offsetParamIdx;

  const res = await pool.query(sql, params);
  return { rows: res.rows, total, limit, offset };
}

async function getTaggedUsersForAdmin(pool, referralId) {
  const sql =
    'SELECT ' +
    '  ra.phone_number, ' +
    '  ra.attributed_at, ' +
    '  COALESCE(SUM(CASE WHEN p.status = \'paid\' THEN 1 ELSE 0 END), 0)::int AS paid_count ' +
    'FROM referral_attributions ra ' +
    'LEFT JOIN users u ON u.phone_number = ra.phone_number ' +
    'LEFT JOIN resume_requests rr ON rr.user_id = u.id ' +
    'LEFT JOIN payments p ON p.resume_request_id = rr.id ' +
    'WHERE ra.referral_id = $1 ' +
    'GROUP BY ra.phone_number, ra.attributed_at ' +
    'ORDER BY ra.attributed_at DESC';
  const r = await pool.query(sql, [referralId]);
  return r.rows;
}

async function getTransactionsForAdmin(pool, referralId) {
  const sql =
    'SELECT ' +
    '  ra.phone_number, ' +
    '  COUNT(p.id)::int AS payment_count ' +
    'FROM referral_attributions ra ' +
    'JOIN users u ON u.phone_number = ra.phone_number ' +
    'JOIN resume_requests rr ON rr.user_id = u.id ' +
    'JOIN payments p ON p.resume_request_id = rr.id ' +
    'WHERE ra.referral_id = $1 AND p.status = \'paid\' ' +
    'GROUP BY ra.phone_number ' +
    'ORDER BY payment_count DESC, ra.phone_number ASC';
  const r = await pool.query(sql, [referralId]);
  return r.rows;
}

module.exports = {
  init,
  findOrCreateReferralUser,
  getReferralStats,
  recordReferralTransaction,
  validateReferralId,
  attributeReferral,
  recordConversion,
  listReferralUsersForAdmin,
  getTaggedUsersForAdmin,
  getTransactionsForAdmin,
};
