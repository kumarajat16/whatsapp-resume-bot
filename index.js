const express = require('express');
const { twiml: { MessagingResponse } } = require('twilio');
const Anthropic = require('@anthropic-ai/sdk').default;

const app = express();
app.use(express.urlencoded({ extended: false }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory session store: phone number -> { messages: [] }
const sessions = new Map();

const WELCOME_MESSAGE =
  'Hi 👋\nI help you create a professional resume in 2 minutes.\n\nReply:\n1 - Create new resume\n2 - Upload existing resume';

const SYSTEM_PROMPT = `You are a friendly resume-building assistant on WhatsApp. Help the user create a professional resume by collecting information in a natural conversation.

Collect the following details, asking only 1-2 questions at a time:
1. Full name
2. City / location
3. Education (degree, institution, graduation year)
4. Work experience (job title, company, duration, key responsibilities) — they may have more than one role
5. Skills (technical and soft skills)

Rules:
- Be warm, encouraging, and concise — messages must be short and mobile-friendly
- Never use markdown (no **, ##, bullet dashes) — use plain text and line breaks only
- Ask only 1-2 questions per message
- If the user gives incomplete answers, gently ask for more detail
- Once you have all 5 categories of information, give a short summary of what was collected, then ask:
  "Great, I have everything I need! Shall I generate your resume now? Reply YES to continue."
- If the user replies YES (or yes / y), respond with exactly this token and nothing else: GENERATE_RESUME
- If the user seems confused or wants to restart, guide them back on track`;

app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = (req.body.Body || '').trim();
  const from = req.body.From || 'unknown';

  let replyText;

  try {
    replyText = await handleMessage(from, incomingMsg);
  } catch (err) {
    console.error('Error handling message:', err);
    replyText = 'Something went wrong. Please try again in a moment.';
  }

  twiml.message(replyText);
  res.type('text/xml');
  res.send(twiml.toString());
});

async function handleMessage(from, incomingMsg) {
  const lower = incomingMsg.toLowerCase();

  // Allow user to reset at any time
  if (lower === '0' || lower === 'menu' || lower === 'restart') {
    sessions.delete(from);
    return WELCOME_MESSAGE;
  }

  const session = sessions.get(from);

  // No active session — show menu or start flow
  if (!session) {
    if (incomingMsg === '1') {
      sessions.set(from, { messages: [] });
      const reply = await askClaude(from, 'Hi, I want to create a new resume. Please get started.');
      return reply;
    }

    if (incomingMsg === '2') {
      return 'Resume upload is coming soon! 🚀\n\nReply 1 to create a new resume instead, or 0 for the main menu.';
    }

    return WELCOME_MESSAGE;
  }

  // Active session — forward message to Claude
  const claudeReply = await askClaude(from, incomingMsg);

  if (claudeReply.trim() === 'GENERATE_RESUME') {
    sessions.delete(from);
    return (
      '✅ Generating your resume...\n\n' +
      'Resume generation is being set up. Your information has been saved.\n\n' +
      'Reply 1 to start a new resume or 0 for the main menu.'
    );
  }

  return claudeReply;
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
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/whatsapp`);
});
