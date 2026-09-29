// ══════════════════════════════════════════════════════════════════
//  NeuroLog · dashboard.js  (Page 2 — Analysis Dashboard)
//  FIX 1: Firebase config imported from firebase-config.js — zero
//          config literals in this file.
//  FIX 3: aggregateTopics() computes an exponentially-weighted
//          average k across all sessions per topic, honouring full
//          revision history instead of discarding it.
//  FIX 4: revisionCount field name standardised; no dual-fallback.
//  FIX 5: Retention model upgraded to R(t) = R₀·e^(-k·t).
//  FIX 6: Adaptive per-topic threshold; R₀-aware deadline formula.
//  FIX 7: R0 now uses latest session only (not weighted average).
//  FIX 8: Rich adaptive threshold (multi-factor: performance tiers,
//          revision depth, session consistency, learning trend,
//          inferred difficulty).
//  FIX 9: Learning velocity (trend detection), auto difficulty
//          inference, and spacing optimization for strong learners.
// ══════════════════════════════════════════════════════════════════

import { collection, query, orderBy, where, getDocs, deleteDoc, doc, addDoc }
    from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import { onAuthStateChanged, signOut, getAuth } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import { db, IS_CONFIGURED, timestamp, app } from './firebase-config.js';
import { normalizeTopic, normalizeSubject, calculateCurrentRetention } from './utils.js';

const auth = app ? getAuth(app) : null;

// ── Auth & Data Isolation ─────────────────────────────────────────
let currentUser = null;

// ── Ignored Topics (persistent dismiss for urgent alerts) ─────────
const IGNORED_KEY = 'neurolog_ignored_topics';

function getIgnoredTopics() {
    try { return JSON.parse(localStorage.getItem(IGNORED_KEY) || '[]'); }
    catch { return []; }
}

function setIgnoredTopics(topics) {
    localStorage.setItem(IGNORED_KEY, JSON.stringify(topics));
}

function ignoreTopic(topicName) {
    const list = getIgnoredTopics();
    if (!list.includes(topicName)) {
        list.push(topicName);
        setIgnoredTopics(list);
    }
}

// ── Delete Topic (all logs for a topic) ───────────────────────────
async function deleteTopic(topicName) {
    if (!confirm(`Delete "${topicName}" and all its history?\nThis cannot be undone.`)) {
        return false;
    }

    try {
        console.log("Deleting topic:", topicName);

        if (IS_CONFIGURED && db && currentUser) {
            // Firebase: fetch all logs and filter in JS to catch un-normalized legacy data
            const q = query(collection(db, 'users', currentUser.uid, 'study_logs'));
            const snap = await getDocs(q);
            
            const deletes = [];
            snap.forEach(d => {
                const data = d.data();
                if (normalizeTopic(data.topic) === topicName) {
                    deletes.push(deleteDoc(doc(db, 'users', currentUser.uid, 'study_logs', d.id)));
                }
            });
            
            await Promise.all(deletes);
            console.log(`🗑️ Deleted ${deletes.length} Firestore docs for "${topicName}"`);
        } else {
            // localStorage fallback
            const stored = JSON.parse(localStorage.getItem('neurologs') || '[]');
            const filtered = stored.filter(l => normalizeTopic(l.topic) !== topicName);
            localStorage.setItem('neurologs', JSON.stringify(filtered));
            console.log(`🗑️ Deleted localStorage logs for "${topicName}"`);
        }

        // Also remove from ignored list if present
        const ignored = getIgnoredTopics();
        setIgnoredTopics(ignored.filter(t => t !== topicName));

        return true;
    } catch (err) {
        console.error('Delete failed:', err);
        alert('Failed to delete topic: ' + err.message);
        return false;
    }
}

// ── Memory Decay ─────────────────────────────────────────────────
//  R(t) = R₀ · e^(-k · t)   where t = days elapsed since last studied
function retention(k, tDays, R0 = 1.0) {
    const safeK = (k === null || k === undefined) ? 0.0500 : k;
    const safeR0 = (R0 === null || R0 === undefined) ? 1.0 : R0;
    return safeR0 * Math.exp(-safeK * tDays);
}

// Days until retention drops to `threshold`
//  Derived from R₀·e^(-k·t) = threshold  →  t = (ln(R₀) − ln(threshold)) / k
function daysUntilThreshold(k, threshold = 0.60, R0 = 1.0) {
    const safeK = (k === null || k === undefined) ? 0.0500 : k;
    const safeR0 = (R0 === null || R0 === undefined) ? 1.0 : R0;
    if (safeK <= 0) return Infinity;
    if (safeR0 <= threshold) return 0;   // already below threshold at t = 0
    let tDays = (Math.log(safeR0) - Math.log(threshold)) / safeK;
    tDays *= 0.8; // optional smoothing for realism
    tDays = Math.max(0.25, Math.min(tDays, 5));  // clamp to 6h - 5d
    return tDays;
}

