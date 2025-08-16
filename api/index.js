const axios = require('axios');
const express = require('express');
const app = express();

app.get('/', async (req, res) => {
  const subreddit = req.query.subreddit || 'python';
  const query = req.query.query || 'API';
  const limit = parseInt(req.query.limit) || 5;  // Lower default for speed
  try {
    const redditId = process.env.REDDIT_ID;
    const redditSecret = process.env.REDDIT_SECRET;
    const auth = { username: redditId, password: redditSecret };
    const tokenData = { grant_type: 'client_credentials', user_agent: 'myRedditApp/0.1' };
    const tokenResp = await axios.post('https://www.reddit.com/api/v1/access_token', new URLSearchParams(tokenData), { auth });
    const token = tokenResp.data.access_token;

    const headers = { Authorization: `bearer ${token}`, 'User-Agent': 'myRedditApp/0.1' };
    const redditUrl = `https://oauth.reddit.com/r/${subreddit}/search?q=${query}&limit=${limit}&restrict_sr=true`;
    const response = await axios.get(redditUrl, { headers });
    let posts = response.data.data.children.map(p => ({ title: p.data.title, content: p.data.selftext }));

    const deepseekKey = process.env.DEEPSEEK_KEY;
    // Parallel enrich: Promise.all for speed
    const enrichPromises = posts.map(post => {
      const prompt = `Analyze this Reddit post and output ONLY valid JSON: { "summary": "Short summary (1-2 sentences)", "sentiment": "positive/negative/neutral", "sentiment_score": number from 1-10 (10 most positive), "key_insights": ["bullet1", "bullet2"] }. Post: ${post.title}. Content: ${post.content}.`;
      return axios.post('https://api.deepseek.com/v1/chat/completions', {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300
      }, { headers: { Authorization: `Bearer ${deepseekKey}` } })
        .then(deepResp => {
          try {
            post.enriched = JSON.parse(deepResp.data.choices[0].message.content);  // Parse structured JSON
          } catch {
            post.enriched = { error: 'Failed to parse AI response' };
          }
          return post;
        });
    });
    const enriched = await Promise.all(enrichPromises);

    res.json({ posts: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
