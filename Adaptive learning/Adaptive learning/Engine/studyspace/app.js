/**
 * app.js — Study Space Application Logic
 * State management, UI interactions, chat orchestration
 * v2 — Doubt Bot, Assessment Modal, Interactive MCQ/QUIZ/QA engine
 */

import { geminiChat, geminiChatStream, geminiStructuredChat, renderMarkdown, setGroundingEnabled, setToolEnabled } from './gemini.js';
import { calculateCurrentRetention, adjustDecayConstant, finalizeSessionMetrics, normalizeTopic, normalizeSubject } from '../utils.js';
import { collection, addDoc } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import { db, IS_CONFIGURED, timestamp } from '../firebase-config.js';

// ─── App State ───────────────────────────────────────────────
const state = {
  sessions: [],             // Saved sessions history list
  currentSessionId: null,   // Active session UUID
  conversationHistory: [],
  messages: [],
  notes: [],
  doubtHistory: [],         // Isolated doubt bot conversation history
  assessmentResults: [],    // Per-question result log: {qi, difficulty, type, correct}
  currentQuizQuestions: [], // Active quiz questions parsed via plain-text string delimiter matrix
  sources: [
    { id: 'webSearch', name: 'Web Search', enabled: true, icon: '🌐', meta: 'Google Grounding Active' },
    { id: 'wikipedia', name: 'Wikipedia', enabled: true, icon: '📘', meta: 'Encyclopedic knowledge' },
    { id: 'academicPapers', name: 'Academic Papers', enabled: true, icon: '🔬', meta: 'Research & studies' },
  ],
  isStreaming: false,
  isDoubtStreaming: false,
  sidebarOpen: true,
  notesOpen: true,
  sessionName: 'New Study Session',
  groundingEnabled: true,   // ← Google Search Grounding toggle state
  q_pre: null,
  q_post: null,
  isPreRevisionRequired: false,
  preRevisionCompleted: false,
  postRevisionActive: false,
  postRevisionCompleted: false,
  coldStartK: null,             // 0.0500 when k URL param is null (cold-start topic); null otherwise
};

let studyBotKey = '';
let doubtBotKey = '';
let activeTopic = '';
let conversationHistoryArray = [];
let isWebGroundingActive = true;

// ─── DOM References ────────────────────────────────────────────
const $ = id => document.getElementById(id);

const DOM = {
  appShell: $('app-shell'),
  chatMessages: $('chat-messages'),
  chatWelcome: $('chat-welcome'),
  chatTextarea: $('chat-textarea'),
  sendBtn: $('send-btn'),
  sidebar: $('sidebar'),
  notesPanel: $('notes-panel'),
  sidebarToggleBtn: $('sidebar-toggle-btn'),
  notesPanelToggleBtn: $('notes-panel-toggle-btn'),
  sourceList: $('source-list'),
  knowledgeSourcesContainer: $('knowledge-sources-container'),
  notesList: $('notes-list'),
  noteTextarea: $('note-textarea'),
  addNoteBtn: $('add-note-btn'),
  sessionNameEl: $('session-name'),
  clearChatBtn: $('clear-chat-btn'),
  newSessionBtn: $('new-session-btn'),
  toastContainer: $('toast-container'),
  testGenerateBtn: $('test-generate-btn'),
  // Doubt Bot
  doubtMessages: $('doubt-messages'),
  doubtTextarea: $('doubt-textarea'),
  doubtSendBtn: $('doubt-send-btn'),
  clearDoubtBtn: $('clear-doubt-btn'),
  // Assessment Modal
  assessmentModal: $('assessment-modal'),
  assessmentBody: $('assessment-body'),
  assessmentCloseBtn: $('assessment-close-btn'),
  assessmentRetryBtn: $('assessment-retry-btn'),
  assessmentModalTitle: $('assessment-modal-title'),
  assessmentModalSubtitle: $('assessment-modal-subtitle'),
  assessmentTypeTag: $('assessment-type-tag'),
  assessmentProgress: $('assessment-progress'),
  assessmentMetaOutput: $('assessment-meta-output'),
  exitDashboardBtn: $('exit-dashboard-btn'),
};