function retentionColor(pct, thresholdPct = 60) {
    if (pct >= thresholdPct + 20) return '#3fb950';
    if (pct >= thresholdPct) return '#d29922';
    return '#f85149';
}

// ── Adaptive per-topic review threshold ───────────────────────────
//  Multi-factor threshold that adapts to the learner's history:
//    • Performance tiers   (high → raise bar, low → lower bar)
//    • Revision depth      (>5 revisions → raise bar)
//    • Session consistency  (>5 sessions → raise bar)
//    • Learning trend       (improving → raise, declining → lower)
//    • Inferred difficulty  (hard topics → lower bar slightly)
//  Clamped to [0.40, 0.85] to keep deadlines reasonable.
function computeThreshold(topic) {
    let threshold = 0.6;

    // ── Performance-based adaptation ──
    const perf = topic.avgPerformance ?? topic.performance ?? 5;
    if (perf > 8)      threshold += 0.10;
    else if (perf > 7) threshold += 0.05;
    else if (perf < 5) threshold -= 0.05;

    // ── Revision depth ──
    if ((topic.revisionCount ?? 0) > 5) threshold += 0.05;

    // ── Learning consistency ──
    if ((topic.sessionCount ?? 1) > 5) threshold += 0.05;

    // ── Learning trend (velocity) ──
    if (typeof topic.learningTrend === 'number') {
        if (topic.learningTrend > 0) threshold += 0.05;
        if (topic.learningTrend < 0) threshold -= 0.05;
    }

    // ── Inferred difficulty pressure ──
    if (typeof topic.difficultyScore === 'number' && topic.difficultyScore > 0.7) {
        threshold -= 0.03;   // hard topics get a slightly relaxed bar
    }

    // ── Clamp for stability ──
    return Math.min(0.85, Math.max(0.40, threshold));
}

function formatDuration(days) {
    if (days < 1 / 24) return Math.round(days * 24 * 60) + ' min';
    if (days < 1) return (days * 24).toFixed(1) + ' hrs';
    return days.toFixed(2) + ' days (' + (days * 24).toFixed(1) + ' hrs)';
}

function addDays(isoString, days) {
    return new Date(new Date(isoString).getTime() + days * 86_400_000);
}

