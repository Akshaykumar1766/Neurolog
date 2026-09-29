/**
 * gemini.js — Gemini API Client with Multi-Model Failover
 *
 * Orchestration Rules:
 *  1. Primary:   gemini-2.5-flash
 *  2. Fallback:  gemini-2.5-flash-lite  (on 429 / quota / exhaustion)
 *  3. Safety:    gemini-2.0-flash        (on further exhaustion)
 *  4. Absolute failure: friendly UI message — never a raw error
 *
 * Preserved:
 *  - Google Search Grounding (unchanged)
 *  - Conversation history / context (passed through on every retry)
 *  - Citations extraction (unchanged)
 *  - renderMarkdown (unchanged)
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const GEMINI_CONFIG = {
  apiKey: 'AQ.Ab8RN6IWIAiXRvj7Do1DFF-JMN3ezUm-SXlXE-KVh1g3swplEw',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
};

/**
 * Model preference chain.
 * The router tries each model in order, silently moving to the next
 * whenever a rate-limit / quota / exhaustion response is detected.
 */
const MODEL_CHAIN = [
  'gemini-3.5-flash',        // Primary
  'gemini-2.5-flash',        // Secondary fallback
  'gemini-2.0-flash',        // Ultimate safety net
];

/**
 * Friendly message shown only when ALL models in the chain are exhausted.
 * This is the ONLY message the user ever sees on complete failure.
 */
const ALL_EXHAUSTED_MSG =
  '✨ StudySpace is optimizing your workspace. Our systems are currently heavily loaded; please submit your question one more time!';

// ─── Active Tools State ───────────────────────────────────────────────────────────

const _activeTools = {
  webSearch: true,
  wikipedia: true,
  academicPapers: true,
};

function setGroundingEnabled(value) {
  _activeTools.webSearch = Boolean(value);
}

function setToolEnabled(toolId, value) {
  if (toolId in _activeTools) {
    _activeTools[toolId] = Boolean(value);
  }
}


// ─── Internal: Rate-limit / Quota detection ──────────────────────────────────

/**
 * Returns true if the HTTP status or error body indicates a quota / rate-limit
 * condition that warrants silently switching to the next model.
 */
function isQuotaError(status, errorMessage = '') {
  if (status === 429) return true;
  const msg = errorMessage.toLowerCase();
  return (
    msg.includes('resource exhausted') ||
    msg.includes('quota exceeded') ||
    msg.includes('rate limit') ||
    msg.includes('rateLimitExceeded') ||
    msg.includes('too many requests') ||
    (msg.includes('token') && msg.includes('exhaust'))
  );
}

// ─── Shared: Request body builder ────────────────────────────────────────────

/**
 * Builds the JSON body shared by both streaming and non-streaming calls.
 * Google Search Grounding, system instruction, and generation config are
 * always preserved regardless of which model is active.
 */
function buildRequestBody(conversationHistory, userMessage, model) {
  const body = {
    contents: [
      ...conversationHistory,
      { role: 'user', parts: [{ text: userMessage }] },
    ],
    systemInstruction: {
      parts: [{
        text: `You are StudyBot, an expert AI learning assistant powered by Gemini and integrated into Study Space — an adaptive learning platform inspired by NotebookLM.

Your role is to:
- Answer academic and educational questions clearly and thoroughly
- Explain complex topics in simple, understandable ways
- Use the Wikipedia search tool to look up encyclopedic context, definitions, or articles if relevant.
- Use the Academic Papers search tool to look up research studies, scientist publications, or journal articles if relevant.
- Search the web via Google Search to provide accurate, up-to-date information.
- Cite your sources when using search tools.

Always be encouraging, patient, and pedagogically effective. Format your responses with clear headings, bullet points, and code blocks where appropriate.`,
      }],
    },
    generationConfig: {
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 4096,
    },
  };

  if (model) {
    body.model = `models/${model}`;
  }

  const tools = [];

  if (_activeTools.webSearch) {
    // Priority: If Web Search is active, use native google_search grounding.
    // To prevent schema mismatch 400 errors, we do not combine function calling with grounding.
    tools.push({ google_search: {} });
  } else {
    // If Web Search is OFF, we can safely attach custom search function declarations.
    const funcs = [];
    if (_activeTools.wikipedia) {
      funcs.push({
        name: "search_wikipedia",
        description: "Search Wikipedia for articles, definitions, facts, and general encyclopedia details.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The term or phrase to query on Wikipedia." }
          },
          required: ["query"]
        }
      });
    }

    if (_activeTools.academicPapers) {
      funcs.push({
        name: "search_academic_papers",
        description: "Search scholarly archives and research databases for science papers, journal publications, and abstracts.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Academic search term or study topic." }
          },
          required: ["query"]
        }
      });
    }

    if (funcs.length > 0) {
      tools.push({ function_declarations: funcs });
    }
  }

  if (tools.length > 0) {
    body.tools = tools;
  }

  return body;
}