// ─── Init ──────────────────────────────────────────────────────
function init() {
  state.conversationHistory = [];
  state.messages = [];
  conversationHistoryArray = [];

  const chatContainer = document.getElementById('chat-container');
  if (chatContainer) chatContainer.innerHTML = '';
  const chatMessagesEl = document.getElementById('chat-messages');
  if (chatMessagesEl) chatMessagesEl.innerHTML = '';

  const params = new URLSearchParams(window.location.search);
  const rawTopicParam = params.get('topic') || "New Study Session";
  activeTopic = normalizeTopic(rawTopicParam);
  studyBotKey = `neurolog_study_bot_${activeTopic}`;
  doubtBotKey = `neurolog_doubt_bot_${activeTopic}`;

  state.sessionName = rawTopicParam;
  localStorage.setItem("current_active_topic", state.sessionName);
  const subject = params.get('subject');
  const reviewDeadlineStr = params.get('reviewDeadline');

  // Clear previous states on switch to avoid data bleeding
  state.notes = [];
  state.q_pre = null;
  state.q_post = null;
  state.isPreRevisionRequired = false;
  state.preRevisionCompleted = false;
  state.postRevisionActive = false;
  state.postRevisionCompleted = false;

  // Look for neurolog chat cache first
  const cachedThread = localStorage.getItem(`neurolog_chat_cache_${activeTopic}`);
  if (cachedThread) {
    try {
      conversationHistoryArray = JSON.parse(cachedThread);
      state.conversationHistory = JSON.parse(JSON.stringify(conversationHistoryArray));
      state.messages = state.conversationHistory.map(m => ({
        role: m.role === 'user' ? 'user' : 'ai',
        text: m.parts?.[0]?.text || m.content || ''
      }));
    } catch (e) {
      console.error('Error parsing cached thread in app.js:', e);
      conversationHistoryArray = [];
      state.conversationHistory = [];
      state.messages = [];
    }
  } else {
    state.messages = [];
    state.conversationHistory = [];
    conversationHistoryArray = [];
  }

  const savedDoubt = localStorage.getItem(doubtBotKey);
  if (savedDoubt) {
    try {
      state.doubtHistory = JSON.parse(savedDoubt);
    } catch (e) {
      console.error('Error loading doubtBot history:', e);
      state.doubtHistory = [];
    }
  } else {
    state.doubtHistory = [];
  }

  // Load notes
  const sanitizedTopic = activeTopic.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() || 'default';
  const notesKey = `studyspace_notes_${sanitizedTopic}`;
  const savedNotes = localStorage.getItem(notesKey);
  if (savedNotes) {
    try {
      state.notes = JSON.parse(savedNotes);
    } catch (e) {
      console.error('Error loading notes:', e);
      state.notes = [];
    }
  } else {
    state.notes = [];
  }

  // ── Core Gatekeeper Scheduling Check ────────────────────────────
  // Evaluate Date.now() against the card's reviewDeadline (reviewDeadlineStr).
  // If reviewDeadline is empty/missing, it is treated as a before-deadline (optional) gate.
  let isOverdue = false;
  if (reviewDeadlineStr && reviewDeadlineStr !== 'null' && reviewDeadlineStr !== '') {
    const deadline = new Date(reviewDeadlineStr);
    isOverdue = !isNaN(deadline.getTime()) && Date.now() >= deadline.getTime();
  }

  const COLD_START_K = 0.0500;
  const rawRevCount = params.get('revisionCount') || params.get('revisions');
  const rawK = params.get('k');
  const rawR0 = params.get('R0');
  
  const isColdStart = (
    rawRevCount === '0' ||
    rawRevCount === '--' ||
    rawK === '--' ||
    rawR0 === '--' ||
    rawK === null ||
    rawK === 'null' ||
    rawK === '' ||
    isNaN(parseFloat(rawK))
  );
  
  state.coldStartK = isColdStart ? COLD_START_K : null;

  if (isColdStart) {
    isOverdue = true;
  }

  if (isOverdue) {
    // Mandatory Gate: Instantly block room views, show 6-question Pre-Revision Exam, strip skip options
    state.isPreRevisionRequired = true;
    startPreRevisionExam(true);
  } else {
    // Optional Gate: Display gateway prompt offering Skip to Study Room bypass
    state.isPreRevisionRequired = false;
    showPreRevisionGatewayPrompt();
    DOM.chatTextarea?.focus();
  }

  if (!state.currentSessionId) {
    state.currentSessionId = 'session_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  // Dynamically Update the Workspace Header
  if (DOM.sessionNameEl) {
    DOM.sessionNameEl.textContent = state.sessionName;
    if (subject) {
      let subjectEl = document.getElementById('session-subject');
      if (!subjectEl) {
        subjectEl = document.createElement('span');
        subjectEl.id = 'session-subject';
        subjectEl.style.cssText = 'font-size: 0.85rem; color: var(--text-muted, #9ca3af); margin-left: 8px; font-weight: 400; opacity: 0.8;';
        DOM.sessionNameEl.after(subjectEl);
      }
      subjectEl.textContent = `- ${subject}`;
    }
  }

  // Push tool settings to gemini.js based on loaded source toggles state
  state.sources.forEach(s => {
    setToolEnabled(s.id, s.enabled);
  });
  isWebGroundingActive = state.groundingEnabled;
  setGroundingEnabled(isWebGroundingActive);

  bindEvents();
  autoResizeTextarea(DOM.chatTextarea);
  autoResizeTextarea(DOM.doubtTextarea);
  renderNotes();
  renderSources();
  renderChat();
  renderDoubtHistory();

  syncGroundingUI();
  initStickyScroll();
}

// ─── Quiz Tokenizer and Parser ────────────────────────────────
function parseQuizResponse(input, userMessage) {
  if (input && typeof input === 'object') {
    if (Array.isArray(input.questions)) {
      state.currentQuizQuestions = input.questions;
      return;
    }
    if (Array.isArray(input)) {
      state.currentQuizQuestions = input;
      return;
    }
  }

  const rawAiString = String(input || '');
  const startIndex = rawAiString.indexOf("START_QUIZ");
  const cleanedOutput = startIndex !== -1 ? rawAiString.substring(startIndex) : rawAiString;
  const questionBlocks = cleanedOutput.split("END_QUESTION").filter(block => block.includes("[Q]"));
  
  const parsedQuestions = questionBlocks.map((block, index) => {
      const getTagContent = (tag) => {
          const startIdx = block.indexOf(tag);
          if (startIdx === -1) return "";
          const endIdx = block.indexOf("\n", startIdx);
          return block.substring(startIdx + tag.length, endIdx !== -1 ? endIdx : block.length).trim();
      };

      const questionText = getTagContent("[Q]");
      const optA = getTagContent("[A]");
      const optB = getTagContent("[B]");
      const optC = getTagContent("[C]");
      const optD = getTagContent("[D]");
      const rawAns = getTagContent("[ANS]").toUpperCase();

      // Resolve literal option string matching to support existing grading algorithms
      let correctOptionText = optA;
      if (rawAns === "B") correctOptionText = optB;
      if (rawAns === "C") correctOptionText = optC;
      if (rawAns === "D") correctOptionText = optD;

      return {
          id: index + 1,
          difficulty: "easy",
          type: "mcq",
          question_text: questionText || "Verify concept baseline parameter.",
          options: [optA || "True", optB || "False", optC || "N/A", optD || "N/A"],
          correct_answer: correctOptionText || optA
      };
  });

  if (parsedQuestions.length === 0) {
      state.currentQuizQuestions = [{
          id: 1, difficulty: "easy", type: "mcq",
          question_text: "Confirm engine initialization to access your workspace session.",
          options: ["Initialize Space", "Cancel"],
          correct_answer: "Initialize Space"
      }];
  } else {
      state.currentQuizQuestions = parsedQuestions;
  }
}

// ─── Events ───────────────────────────────────────────────────
function bindEvents() {
  // Suggestion chips
  document.querySelectorAll('.suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      DOM.chatTextarea.value = chip.dataset.query;
      autoResizeTextarea(DOM.chatTextarea);
      DOM.chatTextarea.focus();
    });
  });

  // Send message
  DOM.sendBtn?.addEventListener('click', handleSend);
  DOM.chatTextarea?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  DOM.chatTextarea?.addEventListener('input', () => autoResizeTextarea(DOM.chatTextarea));

  // Sidebar toggle
  DOM.sidebarToggleBtn?.addEventListener('click', () => {
    state.sidebarOpen = !state.sidebarOpen;
    DOM.sidebar?.classList.toggle('collapsed', !state.sidebarOpen);
  });

  // Notes panel toggle
  DOM.notesPanelToggleBtn?.addEventListener('click', () => {
    state.notesOpen = !state.notesOpen;
    DOM.notesPanel?.classList.toggle('collapsed', !state.notesOpen);
  });

  // Add note
  DOM.addNoteBtn?.addEventListener('click', addNote);
  DOM.noteTextarea?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) addNote();
  });

  // Clear chat
  DOM.clearChatBtn?.addEventListener('click', clearChat);
  DOM.clearDoubtBtn?.addEventListener('click', clearDoubtChat);

  // Grounding toggle
  document.addEventListener('click', e => {
    const btn = e.target.closest('#web-grounding-btn') || e.target.closest('#grounding-toggle-btn');
    if (!btn) return;
    isWebGroundingActive = !isWebGroundingActive;
    state.groundingEnabled = isWebGroundingActive;
    setGroundingEnabled(isWebGroundingActive);

    // Sync "Web Search" under KNOWLEDGE SOURCES
    const webSearchSource = state.sources.find(s => s.id === 'webSearch');
    if (webSearchSource) {
      webSearchSource.enabled = isWebGroundingActive;
      renderSources();
    }

    syncGroundingUI();
    showToast(
      isWebGroundingActive
        ? '🌐 Web Grounding enabled — answers will be web-verified'
        : '🔕 Web Grounding disabled — using model knowledge only',
      'success'
    );
  });

  // Toggle knowledge sources
  DOM.sourceList?.addEventListener('click', e => {
    const itemEl = e.target.closest('.source-item');
    if (!itemEl) return;
    const index = Array.from(DOM.sourceList.children).indexOf(itemEl);
    if (index === -1) return;

    const source = state.sources[index];
    source.enabled = !source.enabled;

    if (source.id === 'webSearch') {
      state.groundingEnabled = source.enabled;
      setGroundingEnabled(state.groundingEnabled);
      syncGroundingUI();
    } else {
      setToolEnabled(source.id, source.enabled);
    }

    renderSources();
    showToast(`${source.name} ${source.enabled ? 'enabled' : 'disabled'}`, 'success');
  });

  // New session
  DOM.newSessionBtn?.addEventListener('click', () => {
    saveCurrentSession();
    state.currentSessionId = 'session_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    state.sessionName = 'New Study Session';
    activeTopic = state.sessionName.toLowerCase().trim();
    studyBotKey = `neurolog_study_bot_${activeTopic}`;
    doubtBotKey = `neurolog_doubt_bot_${activeTopic}`;
    state.conversationHistory = [];
    state.messages = [];
    conversationHistoryArray = [];
    state.notes = [];
    state.doubtHistory = [];

    // Update URL topic parameter and remove specific topic stats for a clean new session
    const url = new URL(window.location.href);
    url.searchParams.set('topic', 'New Study Session');
    url.searchParams.delete('subject');
    url.searchParams.delete('reviewDeadline');
    url.searchParams.delete('lastPerformance');
    url.searchParams.delete('k');
    url.searchParams.delete('R0');
    url.searchParams.delete('revisionCount');
    url.searchParams.delete('loggedAt');
    window.history.replaceState({}, '', url.toString());

    if (DOM.sessionNameEl) DOM.sessionNameEl.textContent = state.sessionName;
    DOM.chatMessages.innerHTML = '';
    if (DOM.chatWelcome) DOM.chatWelcome.style.display = '';
    resetDoubtPanel();

    renderNotes();
    updateNotesCount();
    showToast('✨ New session started', 'success');
  });

  // Test generation — opens Assessment Modal
  DOM.testGenerateBtn?.addEventListener('click', handleTestGenerate);

  DOM.exitDashboardBtn?.addEventListener('click', () => {
    if (state.isPreRevisionRequired) {
      // Condition A — Mandatory/Past Due: lock the view and force post-test
      startPostRevisionTest();
    } else {
      // Condition B — Optional/Before Due: show elegant exit confirm overlay
      showExitConfirmPrompt();
    }
  });

  // Assessment modal close
  DOM.assessmentCloseBtn?.addEventListener('click', closeAssessmentModal);
  
  const resetAndStartPreExam = () => {
    window.isPreTestCompleted = false;
    window.sessionRevisionFinished = false;
    state.isPreTestCompleted = false;
    state.sessionRevisionFinished = false;
    state.currentQuestionIndex = 0;
    state.questionIndex = 0;
    state.assessmentResults = [];
    startPreRevisionExam(true);
  };

  DOM.assessmentRetryBtn?.addEventListener('click', resetAndStartPreExam);
  document.getElementById('new-assessment-btn')?.addEventListener('click', resetAndStartPreExam);
  
  DOM.assessmentModal?.addEventListener('click', e => {
    if (e.target === DOM.assessmentModal) closeAssessmentModal();
  });

  // Doubt Bot send
  DOM.doubtSendBtn?.addEventListener('click', handleDoubtSend);
  DOM.doubtTextarea?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleDoubtSend();
    }
  });
  DOM.doubtTextarea?.addEventListener('input', () => autoResizeTextarea(DOM.doubtTextarea));

  // Session name editing
  document.body.addEventListener('click', e => {
    if (!e.target.matches('#session-name')) return;
    const el = e.target;
    const current = el.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'form-input';
    input.id = 'session-name-input';
    input.style.cssText = 'font-size:0.9rem;padding:4px 8px;width:200px;border-radius:6px;';
    el.replaceWith(input);
    input.focus();
    input.select();
    const done = () => {
      const newName = input.value.trim() || 'Untitled Session';
      const oldName = state.sessionName;
      state.sessionName = newName;
      const span = document.createElement('span');
      span.id = 'session-name';
      span.className = 'header-session-name';
      span.style.cursor = 'pointer';
      span.title = 'Click to rename';
      span.textContent = newName;
      input.replaceWith(span);

      if (oldName !== newName) {
        handleRename(oldName, newName);
        
        // Update URL topic parameter
        const url = new URL(window.location.href);
        url.searchParams.set('topic', newName);
        window.history.replaceState({}, '', url.toString());
      }

      saveCurrentSession();
    };
    input.addEventListener('blur', done);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') done(); });
  });
}

// ─── Sticky Scroll System ─────────────────────────────────────
const stickyScroll = {
  userScrolledUp: false,
  _isUserAction: false,
};

const SCROLL_BOTTOM_THRESHOLD = 64;

function isAtScrollBottom() {
  const el = DOM.chatMessages;
  if (!el) return true;
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= SCROLL_BOTTOM_THRESHOLD;
}

function initStickyScroll() {
  const el = DOM.chatMessages;
  if (!el) return;

  const markUserAction = () => { stickyScroll._isUserAction = true; };

  el.addEventListener('wheel',      markUserAction, { passive: true });
  el.addEventListener('touchstart', markUserAction, { passive: true });
  el.addEventListener('touchmove',  markUserAction, { passive: true });
  el.addEventListener('keydown', (e) => {
    const navKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
    if (navKeys.includes(e.key)) markUserAction();
  }, { passive: true });

  el.addEventListener('scroll', () => {
    if (stickyScroll._isUserAction) {
      stickyScroll._isUserAction = false;
      if (isAtScrollBottom()) {
        stickyScroll.userScrolledUp = false;
      } else {
        stickyScroll.userScrolledUp = true;
      }
    } else {
      if (isAtScrollBottom()) {
        stickyScroll.userScrolledUp = false;
      }
    }
  }, { passive: true });
}

