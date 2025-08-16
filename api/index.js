const axios = require('axios');
const express = require('express');
const app = express();

app.get('/', async (req, res) => {
  const subreddit = req.query.subreddit || 'python';
  const query = req.query.query || 'API';
  const limit = parseInt(req.query.limit) || 5;
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
    let posts = response.data.data.children.map(p => ({ 
      title: p.data.title, 
      content: p.data.selftext, 
      source_url: `https://reddit.com${p.data.permalink}`
    }));

    const deepseekKey = process.env.DEEPSEEK_KEY;
    const enrichPromises = posts.map(post => {
      const prompt = `Output ONLY pure valid JSON (no extra text, no markdown). Example output: { "summary": "Example summary", "sentiment": "neutral", "sentiment_score": 5, "key_insights": ["Point 1", "Point 2"] }. Analyze post (use title if no content): Title: ${post.title}. Content: ${post.content || 'No content - base on title'}.`;
      return axios.post('https://api.deepseek.com/v1/chat/completions', {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        response_format: { type: 'json_object' }  // Enable strict JSON mode
      }, { headers: { Authorization: `Bearer ${deepseekKey}` } })
        .then(deepResp => {
          let content = deepResp.data.choices[0].message.content.trim();
          try {
            content = content.replace(/,\s*([}\]])/g, '$1');  // Fix trailing commas
            post.enriched = JSON.parse(content);
          } catch (e) {
            post.enriched = { 
              summary: 'Fallback summary based on title: ' + post.title.substring(0, 100),
              sentiment: 'neutral', 
              sentiment_score: 5, 
              key_insights: ['Check source for details'] 
            };
          }
          return post;
        }).catch(() => {
          post.enriched = { 
            summary: 'AI failed - using title', 
            sentiment: 'neutral', 
            sentiment_score: 5, 
            key_insights: [] 
          };
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
