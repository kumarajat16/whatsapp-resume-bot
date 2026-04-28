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
  const r = await pool.query(
    `UPDATE referral_attributions
     SET converted_at = NOW(), resume_request_id = $2
     WHERE phone_number = $1 AND converted_at IS NULL
     RETURNING referral_id`,
    [phoneNumber, resumeRequestId]
  );
  if (!r.rows[0]) return null;
  const referralId = r.rows[0].referral_id;
  try {
    await pool.query(
      `INSERT INTO referral_transactions (referral_id, resume_transaction_id) VALUES ($1, $2)
       ON CONFLICT (resume_transaction_id) DO NOTHING`,
      [referralId, resumeRequestId]
    );
  } catch (err) {
    console.error('[REFERRAL] insert txn error:', err);
  }
  return { referral_id: referralId };
}

module.exports = {
  init,
  findOrCreateReferralUser,
  getReferralStats,
  recordReferralTransaction,
  validateReferralId,
  attributeReferral,
  recordConversion,
};
