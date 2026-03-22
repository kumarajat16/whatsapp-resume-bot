const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const Groq = require('groq-sdk');
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
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Root endpoint (health check) ───────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("ResumeWala.ai is running");
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

// ─── Meta WhatsApp Cloud API helper ──────────────────────────────────────────

const WA_API_URL = `https://graph.facebook.com/v22.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;

async function sendWhatsApp(to, body) {
  const truncated = body.length > 1200 ? body.slice(0, 1197) + '...' : body;
  console.log('[OUT]', to, '|', truncated.slice(0, 120));
  const res = await fetch(WA_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: truncated },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[WA API ERROR]', res.status, err);
  }
}

// ─── Filler message batches (randomized per scenario) ────────────────────────

const VOICE_FILLER_BATCHES = [
  [
    '🎧 Listening to your voice note…',
    '✍️ Transcribing what you said…',
    '🧠 Understanding your experience…',
  ],
  [
    '🎙️ Got your voice message.',
    '📝 Converting it into text…',
    '🔍 Extracting key details…',
  ],
  [
    '🎧 Playing your voice note…',
    '💬 Processing what you shared…',
    '✨ Almost ready…',
  ],
];

const RESUME_PARSE_BATCHES = [
  [
    '📄 Scanning your resume…',
    '🔍 Understanding your work experience…',
    '✨ Identifying your skills…',
  ],
  [
    '📋 Reading through your resume…',
    '🧠 Analyzing your career journey…',
    '📊 Extracting key achievements…',
  ],
  [
    '📄 Got your file! Diving in…',
    '💼 Reviewing your professional background…',
    '🎯 Almost done reviewing your profile…',
  ],
];

const RESUME_GEN_BATCHES = [
  [
    '📝 Putting your resume together…',
    '🎨 Formatting it professionally…',
    '✅ Almost done!',
  ],
  [
    '⚙️ Generating your resume…',
    '💼 Making it recruiter-ready…',
    '🚀 Finishing up!',
  ],
  [
    '🛠️ Building your resume…',
    '📐 Applying professional layout…',
    '✨ Final touches!',
  ],
];

function pickBatch(batches) {
  return batches[Math.floor(Math.random() * batches.length)];
}

async function sendFillerMessages(to, batches, delayMs = 2500) {
  const batch = pickBatch(batches);
  for (let i = 0; i < batch.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, delayMs));
    await sendWhatsApp(to, batch[i]);
  }
}

// Legacy wrapper for resume parsing progress
async function sendProgressMessages(to, count) {
  await sendFillerMessages(to, RESUME_PARSE_BATCHES, 3000);
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are *ResumeWala* — a warm, professional WhatsApp resume-building assistant for Indian job seekers.

YOUR APPROACH:
You are a friendly career advisor chatting on WhatsApp. You do NOT behave like a rigid form. You have natural conversations.

FIRST MESSAGE:
When a user messages for the first time, warmly greet them and ask whether they'd like to:
- Upload an existing resume (PDF/Word) for improvement
- Or create a new one from scratch by just talking to you

Be conversational. Do NOT use numbered menus. Mention they can also send voice notes 🎤.

CREATE-FROM-SCRATCH FLOW:
Instead of asking rigid questions one by one, start with a single open-ended prompt like:

"Tell me about yourself — your education, work experience, skills, projects, achievements. Just share your journey and I'll turn it into a strong resume."

Then mention: "You can type your answer or send a voice note 🎤 — whatever's easier."

After the user responds:
1. Extract all the information they shared
2. Assess how much you have — if you have enough for 60-70% of a one-page resume, tell them:
   "I already have a solid foundation for your resume! I can generate it now if you'd like."
   Then suggest additional details that would make it stronger (projects, metrics, tools, certifications).
3. If information is still limited, ask 1-2 conversational follow-up questions about the gaps — NOT rigid form questions.

FOLLOW-UP STYLE:
- "Did you work on any interesting projects you'd like to highlight?"
- "Any achievements you're especially proud of — awards, numbers, milestones?"
- "What tools or technologies do you work with most?"
- NEVER ask like: "Name:", "Address:", "Phone:"

WHEN USER IS DONE:
If the user says "that's all", "nothing else", "done", "generate", or similar — proceed to generate.
Even if content is limited, generate the best possible resume with what you have.

When ready to generate, say something like:
"Great, I have what I need! Reply *YES* and I'll generate your resume."

When user confirms YES/yes/y, respond with EXACTLY: GENERATE_RESUME
Do not add any other text with GENERATE_RESUME.

IMPROVE FLOW:
If user wants to improve an existing resume, ask them to upload their PDF or Word file.

VOICE NOTE REMINDERS:
Occasionally (not every message) remind users they can send voice notes 🎤.

FORMATTING RULES (critical):
- Use *asterisks* for bold on key words, names, sections
- Use - (hyphen) as bullet points
- Break messages into short paragraphs with blank lines
- Keep messages scannable — like ChatGPT on WhatsApp
- Maximum 1-2 questions per message
- If response would be long, split into focused parts

CONVERSATION RULES:
- Be warm, encouraging, concise
- NEVER re-ask for information already provided
- For experience, coach users on ACTION + IMPACT + METRIC
- If user gives vague answers, probe deeper with examples
- Stay on topic — redirect off-topic gently
- Do NOT answer general knowledge, jokes, or unrelated questions`;

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

