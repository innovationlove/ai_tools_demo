// index.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const officeParser = require('officeparser');
const fetch = require('node-fetch');
const Tesseract = require('tesseract.js');

process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', reason => {
  console.error('Unhandled Rejection:', reason);
});

const app = express();
const PORT = 8082;

const upload = multer({ dest: 'uploads/' });
const auth = require('basic-auth');

const requireAuth = (req, res, next) => {
  if (process.env.PROD !== 'true') {
    return next();
  }

  const user = auth(req);
  const validUser = process.env.BASIC_AUTH_USER;
  const validPass = process.env.BASIC_AUTH_PASS;

  if (!user || user.name !== validUser || user.pass !== validPass) {
    res.set('WWW-Authenticate', 'Basic realm="Restricted Area"');
    return res.status(401).send('Authentication required.');
  }

  next();
};
app.use(requireAuth);
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static('public'));

// Upload & parse office/PDF/image files
app.post('/upload-multi', upload.array('files'), async (req, res) => {
  const results = [];
  const imageTypes = ['.jpg', '.jpeg', '.png'];
  const acceptedTypes = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', ...imageTypes];

  for (const file of req.files) {
    const ext = path.extname(file.originalname).toLowerCase();
    const filePath = file.path;

    try {
      // Skip unsupported types early
      if (!acceptedTypes.includes(ext)) {
        results.push({
          filename: file.originalname,
          text: '',
          warning: 'Unsupported file type.'
        });
        continue;
      }

      let text = '';

      // OCR for image types
      if (imageTypes.includes(ext)) {
        const { data: result } = await Tesseract.recognize(filePath, 'eng');
        text = result.text.trim();
      } else {
        // Office/PDF parsing
        const fileBuffer = fs.readFileSync(filePath);
        try {
          text = await officeParser.parseOfficeAsync(fileBuffer);
          text = (text || '').trim();
        } catch {
          text = ''; // fallback to empty on parse error
        }
      }

      // Only include result if text is meaningful
      if (text.length >= 20) {
        results.push({
          filename: file.originalname,
          text
        });
      } else {
        results.push({
          filename: file.originalname,
          text: '',
          warning: 'File parsed but contains little or no extractable text.'
        });
      }
    } catch (err) {
      results.push({
        filename: file.originalname,
        text: '',
        warning: 'Failed to parse file.'
      });
    } finally {
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
    }
  }

  res.json(results);
});

app.post('/process-paraphrase', async (req, res) => {
  try {
    const {
      title,
      description,
      location,
      price,
      bedrooms,
      bathrooms,
      propertyCondition,
      locationProvince,
      locationCity
    } = req.body;

    const response = await fetch(`${process.env.API_ENDPOINT}/paraphrase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.API_KEY
      },
      body: JSON.stringify({
        title,
        description,
        location,
        price: Number(price),
        bedrooms: Number(bedrooms),
        bathrooms: Number(bathrooms),
        propertyCondition,
        locationProvince,
        locationCity
      })
    });

    const result = await response.json();
    res.json(result);
  } catch (err) {
    console.error('Paraphrase error:', err);
    res.status(500).json({ error: 'Failed to process paraphrase request.' });
  }
});

app.post('/process-listing-details', async (req, res) => {
  try {
    const { text, model } = req.body;

    const cleanedText = typeof text === 'string' ? text.replace(/"/g, '') : '';
    const payload = { text: cleanedText };

    if (model === 'arn:aws:bedrock:ap-southeast-1:716337465006:inference-profile/apac.anthropic.claude-3-5-sonnet-20240620-v1:0') {
      payload.model = model;
    }

    const response = await fetch(`${process.env.API_ENDPOINT}/extract_listing_details`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.API_KEY
      },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();

    if (!response.ok) {
      console.error('Upstream error:', response.status, raw);
      return res.status(502).json({ error: 'Upstream API error', details: raw });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr.message);
      console.error('Raw response body:', raw);
      return res.status(500).json({ error: 'Malformed JSON response from Claude', raw });
    }

    res.json(data);
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: 'Failed to process listing details.' });
  }
});

app.post('/generate-project-summary', async (req, res) => {
  try {
    const { text } = req.body;
    const cleanedText = typeof text === 'string' ? text.replace(/"/g, '') : '';

    const response = await fetch(`${process.env.API_ENDPOINT}/generate_project_summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.API_KEY
      },
      body: JSON.stringify({ text: cleanedText })
    });

    const raw = await response.text();
    if (!response.ok) {
      console.error('Upstream error:', response.status, raw);
      return res.status(502).json({ error: 'Upstream API error', details: raw });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr.message);
      return res.status(500).json({ error: 'Malformed JSON response from Claude', raw });
    }

    res.json(data);
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: 'Failed to generate project summary.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

app.post('/aim-assistant-chat', async (req, res) => {
  try {
    const { inputText, sessionId } = req.body;
    if (!inputText) {
      return res.status(400).json({ error: 'Missing inputText' });
    }

    const response = await fetch(`${process.env.API_ENDPOINT}/aim-assistant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.API_KEY
      },
      body: JSON.stringify({
        inputText,
        sessionId
      })
    });

    console.log(sessionId);
    
    const raw = await response.text();
    if (!response.ok) {
      console.error('Assistant upstream error:', response.status, raw);
      return res.status(502).json({ error: 'Upstream error', details: raw });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return res.status(500).json({ error: 'Malformed JSON from agent', raw });
    }

    res.json(data);
  } catch (err) {
    console.error('Assistant error:', err);
    res.status(500).json({ error: 'Failed to reach assistant' });
  }


});