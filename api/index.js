// server.js
// Express + Reddit fetch + DeepSeek enrichment with STRICT function-calling JSON output

const axios = require("axios");
const express = require("express");
const app = express();

// Optional: simple health endpoint
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/", async (req, res) => {
  const subreddit = req.query.subreddit || "python";
  const query = req.query.query || "API";
  const limit = Number.parseInt(req.query.limit, 10) || 5;
  const enrich = req.query.enrich !== "false";

  try {
    // ===== 1) Reddit auth + fetch =====
    const redditId = process.env.REDDIT_ID;
    const redditSecret = process.env.REDDIT_SECRET;
    if (!redditId || !redditSecret) {
      throw new Error("Missing REDDIT_ID / REDDIT_SECRET env vars");
    }

    const tokenResp = await axios.post(
      "https://www.reddit.com/api/v1/access_token",
      new URLSearchParams({ grant_type: "client_credentials" }),
      {
        auth: { username: redditId, password: redditSecret },
        headers: { "User-Agent": "myRedditApp/0.1" },
        timeout: 30000
      }
    );

    const token = tokenResp.data.access_token;
    const headers = {
      Authorization: `bearer ${token}`,
      "User-Agent": "myRedditApp/0.1"
    };

    const redditUrl =
      `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}` +
      `/search?q=${encodeURIComponent(query)}&limit=${limit}&restrict_sr=true`;

    const response = await axios.get(redditUrl, { headers, timeout: 30000 });

    let posts = (response.data?.data?.children || []).map((p) => ({
      title: p?.data?.title || "",
      content: p?.data?.selftext || "",
      source_url: `https://reddit.com${p?.data?.permalink || ""}`
    }));

    // ===== 2) Enrich via DeepSeek (forced JSON via function-calling) =====
    if (enrich && posts.length > 0) {
      const deepseekKey = process.env.DEEPSEEK_KEY;
      if (!deepseekKey) throw new Error("Missing DEEPSEEK_KEY env var");

      // Tool schema: EXACT fields required
      const tools = [
        {
          type: "function",
          function: {
            name: "store_analysis",
            description:
              "Return structured JSON analysis for each input post IN ORDER. " +
              "Include summary, sentiment, sentiment_score, key_insights for every item.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                items: {
                  type: "array",
                  minItems: posts.length,
                  maxItems: posts.length,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      summary: { type: "string", minLength: 1 },
                      sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
                      sentiment_score: { type: "integer", minimum: 1, maximum: 10 },
                      key_insights: {
                        type: "array",
                        items: { type: "string" },
                        minItems: 2,
                        maxItems: 3
                      }
                    },
                    required: ["summary", "sentiment", "sentiment_score", "key_insights"]
                  }
                }
              },
              required: ["items"]
            }
          }
        }
      ];

      // System/user messages — deterministic, say "json", and define neutral defaults for empty content
      const systemMsg =
        "You are a strict JSON analyst. Use the tool ONLY. Output JSON via the function call; no prose. " +
        "For posts with empty content, base your analysis on the title and set sentiment to \"neutral\" and sentiment_score to 5 " +
        "unless the title clearly implies another tone. Always return exactly one item per input, preserving order.";

      const userMsg = {
        instruction: "json batch enrichment",
        spec: {
          fields_required: ["summary", "sentiment", "sentiment_score", "key_insights"],
          scoring_rule:
            "sentiment_score is an INTEGER from 1..10 (10 most positive, 5 neutral, 1 most negative)"
        },
        posts: posts.map((p) => ({
          title: p.title || "",
          content: p.content || ""
        }))
      };

      const deepResp = await axios.post(
        "https://api.deepseek.com/v1/chat/completions",
        {
          model: "deepseek-chat",
          temperature: 0,
          max_tokens: 2000, // prevent truncation
          // JSON mode is not necessary when forcing a tool call, but harmless if kept off.
          messages: [
            { role: "system", content: systemMsg },
            { role: "user", content: JSON.stringify(userMsg) }
          ],
          tools,
          // Force our tool; prevents any freeform assistant text
          tool_choice: { type: "function", function: { name: "store_analysis" } }
        },
        {
          headers: {
            Authorization: `Bearer ${deepseekKey}`,
            "Content-Type": "application/json"
          },
          timeout: 60000
        }
      );

      // Parse tool call JSON args (OpenAI-compatible)
      const choice = deepResp?.data?.choices?.[0];
      const msg = choice?.message;

      // Handle both modern `tool_calls` and legacy `function_call` just in case
      let argsStr = "";
      if (msg?.tool_calls?.length) {
        argsStr = msg.tool_calls[0]?.function?.arguments || "";
      } else if (msg?.function_call) {
        argsStr = msg.function_call?.arguments || "";
      }

      let items = [];
      try {
        const parsed = JSON.parse(argsStr || "{}");
        if (Array.isArray(parsed?.items)) items = parsed.items;
      } catch (_) {
        // leave items empty; we'll fallback below
      }

      // Normalization to guarantee all fields are present and valid
      const normalize = (it = {}, fallbackTitle = "") => {
        const s = (it.sentiment || "").toLowerCase();
        let score = Number.isInteger(it.sentiment_score) ? it.sentiment_score : NaN;
        if (!Number.isInteger(score)) {
          score = s === "positive" ? 8 : s === "negative" ? 2 : 5;
        }
        score = Math.max(1, Math.min(10, score));

        let insights = Array.isArray(it.key_insights) ? it.key_insights.slice(0, 3) : [];
        if (insights.length < 2) {
          insights = ["No additional insights", "Verify source context"];
        }

        return {
          summary:
            it.summary && String(it.summary).trim()
              ? String(it.summary).trim()
              : (fallbackTitle ? `Summary: ${fallbackTitle}` : "Summary unavailable"),
          sentiment: ["positive", "neutral", "negative"].includes(s) ? s : "neutral",
          sentiment_score: score,
          key_insights: insights.map(String)
        };
      };

      posts = posts.map((post, i) => ({
        ...post,
        enriched: normalize(items[i], post.title)
      }));
    } else {
      posts = posts.map((p) => ({ ...p, enriched: null }));
    }

    res.json({ posts });
  } catch (error) {
    // Log more detail server-side; return safe message to client
    console.error("ERROR:", error?.response?.data || error?.message || error);
    res.status(500).json({
      error: error?.message || "Unknown error",
      hint:
        "Check env vars (REDDIT_ID/REDDIT_SECRET/DEEPSEEK_KEY), network, and that DeepSeek API is reachable."
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

module.exports = app;
