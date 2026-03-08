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

async function sendWhatsApp(to, body, mediaUrl) {
  const params = {
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
    body,
  };
  if (mediaUrl) params.mediaUrl = [mediaUrl];
  await twilioClient.messages.create(params);
}

// Temp file store (auto-cleaned after 10 min)
const tempFiles = new Map();

function storeTempFile(filePath) {
  const token = crypto.randomUUID();
  const cleanup = setTimeout(() => {
    tempFiles.delete(token);
    fs.unlink(filePath, () => {});
  }, 10 * 60 * 1000);
  tempFiles.set(token, { filePath, cleanup });
  return token;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
    DATABASE_URL: !!process.env.DATABASE_URL,
    BASE_URL: process.env.BASE_URL || 'NOT SET',
  });
});

app.get('/resume/:token', (req, res) => {
  const entry = tempFiles.get(req.params.token);
  if (!entry) return res.status(404).send('File not found or expired.');
  res.download(entry.filePath, 'resume.docx', (err) => {
    if (err) console.error('File download error:', err);
  });
});

// ─── Prompts ─────────────────────────────────────────────────────────────────

const WELCOME_MESSAGE =
  'Hi!\nI help you create a professional resume in minutes.\n\nReply:\n1 - Create new resume\n2 - Upload existing resume\n\nAnytime type:\ngenerate resume - Build your resume\nedit resume - Modify a section\nrestart - Start over';

const SYSTEM_PROMPT = `You are a friendly resume-building assistant on WhatsApp. Help the user create a professional resume by collecting information in a natural conversation.

Collect the following details, asking only 1-2 questions at a time:
1. Full name
2. Location (city, country)
3. Professional summary (brief 2-3 sentence summary)
4. Education (degree, institution, graduation year)
5. Work experience (job title, company, duration, key responsibilities) — they may have more than one role
6. Skills (technical and soft skills)
7. Projects (optional)
8. Certifications (optional)
9. Achievements (optional)
10. Tools / technologies (optional)

Rules:
- Be warm, encouraging, and concise — messages must be short and mobile-friendly
- Never use markdown (no **, ##, bullet dashes) — use plain text and line breaks only
- Ask only 1-2 questions per message
- If the user gives incomplete answers, gently ask for more detail
- If the conversation starts with pre-loaded resume data, confirm what you found and only ask for missing or unclear fields — do not re-ask for information already provided
- Once you have all the core information (name, location, education, experience, skills), give a short summary of what was collected, then ask:
  "Great, I have everything I need! Shall I generate your resume now? Reply YES to continue."
- If the user replies YES (or yes / y), respond with exactly this token and nothing else: GENERATE_RESUME
- If the user seems confused or wants to restart, guide them back on track`;

const EXTRACT_PROMPT = `You are a resume data extractor. Given resume text or a conversation, extract the information and return it in this EXACT plain-text format with these EXACT section headers. Do not use JSON. Do not add any explanation.

Name: [full name]
Location: [city, country]
Summary: [2-3 sentence professional summary in third person]

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
- Use exactly the section headers above
- Use * bullet points for list sections
- If a section has no data, omit it entirely
- Do not add any other text, JSON, or markdown`;

// ─── Structured text parser ──────────────────────────────────────────────────