function formatDate(timestamp) {
    const date = new Date(timestamp);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

function formatDateTime(timestamp) {
    const date = new Date(timestamp);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year}, ${hours}:${minutes}`;
}

// ── Parse URL params (from the redirect in script.js) ─────────────
function parseCurrentSession() {
    const p = new URLSearchParams(window.location.search);
    if (!p.get('topic')) return null;
    return {
        subject: normalizeSubject(p.get('subject') || ''),
        topic: normalizeTopic(p.get('topic') || ''),
        displaySubject: p.get('subject') || '—',
        displayTopic: p.get('topic') || '—',
        difficulty: parseInt(p.get('difficulty')) || 2,
        performance: parseInt(p.get('performance')) || 5,
        revisionCount: parseInt(p.get('revisionCount')) || 0,  // FIX 4: standardised key
        k: parseFloat(p.get('k')) || 0.3,
        R0: parseFloat(p.get('R0')) || 1.0,
        loggedAt: p.get('loggedAt') || new Date().toISOString(),
        docId: p.get('docId') || null,
        firebase: p.get('firebase') === '1',
    };
}

// ── Load all logs from Firestore or localStorage ──────────────────
async function loadAllLogs() {
    if (IS_CONFIGURED && db && currentUser) {
        const q = query(collection(db, 'users', currentUser.uid, 'study_logs'), orderBy('timestamp', 'desc'));
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    return JSON.parse(localStorage.getItem('neurologs') || '[]');
}

// ── FIX 3: Weighted-average k across all sessions per topic ───────
//
//  Instead of discarding all but the latest log, we group every log
//  for the same topic and compute an exponentially-weighted mean k:
//
//    weight_i  = e^(-λ · age_i_days)   λ = 0.1
//    k_eff     = Σ(weight_i · k_i) / Σ(weight_i)
//
//  This means recent sessions dominate the curve while older ones
//  still contribute — preserving the full benefit of revision history.
//
//  Extra fields attached to each aggregated topic:
//    • sessionCount    — total times this topic has been studied
//    • avgPerformance  — mean recall score across all sessions
//    • latestLoggedAt  — ISO string of the most recent log (used for
//                        revision-deadline calculation)
const RECENCY_LAMBDA = 0.1; // decay rate for session weighting (per day)

function aggregateTopics(logs) {
    const now = Date.now();

    // 1. Group logs by normalized "subject|topic" key
    //    FIX 10: normalization merges legacy duplicates caused by
    //    inconsistent casing/whitespace ("Data Types" + "data types" etc.)
    /** @type {Record<string, Array>} */
    const groups = {};
    for (const log of logs) {
        const key = `${normalizeSubject(log.subject)}|${normalizeTopic(log.topic)}`;
        (groups[key] ??= []).push(log);
    }

    // 2. For each group compute weighted-average k + auxiliary stats
    return Object.values(groups).map(sessions => {
        let weightSum = 0;
        let kWeightedSum = 0;
        // FIX 7: R0 no longer averaged — only latest session's R0 is used.
        let perfSum = 0;
        let latestLog = sessions[0];

        for (const s of sessions) {
            const ageMs = now - new Date(s.loggedAt).getTime();
            const ageDays = Math.max(0, ageMs / 86_400_000);
            const weight = Math.exp(-RECENCY_LAMBDA * ageDays);

            kWeightedSum += weight * (s.k ?? 0);
            weightSum += weight;
            perfSum += (s.performance ?? 5);

            if (new Date(s.loggedAt) > new Date(latestLog.loggedAt)) {
                latestLog = s;
            }
        }

        let k_eff = weightSum > 0
            ? Math.max(0.01, kWeightedSum / weightSum)
            : (latestLog.k ?? 0.3);

        // Recalibrate globally: original k was tuned for hours, adjust to days
        k_eff = k_eff / 24;
        k_eff = Math.max(k_eff, 0.05); // ensure k doesn't get too small

        // FIX 7: R0 = latest session's R0 (current learning quality)
        const R0_eff = latestLog.R0 ?? 1.0;

        const avgPerformance = +(perfSum / sessions.length).toFixed(1);

        // ── FIX 9a: Learning Velocity (Trend Detection) ──────────
        //  Sort sessions chronologically and compare the latest
        //  performance against the mean of the preceding 3–5 sessions.
        const sorted = [...sessions].sort(
            (a, b) => new Date(a.loggedAt) - new Date(b.loggedAt)
        );
        let learningTrend = 0;
        if (sorted.length >= 2) {
            const latestPerf = sorted[sorted.length - 1].performance ?? 5;
            const window = sorted.slice(
                Math.max(0, sorted.length - 6),
                sorted.length - 1           // exclude latest
            );
            const prevAvg = window.reduce(
                (s, l) => s + (l.performance ?? 5), 0
            ) / window.length;
            learningTrend = +(latestPerf - prevAvg).toFixed(2);
        }

        // ── FIX 9b: Auto Difficulty Detection ─────────────────────
        //  Infers difficulty from behaviour: fast decay (high k) and
        //  low performance both push the score higher.
        //  difficultyScore ∈ [0, ~2]  —  >0.7 indicates a hard topic.
        const difficultyScore = +(
            (k_eff / 1.5) + (1 - avgPerformance / 10)
        ).toFixed(3);

        return {
            // Spread the latest log as the base (carries subject, topic,
            // difficulty, revisionCount, context etc.)
            ...latestLog,
            // Ensure tracking properties and layout values use normalized, uniform string targets
            topic: normalizeTopic(latestLog.topic),
            subject: normalizeSubject(latestLog.subject),
            displayTopic: normalizeTopic(latestLog.topic),
            displaySubject: normalizeSubject(latestLog.subject),
            // Override k with the weighted effective value
            k: +k_eff.toFixed(4),
            R0: +R0_eff.toFixed(4),
            // Augmented analytics fields
            sessionCount: sessions.length,
            avgPerformance,
            learningTrend,          // FIX 9a: positive = improving
            difficultyScore,        // FIX 9b: higher = harder
        };
    });
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════
// Instantly freeze the frame if the user bypassed the login gateway illegally
if (!sessionStorage.getItem('neurolog_authenticated_uid')) {
    console.warn("Security check empty. Evicting anonymous traveler to index.");
    window.location.replace('index.html');
}

// Keep the loading spinner visible until Firebase finishes the security handshake
const loadingOverlay = document.getElementById('loading-overlay');
if (loadingOverlay) {
    loadingOverlay.style.display = 'flex';
}

// ── Sign Out Logic ────────────────────────────────────────────
const signOutBtn = document.getElementById('sign-out-btn');
if (signOutBtn && auth) {
    signOutBtn.addEventListener('click', async () => {
        try {
            await signOut(auth);
            sessionStorage.removeItem('neurolog_authenticated_uid');
            window.location.replace('index.html');
        } catch (err) {
            console.error("Sign out error", err);
        }
    });
}

if (auth) {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            console.warn("Network validation failed. Wiping transient credentials.");
            sessionStorage.removeItem('neurolog_authenticated_uid');
            window.location.replace('index.html');
        } else {
            console.log("Access authorization granted for UID:", user.uid);
            sessionStorage.setItem('neurolog_authenticated_uid', user.uid);
            currentUser = user;
            try {
                await initDashboard();
                if (loadingOverlay) {
                    loadingOverlay.style.display = 'none';
                }
            } catch (err) {
                console.error("Dashboard data hydration crash:", err);
            }
        }
    });
} else {
    initDashboard();
}

async function initDashboard() {
    const loading = document.getElementById('loading-overlay');

    // 1. Parse the session that just redirected here
    const session = parseCurrentSession();

    // 2. Render session summary card
    if (session) renderSessionCard(session);

    // 3. Load all historical logs
    let allLogs = [];
    try {
        allLogs = await loadAllLogs();
    } catch (err) {
        console.warn('Could not load logs:', err);
    }

    const transientSync = localStorage.getItem('neurolog_transient_sync');
    if (transientSync) {
        const parsedSync = JSON.parse(transientSync);
        localStorage.removeItem('neurolog_transient_sync');
        
        // Check if entry already exists to avoid duplication anomalies
        const isAlreadyListed = allLogs.some(l => normalizeTopic(l.topic) === parsedSync.topic && l.loggedAt === parsedSync.loggedAt);
        if (!isAlreadyListed) {
            allLogs.unshift(parsedSync);
        }
    }

    const saveStatusEl = document.getElementById('save-status');
    if (saveStatusEl) {
        saveStatusEl.textContent = IS_CONFIGURED ? '🔥 Firebase connected' : '💾 Offline mode (localStorage)';
    }

    // 4. Merge current session if Firestore hasn't returned it yet
    if (session) {
        const alreadyPresent = allLogs.some(
            l => l.id === session.docId || normalizeTopic(l.topic) === session.topic
        );
        if (!alreadyPresent) allLogs.unshift(session);
    }

    // 5. FIX 3: Aggregate per-topic with weighted-average k
    const topics = aggregateTopics(allLogs);
    const now = Date.now();

    // 6. Compute current retention for each aggregated topic
    const topicStats = topics.map(t => {
        const tDays = Math.max(0, (now - new Date(t.loggedAt).getTime()) / 86_400_000);
        const R0 = t.R0 ?? 1.0;
        const R = calculateCurrentRetention(R0, t.k, t.loggedAt);
        const pct = +(R * 100).toFixed(1);
        const threshold = computeThreshold(t);
        const thrPct = +(threshold * 100).toFixed(1);
        let daysToThr = daysUntilThreshold(t.k, threshold, R0);

        // ── FIX 9c: Spacing Optimization ─────────────────────────
        //  If the learner consistently performs well (avg > 8) over
        //  enough sessions (>3), extend the predicted review interval
        //  by 15% — rewarding strong memory consolidation.
        if ((t.avgPerformance ?? 0) > 8 && (t.sessionCount ?? 1) > 3) {
            daysToThr *= 1.15;
        }

        const reviewAt = addDays(t.loggedAt, daysToThr);

        // ── Dashboard badge ──────────────────────────────────────
        let badge = '';
        if (t.learningTrend > 0.5)      badge = 'Improving';
        else if (t.learningTrend < -0.5) badge = 'Declining';
        if (pct >= thrPct + 20)          badge = badge || 'Strong Memory';
        if (pct < thrPct)                badge = 'Weak Topic';

        return {
            ...t,
            tDays,
            R,
            pct,
            threshold,      // per-topic adaptive threshold (0–1)
            thrPct,         // same, as percentage
            daysToThr,
            reviewAt,
            isUrgent: pct < thrPct,
            isWarning: pct >= thrPct && pct < thrPct + 20,
            badge,          // FIX 9d: dashboard indicator badge
        };
    });

    // Sort most-urgent first
    topicStats.sort((a, b) => a.pct - b.pct);

    loading.style.display = 'none';

    // 7–10. Render all dashboard sections
    renderDecayChart(topicStats);
    renderWeeklyCalendar(topicStats);
    renderTopicCards(topicStats);
    renderSchedule(topicStats);

    // ── Urgent alert with persistent ignore support ────────────────
    const ignored = getIgnoredTopics();
    const urgentTopics = topicStats.filter(
        t => t.isUrgent && !ignored.includes(t.topic)
    );
    if (urgentTopics.length > 0) {
        document.getElementById('urgent-alert').classList.remove('hidden');
        document.getElementById('urgent-topics').textContent =
            urgentTopics.map(t => t.displayTopic || t.topic).join(', ');
    }

    // ── Dismiss button handler ────────────────────────────────────
    document.getElementById('dismiss-alert')?.addEventListener('click', () => {
        // Persist each currently-urgent topic to the ignore list
        urgentTopics.forEach(t => ignoreTopic(t.topic));
        document.getElementById('urgent-alert').classList.add('hidden');
    });

    // ── Add New Topic Modal ───────────────────────────────────────
    const addTopicBtn = document.getElementById('add-topic-btn');
    const addTopicModal = document.getElementById('add-topic-modal');
    const cancelAddTopic = document.getElementById('cancel-add-topic');
    const addTopicForm = document.getElementById('add-topic-form');

    if (addTopicBtn) {
        addTopicBtn.addEventListener('click', () => {
            addTopicModal.classList.remove('hidden');
        });
    }

    if (cancelAddTopic) {
        cancelAddTopic.addEventListener('click', () => {
            addTopicModal.classList.add('hidden');
        });
    }

    if (addTopicForm) {
        addTopicForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const rawSubject = document.getElementById('new-subject').value.trim();
            const rawTopic = document.getElementById('new-topic').value.trim();

            if (!rawSubject || !rawTopic) return;

            const subject = normalizeSubject(rawSubject);
            const topic = normalizeTopic(rawTopic);

            const submitBtn = addTopicForm.querySelector('button[type="submit"]');
            const originalText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Adding...';

            // Null-baseline initialisation — all model-driven fields are null
            // until the engine computes real values after the first post-revision quiz.
            // k (decay constant) is intentionally null here: StudySpace detects this
            // as a 'Cold Start' state and forces the mandatory Pre-Revision Exam on
            // first entry, using a temporary internal constant of 0.0500 behind the
            // scenes so the exam algorithms can run without a real k yet.
            const logEntry = {
                subject,
                topic,
                displaySubject: subject,
                displayTopic: topic,
                difficulty: 0,
                avgPerf: 0,
                revisions: 0,
                currentRetention: 0.00,
                revisionCount: 0,
                performance: 0,
                context: '',
                k: 0.0000,
                k_eff: 0.0000,
                R0: 0.00,
                previous_k: 0.0000,
                loggedAt: new Date().toISOString(),
                timestamp: IS_CONFIGURED ? timestamp() : null
            };

            try {
                if (IS_CONFIGURED && db && currentUser) {
                    await addDoc(collection(db, 'users', currentUser.uid, 'study_logs'), logEntry);
                } else {
                    const stored = JSON.parse(localStorage.getItem('neurologs') || '[]');
                    stored.push({ id: 'local_' + Date.now(), ...logEntry });
                    localStorage.setItem('neurologs', JSON.stringify(stored));
                }
                
                // Refresh view
                window.location.reload();
            } catch (err) {
                console.error('Failed to add topic:', err);
                alert('Failed to add topic: ' + err.message);
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }
}

// ── Session Summary Card ───────────────────────────────────────────
function renderSessionCard(s) {
    const diffLabels = ['', 'Easy', 'Medium', 'Hard', 'Expert'];
    document.getElementById('session-grid').innerHTML = `
        <div class="session-stat">
            <span class="stat-label">Subject</span>
            <span class="stat-value">${s.displaySubject || s.subject}</span>
        </div>
        <div class="session-stat">
            <span class="stat-label">Topic</span>
            <span class="stat-value">${s.displayTopic || s.topic}</span>
        </div>
        <div class="session-stat">
            <span class="stat-label">Difficulty</span>
            <span class="stat-value">${diffLabels[s.difficulty] || s.difficulty}</span>
        </div>
        <div class="session-stat">
            <span class="stat-label">Performance</span>
            <span class="stat-value">${s.performance} / 10</span>
        </div>
        <div class="session-stat">
            <span class="stat-label">Revisions</span>
            <span class="stat-value">${s.revisionCount ?? 0}</span>
        </div>
        <div class="session-stat">
            <span class="stat-label">Decay Constant (k)</span>
            <span class="stat-value mono">${parseFloat(s.k).toFixed(4)}</span>
        </div>
        <div class="session-stat">
            <span class="stat-label">Initial Retention (R₀)</span>
            <span class="stat-value mono">${((s.R0 ?? 1.0) * 100).toFixed(0)}%</span>
        </div>
    `;
}

let decayChartInstance = null;

function renderDecayChart(topicStats) {
    const canvas = document.getElementById('decayChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Destroy existing chart instance to prevent canvas reuse errors
    if (decayChartInstance) {
        decayChartInstance.destroy();
    }
    
    const daysArr = Array.from({ length: 168 }, (_, i) => i / 24);   // 7 days in 1-hour increments
    const colors = ['#58a6ff', '#f4d03f', '#3fb950', '#f85149', '#c39bd3', '#85c1e9', '#fad7a0'];

    const datasets = topicStats.slice(0, 6).map((t, idx) => ({
        label: t.displayTopic || t.topic,
        data: daysArr.map(d => +(retention(t.k, d, t.R0 ?? 1.0) * 100).toFixed(2)),
        borderColor: colors[idx % colors.length],
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [5, 3],
        tension: 0.4,
        pointRadius: 0,
    }));

    const avgThr = topicStats.length > 0
        ? topicStats.reduce((s, t) => s + (t.thrPct ?? 60), 0) / topicStats.length
        : 60;
    datasets.push({
        label: `${avgThr.toFixed(0)}% Threshold`,
        data: daysArr.map(() => +avgThr.toFixed(1)),
        borderColor: 'rgba(248, 81, 73, 0.6)',
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderDash: [8, 4],
        pointRadius: 0,
        tension: 0,
    });

    decayChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels: daysArr.map(d => +d.toFixed(2)), datasets },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    labels: { color: '#8b949e', font: { family: 'Outfit', size: 12 }, boxWidth: 20 }
                },
                tooltip: {
                    backgroundColor: 'rgba(13,17,23,0.95)',
                    borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1,
                    titleColor: '#e6edf3',
                    bodyColor: '#8b949e',
                    callbacks: {
                        title: ctx => `T + ${ctx[0].label} days`,
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}%`,
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: '#8b949e',
                        font: { family: 'Outfit' },
                        callback: v => v % 24 === 0 ? `Day ${v / 24}` : ''
                    },
                    grid: { color: 'rgba(255,255,255,0.05)' }
                },
                y: {
                    min: 0, max: 100,
                    ticks: {
                        color: '#8b949e',
                        font: { family: 'Outfit' },
                        callback: v => v + '%',
                        stepSize: 20
                    },
                    grid: { color: 'rgba(255,255,255,0.05)' }
                }
            }
        }
    });
}

