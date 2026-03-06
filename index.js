const express = require('express');
const { twiml: { MessagingResponse } } = require('twilio');
const Anthropic = require('@anthropic-ai/sdk').default;
const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } = require('docx');
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

// In-memory session store: phone -> { messages: [] }
const sessions = new Map();

// Temp file store: token -> filePath (auto-cleaned after 10 minutes)
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

// Serve generated resume files temporarily
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
- Once you have all the core information (name, city, education, experience, skills), give a short summary of what was collected, then ask:
  "Great, I have everything I need! Shall I generate your resume now? Reply YES to continue."
- If the user replies YES (or yes / y), respond with exactly this token and nothing else: GENERATE_RESUME
- If the user seems confused or wants to restart, guide them back on track`;

const EXTRACT_PROMPT = `You are a data extractor. Given a resume conversation, extract all resume data and return ONLY valid JSON with this exact structure:
{
  "name": "Full Name",
  "city": "City, Country",
  "summary": "2-3 sentence professional summary written in third person",
  "education": [{"degree": "...", "institution": "...", "year": "..."}],
  "experience": [{"title": "...", "company": "...", "duration": "...", "responsibilities": "..."}],
  "skills": ["skill1", "skill2"],
  "projects": ["project description"],
  "hobbies": ["hobby1", "hobby2"]
}
Generate a compelling professional summary based on the collected data.
Return ONLY the JSON object. No explanation, no markdown, no code block.`;

app.post('/whatsapp', async (req, res) => {
  const incomingMsg = (req.body.Body || '').trim();
  const from = req.body.From || 'unknown';

  let replyText;
  let mediaUrl = null;

  try {
    const result = await handleMessage(from, incomingMsg);
    replyText = result.text;
    mediaUrl = result.mediaUrl || null;
  } catch (err) {
    console.error('Error handling message:', err);
    replyText = 'Something went wrong. Please try again in a moment.';
  }

  const twiml = new MessagingResponse();
  const msg = twiml.message(replyText);
  if (mediaUrl) msg.media(mediaUrl);

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
      sessions.set(from, { messages: [] });
      const reply = await askClaude(from, 'Hi, I want to create a new resume. Please get started.');
      return { text: reply };
    }
    if (incomingMsg === '2') {
      return { text: 'Resume upload is coming soon! 🚀\n\nReply 1 to create a new resume instead, or 0 for the main menu.' };
    }
    return { text: WELCOME_MESSAGE };
  }

  const claudeReply = await askClaude(from, incomingMsg);

  if (claudeReply.trim() === 'GENERATE_RESUME') {
    const messages = session.messages;
    sessions.delete(from);
    return await buildAndSendResume(from, messages);
  }

  return { text: claudeReply };
}

async function buildAndSendResume(from, messages) {
  try {
    // Step 1: Extract structured data from conversation
    const extractionResponse = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: EXTRACT_PROMPT,
      messages,
    });

    let resumeData;
    try {
      resumeData = JSON.parse(extractionResponse.content[0].text);
    } catch {
      console.error('Failed to parse resume JSON:', extractionResponse.content[0].text);
      return { text: 'Sorry, I had trouble reading your data. Please type 1 to try again.' };
    }

    // Step 2: Generate DOCX
    const filePath = await generateDocx(resumeData);

    // Step 3: Store file and build public URL
    const token = storeTempFile(filePath);
    const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
    const fileUrl = `${baseUrl}/resume/${token}`;

    // Step 4: Start a fresh session for the edit conversation
    sessions.set(from, { messages: [] });

    return {
      text: 'Here is your resume! 📄\n\nWould you like to edit anything in your resume?',
      mediaUrl: fileUrl,
    };
  } catch (err) {
    console.error('Resume generation error:', err);
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
        new Paragraph({
          children: [new TextRun({ text: line, bold: true, size: 22 })],
        })
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
        new Paragraph({
          children: [new TextRun({ text: line, bold: true, size: 22 })],
        })
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
      new Paragraph({
        children: [new TextRun({ text: data.hobbies.join(', '), size: 20 })],
      })
    );
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } },
        },
        children,
      },
    ],
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