const WELCOME_MSG = null; // No longer used — all conversations are AI-driven

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
    GROQ_API_KEY: !!process.env.GROQ_API_KEY,
    WA_PHONE_NUMBER_ID: !!process.env.WA_PHONE_NUMBER_ID,
    WA_ACCESS_TOKEN: !!process.env.WA_ACCESS_TOKEN,
    DATABASE_URL: !!process.env.DATABASE_URL,
    RAZORPAY: RAZORPAY_ENABLED,
    BASE_URL: process.env.BASE_URL || 'NOT SET',
  });
});

// ─── WhatsApp Cloud API Webhook ──────────────────────────────────────────────

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  // Process in background
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Log for debugging
    console.log("[WEBHOOK]", JSON.stringify(req.body, null, 2));

    // Only process actual incoming messages (not status updates)
    const message = value?.messages?.[0];
    if (!message) return;

    const from = message.from; // phone number without +
    const msgType = message.type;

    if (msgType === 'text') {
      const incomingMsg = message.text?.body || '';
      console.log('[IN]', from, '|', incomingMsg);
      handleIncomingMessage(from, incomingMsg).catch(err => {
        console.error('MESSAGE HANDLER ERROR:', err);
      });
    } else if (msgType === 'audio') {
      const mediaId = message.audio?.id;
      const mimeType = message.audio?.mime_type || 'audio/ogg';
      console.log('[IN]', from, '| [VOICE:', mimeType, ']');
      console.log('[VOICE_RECEIVED]', from);
      handleAudioMessage(from, mediaId, mimeType).catch(err => {
        console.error('AUDIO HANDLER ERROR:', err);
      });
    } else if (msgType === 'document' || msgType === 'image') {
      // Media messages (PDF/docx uploads)
      const mediaId = message.document?.id || message.image?.id;
      const mimeType = message.document?.mime_type || message.image?.mime_type || '';
      const caption = message.document?.caption || message.image?.caption || '';
      console.log('[IN]', from, '| [MEDIA:', mimeType, ']');
      handleMediaMessage(from, mediaId, mimeType, caption).catch(err => {
        console.error('MEDIA HANDLER ERROR:', err);
      });
    } else {
      console.log('[IN]', from, '| [UNSUPPORTED:', msgType, ']');
    }
  } catch (err) {
    console.error('WEBHOOK PROCESSING ERROR:', err);
  }
});

// ─── Incoming message dispatcher ────────────────────────────────────────────

async function handleIncomingMessage(from, incomingMsg) {
  try {
    const user = await db.findOrCreateUser(from);
    await db.resetDailyLimitsIfNeeded(user.id);

    const limits = await db.getUserLimits(user.id);
    if (limits.daily_messages >= DAILY_MESSAGE_LIMIT) {
      await sendWhatsApp(from, 'System usage limit reached. Please try again tomorrow.');
      return;
    }
    await db.incrementMessageCount(user.id);

    const reply = await handleMessage(from, user, incomingMsg);

    // Split long messages into chunks for WhatsApp readability
    const chunks = splitMessage(reply);
    for (const chunk of chunks) {
      await sendWhatsApp(from, chunk);
    }
  } catch (err) {
    console.error('HANDLE INCOMING ERROR:', err);
    await sendWhatsApp(from, 'Something went wrong. Please try again.').catch(console.error);
  }
}

// Split long messages into WhatsApp-friendly chunks at paragraph boundaries
function splitMessage(text, maxLen = 1100) {
  if (!text || text.length <= maxLen) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2) > maxLen) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 0 ? chunks : [text];
}

