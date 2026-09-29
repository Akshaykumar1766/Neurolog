// ══════════════════════════════════════════════════════════════════
//  NeuroLog · utils.js  —  Shared utilities
//  FIX 10: Topic normalisation — ensures consistent grouping
//          regardless of casing, whitespace, or trailing spaces.
// ══════════════════════════════════════════════════════════════════

/**
 * Normalise a topic string for consistent storage and grouping.
 *   "Data  Types " → "data types"
 *   "  Arrays " → "arrays"
 *
 * @param {string} raw — the raw user input
 * @returns {string}   — lowercase, trimmed, single-spaced
 */
export function normalizeTopic(raw) {
    return (raw || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

/**
 * Normalise a subject string (same rules as topic).
 * @param {string} raw
 * @returns {string}
 */
export function normalizeSubject(raw) {
    return (raw || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}
/**
 * Calculate retention at the current time based on initial R0, decay rate k, and last study timestamp.
 * R_t = R0 * e^(-k * t) where t is time elapsed in days.
 */
export function calculateCurrentRetention(R0, k, lastStudiedTime) {
    const lastTime = new Date(lastStudiedTime).getTime();
    if (isNaN(lastTime)) return 0;
    const t = (Date.now() - lastTime) / (1000 * 60 * 60 * 24);
    const safeK = (k === null || k === undefined) ? 0.0500 : k;
    const safeR0 = (R0 === null || R0 === undefined) ? 1.0 : R0;
    return safeR0 * Math.exp(-safeK * t);
}

/**
 * Adjust the decay rate kOld based on predicted retention RPred and actual pre-test performance APre.
 * kAdjusted = kOld * (1 + eta * (RPred - APre))
 */
export function adjustDecayConstant(kOld, RPred, APre) {
    const eta = 0.2;
    return kOld * (1 + eta * (RPred - APre));
}

/**
 * Calculate the finalized session parameters, new decay rate, and next review timestamp.
 */
export function finalizeSessionMetrics(kAdjusted, APost, historyCount) {
    const R0 = Math.min(0.95, 0.4 + (0.6 * APost));
    const gamma = 0.5;
    const kFinal = kAdjusted / (1 + (gamma * historyCount * APost));
    
    // Safety check for natural log arguments
    let tDeadlineDays = 0;
    if (R0 > 0.6 && kFinal > 0) {
        tDeadlineDays = -Math.log(0.6 / R0) / kFinal;
    }
    // Clamp to [0.25, 5] to keep review schedules realistic
    tDeadlineDays = Math.max(0.25, Math.min(5.0, tDeadlineDays));
    
    const nextReviewTimestamp = Date.now() + (tDeadlineDays * 24 * 60 * 60 * 1000);
    return {
        R0,
        kFinal,
        nextReviewTimestamp
    };
}
