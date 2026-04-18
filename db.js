const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('WARNING: DATABASE_URL environment variable is not set. Database operations will fail.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function initDb() {
  // Check if old schema exists (section-based resume_data) and migrate
  const oldSchema = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'resume_data' AND column_name = 'section_name'
  `);
  if (oldSchema.rows.length > 0) {
    console.log('Migrating from old schema...');
    await pool.query('DROP TABLE IF EXISTS payments CASCADE');
    await pool.query('DROP TABLE IF EXISTS conversation_messages CASCADE');
    await pool.query('DROP TABLE IF EXISTS resume_data CASCADE');
    await pool.query('DROP TABLE IF EXISTS resume_requests CASCADE');
    await pool.query('DROP TABLE IF EXISTS users CASCADE');
    console.log('Old tables dropped.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_number TEXT UNIQUE NOT NULL,
      daily_messages INT DEFAULT 0,
      daily_resumes INT DEFAULT 0,
      last_active_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS resume_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'awaiting_input',
      flow TEXT DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS resume_data (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      resume_request_id UUID UNIQUE REFERENCES resume_requests(id) ON DELETE CASCADE,
      name TEXT,
      headline TEXT,
      email TEXT,
      phone TEXT,
      location TEXT,
      summary TEXT,
      target_role TEXT,
      experience JSONB DEFAULT '[]',
      education JSONB DEFAULT '[]',
      skills JSONB DEFAULT '[]',
      projects JSONB DEFAULT '[]',
      leadership JSONB DEFAULT '[]',
      certifications JSONB DEFAULT '[]',
      achievements JSONB DEFAULT '[]',
      tools JSONB DEFAULT '[]',
      hobbies JSONB DEFAULT '[]',
      languages JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      resume_request_id UUID REFERENCES resume_requests(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      message_type TEXT DEFAULT 'conversation',
      message_text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      resume_request_id UUID REFERENCES resume_requests(id) ON DELETE CASCADE,
      razorpay_link_id TEXT,
      razorpay_payment_id TEXT,
      amount INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add new columns if they don't exist (for existing deployments)
  const addCol = async (col, type) => {
    try {
      await pool.query(`ALTER TABLE resume_data ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    } catch (_) { /* column already exists */ }
  };
  await addCol('headline', 'TEXT');
  await addCol('target_role', 'TEXT');
  await addCol('leadership', "JSONB DEFAULT '[]'");
  await addCol('languages', "JSONB DEFAULT '[]'");

  // Create payments table for existing deployments
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      resume_request_id UUID REFERENCES resume_requests(id) ON DELETE CASCADE,
      razorpay_link_id TEXT,
      razorpay_payment_id TEXT,
      amount INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Ad tracking table: maps short IDs to fbclid values
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_tracking (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT UNIQUE NOT NULL,
      fbclid TEXT,
      phone_number TEXT,
      source TEXT DEFAULT 'meta_ads',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add ad tracking columns to users table
  const addUserCol = async (col, type) => {
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    } catch (_) { /* column already exists */ }
  };
  await addUserCol('ad_short_id', 'TEXT');
  await addUserCol('fbclid', 'TEXT');
  await addUserCol('ad_source', 'TEXT');

  // Add resume URL columns to resume_requests
  const addReqCol = async (col, type) => {
    try {
      await pool.query(`ALTER TABLE resume_requests ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    } catch (_) { /* column already exists */ }
  };
  await addReqCol('pdf_url', 'TEXT');
  await addReqCol('docx_url', 'TEXT');
  await addReqCol('resume_file_summary', 'TEXT');
  await addReqCol('resume_file_full_text', 'TEXT');
}

// ─── User helpers ──────────────────────────────────────────────────────────

async function findOrCreateUser(phoneNumber) {
  const result = await pool.query(
    `INSERT INTO users (phone_number) VALUES ($1)
     ON CONFLICT (phone_number) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [phoneNumber]
  );
  return result.rows[0];
}

async function resetDailyLimitsIfNeeded(userId) {
  await pool.query(
    `UPDATE users SET daily_messages = 0, daily_resumes = 0, last_active_date = CURRENT_DATE, updated_at = NOW()
     WHERE id = $1 AND last_active_date < CURRENT_DATE`,
    [userId]
  );
}

async function incrementMessageCount(userId) {
  await pool.query(
    'UPDATE users SET daily_messages = daily_messages + 1, updated_at = NOW() WHERE id = $1',
    [userId]
  );
}

async function incrementResumeCount(userId) {
  await pool.query(
    'UPDATE users SET daily_resumes = daily_resumes + 1, updated_at = NOW() WHERE id = $1',
    [userId]
  );
}

async function getUserLimits(userId) {
  const result = await pool.query(
    'SELECT daily_messages, daily_resumes FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || { daily_messages: 0, daily_resumes: 0 };
}

// ─── Resume request helpers ────────────────────────────────────────────────

async function getActiveResumeRequest(userId) {
  const result = await pool.query(
    `SELECT * FROM resume_requests
     WHERE user_id = $1 AND status NOT IN ('completed', 'resume_generated', 'abandoned', 'terminated')
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function createResumeRequest(userId, flow) {
  await pool.query(
    `UPDATE resume_requests SET status = 'abandoned', updated_at = NOW()
     WHERE user_id = $1 AND status NOT IN ('completed', 'resume_generated', 'abandoned', 'terminated')`,
    [userId]
  );
  const result = await pool.query(
    'INSERT INTO resume_requests (user_id, flow) VALUES ($1, $2) RETURNING *',
    [userId, flow || null]
  );
  return result.rows[0];
}

async function updateResumeRequestStatus(requestId, status) {
  await pool.query(
    'UPDATE resume_requests SET status = $1, updated_at = NOW() WHERE id = $2',
    [status, requestId]
  );
}

async function updateResumeRequestFlow(requestId, flow) {
  await pool.query(
    'UPDATE resume_requests SET flow = $1, updated_at = NOW() WHERE id = $2',
    [flow, requestId]
  );
}

// ─── Resume data helpers ───────────────────────────────────────────────────

async function getResumeData(resumeRequestId) {
  const result = await pool.query(
    'SELECT * FROM resume_data WHERE resume_request_id = $1',
    [resumeRequestId]
  );
  return result.rows[0] || null;
}

async function saveResumeData(resumeRequestId, data) {
  await pool.query(
    `INSERT INTO resume_data (resume_request_id, name, headline, email, phone, location, summary, target_role, experience, education, skills, projects, leadership, certifications, achievements, tools, hobbies, languages)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (resume_request_id)
     DO UPDATE SET
       name = COALESCE(NULLIF($2, ''), resume_data.name),
       headline = COALESCE(NULLIF($3, ''), resume_data.headline),
       email = COALESCE(NULLIF($4, ''), resume_data.email),
       phone = COALESCE(NULLIF($5, ''), resume_data.phone),
       location = COALESCE(NULLIF($6, ''), resume_data.location),
       summary = COALESCE(NULLIF($7, ''), resume_data.summary),
       target_role = COALESCE(NULLIF($8, ''), resume_data.target_role),
       experience = CASE WHEN $9::jsonb = '[]'::jsonb THEN resume_data.experience ELSE $9::jsonb END,
       education = CASE WHEN $10::jsonb = '[]'::jsonb THEN resume_data.education ELSE $10::jsonb END,
       skills = CASE WHEN $11::jsonb = '[]'::jsonb THEN resume_data.skills ELSE $11::jsonb END,
       projects = CASE WHEN $12::jsonb = '[]'::jsonb THEN resume_data.projects ELSE $12::jsonb END,
       leadership = CASE WHEN $13::jsonb = '[]'::jsonb THEN resume_data.leadership ELSE $13::jsonb END,
       certifications = CASE WHEN $14::jsonb = '[]'::jsonb THEN resume_data.certifications ELSE $14::jsonb END,
       achievements = CASE WHEN $15::jsonb = '[]'::jsonb THEN resume_data.achievements ELSE $15::jsonb END,
       tools = CASE WHEN $16::jsonb = '[]'::jsonb THEN resume_data.tools ELSE $16::jsonb END,
       hobbies = CASE WHEN $17::jsonb = '[]'::jsonb THEN resume_data.hobbies ELSE $17::jsonb END,
       languages = CASE WHEN $18::jsonb = '[]'::jsonb THEN resume_data.languages ELSE $18::jsonb END,
       updated_at = NOW()`,
    [
      resumeRequestId,
      data.name || '',
      data.headline || '',
      data.email || '',
      data.phone || '',
      data.location || '',
      data.summary || '',
      data.target_role || '',
      JSON.stringify(data.experience || []),
      JSON.stringify(data.education || []),
      JSON.stringify(data.skills || []),
      JSON.stringify(data.projects || []),
      JSON.stringify(data.leadership || []),
      JSON.stringify(data.certifications || []),
      JSON.stringify(data.achievements || []),
      JSON.stringify(data.tools || []),
      JSON.stringify(data.hobbies || []),
      JSON.stringify(data.languages || []),
    ]
  );
}

// ─── Message helpers ───────────────────────────────────────────────────────

async function addMessage(resumeRequestId, direction, text, messageType) {
  await pool.query(
    'INSERT INTO messages (resume_request_id, direction, message_type, message_text) VALUES ($1, $2, $3, $4)',
    [resumeRequestId, direction, messageType || 'conversation', text]
  );
}

async function tagLastIncomingMessage(phoneNumber, messageType) {
  await pool.query(
    `UPDATE messages SET message_type = $1
     WHERE id = (
       SELECT m.id FROM messages m
       JOIN resume_requests rr ON m.resume_request_id = rr.id
       JOIN users u ON rr.user_id = u.id
       WHERE u.phone_number = $2 AND m.direction = 'incoming'
       ORDER BY m.created_at DESC LIMIT 1
     )`,
    [messageType, phoneNumber]
  );
}

async function getConversationMessages(resumeRequestId) {
  const result = await pool.query(
    `SELECT direction, message_text FROM messages
     WHERE resume_request_id = $1 AND message_type = 'conversation'
     ORDER BY created_at ASC`,
    [resumeRequestId]
  );
  return result.rows.map(r => ({
    role: r.direction === 'incoming' ? 'user' : 'assistant',
    content: r.message_text,
  }));
}

// ─── Payment helpers ──────────────────────────────────────────────────────

async function createPayment(resumeRequestId, razorpayLinkId, amount) {
  const result = await pool.query(
    'INSERT INTO payments (resume_request_id, razorpay_link_id, amount) VALUES ($1, $2, $3) RETURNING *',
    [resumeRequestId, razorpayLinkId, amount]
  );
  return result.rows[0];
}

async function updatePaymentByLinkId(linkId, paymentId, status) {
  await pool.query(
    'UPDATE payments SET razorpay_payment_id = $1, status = $2, updated_at = NOW() WHERE razorpay_link_id = $3',
    [paymentId, status, linkId]
  );
}

async function getPaymentByResumeRequest(resumeRequestId) {
  const result = await pool.query(
    'SELECT * FROM payments WHERE resume_request_id = $1 ORDER BY created_at DESC LIMIT 1',
    [resumeRequestId]
  );
  return result.rows[0] || null;
}

// ─── Resume URL helpers ──────────────────────────────────────────────────

async function saveResumeUrls(resumeRequestId, pdfUrl, docxUrl) {
  await pool.query(
    'UPDATE resume_requests SET pdf_url = $1, docx_url = $2, updated_at = NOW() WHERE id = $3',
    [pdfUrl, docxUrl, resumeRequestId]
  );
}

// ─── Resume file summary helpers ─────────────────────────────────────────

async function saveResumeSummary(resumeRequestId, summary) {
  await pool.query(
    `UPDATE resume_requests
     SET resume_file_summary = CASE
       WHEN resume_file_summary IS NOT NULL AND resume_file_summary != ''
       THEN resume_file_summary || E'\n\n---\n\n' || $1
       ELSE $1
     END, updated_at = NOW()
     WHERE id = $2`,
    [summary, resumeRequestId]
  );
}

async function getResumeSummary(resumeRequestId) {
  const result = await pool.query(
    'SELECT resume_file_summary FROM resume_requests WHERE id = $1',
    [resumeRequestId]
  );
  return result.rows[0]?.resume_file_summary || '';
}

// ─── Resume file full text helpers ───────────────────────────────────────

async function saveResumeFullText(resumeRequestId, fullText) {
  await pool.query(
    `UPDATE resume_requests
     SET resume_file_full_text = CASE
       WHEN resume_file_full_text IS NOT NULL AND resume_file_full_text != ''
       THEN resume_file_full_text || E'\n\n---\n\n' || $1
       ELSE $1
     END, updated_at = NOW()
     WHERE id = $2`,
    [fullText, resumeRequestId]
  );
}

async function getResumeFullText(resumeRequestId) {
  const result = await pool.query(
    'SELECT resume_file_full_text FROM resume_requests WHERE id = $1',
    [resumeRequestId]
  );
  return result.rows[0]?.resume_file_full_text || '';
}

// ─── Ad tracking helpers ──────────────────────────────────────────────────

async function createAdTracking(shortId, fbclid) {
  await pool.query(
    'INSERT INTO ad_tracking (short_id, fbclid) VALUES ($1, $2) ON CONFLICT (short_id) DO NOTHING',
    [shortId, fbclid || null]
  );
}

async function getAdTracking(shortId) {
  const result = await pool.query(
    'SELECT * FROM ad_tracking WHERE short_id = $1',
    [shortId]
  );
  return result.rows[0] || null;
}

async function attachAdTrackingToUser(phoneNumber, shortId, fbclid) {
  await pool.query(
    `UPDATE users SET ad_short_id = $1, fbclid = $2, ad_source = 'meta_ads', updated_at = NOW()
     WHERE phone_number = $3`,
    [shortId, fbclid || null, phoneNumber]
  );
  // Also update the ad_tracking record with the phone number
  await pool.query(
    'UPDATE ad_tracking SET phone_number = $1 WHERE short_id = $2',
    [phoneNumber, shortId]
  );
}

async function getUserAdTracking(phoneNumber) {
  const result = await pool.query(
    'SELECT ad_short_id, fbclid, ad_source FROM users WHERE phone_number = $1',
    [phoneNumber]
  );
  return result.rows[0] || null;
}

module.exports = {
  pool,
  initDb,
  findOrCreateUser,
  resetDailyLimitsIfNeeded,
  incrementMessageCount,
  incrementResumeCount,
  getUserLimits,
  getActiveResumeRequest,
  createResumeRequest,
  updateResumeRequestStatus,
  updateResumeRequestFlow,
  getResumeData,
  saveResumeData,
  addMessage,
  tagLastIncomingMessage,
  getConversationMessages,
  createPayment,
  updatePaymentByLinkId,
  getPaymentByResumeRequest,
  saveResumeUrls,
  saveResumeSummary,
  getResumeSummary,
  saveResumeFullText,
  getResumeFullText,
  createAdTracking,
  getAdTracking,
  attachAdTrackingToUser,
  getUserAdTracking,
};