function parseStructuredText(raw) {
  console.log('Claude raw response:', raw);

  const result = {
    name: '',
    location: '',
    summary: '',
    education: [],
    experience: [],
    skills: [],
    projects: [],
    certifications: [],
    achievements: [],
    tools: [],
    hobbies: [],
  };

  const lines = raw.split('\n');
  let currentSection = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const inlineMatch = trimmed.match(/^(Name|Location|City|Summary):\s*(.+)$/i);
    if (inlineMatch) {
      const key = inlineMatch[1].toLowerCase() === 'city' ? 'location' : inlineMatch[1].toLowerCase();
      result[key] = inlineMatch[2].trim();
      currentSection = key;
      continue;
    }

    const sectionMatch = trimmed.match(/^(Education|Experience|Skills|Projects|Certifications|Achievements|Tools|Hobbies):\s*(.*)$/i);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase();
      continue;
    }

    if (currentSection && (trimmed.startsWith('*') || trimmed.startsWith('-') || trimmed.startsWith('\u2022'))) {
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

// ─── Webhook ─────────────────────────────────────────────────────────────────

app.post('/whatsapp', async (req, res) => {
  const incomingMsg = (req.body.Body || '').trim();
  const from = req.body.From || 'unknown';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl = req.body.MediaUrl0 || null;
  const mediaContentType = req.body.MediaContentType0 || '';

  console.log('From:', from, 'Msg:', incomingMsg, 'Media:', numMedia);

  // Media upload — immediate ack + background
  if (numMedia > 0 && mediaUrl) {
    sendTwiml(res, 'Thanks! I received your resume. Extracting the information now...');
    processMediaUpload(from, mediaUrl, mediaContentType).catch(err => {
      console.error('Background media processing error:', err);
      sendWhatsApp(from, 'Sorry, I had trouble processing your file. Please try again or type restart.').catch(console.error);
    });
    return;
  }

  // Text message
  let replyText;
  let mediaReplyUrl = null;

  try {
    const result = await handleMessage(from, incomingMsg);
    replyText = result.text;
    mediaReplyUrl = result.mediaUrl || null;
  } catch (err) {
    console.error('Error handling message:', err);
    replyText = 'Something went wrong. Please try again in a moment.';
  }

  const twiml = new MessagingResponse();
  const msg = twiml.message(replyText);
  if (mediaReplyUrl) msg.media(mediaReplyUrl);
  res.type('text/xml');
  res.send(twiml.toString());
});

function sendTwiml(res, text) {
  const twiml = new MessagingResponse();
  twiml.message(text);
  res.type('text/xml');
  res.send(twiml.toString());
}

// ─── Message handler ─────────────────────────────────────────────────────────

async function handleMessage(from, incomingMsg) {
  const lower = incomingMsg.toLowerCase().trim();
  const user = await db.findOrCreateUser(from);

  // Restart / menu
  if (lower === 'restart' || lower === '0' || lower === 'menu') {
    const active = await db.getActiveResumeRequest(user.id);
    if (active) await db.updateResumeRequestStatus(active.id, 'abandoned');
    return { text: WELCOME_MESSAGE };
  }

  let resumeReq = await db.getActiveResumeRequest(user.id);

  // No active request
  if (!resumeReq) {
    if (lower === '1') {
      resumeReq = await db.createResumeRequest(user.id);
      const reply = await askClaude(resumeReq.id, 'Hi, I want to create a new resume. Please get started.');
      return { text: reply };
    }
    if (lower === '2') {
      await db.createResumeRequest(user.id);
      return { text: 'Please send your resume file (PDF or Word .docx) and I will extract your information automatically.' };
    }
    return { text: WELCOME_MESSAGE };
  }

  // Generate resume — async (Claude extraction + preview)
  if (lower === 'generate resume' || lower === 'generate') {
    processGeneratePreview(from, resumeReq.id).catch(err => {
      console.error('Generate preview error:', err);
      sendWhatsApp(from, 'Sorry, there was an error building your preview. Please try again.').catch(console.error);
    });
    return { text: 'Building your resume preview...' };
  }

  // Download — async (DOCX generation)
  if (lower === 'download') {
    processDownload(from, resumeReq.id).catch(err => {
      console.error('Download error:', err);
      sendWhatsApp(from, 'Sorry, there was an error generating your resume document.').catch(console.error);
    });
    return { text: 'Generating your resume document...' };
  }

  // Edit resume
  if (lower === 'edit resume' || lower === 'edit') {
    const data = await db.getResumeData(resumeReq.id);
    if (Object.keys(data).length === 0) {
      return { text: 'No resume data found yet. Type 1 to create a new resume or send your resume file.' };
    }
    const reply = await askClaude(resumeReq.id,
      'I want to edit my resume. Here is my current data:\n' + JSON.stringify(data, null, 2) + '\n\nPlease ask me which section I want to modify.');
    return { text: reply };
  }

  // Normal conversation
  const claudeReply = await askClaude(resumeReq.id, incomingMsg);

  if (claudeReply.trim() === 'GENERATE_RESUME') {
    processGeneratePreview(from, resumeReq.id).catch(err => {
      console.error('Generate preview error:', err);
      sendWhatsApp(from, 'Sorry, there was an error building your preview. Please try again.').catch(console.error);
    });
    return { text: 'Building your resume preview...' };
  }

  return { text: claudeReply };
}

// ─── Async processors ────────────────────────────────────────────────────────

async function processGeneratePreview(from, resumeRequestId) {
  await extractAndSaveFromConversation(resumeRequestId);
  const data = await db.getResumeData(resumeRequestId);

  let preview = 'Your resume is ready. Here is a preview:\n\n';

  if (data.name) preview += 'Name: ' + data.name + '\n';
  if (data.location) preview += 'Location: ' + data.location + '\n';
  preview += '\n';

  if (data.summary) preview += 'Summary:\n' + data.summary + '\n\n';

  if (data.experience && data.experience.length > 0) {
    preview += 'Experience:\n';
    for (const exp of data.experience) {
      if (typeof exp === 'object') {
        preview += [exp.title, exp.company, exp.duration].filter(Boolean).join(' - ') + '\n';
      } else {
        preview += exp + '\n';
      }
    }
    preview += '\n';
  }

  if (data.education && data.education.length > 0) {
    preview += 'Education:\n';
    for (const edu of data.education) {
      if (typeof edu === 'object') {
        preview += [edu.degree, edu.institution, edu.year].filter(Boolean).join(', ') + '\n';
      } else {
        preview += edu + '\n';
      }
    }
    preview += '\n';
  }

  if (data.skills && data.skills.length > 0) {
    preview += 'Skills:\n' + data.skills.join(', ') + '\n\n';
  }

  if (data.projects && data.projects.length > 0) {
    preview += 'Projects:\n' + data.projects.join(', ') + '\n\n';
  }

  if (data.certifications && data.certifications.length > 0) {
    preview += 'Certifications:\n' + data.certifications.join(', ') + '\n\n';
  }

  if (data.achievements && data.achievements.length > 0) {
    preview += 'Achievements:\n' + data.achievements.join(', ') + '\n\n';
  }

  if (data.tools && data.tools.length > 0) {
    preview += 'Tools:\n' + data.tools.join(', ') + '\n\n';
  }

  preview += 'Reply:\nDOWNLOAD - receive your resume as a Word document\nEDIT - modify your resume';

  await sendWhatsApp(from, preview);
}

async function processDownload(from, resumeRequestId) {
  const data = await db.getResumeData(resumeRequestId);

  if (Object.keys(data).length === 0) {
    await sendWhatsApp(from, 'No resume data found. Please create a resume first by typing 1.');
    return;
  }

  const filePath = await generateDocx(data);
  const token = storeTempFile(filePath);
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  const fileUrl = `${baseUrl}/resume/${token}`;

  await db.updateResumeRequestStatus(resumeRequestId, 'completed');
  await sendWhatsApp(from, 'Here is your resume!\n\nType restart to create a new one.', fileUrl);
}

async function processMediaUpload(from, mediaUrl, contentType) {
  const supportedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];

  if (!supportedTypes.includes(contentType)) {
    await sendWhatsApp(from, 'Sorry, I can only read PDF or Word (.docx) files.\n\nPlease send one of those, or type 1 to create a resume from scratch.');
    return;
  }

  // Ensure user and active request exist
  const user = await db.findOrCreateUser(from);
  let resumeReq = await db.getActiveResumeRequest(user.id);
  if (!resumeReq) resumeReq = await db.createResumeRequest(user.id);

  // Step 1: Download
  let buffer, tmpPath;
  try {
    ({ buffer, tmpPath } = await downloadTwilioMedia(mediaUrl, contentType));
  } catch (err) {
    console.error('Background download error:', err.message);
    await sendWhatsApp(from, 'I could not download your file. Please try again or type restart.');
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
    console.log('Extracted text length:', text.length);
  } catch (err) {
    console.error('Text extraction error:', err.message);
    await sendWhatsApp(from, 'I could not read your file. It may be corrupted or password-protected. Please try another file.');
    return;
  } finally {
    fs.unlink(tmpPath, () => {});
  }

  if (!text.trim()) {
    await sendWhatsApp(from, 'Your file appears to be empty or image-based. Please send a text-based PDF or Word file.');
    return;
  }

  // Step 3: Claude extracts structured data
  let resumeData = {};
  try {
    const extraction = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: 'Extract resume data from this document:\n\n' + text.slice(0, 8000) }],
    });
    resumeData = parseStructuredText(extraction.content[0].text);
  } catch (err) {
    console.error('Resume data extraction error:', err.message);
    await sendWhatsApp(from, 'I could not extract data from your resume. Please type 1 to create a resume manually.');
    return;
  }

  // Step 4: Save to database
  await db.saveFullResumeData(resumeReq.id, resumeData);

  // Step 5: Start conversation with context
  const contextMsg = 'I have uploaded my existing resume. Here is the data extracted:\n' +
    JSON.stringify(resumeData, null, 2) +
    '\n\nPlease confirm what you found and ask me about any missing or unclear fields.';
  const claudeReply = await askClaude(resumeReq.id, contextMsg);

  await sendWhatsApp(from, 'I found some information in your resume. Let me confirm a few details.\n\n' + claudeReply);
}

