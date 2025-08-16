const axios = require('axios');
const express = require('express');
const app = express();

app.get('/', async (req, res) => {
  const subreddit = req.query.subreddit || 'python';
  const query = req.query.query || 'API';
  const limit = parseInt(req.query.limit) || 5;
  const enrich = req.query.enrich !== 'false';  // Default true, ?enrich=false to skip for speed
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
      const enrichPromises = posts.map(post => {
        const prompt = `Respond with ONLY a valid JSON object, no other text, no markdown, no explanations, nothing else. Use this exact structure: { "summary": "1-2 sentence summary (use title if no content)", "sentiment": "positive/negative/neutral", "sentiment_score": 1 to 10 number (10 most positive, 5 if neutral or empty)", "key_insights": ["short bullet 1", "short bullet 2", "short bullet 3"] }. Analyze: Title: ${post.title}. Content: ${post.content || 'No content - use title for neutral analysis'}.`;
        return axios.post('https://api.deepseek.com/v1/chat/completions', {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 150,  // Lower for speed
          response_format: { type: 'json_object' }
        }, { headers: { Authorization: `Bearer ${deepseekKey}` } })
          .then(deepResp => {
            let content = deepResp.data.choices[0].message.content.trim();
            // Extract JSON if wrapped/extra text
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) content = jsonMatch[0];
            try {
              content = content.replace(/,\s*([}\]])/g, '$1');  // Fix commas
              post.enriched = JSON.parse(content);
            } catch (e) {
              post.enriched = { 
                summary: 'Fallback: ' + post.title.substring(0, 100),
                sentiment: 'neutral', 
                sentiment_score: 5, 
                key_insights: ['Based on title only - check source'] 
              };
            }
            return post;
          }).catch(() => {
            post.enriched = { 
              summary: 'AI failed', 
              sentiment: 'neutral', 
              sentiment_score: 5, 
              key_insights: [] 
            };
            return post;
          });
      });
      posts = await Promise.all(enrichPromises);
    } else {
      // No enrich - faster
      posts.forEach(post => post.enriched = null);
    }

    res.json({ posts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