async function handleMediaMessage(from, mediaId, mimeType, caption) {
  try {
    const user = await db.findOrCreateUser(from);
    await db.resetDailyLimitsIfNeeded(user.id);

    const limits = await db.getUserLimits(user.id);
    if (limits.daily_messages >= DAILY_MESSAGE_LIMIT) {
      await sendWhatsApp(from, 'System usage limit reached. Please try again tomorrow.');
      return;
    }
    await db.incrementMessageCount(user.id);

    const supportedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];

    if (!supportedTypes.includes(mimeType)) {
      await sendWhatsApp(from, 'I can only read *PDF* or *Word (.docx)* files.\n\nPlease send one of those, or just tell me you\'d like to create a resume from scratch and I\'ll guide you through it!');
      return;
    }

    await sendWhatsApp(from, 'Great! I received your resume. Let me read it carefully.');

    // Download media from Meta API
    const { buffer, tmpPath } = await downloadWhatsAppMedia(mediaId, mimeType);

    await processMediaUpload(from, user.id, buffer, tmpPath, mimeType).catch(err => {
      console.error('Media processing error:', err);
      sendWhatsApp(from, 'Could not process your file. Please try again or tell me you\'d like to create a resume from scratch.').catch(console.error);
    });
  } catch (err) {
    console.error('HANDLE MEDIA ERROR:', err);
    await sendWhatsApp(from, 'Something went wrong. Please try again.').catch(console.error);
  }
}

// ─── Voice message handler ───────────────────────────────────────────────────

async function handleAudioMessage(from, mediaId, mimeType) {
  try {
    const user = await db.findOrCreateUser(from);
    await db.resetDailyLimitsIfNeeded(user.id);

    const limits = await db.getUserLimits(user.id);
    if (limits.daily_messages >= DAILY_MESSAGE_LIMIT) {
      await sendWhatsApp(from, 'System usage limit reached. Please try again tomorrow.');
      return;
    }
    await db.incrementMessageCount(user.id);

    // Step 1: Send filler messages FIRST (blocking — must complete before AI reply)
    await sendFillerMessages(from, VOICE_FILLER_BATCHES, 1500);

    // Step 2: Download audio file
    let audioPath;
    try {
      audioPath = await downloadAudioFile(mediaId);
      console.log('[VOICE_DOWNLOADED]', from, audioPath);
    } catch (err) {
      console.error('[VOICE_DOWNLOAD_ERROR]', err.message);
      await sendWhatsApp(from, 'Could not download your voice note. Please try sending it again or type your message instead.');
      return;
    }

    // Check file size
    const stats = fs.statSync(audioPath);
    if (stats.size > 10 * 1024 * 1024) {
      fs.unlink(audioPath, () => {});
      await sendWhatsApp(from, 'For best results please keep voice notes under 1 minute so I can understand them properly.');
      return;
    }

    // Step 3: Transcribe audio
    let transcription;
    try {
      transcription = await transcribeAudio(audioPath);
      console.log('[VOICE_TRANSCRIBED]', from);
      console.log('[TRANSCRIPTION_TEXT]', transcription);
    } catch (err) {
      console.error('[VOICE_TRANSCRIPTION_ERROR]', err.message);
      fs.unlink(audioPath, () => {});
      await sendWhatsApp(from, "I couldn't clearly understand the audio. Could you try sending the voice note again or type the message?");
      return;
    } finally {
      fs.unlink(audioPath, () => {});
    }

    if (!transcription || !transcription.trim()) {
      await sendWhatsApp(from, "I couldn't clearly understand the audio. Could you try sending the voice note again or type the message?");
      return;
    }

    // Step 4: Process with AI — filler already sent, AI reply comes LAST
    const reply = await handleMessage(from, user, transcription.trim());
    const chunks = splitMessage(reply);
    for (const chunk of chunks) {
      await sendWhatsApp(from, chunk);
    }
  } catch (err) {
    console.error('HANDLE AUDIO ERROR:', err);
    await sendWhatsApp(from, 'Something went wrong processing your voice note. Please try again or type your message.').catch(console.error);
  }
}

async function downloadAudioFile(mediaId) {
  // Step 1: Get media URL from Meta
  const urlRes = await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}` },
  });
  if (!urlRes.ok) {
    throw new Error('Audio media URL fetch failed: ' + urlRes.status);
  }
  const { url } = await urlRes.json();

  // Step 2: Download the audio binary
  const mediaRes = await fetch(url, {
    headers: { 'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}` },
  });
  if (!mediaRes.ok) {
    throw new Error('Audio download failed: ' + mediaRes.status);
  }

  const arrayBuffer = await mediaRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const audioPath = path.join(os.tmpdir(), `audio-${crypto.randomUUID()}.ogg`);
  fs.writeFileSync(audioPath, buffer);
  return audioPath;
}