// ─── Extract from conversation ───────────────────────────────────────────────

async function extractAndSaveFromConversation(resumeRequestId) {
  const messages = await db.getMessages(resumeRequestId);
  const existingData = await db.getResumeData(resumeRequestId);

  const convText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  if (!convText.trim()) return;

  let prompt = '';
  if (Object.keys(existingData).length > 0) {
    prompt += 'Here is previously extracted resume data:\n' + JSON.stringify(existingData, null, 2) + '\n\n';
  }
  prompt += 'And here is the conversation with additional information:\n\n' + convText.slice(0, 8000);
  prompt += '\n\nExtract the complete resume data, merging all sources. Preserve all existing data and add or update from the conversation.';

  try {
    const extraction = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const parsed = parseStructuredText(extraction.content[0].text);
    await db.saveFullResumeData(resumeRequestId, parsed);
  } catch (err) {
    console.error('Extraction from conversation failed:', err.message);
  }
}

// ─── Download Twilio media ───────────────────────────────────────────────────

async function downloadTwilioMedia(mediaUrl, contentType) {
  console.log('Downloading media...');

  const credentials = Buffer.from(
    process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN
  ).toString('base64');

  const fetchWithAuth = () => fetch(mediaUrl, {
    headers: { Authorization: 'Basic ' + credentials },
  });

  let response = await fetchWithAuth();

  if (!response.ok) {
    console.log('Download failed (' + response.status + '), retrying...');
    response = await fetchWithAuth();
  }

  if (!response.ok) {
    throw new Error('Media download failed: ' + response.status + ' ' + response.statusText);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log('Media downloaded, size:', buffer.length, 'bytes');

  const ext = contentType === 'application/pdf' ? 'pdf' : 'docx';
  const tmpPath = path.join(os.tmpdir(), 'upload-' + crypto.randomUUID() + '.' + ext);
  fs.writeFileSync(tmpPath, buffer);

  return { buffer, tmpPath };
}

// ─── Ask Claude ──────────────────────────────────────────────────────────────

async function askClaude(resumeRequestId, userMessage) {
  await db.addMessage(resumeRequestId, 'user', userMessage);
  const messages = await db.getMessages(resumeRequestId);

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
  });

  const assistantText = response.content[0].text;
  await db.addMessage(resumeRequestId, 'assistant', assistantText);
  return assistantText;
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
      children: [new TextRun({ text: data.name || '', bold: true, size: 48, color: '2E4057' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    })
  );

  // Location
  if (data.location) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.location, size: 22, color: '666666' })],
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
          new Paragraph({ children: [new TextRun({ text: exp, size: 20 })], spacing: { after: 80 } })
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
          new Paragraph({ children: [new TextRun({ text: edu, size: 20 })], spacing: { after: 80 } })
        );
      }
    }
  }

  // Skills
  if (data.skills && data.skills.length > 0) {
    children.push(heading('SKILLS'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.skills.join('  \u2022  '), size: 20 })],
        spacing: { after: 100 },
      })
    );
  }

  // Projects
  if (data.projects && data.projects.length > 0) {
    children.push(heading('PROJECTS'));
    for (const proj of data.projects) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: proj, size: 20 })], spacing: { after: 80 } })
      );
    }
  }

  // Certifications
  if (data.certifications && data.certifications.length > 0) {
    children.push(heading('CERTIFICATIONS'));
    for (const cert of data.certifications) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: cert, size: 20 })], spacing: { after: 80 } })
      );
    }
  }

  // Achievements
  if (data.achievements && data.achievements.length > 0) {
    children.push(heading('ACHIEVEMENTS'));
    for (const ach of data.achievements) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: ach, size: 20 })], spacing: { after: 80 } })
      );
    }
  }

  // Tools
  if (data.tools && data.tools.length > 0) {
    children.push(heading('TOOLS & TECHNOLOGIES'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.tools.join('  \u2022  '), size: 20 })],
        spacing: { after: 100 },
      })
    );
  }

  // Hobbies
  if (data.hobbies && data.hobbies.length > 0) {
    children.push(heading('HOBBIES & INTERESTS'));
    children.push(
      new Paragraph({ children: [new TextRun({ text: data.hobbies.join(', '), size: 20 })] })
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

  const buffer = await Packer.toBuffer(doc);
  const filePath = path.join(os.tmpdir(), `resume-${crypto.randomUUID()}.docx`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// ─── Start ───────────────────────────────────────────────────────────────────

async function start() {
  await db.initDb();
  console.log('Database tables initialized');

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
    console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'FOUND' : 'MISSING');
    console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'FOUND' : 'MISSING');
    console.log('TWILIO_ACCOUNT_SID:', process.env.TWILIO_ACCOUNT_SID ? 'FOUND' : 'MISSING');
    console.log('BASE_URL:', process.env.BASE_URL || 'NOT SET');
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