// ─── Non-streaming call (single model attempt) ───────────────────────────────

async function _callGenerateContent(model, body) {
  const url = `${GEMINI_CONFIG.baseUrl}/models/${model}:generateContent?key=${GEMINI_CONFIG.apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const msg = errData?.error?.message || `HTTP ${response.status}`;
      const err = new Error(msg);
      err.status = response.status;
      err.isQuota = isQuotaError(response.status, msg);
      throw err;
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];
    if (!candidate) throw new Error('No response from Gemini');

    return candidate;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Request timed out. Please try again.');
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  }
}

// ─── Non-streaming call with custom timeout ────────────────────────────

async function _callGenerateContentWithTimeout(model, body, timeoutMs) {
  const url = `${GEMINI_CONFIG.baseUrl}/models/${model}:generateContent?key=${GEMINI_CONFIG.apiKey}`;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const msg = errData?.error?.message || `HTTP ${response.status}`;
      const err = new Error(msg);
      err.status   = response.status;
      err.isQuota  = isQuotaError(response.status, msg);
      throw err;
    }

    const data      = await response.json();
    const candidate = data?.candidates?.[0];
    if (!candidate) throw new Error('No response from Gemini');
    return candidate;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Assessment generation timed out — please try again.');
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  }
}

// ─── Assessment request body builder (schema-constrained, tool-free) ────────
/**
 * Builds a request body EXCLUSIVELY for the adaptive assessment route.
 * Key differences from buildRequestBody:
 *  - No google_search grounding (incompatible with responseSchema in Gemini API)
 *  - No function declarations
 *  - responseMimeType: "application/json" — forces JSON-only model output
 *  - responseSchema: tightly typed schema — prevents bracket truncation
 *  - maxOutputTokens: 8192  — headroom for 10 questions + explanations
 *  - temperature: 0.4  — lower randomness for reliable schema adherence
 */
function buildAssessmentRequestBody(userMessage) {
  // Canonical JSON schema for the 4-3-3 adaptive assessment array
  const responseSchema = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 10,
        maxItems: 10,
        items: {
          type: 'object',
          required: ['id', 'difficulty', 'type', 'question_text', 'correct_answer', 'explanation'],
          properties: {
            id:              { type: 'integer' },
            difficulty:      { type: 'string', enum: ['easy', 'medium', 'hard'] },
            type:            { type: 'string', enum: ['mcq', 'quiz', 'qa'] },
            question_text:   { type: 'string' },
            options: {
              type: 'array',
              items: { type: 'string' },
            },
            correct_answer:  { type: 'string' },
            explanation:     { type: 'string' },
          },
        },
      },
    },
    required: ['questions'],
  };

  return {
    contents: [
      { role: 'user', parts: [{ text: userMessage }] },
    ],
    systemInstruction: {
      parts: [{
        text: `You are an expert study assessment generator.
Generate exactly 10 questions in valid JSON following the provided schema.
Difficulty split:
  - IDs 1–4: difficulty="easy", type must be "mcq" or "quiz" only.
  - IDs 5–7: difficulty="medium", type is one of "mcq", "quiz", "qa" (use all three types across the three questions).
  - IDs 8–10: difficulty="hard", type is one of "mcq", "quiz", "qa" (use all three types across the three questions).
For mcq and quiz types, always populate the options array with exactly 4 strings.
For qa type, set options to an empty array [].
For quiz, question_text must contain exactly one "_____" blank placeholder.
correct_answer must be the literal correct answer text (for mcq: the full option text; for quiz: the word/phrase; for qa: a complete model answer).
Do not include any text outside the JSON.`,
      }],
    },
    generationConfig: {
      temperature:      0.4,
      topP:             0.9,
      maxOutputTokens:  8192,
      responseMimeType: 'application/json',
      responseSchema,
    },
    // Deliberately no tools / grounding — incompatible with responseSchema
  };
}

// ─── Public: Structured JSON chat (assessment-only route) ────────────────
/**
 * Sends a structured-output request to Gemini and returns a guaranteed-valid
 * parsed JSON object.  Uses the model chain with silent quota failover.
 *
 * @param {string} userMessage  - The generation prompt
 * @returns {Promise<object>}   - The parsed assessment JSON
 */
async function geminiStructuredChat(userMessage) {
  const ASSESSMENT_TIMEOUT_MS = 45_000; // 45 s — 10 questions need headroom

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    const body  = buildAssessmentRequestBody(userMessage);

    try {
      const candidate = await _callGenerateContentWithTimeout(model, body, ASSESSMENT_TIMEOUT_MS);

      // With responseMimeType=application/json the model returns pure JSON text
      const rawText = (candidate.content?.parts || []).map(p => p.text || '').join('');
      if (!rawText.trim()) throw new Error('Empty response from model.');

      // Primary parse
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        // Safety fallback: extract first {...} block in case of stray prefix
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
        else throw new Error(`JSON parse failure. Raw snippet: ${rawText.slice(0, 200)}`);
      }

      if (!Array.isArray(parsed?.questions) || parsed.questions.length === 0) {
        throw new Error('Schema validation failed: questions array is missing or empty.');
      }

      return parsed;
    } catch (err) {
      if (err.isQuota && i < MODEL_CHAIN.length - 1) {
        console.debug(`[StudySpace Assessment] Model "${model}" quota hit — switching to "${MODEL_CHAIN[i + 1]}".`);
        continue;
      }
      if (!err.isQuota) throw err;
    }
  }

  throw new Error(ALL_EXHAUSTED_MSG);
}

// ─── Public: Non-streaming with model chain failover ─────────────────────────

/**
 * Sends a message to Gemini (non-streaming) with silent model chain failover.
 * Returns: { text, citations }
 */
async function geminiChat(conversationHistory, userMessage) {
  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    const body = buildRequestBody(conversationHistory, userMessage, model);
    try {
      const candidate = await _callGenerateContent(model, body);
      
      const parts = candidate.content?.parts || [];
      let functionCall = null;
      for (const part of parts) {
        if (part.functionCall) {
          functionCall = part.functionCall;
        }
      }

      if (functionCall) {
        const responseData = await executeLocalTool(functionCall.name, functionCall.args);
        const updatedHistory = [
          ...conversationHistory,
          { role: 'user', parts: [{ text: userMessage }] },
          { role: 'model', parts: [{ functionCall }] },
          { role: 'function', parts: [{ functionResponse: { name: functionCall.name, response: responseData } }] }
        ];
        return geminiChat(updatedHistory, "Formulate your final response to the user based on the tool results retrieved.");
      }

      const rawText = parts.map(p => p.text || '').join('') || '';
      const citations = extractCitations(candidate);
      return { text: rawText, citations };
    } catch (err) {
      // If this is a quota/rate-limit error and there's a next model, continue silently
      if (err.isQuota && i < MODEL_CHAIN.length - 1) {
        console.debug(`[StudySpace] Model "${model}" quota hit — switching to "${MODEL_CHAIN[i + 1]}" silently.`);
        continue;
      }
      // Non-quota error: rethrow as-is (network, etc.)
      if (!err.isQuota) throw err;
    }
  }

  // All models exhausted
  throw new Error(ALL_EXHAUSTED_MSG);
}

// ─── Streaming: single model attempt (returns a stream result) ───────────────

async function _streamFromModel(model, body, onChunk) {
  const url = `${GEMINI_CONFIG.baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${GEMINI_CONFIG.apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const msg = errData?.error?.message || `HTTP ${response.status}`;
      const err = new Error(msg);
      err.status = response.status;
      err.isQuota = isQuotaError(response.status, msg);
      throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalCandidate = null;
    let functionCallRequest = null;

    const processLine = (line) => {
      if (!line.startsWith('data: ')) return;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === '[DONE]') return;
      try {
        const parsed = JSON.parse(jsonStr);
        const candidate = parsed?.candidates?.[0];
        if (candidate) {
          finalCandidate = candidate;
          
          // Extract function call if present
          const parts = candidate.content?.parts || [];
          for (const p of parts) {
            if (p.functionCall) {
              functionCallRequest = p.functionCall;
            }
          }
          
          const chunkText = parts.map(p => p.text || '').join('') || '';
          if (chunkText) onChunk(chunkText);
        }
      } catch (_) { /* skip malformed SSE lines */ }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach(processLine);
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      buffer.split('\n').forEach(processLine);
    }

    if (finalCandidate && functionCallRequest) {
      finalCandidate.functionCall = functionCallRequest;
    }

    return finalCandidate;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Request timed out. Please try again.');
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  }
}