async function transcribeAudio(audioPath) {
  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-large-v3',
    response_format: 'text',
  });
  return transcription;
}

// ─── Routes (continued) ─────────────────────────────────────────────────────

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

app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>ResumeWala Privacy Policy</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;padding:0 20px;color:#333;line-height:1.7}
h1{color:#1F3864;font-size:24px}h2{color:#1F3864;font-size:18px;margin-top:30px}p{margin:10px 0}
.footer{margin-top:40px;color:#888;font-size:13px}</style></head>
<body>
<h1>ResumeWala Privacy Policy</h1>
<p><strong>Effective Date:</strong> March 2026</p>

<h2>What We Collect</h2>
<p>ResumeWala collects resume files, voice notes, and text inputs you share via WhatsApp solely for the purpose of generating and improving your resume.</p>

<h2>How We Use Your Data</h2>
<p>Your data is processed by AI services (including Anthropic Claude and Groq) to extract resume information, transcribe voice messages, and generate professional resumes. Files are temporarily stored during processing and deleted automatically.</p>

<h2>Data Sharing</h2>
<p>Your data is not sold or shared with third parties. It is only sent to AI service providers as needed to generate your resume.</p>

<h2>Data Retention</h2>
<p>Uploaded files are deleted within 15 minutes of processing. Conversation data is stored to maintain your resume-building session. Generated resume download links expire within 15 minutes.</p>

<h2>Your Rights</h2>
<p>You can request deletion of all your data at any time by messaging "delete my data" on WhatsApp or contacting us directly.</p>

<h2>Contact</h2>
<p>For any privacy concerns, reach out to us via WhatsApp or email.</p>

<p class="footer">ResumeWala.ai — Built for Indian job seekers.</p>
</body></html>`);
});

// Razorpay webhook
if (RAZORPAY_ENABLED) {
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


// ─── Message handler (AI-driven) ─────────────────────────────────────────────

async function handleMessage(from, user, incomingMsg) {
  const lower = incomingMsg.toLowerCase().trim();

  // Menu / restart — abandon current session and start fresh with AI
  if (lower === 'menu' || lower === 'restart' || lower === '0') {
    const active = await db.getActiveResumeRequest(user.id);
    if (active) await db.updateResumeRequestStatus(active.id, 'abandoned');
    const freshReq = await db.createResumeRequest(user.id, 'create');
    await db.updateResumeRequestStatus(freshReq.id, 'collecting_data');
    const reply = await askClaude(freshReq.id, 'Hi, I want to start over.');
    return reply;
  }

  let resumeReq = await db.getActiveResumeRequest(user.id);

  // No active request — create one and let AI handle the conversation
  if (!resumeReq) {
    resumeReq = await db.createResumeRequest(user.id, 'create');
    await db.updateResumeRequestStatus(resumeReq.id, 'collecting_data');
    const reply = await askClaude(resumeReq.id, incomingMsg);
    return reply;
  }

  return await handleActiveSession(from, user, resumeReq, incomingMsg);
}

async function handleActiveSession(from, user, resumeReq, incomingMsg) {
  const lower = incomingMsg.toLowerCase().trim();
  const status = resumeReq.status;

  // ─── awaiting_input: waiting for file (improve flow) or first message
  if (status === 'awaiting_input') {
    if (resumeReq.flow === 'improve') {
      // User said they want to improve but hasn't uploaded yet — remind via AI
      const reply = await askClaude(resumeReq.id, incomingMsg);
      return reply;
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

    // Check if user wants to upload a resume (switch to improve flow)
    if (lower.includes('upload') || lower.includes('improve') || lower.includes('existing resume')) {
      await db.updateResumeRequestFlow(resumeReq.id, 'improve');
      await db.updateResumeRequestStatus(resumeReq.id, 'awaiting_input');
      return 'Sure! Just send me your resume file — I accept *PDF* or *Word (.docx)* files.\n\nI\'ll read through it carefully and help you make it even better.';
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
      const freshReq = await db.createResumeRequest(user.id, 'create');
      await db.updateResumeRequestStatus(freshReq.id, 'collecting_data');
      const reply = await askClaude(freshReq.id, 'Hi, I want to start a new resume.');
      return reply;
    }
    if (RAZORPAY_ENABLED) {
      return 'Reply:\n*1* - Get payment link\n*2* - Edit something\n*3* - Start over';
    }
    return 'Reply:\n*1* - Download resume\n*2* - Edit something\n*3* - Start over';
  }

  // ─── paid: payment received, generating
  if (status === 'paid') {
    return 'Your payment was received! Resume is being generated...';
  }

  // ─── generating
  if (status === 'generating') {
    return 'Your resume is being generated. Please wait a moment...';
  }

  // ─── completed: start fresh with AI
  if (status === 'completed') {
    const freshReq = await db.createResumeRequest(user.id, 'create');
    await db.updateResumeRequestStatus(freshReq.id, 'collecting_data');
    const reply = await askClaude(freshReq.id, incomingMsg);
    return reply;
  }

  // Fallback — start fresh with AI
  const freshReq = await db.createResumeRequest(user.id, 'create');
  await db.updateResumeRequestStatus(freshReq.id, 'collecting_data');
  const reply = await askClaude(freshReq.id, incomingMsg);
  return reply;
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
  // Send filler messages FIRST, then process
  await sendFillerMessages(from, RESUME_GEN_BATCHES, 2500);

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

async function processMediaUpload(from, userId, buffer, tmpPath, contentType) {
  // Ensure active request exists
  let resumeReq = await db.getActiveResumeRequest(userId);
  if (!resumeReq) {
    resumeReq = await db.createResumeRequest(userId, 'improve');
  }
  if (!resumeReq.flow) {
    await db.updateResumeRequestFlow(resumeReq.id, 'improve');
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

  // Send filler messages FIRST (blocking), then process
  await sendFillerMessages(from, RESUME_PARSE_BATCHES, 2500);

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

// ─── Download WhatsApp media (Meta Cloud API) ───────────────────────────────

async function downloadWhatsAppMedia(mediaId, contentType) {
  // Step 1: Get media URL from Meta
  const urlRes = await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}` },
  });
  if (!urlRes.ok) {
    throw new Error('Media URL fetch failed: ' + urlRes.status);
  }
  const { url } = await urlRes.json();

  // Step 2: Download the actual file
  const mediaRes = await fetch(url, {
    headers: { 'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}` },
  });
  if (!mediaRes.ok) {
    throw new Error('Media download failed: ' + mediaRes.status);
  }

  const arrayBuffer = await mediaRes.arrayBuffer();
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

// ─── DOCX generation ─────────────────────────────────────────────────────────

async function generateDocx(data) {
  const children = [];

  // ── Section heading with bottom border and clear spacing
  const sectionHeading = (title) =>
    new Paragraph({
      children: [new TextRun({ text: title.toUpperCase(), bold: true, size: 24, font: 'Calibri', color: '1F3864' })],
      border: {
        bottom: { color: '1F3864', space: 6, style: BorderStyle.SINGLE, size: 8 },
      },
      spacing: { before: 400, after: 200 },
    });

  // ── Bullet paragraph with hanging indent and strategic bold
  const bulletParagraph = (text) => {
    // Bold metric phrases: number + nearby context (e.g. "35% growth", "₹5L+ revenue", "10,000+ customers")
    const metricPattern = /((?:[₹$])\s*\d+[\d,.]*\s*[KkMmLl]*(?:\s*(?:Cr|cr|Lakh|lakh|crore))?\s*\+?\s*(?:revenue|users|customers|leads|growth|improvement|reduction|increase)?|\d+[\d,.]*\s*[%xX]+(?:\s+(?:growth|improvement|increase|reduction|conversion|revenue|ROI|margin))?|\d+[\d,.]*\s*\+?\s*(?:users|customers|leads|members|participants|team|employees|stores|cities|brands|clients|partners|campaigns|experiments|projects|products|months|years|weeks|days|cr|lakh|Cr|Lakh|crore|million|billion|[KkMm])\w*)/gi;
    const parts = text.split(metricPattern);
    const runs = [];
    for (const part of parts) {
      if (!part) continue;
      if (metricPattern.test(part)) {
        metricPattern.lastIndex = 0; // reset regex state
        runs.push(new TextRun({ text: part, bold: true, size: 21, font: 'Calibri' }));
      } else {
        runs.push(new TextRun({ text: part, size: 21, font: 'Calibri' }));
      }
    }
    return new Paragraph({
      children: [new TextRun({ text: '\u2022  ', size: 21, font: 'Calibri' }), ...runs],
      spacing: { after: 60, line: 264 },
      indent: { left: 360, hanging: 180 },
    });
  };

  // ═══════════════════════════════════════════════════════════════
  // NAME
  // ═══════════════════════════════════════════════════════════════
  children.push(
    new Paragraph({
      children: [new TextRun({ text: (data.name || 'Resume').toUpperCase(), bold: true, size: 48, font: 'Calibri', color: '1F3864' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
    })
  );

  // ── Headline (e.g., "Product Manager | Growth & Analytics")
  if (data.headline) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.headline, size: 24, font: 'Calibri', color: '404040', italics: true })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
      })
    );
  }

  // ── Contact line
  const contactParts = [data.location, data.email, data.phone].filter(Boolean);
  if (contactParts.length > 0) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: contactParts.join('  |  '), size: 20, font: 'Calibri', color: '666666' })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
      })
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  if (data.summary) {
    children.push(sectionHeading('Professional Summary'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.summary, size: 21, font: 'Calibri' })],
        spacing: { after: 120 },
      })
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // PROFESSIONAL EXPERIENCE
  // ═══════════════════════════════════════════════════════════════
  if (data.experience && data.experience.length > 0) {
    children.push(sectionHeading('Professional Experience'));

    for (const exp of data.experience) {
      if (typeof exp === 'object') {
        const headerRuns = [];
        if (exp.company) {
          headerRuns.push(new TextRun({ text: exp.company, bold: true, size: 23, font: 'Calibri', color: '1F3864' }));
          if (exp.title) headerRuns.push(new TextRun({ text: '  |  ', size: 23, font: 'Calibri', color: '666666' }));
        }
        if (exp.title) {
          headerRuns.push(new TextRun({ text: exp.title, bold: true, size: 23, font: 'Calibri' }));
        }
        if (exp.duration) {
          headerRuns.push(new TextRun({ text: '  |  ', size: 23, font: 'Calibri', color: '666666' }));
          headerRuns.push(new TextRun({ text: exp.duration, size: 21, font: 'Calibri', color: '666666' }));
        }

        children.push(
          new Paragraph({ children: headerRuns, spacing: { before: 180, after: 40 } })
        );

        if (exp.description) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: exp.description, size: 20, font: 'Calibri', color: '555555', italics: true })],
              spacing: { after: 120 },
            })
          );
        }

        const responsibilities = Array.isArray(exp.responsibilities) ? exp.responsibilities :
          (exp.responsibilities ? [exp.responsibilities] : []);

        for (const resp of responsibilities) {
          children.push(bulletParagraph(String(resp)));
        }
      } else {
        children.push(bulletParagraph(String(exp)));
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PROJECTS
  // ═══════════════════════════════════════════════════════════════
  if (data.projects && data.projects.length > 0) {
    children.push(sectionHeading('Projects'));
    for (const proj of data.projects) {
      children.push(bulletParagraph(String(proj)));
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EDUCATION
  // ═══════════════════════════════════════════════════════════════
  if (data.education && data.education.length > 0) {
    children.push(sectionHeading('Education'));
    for (const edu of data.education) {
      if (typeof edu === 'object') {
        const runs = [];
        if (edu.degree) runs.push(new TextRun({ text: edu.degree, bold: true, size: 23, font: 'Calibri' }));
        if (edu.institution) {
          if (runs.length) runs.push(new TextRun({ text: '\n', size: 21, font: 'Calibri' }));
          runs.push(new TextRun({ text: edu.institution, size: 21, font: 'Calibri', color: '1F3864', bold: true }));
        }
        if (edu.year) {
          runs.push(new TextRun({ text: '  |  ', size: 21, font: 'Calibri', color: '666666' }));
          runs.push(new TextRun({ text: edu.year, size: 21, font: 'Calibri', color: '666666' }));
        }
        children.push(
          new Paragraph({ children: runs, spacing: { before: 80, after: 100 } })
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

  // ═══════════════════════════════════════════════════════════════
  // SKILLS (pipe-separated)
  // ═══════════════════════════════════════════════════════════════
  const skillsList = (data.skills || []).map(s => typeof s === 'string' ? s : String(s));
  if (skillsList.length > 0) {
    children.push(sectionHeading('Skills'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: skillsList.join('  |  '), size: 21, font: 'Calibri' })],
        spacing: { after: 120 },
      })
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // ACHIEVEMENTS
  // ═══════════════════════════════════════════════════════════════
  if (data.achievements && data.achievements.length > 0) {
    children.push(sectionHeading('Achievements'));
    for (const ach of data.achievements) {
      children.push(bulletParagraph(String(ach)));
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CERTIFICATIONS
  // ═══════════════════════════════════════════════════════════════
  if (data.certifications && data.certifications.length > 0) {
    children.push(sectionHeading('Certifications'));
    for (const cert of data.certifications) {
      children.push(bulletParagraph(String(cert)));
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TOOLS (pipe-separated)
  // ═══════════════════════════════════════════════════════════════
  const toolsList = (data.tools || []).map(t => typeof t === 'string' ? t : String(t));
  if (toolsList.length > 0) {
    children.push(sectionHeading('Tools'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: toolsList.join('  |  '), size: 21, font: 'Calibri' })],
        spacing: { after: 120 },
      })
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // LEADERSHIP EXPERIENCE
  // ═══════════════════════════════════════════════════════════════
  if (data.leadership && data.leadership.length > 0) {
    children.push(sectionHeading('Leadership Experience'));
    for (const item of data.leadership) {
      if (typeof item === 'object' && item.title) {
        const headerRuns = [];
        if (item.title) headerRuns.push(new TextRun({ text: item.title, bold: true, size: 23, font: 'Calibri' }));
        if (item.company) {
          headerRuns.push(new TextRun({ text: '  |  ', size: 23, font: 'Calibri', color: '666666' }));
          headerRuns.push(new TextRun({ text: item.company, bold: true, size: 23, font: 'Calibri', color: '1F3864' }));
        }
        if (item.duration) {
          headerRuns.push(new TextRun({ text: '  |  ', size: 23, font: 'Calibri', color: '666666' }));
          headerRuns.push(new TextRun({ text: item.duration, size: 21, font: 'Calibri', color: '666666' }));
        }
        children.push(
          new Paragraph({ children: headerRuns, spacing: { before: 120, after: 40 } })
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

  // ═══════════════════════════════════════════════════════════════
  // LANGUAGES (pipe-separated)
  // ═══════════════════════════════════════════════════════════════
  const langList = (data.languages || []).map(l => typeof l === 'string' ? l : String(l));
  if (langList.length > 0) {
    children.push(sectionHeading('Languages'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: langList.join('  |  '), size: 21, font: 'Calibri' })],
        spacing: { after: 120 },
      })
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // HOBBIES
  // ═══════════════════════════════════════════════════════════════
  if (data.hobbies && data.hobbies.length > 0) {
    children.push(sectionHeading('Hobbies & Interests'));
    const hobbyTexts = data.hobbies.map(h => typeof h === 'string' ? h : String(h));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: hobbyTexts.join('  |  '), size: 21, font: 'Calibri' })],
      })
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

// ─── PDF generation ──────────────────────────────────────────────────────────

async function generatePdf(data) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(os.tmpdir(), `resume-${crypto.randomUUID()}.pdf`);
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: (data.name || 'Resume') + ' - Resume',
        Author: 'ResumeWala.ai',
      },
    });

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const NAVY = '#1F3864';
    const GRAY = '#666666';
    const BLACK = '#000000';

    // Name
    doc.fontSize(22).fillColor(NAVY).font('Helvetica-Bold')
      .text((data.name || 'Resume').toUpperCase(), { align: 'center' });

    // Headline
    if (data.headline) {
      doc.fontSize(11).fillColor(GRAY).font('Helvetica-Oblique')
        .text(data.headline, { align: 'center' });
    }

    // Contact
    const contactParts = [data.location, data.email, data.phone].filter(Boolean);
    if (contactParts.length > 0) {
      doc.fontSize(9).fillColor(GRAY).font('Helvetica')
        .text(contactParts.join('  |  '), { align: 'center' });
    }

    doc.moveDown(0.5);

    // Helper: section heading with line and clear spacing
    const pdfSectionHeading = (title) => {
      doc.moveDown(0.6);
      doc.fontSize(11).fillColor(NAVY).font('Helvetica-Bold')
        .text(title.toUpperCase());
      const y = doc.y + 2;
      doc.moveTo(50, y).lineTo(545, y)
        .strokeColor(NAVY).lineWidth(1).stroke();
      doc.moveDown(0.35);
    };

    // Helper: bullet point with hanging indent
    const BULLET_INDENT = 15;
    const pdfBullet = (text) => {
      const startX = 50 + BULLET_INDENT;
      const bulletWidth = doc.font('Helvetica').fontSize(10).widthOfString('\u2022  ');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text('\u2022', startX, doc.y);
      doc.moveUp();
      doc.text(text, startX + bulletWidth, doc.y, {
        width: 545 - startX - bulletWidth,
        lineGap: 2,
      });
    };

    // Summary
    if (data.summary) {
      pdfSectionHeading('Professional Summary');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(data.summary, { lineGap: 2 });
    }

    // Experience
    if (data.experience && data.experience.length > 0) {
      pdfSectionHeading('Professional Experience');
      for (const exp of data.experience) {
        if (typeof exp === 'object') {
          const parts = [exp.company, exp.title, exp.duration].filter(Boolean);
          doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold')
            .text(parts.join('  |  '));
          if (exp.description) {
            doc.fontSize(9).fillColor(GRAY).font('Helvetica-Oblique')
              .text(exp.description);
            doc.moveDown(0.2);
          }
          const resps = Array.isArray(exp.responsibilities) ? exp.responsibilities : [];
          for (const r of resps) {
            pdfBullet(String(r));
          }
          doc.moveDown(0.3);
        } else {
          pdfBullet(String(exp));
        }
      }
    }

    // Projects
    if (data.projects && data.projects.length > 0) {
      pdfSectionHeading('Projects');
      for (const proj of data.projects) {
        pdfBullet(String(proj));
      }
    }

    // Education
    if (data.education && data.education.length > 0) {
      pdfSectionHeading('Education');
      for (const edu of data.education) {
        if (typeof edu === 'object') {
          if (edu.degree) {
            doc.fontSize(10).fillColor(BLACK).font('Helvetica-Bold')
              .text(edu.degree);
          }
          const subParts = [edu.institution, edu.year].filter(Boolean);
          if (subParts.length > 0) {
            doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold')
              .text(subParts.join('  |  '));
          }
        } else {
          doc.fontSize(10).fillColor(BLACK).font('Helvetica')
            .text(String(edu));
        }
        doc.moveDown(0.2);
      }
    }

    // Skills
    const pdfSkills = (data.skills || []).map(s => typeof s === 'string' ? s : String(s));
    if (pdfSkills.length > 0) {
      pdfSectionHeading('Skills');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(pdfSkills.join('  |  '), { lineGap: 2 });
    }

    // Achievements
    if (data.achievements && data.achievements.length > 0) {
      pdfSectionHeading('Achievements');
      for (const ach of data.achievements) {
        pdfBullet(String(ach));
      }
    }

    // Certifications
    if (data.certifications && data.certifications.length > 0) {
      pdfSectionHeading('Certifications');
      for (const cert of data.certifications) {
        pdfBullet(String(cert));
      }
    }

    // Tools
    const pdfTools = (data.tools || []).map(t => typeof t === 'string' ? t : String(t));
    if (pdfTools.length > 0) {
      pdfSectionHeading('Tools');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(pdfTools.join('  |  '), { lineGap: 2 });
    }

    // Leadership
    if (data.leadership && data.leadership.length > 0) {
      pdfSectionHeading('Leadership Experience');
      for (const item of data.leadership) {
        if (typeof item === 'object' && item.title) {
          const parts = [item.title, item.company, item.duration].filter(Boolean);
          doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold')
            .text(parts.join('  |  '));
          const resps = Array.isArray(item.responsibilities) ? item.responsibilities : [];
          for (const r of resps) {
            pdfBullet(String(r));
          }
          doc.moveDown(0.2);
        } else {
          pdfBullet(String(item));
        }
      }
    }

    // Languages
    const pdfLangs = (data.languages || []).map(l => typeof l === 'string' ? l : String(l));
    if (pdfLangs.length > 0) {
      pdfSectionHeading('Languages');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(pdfLangs.join('  |  '), { lineGap: 2 });
    }

    // Hobbies
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
  console.log('--- ResumeWala.ai Startup ---');
  console.log('ENV PORT:', process.env.PORT);
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');
  console.log('WA_PHONE_NUMBER_ID:', process.env.WA_PHONE_NUMBER_ID ? 'SET' : 'NOT SET');
  console.log('WA_ACCESS_TOKEN:', process.env.WA_ACCESS_TOKEN ? 'SET' : 'NOT SET');
  console.log('WA_VERIFY_TOKEN:', process.env.WA_VERIFY_TOKEN ? 'SET' : 'NOT SET');
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET');
  console.log('GROQ_API_KEY:', process.env.GROQ_API_KEY ? 'SET' : 'NOT SET');
  console.log('Starting Express server...');

  await db.initDb();
  console.log('ResumeWala.ai - Database initialized');

  const PORT = process.env.PORT || 8080;
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log('ResumeWala.ai running on port ' + PORT);
    console.log('Razorpay:', RAZORPAY_ENABLED ? 'ENABLED' : 'DISABLED (free mode)');
    console.log('BASE_URL:', process.env.BASE_URL || 'NOT SET');
  });
  server.on('error', (err) => {
    console.error('SERVER ERROR:', err);
  });
}

// ─── Global error handlers (prevent process crash) ──────────────────────────

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received — keeping process alive for Railway');
});

process.on('SIGINT', () => {
  console.log('SIGINT received');
});

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