// ─── Main Chat ────────────────────────────────────────────────
async function handleSend() {
  const text = DOM.chatTextarea?.value?.trim();
  if (!text || state.isStreaming) return;

  if (DOM.chatWelcome) DOM.chatWelcome.style.display = 'none';

  DOM.chatTextarea.value = '';
  autoResizeTextarea(DOM.chatTextarea);

  appendMessage('user', text);
  state.conversationHistory.push({ role: 'user', parts: [{ text }] });
  state.messages.push({ role: 'user', text: text });
  saveCurrentSession();
  localStorage.setItem(studyBotKey, JSON.stringify(state.messages));

  conversationHistoryArray = JSON.parse(JSON.stringify(state.conversationHistory));
  localStorage.setItem(`neurolog_chat_cache_${activeTopic}`, JSON.stringify(conversationHistoryArray));

  const typingEl = showTyping();
  state.isStreaming = true;
  DOM.sendBtn.disabled = true;
  stickyScroll.userScrolledUp = false;

  let fullText = '';
  let aiMsgEl = null;
  let bubbleEl = null;

  try {
    await geminiChatStream(
      state.conversationHistory.slice(0, -1),
      text,

      (chunk) => {
        fullText += chunk;
        if (!aiMsgEl) {
          typingEl?.remove();
          const { msgEl, bubble } = appendMessage('ai', '', true);
          aiMsgEl = msgEl;
          bubbleEl = bubble;
        }
        if (bubbleEl) {
          bubbleEl.innerHTML = renderMarkdown(fullText) + '<span class="streaming-cursor"></span>';
          scrollToBottom();
        }
      },

      (citations) => {
        state.isStreaming = false;
        DOM.sendBtn.disabled = false;
        typingEl?.remove();

        if (!aiMsgEl) {
          const { msgEl, bubble } = appendMessage('ai', fullText);
          aiMsgEl = msgEl;
          bubbleEl = bubble;
        }

        if (bubbleEl) {
          bubbleEl.innerHTML = renderMarkdown(fullText);
        }

        if (citations.length > 0 && aiMsgEl) {
          const citBox = buildCitationsBox(citations);
          aiMsgEl.querySelector('.msg-content')?.appendChild(citBox);
        }

        if (aiMsgEl) {
          const actionsEl = buildMessageActions(fullText);
          aiMsgEl.querySelector('.msg-content')?.appendChild(actionsEl);
        }

        state.conversationHistory.push({ role: 'model', parts: [{ text: fullText }] });
        state.messages.push({ role: 'ai', text: fullText });
        saveCurrentSession();
        localStorage.setItem(studyBotKey, JSON.stringify(state.messages));

        // Backup the full current conversation array into browser memory using neurolog_chat_cache_${activeTopic}
        conversationHistoryArray = JSON.parse(JSON.stringify(state.conversationHistory));
        localStorage.setItem(`neurolog_chat_cache_${activeTopic}`, JSON.stringify(conversationHistoryArray));
        scrollToBottom();
      },

      (err) => {
        state.isStreaming = false;
        DOM.sendBtn.disabled = false;
        typingEl?.remove();

        const msg = err.message || '';

        const isExhausted = msg.startsWith('✨ StudySpace');
        if (isExhausted) {
          appendMessage('ai', msg);
          return;
        }

        console.error('[StudySpace] Unrecoverable error:', err);

        let errMsg;
        if (err.isTimeout) {
          errMsg = '⏱️ The request timed out. Please check your connection and try again.';
        } else if (msg.includes('API_KEY') || msg.includes('API key')) {
          errMsg = '⚠️ The API key appears to be invalid. Please verify it and try again.';
        } else if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch')) {
          errMsg = '⚠️ Network error. Please check your internet connection and try again.';
        } else if (msg.includes('google_search') || msg.includes('googleSearch') || msg.includes('tools') || msg.includes('payload')) {
          errMsg = '⚠️ StudySpace encountered a configuration mismatch. Attempting recovery... Please re-send your message.';
        } else {
          errMsg = `⚠️ Something went wrong. Please try again in a moment.`;
        }

        appendMessage('ai', errMsg);
      }
    );
  } catch (err) {
    state.isStreaming = false;
    DOM.sendBtn.disabled = false;
    typingEl?.remove();
    console.error('[StudySpace] Unexpected JS error:', err);
    appendMessage('ai', '⚠️ An unexpected error occurred. Please try again.');
  }
}

// ─── Doubt Clarification Bot ──────────────────────────────────
function renderDoubtHistory() {
  if (!DOM.doubtMessages) return;
  DOM.doubtMessages.innerHTML = '';
  if (state.doubtHistory.length === 0) {
    resetDoubtPanel();
  } else {
    state.doubtHistory.forEach(msg => {
      const role = msg.role === 'user' ? 'user' : 'bot';
      const text = msg.parts[0]?.text || '';
      appendDoubtMessage(role, text);
    });
  }
}

function resetDoubtPanel() {
  state.doubtHistory = [];
  if (DOM.doubtMessages) {
    DOM.doubtMessages.innerHTML = `
      <div class="doubt-empty-state">
        <div class="doubt-empty-icon">💡</div>
        <div class="doubt-empty-text">Any doubt about the topic? Ask here — I'll answer instantly without cluttering your main study feed.</div>
      </div>`;
  }
}

function clearDoubtChat() {
  if (confirm('Clear all doubt history for this topic?')) {
    state.doubtHistory = [];
    localStorage.removeItem(doubtBotKey);
    resetDoubtPanel();
    if (typeof showToast === 'function') {
      showToast('🧹 Doubt history cleared', 'success');
    }
  }
}

function appendDoubtMessage(role, text) {
  // Remove empty state on first message
  const emptyState = DOM.doubtMessages?.querySelector('.doubt-empty-state');
  if (emptyState) emptyState.remove();

  const el = document.createElement('div');
  el.className = role === 'user' ? 'doubt-msg doubt-msg-user' : 'doubt-msg doubt-msg-bot';

  if (role === 'bot') {
    el.innerHTML = renderMarkdown(text);
  } else {
    el.textContent = text;
  }

  DOM.doubtMessages?.appendChild(el);
  DOM.doubtMessages.scrollTop = DOM.doubtMessages.scrollHeight;
  return el;
}

async function handleDoubtSend() {
  const text = DOM.doubtTextarea?.value?.trim();
  if (!text || state.isDoubtStreaming) return;

  DOM.doubtTextarea.value = '';
  autoResizeTextarea(DOM.doubtTextarea);

  appendDoubtMessage('user', text);

  // Build isolated doubt history push
  state.doubtHistory.push({ role: 'user', parts: [{ text }] });
  localStorage.setItem(doubtBotKey, JSON.stringify(state.doubtHistory));

  // Show inline typing in doubt panel
  const emptyState = DOM.doubtMessages?.querySelector('.doubt-empty-state');
  if (emptyState) emptyState.remove();

  const typingEl = document.createElement('div');
  typingEl.className = 'doubt-msg doubt-msg-bot doubt-typing';
  typingEl.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  DOM.doubtMessages?.appendChild(typingEl);
  DOM.doubtMessages.scrollTop = DOM.doubtMessages.scrollHeight;

  state.isDoubtStreaming = true;
  if (DOM.doubtSendBtn) DOM.doubtSendBtn.disabled = true;

  // System instruction binds to current session topic + conversation context
  const topicContext = state.sessionName;
  const recentMainContext = state.conversationHistory
    .slice(-6)
    .filter(m => m.role === 'model' || m.role === 'user')
    .map(m => `${m.role === 'user' ? 'Student' : 'StudyBot'}: ${m.parts[0]?.text?.slice(0, 300) || ''}`)
    .join('\n');

  const doubtSystemPrompt = `You are a concise doubt-clarification assistant embedded in Study Space.
Current learning topic: "${topicContext}".
${recentMainContext ? `Recent study context:\n${recentMainContext}` : ''}

Rules:
- Answer ONLY the student's specific doubt in 2-4 sentences max.
- Do NOT generate lengthy explanations unless specifically asked.
- Stay strictly within the current topic context.
- Never recommend the student to "check the main chat" — you ARE the answer.`;

  let fullReply = '';
  let botMsgEl = null;

  try {
    await geminiChatStream(
      state.doubtHistory.slice(0, -1),
      `[DOUBT QUERY — answer concisely under topic: "${topicContext}"]\n${text}\n\n[System: ${doubtSystemPrompt}]`,

      (chunk) => {
        fullReply += chunk;
        if (!botMsgEl) {
          typingEl.remove();
          botMsgEl = appendDoubtMessage('bot', fullReply);
        } else {
          botMsgEl.innerHTML = renderMarkdown(fullReply);
          DOM.doubtMessages.scrollTop = DOM.doubtMessages.scrollHeight;
        }
      },

      () => {
        state.isDoubtStreaming = false;
        if (DOM.doubtSendBtn) DOM.doubtSendBtn.disabled = false;
        if (!botMsgEl) {
          typingEl.remove();
          appendDoubtMessage('bot', fullReply || '(No response)');
        } else {
          botMsgEl.innerHTML = renderMarkdown(fullReply);
        }
        state.doubtHistory.push({ role: 'model', parts: [{ text: fullReply }] });
        localStorage.setItem(doubtBotKey, JSON.stringify(state.doubtHistory));
        DOM.doubtMessages.scrollTop = DOM.doubtMessages.scrollHeight;
      },

      (err) => {
        state.isDoubtStreaming = false;
        if (DOM.doubtSendBtn) DOM.doubtSendBtn.disabled = false;
        typingEl.remove();
        appendDoubtMessage('bot', '⚠️ Could not process your doubt. Please try again.');
        console.error('[StudySpace Doubt Bot] Error:', err);
      }
    );
  } catch (err) {
    state.isDoubtStreaming = false;
    if (DOM.doubtSendBtn) DOM.doubtSendBtn.disabled = false;
    typingEl.remove();
    appendDoubtMessage('bot', '⚠️ An unexpected error occurred.');
    console.error('[StudySpace Doubt Bot] Unexpected error:', err);
  }
}

// ─── Assessment Modal Engine — 4-3-3 Adaptive Difficulty ─────
/**
 * Difficulty split (enforced by geminiStructuredChat schema):
 *   IDs 1-4  → easy   — only mcq / quiz
 *   IDs 5-7  → medium — mcq, quiz, or qa (mixed)
 *   IDs 8-10 → hard   — mcq, quiz, or qa (mixed)
 *
 * Per-question result record: { qi, id, difficulty, type, correct }
 * Engine metadata tag format: [Q1: easy-mcq, Correct] [Q6: medium-qa, Incorrect] ...
 */