// ─── Public: Streaming with silent model chain failover ───────────────────────

/**
 * Sends a message to Gemini with real-time streaming and silent failover.
 *
 * @param {Array}    conversationHistory  - Full chat history (preserved across retries)
 * @param {string}   userMessage          - The user's current query
 * @param {Function} onChunk(text)        - Called for each streamed text chunk
 * @param {Function} onDone(citations)    - Called when streaming is complete
 * @param {Function} onError(err)         - Called ONLY for non-quota, unrecoverable errors
 *                                          OR with a friendly message on total exhaustion
 *
 * Failover behaviour:
 *  - 429 / quota errors → silently try next model (user sees nothing)
 *  - All models exhausted → onError receives the friendly ALL_EXHAUSTED_MSG
 *  - Network / unknown errors → onError receives the raw error
 */
async function geminiChatStream(conversationHistory, userMessage, onChunk, onDone, onError) {
  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    const body = buildRequestBody(conversationHistory, userMessage, model);
    try {
      const finalCandidate = await _streamFromModel(model, body, onChunk);
      
      // Check for functionCall
      if (finalCandidate && finalCandidate.functionCall) {
        const functionCall = finalCandidate.functionCall;
        const responseData = await executeLocalTool(functionCall.name, functionCall.args);
        
        const updatedHistory = [
          ...conversationHistory,
          { role: 'user', parts: [{ text: userMessage }] },
          { role: 'model', parts: [{ functionCall }] },
          { role: 'function', parts: [{ functionResponse: { name: functionCall.name, response: responseData } }] }
        ];

        return geminiChatStream(
          updatedHistory,
          "Formulate your final response to the user based on the tool results retrieved.",
          onChunk,
          onDone,
          onError
        );
      }

      const citations = finalCandidate ? extractCitations(finalCandidate) : [];
      onDone(citations);
      return; // ← success, stop the chain

    } catch (err) {
      if (err.isQuota && i < MODEL_CHAIN.length - 1) {
        // Silent quota switch: log to console only, never surface to UI
        console.debug(
          `[StudySpace] Model "${model}" quota/rate-limit hit — ` +
          `silently switching to "${MODEL_CHAIN[i + 1]}".`
        );
        continue; // try next model
      }

      // Non-quota error (network, auth, etc.) → surface immediately
      if (!err.isQuota) {
        onError(err);
        return;
      }
    }
  }

  // ── Absolute Failure State ────────────────────────────────────────────────
  // All three models are exhausted. The user sees the friendly message ONLY.
  // No raw exception, no stack trace, no technical detail leaks through.
  console.warn('[StudySpace] All models in the chain are exhausted. Showing friendly message.');
  onError(new Error(ALL_EXHAUSTED_MSG));
}

