const axios = require('axios');
const express = require('express');
const app = express();

app.get('/', async (req, res) => {
  const subreddit = req.query.subreddit || 'python';
  const query = req.query.query || 'API';
  const limit = parseInt(req.query.limit) || 5;
  const enrich = req.query.enrich !== 'false';

  try {
    // ===== 1) Reddit auth + fetch =====
    const redditId = process.env.REDDIT_ID;
    const redditSecret = process.env.REDDIT_SECRET;
    if (!redditId || !redditSecret) {
      throw new Error('Missing REDDIT_ID / REDDIT_SECRET env vars');
    }
    const auth = { username: redditId, password: redditSecret };
    const tokenData = { grant_type: 'client_credentials' };
    const tokenResp = await axios.post(
      'https://www.reddit.com/api/v1/access_token',
      new URLSearchParams(tokenData),
      { auth, headers: { 'User-Agent': 'myRedditApp/0.1' } }
    );
    const token = tokenResp.data.access_token;

    const headers = {
      Authorization: `bearer ${token}`,
      'User-Agent': 'myRedditApp/0.1'
    };
    const redditUrl = `https://oauth.reddit.com/r/${subreddit}/search?q=${encodeURIComponent(
      query
    )}&limit=${limit}&restrict_sr=true`;
    const response = await axios.get(redditUrl, { headers });

    let posts = (response.data?.data?.children || []).map((p) => ({
      title: p.data.title || '',
      content: p.data.selftext || '',
      source_url: `https://reddit.com${p.data.permalink}`
    }));

    // ===== 2) Enrich via DeepSeek (JSON mode) =====
    if (enrich && posts.length) {
      const deepseekKey = process.env.DEEPSEEK_KEY;
      if (!deepseekKey) throw new Error('Missing DEEPSEEK_KEY env var');

      // System: force strict JSON behavior
      const systemMsg =
        'You are a strict JSON generator. Output ONLY valid json with a top-level object and the single key "items". No markdown, no code fences, no commentary.';

      // We wrap the array in an object due to JSON mode requirements
      const userPayload = {
        instruction: 'json structured analysis',
        spec: {
          length: posts.length,
          item_shape: {
            summary: 'string (1-2 sentences; use title if no content)',
            sentiment: '"positive" | "neutral" | "negative"',
            sentiment_score:
              'integer 1..10 (10 most positive, 5 neutral/empty, 1 most negative)',
            key_insights: 'array of 2-3 short strings'
          }
        },
        defaults: {
          when_empty_content: {
            sentiment: 'neutral',
            sentiment_score: 5
          }
        },
        example: {
          items: [
            {
              summary: 'Example summary',
              sentiment: 'neutral',
              sentiment_score: 5,
              key_insights: ['Point 1', 'Point 2']
            }
          ]
        },
        posts: posts.map((p) => ({
          title: p.title,
          content: p.content || 'No content'
        }))
      };

      const deepResp = await axios.post(
        'https://api.deepseek.com/v1/chat/completions',
        {
          model: 'deepseek-chat',
          temperature: 0,
          max_tokens: 2000, // ensure not truncated
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemMsg },
            { role: 'user', content: JSON.stringify(userPayload) }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${deepseekKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 60_000
        }
      );

      // ===== 3) Parse + normalize guaranteed fields =====
      const raw = deepResp?.data?.choices?.[0]?.message?.content?.trim() || '{}';

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Try to salvage if the model wrapped the JSON in fences (shouldn’t happen in JSON mode)
        const m = raw.match(/\{[\s\S]*\}$/);
        parsed = m ? JSON.parse(m[0]) : { items: [] };
      }

      const items = Array.isArray(parsed?.items) ? parsed.items : [];

      // Normalize and guarantee fields
      const normalizeItem = (it = {}, fallbackTitle = '') => {
        const sentiment = (it.sentiment || '').toLowerCase();
        let score = Number.isFinite(it.sentiment_score) ? it.sentiment_score : NaN;
        // If score missing, derive from sentiment
        if (!Number.isFinite(score)) {
          if (sentiment === 'positive') score = 8;
          else if (sentiment === 'negative') score = 2;
          else score = 5;
        }
        // Clamp to 1..10 and round to integer
        score = Math.max(1, Math.min(10, Math.round(score)));

        return {
          summary: it.summary || (fallbackTitle ? `Summary: ${fallbackTitle}` : 'Summary unavailable'),
          sentiment: ['positive', 'neutral', 'negative'].includes(sentiment)
            ? sentiment
            : 'neutral',
          sentiment_score: score,
          key_insights: Array.isArray(it.key_insights) && it.key_insights.length
            ? it.key_insights.slice(0, 3).map(String)
            : ['No additional insights']
        };
      };

      // Merge back onto posts, preserving order and guaranteeing a valid object
      posts = posts.map((post, i) => {
        const normalized = normalizeItem(items[i], post.title);
        return { ...post, enriched: normalized };
      });
    } else {
      posts.forEach((post) => (post.enriched = null));
    }

    res.json({ posts });
  } catch (error) {
    console.error(error?.response?.data || error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

module.exports = app;
