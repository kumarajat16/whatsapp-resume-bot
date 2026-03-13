const express = require('express');
const { twiml: { MessagingResponse } } = require('twilio');
const Anthropic = require('@anthropic-ai/sdk').default;
const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, TabStopType } = require('docx');
const PDFDocument = require('pdfkit');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(express.urlencoded({ extended: false }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const twilio = require('twilio');
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─── Config ──────────────────────────────────────────────────────────────────

const DAILY_MESSAGE_LIMIT = 100;
const DAILY_RESUME_LIMIT = 5;
const PAYMENT_AMOUNT = 500; // ₹5 in paise (testing price)

const RAZORPAY_ENABLED = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
let razorpay = null;
if (RAZORPAY_ENABLED) {
  const Razorpay = require('razorpay');
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

// ─── Temp file store ─────────────────────────────────────────────────────────

const tempFiles = new Map();

function storeTempFile(filePath, filename) {
  const token = crypto.randomUUID();
  setTimeout(() => {
    tempFiles.delete(token);
    fs.unlink(filePath, () => {});
  }, 15 * 60 * 1000);
  tempFiles.set(token, { filePath, filename });
  return token;
}

// ─── Twilio helpers ──────────────────────────────────────────────────────────

async function sendWhatsApp(to, body) {
  const truncated = body.length > 1200 ? body.slice(0, 1197) + '...' : body;
  console.log('[OUT-ASYNC]', to, '|', truncated.slice(0, 120));
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
    body: truncated,
  });
}

function sendTwiml(res, text) {
  const resp = new MessagingResponse();
  const truncated = text.length > 1200 ? text.slice(0, 1197) + '...' : text;
  console.log('[OUT-TWIML]', truncated.slice(0, 120));
  resp.message(truncated);
  res.type('text/xml');
  res.send(resp.toString());
}

// ─── Progress messages (no AI cost) ──────────────────────────────────────────

const PROGRESS_MESSAGES = [
  'Scanning your resume...',
  'Understanding your work experience...',
  'Identifying your skills...',
  'Checking education details...',
  'Almost done reviewing your profile...',
];

async function sendProgressMessages(to, count) {
  for (let i = 0; i < Math.min(count, PROGRESS_MESSAGES.length); i++) {
    await new Promise(r => setTimeout(r, 3000));
    await sendWhatsApp(to, PROGRESS_MESSAGES[i]);
  }
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are ResumeWala, a WhatsApp resume-building assistant for Indian job seekers. You help users create professional, recruiter-ready resumes.

Your job: collect resume information through natural conversation.

Information to collect:
1. Full name
2. Phone / Email (optional)
3. Location (city)
4. Target job role (what jobs they are applying for)
5. Professional summary (you will help write this)
6. Education (degree, college, year)
7. Work experience (title, company, duration, key responsibilities with measurable impact)
8. Skills (technical and soft)
9. Projects (optional)
10. Leadership roles (optional)
11. Certifications (optional)
12. Achievements (optional)
13. Languages spoken (optional)

Rules:
- Be warm, encouraging, and concise. Messages must be SHORT and WhatsApp-friendly (under 1200 characters).
- Use plain text only. No markdown headers. You may use *asterisks* for bold on WhatsApp.
- Ask MAXIMUM 1-2 questions per message. If a question needs options, ask only 1 question.
- NEVER re-ask for information the user already provided. Before asking, mentally check what you already know.
- For experience bullets, coach users to include ACTION + IMPACT + METRIC. Example: "Led a team of 5 to build payment gateway, reducing checkout drop-offs by 30%"
- If user gives vague responsibilities like "handled operations", ask deeper: "Can you share a specific achievement or number from that role? For example, team size, revenue impact, or a project you led?"
- You MUST stay on topic. If the user tries to chat about non-resume topics, politely redirect: "Let's focus on your resume! [next question]"
- Do NOT answer general knowledge questions, jokes, or off-topic requests.
- Once you have the core info (name, education, experience, skills), say:
  "I have everything I need! Reply *YES* to generate your resume."
- When user says YES/yes/y, respond with exactly: GENERATE_RESUME
- Do not add any other text when responding with GENERATE_RESUME`;

const EXTRACT_PROMPT = `You are a resume data extractor. Given resume text, extract ALL information thoroughly. Return in this EXACT plain-text format. Do not use JSON. Do not add explanation.

Name: [full name]
Headline: [professional headline like "Product Manager | Growth & Analytics" - generate from their role/skills]
Email: [email if found]
Phone: [phone if found]
Location: [city]
Summary: [write a strong 2-3 sentence professional summary in third person, highlighting years of experience, domain expertise, and key achievements]

Education:
* [Degree], [Institution], [Year]

Experience:
## [Job Title] | [Company] | [Duration]
> [One line company/role context if inferrable]
* [Action verb] + [what was done] + [impact/result with metric if available]
* [Action verb] + [what was done] + [impact/result with metric if available]

Skills:
* [Skill]

Projects:
* [Project name or description with impact]

Leadership:
* [Leadership role or responsibility]

Certifications:
* [Certification]

Achievements:
* [Achievement with metric if available]

Tools:
* [Tool or technology]

Languages:
* [Language]

Rules:
- Use EXACTLY these section headers
- For Experience, use ## for each role header (Job Title | Company | Duration)
- Use > for optional company/role description under each role
- Use * for bullet points under each role
- Every bullet MUST start with a strong action verb (Led, Built, Developed, Optimized, Launched, Revamped, Managed, Created, Implemented, Drove, Spearheaded)
- Include metrics and numbers wherever found in the original text
- If the resume mentions leadership activities, volunteer work, or organizational roles, put them under Leadership
- Omit empty sections entirely
- Do NOT truncate or summarize - extract EVERYTHING from the resume
- No JSON, no markdown headers`;

const AI_UNDERSTANDING_PROMPT = `You are ResumeWala. Given parsed resume data, generate a warm personalized message showing you deeply understand this person's profile.

Rules:
- Address them by first name
- Highlight their strongest experience area with specific details
- Mention specific achievements or metrics from their resume
- Reference their education
- Note their key skills that make them stand out
- End with: "To make your resume even stronger, I just need a few more details."
- Use *asterisks* for WhatsApp bold on: company names, role titles, key metrics, institution names
- Keep it 4-6 sentences, warm and professional
- Do NOT use markdown headers (##) or bullet points
- Do NOT list out all their information - synthesize it into a natural narrative
- Write as if you're an experienced career advisor who is impressed by their profile`;

// ─── Welcome / Menu ──────────────────────────────────────────────────────────

const WELCOME_MSG =
  'Welcome to ResumeWala!\nBuild a professional resume in minutes.\n\nReply:\n1 - Improve existing resume (upload PDF/Word)\n2 - Create fresh resume\n\nType "menu" anytime to see this again.';

// ─── Structured text parser (enhanced) ───────────────────────────────────────

function parseStructuredText(raw) {
  const result = {
    name: '', headline: '', email: '', phone: '', location: '',
    summary: '', target_role: '',
    education: [], experience: [], skills: [],
    projects: [], leadership: [], certifications: [],
    achievements: [], tools: [], hobbies: [], languages: [],
  };

  const lines = raw.split('\n');
  let currentSection = null;
  let currentExpEntry = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Inline fields: Name: ..., Email: ..., etc.
    const inlineMatch = trimmed.match(/^(Name|Headline|Email|Phone|Location|City|Summary|Target Role):\s*(.+)$/i);
    if (inlineMatch) {
      let key = inlineMatch[1].toLowerCase().replace(/\s+/g, '_');
      if (key === 'city') key = 'location';
      result[key] = inlineMatch[2].trim();
      currentSection = key;
      currentExpEntry = null;
      continue;
    }

    // Section headers
    const sectionMatch = trimmed.match(/^(Education|Experience|Skills|Projects|Leadership|Certifications|Achievements|Tools|Hobbies|Languages):\s*$/i);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase();
      currentExpEntry = null;
      continue;
    }

    // Experience/Leadership role header: ## Title | Company | Duration
    if ((currentSection === 'experience' || currentSection === 'leadership') && trimmed.startsWith('##')) {
      const headerText = trimmed.replace(/^#+\s*/, '');
      const parts = headerText.split('|').map(s => s.trim());

      const entry = {
        title: parts[0] || '',
        company: parts[1] || '',
        duration: parts[2] || '',
        description: '',
        responsibilities: [],
      };

      if (currentSection === 'experience') {
        result.experience.push(entry);
        currentExpEntry = entry;
      } else {
        result.leadership.push(entry);
        currentExpEntry = entry;
      }
      continue;
    }

    // Company/role description: > text
    if (currentExpEntry && trimmed.startsWith('>')) {
      currentExpEntry.description = trimmed.replace(/^>\s*/, '').trim();
      continue;
    }

    // Bullet items
    if (currentSection && /^[*\-\u2022]/.test(trimmed)) {
      const val = trimmed.replace(/^[*\-\u2022]\s*/, '').trim();
      if (!val) continue;

      // If we're in experience/leadership and have a current entry, add as responsibility
      if ((currentSection === 'experience' || currentSection === 'leadership') && currentExpEntry) {
        currentExpEntry.responsibilities.push(val);
        continue;
      }

      // If in experience but no ## header yet, create an entry from the bullet
      if (currentSection === 'experience' && !currentExpEntry) {
        const parts = val.split(',').map(s => s.trim());
        result.experience.push({
          title: parts[0] || val,
          company: parts[1] || '',
          duration: parts[2] || '',
          description: '',
          responsibilities: parts.length > 3 ? [parts.slice(3).join(', ')] : [],
        });
        continue;
      }

      if (currentSection === 'education') {
        const parts = val.split(',').map(s => s.trim());
        result.education.push({
          degree: parts[0] || val,
          institution: parts[1] || '',
          year: parts[2] || '',
        });
      } else if (currentSection === 'leadership' && !currentExpEntry) {
        result.leadership.push(val);
      } else if (Array.isArray(result[currentSection])) {
        result[currentSection].push(val);
      }
    }
  }

  return result;
}

// ─── Missing field detection ─────────────────────────────────────────────────

function detectMissingFields(data) {
  const missing = [];

  if (!data.target_role) missing.push('target_role');
  if (!data.summary || data.summary.length < 20) missing.push('summary');
  if (!data.experience || data.experience.length === 0) missing.push('experience');
  if (!data.education || data.education.length === 0) missing.push('education');
  if (!data.skills || data.skills.length === 0) missing.push('skills');
  if (!data.certifications || data.certifications.length === 0) missing.push('certifications');
  if (!data.achievements || data.achievements.length === 0) missing.push('achievements');
  if (!data.projects || data.projects.length === 0) missing.push('projects');

  // Check if experience bullets are weak (no metrics)
  if (data.experience && data.experience.length > 0) {
    let hasMetrics = false;
    for (const exp of data.experience) {
      const resps = exp.responsibilities || [];
      for (const r of resps) {
        if (/\d+%|\d+x|\d+X|\d{2,}/.test(r)) {
          hasMetrics = true;
          break;
        }
      }
      if (hasMetrics) break;
    }
    if (!hasMetrics) missing.push('experience_metrics');
  }

  return missing;
}

function formatMissingFieldQuestions(missing) {
  const questions = [];

  if (missing.includes('target_role')) {
    questions.push(
      'What type of jobs are you targeting?\n\n' +
      '1. Product Management\n' +
      '2. Software Engineering\n' +
      '3. Data / Analytics\n' +
      '4. Marketing\n' +
      '5. Operations\n' +
      '6. Other (please specify)'
    );
  }

  if (missing.includes('experience_metrics')) {
    questions.push(
      'Your experience looks great! To make it stand out, can you share any specific numbers or achievements?\n\n' +
      'For example:\n' +
      '- Team size you managed\n' +
      '- Revenue or growth impact\n' +
      '- Users/customers affected\n' +
      '- Percentage improvements'
    );
  }

  if (missing.includes('certifications')) {
    questions.push('Do you have any certifications? (e.g., AWS, PMP, Google Analytics, etc.) Reply "none" if not.');
  }

  if (missing.includes('achievements')) {
    questions.push('Any key achievements or awards you want to highlight? (e.g., hackathon wins, top performer awards, publications)');
  }

  if (missing.includes('projects') && !missing.includes('experience')) {
    questions.push('Any notable projects you want to showcase on your resume?');
  }

  return questions;
}

// ─── AI Understanding message generator ──────────────────────────────────────

async function generateAIUnderstanding(data) {
  const dataStr =
    'Name: ' + (data.name || '') + '\n' +
    'Location: ' + (data.location || '') + '\n' +
    'Education: ' + JSON.stringify(data.education || []) + '\n' +
    'Experience: ' + JSON.stringify(data.experience || []) + '\n' +
    'Skills: ' + JSON.stringify(data.skills || []) + '\n' +
    'Projects: ' + JSON.stringify(data.projects || []) + '\n' +
    'Achievements: ' + JSON.stringify(data.achievements || []) + '\n' +
    'Leadership: ' + JSON.stringify(data.leadership || []) + '\n' +
    'Languages: ' + JSON.stringify(data.languages || []);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 500,
      system: AI_UNDERSTANDING_PROMPT,
      messages: [{ role: 'user', content: 'Generate an understanding message for this profile:\n\n' + dataStr }],
    });
    return response.content[0].text;
  } catch (err) {
    console.error('AI understanding generation failed:', err.message);
    const firstName = (data.name || '').split(' ')[0] || 'there';
    return `Hi ${firstName}, I've gone through your resume carefully. You have a solid profile! To make your resume even stronger, I just need a few more details.`;
  }
}