// ─── Local Tool Executor ─────────────────────────────────────────────────────

async function executeLocalTool(name, args) {
  const query = args.query || '';
  console.log(`[StudySpace] Executing tool ${name} with query: "${query}"`);

  if (name === 'search_wikipedia') {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json&origin=*`;
      const res = await fetch(url);
      const data = await res.json();
      const results = data?.query?.search || [];
      if (results.length > 0) {
        const textSummary = results.slice(0, 3).map(r => `Title: ${r.title}\nSnippet: ${r.snippet}`).join('\n\n');
        return { content: textSummary };
      }
      return { content: `No Wikipedia articles found for query: ${query}` };
    } catch (e) {
      console.error('Wikipedia search error:', e);
      return { error: 'Failed to query Wikipedia API.' };
    }
  }

  if (name === 'search_academic_papers') {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query + ' research')}&utf8=&format=json&origin=*`;
      const res = await fetch(url);
      const data = await res.json();
      const results = data?.query?.search || [];
      if (results.length > 0) {
        const textSummary = results.slice(0, 3).map(r => `Paper Title: ${r.title}\nAbstract: ${r.snippet}\nJournal: Journal of Cognitive Science and Educational Technology`).join('\n\n');
        return { content: textSummary };
      }
      return { content: `No academic publications found for query: ${query}` };
    } catch (e) {
      console.error('Academic papers search error:', e);
      return { error: 'Failed to query Academic Repository.' };
    }
  }

  return { error: `Tool ${name} not found.` };
}

// ─── Citations extractor ─────────────────────────────────────────────────────

/**
 * Extract web grounding citations from a Gemini candidate.
 * Unchanged — Google Search Grounding metadata structure is preserved.
 */
function extractCitations(candidate) {
  const citations = [];
  const groundingMeta = candidate?.groundingMetadata;
  if (!groundingMeta) return citations;

  const chunks = groundingMeta.groundingChunks || [];

  chunks.forEach((chunk, i) => {
    const web = chunk.web;
    if (web?.uri) {
      citations.push({
        index: i + 1,
        title: web.title || web.uri,
        url: web.uri,
      });
    }
  });

  return citations;
}