function openAssessmentModal() {
  if (!DOM.assessmentModal) return;
  DOM.assessmentModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeAssessmentModal() {
  if (state.isPreRevisionRequired && !state.preRevisionCompleted) {
    showToast('⚠️ You must complete the Pre-Revision Exam to unlock StudySpace.', 'error');
    return;
  }
  if (state.postRevisionActive && !state.postRevisionCompleted) {
    showToast('⚠️ You must complete the Post-Revision Test to conclude your session.', 'error');
    return;
  }
  if (!DOM.assessmentModal) return;
  DOM.assessmentModal.classList.add('hidden');
  document.body.style.overflow = '';
}

async function handleTestGenerate() {
  if (state.isStreaming) return;

  const btn = DOM.testGenerateBtn;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('generating');
    const labelEl = btn.querySelector('.test-btn-label');
    if (labelEl) labelEl.textContent = 'Generating…';
  }

  state.assessmentResults = [];

  if (DOM.assessmentBody) {
    DOM.assessmentBody.innerHTML = `
      <div class="assessment-loading">
        <div class="assessment-loading-dots">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
        <span>Building adaptive 10-question assessment…</span>
        <div class="assessment-loading-meta">4 Easy · 3 Medium · 3 Hard</div>
      </div>`;
  }
  if (DOM.assessmentModalTitle)    DOM.assessmentModalTitle.textContent    = 'Adaptive Study Assessment';
  if (DOM.assessmentModalSubtitle) DOM.assessmentModalSubtitle.textContent = '10 questions · Mixed difficulty & format';
  if (DOM.assessmentTypeTag)       DOM.assessmentTypeTag.textContent       = '';

  openAssessmentModal();

  // ── Build context string ──
  let contextText = `Study topic: ${state.sessionName}.`;
  if (state.notes.length > 0) {
    contextText += `\nStudent notes:\n${state.notes.map(n => `- ${n.text}`).join('\n')}`;
  }
  const chatContext = state.conversationHistory
    .filter(m => m.role === 'model' || m.role === 'user')
    .slice(-10)
    .map(m => `${m.role === 'user' ? 'Student' : 'StudyBot'}: ${m.parts[0]?.text?.slice(0, 400) || ''}`)
    .join('\n');
  if (chatContext) contextText += `\n\nRecent study conversation:\n${chatContext}`;

  // ── Concise prompt — schema is enforced by geminiStructuredChat, not by prompt verbosity ──
  const prompt = `Generate a 10-question adaptive study assessment based on the following context.
${contextText}

Difficulty and type requirements:
- Questions 1-4: difficulty=easy, type=mcq or quiz only (literal recall)
- Questions 5-7: difficulty=medium, use a mix of mcq, quiz, and qa types (application/analytical)
- Questions 8-10: difficulty=hard, use a mix of mcq, quiz, and qa types (deep understanding)

For mcq/quiz: provide 4 options. For qa: empty options array.
For quiz: question_text must include a _____ blank.
correct_answer = full option text (mcq), fill word (quiz), or complete model answer (qa).`;

  try {
    const rawAiString = await geminiStructuredChat(prompt);
    parseQuizResponse(rawAiString, state.sessionName);
  } catch (err) {
    console.warn('[StudySpace] Assessment generation error (using silent fallback):', err);
    state.currentQuizQuestions = [{
        id: 1, difficulty: "easy", type: "mcq",
        question_text: "Confirm engine initialization to access your workspace session.",
        options: ["Initialize Space", "Cancel"],
        correct_answer: "Initialize Space"
    }];
  }

  renderMixedAssessment(state.currentQuizQuestions);

  if (btn) {
    btn.disabled = false;
    btn.classList.remove('generating');
    const labelEl = btn.querySelector('.test-btn-label');
    if (labelEl) labelEl.textContent = 'Generate Assessment';
  }
}

// ─── Adaptive Assessment Renderer (Mixed 4-3-3) ───────────────
/**
 * Schema field mapping (geminiStructuredChat canonical fields):
 *   q.id            → question number for metadata tags
 *   q.difficulty    → 'easy' | 'medium' | 'hard' (lowercase)
 *   q.type          → 'mcq' | 'quiz' | 'qa'   (lowercase)
 *   q.question_text → displayed question / QUIZ statement
 *   q.options       → string[4] for mcq/quiz, [] for qa
 *   q.correct_answer→ full text of correct option (mcq), fill word (quiz), model answer (qa)
 *   q.explanation   → shown in feedback block
 */
function renderMixedAssessment(questions) {
  if (!DOM.assessmentBody || !questions?.length) return;

  if (DOM.assessmentModalTitle)    DOM.assessmentModalTitle.textContent    = 'Adaptive Assessment';
  if (DOM.assessmentModalSubtitle) DOM.assessmentModalSubtitle.textContent = `${questions.length} questions · 4 Easy · 3 Medium · 3 Hard`;
  if (DOM.assessmentTypeTag) {
    DOM.assessmentTypeTag.className = 'assessment-type-tag';
    DOM.assessmentTypeTag.textContent = '🧩 Mixed Format';
  }

  const optionLetters = ['A', 'B', 'C', 'D'];

  // Normalise difficulty/type casing defensively
  const norm   = s => (s || '').toLowerCase();
  const capStr = s => s.charAt(0).toUpperCase() + s.slice(1);

  const difficultyColors = { easy: '#81c995', medium: '#f8b84e', hard: '#f28b82' };
  const difficultyIcons  = { easy: '🟢', medium: '🟡', hard: '🔴' };
  const typeLabels       = { mcq: 'Multiple Choice', quiz: 'Fill in the Blank', qa: 'Written Q&A' };

  let html = `<div class="assessment-progress-bar-wrap">
    <div class="assessment-progress-label">Progress: <span id="assessment-answered-count">0</span> / ${questions.length}</div>
    <div class="assessment-progress-track"><div class="assessment-progress-fill" id="assessment-progress-fill" style="width:0%"></div></div>
  </div>`;

  questions.forEach((q, idx) => {
    const difficulty = norm(q.difficulty);
    const type       = norm(q.type);
    const qId        = q.id ?? (idx + 1); // use schema id; fall back to 1-based index
    const diffColor  = difficultyColors[difficulty] || '#8ab4f8';
    const diffIcon   = difficultyIcons[difficulty]  || '⚪';
    const typeLabel  = typeLabels[type] || type;

    // Store question id on the block for metadata tag extraction
    html += `<div class="mixed-question-block" id="mixed-block-${idx}"
      data-qi="${idx}"
      data-q-id="${qId}"
      data-difficulty="${escapeHtmlAttr(difficulty)}"
      data-type="${escapeHtmlAttr(type)}"
      data-correct-answer="${escapeHtmlAttr(q.correct_answer || '')}"
      data-explanation="${escapeHtmlAttr(q.explanation || '')}"
      data-ideal="${escapeHtmlAttr(q.correct_answer || '')}" 
    >
      <div class="mixed-q-header">
        <div class="mixed-q-num-row">
          <span class="mixed-q-num">Q${qId}</span>
          <span class="mixed-q-difficulty-badge" style="color:${diffColor};border-color:${diffColor}20;background:${diffColor}12">${diffIcon} ${capStr(difficulty)}</span>
          <span class="mixed-q-type-badge">${typeLabel}</span>
        </div>
      </div>`;

    if (type === 'mcq') {
      const opts = q.options || [];
      html += `<div class="mcq-question-text">${escapeHtml(q.question_text)}</div>
        <div class="mcq-options" role="radiogroup">`;
      opts.forEach((opt, oi) => {
        html += `<button class="mcq-option" data-qi="${idx}" data-oi="${oi}" role="radio" aria-checked="false" aria-label="Option ${optionLetters[oi]}: ${escapeHtmlAttr(opt)}">
          <span class="mcq-option-letter">${optionLetters[oi]}</span>
          <span class="mcq-option-text">${escapeHtml(opt)}</span>
        </button>`;
      });
      html += `</div><div class="mcq-feedback" id="mixed-feedback-${idx}" style="display:none;"></div>`;

    } else if (type === 'quiz') {
      // question_text contains the _____ blank
      const stmt = escapeHtml(q.question_text || '').replace('_____', '<span class="quiz-blank">_____</span>');
      html += `<div class="mcq-question-text">${stmt}</div>
        <input type="text" class="quiz-answer-input" id="quiz-input-${idx}" placeholder="Type your answer…" aria-label="Fill in blank" />
        <button class="btn btn-secondary btn-sm quiz-check-single-btn" id="quiz-check-${idx}" data-qi="${idx}" style="margin-top:8px;">
          ✅ Check Answer
        </button>
        <div class="quiz-item-feedback" id="mixed-feedback-${idx}" style="display:none;"></div>`;

    } else if (type === 'qa') {
      html += `<div class="mcq-question-text">${escapeHtml(q.question_text)}</div>
        <textarea class="qa-textarea" id="qa-textarea-${idx}" placeholder="Write your analytical response here…" rows="5" aria-label="Your answer"></textarea>
        <button class="btn btn-primary btn-sm" id="qa-submit-${idx}" data-qi="${idx}" style="width:100%;margin-top:10px;">
          Submit for AI Grading →
        </button>
        <div class="qa-feedback" id="mixed-feedback-${idx}" style="display:none;"></div>`;
    }

    html += `</div>`;
  });

  html += `<div class="assessment-meta-panel" id="assessment-meta-panel" style="display:none;">
    <div class="assessment-meta-header">📊 Adaptive Engine Metadata</div>
    <div class="assessment-meta-body" id="assessment-meta-body"></div>
  </div>`;

  DOM.assessmentBody.innerHTML = html;

  // ── Bind event listeners ──
  DOM.assessmentBody.querySelectorAll('.mcq-option').forEach(optBtn => {
    optBtn.addEventListener('click', () => {
      const qi = parseInt(optBtn.dataset.qi, 10);
      const oi = parseInt(optBtn.dataset.oi, 10);
      handleMixedMCQAnswer(qi, oi, questions);
    });
  });

  DOM.assessmentBody.querySelectorAll('.quiz-check-single-btn').forEach(checkBtn => {
    checkBtn.addEventListener('click', () => {
      const qi = parseInt(checkBtn.dataset.qi, 10);
      handleMixedQuizAnswer(qi, questions);
    });
  });

  DOM.assessmentBody.querySelectorAll('[id^="qa-submit-"]').forEach(subBtn => {
    subBtn.addEventListener('click', async () => {
      const qi = parseInt(subBtn.dataset.qi, 10);
      await handleMixedQASubmit(qi, questions);
    });
  });
}

// ─── Track progress & metadata ────────────────────────────────
function recordResult(qi, difficulty, type, correct, questions) {
  if (state.assessmentResults.find(r => r.qi === qi)) return;
  // Read the question's canonical id from the DOM block for clean engine tags
  const block = document.getElementById(`mixed-block-${qi}`);
  const qId   = block?.dataset?.qId ?? (qi + 1);
  state.assessmentResults.push({ qi, qId: Number(qId), difficulty, type, correct });
  updateProgressUI(questions.length);
}

function updateProgressUI(total) {
  const answered = state.assessmentResults.length;
  const countEl = document.getElementById('assessment-answered-count');
  const fillEl  = document.getElementById('assessment-progress-fill');
  if (countEl) countEl.textContent = answered;
  if (fillEl)  fillEl.style.width  = `${Math.round((answered / total) * 100)}%`;

  // Show completion screens
  if (answered >= total) {
    if (state.postRevisionActive) {
      concludePostRevisionTest(total);
    } else if (state.preRevisionActive) {
      concludePreRevisionExam(total);
    } else {
      renderMetadataPanel();
    }
  }
}