// ── Topic Cards ────────────────────────────────────────────────────
//  FIX 3: Shows sessionCount and avgPerformance.
//  FIX 4: Uses t.revisionCount ?? 0 — no dual-fallback.
//  FIX 11: Evaluation gating — Avg perf and Diff display '--' until the
//           first post-revision quiz has been completed (revisions > 0).
//  FIX 12: k_eff gating — displays '--' for cold-start cards (k === null
//           or revisions === 0) and the 4-decimal float once computed.
function renderTopicCards(topicStats) {
    document.getElementById('topics-grid').innerHTML = topicStats.map(t => {
        const color = retentionColor(t.pct, t.thrPct);
        const statusText = t.isUrgent ? 'Review Now'
            : t.isWarning ? 'Review Soon'
                : 'Healthy';

        // ── Evaluation Gating ────────────────────────────────────
        // revisions field (set by add-topic init) takes precedence;
        // fall back to revisionCount from legacy study_log entries.
        const revisions = t.revisions ?? t.revisionCount ?? 0;
        const kVal = t.k;

        let kEffDisplay;
        let avgPerfDisplay;
        let diffDisplay;

        if (revisions === 0 || kVal === 0 || kVal === null || kVal === undefined) {
            kEffDisplay = "0.0000";
            avgPerfDisplay = "0.0/10";
            diffDisplay = "Unrated";
        } else {
            kEffDisplay = parseFloat(kVal).toFixed(4);
            const scoreVal = t.avgPerf ?? t.avgPerformance ?? t.performance ?? 5;
            avgPerfDisplay = `${parseFloat(scoreVal).toFixed(1)}/10`;
            if (scoreVal > 7)       diffDisplay = 'Easy';
            else if (scoreVal >= 4) diffDisplay = 'Medium';
            else                    diffDisplay = 'Hard';
        }

        // badge class for color coding
        const badgeClass = t.badge?.includes('Improving') ? 'badge-improving'
            : t.badge?.includes('Declining') ? 'badge-declining'
            : t.badge?.includes('Strong') ? 'badge-strong'
            : t.badge?.includes('Weak') ? 'badge-weak'
            : '';

        // Clean up all clumpy subscripts and formulas to ensure clear visual uniformity
        const renderedMetaLine = `
  <span>k-Decay Rate: <strong>${kEffDisplay}</strong></span>
  <span>Difficulty: <strong>${diffDisplay}</strong></span>
  <span>Revisions: <strong>${revisions}</strong></span>
  <span>Sessions: <strong>${t.sessionCount ?? 1}</strong></span>
  <span>Avg Score: <strong>${avgPerfDisplay}</strong></span>
  <span>Threshold: <strong>${t.thrPct}%</strong></span>
`;

        return `
        <div class="topic-card glass-card ${t.isUrgent ? 'urgent' : t.isWarning ? 'warning' : ''}">
            <div class="topic-card-header">
                <div>
                    <div class="topic-name">${t.displayTopic || t.topic}</div>
                    <div class="topic-subject">${t.displaySubject || t.subject || '—'}</div>
                </div>
                <div class="topic-badges">
                    ${t.badge ? `<span class="topic-badge ${badgeClass}">${t.badge}</span>` : ''}
                    <span class="topic-status">${statusText}</span>
                    <button class="delete-btn" data-topic="${t.topic}" title="Delete topic and all history">Delete</button>
                </div>
            </div>
            <div class="topic-meta">
                ${renderedMetaLine}
                ${t.learningTrend !== 0 ? `<span>Trend: <strong style="color:${t.learningTrend > 0 ? 'var(--success)' : 'var(--danger)'}">${t.learningTrend > 0 ? '+' : ''}${t.learningTrend}</strong></span>` : ''}
            </div>
            <div class="topic-retention-row">
                <span class="retention-label">Current Retention</span>
                <span class="retention-value" style="color:${color}">${t.pct}%</span>
            </div>
            <div class="retention-bar-wrap">
                <div class="retention-bar" style="width:${t.pct}%; background:${color}"></div>
            </div>
            <div class="topic-review-time">
                Review deadline: <strong>${formatDateTime(t.reviewAt)}</strong>
                <span class="remaining">(${formatDuration(t.daysToThr)} from log time)</span>
            </div>
            <a class="study-btn"
               href="studyspace/index.html?topic=${encodeURIComponent(t.displayTopic || t.topic)}&subject=${encodeURIComponent(t.displaySubject || t.subject || '')}&reviewDeadline=${encodeURIComponent(t.reviewAt ? new Date(t.reviewAt).toISOString() : '')}&lastPerformance=${t.performance ?? ''}&k=${t.k ?? ''}&R0=${t.R0 ?? ''}&revisionCount=${t.revisionCount ?? 0}&loggedAt=${encodeURIComponent(t.loggedAt || '')}">
                Start Study
            </a>
        </div>`;
    }).join('');

    // ── Wire delete buttons ───────────────────────────────────────
    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const topicName = btn.dataset.topic;
            btn.disabled = true;
            btn.textContent = '⏳';
            const deleted = await deleteTopic(topicName);
            if (deleted) {
                // Reload dashboard to reflect changes
                window.location.href = 'dashboard.html';
            } else {
                btn.disabled = false;
                btn.textContent = '🗑️';
            }
        });
    });
}

