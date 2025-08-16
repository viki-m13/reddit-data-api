const axios = require('axios');
const express = require('express');
const app = express();

app.get('/', async (req, res) => {
  const subreddit = req.query.subreddit || 'python';
  const query = req.query.query || 'API';
  const limit = parseInt(req.query.limit) || 10;
  try {
    const redditId = 'G6FSxnM-Vi_8ro2GmgSeow';  // Replace
    const redditSecret = 'jSkhzR_7_OHn5LUR_ltCts275tStHA';  // Replace
    const auth = { username: redditId, password: redditSecret };
    const tokenData = { grant_type: 'client_credentials', user_agent: 'myRedditApp/0.1' };
    const tokenResp = await axios.post('https://www.reddit.com/api/v1/access_token', new URLSearchParams(tokenData), { auth });
    const token = tokenResp.data.access_token;

    const headers = { Authorization: `bearer ${token}`, 'User-Agent': 'myRedditApp/0.1' };
    const redditUrl = `https://oauth.reddit.com/r/${subreddit}/search?q=${query}&limit=${limit}&restrict_sr=true`;
    const response = await axios.get(redditUrl, { headers });
    let posts = response.data.data.children.map(p => ({ title: p.data.title, content: p.data.selftext }));

    const deepseekKey = 'sk-457f3a9291c74e9589c87eb822c98ae6';  // Replace
    const enriched = [];
    for (let post of posts) {
      const prompt = `Summarize this Reddit post: ${post.title}. Content: ${post.content}. Provide sentiment and insights.`;
      const deepResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200
      }, { headers: { Authorization: `Bearer ${deepseekKey}` } });
      post.enriched = deepResp.data.choices[0].message.content;
      enriched.push(post);
    }

    res.json({ posts: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
