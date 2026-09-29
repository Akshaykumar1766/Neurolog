/**
 * gemini.js — Local AI Integration
 */

import { LOCAL_AI_CONFIG } from '../firebase-config.js';

// ─── Thread Recovery Setup ─────────────────────────────────────
const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
const activeTopic = params.get('topic') || 'New Study Session';
let conversationHistoryArray = [];
try {
  const cached = localStorage.getItem('neurolog_chat_cache_' + activeTopic);
  if (cached) {
    conversationHistoryArray = JSON.parse(cached);
  }
} catch (e) {
  console.error('Error recovering thread cache:', e);
}

// ─── Chat History Role Normalizer ─────────────────────────────
function formatHistoryForOllama(conversationHistory) {
  if (!Array.isArray(conversationHistory)) return [];
  return conversationHistory.map(msg => {
    let content = '';
    if (msg.parts && Array.isArray(msg.parts)) {
      content = msg.parts[0]?.text || '';
    } else {
      content = msg.text || msg.content || '';
    }
    
    let role = msg.role;
    if (role === 'model' || role === 'ai') {
      role = 'assistant';
    } else {
      role = 'user';
    }
    
    return { role, content };
  });
}

/**
 * Sends messages to a local OpenAI-compatible chat completion endpoint.
 */
async function geminiChat(conversationHistory, userMessage) {
  const STUDY_BOT_SYSTEM_INSTRUCTION = `You are StudyBot, an expert AI learning assistant integrated into Study Space — an adaptive learning platform inspired by NotebookLM.

Your role is to:
- Answer academic and educational questions clearly and thoroughly
- Explain complex topics in simple, understandable ways
- Always be encouraging, patient, and pedagogically effective. Format your responses with clear headings, bullet points, and code blocks where appropriate.`;

  let systemContent = STUDY_BOT_SYSTEM_INSTRUCTION;
  if (userMessage && userMessage.includes('grader')) {
    systemContent = "You are a study assessment grader. Evaluate the student's answer and return grading JSON.";
  }

  const normalized = formatHistoryForOllama(conversationHistory).slice(-6);
  const messages = [
    { role: 'system', content: systemContent },
    ...normalized
  ];

  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  const response = await fetch(LOCAL_AI_CONFIG.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: LOCAL_AI_CONFIG.modelName,
      messages: messages
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`HTTP error! status: ${response.status}. Details: ${errorText}`);
  }

  const data = await response.json();
  return {
    text: data.choices?.[0]?.message?.content || '',
    citations: []
  };
}

/**
 * Streams chat completion chunks from a local endpoint using a readable stream.
 */
async function geminiChatStream(conversationHistory, userMessage, onChunk, onDone, onError) {
  try {
    const STUDY_BOT_SYSTEM_INSTRUCTION = `You are StudyBot, an expert AI learning assistant integrated into Study Space — an adaptive learning platform inspired by NotebookLM.

Your role is to:
- Answer academic and educational questions clearly and thoroughly
- Explain complex topics in simple, understandable ways
- Always be encouraging, patient, and pedagogically effective. Format your responses with clear headings, bullet points, and code blocks where appropriate.`;

    let systemContent = STUDY_BOT_SYSTEM_INSTRUCTION;
    if (userMessage && userMessage.includes('grader')) {
      systemContent = "You are a study assessment grader. Evaluate the student's answer and return grading JSON.";
    }

    const normalized = formatHistoryForOllama(conversationHistory).slice(-6);
    const messages = [
      { role: 'system', content: systemContent },
      ...normalized
    ];

    if (userMessage) {
      messages.push({ role: 'user', content: userMessage });
    }

    const response = await fetch(LOCAL_AI_CONFIG.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: LOCAL_AI_CONFIG.modelName,
        messages: messages,
        stream: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP error! status: ${response.status}. Details: ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]') continue;

        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const chunkText = parsed.choices?.[0]?.delta?.content || '';
            if (chunkText) {
              onChunk(chunkText);
            }
          } catch (e) {
            console.error('Error parsing stream chunk:', e, trimmed);
          }
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed !== 'data: [DONE]' && trimmed.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          const chunkText = parsed.choices?.[0]?.delta?.content || '';
          if (chunkText) {
            onChunk(chunkText);
          }
        } catch (e) {
          console.error('Error parsing stream chunk (end):', e, trimmed);
        }
      }
    }

    onDone([]);
  } catch (err) {
    onError(err);
  }
}

/**
 * Returns structured JSON quiz questions from a local endpoint using response_format JSON mode.
 */
async function geminiStructuredChat(userMessage, numQuestions = 10) {
  const systemInstruction = `You are an expert study assessment generator. Your task is to generate exactly ${numQuestions} questions for the topic: "${userMessage}" in a strict JSON object matching our structural layout.
  
  JSON Layout Format:
  {
    "questions": [
      {
        "id": 1,
        "difficulty": "easy" | "medium" | "hard",
        "type": "mcq" | "quiz" | "qa",
        "question_text": "Question content or statement?",
        "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
        "correct_answer": "Option 1",
        "explanation": "Brief context explanation."
      }
    ]
  }

  Rules to enforce:
  1. For "mcq" or "quiz" types, "options" must contain exactly 4 strings. For "qa" types, "options" must be an empty array [].
  2. For "quiz" types, "question_text" must include exactly one '_____' blank placeholder (five underscores).
  3. "correct_answer" must hold the literal string value of the correct choice, fill-word, or reference model answer.
  4. Ensure a mix of difficulties ("easy", "medium", "hard") matching the request context.`;

  const response = await fetch(LOCAL_AI_CONFIG.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: LOCAL_AI_CONFIG.modelName,
      messages: [
        { role: "system", content: systemInstruction }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
      stream: false
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`HTTP error! status: ${response.status}. Details: ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '{}';

  try {
    return JSON.parse(content);
  } catch (parseError) {
    console.error("[Local AI Engine] JSON parsing failed, structural anomalies detected:", parseError, content);
    return {
      questions: [{
        id: 1,
        difficulty: "easy",
        type: "mcq",
        question_text: "Confirm engine initialization to access your workspace session.",
        options: ["Initialize Space", "Cancel"],
        correct_answer: "Initialize Space"
      }]
    };
  }
}

function setGroundingEnabled(value) {
  // Empty fallback to prevent app.js from breaking
}

function setToolEnabled(toolId, value) {
  // Empty fallback to prevent app.js from breaking
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