function renderMetadataPanel() {
  const panel  = document.getElementById('assessment-meta-panel');
  const bodyEl = document.getElementById('assessment-meta-body');
  if (!panel || !bodyEl) return;

  const sorted = [...state.assessmentResults].sort((a, b) => a.qId - b.qId);

  // Engine metadata tag string: [Q1: easy-mcq, Correct] [Q6: medium-qa, Incorrect] ...
  const tagString = sorted.map(r =>
    `[Q${r.qId}: ${r.difficulty}-${r.type}, ${r.correct ? 'Correct' : 'Incorrect'}]`
  ).join(' ');

  const correctCount = sorted.filter(r => r.correct).length;
  const total = sorted.length;
  const pct   = Math.round((correctCount / total) * 100);

  const byDiff = { easy: {c:0,t:0}, medium: {c:0,t:0}, hard: {c:0,t:0} };
  sorted.forEach(r => {
    const d = (r.difficulty || '').toLowerCase();
    if (!byDiff[d]) byDiff[d] = {c:0,t:0};
    byDiff[d].t++;
    if (r.correct) byDiff[d].c++;
  });

  const scoreColor = pct >= 80 ? '#81c995' : pct >= 50 ? '#f8b84e' : '#f28b82';

  bodyEl.innerHTML = `
    <div class="meta-score-row">
      <span class="meta-score-num" style="color:${scoreColor}">${correctCount}/${total}</span>
      <span class="meta-score-pct" style="color:${scoreColor}">${pct}%</span>
    </div>
    <div class="meta-breakdown">
      ${Object.entries(byDiff).filter(([,v])=>v.t>0).map(([diff,v])=>`
        <div class="meta-diff-row">
          <span class="meta-diff-label">${diff.charAt(0).toUpperCase()+diff.slice(1)}</span>
          <span class="meta-diff-score">${v.c}/${v.t}</span>
          <div class="meta-diff-bar"><div class="meta-diff-fill" style="width:${v.t>0?Math.round(v.c/v.t*100):0}%;background:${diffColors(diff)}"></div></div>
        </div>`).join('')}
    </div>
    <div class="meta-tags-label">Engine Payload (K / Ro adapter input):</div>
    <code class="meta-tags-code">${escapeHtml(tagString)}</code>
  `;

  panel.style.display = '';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function diffColors(d) {
  return d === 'Easy' ? '#81c995' : d === 'Medium' ? '#f8b84e' : '#f28b82';
}

// ─── MCQ answer handler (mixed assessment) ────────────────────
function handleMixedMCQAnswer(qi, selectedOi, questions) {
  const block = document.getElementById(`mixed-block-${qi}`);
  if (!block || block.dataset.answered === 'true') return;
  block.dataset.answered = 'true';

  const difficulty   = block.dataset.difficulty || 'easy';
  const explanation  = block.dataset.explanation || '';
  const correctText  = block.dataset.correctAnswer || '';

  // Find correct option index by matching stored correct_answer text
  const allOpts = block.querySelectorAll('.mcq-option');
  let correctOi = -1;
  allOpts.forEach((btn, oi) => {
    if (btn.querySelector('.mcq-option-text')?.textContent === correctText) correctOi = oi;
  });
  const isCorrect = selectedOi === correctOi;

  allOpts.forEach((btn, oi) => {
    btn.disabled = true;
    if (oi === selectedOi && !isCorrect) btn.classList.add('wrong');
    if (oi === correctOi)               btn.classList.add('correct');
  });

  const feedbackEl = document.getElementById(`mixed-feedback-${qi}`);
  if (feedbackEl) {
    feedbackEl.style.display = '';
    if (isCorrect) {
      feedbackEl.className = 'mcq-feedback feedback-correct';
      feedbackEl.innerHTML = `<span class="feedback-icon">✅</span> <strong>Correct!</strong>${explanation ? ' ' + escapeHtml(explanation) : ''}`;
    } else {
      feedbackEl.className = 'mcq-feedback feedback-wrong';
      feedbackEl.innerHTML = `<span class="feedback-icon">❌</span> <strong>Incorrect.</strong>${explanation ? `<div class="assessment-explanation">${renderMarkdown(explanation)}</div>` : ''}`;
    }
  }

  recordResult(qi, difficulty, 'mcq', isCorrect, questions);
}

// ─── QUIZ answer handler (mixed assessment) ───────────────────
function handleMixedQuizAnswer(qi, questions) {
  const block = document.getElementById(`mixed-block-${qi}`);
  if (!block || block.dataset.answered === 'true') return;

  const inputEl    = document.getElementById(`quiz-input-${qi}`);
  const feedbackEl = document.getElementById(`mixed-feedback-${qi}`);
  const checkBtn   = document.getElementById(`quiz-check-${qi}`);
  if (!inputEl || !feedbackEl) return;

  const userAnswer    = inputEl.value.trim().toLowerCase();
  if (!userAnswer) { showToast('⚠️ Please type an answer first.', 'error'); return; }

  const question = questions[qi];
  const explanation   = block.dataset.explanation || '';
  const difficulty    = block.dataset.difficulty || 'easy';

  const cleanUserAns = (userAnswer || '').toLowerCase().trim().replace(/['"‘“’”]/g, '');
  const cleanCorrectAns = (question.correct_answer || '').toLowerCase().trim().replace(/['"‘“’”]/g, '');
  const isCorrect = cleanUserAns === cleanCorrectAns;

  block.dataset.answered = 'true';
  inputEl.disabled = true;
  if (checkBtn) checkBtn.disabled = true;
  inputEl.classList.add(isCorrect ? 'quiz-input-correct' : 'quiz-input-wrong');

  feedbackEl.style.display = '';
  if (isCorrect) {
    feedbackEl.className = 'quiz-item-feedback feedback-correct';
    feedbackEl.innerHTML = `<span class="feedback-icon">✅</span> <strong>Correct!</strong> Answer: <em>${escapeHtml(block.dataset.correctAnswer)}</em>. ${explanation ? escapeHtml(explanation) : ''}`;
  } else {
    feedbackEl.className = 'quiz-item-feedback feedback-wrong';
    feedbackEl.innerHTML = `<span class="feedback-icon">❌</span> <strong>Incorrect.</strong> Correct: <em>${escapeHtml(block.dataset.correctAnswer)}</em>.
      ${explanation ? `<div class="assessment-explanation">${renderMarkdown(explanation)}</div>` : ''}`;
  }

  recordResult(qi, difficulty, 'quiz', isCorrect, questions);
}

// ─── QA grading handler (mixed assessment) ────────────────────
async function handleMixedQASubmit(qi, questions) {
  const block      = document.getElementById(`mixed-block-${qi}`);
  const textareaEl = document.getElementById(`qa-textarea-${qi}`);
  const feedbackEl = document.getElementById(`mixed-feedback-${qi}`);
  const submitBtn  = document.getElementById(`qa-submit-${qi}`);

  if (!block || !textareaEl || !feedbackEl || !submitBtn) return;
  if (block.dataset.answered === 'true') return;

  const studentAnswer = textareaEl.value.trim();
  if (!studentAnswer) { showToast('⚠️ Please write your answer before submitting.', 'error'); return; }

  // correct_answer field holds the model's full ideal answer for QA
  const idealAnswer  = block.dataset.ideal || '';
  const question     = block.querySelector('.mcq-question-text')?.textContent || '';
  const difficulty   = block.dataset.difficulty || 'medium';

  submitBtn.disabled   = true;
  textareaEl.disabled  = true;
  submitBtn.textContent = 'Grading…';

  feedbackEl.style.display = '';
  feedbackEl.className = 'qa-feedback';
  feedbackEl.innerHTML = `<div class="assessment-loading" style="padding:14px 0;">
    <div class="assessment-loading-dots"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>
    <span>AI is evaluating your response…</span></div>`;

  const gradingPrompt = `You are a study assessment grader. Evaluate the student's answer.

Question: ${question}
Model Answer: ${idealAnswer}
Student's Answer: ${studentAnswer}

Return ONLY a valid JSON object (no markdown fences):
{
  "score": 0-100,
  "grade": "Excellent" | "Good" | "Partial" | "Needs Improvement",
  "summary": "One sentence.",
  "strengths": "What the student got right.",
  "gaps": "What was missing or incorrect.",
  "modelAnswer": "A clear, complete reference answer."
}`;

  try {
    const { text: rawJson } = await geminiChat([], gradingPrompt);
    let cleanJson = rawJson.trim()
      .replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();

    let grading;
    try { grading = JSON.parse(cleanJson); }
    catch { const m = cleanJson.match(/\{[\s\S]*\}/); if (m) grading = JSON.parse(m[0]); else throw new Error('Grading parse error'); }

    block.dataset.answered = 'true';

    const scoreColor = grading.score >= 80 ? '#81c995' : grading.score >= 50 ? '#f8b84e' : '#f28b82';
    const gradeEmoji = grading.score >= 80 ? '🏆' : grading.score >= 50 ? '📈' : '📚';
    const isCorrect  = grading.score > 60;

    feedbackEl.className = 'qa-feedback qa-grading-result';
    feedbackEl.innerHTML = `
      <div class="qa-grade-header">
        <span class="qa-grade-emoji">${gradeEmoji}</span>
        <div class="qa-grade-score" style="color:${scoreColor}">${grading.score}/100</div>
        <div class="qa-grade-label">${escapeHtml(grading.grade || '')}</div>
      </div>
      <div class="qa-grade-summary">${escapeHtml(grading.summary || '')}</div>
      <div class="assessment-explanation">
        ${grading.strengths ? `<div class="qa-strength"><strong>✅ Strengths:</strong> ${escapeHtml(grading.strengths)}</div>` : ''}
        ${grading.gaps      ? `<div class="qa-gap"><strong>🔍 Gaps:</strong> ${escapeHtml(grading.gaps)}</div>` : ''}
        ${grading.modelAnswer ? `<div class="qa-model-answer"><strong>📖 Model Answer:</strong><br>${renderMarkdown(grading.modelAnswer)}</div>` : ''}
      </div>`;

    recordResult(qi, difficulty, 'qa', isCorrect, questions);
  } catch (err) {
    console.error('[StudySpace] QA grading error:', err);
    feedbackEl.className = 'qa-feedback qa-grading-error';
    feedbackEl.innerHTML = `<span class="feedback-icon">⚠️</span> Could not grade your response. Please try again.`;
    submitBtn.disabled   = false;
    textareaEl.disabled  = false;
    submitBtn.textContent = 'Submit for AI Grading →';
  }
}

// ─── Message Rendering ─────────────────────────────────────────
function appendMessage(role, text, streaming = false) {
  const isAI = role === 'ai';
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const msgEl = document.createElement('div');
  msgEl.className = `message ${isAI ? 'ai-message' : 'user-message'}`;

  const avatarEl = document.createElement('div');
  avatarEl.className = `msg-avatar ${isAI ? 'ai-avatar' : 'user-avatar'}`;
  avatarEl.textContent = isAI ? '✦' : 'U';

  const contentEl = document.createElement('div');
  contentEl.className = 'msg-content';

  const headerEl = document.createElement('div');
  headerEl.className = 'msg-header';
  headerEl.innerHTML = `
    <span class="msg-name">${isAI ? 'StudyBot' : 'You'}</span>
    <span class="msg-time">${now}</span>
  `;

  const bubbleEl = document.createElement('div');
  bubbleEl.className = `msg-bubble ${isAI ? 'ai-bubble' : 'user-bubble'}`;

  if (text) {
    bubbleEl.innerHTML = isAI ? renderMarkdown(text) : escapeHtml(text);
  }

  if (streaming) {
    bubbleEl.innerHTML = '<span class="streaming-cursor"></span>';
  }

  contentEl.appendChild(headerEl);
  contentEl.appendChild(bubbleEl);
  msgEl.appendChild(avatarEl);
  msgEl.appendChild(contentEl);

  DOM.chatMessages.appendChild(msgEl);
  scrollToBottom();

  return { msgEl, bubble: bubbleEl };
}

function buildCitationsBox(citations) {
  const box = document.createElement('div');
  box.className = 'citations-box';
  box.innerHTML = `
    <div class="citations-title">
      <span>🌐</span> Sources from the web
    </div>
    ${citations.map(c => `
      <a class="citation-link" href="${c.url}" target="_blank" rel="noopener">
        <span class="citation-num">${c.index}</span>
        <div class="citation-info">
          <span class="citation-title-text">${escapeHtml(c.title)}</span>
          <span class="citation-url-text">${escapeHtml(c.url)}</span>
        </div>
      </a>
    `).join('')}
  `;
  return box;
}

function buildMessageActions(text) {
  const el = document.createElement('div');
  el.className = 'msg-actions';
  el.innerHTML = `
    <button class="btn btn-ghost btn-xs" id="copy-btn-${Date.now()}" onclick="copyToClipboard(this, \`${escapeAttr(text)}\`)">
      📋 Copy
    </button>
  `;
  return el;
}

// ─── Typing Indicator ──────────────────────────────────────────
function showTyping() {
  const msgEl = document.createElement('div');
  msgEl.className = 'message ai-message';
  msgEl.id = 'typing-indicator';
  msgEl.innerHTML = `
    <div class="msg-avatar ai-avatar">✦</div>
    <div class="msg-content">
      <div class="msg-header">
        <span class="msg-name">StudyBot</span>
        <span class="msg-time">Thinking…</span>
      </div>
      <div class="typing-indicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>
  `;
  DOM.chatMessages.appendChild(msgEl);
  scrollToBottom();
  return msgEl;
}

// ─── Session Management ────────────────────────────────────────
function saveCurrentSession() {
  if (state.conversationHistory.length === 0 && state.notes.length === 0 && state.sessionName === 'New Study Session') {
    return;
  }

  const sanitizedTopic = activeTopic.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() || 'default';

  const historyKey = `studyspace_history_${sanitizedTopic}`;
  const notesKey = `studyspace_notes_${sanitizedTopic}`;
  const messagesKey = `studyspace_messages_${sanitizedTopic}`;

  localStorage.setItem(historyKey, JSON.stringify(state.conversationHistory));
  localStorage.setItem(notesKey, JSON.stringify(state.notes));
  localStorage.setItem(messagesKey, JSON.stringify(state.messages || []));
}

function renderChatBubbles() {
  if (!DOM.chatMessages) return;
  if (!state.conversationHistory) {
    state.conversationHistory = [];
  }
  if (!state.messages) {
    state.messages = [];
  }
  DOM.chatMessages.innerHTML = '';
  if (state.conversationHistory.length === 0) {
    if (DOM.chatWelcome) DOM.chatWelcome.style.display = '';
  } else {
    if (DOM.chatWelcome) DOM.chatWelcome.style.display = 'none';

    state.conversationHistory.forEach(msg => {
      const role = msg.role === 'user' ? 'user' : 'ai';
      const text = msg.parts[0]?.text || '';
      appendMessage(role, text);
    });
  }
}

function renderChat() {
  renderChatBubbles();
}

// ─── Sources ────────────────────────────────────────────────────
function renderSources() {
  if (!DOM.sourceList) return;
  DOM.sourceList.innerHTML = state.sources.map(s => `
    <div class="source-item ${s.enabled ? 'active' : ''}">
      <span class="source-icon">${s.icon}</span>
      <div>
        <div class="source-name">${s.name}</div>
        <div class="source-meta">${s.meta}</div>
      </div>
    </div>
  `).join('');
  if (DOM.knowledgeSourcesContainer) {
    DOM.knowledgeSourcesContainer.style.display = 'block';
  }
}

// ─── Notes ─────────────────────────────────────────────────────
function addNote() {
  const text = DOM.noteTextarea?.value?.trim();
  if (!text) return;
  state.notes.unshift({ text, time: new Date() });
  DOM.noteTextarea.value = '';
  renderNotes();
  updateNotesCount();
  saveCurrentSession();
  showToast('📝 Note saved!', 'success');
}

function updateNotesCount() {
  const el = document.getElementById('notes-count');
  if (el) el.textContent = `${state.notes.length} note${state.notes.length !== 1 ? 's' : ''}`;
}

function renderNotes() {
  if (!DOM.notesList) return;
  if (state.notes.length === 0) {
    DOM.notesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📝</div>
        <div class="empty-text">No notes yet.<br>Jot down key ideas!</div>
      </div>`;
    return;
  }
  DOM.notesList.innerHTML = state.notes.map((n, i) => `
    <div class="note-item">
      <div class="note-text">${escapeHtml(n.text)}</div>
      <div class="note-time">${timeAgo(new Date(n.time))}</div>
    </div>
  `).join('');
}

// ─── Clear Chat ─────────────────────────────────────────────────
function clearChat() {
  state.conversationHistory = [];
  state.messages = [];
  conversationHistoryArray = [];
  localStorage.removeItem(`neurolog_chat_cache_${activeTopic}`);
  localStorage.removeItem(studyBotKey);
  DOM.chatMessages.innerHTML = '';
  if (DOM.chatWelcome) DOM.chatWelcome.style.display = '';
  saveCurrentSession();
  showToast('🗑️ Chat cleared', 'success');
}

// ─── Grounding UI Sync ────────────────────────────────────────
function syncGroundingUI() {
  const on = state.groundingEnabled;

  const btn   = document.getElementById('web-grounding-btn') || document.getElementById('grounding-toggle-btn');
  const badge = document.getElementById('grounding-hint-badge');
  const label = document.getElementById('grounding-hint-label');
  const textarea = DOM.chatTextarea;

  if (btn) {
    btn.classList.toggle('grounding-on',  on);
    btn.classList.toggle('grounding-off', !on);
    btn.setAttribute('aria-pressed', String(on));
    const lbl = btn.querySelector('.grounding-toggle-label');
    if (lbl) lbl.textContent = on ? 'Web Grounding ON' : 'Web Grounding OFF';
    btn.title = on
      ? 'Google Search Grounding is ON — click to disable'
      : 'Google Search Grounding is OFF — click to enable';
  }

  if (badge) {
    badge.classList.toggle('grounding-badge-on',  on);
    badge.classList.toggle('grounding-badge-off', !on);
    badge.title = on
      ? 'Google Search Grounding is active — answers are web-verified'
      : 'Google Search Grounding is OFF — answers use model knowledge only';
  }

  if (label) {
    label.textContent = on ? 'Google Grounding ON' : 'Google Grounding OFF';
  }

  if (textarea) {
    textarea.placeholder = on
      ? 'Ask any question — I\'ll search the web for the best answer…'
      : 'Ask any question — answering from model knowledge (Grounding OFF)…';
  }
}

// ─── Utilities ─────────────────────────────────────────────────
function scrollToBottom() {
  if (!DOM.chatMessages) return;
  if (state.isStreaming && stickyScroll.userScrolledUp) return;
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

function autoResizeTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  const maxH = 180;
  el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtmlAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return String(str).replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return date.toLocaleDateString();
}

function showToast(msg, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  DOM.toastContainer?.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

window.copyToClipboard = function(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✅ Copied!';
    setTimeout(() => (btn.textContent = '📋 Copy'), 2000);
  });
};

// ─── Start ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

// ─── Pre/Post Revision Assessment Flows ─────────────────────────
async function startPreRevisionExam(isBlocked) {
  state.assessmentResults = [];
  state.preRevisionActive = true;
  state.preRevisionCompleted = false;
  state.isPreRevisionRequired = isBlocked;
  
  if (DOM.assessmentCloseBtn) {
    DOM.assessmentCloseBtn.style.display = isBlocked ? 'none' : 'block';
  }

  if (DOM.assessmentBody) {
    DOM.assessmentBody.innerHTML = `
      <div class="assessment-loading">
        <div class="assessment-loading-dots">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
        <span>Building your unique Pre-Revision Exam…</span>
        <div class="assessment-loading-meta">6 questions: 3 Conceptual, 2 Analytical, 1 Hard Challenge</div>
      </div>`;
  }
  if (DOM.assessmentModalTitle)    DOM.assessmentModalTitle.textContent    = 'Pre-Revision Exam';
  if (DOM.assessmentModalSubtitle) DOM.assessmentModalSubtitle.textContent = '6 questions · Evaluates current retention';
  if (DOM.assessmentTypeTag)       DOM.assessmentTypeTag.textContent       = '';

  openAssessmentModal();

  const seed = Math.random().toString(36).substring(7);
  const prompt = `Generate a 6-question Pre-Revision Exam based on the study topic: ${state.sessionName}.
  Cache-buster payload seed: ${seed}. Ensure the questions are completely fresh, unique, and related to this topic.
  
  Distribution rules:
  - Questions 1-3: Conceptual/Core definitions (difficulty=easy, type=mcq or quiz only)
  - Questions 4-5: Analytical/Problem-solving items (difficulty=medium, mixed mcq, quiz, or qa)
  - Question 6: Hard Integration challenge (difficulty=hard, mixed mcq, quiz, or qa)`;

  try {
    const rawAiString = await geminiStructuredChat(prompt, 6);
    parseQuizResponse(rawAiString, state.sessionName);
  } catch (err) {
    console.warn('[StudySpace] Pre-Revision assessment generation error (using silent fallback):', err);
    state.currentQuizQuestions = [{
        id: 1, difficulty: "easy", type: "mcq",
        question_text: "Confirm engine initialization to access your workspace session.",
        options: ["Initialize Space", "Cancel"],
        correct_answer: "Initialize Space"
    }];
  }
  renderMixedAssessment(state.currentQuizQuestions);
}

async function startPostRevisionTest() {
  state.assessmentResults = [];
  state.postRevisionActive = true;
  state.postRevisionCompleted = false;
  
  if (DOM.assessmentCloseBtn) {
    DOM.assessmentCloseBtn.style.display = 'none'; // Lock exit until they finish post-test
  }

  if (DOM.assessmentBody) {
    DOM.assessmentBody.innerHTML = `
      <div class="assessment-loading">
        <div class="assessment-loading-dots">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
        <span>Building your exhaustive Post-Revision Test…</span>
        <div class="assessment-loading-meta">10 questions spanning complete session topic chapter</div>
      </div>`;
  }
  if (DOM.assessmentModalTitle)    DOM.assessmentModalTitle.textContent    = 'Post-Revision Test';
  if (DOM.assessmentModalSubtitle) DOM.assessmentModalSubtitle.textContent = '10 questions · Mixed formats';
  if (DOM.assessmentTypeTag)       DOM.assessmentTypeTag.textContent       = '';

  openAssessmentModal();

  const seed = Math.random().toString(36).substring(7);
  
  // Compile study session material
  let sessionContent = `Topic: ${state.sessionName}.\n`;
  if (state.notes.length > 0) {
    sessionContent += `Study notes:\n${state.notes.map(n => `- ${n.text}`).join('\n')}\n`;
  }
  const chatContext = state.conversationHistory
    .slice(-12)
    .map(m => `${m.role === 'user' ? 'Student' : 'StudyBot'}: ${m.parts[0]?.text || ''}`)
    .join('\n');
  if (chatContext) sessionContent += `Study Room Conversation:\n${chatContext}`;

  const prompt = `Generate a 10-question Post-Revision Test based on this study session material.
  Study Session Material:
  ${sessionContent}
  
  Cache-buster seed: ${seed}. Ensure the questions are completely fresh and unique to evaluate understanding.`;

  try {
    const rawAiString = await geminiStructuredChat(prompt, 10);
    parseQuizResponse(rawAiString, state.sessionName);
  } catch (err) {
    console.warn('[StudySpace] Post-Revision assessment generation error (using silent fallback):', err);
    state.currentQuizQuestions = [{
        id: 1, difficulty: "easy", type: "mcq",
        question_text: "Confirm engine initialization to access your workspace session.",
        options: ["Initialize Workspace", "Cancel"],
        correct_answer: "Initialize Workspace"
    }];
  }
  renderMixedAssessment(state.currentQuizQuestions);
}

function concludePreRevisionExam(total) {
  const correctCount = state.assessmentResults.filter(r => r.correct).length;
  state.q_pre = (correctCount / total) * 5;
  state.preRevisionCompleted = true;
  state.preRevisionActive = false;
  state.isPreRevisionRequired = false;

  if (DOM.assessmentCloseBtn) {
    DOM.assessmentCloseBtn.style.display = 'block'; // unlock close
  }

  if (DOM.assessmentBody) {
    DOM.assessmentBody.innerHTML = `
      <div class="assessment-completion-card" style="text-align: center; padding: 40px 20px; font-family: 'Inter', sans-serif;">
        <div style="font-size: 1.15rem; font-weight: 500; color: var(--text-main); margin-bottom: 30px;">
          Review Complete. You scored ${correctCount} / ${total} questions correct.
        </div>
        <div>
          <button class="btn btn-primary" id="pre-revision-start-study-btn" style="padding: 10px 24px; font-size: 1rem;">
            Enter Study Room & Start Study
          </button>
        </div>
      </div>`;

    document.getElementById('pre-revision-start-study-btn')?.addEventListener('click', () => {
      closeAssessmentModal();
    });
  }
}

async function concludePostRevisionTest(total) {
  const correctCount = state.assessmentResults.filter(r => r.correct).length;
  state.q_post = (correctCount / total) * 5;
  state.postRevisionCompleted = true;

  // Calibration maths using continuous physics-based modeling
  const params = new URLSearchParams(window.location.search);
  const rawPrevK  = params.get('k');
  const rawPrevR0 = params.get('R0');
  const rawRevCount = params.get('revisionCount') || params.get('revisions');

  // ── NaN Safety Guard — Cold-Start k & R0 protection ───────────────────
  const COLD_START_K = 0.0500;
  const COLD_START_R0 = 0.0;
  
  const isCold = (
    rawRevCount === '0' ||
    rawRevCount === '--' ||
    rawPrevK === '--' ||
    rawPrevR0 === '--' ||
    rawPrevK === null ||
    rawPrevK === 'null' ||
    rawPrevK === '' ||
    rawPrevK === '0' ||
    rawPrevK === '0.0000' ||
    parseFloat(rawPrevK) === 0 ||
    isNaN(parseFloat(rawPrevK))
  );

  const prev_k  = (isCold || isNaN(parseFloat(rawPrevK))) ? COLD_START_K : parseFloat(rawPrevK);
  const prev_R0 = (isCold || isNaN(parseFloat(rawPrevR0))) ? COLD_START_R0 : parseFloat(rawPrevR0);

  const loggedAt      = params.get('loggedAt') || new Date().toISOString();
  const historyCount  = parseInt(params.get('revisionCount')) || 0;

  const RPred    = calculateCurrentRetention(prev_R0, prev_k, loggedAt);
  const APre     = state.q_pre !== null ? (state.q_pre / 5) : RPred;
  const kAdjusted = adjustDecayConstant(prev_k, RPred, APre);
  const APost    = correctCount / total;

  // CRITICAL SAFETY GATE: freeze historyCount for optional (non-deadline) sessions
  const effectiveHistoryCount = state.isPreRevisionRequired ? historyCount : historyCount;
  // NOTE: when session is optional, we still run the decay formulas to reshape k/R0
  // but we do NOT increment revisionCount in the saved log entry (handled in saveStudySessionLog)

  const { R0, kFinal, nextReviewTimestamp } = finalizeSessionMetrics(kAdjusted, APost, effectiveHistoryCount);

  if (DOM.assessmentBody) {
    DOM.assessmentBody.innerHTML = `
      <div class="assessment-completion-card" style="text-align: center; padding: 40px 20px; font-family: 'Inter', sans-serif;">
        <div style="font-size: 1.15rem; font-weight: 500; color: var(--text-main); margin-bottom: 30px;">
          Review Complete. You scored ${correctCount} / 10 questions correct.
        </div>
        <div>
          <button class="btn btn-primary" id="post-revision-exit-btn" style="padding: 10px 24px; font-size: 1rem; background: #81c995; border-color: #81c995; color: #072711;">
            Exit to Dashboard
          </button>
        </div>
      </div>`;

    document.getElementById('post-revision-exit-btn')?.addEventListener('click', async () => {
      // Recalculate k and R0 & push final score vectors to Firestore
      // Pass isOptional flag so saveStudySessionLog can freeze the revisionCount increment
      await saveStudySessionLog(state.q_post * 2, kFinal, R0, nextReviewTimestamp, !state.isPreRevisionRequired);
      
      // Clear out local session caches - commented out to allow chat resumption
      // localStorage.removeItem(studyBotKey);
      // localStorage.removeItem(doubtBotKey);
      // localStorage.removeItem(`neurolog_chat_cache_${activeTopic}`);
      
      // Cache freshly computed k/R0 for instant dashboard hydration before Firestore indexes
      const rawTopic = params.get('topic') || state.sessionName;
      const rawSubject = params.get('subject') || 'General';
      const transientPayload = {
          topic: normalizeTopic(rawTopic),
          subject: normalizeSubject(rawSubject),
          displayTopic: normalizeTopic(rawTopic),
          displaySubject: normalizeSubject(rawSubject),
          k: kFinal,
          R0: R0,
          loggedAt: new Date().toISOString(),
          revisionCount: effectiveHistoryCount + 1
      };
      localStorage.setItem('neurolog_transient_sync', JSON.stringify(transientPayload));

      // Navigation redirect
      window.location.replace("../dashboard.html");
    });
  }
}

async function saveStudySessionLog(performanceScore, new_k, new_R0, nextReviewTimestamp, isOptionalSession = false) {
  const params = new URLSearchParams(window.location.search);
  const rawSubject = params.get('subject') || 'General';
  const rawTopic = params.get('topic') || state.sessionName;
  const prevRevisionCount = parseInt(params.get('revisionCount')) || 0;

  const perfNorm = Math.min(10, Math.max(0, performanceScore));
  let inferredDifficulty;
  if (perfNorm > 7)       inferredDifficulty = 'Easy';
  else if (perfNorm >= 4) inferredDifficulty = 'Medium';
  else                    inferredDifficulty = 'Hard';

  // Short-term calibration safeguard rule: freeze counter increment for optional before-deadline sessions
  const newRevisionCount = isOptionalSession ? prevRevisionCount : prevRevisionCount + 1;

  const logEntry = {
    subject: normalizeSubject(rawSubject),
    topic: normalizeTopic(rawTopic),
    displaySubject: normalizeSubject(rawSubject),
    displayTopic: normalizeTopic(rawTopic),
    difficulty: inferredDifficulty,
    avgPerf: +perfNorm.toFixed(2),
    revisions: newRevisionCount,
    currentRetention: +(new_R0 * 100).toFixed(2),
    revisionCount: newRevisionCount,
    performance: Math.round(performanceScore),
    context: state.notes.map(n => n.text).join('\n'),
    k: new_k,
    R0: new_R0,
    previous_k: (() => {
      const raw = params.get('k');
      const parsed = parseFloat(raw);
      return (raw && raw !== 'null' && !isNaN(parsed)) ? parsed : (state.coldStartK || 0.0500);
    })(),
    loggedAt: new Date().toISOString(),
    timestamp: IS_CONFIGURED ? timestamp() : null,
    reviewAt: nextReviewTimestamp ? new Date(nextReviewTimestamp).toISOString() : null
  };

  // Push immediate local cache token to bridge async database replication delays
  localStorage.setItem('neurolog_transient_sync', JSON.stringify(logEntry));

  const uid = sessionStorage.getItem('neurolog_authenticated_uid');
  if (IS_CONFIGURED && db && uid) {
    try {
      await addDoc(collection(db, 'users', uid, 'study_logs'), logEntry);
    } catch (err) {
      console.error("Failed to log session to Firestore:", err);
      saveToLocalStorage(logEntry);
    }
  } else {
    saveToLocalStorage(logEntry);
  }
}

function saveToLocalStorage(logEntry) {
  const stored = JSON.parse(localStorage.getItem('neurologs') || '[]');
  stored.push({ id: 'local_' + Date.now(), ...logEntry });
  localStorage.setItem('neurologs', JSON.stringify(stored));
  console.log("Logged session to localStorage successfully.");
}

// ─── Gateway Prompt — Optional Pre-Revision (Condition B) ─────
//  Shown when the deadline has NOT yet passed.
//  Offers "Start Test" (runs 6-Q pre-exam) or "Skip to Study Room" bypass.
function showPreRevisionGatewayPrompt() {
  if (!DOM.assessmentModal || !DOM.assessmentBody) return;

  // Hide the close button — user must actively choose a path
  if (DOM.assessmentCloseBtn) DOM.assessmentCloseBtn.style.display = 'none';

  if (DOM.assessmentModalTitle)    DOM.assessmentModalTitle.textContent    = 'Pre-Revision Check-In';
  if (DOM.assessmentModalSubtitle) DOM.assessmentModalSubtitle.textContent = 'Optional — helps calibrate your memory curve';
  if (DOM.assessmentTypeTag)       DOM.assessmentTypeTag.textContent       = '';

  DOM.assessmentBody.innerHTML = `
    <div style="
      display: flex; flex-direction: column; align-items: center;
      gap: 20px; padding: 36px 24px; text-align: center;
      font-family: 'Inter', 'Outfit', sans-serif;
    ">
      <div style="
        font-size: 1.05rem; font-weight: 500;
        color: var(--text-main, #e6edf3);
        line-height: 1.6; max-width: 420px;
      ">
        Would you like to take a quick Pre-Revision evaluation to tune your active memory curve?
      </div>
      <div style="font-size: 0.85rem; color: var(--text-muted, #8b949e); max-width: 380px;">
        This is optional. Your results will adaptively reshape your decay constant and retention intercept — making your review schedule more accurate.
      </div>
      <div style="display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 300px; margin-top: 8px;">
        <button
          id="gateway-start-test-btn"
          style="
            padding: 11px 24px; border-radius: 10px; border: none; cursor: pointer;
            background: var(--accent, #58a6ff); color: #080c12;
            font-size: 0.95rem; font-weight: 700; font-family: inherit;
            transition: opacity 0.2s;
          "
          onmouseover="this.style.opacity='0.88'" onmouseout="this.style.opacity='1'"
        >
          Start Test
        </button>
        <button
          id="gateway-skip-btn"
          style="
            padding: 9px 24px; border-radius: 10px; cursor: pointer;
            background: transparent; border: 1px solid rgba(255,255,255,0.12);
            color: var(--text-muted, #8b949e); font-size: 0.85rem;
            font-family: inherit; transition: color 0.2s, border-color 0.2s;
          "
          onmouseover="this.style.color='var(--text-main,#e6edf3)';this.style.borderColor='rgba(255,255,255,0.25)'"
          onmouseout="this.style.color='var(--text-muted,#8b949e)';this.style.borderColor='rgba(255,255,255,0.12)'"
        >
          Skip to Study Room
        </button>
      </div>
    </div>`;

  openAssessmentModal();

  document.getElementById('gateway-start-test-btn')?.addEventListener('click', () => {
    // Run optional pre-exam (isBlocked = false → close button restored after)
    startPreRevisionExam(false);
  });

  document.getElementById('gateway-skip-btn')?.addEventListener('click', () => {
    // Restore close button visibility and dismiss the modal
    if (DOM.assessmentCloseBtn) DOM.assessmentCloseBtn.style.display = '';
    DOM.assessmentModal.classList.add('hidden');
    document.body.style.overflow = '';
  });
}

// ─── Exit Confirm Prompt — Post-Revision with Gating Rules ──────
//  Evaluates cold-start and deadline constraints to decide whether
//  the user may bypass the post-revision quiz or must complete it.
function showExitConfirmPrompt() {
  if (!DOM.assessmentModal || !DOM.assessmentBody) return;

  // ── Gating evaluation ─────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  const rawK = params.get('k');
  const rawRevCount = params.get('revisionCount');
  const reviewDeadlineRaw = params.get('reviewDeadline');

  // Cold Start condition 1: k is missing, empty, undefined, "null", or 0
  const isColdStartK = !rawK || rawK === '' || rawK === 'null' || rawK === '0' || rawK === '0.0000' || parseFloat(rawK) === 0;

  // Cold Start condition 2: revisionCount is 0, missing, or "0"
  const isColdStartRev = !rawRevCount || rawRevCount === '0' || rawRevCount === '';

  // Deadline Check: current time is equal to or past the parsed reviewDeadline
  const now = Date.now();
  const deadlineMs = reviewDeadlineRaw ? new Date(reviewDeadlineRaw).getTime() : NaN;
  const isOverdue = !isNaN(deadlineMs) && now >= deadlineMs;

  // MANDATORY if any cold-start condition OR overdue; OPTIONAL only if before deadline with history > 0
  const isMandatory = isColdStartK || isColdStartRev || isOverdue;

  // Hide close button — user must actively choose a path
  if (DOM.assessmentCloseBtn) DOM.assessmentCloseBtn.style.display = 'none';

  if (DOM.assessmentModalTitle)    DOM.assessmentModalTitle.textContent    = 'Session Complete';
  if (DOM.assessmentModalSubtitle) DOM.assessmentModalSubtitle.textContent = isMandatory
    ? 'Post-revision evaluation required'
    : 'Optional post-revision calibration';
  if (DOM.assessmentTypeTag)       DOM.assessmentTypeTag.textContent       = '';

  DOM.assessmentBody.innerHTML = `
    <div style="
      display: flex; flex-direction: column; align-items: center;
      gap: 20px; padding: 36px 24px; text-align: center;
      font-family: 'Inter', 'Outfit', sans-serif;
    ">
      <div style="
        font-size: 1.05rem; font-weight: 500;
        color: var(--text-main, #e6edf3);
        line-height: 1.6; max-width: 420px;
      ">
        ${isMandatory
          ? 'You must complete the post-revision evaluation to establish your memory curve constants.'
          : 'Would you like to complete your post-revision evaluation to calibrate your current curve statistics?'}
      </div>
      <div style="font-size: 0.85rem; color: var(--text-muted, #8b949e); max-width: 380px;">
        ${isMandatory
          ? 'This evaluation is required because ' + ((isColdStartK || isColdStartRev) ? 'this is your first session for this topic.' : 'your review deadline has passed.')
          : 'Taking the quiz updates your decay constant and retention intercept in real-time. Your revision count will not increment — this is a calibration-only session.'}
      </div>
      <div style="display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 300px; margin-top: 8px;">
        <button
          id="exit-attempt-quiz-btn"
          style="
            padding: 11px 24px; border-radius: 10px; border: none; cursor: pointer;
            background: var(--accent, #58a6ff); color: #080c12;
            font-size: 0.95rem; font-weight: 700; font-family: inherit;
            transition: opacity 0.2s;
          "
          onmouseover="this.style.opacity='0.88'" onmouseout="this.style.opacity='1'"
        >
          ${isMandatory ? 'Start Evaluation' : 'Attempt Quiz'}
        </button>
        ${!isMandatory ? `
        <button
          id="exit-bypass-btn"
          style="
            padding: 9px 24px; border-radius: 10px; cursor: pointer;
            background: transparent; border: 1px solid rgba(248,81,73,0.3);
            color: #ff7b72; font-size: 0.85rem;
            font-family: inherit; transition: border-color 0.2s;
          "
          onmouseover="this.style.borderColor='rgba(248,81,73,0.6)'"
          onmouseout="this.style.borderColor='rgba(248,81,73,0.3)'"
        >
          Bypass Quiz &amp; Exit
        </button>
        ` : ''}
      </div>
    </div>`;

  openAssessmentModal();

  document.getElementById('exit-attempt-quiz-btn')?.addEventListener('click', () => {
    // Run post-test (mandatory or optional depending on gating)
    startPostRevisionTest();
  });

  // Only wire bypass handler when the button exists (non-mandatory sessions)
  if (!isMandatory) {
    document.getElementById('exit-bypass-btn')?.addEventListener('click', async () => {
      const rawPrevK  = params.get('k');
      const rawPrevR0 = params.get('R0');
      const COLD_START_K = 0.0500;
      
      const prev_k  = (rawPrevK && rawPrevK !== 'null' && !isNaN(parseFloat(rawPrevK))) ? parseFloat(rawPrevK) : (state.coldStartK || COLD_START_K);
      const prev_R0 = (rawPrevR0 && rawPrevR0 !== 'null' && !isNaN(parseFloat(rawPrevR0))) ? parseFloat(rawPrevR0) : 1.0;
      const loggedAt = params.get('loggedAt') || new Date().toISOString();
      const historyCount = parseInt(params.get('revisionCount')) || 0;

      // Use continuous physics-based modeling to establish safety baselines
      const RPred = calculateCurrentRetention(prev_R0, prev_k, loggedAt);
      const APre = state.q_pre !== null ? (state.q_pre / 5) : RPred;
      const kAdjusted = adjustDecayConstant(prev_k, RPred, APre);
      
      // Conclude with a neutral 50% baseline score since they bypassed the physical assessment
      const APostFallback = 0.50; 
      const { R0, kFinal, nextReviewTimestamp } = finalizeSessionMetrics(kAdjusted, APostFallback, historyCount);

      // Save the baseline snapshot log, explicit flagging as optional to preserve long-term intervals
      await saveStudySessionLog(5, kFinal, R0, nextReviewTimestamp, true);
      window.location.replace('../dashboard.html');
    });
  }
}

// ─── Session Renaming Cache Migration ──────────────────────────
function handleRename(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const oldActive = oldName.toLowerCase().trim();
  const newActive = newName.toLowerCase().trim();
  
  const oldStudyKey = `neurolog_study_bot_${oldActive}`;
  const newStudyKey = `neurolog_study_bot_${newActive}`;
  const oldDoubtKey = `neurolog_doubt_bot_${oldActive}`;
  const newDoubtKey = `neurolog_doubt_bot_${newActive}`;
  const oldCacheKey = `neurolog_chat_cache_${oldActive}`;
  const newCacheKey = `neurolog_chat_cache_${newActive}`;
  
  const oldSanitized = oldActive.replace(/[^a-zA-Z0-9]/g, '_') || 'default';
  const newSanitized = newActive.replace(/[^a-zA-Z0-9]/g, '_') || 'default';
  const oldNotesKey = `studyspace_notes_${oldSanitized}`;
  const newNotesKey = `studyspace_notes_${newSanitized}`;
  const oldHistKey = `studyspace_history_${oldSanitized}`;
  const newHistKey = `studyspace_history_${newSanitized}`;
  const oldMsgKey = `studyspace_messages_${oldSanitized}`;
  const newMsgKey = `studyspace_messages_${newSanitized}`;

  // Move Study Bot history
  const studyHistory = localStorage.getItem(oldStudyKey);
  if (studyHistory) {
    localStorage.setItem(newStudyKey, studyHistory);
    localStorage.removeItem(oldStudyKey);
  }
  
  // Move Doubt Bot history
  const doubtHistory = localStorage.getItem(oldDoubtKey);
  if (doubtHistory) {
    localStorage.setItem(newDoubtKey, doubtHistory);
    localStorage.removeItem(oldDoubtKey);
  }
  
  // Move Cache history
  const cacheHistory = localStorage.getItem(oldCacheKey);
  if (cacheHistory) {
    localStorage.setItem(newCacheKey, cacheHistory);
    localStorage.removeItem(oldCacheKey);
  }
  
  // Move Notes
  const notes = localStorage.getItem(oldNotesKey);
  if (notes) {
    localStorage.setItem(newNotesKey, notes);
    localStorage.removeItem(oldNotesKey);
  }

  // Move History/Messages
  const hist = localStorage.getItem(oldHistKey);
  if (hist) {
    localStorage.setItem(newHistKey, hist);
    localStorage.removeItem(oldHistKey);
  }
  const msg = localStorage.getItem(oldMsgKey);
  if (msg) {
    localStorage.setItem(newMsgKey, msg);
    localStorage.removeItem(oldMsgKey);
  }

  // Update active variables
  activeTopic = newActive;
  studyBotKey = newStudyKey;
  doubtBotKey = newDoubtKey;
}