// ── Review Schedule ────────────────────────────────────────────────
function renderSchedule(topicStats) {
    const list = document.getElementById('schedule-list');
    // Show topics that are below their *own* adaptive threshold + 20 pp buffer
    const atRisk = topicStats.filter(t => t.pct < t.thrPct + 20);

    if (atRisk.length === 0) {
        list.innerHTML = `<div class="schedule-empty">All topics are currently healthy — above their adaptive thresholds. Keep it up!</div>`;
        return;
    }

    const now = new Date();
    list.innerHTML = atRisk.map(t => {
        const diffMs = t.reviewAt - now;
        const diffDays = diffMs / 86_400_000;
        const isOverdue = diffDays < 0;
        const color = retentionColor(t.pct, t.thrPct);

        return `
        <div class="schedule-row ${t.isUrgent ? 'overdue' : ''}">
            <div class="schedule-topic">
                <div class="schedule-dot" style="background:${color}"></div>
                <div>
                    <strong>${t.displayTopic || t.topic}</strong>
                    <span class="schedule-sub">${t.displaySubject || t.subject || ''}</span>
                </div>
            </div>
            <div class="schedule-retention">
                <span style="color:${color}">${t.pct}%</span>
                <span class="schedule-k">k = ${parseFloat(t.k).toFixed(4)} · thr = ${t.thrPct}%</span>
            </div>
            <div class="schedule-deadline ${isOverdue ? 'overdue-text' : ''}">
                ${isOverdue
                ? 'Overdue — review immediately'
                : `Review by: <strong>${formatDateTime(t.reviewAt)}</strong>`}
                <span class="schedule-remaining">
                    (${isOverdue
                ? Math.abs(diffDays).toFixed(2) + ' days overdue'
                : formatDuration(diffDays) + ' remaining'})
                </span>
            </div>
        </div>`;
    }).join('');
}

