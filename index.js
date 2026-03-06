require('dotenv').config();
const express = require('express');
const { twiml: { MessagingResponse } } = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  OPENAI_API_KEY,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OPENAI_API_KEY) {
  console.warn('Warning: Missing one or more required environment variables (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, OPENAI_API_KEY)');
}

const app = express();
app.use(express.urlencoded({ extended: false }));

app.post('/whatsapp', (req, res) => {
  const response = new MessagingResponse();

  response.message(
    'Hi 👋\nI help you create a professional resume in 2 minutes.\n\nReply:\n1 - Create new resume\n2 - Upload existing resume'
  );

  res.type('text/xml');
  res.send(response.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/whatsapp`);
});
