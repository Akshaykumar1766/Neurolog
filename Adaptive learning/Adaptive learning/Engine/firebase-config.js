// ══════════════════════════════════════════════════════════════════
//  NeuroLog · firebase-config.js
//  Single source of truth for Firebase initialisation.
//  Both script.js and dashboard.js import from here — the config
//  literal exists in exactly ONE place.
// ══════════════════════════════════════════════════════════════════

import { initializeApp }       from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import { getFirestore, serverTimestamp }
                                from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

const firebaseConfig = {
    apiKey:            "AIzaSyDFO9RA9Otnru953q6Q5pnc1CxDNyTxSXs",
    authDomain:        "adaptive-learning-20028.firebaseapp.com",
    projectId:         "adaptive-learning-20028",
    storageBucket:     "adaptive-learning-20028.firebasestorage.app",
    messagingSenderId: "596351887505",
    appId:             "1:596351887505:web:b0193f18884d4a9ff4b730"
};

// True when the config holds real credentials (not the placeholder template).
export const IS_CONFIGURED = !firebaseConfig.apiKey.startsWith('YOUR_');

// Initialise Firebase once; export null values in unconfigured environments
// so consumers can guard with `if (IS_CONFIGURED && db)` without crashing.
let _db = null;

export let app = null;
if (IS_CONFIGURED) {
    app = initializeApp(firebaseConfig);
    _db = getFirestore(app);
}
export { _db as db };

// Re-export serverTimestamp so consumers never need to import Firebase directly.
export const timestamp = serverTimestamp;

export const LOCAL_AI_CONFIG = {
    baseUrl: "http://localhost:11434/v1/chat/completions",
    modelName: "qwen2.5:7b"
};


