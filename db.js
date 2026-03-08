const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_number TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS resume_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS resume_data (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      resume_request_id UUID REFERENCES resume_requests(id) ON DELETE CASCADE,
      section_name TEXT NOT NULL,
      section_data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      resume_request_id UUID REFERENCES resume_requests(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      message_text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_resume_data_section
      ON resume_data(resume_request_id, section_name);
  `);
}

async function findOrCreateUser(phoneNumber) {
  const result = await pool.query(
    `INSERT INTO users (phone_number) VALUES ($1)
     ON CONFLICT (phone_number) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [phoneNumber]
  );
  return result.rows[0];
}

async function getActiveResumeRequest(userId) {
  const result = await pool.query(
    "SELECT * FROM resume_requests WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    [userId]
  );
  return result.rows[0] || null;
}

async function createResumeRequest(userId) {
  await pool.query(
    "UPDATE resume_requests SET status = 'abandoned', updated_at = NOW() WHERE user_id = $1 AND status = 'active'",
    [userId]
  );
  const result = await pool.query(
    'INSERT INTO resume_requests (user_id) VALUES ($1) RETURNING *',
    [userId]
  );
  return result.rows[0];
}

async function updateResumeRequestStatus(requestId, status) {
  await pool.query(
    'UPDATE resume_requests SET status = $1, updated_at = NOW() WHERE id = $2',
    [status, requestId]
  );
}

async function upsertResumeSection(resumeRequestId, sectionName, sectionData) {
  await pool.query(
    `INSERT INTO resume_data (resume_request_id, section_name, section_data)
     VALUES ($1, $2, $3)
     ON CONFLICT (resume_request_id, section_name)
     DO UPDATE SET section_data = $3, updated_at = NOW()`,
    [resumeRequestId, sectionName, JSON.stringify(sectionData)]
  );
}

async function getResumeData(resumeRequestId) {
  const result = await pool.query(
    'SELECT section_name, section_data FROM resume_data WHERE resume_request_id = $1',
    [resumeRequestId]
  );
  const data = {};
  for (const row of result.rows) {
    data[row.section_name] = row.section_data;
  }
  return data;
}

async function saveFullResumeData(resumeRequestId, parsed) {
  const sections = [
    'name', 'location', 'summary', 'experience', 'education',
    'skills', 'projects', 'certifications', 'achievements', 'tools', 'hobbies',
  ];
  for (const key of sections) {
    const val = parsed[key];
    if (val === undefined || val === null || val === '') continue;
    if (Array.isArray(val) && val.length === 0) continue;
    await upsertResumeSection(resumeRequestId, key, val);
  }
}

async function addMessage(resumeRequestId, role, text) {
  await pool.query(
    'INSERT INTO conversation_messages (resume_request_id, role, message_text) VALUES ($1, $2, $3)',
    [resumeRequestId, role, text]
  );
}

async function getMessages(resumeRequestId) {
  const result = await pool.query(
    'SELECT role, message_text FROM conversation_messages WHERE resume_request_id = $1 ORDER BY created_at ASC',
    [resumeRequestId]
  );
  return result.rows.map(r => ({ role: r.role, content: r.message_text }));
}

module.exports = {
  pool,
  initDb,
  findOrCreateUser,
  getActiveResumeRequest,
  createResumeRequest,
  updateResumeRequestStatus,
  upsertResumeSection,
  getResumeData,
  saveFullResumeData,
  addMessage,
  getMessages,
};
