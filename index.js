// ─── MINIMAL SERVER FOR RAILWAY DEBUGGING ───────────────────────────────────
// All application code is commented out below. This minimal server tests
// whether Railway can keep the container alive.

const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("ResumeWala.ai server alive");
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get("/privacy", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`
  <html>
  <head>
    <title>ResumeWala.ai Privacy Policy</title>
    <style>
      body { font-family: Arial; max-width: 800px; margin: 40px auto; line-height: 1.6; }
      h1 { color:#333; }
    </style>
  </head>
  <body>
    <h1>ResumeWala.ai Privacy Policy</h1>

    <p>ResumeWala.ai provides automated resume generation services through WhatsApp.</p>

    <h2>Information We Collect</h2>
    <ul>
      <li>Name</li>
      <li>Email</li>
      <li>Resume information provided by the user</li>
      <li>WhatsApp message content</li>
    </ul>

    <h2>How We Use Information</h2>
    <p>Information is used only to generate resumes and improve the service.</p>

    <h2>Data Sharing</h2>
    <p>We do not sell or share personal data with third parties.</p>

    <h2>Contact</h2>
    <p>Email: support@resumewala.ai</p>

  </body>
  </html>
  `);
});

app.get("/webhook", (req, res) => {

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    console.log("Webhook verification failed");
    res.sendStatus(403);
  }

});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});

/*
// ══════════════════════════════════════════════════════════════════════════════
// ORIGINAL APPLICATION CODE — COMMENTED OUT FOR DEBUGGING
// ══════════════════════════════════════════════════════════════════════════════

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

// --- The rest of the original code is preserved in index.js.bak ---
// --- Restore with: cp index.js.bak index.js ---

*/