// ── Weekly Review Calendar ─────────────────────────────────────────
//  Renders a 7-column Mon–Sun grid for the current week.
//  Each topic's reviewAt timestamp is bucketed into the matching day.
//  Month-boundary safe: all arithmetic uses UTC epoch milliseconds,
//  so a transition from e.g. June 30 → July 1 never misaligns indices.
function renderWeeklyCalendar(topicStats) {
    const container = document.getElementById('calendar-week-row');
    if (!container) return;

    const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const MS_PER_DAY = 86_400_000;

    // ── Compute the Monday that anchors the current week ─────────────
    //  JS getDay(): 0 = Sun, 1 = Mon … 6 = Sat
    //  We remap to ISO: Mon = 0 … Sun = 6.
    const nowMs   = Date.now();
    const nowDate = new Date(nowMs);

    // Strip to UTC midnight to avoid DST offsets skewing the bucket index
    const todayUtcMs = Date.UTC(
        nowDate.getFullYear(),
        nowDate.getMonth(),
        nowDate.getDate()
    );

    const jsDow    = nowDate.getDay();           // 0=Sun … 6=Sat
    const isoDow   = jsDow === 0 ? 6 : jsDow - 1; // 0=Mon … 6=Sun
    const mondayMs = todayUtcMs - isoDow * MS_PER_DAY;
    const sundayMs = mondayMs   + 6  * MS_PER_DAY;

    // ── Build 7 day buckets ──────────────────────────────────────────
    // Each bucket = array of { label, isOverdue, isUrgent }
    const buckets = Array.from({ length: 7 }, () => []);

    for (const t of topicStats) {
        // reviewAt may be a Date object or an ISO string; normalise to ms
        const deadlineMs = t.reviewAt ? new Date(t.reviewAt).getTime() : null;
        if (!deadlineMs || isNaN(deadlineMs)) continue;

        // Strip to UTC midnight for clean day comparison
        const dlDate = new Date(deadlineMs);
        const dlUtcMs = Date.UTC(
            dlDate.getUTCFullYear(),
            dlDate.getUTCMonth(),
            dlDate.getUTCDate()
        );

        if (dlUtcMs < mondayMs || dlUtcMs > sundayMs) continue;

        // Safe integer bucket index (guaranteed 0–6 by the bounds check above)
        const dayIdx = Math.round((dlUtcMs - mondayMs) / MS_PER_DAY);
        if (dayIdx < 0 || dayIdx > 6) continue;   // extra safety gate

        buckets[dayIdx].push({
            label:     t.displayTopic || t.topic,
            isOverdue: t.isUrgent,
            isUrgent:  t.isWarning,
        });
    }

    // ── Render the 7 column cells ────────────────────────────────────
    container.innerHTML = '';

    for (let i = 0; i < 7; i++) {
        const cellDateMs   = mondayMs + i * MS_PER_DAY;
        const cellDate     = new Date(cellDateMs);
        const dayNum       = String(cellDate.getUTCDate()).padStart(2, '0');
        const isToday      = cellDateMs === todayUtcMs;
        const hasOverdue   = buckets[i].some(c => c.isOverdue);

        // Build class list
        const colClasses = [
            'cal-day-col',
            isToday    ? 'cal-today'      : '',
            hasOverdue ? 'cal-has-overdue' : '',
        ].filter(Boolean).join(' ');

        // Build chip HTML
        let chipsHtml;
        if (buckets[i].length === 0) {
            chipsHtml = `<span class="cal-empty">No sessions</span>`;
        } else {
            const chipItems = buckets[i].map(c => {
                const chipClass = c.isOverdue ? 'cal-chip cal-chip-overdue'
                    : c.isUrgent ? 'cal-chip cal-chip-urgent'
                    : 'cal-chip';
                // Truncate label to 22 chars for column density
                const label = c.label.length > 22
                    ? c.label.slice(0, 21) + '\u2026'
                    : c.label;
                return `<span class="${chipClass}" title="${c.label}">${label}</span>`;
            }).join('');
            chipsHtml = `<div class="cal-chip-list">${chipItems}</div>`;
        }

        container.insertAdjacentHTML('beforeend', `
            <div class="${colClasses}">
                <div class="cal-day-header">
                    <span class="cal-day-name">${DAY_NAMES[i]}</span>
                    <span class="cal-day-number">${dayNum}</span>
                </div>
                ${chipsHtml}
            </div>`);
    }
}
