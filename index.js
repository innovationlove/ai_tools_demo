require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const officeParser = require('officeparser');
const fetch = require('node-fetch');

const app = express();
const PORT = 8082;

const upload = multer({ dest: 'uploads/' });
const auth = require('basic-auth');

const requireAuth = (req, res, next) => {

  if (process.env.PROD !== 'true') {
    return next(); // skip auth in non-prod
  }

  const user = auth(req);
  const validUser = 'ilove-ai-tools';
  const validPass = 'ilove-ai-tools-091106';

  if (!user || user.name !== validUser || user.pass !== validPass) {
    res.set('WWW-Authenticate', 'Basic realm="Restricted Area"');
    return res.status(401).send('Authentication required.');
  }

  next();
};
app.use(requireAuth);

app.use(express.static('public'));
app.use(express.json());

// Upload & parse office/PDF files
app.post('/upload-multi', upload.array('files'), async (req, res) => {
  const results = [];

  for (const file of req.files) {
    const ext = path.extname(file.originalname).toLowerCase();
    const filePath = file.path;

    try {
      const fileBuffer = fs.readFileSync(filePath); // Use buffer for better support
      const text = await officeParser.parseOfficeAsync(fileBuffer);
      results.push({ filename: file.originalname, text });
    } catch (err) {
      console.error(`Failed to parse ${file.originalname}:`, err.message);
      results.push({ filename: file.originalname, error: 'Failed to parse.' });
    } finally {
      fs.unlink(filePath, () => {}); // clean up temp file
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


// Proxy to Bedrock API (parsing listing details)
app.post('/process-listing-details', async (req, res) => {
  try {
    const { text } = req.body;

    const response = await fetch(`${process.env.API_ENDPOINT}/extract_listing_details`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.API_KEY
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Upstream error:', response.status, errorBody);
      return res.status(502).json({ error: 'Upstream API error', details: errorBody });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: 'Failed to process listing details.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