// ─── Redacted resume preview ─────────────────────────────────────────────────

function buildRedactedPreview(data) {
  let preview = '';

  // Name - show first name, redact rest
  const nameParts = (data.name || '').split(' ');
  const redactedName = nameParts.length > 1
    ? nameParts[0] + ' ****'
    : (nameParts[0] || '****');
  preview += '*' + redactedName + '*\n';

  if (data.headline) preview += data.headline + '\n';
  preview += '****@****.com | +91 ****\n';
  if (data.location) preview += data.location + '\n';
  preview += '\n';

  if (data.summary) {
    preview += '*SUMMARY*\n';
    preview += data.summary.slice(0, 100) + '****\n\n';
  }

  if (data.experience && data.experience.length > 0) {
    preview += '*EXPERIENCE*\n';
    for (const exp of data.experience) {
      if (typeof exp === 'object') {
        preview += (exp.title || '****') + ' | ' + (exp.company || '****') + '\n';
        const resps = Array.isArray(exp.responsibilities) ? exp.responsibilities : [];
        if (resps.length > 0) {
          preview += '\u2022 ' + String(resps[0]).slice(0, 60) + '****\n';
        }
        if (resps.length > 1) {
          preview += '\u2022 ****\n';
        }
      }
    }
    preview += '\n';
  }

  if (data.education && data.education.length > 0) {
    preview += '*EDUCATION*\n';
    for (const edu of data.education) {
      if (typeof edu === 'object') {
        preview += (edu.degree || '****') + ', ' + (edu.institution || '****') + '\n';
      }
    }
    preview += '\n';
  }

  if (data.skills && data.skills.length > 0) {
    preview += '*SKILLS*\n';
    const shown = data.skills.slice(0, 3).join(' | ');
    preview += shown;
    if (data.skills.length > 3) preview += ' | ****';
    preview += '\n';
  }

  return preview;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    service: 'ResumeWala.ai',
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
    DATABASE_URL: !!process.env.DATABASE_URL,
    RAZORPAY: RAZORPAY_ENABLED,
    BASE_URL: process.env.BASE_URL || 'NOT SET',
  });
});