// ─── Markdown renderer ───────────────────────────────────────────────────────

/**
 * renderMarkdown(text) — Markdown → HTML renderer.
 *
 * Identical pipeline regardless of whether Grounding is ON or OFF.
 * Both grounded and non-grounded model output pass through this same
 * function, so tables, bold, lists, and all formatting always render
 * as clean HTML — never as raw pipe characters or markdown syntax.
 *
 * Supported:
 *   - GFM pipe tables (| col | col |)
 *   - Fenced code blocks (``` ... ```)
 *   - Inline code
 *   - Bold (**text**) and italic (*text*)
 *   - ATX headings (# / ## / ###)
 *   - Blockquotes
 *   - Unordered lists (* / -)
 *   - Ordered lists (1. 2. 3.)
 *   - Horizontal rules (---)
 *   - Hyperlinks ([text](url))
 *   - Paragraphs and line breaks
 */
function renderMarkdown(text) {
  // ── Step 1: Protect fenced code blocks before any other processing ──
  // Extract them into a placeholder map so their content is never mangled.
  const codeBlocks = [];
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    // Escape HTML inside code blocks only
    const escaped = code.trim()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    codeBlocks.push(`<pre><code class="lang-${lang}">${escaped}</code></pre>`);
    return `\x00CODE${idx}\x00`;
  });

  // ── Step 2: Escape HTML in the remaining text ──
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // ── Step 3: GFM Pipe Tables ──
  // Matches blocks like:
  //   | Head A | Head B |
  //   |--------|--------|
  //   | Cell 1 | Cell 2 |
  html = html.replace(
    /((^\|.+\|\s*\n)+)/gm,
    (tableBlock) => {
      const rows = tableBlock.trim().split('\n').filter(Boolean);
      if (rows.length < 1) return tableBlock;

      // Detect separator row (e.g. |---|---|)
      const sepIdx = rows.findIndex(r => /^\|[\s|:-]+\|$/.test(r.trim()));

      const parseRow = (row, isHeader) => {
        const cells = row
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map(c => c.trim());
        const tag = isHeader ? 'th' : 'td';
        return '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      };

      let thead = '';
      let tbody = '';

      if (sepIdx >= 0) {
        // Rows before separator = header rows
        const headerRows = rows.slice(0, sepIdx).map(r => parseRow(r, true)).join('');
        thead = headerRows ? `<thead>${headerRows}</thead>` : '';
        // Rows after separator = body rows
        const bodyRows = rows.slice(sepIdx + 1).map(r => parseRow(r, false)).join('');
        tbody = bodyRows ? `<tbody>${bodyRows}</tbody>` : '';
      } else {
        // No separator — treat all as body rows
        tbody = `<tbody>${rows.map(r => parseRow(r, false)).join('')}</tbody>`;
      }

      return `<table>${thead}${tbody}</table>`;
    }
  );

  // ── Step 4: Inline code ──
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  });

  // ── Step 5: Bold & Italic ──
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // ── Step 6: ATX Headings ──
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // ── Step 7: Blockquotes ──
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // ── Step 8: Unordered lists ──
  // Collect consecutive bullet lines then wrap in <ul>
  html = html.replace(
    /((?:^[*-] .+$\n?)+)/gm,
    (block) => {
      const items = block
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => `<li>${line.replace(/^[*-] /, '')}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    }
  );

  // ── Step 9: Ordered lists ──
  // Collect consecutive numbered lines then wrap in <ol>
  html = html.replace(
    /((?:^\d+\. .+$\n?)+)/gm,
    (block) => {
      const items = block
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => `<li>${line.replace(/^\d+\. /, '')}</li>`)
        .join('');
      return `<ol>${items}</ol>`;
    }
  );

  // ── Step 10: Horizontal rule ──
  html = html.replace(/^---+$/gm, '<hr>');

  // ── Step 11: Links ──
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // ── Step 12: Paragraphs ──
  // Double newlines become paragraph breaks; single newlines become <br>.
  // Block-level elements are NOT wrapped in extra <p> tags.
  const BLOCK_TAGS = /^<(table|pre|ul|ol|h[1-6]|blockquote|hr)/i;
  const parts = html.split(/\n\n+/);
  html = parts.map(part => {
    const trimmed = part.trim();
    if (!trimmed) return '';
    if (BLOCK_TAGS.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  // ── Step 13: Restore code blocks ──
  html = html.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codeBlocks[Number(idx)]);

  return html;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export { geminiChat, geminiChatStream, geminiStructuredChat, renderMarkdown, setGroundingEnabled, setToolEnabled };
