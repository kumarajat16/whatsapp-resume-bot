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

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get('/health', (req, res) => {
  res.json({
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
    BASE_URL: process.env.BASE_URL || 'NOT SET',
    PORT: process.env.PORT,
  });
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Session store: phone -> { messages: [], resumeData: {} }
const sessions = new Map();

// Temp file store: token -> { filePath } (auto-cleaned after 10 min)
const tempFiles = new Map();

// Parse Claude's structured plain-text response into a resume data object
function parseStructuredText(raw) {
  console.log('Claude raw response:', raw);

  const result = {
    name: '',
    city: '',
    summary: '',
    education: [],
    experience: [],
    skills: [],
    projects: [],
    hobbies: [],
  };

  const lines = raw.split('\n');
  let currentSection = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Single-value fields: "Name: John Doe"
    const inlineMatch = trimmed.match(/^(Name|City|Summary):\s*(.+)$/i);
    if (inlineMatch) {
      result[inlineMatch[1].toLowerCase()] = inlineMatch[2].trim();
      currentSection = inlineMatch[1].toLowerCase();
      continue;
    }

    // Section headers: "Education:", "Experience:", etc.
    const sectionMatch = trimmed.match(/^(Education|Experience|Skills|Projects|Hobbies):\s*(.*)$/i);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase();
      continue;
    }

    // Bullet points under a list section
    if (currentSection && (trimmed.startsWith('*') || trimmed.startsWith('-') || trimmed.startsWith('•'))) {
      const val = trimmed.replace(/^[*\-•]\s*/, '').trim();
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

function storeTempFile(filePath) {
  const token = crypto.randomUUID();
  const cleanup = setTimeout(() => {
    tempFiles.delete(token);
    fs.unlink(filePath, () => {});
  }, 10 * 60 * 1000);
  tempFiles.set(token, { filePath, cleanup });
  return token;
}

app.get('/resume/:token', (req, res) => {
  const entry = tempFiles.get(req.params.token);
  if (!entry) return res.status(404).send('File not found or expired.');
  res.download(entry.filePath, 'resume.docx', (err) => {
    if (err) console.error('File download error:', err);
  });
});

const WELCOME_MESSAGE =
  'Hi 👋\nI help you create a professional resume in 2 minutes.\n\nReply:\n1 - Create new resume\n2 - Upload existing resume';

const SYSTEM_PROMPT = `You are a friendly resume-building assistant on WhatsApp. Help the user create a professional resume by collecting information in a natural conversation.

Collect the following details, asking only 1-2 questions at a time:
1. Full name
2. City / location
3. Education (degree, institution, graduation year)
4. Work experience (job title, company, duration, key responsibilities) — they may have more than one role
5. Skills (technical and soft skills)
6. Projects (optional)
7. Hobbies / interests (optional)

Rules:
- Be warm, encouraging, and concise — messages must be short and mobile-friendly
- Never use markdown (no **, ##, bullet dashes) — use plain text and line breaks only
- Ask only 1-2 questions per message
- If the user gives incomplete answers, gently ask for more detail
- If the conversation starts with pre-loaded resume data, confirm what you found and only ask for missing or unclear fields — do not re-ask for information already provided
- Once you have all the core information (name, city, education, experience, skills), give a short summary of what was collected, then ask:
  "Great, I have everything I need! Shall I generate your resume now? Reply YES to continue."
- If the user replies YES (or yes / y), respond with exactly this token and nothing else: GENERATE_RESUME
- If the user seems confused or wants to restart, guide them back on track`;

const EXTRACT_PROMPT = `You are a resume data extractor. Given resume text or a conversation, extract the information and return it in this EXACT plain-text format with these EXACT section headers. Do not use JSON. Do not add any explanation.

Name: [full name]
City: [city, country]
Summary: [2-3 sentence professional summary in third person]

Education:
* [Degree], [Institution], [Year]

Experience:
* [Job Title], [Company], [Duration], [Key responsibilities]

Skills:
* [Skill]

Projects:
* [Project description]

Hobbies:
* [Hobby]

Rules:
- Use exactly the section headers above
- Use * bullet points for list sections
- If a section has no data, omit it entirely
- Do not add any other text, JSON, or markdown`;

app.post('/whatsapp', async (req, res) => {
  const incomingMsg = (req.body.Body || '').trim();
  const from = req.body.From || 'unknown';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl = req.body.MediaUrl0 || null;
  const mediaContentType = req.body.MediaContentType0 || '';

  console.log('NumMedia:', req.body.NumMedia);
  console.log('MediaUrl:', req.body.MediaUrl0);
  console.log('MediaType:', req.body.MediaContentType0);

  // Download media immediately before any other processing — Twilio URLs expire fast
  let preDownloaded = null;
  if (numMedia > 0 && mediaUrl) {
    try {
      preDownloaded = await downloadTwilioMedia(mediaUrl, mediaContentType);
    } catch (err) {
      console.error('Immediate media download failed:', err.message);
    }
  }

  let replyText;
  let mediaReplyUrl = null;

  try {
    const result = numMedia > 0 && mediaUrl
      ? await handleMediaUpload(from, mediaContentType, preDownloaded)
      : await handleMessage(from, incomingMsg);
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

async function handleMessage(from, incomingMsg) {
  const lower = incomingMsg.toLowerCase();

  if (lower === '0' || lower === 'menu' || lower === 'restart') {
    sessions.delete(from);
    return { text: WELCOME_MESSAGE };
  }

  const session = sessions.get(from);

  if (!session) {
    if (incomingMsg === '1') {
      sessions.set(from, { messages: [], resumeData: {} });
      const reply = await askClaude(from, 'Hi, I want to create a new resume. Please get started.');
      return { text: reply };
    }
    if (incomingMsg === '2') {
      return { text: 'Please send your resume file (PDF or Word .docx) and I will extract your information automatically.' };
    }
    return { text: WELCOME_MESSAGE };
  }

  const claudeReply = await askClaude(from, incomingMsg);

  if (claudeReply.trim() === 'GENERATE_RESUME') {
    const messages = session.messages;
    const existingData = session.resumeData || {};
    sessions.delete(from);
    return await buildAndSendResume(from, messages, existingData);
  }

  return { text: claudeReply };
}

async function handleMediaUpload(from, contentType, preDownloaded) {
  const supportedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];

  if (!supportedTypes.includes(contentType)) {
    return {
      text: 'Sorry, I can only read PDF or Word (.docx) files.\n\nPlease send one of those, or type 1 to create a resume from scratch.',
    };
  }

  if (!preDownloaded) {
    return { text: 'I could not download your file. Please try again or type 1 to start fresh.' };
  }

  const { buffer, tmpPath } = preDownloaded;

  // Extract text from saved /tmp file
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
    return {
      text: 'I could not read your file. It may be corrupted or password-protected. Please try another file or type 1 to start fresh.',
    };
  } finally {
    fs.unlink(tmpPath, () => {});
  }

  if (!text.trim()) {
    return {
      text: 'Your file appears to be empty or image-based. Please send a text-based PDF or Word file, or type 1 to create a resume from scratch.',
    };
  }

  // Extract structured resume data via Claude
  let resumeData = {};
  try {
    const extraction = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: `Extract resume data from this document:\n\n${text.slice(0, 8000)}` }],
    });
    resumeData = parseStructuredText(extraction.content[0].text);
  } catch (err) {
    console.error('Resume data extraction error:', err.message);
    // Fall back: start a fresh session and ask Claude to collect info manually
    sessions.set(from, { messages: [], resumeData: {} });
    const fallbackReply = await askClaude(from, 'I uploaded my resume but could not read all the data. Please ask me for my details one section at a time.');
    return { text: 'I could not fully read your resume. Let me ask you a few quick questions instead.\n\n' + fallbackReply };
  }

  // Create session with pre-loaded data
  sessions.set(from, { messages: [], resumeData });

  // Feed extracted data into the conversation so Claude can confirm and ask for gaps
  const contextMessage = `I have uploaded my existing resume. Here is the data extracted from it:\n${JSON.stringify(resumeData, null, 2)}\n\nPlease confirm what you found and ask me about any missing or unclear fields.`;

  const claudeReply = await askClaude(from, contextMessage);

  return {
    text: 'I found some information in your resume. Let me confirm a few details.\n\n' + claudeReply,
  };
}