app.get('/resume/:token', (req, res) => {
  const entry = tempFiles.get(req.params.token);
  if (!entry) return res.status(404).send('File not found or expired.');
  const filename = entry.filename || 'ResumeWala-Resume.docx';
  res.download(entry.filePath, filename, (err) => {
    if (err && !res.headersSent) res.status(500).send('Download error.');
  });
});

app.get('/payment-success', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Payment Successful - ResumeWala</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f8f0}
.card{background:white;padding:40px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1);text-align:center;max-width:400px}
h1{color:#1F3864;font-size:24px}p{color:#555;font-size:16px;line-height:1.5}</style></head>
<body><div class="card"><h1>Payment Successful!</h1>
<p>Your resume is being generated and will be sent to your WhatsApp shortly.</p>
<p style="margin-top:20px;color:#888;font-size:14px">You can close this page.</p></div></body></html>`);
});

// Razorpay webhook
if (RAZORPAY_ENABLED) {
  app.use('/razorpay-webhook', express.json());
  app.post('/razorpay-webhook', async (req, res) => {
    console.log('RAZORPAY WEBHOOK RECEIVED');
    console.log('Event:', req.body.event);
    console.log('Payload:', JSON.stringify(req.body));
    try {
      const event = req.body.event;
      let notes, paymentLinkId, paymentId;

      if (event === 'payment_link.paid') {
        const plEntity = req.body.payload?.payment_link?.entity || {};
        const pyEntity = req.body.payload?.payment?.entity || {};
        notes = plEntity.notes || pyEntity.notes || {};
        paymentLinkId = plEntity.id;
        paymentId = pyEntity.id;
      } else if (event === 'payment.captured') {
        const pyEntity = req.body.payload?.payment?.entity || {};
        notes = pyEntity.notes || {};
        paymentId = pyEntity.id;
        paymentLinkId = pyEntity.payment_link_id;
      } else {
        return res.json({ status: 'ok' });
      }

      const resumeRequestId = notes?.resume_request_id;
      const phone = notes?.phone;

      if (resumeRequestId && phone) {
        // Update payment record
        if (paymentLinkId) {
          await db.updatePaymentByLinkId(paymentLinkId, paymentId || '', 'paid').catch(console.error);
        }

        // Avoid double-processing
        const reqCheck = await db.pool.query('SELECT status FROM resume_requests WHERE id = $1', [resumeRequestId]);
        const currentStatus = reqCheck.rows[0]?.status;
        if (currentStatus === 'completed' || currentStatus === 'generating') {
          return res.json({ status: 'ok' });
        }

        await db.updateResumeRequestStatus(resumeRequestId, 'paid');
        console.log('Payment confirmed. Generating resume for:', phone);
        processFullResume(phone, resumeRequestId).catch(err => {
          console.error('Post-payment resume generation error:', err);
        });
      }

      res.json({ status: 'ok' });
    } catch (err) {
      console.error('Razorpay webhook error:', err);
      res.json({ status: 'ok' });
    }
  });
}

// ─── WhatsApp Webhook ────────────────────────────────────────────────────────

app.post('/whatsapp', async (req, res) => {
  try {
    const incomingMsg = (req.body.Body || '').trim();
    const from = req.body.From || 'unknown';
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const mediaUrl = req.body.MediaUrl0 || null;
    const mediaContentType = req.body.MediaContentType0 || '';

    console.log('[IN]', from, '|', numMedia > 0 ? `[MEDIA:${mediaContentType}]` : incomingMsg);

    const user = await db.findOrCreateUser(from);
    await db.resetDailyLimitsIfNeeded(user.id);

    // Rate limit check
    const limits = await db.getUserLimits(user.id);
    if (limits.daily_messages >= DAILY_MESSAGE_LIMIT) {
      sendTwiml(res, 'System usage limit reached. Please try again tomorrow.');
      return;
    }
    await db.incrementMessageCount(user.id);

    // Media upload — immediate ack + background processing
    if (numMedia > 0 && mediaUrl) {
      sendTwiml(res, 'Great! I received your resume. Let me read it carefully.');
      processMediaUpload(from, user.id, mediaUrl, mediaContentType).catch(err => {
        console.error('Media processing error:', err);
        sendWhatsApp(from, 'Could not process your file. Please try again or type "2" to create from scratch.').catch(console.error);
      });
      return;
    }

    // Text message
    try {
      const reply = await handleMessage(from, user, incomingMsg);
      sendTwiml(res, reply);
    } catch (err) {
      console.error('Error handling message:', err);
      sendTwiml(res, 'Something went wrong. Please try again.');
    }
  } catch (err) {
    console.error('WHATSAPP HANDLER CRASH:', err);
    try {
      sendTwiml(res, 'Something went wrong. Please try again.');
    } catch (_) {
      if (!res.headersSent) res.status(200).type('text/xml').send('<Response></Response>');
    }
  }
});

// ─── Message handler (state machine) ─────────────────────────────────────────

async function handleMessage(from, user, incomingMsg) {
  const lower = incomingMsg.toLowerCase().trim();

  // Menu / restart
  if (lower === 'menu' || lower === 'restart' || lower === '0') {
    const active = await db.getActiveResumeRequest(user.id);
    if (active) await db.updateResumeRequestStatus(active.id, 'abandoned');
    return WELCOME_MSG;
  }

  // Greetings — continue active or show menu
  if (lower === 'hi' || lower === 'hello') {
    const active = await db.getActiveResumeRequest(user.id);
    if (active) return await handleActiveSession(from, user, active, incomingMsg);
    return WELCOME_MSG;
  }

  let resumeReq = await db.getActiveResumeRequest(user.id);

  // No active request — show menu or start flow
  if (!resumeReq) {
    if (lower === '1') {
      resumeReq = await db.createResumeRequest(user.id, 'improve');
      return 'Send your existing resume (PDF or Word .docx) and I will extract your details.';
    }
    if (lower === '2') {
      resumeReq = await db.createResumeRequest(user.id, 'create');
      const reply = await askClaude(resumeReq.id, 'Hi, I want to create a new resume from scratch.');
      return reply;
    }
    return WELCOME_MSG;
  }

  return await handleActiveSession(from, user, resumeReq, incomingMsg);
}

async function handleActiveSession(from, user, resumeReq, incomingMsg) {
  const lower = incomingMsg.toLowerCase().trim();
  const status = resumeReq.status;

  // ─── awaiting_input: waiting for file (improve flow) or first message
  if (status === 'awaiting_input') {
    if (resumeReq.flow === 'improve') {
      return 'Please send your resume file (PDF or Word). Or type "2" to create from scratch instead.';
    }
    await db.updateResumeRequestStatus(resumeReq.id, 'collecting_data');
    const reply = await askClaude(resumeReq.id, incomingMsg);
    return reply;
  }

  // ─── collecting_data: conversation with Claude
  if (status === 'collecting_data') {
    if (lower === 'generate resume' || lower === 'generate' || lower === 'gen') {
      return await startResumeGeneration(from, user, resumeReq);
    }

    if (lower === 'edit resume' || lower === 'edit') {
      const data = await db.getResumeData(resumeReq.id);
      if (!data || !data.name) {
        return 'No resume data yet. Let me ask you some questions first!\n\nWhat is your full name?';
      }
      const reply = await askClaude(resumeReq.id,
        'I want to edit my resume. Ask me what section I want to change.');
      return reply;
    }

    // Normal conversation with Claude
    const claudeReply = await askClaude(resumeReq.id, incomingMsg);

    if (claudeReply.trim() === 'GENERATE_RESUME') {
      return await startResumeGeneration(from, user, resumeReq);
    }

    return claudeReply;
  }

  // ─── preview_ready: resume preview shown, waiting for action
  if (status === 'preview_ready') {
    if (lower === '1' || lower === 'download' || lower === 'yes') {
      if (RAZORPAY_ENABLED) {
        return await createPaymentLink(from, resumeReq);
      }
      return await startFullResumeGeneration(from, user, resumeReq);
    }
    if (lower === '2' || lower === 'edit') {
      await db.updateResumeRequestStatus(resumeReq.id, 'collecting_data');
      const reply = await askClaude(resumeReq.id,
        'I want to edit my resume before downloading. Ask me what I want to change.');
      return reply;
    }
    if (lower === '3' || lower === 'new' || lower === 'restart') {
      await db.updateResumeRequestStatus(resumeReq.id, 'abandoned');
      return WELCOME_MSG;
    }
    if (RAZORPAY_ENABLED) {
      return 'Reply:\n1 - Get payment link\n2 - Edit something\n3 - Start over';
    }
    return 'Reply:\n1 - Download resume\n2 - Edit something\n3 - Start over';
  }

  // ─── paid: payment received, generating
  if (status === 'paid') {
    return 'Your payment was received! Resume is being generated...';
  }

  // ─── generating
  if (status === 'generating') {
    return 'Your resume is being generated. Please wait a moment...';
  }

  // ─── completed
  if (status === 'completed') {
    return WELCOME_MSG;
  }

  return WELCOME_MSG;
}

// ─── Resume generation triggers ──────────────────────────────────────────────

async function startResumeGeneration(from, user, resumeReq) {
  const limits = await db.getUserLimits(user.id);
  if (limits.daily_resumes >= DAILY_RESUME_LIMIT) {
    return 'System usage limit reached. Please try again tomorrow.';
  }

  await db.updateResumeRequestStatus(resumeReq.id, 'generating');
  await db.incrementResumeCount(user.id);

  processResumePreview(from, resumeReq.id).catch(err => {
    console.error('Resume generation error:', err);
    db.updateResumeRequestStatus(resumeReq.id, 'collecting_data').catch(console.error);
    sendWhatsApp(from, 'Sorry, there was an error. Please try again by typing "generate".').catch(console.error);
  });

  return 'Generating your resume...';
}

async function startFullResumeGeneration(from, user, resumeReq) {
  await db.updateResumeRequestStatus(resumeReq.id, 'generating');

  processFullResume(from, resumeReq.id).catch(err => {
    console.error('Full resume generation error:', err);
    db.updateResumeRequestStatus(resumeReq.id, 'preview_ready').catch(console.error);
    sendWhatsApp(from, 'Error generating your resume file. Reply "1" to try again.').catch(console.error);
  });

  return 'Creating your resume file...';
}

// ─── Async processors ────────────────────────────────────────────────────────

async function processResumePreview(from, resumeRequestId) {
  sendProgressMessages(from, 3).catch(console.error);

  await extractAndSaveFromConversation(resumeRequestId);
  const data = await db.getResumeData(resumeRequestId);

  if (!data || !data.name) {
    await db.updateResumeRequestStatus(resumeRequestId, 'collecting_data');
    await sendWhatsApp(from, 'I don\'t have enough information yet. Let\'s continue.\n\nWhat is your full name?');
    return;
  }

  await db.updateResumeRequestStatus(resumeRequestId, 'preview_ready');

  // Build redacted preview
  const preview = buildRedactedPreview(data);

  if (RAZORPAY_ENABLED) {
    // Send preview
    await sendWhatsApp(from, 'Here\'s a preview of your resume:\n\n' + preview);

    // Create payment link and send
    const paymentMsg = await createPaymentLink(from, { id: resumeRequestId });
    await sendWhatsApp(from, paymentMsg + '\n\nOr reply:\n2 - Edit something\n3 - Start over');
  } else {
    // Free mode: show preview + download options
    await sendWhatsApp(from,
      'Here\'s a preview of your resume:\n\n' + preview + '\n' +
      'Reply:\n' +
      '1 - Download full resume\n' +
      '2 - Edit something\n' +
      '3 - Start over'
    );
  }
}

async function processFullResume(from, resumeRequestId) {
  const data = await db.getResumeData(resumeRequestId);

  if (!data || !data.name) {
    await sendWhatsApp(from, 'No resume data found. Please start over by typing "menu".');
    return;
  }

  // Generate both DOCX and PDF
  const [docxPath, pdfPath] = await Promise.all([
    generateDocx(data),
    generatePdf(data),
  ]);

  const docxToken = storeTempFile(docxPath, 'ResumeWala-Resume.docx');
  const pdfToken = storeTempFile(pdfPath, 'ResumeWala-Resume.pdf');
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  const docxUrl = `${baseUrl}/resume/${docxToken}`;
  const pdfUrl = `${baseUrl}/resume/${pdfToken}`;

  await db.updateResumeRequestStatus(resumeRequestId, 'completed');

  const msg =
    'Your resume is ready!\n\n' +
    'Download Word: ' + docxUrl + '\n' +
    'Download PDF: ' + pdfUrl + '\n\n' +
    '(Links expire in 15 minutes)\n\n' +
    'Type "menu" to create another resume.';

  await sendWhatsApp(from, msg);
}

async function processMediaUpload(from, userId, mediaUrl, contentType) {
  const supportedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];

  if (!supportedTypes.includes(contentType)) {
    await sendWhatsApp(from, 'I can only read PDF or Word (.docx) files. Please send one of those, or type "2" to create from scratch.');
    return;
  }

  // Ensure active request exists
  let resumeReq = await db.getActiveResumeRequest(userId);
  if (!resumeReq) {
    resumeReq = await db.createResumeRequest(userId, 'improve');
  }
  if (!resumeReq.flow) {
    await db.updateResumeRequestFlow(resumeReq.id, 'improve');
  }

  // Step 1: Download file
  let buffer, tmpPath;
  try {
    ({ buffer, tmpPath } = await downloadTwilioMedia(mediaUrl, contentType));
  } catch (err) {
    console.error('Download error:', err.message);
    await sendWhatsApp(from, 'Could not download your file. Please try again.');
    return;
  }

  // Step 2: Extract text
  let text = '';
  try {
    if (contentType === 'application/pdf') {
      const data = await pdfParse(buffer);
      text = data.text;
    } else {
      const result = await mammoth.extractRawText({ path: tmpPath });
      text = result.value;
    }
  } catch (err) {
    console.error('Text extraction error:', err.message);
    await sendWhatsApp(from, 'Could not read your file. It may be corrupted. Please try another file.');
    return;
  } finally {
    fs.unlink(tmpPath, () => {});
  }

  if (!text.trim()) {
    await sendWhatsApp(from, 'Your file appears empty or image-based. Please send a text-based PDF or Word file.');
    return;
  }

  // Send progress messages
  sendProgressMessages(from, 5).catch(console.error);

  // Step 3: Claude extracts structured data (complete extraction)
  let resumeData = {};
  try {
    const extraction = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 3000,
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: 'Extract ALL resume data from this document. Do not miss any information:\n\n' + text.slice(0, 12000) }],
    });
    console.log('Extraction raw:', extraction.content[0].text.slice(0, 200));
    resumeData = parseStructuredText(extraction.content[0].text);
  } catch (err) {
    console.error('Extraction error:', err.message);
    await sendWhatsApp(from, 'Could not extract data. Type "2" to create a resume manually.');
    return;
  }

  // Step 4: Save to database
  await db.saveResumeData(resumeReq.id, resumeData);
  await db.updateResumeRequestStatus(resumeReq.id, 'collecting_data');

  // Step 5: Generate AI understanding message (Message 1)
  const understanding = await generateAIUnderstanding(resumeData);
  await sendWhatsApp(from, understanding);

  // Step 6: Detect missing fields and send questions (Message 2 - separate)
  const missing = detectMissingFields(resumeData);
  const questions = formatMissingFieldQuestions(missing);

  if (questions.length > 0) {
    // Send max 2 questions at a time
    const batch = questions.slice(0, 2);
    const questionMsg = 'I just need a few more details.\n\n' + batch.join('\n\n');
    await sendWhatsApp(from, questionMsg);

    // Seed the conversation context so Claude knows what was extracted and what was asked
    const contextMsg = 'User uploaded resume. Extracted data:\n' +
      'Name: ' + (resumeData.name || '') + '\n' +
      'Experience: ' + (resumeData.experience || []).map(e => typeof e === 'object' ? (e.title + ' at ' + e.company) : e).join(', ') + '\n' +
      'Education: ' + (resumeData.education || []).map(e => typeof e === 'object' ? (e.degree + ' from ' + e.institution) : e).join(', ') + '\n' +
      'Skills: ' + (resumeData.skills || []).join(', ') + '\n' +
      'Languages: ' + (resumeData.languages || []).join(', ') + '\n' +
      'Missing fields: ' + missing.join(', ') + '\n' +
      'I already asked about: ' + batch.map(q => q.split('\n')[0]).join('; ');
    await db.addMessage(resumeReq.id, 'incoming', contextMsg);
    await db.addMessage(resumeReq.id, 'outgoing', understanding + '\n\n' + questionMsg);
  } else {
    // No missing fields — ready to generate
    const readyMsg = 'Your resume data looks complete! Reply *YES* to generate your resume, or tell me if you want to change anything.';
    await sendWhatsApp(from, readyMsg);
    await db.addMessage(resumeReq.id, 'incoming', 'User uploaded resume with complete data.');
    await db.addMessage(resumeReq.id, 'outgoing', understanding + '\n\n' + readyMsg);
  }
}

// ─── Extract from conversation ───────────────────────────────────────────────

async function extractAndSaveFromConversation(resumeRequestId) {
  const messages = await db.getConversationMessages(resumeRequestId);
  const existingData = await db.getResumeData(resumeRequestId);

  const convText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  if (!convText.trim()) return;

  let prompt = '';
  if (existingData && existingData.name) {
    prompt += 'Previously extracted resume data:\n';
    prompt += 'Name: ' + (existingData.name || '') + '\n';
    prompt += 'Headline: ' + (existingData.headline || '') + '\n';
    prompt += 'Location: ' + (existingData.location || '') + '\n';
    prompt += 'Email: ' + (existingData.email || '') + '\n';
    prompt += 'Phone: ' + (existingData.phone || '') + '\n';
    prompt += 'Target Role: ' + (existingData.target_role || '') + '\n';
    if (existingData.summary) prompt += 'Summary: ' + existingData.summary + '\n';
    if (existingData.experience?.length) prompt += 'Experience: ' + JSON.stringify(existingData.experience) + '\n';
    if (existingData.education?.length) prompt += 'Education: ' + JSON.stringify(existingData.education) + '\n';
    if (existingData.skills?.length) prompt += 'Skills: ' + existingData.skills.join(', ') + '\n';
    if (existingData.leadership?.length) prompt += 'Leadership: ' + JSON.stringify(existingData.leadership) + '\n';
    if (existingData.projects?.length) prompt += 'Projects: ' + JSON.stringify(existingData.projects) + '\n';
    if (existingData.certifications?.length) prompt += 'Certifications: ' + existingData.certifications.join(', ') + '\n';
    if (existingData.achievements?.length) prompt += 'Achievements: ' + existingData.achievements.join(', ') + '\n';
    if (existingData.languages?.length) prompt += 'Languages: ' + existingData.languages.join(', ') + '\n';
    prompt += '\n';
  }
  prompt += 'Conversation with additional information:\n\n' + convText.slice(0, 10000);
  prompt += '\n\nExtract the COMPLETE resume data, merging all sources. Preserve all existing data and add/update from the conversation. Do not lose any information.';

  try {
    const extraction = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 3000,
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = parseStructuredText(extraction.content[0].text);
    await db.saveResumeData(resumeRequestId, parsed);
  } catch (err) {
    console.error('Extraction from conversation failed:', err.message);
  }
}

// ─── Download Twilio media ───────────────────────────────────────────────────

async function downloadTwilioMedia(mediaUrl, contentType) {
  const credentials = Buffer.from(
    process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN
  ).toString('base64');

  const fetchWithAuth = () => fetch(mediaUrl, {
    headers: { Authorization: 'Basic ' + credentials },
  });

  let response = await fetchWithAuth();
  if (!response.ok) {
    response = await fetchWithAuth();
  }
  if (!response.ok) {
    throw new Error('Media download failed: ' + response.status);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const ext = contentType === 'application/pdf' ? 'pdf' : 'docx';
  const tmpPath = path.join(os.tmpdir(), 'upload-' + crypto.randomUUID() + '.' + ext);
  fs.writeFileSync(tmpPath, buffer);

  return { buffer, tmpPath };
}

// ─── Ask Claude ──────────────────────────────────────────────────────────────

async function askClaude(resumeRequestId, userMessage) {
  await db.addMessage(resumeRequestId, 'incoming', userMessage);
  const messages = await db.getConversationMessages(resumeRequestId);

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
  });

  const assistantText = response.content[0].text;
  await db.addMessage(resumeRequestId, 'outgoing', assistantText);
  return assistantText;
}

// ─── Razorpay payment link ───────────────────────────────────────────────────

async function createPaymentLink(from, resumeReq) {
  if (!razorpay) return 'Payment is not configured. Please contact support.';

  try {
    const link = await razorpay.paymentLink.create({
      amount: PAYMENT_AMOUNT,
      currency: 'INR',
      description: 'ResumeWala - Professional Resume',
      notes: {
        resume_request_id: resumeReq.id,
        phone: from,
      },
      callback_url: (process.env.BASE_URL || '') + '/payment-success',
      callback_method: 'get',
    });

    // Store payment in database
    await db.createPayment(resumeReq.id, link.id, PAYMENT_AMOUNT);

    const price = PAYMENT_AMOUNT / 100;
    return 'To download your full resume, complete payment:\n\n' +
      link.short_url + '\n\n' +
      'Price: Rs ' + price + ' only\n\n' +
      'Your resume will be sent automatically after payment.';
  } catch (err) {
    console.error('Razorpay error:', err);
    return 'Could not create payment link. Please try again.';
  }
}

// ─── DOCX generation (professional ATS-compatible template) ──────────────────

async function generateDocx(data) {
  const children = [];
  const RIGHT_TAB = 10466; // A4 content width in twips (11906 - 720 - 720)

  // ── Section heading with bottom border (13pt, navy, uppercase)
  const sectionHeading = (title) =>
    new Paragraph({
      children: [new TextRun({ text: title.toUpperCase(), bold: true, size: 26, font: 'Calibri', color: '1F3864' })],
      border: {
        bottom: { color: '1F3864', space: 2, style: BorderStyle.SINGLE, size: 6 },
      },
      spacing: { before: 300, after: 120 },
    });

  // ── Bullet paragraph with hanging indent and bold metrics
  const bulletParagraph = (text) => {
    // Bold: numbers, percentages, multipliers, currency, large counts
    const parts = text.split(/((?:[₹$])\s*\d+[\d,.]*[KkMmLl]*(?:\s*(?:Cr|cr|Lakh|lakh))?|\d+[\d,.]*\s*[%xXkKmM+]*|\d{2,}[+]?)/g);
    const runs = [];
    for (const part of parts) {
      if (/^(?:[₹$])\s*\d+|^\d+[\d,.]*\s*[%xXkKmM+]*$|^\d{2,}[+]?$/.test(part)) {
        runs.push(new TextRun({ text: part, bold: true, size: 21, font: 'Calibri' }));
      } else {
        runs.push(new TextRun({ text: part, size: 21, font: 'Calibri' }));
      }
    }
    return new Paragraph({
      children: [new TextRun({ text: '\u2022  ', size: 21, font: 'Calibri' }), ...runs],
      spacing: { after: 80, line: 264 },
      indent: { left: 360, hanging: 180 },
    });
  };

  // ═══ HEADER ═══════════════════════════════════════════════════

  // Name (16pt bold navy, centered)
  children.push(
    new Paragraph({
      children: [new TextRun({ text: (data.name || 'Resume').toUpperCase(), bold: true, size: 32, font: 'Calibri', color: '1F3864' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
    })
  );

  // Headline (11pt, dark gray, centered)
  if (data.headline) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.headline, size: 22, font: 'Calibri', color: '404040' })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 40 },
      })
    );
  }

  // Contact line (10pt, gray, centered)
  const contactParts = [data.location, data.phone, data.email].filter(Boolean);
  if (contactParts.length > 0) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: contactParts.join('  |  '), size: 20, font: 'Calibri', color: '666666' })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      })
    );
  }

  // ═══ PROFESSIONAL SUMMARY ═════════════════════════════════════

  if (data.summary) {
    children.push(sectionHeading('Professional Summary'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.summary, size: 21, font: 'Calibri' })],
        spacing: { after: 100, line: 276 },
      })
    );
  }

  // ═══ PROFESSIONAL EXPERIENCE ══════════════════════════════════

  if (data.experience && data.experience.length > 0) {
    children.push(sectionHeading('Professional Experience'));
    const MAX_DETAILED = 4;

    for (let i = 0; i < data.experience.length; i++) {
      const exp = data.experience[i];
      if (typeof exp !== 'object') {
        children.push(bulletParagraph(String(exp)));
        continue;
      }

      // Company name (bold, navy)
      if (exp.company) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: exp.company, bold: true, size: 23, font: 'Calibri', color: '1F3864' })],
            spacing: { before: i === 0 ? 0 : 200, after: 30 },
          })
        );
      }

      // Role title + Duration (right-aligned via tab stop)
      if (exp.title) {
        const roleChildren = [
          new TextRun({ text: exp.title, bold: true, size: 21, font: 'Calibri' }),
        ];
        if (exp.duration) {
          roleChildren.push(new TextRun({ text: '\t' }));
          roleChildren.push(new TextRun({ text: exp.duration, size: 20, font: 'Calibri', color: '666666' }));
        }
        children.push(
          new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
            children: roleChildren,
            spacing: { after: 60 },
          })
        );
      }

      // Description (optional, italic)
      if (exp.description) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: exp.description, size: 20, font: 'Calibri', color: '555555', italics: true })],
            spacing: { after: 60 },
          })
        );
      }

      // Responsibility bullets (max 10 for first 4 roles, 3 for older)
      const responsibilities = Array.isArray(exp.responsibilities) ? exp.responsibilities :
        (exp.responsibilities ? [exp.responsibilities] : []);
      const maxBullets = i < MAX_DETAILED ? 10 : 3;
      for (const resp of responsibilities.slice(0, maxBullets)) {
        children.push(bulletParagraph(String(resp)));
      }
    }
  }

  // ═══ PROJECTS ═════════════════════════════════════════════════

  if (data.projects && data.projects.length > 0) {
    children.push(sectionHeading('Projects'));
    for (const proj of data.projects) {
      children.push(bulletParagraph(String(proj)));
    }
  }

  // ═══ EDUCATION ════════════════════════════════════════════════

  if (data.education && data.education.length > 0) {
    children.push(sectionHeading('Education'));
    for (const edu of data.education) {
      if (typeof edu === 'object') {
        const rightText = [edu.institution, edu.year].filter(Boolean).join(' | ');
        const eduChildren = [
          new TextRun({ text: edu.degree || '', bold: true, size: 21, font: 'Calibri' }),
        ];
        if (rightText) {
          eduChildren.push(new TextRun({ text: '\t' }));
          eduChildren.push(new TextRun({ text: rightText, size: 21, font: 'Calibri', color: '666666' }));
        }
        children.push(
          new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
            children: eduChildren,
            spacing: { before: 60, after: 80 },
          })
        );
      } else {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: String(edu), size: 21, font: 'Calibri' })],
            spacing: { after: 80 },
          })
        );
      }
    }
  }

  // ═══ KEY SKILLS (pipe-separated) ══════════════════════════════

  const skillsList = (data.skills || []).map(s => typeof s === 'string' ? s : String(s));
  if (skillsList.length > 0) {
    children.push(sectionHeading('Key Skills'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: skillsList.join('  |  '), size: 21, font: 'Calibri' })],
        spacing: { after: 100 },
      })
    );
  }

  // ═══ ACHIEVEMENTS ═════════════════════════════════════════════

  if (data.achievements && data.achievements.length > 0) {
    children.push(sectionHeading('Achievements'));
    for (const ach of data.achievements) {
      children.push(bulletParagraph(String(ach)));
    }
  }

  // ═══ CERTIFICATIONS ═══════════════════════════════════════════

  if (data.certifications && data.certifications.length > 0) {
    children.push(sectionHeading('Certifications'));
    for (const cert of data.certifications) {
      children.push(bulletParagraph(String(cert)));
    }
  }

  // ═══ TOOLS & TECHNOLOGIES (pipe-separated) ════════════════════

  const toolsList = (data.tools || []).map(t => typeof t === 'string' ? t : String(t));
  if (toolsList.length > 0) {
    children.push(sectionHeading('Tools & Technologies'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: toolsList.join('  |  '), size: 21, font: 'Calibri' })],
        spacing: { after: 100 },
      })
    );
  }

  // ═══ LEADERSHIP & EXTRACURRICULAR ═════════════════════════════

  if (data.leadership && data.leadership.length > 0) {
    children.push(sectionHeading('Leadership & Extracurricular'));
    for (const item of data.leadership) {
      if (typeof item === 'object' && item.title) {
        const headerRuns = [
          new TextRun({ text: item.title, bold: true, size: 21, font: 'Calibri' }),
        ];
        if (item.company) {
          headerRuns.push(new TextRun({ text: ' | ', size: 21, font: 'Calibri', color: '666666' }));
          headerRuns.push(new TextRun({ text: item.company, size: 21, font: 'Calibri', color: '1F3864', bold: true }));
        }
        if (item.duration) {
          headerRuns.push(new TextRun({ text: '\t' }));
          headerRuns.push(new TextRun({ text: item.duration, size: 20, font: 'Calibri', color: '666666' }));
        }
        children.push(
          new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
            children: headerRuns,
            spacing: { before: 120, after: 40 },
          })
        );
        const resps = Array.isArray(item.responsibilities) ? item.responsibilities : [];
        for (const r of resps) {
          children.push(bulletParagraph(String(r)));
        }
      } else {
        children.push(bulletParagraph(String(item)));
      }
    }
  }

  // ═══ LANGUAGES (pipe-separated) ═══════════════════════════════

  const langList = (data.languages || []).map(l => typeof l === 'string' ? l : String(l));
  if (langList.length > 0) {
    children.push(sectionHeading('Languages'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: langList.join('  |  '), size: 21, font: 'Calibri' })],
        spacing: { after: 100 },
      })
    );
  }

  // ═══ HOBBIES ══════════════════════════════════════════════════

  if (data.hobbies && data.hobbies.length > 0) {
    children.push(sectionHeading('Hobbies & Interests'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.hobbies.map(h => typeof h === 'string' ? h : String(h)).join('  |  '), size: 21, font: 'Calibri' })],
      })
    );
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 720, right: 720, bottom: 720, left: 720 },
        },
      },
      children,
    }],
  });

  const docBuffer = await Packer.toBuffer(doc);
  const filePath = path.join(os.tmpdir(), `resume-${crypto.randomUUID()}.docx`);
  fs.writeFileSync(filePath, docBuffer);
  return filePath;
}

// ─── PDF generation ──────────────────────────────────────────────────────────

async function generatePdf(data) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(os.tmpdir(), `resume-${crypto.randomUUID()}.pdf`);
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      info: {
        Title: (data.name || 'Resume') + ' - Resume',
        Author: 'ResumeWala.ai',
      },
    });

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const NAVY = '#1F3864';
    const GRAY = '#666666';
    const DARK_GRAY = '#404040';
    const BLACK = '#000000';
    const PAGE_WIDTH = 495; // A4 content: 595 - 50 - 50
    const LEFT = 50;
    const RIGHT_EDGE = LEFT + PAGE_WIDTH;

    // Helper: right-aligned pair on same line
    const rightAlignedLine = (leftTxt, lFont, lSize, lColor, rightTxt, rFont, rSize, rColor) => {
      const startY = doc.y;
      doc.font(rFont).fontSize(rSize);
      const rWidth = doc.widthOfString(rightTxt);
      doc.font(lFont).fontSize(lSize).fillColor(lColor)
        .text(leftTxt, LEFT, startY, { width: PAGE_WIDTH - rWidth - 10 });
      const afterLeftY = doc.y;
      doc.font(rFont).fontSize(rSize).fillColor(rColor)
        .text(rightTxt, RIGHT_EDGE - rWidth, startY);
      doc.y = Math.max(afterLeftY, doc.y);
    };

    // Helper: section heading with line
    const pdfSectionHeading = (title) => {
      doc.moveDown(0.4);
      doc.fontSize(11).fillColor(NAVY).font('Helvetica-Bold')
        .text(title.toUpperCase());
      const y = doc.y;
      doc.moveTo(LEFT, y).lineTo(RIGHT_EDGE, y)
        .strokeColor(NAVY).lineWidth(0.8).stroke();
      doc.moveDown(0.15);
    };

    // Helper: bullet with hanging indent
    const pdfBullet = (text) => {
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text('\u2022  ' + text, LEFT + 15, doc.y, {
          width: PAGE_WIDTH - 15,
          lineGap: 2,
        });
    };

    // ═══ HEADER ═════════════════════════════════════════════════

    doc.fontSize(16).fillColor(NAVY).font('Helvetica-Bold')
      .text((data.name || 'Resume').toUpperCase(), { align: 'center' });

    if (data.headline) {
      doc.fontSize(10.5).fillColor(DARK_GRAY).font('Helvetica')
        .text(data.headline, { align: 'center' });
    }

    const contactParts = [data.location, data.phone, data.email].filter(Boolean);
    if (contactParts.length > 0) {
      doc.fontSize(9).fillColor(GRAY).font('Helvetica')
        .text(contactParts.join('  |  '), { align: 'center' });
    }

    doc.moveDown(0.5);

    // ═══ PROFESSIONAL SUMMARY ═══════════════════════════════════

    if (data.summary) {
      pdfSectionHeading('Professional Summary');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(data.summary, { lineGap: 3 });
    }

    // ═══ PROFESSIONAL EXPERIENCE ════════════════════════════════

    if (data.experience && data.experience.length > 0) {
      pdfSectionHeading('Professional Experience');
      const MAX_DETAILED = 4;

      for (let i = 0; i < data.experience.length; i++) {
        const exp = data.experience[i];
        if (typeof exp !== 'object') {
          pdfBullet(String(exp));
          continue;
        }

        if (i > 0) doc.moveDown(0.3);

        // Company name (bold, navy)
        if (exp.company) {
          doc.fontSize(10.5).fillColor(NAVY).font('Helvetica-Bold')
            .text(exp.company);
        }

        // Role + Duration (right-aligned)
        if (exp.title) {
          if (exp.duration) {
            rightAlignedLine(
              exp.title, 'Helvetica-Bold', 10, BLACK,
              exp.duration, 'Helvetica', 9.5, GRAY
            );
          } else {
            doc.fontSize(10).fillColor(BLACK).font('Helvetica-Bold')
              .text(exp.title);
          }
        }

        // Description (optional, italic)
        if (exp.description) {
          doc.fontSize(9).fillColor(GRAY).font('Helvetica-Oblique')
            .text(exp.description);
        }

        // Bullets (max 10 for first 4 roles, 3 for older)
        const responsibilities = Array.isArray(exp.responsibilities) ? exp.responsibilities :
          (exp.responsibilities ? [exp.responsibilities] : []);
        const maxBullets = i < MAX_DETAILED ? 10 : 3;
        for (const resp of responsibilities.slice(0, maxBullets)) {
          pdfBullet(String(resp));
        }
      }
    }

    // ═══ PROJECTS ═══════════════════════════════════════════════

    if (data.projects && data.projects.length > 0) {
      pdfSectionHeading('Projects');
      for (const proj of data.projects) {
        pdfBullet(String(proj));
      }
    }

    // ═══ EDUCATION ══════════════════════════════════════════════

    if (data.education && data.education.length > 0) {
      pdfSectionHeading('Education');
      for (const edu of data.education) {
        if (typeof edu === 'object') {
          const rightText = [edu.institution, edu.year].filter(Boolean).join(' | ');
          if (rightText) {
            rightAlignedLine(
              edu.degree || '', 'Helvetica-Bold', 10, BLACK,
              rightText, 'Helvetica', 10, GRAY
            );
          } else {
            doc.fontSize(10).fillColor(BLACK).font('Helvetica-Bold')
              .text(edu.degree || '');
          }
          doc.moveDown(0.1);
        } else {
          doc.fontSize(10).fillColor(BLACK).font('Helvetica')
            .text(String(edu));
          doc.moveDown(0.1);
        }
      }
    }

    // ═══ KEY SKILLS ═════════════════════════════════════════════

    const pdfSkills = (data.skills || []).map(s => typeof s === 'string' ? s : String(s));
    if (pdfSkills.length > 0) {
      pdfSectionHeading('Key Skills');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(pdfSkills.join('  |  '), { lineGap: 2 });
    }

    // ═══ ACHIEVEMENTS ═══════════════════════════════════════════

    if (data.achievements && data.achievements.length > 0) {
      pdfSectionHeading('Achievements');
      for (const ach of data.achievements) {
        pdfBullet(String(ach));
      }
    }

    // ═══ CERTIFICATIONS ═════════════════════════════════════════

    if (data.certifications && data.certifications.length > 0) {
      pdfSectionHeading('Certifications');
      for (const cert of data.certifications) {
        pdfBullet(String(cert));
      }
    }

    // ═══ TOOLS & TECHNOLOGIES ═══════════════════════════════════

    const pdfTools = (data.tools || []).map(t => typeof t === 'string' ? t : String(t));
    if (pdfTools.length > 0) {
      pdfSectionHeading('Tools & Technologies');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(pdfTools.join('  |  '), { lineGap: 2 });
    }

    // ═══ LEADERSHIP & EXTRACURRICULAR ═══════════════════════════

    if (data.leadership && data.leadership.length > 0) {
      pdfSectionHeading('Leadership & Extracurricular');
      for (const item of data.leadership) {
        if (typeof item === 'object' && item.title) {
          const leftTxt = [item.title, item.company].filter(Boolean).join(' | ');
          if (item.duration) {
            rightAlignedLine(
              leftTxt, 'Helvetica-Bold', 10, NAVY,
              item.duration, 'Helvetica', 9.5, GRAY
            );
          } else {
            doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold')
              .text(leftTxt);
          }
          const resps = Array.isArray(item.responsibilities) ? item.responsibilities : [];
          for (const r of resps) {
            pdfBullet(String(r));
          }
          doc.moveDown(0.15);
        } else {
          pdfBullet(String(item));
        }
      }
    }

    // ═══ LANGUAGES ══════════════════════════════════════════════

    const pdfLangs = (data.languages || []).map(l => typeof l === 'string' ? l : String(l));
    if (pdfLangs.length > 0) {
      pdfSectionHeading('Languages');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(pdfLangs.join('  |  '), { lineGap: 2 });
    }

    // ═══ HOBBIES ════════════════════════════════════════════════

    const pdfHobbies = (data.hobbies || []).map(h => typeof h === 'string' ? h : String(h));
    if (pdfHobbies.length > 0) {
      pdfSectionHeading('Hobbies & Interests');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(pdfHobbies.join('  |  '), { lineGap: 2 });
    }

    doc.end();
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────

async function start() {
  await db.initDb();
  console.log('ResumeWala.ai - Database initialized');

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log('ResumeWala.ai running on port ' + PORT);
    console.log('Razorpay:', RAZORPAY_ENABLED ? 'ENABLED' : 'DISABLED (free mode)');
    console.log('BASE_URL:', process.env.BASE_URL || 'NOT SET');
  });
}

// ─── Global error handlers (prevent process crash) ──────────────────────────

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
