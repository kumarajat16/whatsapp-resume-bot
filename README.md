# WhatsApp Resume Bot

A WhatsApp bot built with Node.js, Express, and Twilio that helps users create professional resumes.

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the example env file and fill in your values:
   ```bash
   cp .env.example .env
   ```

3. Start the dev server:
   ```bash
   npm run dev
   ```

4. Expose your local server with ngrok:
   ```bash
   ngrok http 3000
   ```

5. Set the ngrok HTTPS URL as your Twilio WhatsApp sandbox webhook:
   ```
   https://xxxx.ngrok-free.app/whatsapp
   ```

## Deploy on Railway

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/whatsapp-resume-bot.git
git push -u origin main
```

### 2. Create a Railway project

1. Go to [railway.app](https://railway.app) and log in
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your repository

### 3. Set environment variables

In your Railway project, go to **Variables** and add:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | Your Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Your Twilio Auth Token |
| `OPENAI_API_KEY` | Your OpenAI API key |

> `PORT` is set automatically by Railway — do not set it manually.

### 4. Deploy

Railway will automatically deploy on every push to your main branch.

### 5. Set the webhook in Twilio

Once deployed, copy your Railway public URL (e.g. `https://whatsapp-resume-bot.up.railway.app`) and set it as the webhook in your Twilio WhatsApp sandbox:

```
https://whatsapp-resume-bot.up.railway.app/whatsapp
```

Go to: Twilio Console → Messaging → Try it out → Send a WhatsApp message → Sandbox Settings

## Environment Variables

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio Account SID (starts with AC) |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `OPENAI_API_KEY` | OpenAI API key (starts with sk-) |
| `PORT` | Server port (set automatically by Railway) |