async function downloadTwilioMedia(mediaUrl, contentType) {
  console.log('Media type:', contentType);
  console.log('Downloading media immediately...');

  const credentials = Buffer.from(
    process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN
  ).toString('base64');

  const fetchWithAuth = () => fetch(mediaUrl, {
    headers: { Authorization: 'Basic ' + credentials },
  });

  let response = await fetchWithAuth();

  // Retry once on failure
  if (!response.ok) {
    console.log('Download failed (' + response.status + '), retrying once...');
    response = await fetchWithAuth();
  }

  if (!response.ok) {
    throw new Error('Media download failed after retry: ' + response.status + ' ' + response.statusText);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log('Media downloaded successfully, size:', buffer.length, 'bytes');

  const ext = contentType === 'application/pdf' ? 'pdf' : 'docx';
  const tmpPath = path.join(os.tmpdir(), 'upload-' + crypto.randomUUID() + '.' + ext);
  fs.writeFileSync(tmpPath, buffer);
  console.log('File saved to:', tmpPath);

  return { buffer, tmpPath };
}

async function buildAndSendResume(from, messages, existingData) {
  try {
    // Re-extract from the full conversation, merging with pre-loaded data
    const extraction = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: EXTRACT_PROMPT,
      messages,
    });

    let resumeData = existingData;
    try {
      const fresh = parseStructuredText(extraction.content[0].text);
      // Fresh conversation data takes precedence; fall back to pre-loaded data
      resumeData = {
        name: fresh.name || existingData.name || '',
        city: fresh.city || existingData.city || '',
        summary: fresh.summary || existingData.summary || '',
        education: fresh.education && fresh.education.length ? fresh.education : (existingData.education || []),
        experience: fresh.experience && fresh.experience.length ? fresh.experience : (existingData.experience || []),
        skills: fresh.skills && fresh.skills.length ? fresh.skills : (existingData.skills || []),
        projects: fresh.projects && fresh.projects.length ? fresh.projects : (existingData.projects || []),
        hobbies: fresh.hobbies && fresh.hobbies.length ? fresh.hobbies : (existingData.hobbies || []),
      };
    } catch (err) {
      console.error('Failed to parse resume structured text:', err.message, '— using existing data');
    }

    const filePath = await generateDocx(resumeData);
    const token = storeTempFile(filePath);
    const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
    const fileUrl = `${baseUrl}/resume/${token}`;

    // Keep session alive for possible edits
    sessions.set(from, { messages: [], resumeData });

    return {
      text: 'Here is your resume! 📄\n\nWould you like to edit anything in your resume?',
      mediaUrl: fileUrl,
    };
  } catch (err) {
    console.error('Resume build error:', err);
    return { text: 'Sorry, there was an error generating your resume. Please type 1 to try again.' };
  }
}

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
      children: [new TextRun({ text: data.name || '', bold: true, size: 56, color: '2E4057' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    })
  );

  // City
  if (data.city) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.city, size: 22, color: '666666' })],
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

  // Education
  if (data.education && data.education.length > 0) {
    children.push(heading('EDUCATION'));
    for (const edu of data.education) {
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
    }
  }

  // Experience
  if (data.experience && data.experience.length > 0) {
    children.push(heading('WORK EXPERIENCE'));
    for (const exp of data.experience) {
      const line = [exp.title, exp.company, exp.duration].filter(Boolean).join('  |  ');
      children.push(
        new Paragraph({ children: [new TextRun({ text: line, bold: true, size: 22 })] })
      );
      if (exp.responsibilities) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: exp.responsibilities, size: 20 })],
            spacing: { after: 120 },
          })
        );
      }
    }
  }

  // Skills
  if (data.skills && data.skills.length > 0) {
    children.push(heading('SKILLS'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.skills.join('  •  '), size: 20 })],
        spacing: { after: 100 },
      })
    );
  }

  // Projects
  if (data.projects && data.projects.length > 0) {
    children.push(heading('PROJECTS'));
    for (const proj of data.projects) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: proj, size: 20 })],
          spacing: { after: 80 },
        })
      );
    }
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

async function askClaude(from, userMessage) {
  const session = sessions.get(from);
  session.messages.push({ role: 'user', content: userMessage });

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: session.messages,
  });

  const assistantText = response.content[0].text;
  session.messages.push({ role: 'assistant', content: assistantText });
  return assistantText;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  console.log('TWILIO_ACCOUNT_SID:', process.env.TWILIO_ACCOUNT_SID ? 'FOUND' : 'MISSING');
  console.log('TWILIO_AUTH_TOKEN:', process.env.TWILIO_AUTH_TOKEN ? 'FOUND' : 'MISSING');
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'FOUND' : 'MISSING');
  console.log('BASE_URL:', process.env.BASE_URL || 'NOT SET');
});
