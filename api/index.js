const axios = require('axios');
const express = require('express');
const app = express();

app.get('/', async (req, res) => {
  const subreddit = req.query.subreddit || 'python';
  const query = req.query.query || 'API';
  const limit = parseInt(req.query.limit) || 5;
  const enrich = req.query.enrich !== 'false';
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

    if (enrich) {
      const deepseekKey = process.env.DEEPSEEK_KEY;
      // Batch all posts into one prompt
      const batchPrompt = `Respond with ONLY a valid JSON array of objects (length ${posts.length}), nothing else. Each object: { "summary": "1-2 sentence summary (use title if no content)", "sentiment": "positive/negative/neutral", "sentiment_score": number 1 to 10 (10 most positive, 5 neutral/empty, base on tone)", "key_insights": array of 2-3 short strings }. Example for one: { "summary": "Test", "sentiment": "neutral", "sentiment_score": 5, "key_insights": ["Point1", "Point2"] }. Analyze these posts: ${JSON.stringify(posts.map(p => ({ title: p.title, content: p.content || 'No content - use title for neutral analysis' })))}.`;
      const deepResp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: batchPrompt }],
        max_tokens: 1000,  // Higher for batch, but efficient
        response_format: { type: 'json_object' }
      }, { headers: { Authorization: `Bearer ${deepseekKey}` } });

      let enrichedArray;
      try {
        let content = deepResp.data.choices[0].message.content.trim();
        const jsonMatch = content.match(/\[[\s\S]*\]/);  // Extract array if wrapped
        if (jsonMatch) content = jsonMatch[0];
        content = content.replace(/,\s*(\])/g, '$1');  // Fix commas
        enrichedArray = JSON.parse(content);
      } catch (e) {
        enrichedArray = posts.map(() => ({ 
          summary: 'Fallback analysis', 
          sentiment: 'neutral', 
          sentiment_score: 5, 
          key_insights: ['Based on title - check source'] 
        }));
      }

      // Merge enriched
      posts.forEach((post, i) => post.enriched = enrichedArray[i] || { sentiment_score: 5 });
    } else {
      posts.forEach(post => post.enriched = null);
    }

    res.json({ posts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
