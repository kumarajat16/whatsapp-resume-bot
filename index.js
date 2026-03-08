const express = require('express');
const { twiml: { MessagingResponse } } = require('twilio');
const Anthropic = require('@anthropic-ai/sdk').default;
const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } = require('docx');
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

function storeTempFile(filePath) {
  const token = crypto.randomUUID();
  setTimeout(() => {
    tempFiles.delete(token);
    fs.unlink(filePath, () => {});
  }, 15 * 60 * 1000);
  tempFiles.set(token, { filePath });
  return token;
}

// ─── Twilio helpers ──────────────────────────────────────────────────────────

async function sendWhatsApp(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
    body,
  });
}

function sendTwiml(res, text) {
  const resp = new MessagingResponse();
  resp.message(text);
  res.type('text/xml');
  res.send(resp.toString());
}

// ─── Progress messages (no AI cost) ──────────────────────────────────────────

const PROGRESS_MESSAGES = [
  'Analyzing your information...',
  'Building your professional summary...',
  'Formatting your resume...',
  'Almost done, adding final touches...',
];

async function sendProgressMessages(to, count) {
  for (let i = 0; i < Math.min(count, PROGRESS_MESSAGES.length); i++) {
    await new Promise(r => setTimeout(r, 2000));
    await sendWhatsApp(to, PROGRESS_MESSAGES[i]);
  }
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are ResumeWala, a WhatsApp resume-building assistant for Indian job seekers. You help users create professional resumes quickly.

Your job: collect resume information through natural conversation. Ask 1-2 questions at a time.

Collect these details:
1. Full name
2. Phone / Email (optional)
3. Location (city)
4. Professional summary (you can help write this)
5. Education (degree, college, year)
6. Work experience (title, company, duration, responsibilities) - may have multiple
7. Skills (technical and soft)
8. Projects (optional)
9. Certifications (optional)
10. Achievements (optional)

Rules:
- Be warm, encouraging, and concise. Messages must be SHORT and mobile-friendly.
- Use plain text only. No markdown (no **, ##, bullet dashes). Use line breaks for formatting.
- Ask 1-2 questions per message. Do not overwhelm.
- If user gives short answers, gently ask for more detail.
- If conversation starts with pre-loaded resume data, confirm what you found and only ask about missing/unclear fields. Do NOT re-ask everything.
- You MUST stay on topic. If the user tries to chat about non-resume topics, politely redirect: "Let's focus on your resume! [next question]"
- Do NOT answer general knowledge questions, jokes, or off-topic requests.
- Once you have the core info (name, education, experience, skills), say:
  "I have your details ready! Reply YES to generate your resume."
- When user says YES/yes/y, respond with exactly: GENERATE_RESUME
- Do not add any other text when responding with GENERATE_RESUME`;

const EXTRACT_PROMPT = `You are a resume data extractor. Given resume text or a conversation, extract information in this EXACT plain-text format. Do not use JSON. Do not add explanation.

Name: [full name]
Email: [email if found]
Phone: [phone if found]
Location: [city]
Summary: [2-3 sentence professional summary]

Education:
* [Degree], [Institution], [Year]

Experience:
* [Job Title], [Company], [Duration], [Key responsibilities]

Skills:
* [Skill]

Projects:
* [Project description]

Certifications:
* [Certification]

Achievements:
* [Achievement]

Tools:
* [Tool or technology]

Rules:
- Use exactly these section headers
- Use * for list items
- Omit empty sections entirely
- No JSON, no markdown`;

// ─── Welcome / Menu ──────────────────────────────────────────────────────────

const WELCOME_MSG =
  'Welcome to ResumeWala!\nBuild a professional resume in minutes.\n\nReply:\n1 - Improve existing resume (upload PDF/Word)\n2 - Create fresh resume\n\nType "menu" anytime to see this again.';

// ─── Structured text parser ──────────────────────────────────────────────────

function parseStructuredText(raw) {
  const result = {
    name: '', email: '', phone: '', location: '', summary: '',
    education: [], experience: [], skills: [],
    projects: [], certifications: [], achievements: [], tools: [], hobbies: [],
  };

  const lines = raw.split('\n');
  let currentSection = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const inlineMatch = trimmed.match(/^(Name|Email|Phone|Location|City|Summary):\s*(.+)$/i);
    if (inlineMatch) {
      let key = inlineMatch[1].toLowerCase();
      if (key === 'city') key = 'location';
      result[key] = inlineMatch[2].trim();
      currentSection = key;
      continue;
    }

    const sectionMatch = trimmed.match(/^(Education|Experience|Skills|Projects|Certifications|Achievements|Tools|Hobbies):\s*$/i);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase();
      continue;
    }

    if (currentSection && /^[*\-\u2022]/.test(trimmed)) {
      const val = trimmed.replace(/^[*\-\u2022]\s*/, '').trim();
      if (!val) continue;

      if (currentSection === 'education') {
        const parts = val.split(',').map(s => s.trim());
        result.education.push({
          degree: parts[0] || val,
          institution: parts[1] || '',
          year: parts[2] || '',
        });
      } else if (currentSection === 'experience') {
        const parts = val.split(',').map(s => s.trim());
        result.experience.push({
          title: parts[0] || val,
          company: parts[1] || '',
          duration: parts[2] || '',
          responsibilities: parts.slice(3).join(', '),
        });
      } else if (Array.isArray(result[currentSection])) {
        result[currentSection].push(val);
      }
    }
  }

  return result;
}

// ─── Resume data summary (for preview / confirmation) ────────────────────────

function buildResumeSummary(data, redacted) {
  const lines = [];
  if (data.name) lines.push('Name: ' + data.name);
  if (data.location) lines.push('Location: ' + data.location);

  if (data.experience && data.experience.length > 0) {
    lines.push('\nExperience:');
    for (const exp of data.experience) {
      if (typeof exp === 'object') {
        const parts = [exp.title, exp.company, exp.duration].filter(Boolean);
        lines.push('- ' + parts.join(' | '));
      } else {
        lines.push('- ' + exp);
      }
    }
  }

  if (data.education && data.education.length > 0) {
    lines.push('\nEducation:');
    for (const edu of data.education) {
      if (typeof edu === 'object') {
        lines.push('- ' + [edu.degree, edu.institution, edu.year].filter(Boolean).join(' | '));
      } else {
        lines.push('- ' + edu);
      }
    }
  }

  if (data.skills && data.skills.length > 0) {
    const shown = data.skills.slice(0, 5);
    const more = data.skills.length > 5 ? ` +${data.skills.length - 5} more` : '';
    lines.push('\nSkills: ' + shown.join(', ') + more);
  }

  if (redacted) {
    lines.push('\n--- Full details available after download ---');
  }

  return lines.join('\n');
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
  res.download(entry.filePath, 'ResumeWala-Resume.docx', (err) => {
    if (err && !res.headersSent) res.status(500).send('Download error.');
  });
});

// Razorpay webhook (optional)
if (RAZORPAY_ENABLED) {
  app.use('/razorpay/webhook', express.json());
  app.post('/razorpay/webhook', async (req, res) => {
    try {
      const event = req.body.event;
      if (event === 'payment_link.paid') {
        const notes = req.body.payload?.payment_link?.entity?.notes || {};
        const resumeRequestId = notes.resume_request_id;
        const phone = notes.phone;
        if (resumeRequestId && phone) {
          await db.updateResumeRequestStatus(resumeRequestId, 'paid');
          // Generate and send the full resume
          processFullResume(phone, resumeRequestId).catch(err => {
            console.error('Post-payment resume generation error:', err);
          });
        }
      }
      res.json({ status: 'ok' });
    } catch (err) {
      console.error('Razorpay webhook error:', err);
      res.status(500).json({ error: 'webhook error' });
    }
  });
}

// ─── WhatsApp Webhook ────────────────────────────────────────────────────────

app.post('/whatsapp', async (req, res) => {
  const incomingMsg = (req.body.Body || '').trim();
  const from = req.body.From || 'unknown';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl = req.body.MediaUrl0 || null;
  const mediaContentType = req.body.MediaContentType0 || '';

  console.log('From:', from, 'Msg:', incomingMsg, 'Media:', numMedia);

  const user = await db.findOrCreateUser(from);
  await db.resetDailyLimitsIfNeeded(user.id);

  // Rate limit check
  const limits = await db.getUserLimits(user.id);
  if (limits.daily_messages >= DAILY_MESSAGE_LIMIT) {
    sendTwiml(res, 'You have reached your daily message limit. Please try again tomorrow!');
    return;
  }
  await db.incrementMessageCount(user.id);

  // Media upload — immediate ack + background processing
  if (numMedia > 0 && mediaUrl) {
    sendTwiml(res, 'Got your file! Give me a moment to read it...');
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
});

// ─── Message handler (state machine) ─────────────────────────────────────────

async function handleMessage(from, user, incomingMsg) {
  const lower = incomingMsg.toLowerCase().trim();

  // Menu / restart
  if (lower === 'menu' || lower === 'restart' || lower === '0' || lower === 'hi' || lower === 'hello') {
    const active = await db.getActiveResumeRequest(user.id);
    if (active && lower !== 'hi' && lower !== 'hello') {
      await db.updateResumeRequestStatus(active.id, 'abandoned');
    }
    if (active && (lower === 'hi' || lower === 'hello')) {
      // If they have an active session, continue it
      return await handleActiveSession(from, user, active, incomingMsg);
    }
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
    // Create flow — start conversation
    await db.updateResumeRequestStatus(resumeReq.id, 'collecting_data');
    const reply = await askClaude(resumeReq.id, incomingMsg);
    return reply;
  }

  // ─── collecting_data: conversation with Claude
  if (status === 'collecting_data') {
    // Generate command
    if (lower === 'generate resume' || lower === 'generate' || lower === 'gen') {
      return await startResumeGeneration(from, user, resumeReq);
    }

    // Edit command
    if (lower === 'edit resume' || lower === 'edit') {
      const data = await db.getResumeData(resumeReq.id);
      if (!data || !data.name) {
        return 'No resume data yet. Let me ask you some questions first!\n\nWhat is your full name?';
      }
      const reply = await askClaude(resumeReq.id,
        'I want to edit my resume. Current data:\n' + buildResumeSummary(data, false) + '\n\nAsk me what I want to change.');
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
      // No payment required — generate and send
      return await startFullResumeGeneration(from, user, resumeReq);
    }
    if (lower === '2' || lower === 'edit') {
      await db.updateResumeRequestStatus(resumeReq.id, 'collecting_data');
      const data = await db.getResumeData(resumeReq.id);
      const reply = await askClaude(resumeReq.id,
        'I want to edit my resume before downloading. Current data:\n' + buildResumeSummary(data, false) + '\n\nAsk me what I want to change.');
      return reply;
    }
    if (lower === '3' || lower === 'new' || lower === 'restart') {
      await db.updateResumeRequestStatus(resumeReq.id, 'abandoned');
      return WELCOME_MSG;
    }
    return 'Reply:\n1 - Download resume\n2 - Edit something\n3 - Start over';
  }

  // ─── generating: resume is being generated
  if (status === 'generating') {
    return 'Your resume is being generated. Please wait a moment...';
  }

  // ─── completed: resume already delivered
  if (status === 'completed') {
    return WELCOME_MSG;
  }

  // Fallback
  return WELCOME_MSG;
}

// ─── Resume generation triggers ──────────────────────────────────────────────

async function startResumeGeneration(from, user, resumeReq) {
  // Check resume daily limit
  const limits = await db.getUserLimits(user.id);
  if (limits.daily_resumes >= DAILY_RESUME_LIMIT) {
    return 'You have used all ' + DAILY_RESUME_LIMIT + ' resume generations for today. Try again tomorrow!';
  }

  await db.updateResumeRequestStatus(resumeReq.id, 'generating');
  await db.incrementResumeCount(user.id);

  // Fire and forget
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
  // Send progress messages
  sendProgressMessages(from, 2).catch(console.error);

  // Extract data from conversation
  await extractAndSaveFromConversation(resumeRequestId);
  const data = await db.getResumeData(resumeRequestId);

  if (!data || !data.name) {
    await db.updateResumeRequestStatus(resumeRequestId, 'collecting_data');
    await sendWhatsApp(from, 'I don\'t have enough information yet. Let\'s continue.\n\nWhat is your full name?');
    return;
  }

  // Show preview (redacted)
  await db.updateResumeRequestStatus(resumeRequestId, 'preview_ready');

  const preview = buildResumeSummary(data, true);
  const msg =
    'Here\'s a preview of your resume:\n\n' +
    preview + '\n\n' +
    'Reply:\n' +
    '1 - Download full resume\n' +
    '2 - Edit something\n' +
    '3 - Start over';

  await sendWhatsApp(from, msg);
}

async function processFullResume(from, resumeRequestId) {
  const data = await db.getResumeData(resumeRequestId);

  if (!data || !data.name) {
    await sendWhatsApp(from, 'No resume data found. Please start over by typing "menu".');
    return;
  }

  const filePath = await generateDocx(data);
  const token = storeTempFile(filePath);
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  const downloadUrl = `${baseUrl}/resume/${token}`;

  await db.updateResumeRequestStatus(resumeRequestId, 'completed');

  const msg =
    'Your resume is ready!\n\n' +
    'Download: ' + downloadUrl + '\n\n' +
    '(Link expires in 15 minutes)\n\n' +
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

  // Download file
  let buffer, tmpPath;
  try {
    ({ buffer, tmpPath } = await downloadTwilioMedia(mediaUrl, contentType));
  } catch (err) {
    console.error('Download error:', err.message);
    await sendWhatsApp(from, 'Could not download your file. Please try again.');
    return;
  }

  // Extract text
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

  await sendWhatsApp(from, 'Reading your resume...');

  // Claude extracts structured data
  let resumeData = {};
  try {
    const extraction = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: 'Extract resume data:\n\n' + text.slice(0, 8000) }],
    });
    resumeData = parseStructuredText(extraction.content[0].text);
  } catch (err) {
    console.error('Extraction error:', err.message);
    await sendWhatsApp(from, 'Could not extract data. Type "2" to create a resume manually.');
    return;
  }

  // Save
  await db.saveResumeData(resumeReq.id, resumeData);
  await db.updateResumeRequestStatus(resumeReq.id, 'collecting_data');

  // Build summary and start conversation
  const summary = buildResumeSummary(resumeData, false);

  const contextMsg = 'I uploaded my resume. Here is what was extracted:\n' +
    summary + '\n\nConfirm what you found and ask about any missing fields.';
  const claudeReply = await askClaude(resumeReq.id, contextMsg);

  await sendWhatsApp(from, 'Here\'s what I found:\n\n' + summary + '\n\n' + claudeReply);
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
    prompt += 'Location: ' + (existingData.location || '') + '\n';
    prompt += 'Email: ' + (existingData.email || '') + '\n';
    prompt += 'Phone: ' + (existingData.phone || '') + '\n';
    if (existingData.summary) prompt += 'Summary: ' + existingData.summary + '\n';
    if (existingData.experience?.length) prompt += 'Experience: ' + JSON.stringify(existingData.experience) + '\n';
    if (existingData.education?.length) prompt += 'Education: ' + JSON.stringify(existingData.education) + '\n';
    if (existingData.skills?.length) prompt += 'Skills: ' + existingData.skills.join(', ') + '\n';
    prompt += '\n';
  }
  prompt += 'Conversation:\n\n' + convText.slice(0, 8000);
  prompt += '\n\nExtract the complete resume data, merging all sources. Preserve existing data and add/update from conversation.';

  try {
    const extraction = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
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
      amount: 7900, // Rs 79 in paise
      currency: 'INR',
      description: 'ResumeWala - Professional Resume Download',
      notes: {
        resume_request_id: resumeReq.id,
        phone: from,
      },
      callback_url: (process.env.BASE_URL || '') + '/razorpay/webhook',
      callback_method: 'get',
    });

    return 'To download your full resume, complete payment:\n\n' +
      link.short_url + '\n\n' +
      'Price: Rs 79 only\n\n' +
      'Your resume will be sent automatically after payment.';
  } catch (err) {
    console.error('Razorpay error:', err);
    return 'Could not create payment link. Please try again.';
  }
}

// ─── DOCX generation ─────────────────────────────────────────────────────────

async function generateDocx(data) {
  const heading = (title) =>
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 26, color: '2E4057' })],
      border: {
        bottom: { color: '2E4057', space: 4, style: BorderStyle.SINGLE, size: 6 },
      },
      spacing: { before: 320, after: 140 },
    });

  const children = [];

  // Name
  children.push(
    new Paragraph({
      children: [new TextRun({ text: data.name || 'Resume', bold: true, size: 48, color: '2E4057' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    })
  );

  // Contact line
  const contactParts = [data.location, data.email, data.phone].filter(Boolean);
  if (contactParts.length > 0) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: contactParts.join('  |  '), size: 22, color: '666666' })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
      })
    );
  }

  // Summary
  if (data.summary) {
    children.push(heading('PROFESSIONAL SUMMARY'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.summary, size: 20 })],
        spacing: { after: 120 },
      })
    );
  }

  // Experience
  if (data.experience && data.experience.length > 0) {
    children.push(heading('WORK EXPERIENCE'));
    for (const exp of data.experience) {
      if (typeof exp === 'object') {
        const line = [exp.title, exp.company, exp.duration].filter(Boolean).join('  |  ');
        children.push(
          new Paragraph({ children: [new TextRun({ text: line, bold: true, size: 22 })], spacing: { before: 80 } })
        );
        if (exp.responsibilities) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: exp.responsibilities, size: 20 })],
              spacing: { after: 100 },
            })
          );
        }
      } else {
        children.push(
          new Paragraph({ children: [new TextRun({ text: String(exp), size: 20 })], spacing: { after: 80 } })
        );
      }
    }
  }

  // Education
  if (data.education && data.education.length > 0) {
    children.push(heading('EDUCATION'));
    for (const edu of data.education) {
      if (typeof edu === 'object') {
        const line = [edu.degree, edu.institution].filter(Boolean).join('  |  ');
        children.push(
          new Paragraph({ children: [new TextRun({ text: line, bold: true, size: 22 })] })
        );
        if (edu.year) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: edu.year, size: 20, color: '888888' })],
              spacing: { after: 100 },
            })
          );
        }
      } else {
        children.push(
          new Paragraph({ children: [new TextRun({ text: String(edu), size: 20 })], spacing: { after: 80 } })
        );
      }
    }
  }

  // Skills
  if (data.skills && data.skills.length > 0) {
    children.push(heading('SKILLS'));
    const skillTexts = data.skills.map(s => typeof s === 'string' ? s : String(s));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: skillTexts.join('  \u2022  '), size: 20 })],
        spacing: { after: 100 },
      })
    );
  }

  // Projects
  if (data.projects && data.projects.length > 0) {
    children.push(heading('PROJECTS'));
    for (const proj of data.projects) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: String(proj), size: 20 })], spacing: { after: 80 } })
      );
    }
  }

  // Certifications
  if (data.certifications && data.certifications.length > 0) {
    children.push(heading('CERTIFICATIONS'));
    for (const cert of data.certifications) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: String(cert), size: 20 })], spacing: { after: 80 } })
      );
    }
  }

  // Achievements
  if (data.achievements && data.achievements.length > 0) {
    children.push(heading('ACHIEVEMENTS'));
    for (const ach of data.achievements) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: String(ach), size: 20 })], spacing: { after: 80 } })
      );
    }
  }

  // Tools
  if (data.tools && data.tools.length > 0) {
    children.push(heading('TOOLS & TECHNOLOGIES'));
    const toolTexts = data.tools.map(t => typeof t === 'string' ? t : String(t));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: toolTexts.join('  \u2022  '), size: 20 })],
        spacing: { after: 100 },
      })
    );
  }

  // Hobbies
  if (data.hobbies && data.hobbies.length > 0) {
    children.push(heading('HOBBIES & INTERESTS'));
    const hobbyTexts = data.hobbies.map(h => typeof h === 'string' ? h : String(h));
    children.push(
      new Paragraph({ children: [new TextRun({ text: hobbyTexts.join(', '), size: 20 })] })
    );
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } },
      },
      children,
    }],
  });

  const docBuffer = await Packer.toBuffer(doc);
  const filePath = path.join(os.tmpdir(), `resume-${crypto.randomUUID()}.docx`);
  fs.writeFileSync(filePath, docBuffer);
  return filePath;
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

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
