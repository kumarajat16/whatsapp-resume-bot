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
const PAYMENT_AMOUNT = 4900; // ₹49 in paise

const RAZORPAY_ENABLED = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
let razorpay = null;
if (RAZORPAY_ENABLED) {
  const Razorpay = require('razorpay');
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

// ─── Admin auth ──────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'resumewala123';
const adminSessions = new Map(); // token -> createdAt

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

function isAdminAuthed(req) {
  const cookies = parseCookies(req);
  const token = cookies.admin_session;
  return !!(token && adminSessions.has(token));
}

function requireAdminAuth(req, res, next) {
  if (!isAdminAuthed(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Temp file store ─────────────────────────────────────────────────────────

const tempFiles = new Map();

const FILE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

function storeTempFile(filePath, filename, expiryMs) {
  const token = crypto.randomUUID();
  setTimeout(() => {
    tempFiles.delete(token);
    fs.unlink(filePath, () => {});
  }, expiryMs || FILE_EXPIRY_MS);
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

// ─── WhatsApp media upload + document send ───────────────────────────────────

const WA_MEDIA_URL = `https://graph.facebook.com/v22.0/${process.env.WA_PHONE_NUMBER_ID}/media`;

async function uploadWhatsAppMedia(filePath, mimeType) {
  const FormData = (await import('node-fetch')).FormData || globalThis.FormData;
  const fileBuffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);

  // Use fetch with multipart form data
  const boundary = '----FormBoundary' + crypto.randomUUID().replace(/-/g, '');
  const bodyParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mimeType}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  ];

  const bodyStart = Buffer.from(bodyParts.join(''));
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([bodyStart, fileBuffer, bodyEnd]);

  const res = await fetch(WA_MEDIA_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[WA MEDIA UPLOAD ERROR]', res.status, err);
    return null;
  }

  const result = await res.json();
  console.log('[WA MEDIA UPLOADED]', result.id);
  return result.id; // media_id
}

async function sendWhatsAppDocument(to, mediaId, filename, caption) {
  console.log('[OUT DOC]', to, '|', filename);
  const res = await fetch(WA_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: {
        id: mediaId,
        filename,
        caption: caption || '',
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[WA DOC SEND ERROR]', res.status, err);
    return false;
  }
  return true;
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

const SYSTEM_PROMPT = `You are *ResumeWala* — a smart, friendly AI career coach that helps people build killer resumes through WhatsApp.

PERSONALITY:
• You're that one sharp friend who's amazing at resumes and genuinely enjoys helping.
• Warm, cheerful, confident, slightly playful — never corporate or robotic.
• Celebrate the user's background. Make them feel great about their career story.
• Say things like "That's a solid background — this resume's going to look great."
• NEVER say things like "Data received." or "Information noted." or "Got it, processing."

LANGUAGE:
• Default: English. First message is always English.
• If the user replies in Hindi or Hinglish, switch naturally.
  Example: User: "resume banana hai" → You: "Perfect 👍 Chaliye banaate hain ek solid resume."
• Don't mix languages randomly. Match the user's language.

MESSAGE STYLE:
• Short messages. One idea per message. No walls of text.
• Use *bold* for emphasis. Use • or - for lists.
• Max 1-2 questions per message. Emojis sparingly.

═══ CONVERSATION FLOW ═══

STEP 1 — GREETING:

Hey! I'm *ResumeWala* 👋

Want to:
1️⃣ Improve your current resume
2️⃣ Create a new one from scratch

STEP 2 — ASK FOR THEIR STORY:
One open-ended question:

"Tell me about yourself — your work experience, education, projects, skills… anything you want on your resume."

Then encourage voice notes:
"You can also just send a voice note if that's easier 🎤 Don't worry about grammar or structure — I'll handle all of that."

STEP 3 — IF ANSWER IS TOO SHORT (e.g. "I'm a software engineer"):
• Acknowledge warmly: "Nice! Software engineering — great field 👌"
• Ask for more, with voice note nudge: "Just tell me a bit more — your experience, projects, companies. A voice note works great if you don't feel like typing 🎤"

STEP 4 — WHEN USER GIVES GOOD INFORMATION:
This is CRITICAL. When the user shares a detailed message, good voice note, or uploads a resume:

Write a RICH acknowledgement (2-3 sentences) that proves you understood them:
• Mention SPECIFIC things they said — college name, company, role, tech stack, domain.
• Point out 1-2 strong angles you'll highlight in the resume.

Examples:
"Nice! B.Tech from IIT Bombay and currently SPM at Naukri — that's already a really strong product profile. I can see some great angles here: product growth, experimentation, cross-functional leadership."

"That's solid — 3 years of backend at Flipkart with Go and Kubernetes. This is going to make a sharp resume. I'll definitely highlight the system design and scale work."

"Okay so MBA from XLRI and 4 years in brand management at HUL — this is a great story. Lots of strong angles like campaign ROI, P&L ownership, and market share impact."

NEVER give a lazy one-liner like "Nice — got it." Prove you actually listened.

Then NATURALLY bridge to payment. End your acknowledgement with something like:
"Before I start building this out — there's one quick step."

Then on the next line, write: SEND_PAYMENT

The system intercepts SEND_PAYMENT. Your acknowledgement text before it gets sent to the user. The system then handles the payment messages.

IMPORTANT: Trigger SEND_PAYMENT after one solid chunk of info. Do NOT ask follow-up questions before payment. You'll collect more details after.

STEP 5 — IF USER MESSAGES INSTEAD OF PAYING:
Stay friendly but guide them back:
"I've got your details saved 🙂 Just complete the quick ₹49 step and we'll jump right back into building your resume."

STEP 6 — AFTER PAYMENT:
The system tells you "Payment received. Continue collecting details." and sends the user a payment confirmation. Do NOT repeat the confirmation yourself.

Now continue the conversation naturally:
• Look at everything the user already shared (text, voice notes, uploaded files).
• Figure out what's ACTUALLY missing for a strong one-page resume.
• Ask ONLY about genuine gaps — never use a fixed list of questions.

Dynamic question examples:
• Missing metrics → "Any numbers you can share? Users impacted, revenue, percentage improvements — stuff like that makes bullets really pop."
• Missing tools → "What tools or tech stack did you use day-to-day?"
• Missing leadership → "Did you lead or mentor anyone? Even informal leadership counts."
• Vague projects → "Tell me more about that project — what was the problem, what did you build, what happened?"

If info seems thin for a full page:
"This might be a bit short for a full one-page resume. I can fill in some relevant achievements and responsibilities based on your role — want me to do that?"

Always add a voice note nudge when asking for details:
"You can type it or just send a quick voice note — whatever's easier 🙂"

STEP 7 — TRIGGER RESUME GENERATION:
When user says "done" / "that's all" / "generate" or you have enough material:
Write EXACTLY: GENERATE_RESUME (nothing else on that line)

GENERATE_RESUME can ONLY happen AFTER payment. Never before.

═══ OTHER FLOWS ═══

IMPROVE FLOW:
If user wants to improve their existing resume, ask them to upload the PDF or Word file.

═══ MEMORY RULES (CRITICAL) ═══

Before asking ANY question, check the full conversation history.
• NEVER re-ask something already answered — whether by text, voice, or file upload.
• If info exists, acknowledge it: "You mentioned SQL and Python — nice, I'll make sure those are prominent."
• Reference earlier details: "You talked about the recommendation engine — any metrics from that?"

═══ CONVERSATION RULES ═══

• Be the kind of resume helper people tell their friends about.
• Coach users toward ACTION + IMPACT + METRIC framing for experience.
• If answers are vague, probe with specific examples.
• Stay on topic. Redirect off-topic gently.
• Do NOT answer random questions, jokes, or general knowledge.
• If user messages during payment_pending, redirect to payment warmly.

You are ResumeWala — the best resume assistant on WhatsApp 🚀`;

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
- No JSON, no markdown headers

Smart Bold Rules for Bullets:
- Use **double asterisks** to bold the most impactful phrases INSIDE each bullet
- Bold 1-2 phrases per bullet maximum. Do NOT bold the entire sentence
- Do NOT bold the first word (action verb) of the bullet
- WHAT TO BOLD:
  - Metrics and numbers: "increased retention by **32%**"
  - Key achievements: "Launched **AI-powered recommendation engine**"
  - Tools/technologies: "using **Python, SQL and Airflow**"
  - Product/feature names: "Built **Smart Job Match Engine**"
  - Leadership scope: "**Led cross-functional team of 6 engineers**"
- NEVER bold generic verbs like Worked, Responsible, Managed
- Example: Built **SQL-based analytics dashboards** enabling leadership to track metrics and improve retention by **18%**`;

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

const RESUME_SUMMARY_PROMPT = `You are a resume analyzer. Given parsed resume data, produce a concise factual summary. Use EXACTLY this format:

Name: [name]
Current Role: [latest role and company]

Past Experience:
- [Role at Company]

Key Achievements:
- [achievement with metric if available]

Skills Mentioned:
[comma-separated list]

Education:
[degree from institution]

Projects:
[project names or one-line descriptions, if any]

Certifications:
[certifications, if any]

Rules:
- Include ALL information from the data — do not omit any section that has content
- Use plain text, no markdown
- Be factual and complete — this summary will be used to avoid asking the user repeated questions
- Omit sections only if the data is truly empty`;

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

// ─── Resume file summary generator ──────────────────────────────────────────

async function generateResumeSummary(data) {
  const dataStr =
    'Name: ' + (data.name || '') + '\n' +
    'Location: ' + (data.location || '') + '\n' +
    'Email: ' + (data.email || '') + '\n' +
    'Phone: ' + (data.phone || '') + '\n' +
    'Headline: ' + (data.headline || '') + '\n' +
    'Summary: ' + (data.summary || '') + '\n' +
    'Education: ' + JSON.stringify(data.education || []) + '\n' +
    'Experience: ' + JSON.stringify(data.experience || []) + '\n' +
    'Skills: ' + JSON.stringify(data.skills || []) + '\n' +
    'Projects: ' + JSON.stringify(data.projects || []) + '\n' +
    'Achievements: ' + JSON.stringify(data.achievements || []) + '\n' +
    'Certifications: ' + JSON.stringify(data.certifications || []) + '\n' +
    'Leadership: ' + JSON.stringify(data.leadership || []) + '\n' +
    'Tools: ' + JSON.stringify(data.tools || []) + '\n' +
    'Languages: ' + JSON.stringify(data.languages || []);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1000,
      system: RESUME_SUMMARY_PROMPT,
      messages: [{ role: 'user', content: 'Summarize this resume data:\n\n' + dataStr }],
    });
    return response.content[0].text;
  } catch (err) {
    console.error('Resume summary generation failed:', err.message);
    // Fallback: build a basic summary manually
    const expList = (data.experience || []).map(e =>
      typeof e === 'object' ? `${e.title || ''} at ${e.company || ''}` : String(e)
    ).join('\n- ');
    return `Name: ${data.name || 'Unknown'}\n` +
      (expList ? `Experience:\n- ${expList}\n` : '') +
      (data.skills?.length ? `Skills: ${data.skills.join(', ')}\n` : '') +
      ((data.education || []).length ? `Education: ${data.education.map(e => typeof e === 'object' ? `${e.degree || ''} from ${e.institution || ''}` : String(e)).join(', ')}\n` : '');
  }
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

function redactText(text) {
  if (!text) return text;
  const s = String(text);
  const midpoint = Math.ceil(s.length / 2);
  const visible = s.slice(0, midpoint);
  const hidden = s.slice(midpoint).replace(/\S/g, '*');
  return visible + hidden;
}

function redactResumeData(data) {
  const r = { ...data };
  r.name = redactText(r.name);
  r.headline = redactText(r.headline);
  r.email = r.email ? '****@****.com' : '';
  r.phone = r.phone ? '+91 ****' : '';
  r.summary = redactText(r.summary);
  r.target_role = redactText(r.target_role);

  r.experience = (data.experience || []).map(exp => {
    if (typeof exp === 'object') {
      return {
        ...exp,
        title: redactText(exp.title),
        company: redactText(exp.company),
        duration: redactText(exp.duration),
        description: redactText(exp.description),
        responsibilities: (exp.responsibilities || []).map(s => redactText(String(s))),
      };
    }
    return redactText(String(exp));
  });

  r.education = (data.education || []).map(edu => {
    if (typeof edu === 'object') {
      return {
        ...edu,
        degree: redactText(edu.degree),
        institution: redactText(edu.institution),
      };
    }
    return redactText(String(edu));
  });

  r.skills = (data.skills || []).map(s => redactText(String(s)));
  r.projects = (data.projects || []).map(s => redactText(String(s)));
  r.certifications = (data.certifications || []).map(s => redactText(String(s)));
  r.achievements = (data.achievements || []).map(s => redactText(String(s)));
  r.tools = (data.tools || []).map(s => redactText(String(s)));

  r.leadership = (data.leadership || []).map(item => {
    if (typeof item === 'object' && item.title) {
      return {
        ...item,
        title: redactText(item.title),
        company: redactText(item.company),
        duration: redactText(item.duration),
        responsibilities: (item.responsibilities || []).map(s => redactText(String(s))),
      };
    }
    return redactText(String(item));
  });

  r.languages = (data.languages || []).map(s => redactText(String(s)));
  r.hobbies = (data.hobbies || []).map(s => redactText(String(s)));

  return r;
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

    // Skip WhatsApp status updates (sent/delivered/read) to avoid log spam
    if (!value || value.statuses) return;

    // Only process actual incoming messages
    const message = value.messages?.[0];
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
      console.log('[IN]', from, '| [VOICE]');
      handleAudioMessage(from, mediaId, mimeType).catch(err => {
        console.error('AUDIO HANDLER ERROR:', err);
      });
    } else if (msgType === 'document' || msgType === 'image') {
      // Media messages (PDF/docx uploads)
      const mediaId = message.document?.id || message.image?.id;
      const mimeType = message.document?.mime_type || message.image?.mime_type || '';
      const caption = message.document?.caption || message.image?.caption || '';
      console.log('[IN]', from, '| [MEDIA]');
      handleMediaMessage(from, mediaId, mimeType, caption).catch(err => {
        console.error('MEDIA HANDLER ERROR:', err);
      });
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

    // Extract ad tracking Ref: XXXXX from message
    const refMatch = incomingMsg.match(/Ref:\s*([A-Z0-9]{4,8})/i);
    if (refMatch) {
      const shortId = refMatch[1].toUpperCase();
      try {
        const tracking = await db.getAdTracking(shortId);
        if (tracking) {
          await db.attachAdTrackingToUser(from, shortId, tracking.fbclid);
          console.log('[AD_TRACKING] Attached', shortId, 'to user', from);
        }
      } catch (trackErr) {
        console.error('[AD_TRACKING] Resolve error:', trackErr);
      }
      // Strip the Ref line so the AI doesn't see it
      incomingMsg = incomingMsg.replace(/\n*Ref:\s*[A-Z0-9]{4,8}/i, '').trim();
    }

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
    await db.tagLastIncomingMessage(from, 'audio').catch(err => console.error('tag audio error:', err.message));
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

// ─── Short tracking ID generator ────────────────────────────────────────────
function generateShortId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

app.get('/start', async (req, res) => {
  // Safely read params — never throw
  const fbclid = (req.query.fbclid && typeof req.query.fbclid === 'string') ? req.query.fbclid : '';
  let shortId = '';
  let safeFbclid = '';

  // Try to create tracking, but never block page render
  try {
    if (fbclid) {
      shortId = generateShortId();
      await db.createAdTracking(shortId, fbclid);
      safeFbclid = fbclid.replace(/[^a-zA-Z0-9_\-]/g, '');
      console.log('[AD_TRACKING] Created:', shortId, 'fbclid=' + fbclid.slice(0, 20) + '...');
    }
  } catch (err) {
    console.error('[AD_TRACKING] Store error (non-fatal):', err.message);
    shortId = '';
    safeFbclid = '';
  }

  const waMessage = shortId
    ? 'Hi ResumeWala, I want to create my professional resume.\n\nRef: ' + shortId
    : 'Hi ResumeWala, I want to create my professional resume.';
  const waUrl = 'https://wa.me/919217232103?text=' + encodeURIComponent(waMessage);

  const pageViewCall = safeFbclid
    ? `fbq('track', 'PageView', { fbclid: '${safeFbclid}' });`
    : `fbq('track', 'PageView');`;

  res.send(`<!DOCTYPE html><html><head><title>ResumeWala - Start on WhatsApp</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '2164200404396165');
${pageViewCall}
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=2164200404396165&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f0f8f0;padding:20px}
.card{background:white;padding:40px 30px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1);text-align:center;max-width:400px;width:100%}
h1{color:#1F3864;font-size:22px;margin-bottom:12px}
p{color:#555;font-size:16px;line-height:1.5;margin-bottom:20px}
.spinner{display:inline-block;width:28px;height:28px;border:3px solid #ddd;border-top-color:#25D366;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:16px}
@keyframes spin{to{transform:rotate(360deg)}}
.btn{display:inline-block;background:#25D366;color:white;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:16px;font-weight:bold}
.btn:active{background:#1da851}
.sub{color:#999;font-size:13px;margin-top:16px}
</style></head>
<body><div class="card">
<div class="spinner"></div>
<h1>Opening WhatsApp...</h1>
<p>We're connecting you to ResumeWala to create your professional resume.</p>
<a class="btn" href="${waUrl}">Start Chat on WhatsApp</a>
<p class="sub">If you're not redirected, tap the button above.</p>
</div>
<script>
setTimeout(function(){
  window.location.href="${waUrl}";
},500);
</script>
</body></html>`);
});

app.get('/payment-success', async (req, res) => {
  const purchaseValue = PAYMENT_AMOUNT / 100;

  // Safely resolve fbclid from ref — never block page render
  let safeFbclid = '';
  try {
    const ref = (req.query.ref && typeof req.query.ref === 'string') ? req.query.ref : '';
    if (ref) {
      const tracking = await db.getAdTracking(ref);
      if (tracking && tracking.fbclid) {
        safeFbclid = tracking.fbclid.replace(/[^a-zA-Z0-9_\-]/g, '');
      }
    }
  } catch (err) {
    console.error('[AD_TRACKING] Resolve error on payment-success (non-fatal):', err.message);
    safeFbclid = '';
  }

  // Build pixel calls — always safe, with or without fbclid
  const pageViewCall = safeFbclid
    ? `fbq('track', 'PageView', { fbclid: '${safeFbclid}' });`
    : `fbq('track', 'PageView');`;
  const purchaseCall = safeFbclid
    ? `fbq('track', 'Purchase', { value: ${purchaseValue}, currency: 'INR', fbclid: '${safeFbclid}' });`
    : `fbq('track', 'Purchase', { value: ${purchaseValue}, currency: 'INR' });`;

  res.send(`<!DOCTYPE html><html><head><title>Payment Successful - ResumeWala</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '2164200404396165');
${pageViewCall}
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=2164200404396165&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->
<style>body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f8f0}
.card{background:white;padding:40px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1);text-align:center;max-width:400px}
h1{color:#1F3864;font-size:24px}p{color:#555;font-size:16px;line-height:1.5}
.emoji{font-size:48px;margin-bottom:16px}</style></head>
<body><div class="card"><div class="emoji">🎉</div><h1>Payment Successful!</h1>
<p>You're all set. Head back to WhatsApp and let's continue building your world-class, job-winning resume.</p>
<p style="margin-top:20px;color:#888;font-size:14px">You can close this page now.</p></div>
<!-- Meta Pixel Purchase Event - fires once per unique payment -->
<script>
(function(){
  var params = new URLSearchParams(window.location.search);
  var paymentId = params.get('razorpay_payment_id');
  var status = params.get('razorpay_payment_link_status');
  if (paymentId && status === 'paid') {
    var key = 'fbq_purchase_' + paymentId;
    if (!localStorage.getItem(key)) {
      ${purchaseCall}
      localStorage.setItem(key, '1');
    }
  }
})();
</script>
</body></html>`);
});

app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>ResumeWala Privacy Policy</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '2164200404396165');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=2164200404396165&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->
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

// ─── Admin dashboard ─────────────────────────────────────────────────────────

app.post('/admin/login', (req, res) => {
  const password = req.body?.password || '';
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }
  const token = crypto.randomUUID();
  adminSessions.set(token, Date.now());
  // Session cookie (no Max-Age = expires on browser close)
  res.setHeader('Set-Cookie', `admin_session=${token}; Path=/; HttpOnly; SameSite=Strict`);
  res.json({ success: true });
});

app.post('/admin/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.admin_session) adminSessions.delete(cookies.admin_session);
  res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ success: true });
});

app.get('/admin', (req, res) => {
  if (!isAdminAuthed(req)) {
    return res.send(ADMIN_LOGIN_HTML);
  }
  res.send(ADMIN_DASHBOARD_HTML);
});

app.get('/admin/conversations', requireAdminAuth, async (req, res) => {
  try {
    const { start_date, end_date, state, chat_depth } = req.query;

    const params = [];
    const whereClauses = [];

    // Base query: aggregate messages per user via their resume_requests
    let sql = `
      WITH latest_request AS (
        SELECT DISTINCT ON (user_id) user_id, status, id, pdf_url
        FROM resume_requests
        ORDER BY user_id, created_at DESC
      ),
      message_stats AS (
        SELECT
          rr.user_id,
          MAX(m.created_at) AS last_message_timestamp,
          COUNT(*) FILTER (WHERE m.direction = 'incoming') AS chat_depth,
          COUNT(*) FILTER (WHERE m.message_type = 'audio') AS audio_count,
          COUNT(*) FILTER (WHERE m.message_type = 'document') AS document_count
        FROM messages m
        JOIN resume_requests rr ON m.resume_request_id = rr.id
        GROUP BY rr.user_id
      ),
      payment_info AS (
        SELECT DISTINCT ON (rr.user_id) rr.user_id, p.status AS payment_status, p.updated_at AS payment_at
        FROM payments p
        JOIN resume_requests rr ON p.resume_request_id = rr.id
        ORDER BY rr.user_id, p.created_at DESC
      )
      SELECT
        u.id AS user_id,
        u.phone_number,
        ms.last_message_timestamp,
        COALESCE(lr.status, 'no_session') AS state,
        COALESCE(ms.chat_depth, 0)::int AS chat_depth,
        COALESCE(ms.audio_count, 0)::int AS audio_count,
        COALESCE(ms.document_count, 0)::int AS document_count,
        lr.pdf_url,
        COALESCE(pi.payment_status, 'none') AS payment_status
      FROM users u
      LEFT JOIN latest_request lr ON lr.user_id = u.id
      LEFT JOIN message_stats ms ON ms.user_id = u.id
      LEFT JOIN payment_info pi ON pi.user_id = u.id
    `;

    if (start_date) {
      params.push(start_date);
      whereClauses.push(`ms.last_message_timestamp >= $${params.length}`);
    }
    if (end_date) {
      params.push(end_date);
      whereClauses.push(`ms.last_message_timestamp <= $${params.length}`);
    }
    if (state) {
      params.push(state);
      whereClauses.push(`lr.status = $${params.length}`);
    }
    if (chat_depth) {
      if (chat_depth === '1-5') {
        whereClauses.push(`COALESCE(ms.chat_depth, 0) BETWEEN 1 AND 5`);
      } else if (chat_depth === '6-10') {
        whereClauses.push(`COALESCE(ms.chat_depth, 0) BETWEEN 6 AND 10`);
      } else if (chat_depth === '10+') {
        whereClauses.push(`COALESCE(ms.chat_depth, 0) > 10`);
      }
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    sql += ' ORDER BY ms.last_message_timestamp DESC NULLS LAST LIMIT 500';

    const result = await db.pool.query(sql, params);
    res.json({ rows: result.rows });
  } catch (err) {
    console.error('ADMIN /conversations error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/admin/chat/:phone_number', requireAdminAuth, async (req, res) => {
  try {
    const phone = req.params.phone_number;
    const result = await db.pool.query(
      `SELECT m.direction, m.message_text, m.message_type, m.created_at
       FROM messages m
       JOIN resume_requests rr ON m.resume_request_id = rr.id
       JOIN users u ON rr.user_id = u.id
       WHERE u.phone_number = $1
       ORDER BY m.created_at ASC`,
      [phone]
    );
    const messages = result.rows.map(r => ({
      role: r.direction === 'system' ? 'system' : r.direction === 'incoming' ? 'user' : 'bot',
      message_text: r.message_text,
      message_type: r.message_type,
      timestamp: r.created_at,
    }));
    res.json({ phone_number: phone, messages });
  } catch (err) {
    console.error('ADMIN /chat error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

const ADMIN_LOGIN_HTML = `<!DOCTYPE html><html><head><title>Admin Login - ResumeWala</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f0f2f5}
.card{background:white;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08);width:360px}
h1{color:#1F3864;font-size:22px;margin-bottom:20px;text-align:center}
input{width:100%;padding:12px;border:1px solid #ddd;border-radius:6px;font-size:15px;margin-bottom:12px}
button{width:100%;padding:12px;background:#1F3864;color:white;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#2a4a7a}
.err{color:#c00;font-size:13px;margin-top:8px;min-height:18px}
</style></head>
<body><div class="card">
<h1>Admin Dashboard</h1>
<form id="f">
<input type="password" id="pw" placeholder="Password" autofocus required>
<button type="submit">Login</button>
<div class="err" id="err"></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async function(e){
  e.preventDefault();
  const pw = document.getElementById('pw').value;
  const err = document.getElementById('err');
  err.textContent = '';
  try {
    const r = await fetch('/admin/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({password: pw}),
    });
    if (r.ok) {
      window.location.reload();
    } else {
      err.textContent = 'Invalid password';
    }
  } catch (e) {
    err.textContent = 'Network error';
  }
});
</script>
</div></body></html>`;

const ADMIN_DASHBOARD_HTML = `<!DOCTYPE html><html><head><title>Admin Dashboard - ResumeWala</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,sans-serif;background:#f0f2f5;color:#222;padding:20px}
h1{color:#1F3864;font-size:24px;margin-bottom:16px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.logout{background:#eee;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px}
.logout:hover{background:#ddd}
.filters{background:white;padding:16px;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,0.06);display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin-bottom:16px}
.filter{display:flex;flex-direction:column;gap:4px}
.filter label{font-size:12px;color:#666;font-weight:600}
.filter input,.filter select{padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px}
.filter button{padding:8px 16px;background:#1F3864;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px}
.filter button:hover{background:#2a4a7a}
.filter .reset{background:#eee;color:#333}
.filter .reset:hover{background:#ddd}
.table-wrap{background:white;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,0.06);overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:1100px}
th,td{padding:10px 12px;text-align:left;font-size:13px;border-bottom:1px solid #eee}
th{background:#f8f9fa;color:#555;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;position:sticky;top:0}
tr:hover{background:#fafbfc}
.view-btn{background:#1F3864;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px}
.view-btn:hover{background:#2a4a7a}
.state{display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase}
.state-collecting_data{background:#fff3cd;color:#856404}
.state-payment_pending{background:#fce4ec;color:#880e4f}
.state-payment_completed{background:#d4edda;color:#155724}
.state-generating{background:#e7f3ff;color:#0c63e4}
.state-resume_generated{background:#c8e6c9;color:#1b5e20}
.state-completed{background:#cce5ff;color:#004085}
.state-paid{background:#d4edda;color:#155724}
.state-awaiting_input{background:#e2e3e5;color:#383d41}
.state-abandoned{background:#f8d7da;color:#721c24}
.state-terminated{background:#e0e0e0;color:#424242}
.state-no_session{background:#f8f9fa;color:#666}
.state-preview_ready{background:#d1ecf1;color:#0c5460}
.pay-paid{color:#155724;font-weight:600}
.pay-pending,.pay-created{color:#856404}
.pay-none{color:#999}
.pay-failed{color:#721c24}
.empty{padding:40px;text-align:center;color:#888}
.overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:100;padding:20px}
.overlay.show{display:flex}
.modal{background:white;border-radius:12px;width:100%;max-width:640px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden}
.modal-header{padding:16px 20px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center}
.modal-header h2{font-size:16px;color:#1F3864}
.modal-close{background:none;border:none;font-size:22px;cursor:pointer;color:#888;line-height:1}
.modal-body{flex:1;overflow-y:auto;padding:16px 20px;background:#f8f9fa}
.msg{margin-bottom:12px;max-width:80%;padding:10px 14px;border-radius:10px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}
.msg-user{background:#dcf8c6;margin-left:auto;border-bottom-right-radius:2px}
.msg-bot{background:white;border:1px solid #eee;margin-right:auto;border-bottom-left-radius:2px}
.msg-meta{font-size:10px;color:#888;margin-top:4px}
.msg-type-tag{display:inline-block;background:#ffd700;color:#333;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-right:4px;text-transform:uppercase}
.msg-system{background:#e7f3ff;border:1px dashed #90caf9;margin:8px auto;max-width:60%;text-align:center;font-size:12px;color:#0c63e4;font-weight:600}
.loading{padding:40px;text-align:center;color:#888}
.count{text-align:center;font-weight:600}
</style></head>
<body>
<div class="header">
<h1>Admin Dashboard</h1>
<button class="logout" id="logoutBtn">Logout</button>
</div>

<div class="filters">
<div class="filter">
<label>Start Date</label>
<input type="date" id="startDate">
</div>
<div class="filter">
<label>End Date</label>
<input type="date" id="endDate">
</div>
<div class="filter">
<label>State</label>
<select id="stateFilter">
<option value="">All</option>
<option value="collecting_data">collecting_data</option>
<option value="payment_pending">payment_pending</option>
<option value="payment_completed">payment_completed</option>
<option value="generating">generating</option>
<option value="resume_generated">resume_generated</option>
<option value="completed">completed</option>
<option value="abandoned">abandoned</option>
<option value="terminated">terminated</option>
</select>
</div>
<div class="filter">
<label>Chat Depth</label>
<select id="depthFilter">
<option value="">All</option>
<option value="1-5">1-5 messages</option>
<option value="6-10">6-10 messages</option>
<option value="10+">10+ messages</option>
</select>
</div>
<div class="filter">
<label>&nbsp;</label>
<button id="applyBtn">Apply Filters</button>
</div>
<div class="filter">
<label>&nbsp;</label>
<button class="reset" id="resetBtn">Reset</button>
</div>
</div>

<div class="table-wrap">
<table>
<thead><tr>
<th>User ID</th>
<th>Phone</th>
<th>Chat</th>
<th>Last Active (IST)</th>
<th>State</th>
<th>Audio</th>
<th>Docs</th>
<th>Chat Depth</th>
<th>Payment</th>
<th>Resume</th>
</tr></thead>
<tbody id="tbody"><tr><td colspan="10" class="loading">Loading...</td></tr></tbody>
</table>
</div>

<div class="overlay" id="overlay">
<div class="modal">
<div class="modal-header">
<h2 id="modalTitle">Conversation</h2>
<button class="modal-close" id="modalClose">&times;</button>
</div>
<div class="modal-body" id="modalBody"><div class="loading">Loading...</div></div>
</div>
</div>

<script>
function fmtIST(ts){
  if(!ts)return '-';
  const d=new Date(ts);
  return d.toLocaleString('en-IN',{timeZone:'Asia/Kolkata',year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

async function loadData(){
  const qs=new URLSearchParams();
  const sd=document.getElementById('startDate').value;
  const ed=document.getElementById('endDate').value;
  const st=document.getElementById('stateFilter').value;
  const cd=document.getElementById('depthFilter').value;
  if(sd)qs.set('start_date',sd);
  if(ed)qs.set('end_date',ed+'T23:59:59');
  if(st)qs.set('state',st);
  if(cd)qs.set('chat_depth',cd);
  const tbody=document.getElementById('tbody');
  tbody.innerHTML='<tr><td colspan="10" class="loading">Loading...</td></tr>';
  try{
    const r=await fetch('/admin/conversations?'+qs.toString());
    if(r.status===401){window.location.reload();return;}
    const data=await r.json();
    if(!data.rows||data.rows.length===0){
      tbody.innerHTML='<tr><td colspan="10" class="empty">No users found</td></tr>';
      return;
    }
    tbody.innerHTML=data.rows.map(row=>{
      const state=esc(row.state);
      const ps=esc(row.payment_status||'none');
      const resumeCell=(row.state==='resume_generated'||row.state==='completed')&&row.pdf_url
        ?'<a href="'+esc(row.pdf_url)+'" target="_blank" rel="noopener" class="view-btn" style="text-decoration:none;display:inline-block">View Resume</a>'
        :'<span style="color:#999;font-size:12px">—</span>';
      return '<tr>'+
        '<td>'+esc(String(row.user_id).slice(0,8))+'...</td>'+
        '<td>'+esc(row.phone_number)+'</td>'+
        '<td><button class="view-btn" data-phone="'+esc(row.phone_number)+'">View Chat</button></td>'+
        '<td>'+fmtIST(row.last_message_timestamp)+'</td>'+
        '<td><span class="state state-'+state+'">'+state+'</span></td>'+
        '<td class="count">'+row.audio_count+'</td>'+
        '<td class="count">'+row.document_count+'</td>'+
        '<td class="count">'+row.chat_depth+'</td>'+
        '<td><span class="pay-'+ps+'">'+ps+'</span></td>'+
        '<td>'+resumeCell+'</td>'+
      '</tr>';
    }).join('');
    document.querySelectorAll('.view-btn').forEach(b=>{
      b.addEventListener('click',()=>openChat(b.dataset.phone));
    });
  }catch(e){
    tbody.innerHTML='<tr><td colspan="10" class="empty">Error loading data</td></tr>';
  }
}

async function openChat(phone){
  document.getElementById('modalTitle').textContent='Chat: '+phone;
  document.getElementById('overlay').classList.add('show');
  const body=document.getElementById('modalBody');
  body.innerHTML='<div class="loading">Loading...</div>';
  try{
    const r=await fetch('/admin/chat/'+encodeURIComponent(phone));
    if(r.status===401){window.location.reload();return;}
    const data=await r.json();
    if(!data.messages||data.messages.length===0){
      body.innerHTML='<div class="empty">No messages</div>';
      return;
    }
    body.innerHTML=data.messages.map(m=>{
      if(m.role==='system'){
        return '<div class="msg msg-system">'+esc(m.message_text)+
          '<div class="msg-meta">'+fmtIST(m.timestamp)+'</div></div>';
      }
      const cls=m.role==='user'?'msg-user':'msg-bot';
      const tag=(m.message_type&&m.message_type!=='conversation'&&m.message_type!=='text'&&m.message_type!=='system')?
        '<span class="msg-type-tag">'+esc(m.message_type)+'</span>':'';
      return '<div class="msg '+cls+'">'+tag+esc(m.message_text)+
        '<div class="msg-meta">'+fmtIST(m.timestamp)+'</div></div>';
    }).join('');
    body.scrollTop=body.scrollHeight;
  }catch(e){
    body.innerHTML='<div class="empty">Error loading chat</div>';
  }
}

document.getElementById('applyBtn').addEventListener('click',loadData);
document.getElementById('resetBtn').addEventListener('click',()=>{
  document.getElementById('startDate').value='';
  document.getElementById('endDate').value='';
  document.getElementById('stateFilter').value='';
  document.getElementById('depthFilter').value='';
  loadData();
});
document.getElementById('modalClose').addEventListener('click',()=>{
  document.getElementById('overlay').classList.remove('show');
});
document.getElementById('overlay').addEventListener('click',e=>{
  if(e.target.id==='overlay')document.getElementById('overlay').classList.remove('show');
});
document.getElementById('logoutBtn').addEventListener('click',async()=>{
  await fetch('/admin/logout',{method:'POST'});
  window.location.reload();
});

loadData();
</script>
</body></html>`;

// ─── LinkedIn Profile Discovery (testing tool) ─────────────────────────────

app.get('/linkedin-test', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>LinkedIn Profile Discovery — ResumeWala</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f7fa;color:#333;min-height:100vh}
.header{background:#1F3864;color:white;padding:20px 24px;text-align:center}
.header h1{font-size:22px;font-weight:600}
.header p{font-size:13px;opacity:0.8;margin-top:4px}
.container{max-width:700px;margin:24px auto;padding:0 16px}
.card{background:white;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);padding:24px;margin-bottom:20px}
.card h2{font-size:16px;color:#1F3864;margin-bottom:16px}
label{display:block;font-size:13px;font-weight:600;color:#555;margin-bottom:4px}
input{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;margin-bottom:12px;outline:none;transition:border 0.2s}
input:focus{border-color:#1F3864}
.btn{background:#1F3864;color:white;border:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;width:100%;transition:background 0.2s}
.btn:hover{background:#2a4a7a}
.btn:disabled{background:#999;cursor:not-allowed}
.results{display:none}
.profile-card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:12px;transition:box-shadow 0.2s}
.profile-card:hover{box-shadow:0 2px 8px rgba(0,0,0,0.1)}
.profile-name{font-size:16px;font-weight:700;color:#1F3864}
.profile-headline{font-size:13px;color:#555;margin-top:2px}
.profile-url{font-size:12px;color:#888;margin-top:4px;word-break:break-all}
.profile-actions{margin-top:12px;display:flex;gap:8px}
.btn-sm{padding:8px 16px;font-size:12px;border-radius:6px;border:none;cursor:pointer;font-weight:600}
.btn-confirm{background:#10b981;color:white}
.btn-confirm:hover{background:#059669}
.btn-skip{background:#e5e7eb;color:#555}
.btn-skip:hover{background:#d1d5db}
.loading{text-align:center;padding:24px;color:#888;font-size:14px}
.spinner{display:inline-block;width:20px;height:20px;border:3px solid #ddd;border-top-color:#1F3864;border-radius:50%;animation:spin 0.8s linear infinite;margin-right:8px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.error{background:#fef2f2;color:#dc2626;padding:12px;border-radius:8px;font-size:13px;margin-bottom:12px}
.extracted-data{background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:20px}
.extracted-data h3{font-size:15px;color:#1F3864;margin-bottom:12px}
.data-section{margin-bottom:16px}
.data-section h4{font-size:13px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}
.data-section p,.data-section li{font-size:14px;line-height:1.6}
.data-section ul{padding-left:20px}
.tag{display:inline-block;background:#e0e7ff;color:#3730a3;padding:3px 10px;border-radius:12px;font-size:12px;margin:2px 4px 2px 0}
</style></head><body>
<div class="header">
  <h1>LinkedIn Profile Discovery</h1>
  <p>Internal testing tool — ResumeWala</p>
</div>
<div class="container">
  <div class="card">
    <h2>Search for a LinkedIn Profile</h2>
    <label>Full Name</label>
    <input type="text" id="name" placeholder="Rajat Sharma">
    <label>Company</label>
    <input type="text" id="company" placeholder="Naukri">
    <label>Designation</label>
    <input type="text" id="designation" placeholder="Senior Product Manager">
    <button class="btn" id="searchBtn" onclick="doSearch()">Find LinkedIn Profile</button>
  </div>
  <div id="resultsSection" class="results">
    <div class="card" id="resultsCard"></div>
  </div>
  <div id="extractedSection" style="display:none">
    <div class="card" id="extractedCard"></div>
  </div>
</div>
<script>
const esc = s => {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
};

async function doSearch() {
  const name = document.getElementById('name').value.trim();
  const company = document.getElementById('company').value.trim();
  const designation = document.getElementById('designation').value.trim();
  if (!name) { alert('Please enter a name'); return; }

  const btn = document.getElementById('searchBtn');
  btn.disabled = true;
  btn.textContent = 'Searching…';

  const resultsSection = document.getElementById('resultsSection');
  const resultsCard = document.getElementById('resultsCard');
  document.getElementById('extractedSection').style.display = 'none';
  resultsSection.style.display = 'block';
  resultsCard.innerHTML = '<div class="loading"><span class="spinner"></span>Searching Google for LinkedIn profiles…</div>';

  try {
    const res = await fetch('/linkedin-test/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, company, designation })
    });
    const data = await res.json();
    if (data.error) {
      resultsCard.innerHTML = '<div class="error">' + esc(data.error) + '</div>';
      return;
    }
    if (!data.profiles || data.profiles.length === 0) {
      resultsCard.innerHTML = '<div class="error">No LinkedIn profiles found. Try different search terms.</div>';
      return;
    }
    resultsCard.innerHTML = '<h2>Found ' + data.profiles.length + ' profile(s)</h2>';
    data.profiles.forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'profile-card';
      div.id = 'profile-' + i;
      div.innerHTML =
        '<div class="profile-name">' + esc(p.title || 'Unknown') + '</div>' +
        '<div class="profile-headline">' + esc(p.snippet || '') + '</div>' +
        '<div class="profile-url">' + esc(p.url) + '</div>' +
        '<div class="profile-actions"></div>';
      const actions = div.querySelector('.profile-actions');
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn-sm btn-confirm';
      confirmBtn.textContent = String.fromCharCode(10003) + ' Yes, this is correct';
      confirmBtn.onclick = () => confirmProfile(p.url, i);
      const skipBtn = document.createElement('button');
      skipBtn.className = 'btn-sm btn-skip';
      skipBtn.textContent = 'Show next';
      skipBtn.onclick = () => skipProfile(i);
      actions.appendChild(confirmBtn);
      actions.appendChild(skipBtn);
      resultsCard.appendChild(div);
    });
  } catch (e) {
    resultsCard.innerHTML = '<div class="error">Search failed: ' + esc(e.message) + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find LinkedIn Profile';
  }
}

function skipProfile(index) {
  const card = document.getElementById('profile-' + index);
  if (card) card.style.display = 'none';
}

async function confirmProfile(url, index) {
  const card = document.getElementById('profile-' + index);
  const actions = card.querySelector('.profile-actions');
  actions.innerHTML = '<span class="spinner"></span> Extracting profile data…';

  const extractedSection = document.getElementById('extractedSection');
  const extractedCard = document.getElementById('extractedCard');
  extractedSection.style.display = 'block';
  extractedCard.innerHTML = '<div class="loading"><span class="spinner"></span>Fetching and parsing LinkedIn profile…</div>';

  try {
    const res = await fetch('/linkedin-test/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (data.error) {
      extractedCard.innerHTML = '<div class="error">' + esc(data.error) + '</div>';
      return;
    }
    actions.innerHTML = '<span style="color:#10b981;font-weight:600">✓ Confirmed</span>';
    renderExtracted(data.profile);
  } catch (e) {
    extractedCard.innerHTML = '<div class="error">Extraction failed: ' + esc(e.message) + '</div>';
  }
}

function renderExtracted(p) {
  const extractedCard = document.getElementById('extractedCard');
  let html = '<h2>Extracted Resume Context</h2><div class="extracted-data">';

  html += '<div class="data-section"><h4>Name</h4><p>' + esc(p.name || 'N/A') + '</p></div>';
  html += '<div class="data-section"><h4>Headline</h4><p>' + esc(p.headline || 'N/A') + '</p></div>';
  if (p.company) html += '<div class="data-section"><h4>Current Company</h4><p>' + esc(p.company) + '</p></div>';
  if (p.location) html += '<div class="data-section"><h4>Location</h4><p>' + esc(p.location) + '</p></div>';

  if (p.experience && p.experience.length) {
    html += '<div class="data-section"><h4>Experience</h4><ul>';
    p.experience.forEach(e => {
      if (typeof e === 'string') { html += '<li>' + esc(e) + '</li>'; }
      else { html += '<li><strong>' + esc(e.title || '') + '</strong>' + (e.company ? ' at ' + esc(e.company) : '') + (e.duration ? ' (' + esc(e.duration) + ')' : '') + '</li>'; }
    });
    html += '</ul></div>';
  }

  if (p.education && p.education.length) {
    html += '<div class="data-section"><h4>Education</h4><ul>';
    p.education.forEach(e => {
      if (typeof e === 'string') { html += '<li>' + esc(e) + '</li>'; }
      else { html += '<li><strong>' + esc(e.degree || e.school || '') + '</strong>' + (e.school && e.degree ? ' — ' + esc(e.school) : '') + (e.year ? ' (' + esc(e.year) + ')' : '') + '</li>'; }
    });
    html += '</ul></div>';
  }

  if (p.skills && p.skills.length) {
    html += '<div class="data-section"><h4>Skills</h4><div>';
    p.skills.forEach(s => { html += '<span class="tag">' + esc(s) + '</span>'; });
    html += '</div></div>';
  }

  if (p.about) html += '<div class="data-section"><h4>About</h4><p>' + esc(p.about) + '</p></div>';

  html += '</div>';

  // Raw JSON
  html += '<details style="margin-top:16px"><summary style="cursor:pointer;font-size:13px;color:#888">View raw JSON</summary>';
  html += '<pre style="background:#f1f5f9;padding:12px;border-radius:8px;font-size:12px;overflow-x:auto;margin-top:8px">' + esc(JSON.stringify(p, null, 2)) + '</pre></details>';

  extractedCard.innerHTML = html;
}
</script>
</body></html>`);
});

// LinkedIn search endpoint
app.post('/linkedin-test/search', async (req, res) => {
  const { name, company, designation } = req.body;
  if (!name) return res.json({ error: 'Name is required' });

  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
    return res.json({ error: 'Google Custom Search API not configured. Set GOOGLE_API_KEY and GOOGLE_CSE_ID environment variables.' });
  }

  try {
    // Build search query
    let query = `site:linkedin.com/in "${name}"`;
    if (company) query += ` "${company}"`;
    if (designation) query += ` "${designation}"`;

    const params = new URLSearchParams({
      q: query,
      key: GOOGLE_API_KEY,
      cx: GOOGLE_CSE_ID,
      num: '10',
    });

    const searchRes = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
    const searchData = await searchRes.json();

    if (searchData.error) {
      return res.json({ error: `Google API error: ${searchData.error.message}` });
    }

    // Filter to linkedin.com/in/ profiles only
    const profiles = (searchData.items || [])
      .filter(item => item.link && item.link.includes('linkedin.com/in/'))
      .filter(item => !item.link.includes('/company/') && !item.link.includes('/jobs/'))
      .slice(0, 3)
      .map(item => ({
        title: item.title || '',
        snippet: item.snippet || '',
        url: item.link,
      }));

    res.json({ profiles });
  } catch (err) {
    console.error('[LINKEDIN_SEARCH_ERROR]', err.message);
    res.json({ error: 'Search failed: ' + err.message });
  }
});

// LinkedIn profile extraction endpoint
app.post('/linkedin-test/extract', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes('linkedin.com/in/')) {
    return res.json({ error: 'Invalid LinkedIn profile URL' });
  }

  try {
    // Fetch LinkedIn profile HTML
    const profileRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    if (!profileRes.ok) {
      return res.json({ error: `Could not fetch profile (HTTP ${profileRes.status}). LinkedIn may be blocking the request.` });
    }

    const html = await profileRes.text();

    // Try to extract JSON-LD structured data first
    let structuredData = null;
    const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try { structuredData = JSON.parse(jsonLdMatch[1]); } catch (e) { /* ignore */ }
    }

    // Extract useful text from meta tags and visible content
    const metaDesc = (html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/) || [])[1] || '';
    const ogTitle = (html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/) || [])[1] || '';
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';

    // Strip HTML tags for a text snapshot
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    let bodyText = '';
    if (bodyMatch) {
      bodyText = bodyMatch[1]
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
    }

    // Build context for LLM extraction
    let extractionContext = `LinkedIn Profile URL: ${url}\n\n`;
    if (structuredData) extractionContext += `Structured Data (JSON-LD):\n${JSON.stringify(structuredData, null, 2)}\n\n`;
    if (ogTitle) extractionContext += `Page Title: ${ogTitle}\n`;
    if (metaDesc) extractionContext += `Meta Description: ${metaDesc}\n\n`;
    if (bodyText) extractionContext += `Page Text Content:\n${bodyText}\n`;

    // Use Claude to extract structured profile data
    const extraction = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Extract structured profile information from this LinkedIn page content. Return ONLY valid JSON with no explanation.

${extractionContext}

Return this exact JSON structure (use empty string or empty array if not found):
{
  "name": "",
  "headline": "",
  "company": "",
  "location": "",
  "about": "",
  "experience": [
    { "title": "", "company": "", "duration": "", "description": "" }
  ],
  "education": [
    { "degree": "", "school": "", "year": "" }
  ],
  "skills": []
}`
      }],
    });

    const responseText = extraction.content[0].text;
    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.json({ error: 'Could not extract profile data. LinkedIn may require authentication to view full profiles.' });
    }

    const profile = JSON.parse(jsonMatch[0]);
    res.json({ profile });
  } catch (err) {
    console.error('[LINKEDIN_EXTRACT_ERROR]', err.message);
    res.json({ error: 'Extraction failed: ' + err.message });
  }
});

// Razorpay webhook
if (RAZORPAY_ENABLED) {
  app.post('/razorpay-webhook', async (req, res) => {
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
        if (currentStatus === 'completed' || currentStatus === 'resume_generated' || currentStatus === 'generating' || currentStatus === 'payment_completed') {
          return res.json({ status: 'ok' });
        }

        await db.updateResumeRequestStatus(resumeRequestId, 'payment_completed');
        await db.addMessage(resumeRequestId, 'system', 'payment_completed', 'system');
        console.log('Payment verified:', paymentId);

        // Message 1: Payment confirmation (sent immediately)
        await sendWhatsApp(phone, 'Awesome! Payment received 🎉\n\nLet\'s get back to building your resume.').catch(console.error);

        // Message 2: Continue conversation (Claude generates dynamic follow-up)
        await db.addMessage(resumeRequestId, 'incoming', 'Payment received. Continue collecting details.');
        const postPaymentReply = await askClaudeRaw(resumeRequestId);
        await sendWhatsApp(phone, postPaymentReply).catch(console.error);
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
  const trimmed = incomingMsg.trim();
  const lower = trimmed.toLowerCase();

  // Developer reset — terminate current session cleanly for re-testing
  if (trimmed === 'RESET_CONVO' || trimmed === 'END_CONVO') {
    const active = await db.getActiveResumeRequest(user.id);
    if (active) {
      await db.updateResumeRequestStatus(active.id, 'terminated');
      await db.addMessage(active.id, 'system', 'conversation_terminated_by_reset', 'system');
    }
    const freshReq = await db.createResumeRequest(user.id, 'create');
    await db.updateResumeRequestStatus(freshReq.id, 'collecting_data');
    await sendWhatsApp(from,
      'Conversation reset successfully ✅\n\n' +
      'Starting a fresh session now.\n\n' +
      'You can begin again by telling me:\n' +
      '• Create a resume\n' +
      '• Improve my resume'
    );
    const reply = await askClaude(freshReq.id, 'Hi');
    return reply;
  }

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
      const reply = await askClaude(resumeReq.id, incomingMsg);
      return reply;
    }
    await db.updateResumeRequestStatus(resumeReq.id, 'collecting_data');
    const reply = await askClaude(resumeReq.id, incomingMsg);
    return reply;
  }

  // ─── collecting_data: conversation with Claude (before payment)
  if (status === 'collecting_data') {
    // Check if user wants to upload a resume (switch to improve flow)
    if (lower.includes('upload') || lower.includes('improve') || lower.includes('existing resume')) {
      await db.updateResumeRequestFlow(resumeReq.id, 'improve');
      await db.updateResumeRequestStatus(resumeReq.id, 'awaiting_input');
      return 'Sure! Just send me your resume file — I accept *PDF* or *Word (.docx)* files.\n\nI\'ll read through it carefully and help you make it even better.';
    }

    // Normal conversation with Claude
    const claudeReply = await askClaude(resumeReq.id, incomingMsg);

    // Claude triggers early payment after enough data collected
    if (claudeReply.includes('SEND_PAYMENT')) {
      // Send any acknowledgment text Claude wrote before the trigger
      const preText = claudeReply.replace(/SEND_PAYMENT/g, '').trim();
      if (preText) await sendWhatsApp(from, preText);

      await db.updateResumeRequestStatus(resumeReq.id, 'payment_pending');
      if (RAZORPAY_ENABLED) {
        const paymentUrl = await createPaymentLink(from, resumeReq);
        await sendWhatsApp(from, 'Btw — we\'re running a *50% off* deal right now 🎉\n\nThe full resume package is usually ₹99, but today it\'s just *₹49*.\n\nHonestly I\'d grab it — this won\'t last long.');
        await sendWhatsApp(from, paymentUrl);
        return 'Just complete this quick step and we\'ll continue building your resume right after 🚀';
      }
      // Free mode — skip payment, go straight to post-payment collecting
      await db.updateResumeRequestStatus(resumeReq.id, 'payment_completed');
      return 'Great — let me ask a few more questions to make your resume even stronger.';
    }

    return claudeReply;
  }

  // ─── payment_pending: waiting for payment
  if (status === 'payment_pending') {
    // Politely redirect to payment
    if (RAZORPAY_ENABLED) {
      return 'I\'ve got your details saved 🙂\n\nJust complete the quick ₹49 step and we\'ll jump right back into building your resume.';
    }
    // Free mode fallback
    await db.updateResumeRequestStatus(resumeReq.id, 'payment_completed');
    const reply = await askClaude(resumeReq.id, 'Payment received. Continue collecting details.');
    return reply;
  }

  // ─── payment_completed: continue collecting details, then generate
  if (status === 'payment_completed') {
    const claudeReply = await askClaude(resumeReq.id, incomingMsg);

    if (claudeReply.includes('GENERATE_RESUME')) {
      const preText = claudeReply.replace(/GENERATE_RESUME/g, '').trim();
      if (preText) await sendWhatsApp(from, preText);
      return await startDirectResumeGeneration(from, user, resumeReq);
    }

    return claudeReply;
  }

  // ─── generating / paid: resume is being generated
  if (status === 'generating' || status === 'paid') {
    return 'Your resume is being generated. Please wait a moment...';
  }

  // ─── resume_generated / completed: start fresh with AI
  if (status === 'resume_generated' || status === 'completed') {
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

async function startDirectResumeGeneration(from, user, resumeReq) {
  const limits = await db.getUserLimits(user.id);
  if (limits.daily_resumes >= DAILY_RESUME_LIMIT) {
    return 'System usage limit reached. Please try again tomorrow.';
  }

  await db.updateResumeRequestStatus(resumeReq.id, 'generating');
  await db.incrementResumeCount(user.id);

  // Send loader messages, then generate directly (no preview step)
  processFullResume(from, resumeReq.id).catch(err => {
    console.error('Resume generation error:', err);
    db.updateResumeRequestStatus(resumeReq.id, 'payment_completed').catch(console.error);
    sendWhatsApp(from, 'Oops, something went wrong. Just say "generate" and I\'ll try again.').catch(console.error);
  });

  return 'Alright — putting your resume together now ✨\n\nThis will take a moment. I\'ll send it as soon as it\'s ready.';
}

// ─── Async processors ────────────────────────────────────────────────────────

async function processResumePreview(from, resumeRequestId) {
  await extractAndSaveFromConversation(resumeRequestId);
  const data = await db.getResumeData(resumeRequestId);

  if (!data || !data.name) {
    await db.updateResumeRequestStatus(resumeRequestId, 'collecting_data');
    await sendWhatsApp(from, 'I don\'t have enough information yet. Let\'s continue.\n\nWhat is your full name?');
    return;
  }

  await db.updateResumeRequestStatus(resumeRequestId, 'preview_ready');

  // Send loader messages while generating preview
  await sendWhatsApp(from, 'Generating your resume preview...');
  await new Promise(r => setTimeout(r, 2000));
  await sendWhatsApp(from, 'Formatting the resume layout...');
  await new Promise(r => setTimeout(r, 2000));
  await sendWhatsApp(from, 'Preparing your preview document...');

  // Generate redacted preview PDF
  const redactedData = redactResumeData(data);
  const previewPdfPath = await generatePdf(redactedData);
  const PREVIEW_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
  const previewToken = storeTempFile(previewPdfPath, 'ResumeWala-Preview.pdf', PREVIEW_EXPIRY_MS);
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  const previewUrl = `${baseUrl}/resume/${previewToken}`;

  // Send preview link
  await sendWhatsApp(from,
    'Your resume preview is ready.\n\n' +
    'You can view the preview here:\n' + previewUrl + '\n\n' +
    'This preview link will expire in 15 minutes.'
  );

  if (RAZORPAY_ENABLED) {
    // Send payment message
    const paymentUrl = await createPaymentLink(from, { id: resumeRequestId });
    await sendWhatsApp(from,
      'Like the preview? Complete the payment to get the full resume:\n\n' +
      paymentUrl + '\n\n' +
      'Or reply:\n2 - Edit something\n3 - Start over'
    );
  } else {
    // Free mode: show preview + download options
    await sendWhatsApp(from,
      'Reply:\n' +
      '1 - Download full resume\n' +
      '2 - Edit something\n' +
      '3 - Start over'
    );
  }
}

async function processFullResume(from, resumeRequestId) {
  // Dynamically build resume data from all available sources
  await extractAndSaveFromConversation(resumeRequestId);
  const data = await db.getResumeData(resumeRequestId);

  // Only fail if BOTH conversation messages AND resume file are empty
  if (!data || !data.name) {
    const messages = await db.getConversationMessages(resumeRequestId);
    const resumeSummary = await db.getResumeSummary(resumeRequestId);
    if ((!messages || messages.length === 0) && !resumeSummary) {
      await sendWhatsApp(from, 'No resume data found. Please start over by typing "menu".');
      return;
    }
    // Conversation exists but extraction failed to get a name — retry won't help
    // Use phone number as fallback name so generation can proceed
    if (!data) {
      await sendWhatsApp(from, 'Could not extract resume details. Please start over by typing "menu".');
      return;
    }
    if (!data.name) data.name = 'Your Name';
  }

  console.log('Resume generation started');
  await db.addMessage(resumeRequestId, 'system', 'resume_generation_started', 'system');

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

  // Store resume URLs in database
  await db.saveResumeUrls(resumeRequestId, pdfUrl, docxUrl);
  await db.addMessage(resumeRequestId, 'system', 'resume_generated', 'system');

  await db.updateResumeRequestStatus(resumeRequestId, 'resume_generated');
  console.log('Resume generation completed');

  // Send download links
  const msg =
    '✅ *Your resume is ready!*\n\n' +
    'Here are your files (valid for 24 hours):\n\n' +
    '📄 *PDF:*\n' + pdfUrl + '\n\n' +
    '📝 *Word:*\n' + docxUrl + '\n\n' +
    'Hope this helps you land something great 💪\n\nWant to create another one? Just say *hi*.';

  await sendWhatsApp(from, msg);
  await db.addMessage(resumeRequestId, 'system', 'resume_links_sent', 'system');
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

  // Store full resume text for use during final generation
  await db.saveResumeFullText(resumeReq.id, text.slice(0, 15000));

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
    resumeData = parseStructuredText(extraction.content[0].text);
  } catch (err) {
    console.error('Extraction error:', err.message);
    await sendWhatsApp(from, 'Could not extract data. Type "2" to create a resume manually.');
    return;
  }

  // Step 4: Save to database
  await db.saveResumeData(resumeReq.id, resumeData);
  await db.updateResumeRequestStatus(resumeReq.id, 'collecting_data');

  // Step 4b: Generate and store resume file summary for context memory
  const summary = await generateResumeSummary(resumeData);
  await db.saveResumeSummary(resumeReq.id, summary);

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
    await db.tagLastIncomingMessage(from, 'document').catch(err => console.error('tag document error:', err.message));
    await db.addMessage(resumeReq.id, 'outgoing', understanding + '\n\n' + questionMsg);
  } else {
    // No missing fields — ready to generate
    const readyMsg = 'Your resume data looks complete! Reply *YES* to generate your resume, or tell me if you want to change anything.';
    await sendWhatsApp(from, readyMsg);
    await db.addMessage(resumeReq.id, 'incoming', 'User uploaded resume with complete data.');
    await db.tagLastIncomingMessage(from, 'document').catch(err => console.error('tag document error:', err.message));
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

  // Include uploaded resume summary if available
  const resumeSummary = await db.getResumeSummary(resumeRequestId);
  if (resumeSummary) {
    prompt += 'UPLOADED RESUME SUMMARY:\n' + resumeSummary + '\n\n';
  }

  // Include full original resume content for complete data extraction
  const resumeFullText = await db.getResumeFullText(resumeRequestId);
  if (resumeFullText) {
    prompt += 'FULL ORIGINAL RESUME CONTENT (from uploaded file):\n' + resumeFullText.slice(0, 12000) + '\n\n';
  }

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
  prompt += '\n\nExtract the COMPLETE resume data, merging all sources (uploaded resume summary, previously extracted data, and conversation). Preserve all existing data and add/update from the conversation. Do not lose any information.';

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

  // Prepend uploaded resume summary if available
  const resumeSummary = await db.getResumeSummary(resumeRequestId);
  let systemPrompt = SYSTEM_PROMPT;
  if (resumeSummary) {
    systemPrompt += '\n\nUPLOADED RESUME SUMMARY\n\n' + resumeSummary +
      '\n\nThe user has already provided the above information in their uploaded resume or documents. ' +
      'Do not ask the user again for information already contained in this summary. ' +
      'Only ask questions about missing details that could strengthen the resume.';
  }

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  const assistantText = response.content[0].text;
  await db.addMessage(resumeRequestId, 'outgoing', assistantText);
  return assistantText;
}

// askClaudeRaw: same as askClaude but does NOT add the incoming message (already added by caller)
async function askClaudeRaw(resumeRequestId) {
  const messages = await db.getConversationMessages(resumeRequestId);

  const resumeSummary = await db.getResumeSummary(resumeRequestId);
  let systemPrompt = SYSTEM_PROMPT;
  if (resumeSummary) {
    systemPrompt += '\n\nUPLOADED RESUME SUMMARY\n\n' + resumeSummary +
      '\n\nThe user has already provided the above information in their uploaded resume or documents. ' +
      'Do not ask the user again for information already contained in this summary. ' +
      'Only ask questions about missing details that could strengthen the resume.';
  }

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: systemPrompt,
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
    // Look up ad tracking for this user — never let this block payment
    let refParam = '';
    let adShortId = '';
    let adFbclid = '';
    try {
      const userTracking = await db.getUserAdTracking(from);
      if (userTracking?.ad_short_id) {
        refParam = '?ref=' + userTracking.ad_short_id;
        adShortId = userTracking.ad_short_id;
        adFbclid = userTracking.fbclid || '';
      }
    } catch (trackErr) {
      console.error('[AD_TRACKING] Lookup error in createPaymentLink (non-fatal):', trackErr.message);
    }

    const link = await razorpay.paymentLink.create({
      amount: PAYMENT_AMOUNT,
      currency: 'INR',
      description: 'ResumeWala - Professional Resume',
      notes: {
        resume_request_id: resumeReq.id,
        phone: from,
        ad_short_id: adShortId,
        fbclid: adFbclid,
      },
      callback_url: (process.env.BASE_URL || '') + '/payment-success' + refParam,
      callback_method: 'get',
    });

    // Store payment in database
    await db.createPayment(resumeReq.id, link.id, PAYMENT_AMOUNT);
    await db.addMessage(resumeReq.id, 'system', 'payment_link_sent', 'system');

    return link.short_url;
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

  // ── Action verbs to bold at start of bullets
  const ACTION_VERBS = new Set([
    'led', 'built', 'developed', 'optimized', 'launched', 'revamped', 'managed',
    'created', 'implemented', 'drove', 'spearheaded', 'designed', 'delivered',
    'established', 'achieved', 'increased', 'reduced', 'improved', 'generated',
    'streamlined', 'orchestrated', 'pioneered', 'transformed', 'automated',
    'negotiated', 'executed', 'analyzed', 'mentored', 'directed', 'coordinated',
    'facilitated', 'initiated', 'secured', 'scaled', 'resolved', 'introduced',
    'collaborated', 'supervised', 'oversaw', 'consolidated', 'restructured',
  ]);

  // ── Bullet paragraph with hanging indent, smart bold via **markers** or fallback
  const bulletParagraph = (text) => {
    const runs = [];
    const hasMarkers = /\*\*.+?\*\*/.test(text);

    if (hasMarkers) {
      // Parse **bold** markers from Claude's extraction output
      const parts = text.split(/\*\*(.+?)\*\*/g);
      for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        runs.push(new TextRun({ text: parts[i], bold: i % 2 === 1, size: 21, font: 'Calibri' }));
      }
    } else {
      // Fallback: regex-based metric bolding for older data without markers
      const metricPattern = /((?:[₹$])\s*\d+[\d,.]*\s*[KkMmLl]*(?:\s*(?:Cr|cr|Lakh|lakh|crore))?\s*\+?\s*(?:revenue|users|customers|leads|growth|improvement|reduction|increase)?|\d+[\d,.]*\s*[%xX]+(?:\s+(?:growth|improvement|increase|reduction|conversion|revenue|ROI|margin))?|\d+[\d,.]*\s*\+?\s*(?:users|customers|leads|members|participants|team|employees|stores|cities|brands|clients|partners|campaigns|experiments|projects|products|months|years|weeks|days|cr|lakh|Cr|Lakh|crore|million|billion|[KkMm])\w*)/gi;
      const parts = text.split(metricPattern);
      for (const part of parts) {
        if (!part) continue;
        metricPattern.lastIndex = 0;
        if (metricPattern.test(part)) {
          metricPattern.lastIndex = 0;
          runs.push(new TextRun({ text: part, bold: true, size: 21, font: 'Calibri' }));
        } else {
          runs.push(new TextRun({ text: part, size: 21, font: 'Calibri' }));
        }
      }
    }

    return new Paragraph({
      children: [new TextRun({ text: '\u2022  ', size: 21, font: 'Calibri' }), ...runs],
      spacing: { after: 80, line: 276 },
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
          new Paragraph({ children: headerRuns, spacing: { before: 200, after: 60 } })
        );

        if (exp.description) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: exp.description, size: 20, font: 'Calibri', color: '555555', italics: true })],
              spacing: { after: 80 },
              indent: { left: 0 },
            })
          );
        }

        const responsibilities = Array.isArray(exp.responsibilities) ? exp.responsibilities :
          (exp.responsibilities ? [exp.responsibilities] : []);

        for (const resp of responsibilities) {
          children.push(bulletParagraph(String(resp)));
        }

        // Add spacing after each experience entry
        if (responsibilities.length > 0) {
          children.push(new Paragraph({ spacing: { after: 120 } }));
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
    const LEFT = 50;          // fixed left margin for all content
    const RIGHT = 545;        // fixed right edge
    const CONTENT_WIDTH = RIGHT - LEFT;
    const BULLET_X = LEFT + 10;    // bullet character position
    const BULLET_TEXT_X = LEFT + 22; // bullet text position (fixed, never recalculated)
    const BULLET_TEXT_W = RIGHT - BULLET_TEXT_X;

    // Name
    doc.fontSize(22).fillColor(NAVY).font('Helvetica-Bold')
      .text((data.name || 'Resume').toUpperCase(), LEFT, doc.y, { width: CONTENT_WIDTH, align: 'center' });

    // Headline
    if (data.headline) {
      doc.fontSize(11).fillColor(GRAY).font('Helvetica-Oblique')
        .text(data.headline, LEFT, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    }

    // Contact
    const contactParts = [data.location, data.email, data.phone].filter(Boolean);
    if (contactParts.length > 0) {
      doc.fontSize(9).fillColor(GRAY).font('Helvetica')
        .text(contactParts.join('  |  '), LEFT, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    }

    doc.moveDown(0.5);

    // Helper: section heading with line — always starts at LEFT
    const pdfSectionHeading = (title) => {
      doc.moveDown(0.6);
      doc.fontSize(11).fillColor(NAVY).font('Helvetica-Bold')
        .text(title.toUpperCase(), LEFT, doc.y, { width: CONTENT_WIDTH });
      const y = doc.y + 2;
      doc.moveTo(LEFT, y).lineTo(RIGHT, y)
        .strokeColor(NAVY).lineWidth(1).stroke();
      doc.moveDown(0.35);
    };

    // Helper: parse **bold** markers into segments
    const parseBoldMarkers = (text) => {
      const segments = [];
      const parts = text.split(/\*\*(.+?)\*\*/g);
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '') continue;
        segments.push({ text: parts[i], bold: i % 2 === 1 });
      }
      return segments;
    };

    // Fallback: regex-based smart bolding for bullets without **markers**
    const smartBoldPattern = /(\d+[\d,.]*\s*[%xX+]+(?:\s+\w+(?:\s+\w+)?)?|\d+[\d,.]*\s*\+?\s*(?:users|customers|leads|team|employees|stores|cities|months|years|cr|lakh|million|billion|[KkMm])\w*|[₹$]\s*\d+[\d,.]*\w*)/gi;

    const parseBoldFallback = (text) => {
      const segments = [];
      let lastIndex = 0;
      let match;
      smartBoldPattern.lastIndex = 0;
      while ((match = smartBoldPattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
          segments.push({ text: text.slice(lastIndex, match.index), bold: false });
        }
        segments.push({ text: match[1], bold: true });
        lastIndex = smartBoldPattern.lastIndex;
      }
      if (lastIndex < text.length) {
        segments.push({ text: text.slice(lastIndex), bold: false });
      }
      return segments;
    };

    // Helper: bullet point with smart bolding — fixed positions for all bullets
    const pdfBullet = (text) => {
      const currentY = doc.y;
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text('\u2022', BULLET_X, currentY);
      doc.moveUp();

      // Use **markers** if present, otherwise fall back to regex
      const hasMarkers = /\*\*.+?\*\*/.test(text);
      const cleanText = hasMarkers ? text.replace(/\*\*/g, '') : text;
      const segments = hasMarkers ? parseBoldMarkers(text) : parseBoldFallback(text);

      // If no bold segments, print plain
      if (segments.length <= 1 && !segments[0]?.bold) {
        doc.font('Helvetica').fontSize(10).fillColor(BLACK)
          .text(cleanText, BULLET_TEXT_X, doc.y, { width: BULLET_TEXT_W, lineGap: 2 });
        return;
      }

      // Print segments with inline bold switching
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const isLast = i === segments.length - 1;
        const font = seg.bold ? 'Helvetica-Bold' : 'Helvetica';
        if (i === 0) {
          doc.font(font).fontSize(10).fillColor(BLACK)
            .text(seg.text, BULLET_TEXT_X, doc.y, { continued: !isLast, width: BULLET_TEXT_W, lineGap: 2 });
        } else {
          doc.font(font).fontSize(10).fillColor(BLACK)
            .text(seg.text, { continued: !isLast, width: BULLET_TEXT_W, lineGap: 2 });
        }
      }
    };

    // Helper: job/leadership entry header — always at LEFT
    const pdfEntryHeader = (parts) => {
      doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold')
        .text(parts.filter(Boolean).join('  |  '), LEFT, doc.y, { width: CONTENT_WIDTH });
    };

    // Summary
    if (data.summary) {
      pdfSectionHeading('Professional Summary');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(data.summary, LEFT, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
    }

    // Experience
    if (data.experience && data.experience.length > 0) {
      pdfSectionHeading('Professional Experience');
      for (const exp of data.experience) {
        if (typeof exp === 'object') {
          pdfEntryHeader([exp.company, exp.title, exp.duration]);
          if (exp.description) {
            doc.fontSize(9).fillColor(GRAY).font('Helvetica-Oblique')
              .text(exp.description, LEFT, doc.y, { width: CONTENT_WIDTH });
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
              .text(edu.degree, LEFT, doc.y, { width: CONTENT_WIDTH });
          }
          const subParts = [edu.institution, edu.year].filter(Boolean);
          if (subParts.length > 0) {
            doc.fontSize(10).fillColor(NAVY).font('Helvetica-Bold')
              .text(subParts.join('  |  '), LEFT, doc.y, { width: CONTENT_WIDTH });
          }
        } else {
          doc.fontSize(10).fillColor(BLACK).font('Helvetica')
            .text(String(edu), LEFT, doc.y, { width: CONTENT_WIDTH });
        }
        doc.moveDown(0.2);
      }
    }

    // Skills
    const pdfSkills = (data.skills || []).map(s => typeof s === 'string' ? s : String(s));
    if (pdfSkills.length > 0) {
      pdfSectionHeading('Skills');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(pdfSkills.join('  |  '), LEFT, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
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
        .text(pdfTools.join('  |  '), LEFT, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
    }

    // Leadership
    if (data.leadership && data.leadership.length > 0) {
      pdfSectionHeading('Leadership Experience');
      for (const item of data.leadership) {
        if (typeof item === 'object' && item.title) {
          pdfEntryHeader([item.title, item.company, item.duration]);
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
        .text(pdfLangs.join('  |  '), LEFT, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
    }

    // Hobbies
    const pdfHobbies = (data.hobbies || []).map(h => typeof h === 'string' ? h : String(h));
    if (pdfHobbies.length > 0) {
      pdfSectionHeading('Hobbies & Interests');
      doc.fontSize(10).fillColor(BLACK).font('Helvetica')
        .text(pdfHobbies.join('  |  '), LEFT, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
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
