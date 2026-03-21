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
