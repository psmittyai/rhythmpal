const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../lib/auth');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /api/food/analyze-photo
router.post('/analyze-photo', requireAuth, async (req, res) => {
  try {
    const { image } = req.body;

    if (!image || !image.data || !image.mediaType) {
      return res.status(400).json({ error: 'Image data and mediaType required' });
    }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      system: 'You are a precise nutrition analyst. When shown a food photo, identify every food item visible and estimate: total calories, protein (g), carbs (g), fat (g), fiber (g). Be specific and realistic. Return ONLY valid JSON, no markdown, no explanation.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mediaType,
                data: image.data,
              },
            },
            {
              type: 'text',
              text: 'Analyze this food photo. Return JSON: { "foodName": string, "description": string, "calories": number, "protein": number, "carbs": number, "fat": number, "fiber": number, "confidence": "high"|"medium"|"low", "items": [{"name": string, "portion": string, "calories": number}] }',
            },
          ],
        },
      ],
    });

    const raw = response.content[0].text.trim();
    let parsed;
    try {
      // Strip any accidental markdown fences
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Food photo parse error:', parseErr, 'Raw:', raw);
      return res.status(422).json({ error: 'Could not analyze photo' });
    }

    res.json(parsed);
  } catch (err) {
    console.error('Food photo analyze error:', err);
    res.status(500).json({ error: 'Could not analyze photo' });
  }
});

module.exports = router;
