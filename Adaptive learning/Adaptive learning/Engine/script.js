// ══════════════════════════════════════════════════════════════════
//  NeuroLog · script.js  (Auth Gateway)
// ══════════════════════════════════════════════════════════════════

import { db, IS_CONFIGURED, app } from './firebase-config.js';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithRedirect, getRedirectResult, GoogleAuthProvider, onAuthStateChanged } 
from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';

const auth = app ? getAuth(app) : null;

// ── Show the unconfigured notice if Firebase is not yet set up ────
if (!IS_CONFIGURED) {
    document.getElementById('firebase-notice')?.classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
    const authForm = document.getElementById('auth-form');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const submitBtn = document.getElementById('submit-btn');
    const btnText = document.getElementById('auth-submit-text');
    const btnLoader = submitBtn?.querySelector('.btn-loader');
    const errorMessage = document.getElementById('errorMessage');
    
    const googleBtn = document.getElementById('google-auth-btn');
    const toggleBtn = document.getElementById('auth-toggle-btn');
    const toggleText = document.getElementById('auth-toggle-text');
    
    let isSignUp = false;
    let isRedirecting = false;

    // ── Route Protection & Google Redirect Landing ──────────────
    if (auth) {
        getRedirectResult(auth)
            .then((result) => {
                if (result) {
                    console.log("Authentication handshake successful:", result.user.uid);
                    isRedirecting = true;
                    sessionStorage.setItem('google_auth_success_uid', result.user.uid);
                    window.location.href = 'dashboard.html';
                }
            })
            .catch((error) => {
                showError(`Google Redirect Error: ${error.message}`);
            });

        onAuthStateChanged(auth, (user) => {
            if (user) {
                console.log("Secure connection confirmed for Firebase UID:", user.uid);
                // Use sessionStorage to safely flag an active session across async page refreshes
                sessionStorage.setItem('neurolog_authenticated_uid', user.uid);
                window.location.replace('dashboard.html');
            }
        });
    }

    // ── Toggle Login / Sign Up Mode ──────────────────────────────
    toggleBtn?.addEventListener('click', () => {
        isSignUp = !isSignUp;
        if (isSignUp) {
            btnText.textContent = 'Sign Up';
            toggleText.textContent = 'Already have an account?';
            toggleBtn.textContent = 'Log In';
        } else {
            btnText.textContent = 'Log In';
            toggleText.textContent = "Don't have an account?";
            toggleBtn.textContent = 'Sign Up';
        }
        hideError();
    });

    // ── Email/Password Submit ────────────────────────────────────
    authForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = emailInput.value.trim();
        const password = passwordInput.value.trim();

        if (!email || !password) {
            return showError('Please enter email and password.');
        }

        setLoading(true);
        hideError();

        try {
            if (!auth) throw new Error("Firebase Auth is not configured.");
            
            if (isSignUp) {
                await createUserWithEmailAndPassword(auth, email, password);
            } else {
                await signInWithEmailAndPassword(auth, email, password);
            }
            // onAuthStateChanged will handle the redirect
        } catch (err) {
            setLoading(false);
            showError(getAuthErrorMessage(err.code) || err.message);
        }
    });

    // ── Google Sign In ───────────────────────────────────────────
    googleBtn?.addEventListener('click', async () => {
        setLoading(true);
        hideError();
        try {
            if (!auth) throw new Error("Firebase Auth is not configured.");
            const provider = new GoogleAuthProvider();
            await signInWithRedirect(auth, provider);
        } catch (err) {
            setLoading(false);
            showError(`Google Redirect Error: ${err.message}`);
        }
    });

    // ── Utility Functions ────────────────────────────────────────
    function setLoading(isLoading) {
        if (submitBtn) submitBtn.disabled = isLoading;
        if (googleBtn) googleBtn.disabled = isLoading;
        if (isLoading) {
            btnText?.classList.add('text-hidden');
            btnLoader?.classList.remove('loader-hidden');
        } else {
            btnText?.classList.remove('text-hidden');
            btnLoader?.classList.add('loader-hidden');
        }
    }

    function showError(msg) {
        if (errorMessage) {
            errorMessage.textContent = msg;
            errorMessage.classList.remove('hidden');
        }
    }

    function hideError() {
        if (errorMessage) {
            errorMessage.classList.add('hidden');
        }
    }

    function getAuthErrorMessage(errorCode) {
        switch (errorCode) {
            case 'auth/invalid-email': return 'Invalid email address format.';
            case 'auth/user-disabled': return 'This user account has been disabled.';
            case 'auth/user-not-found': return 'No account found with this email.';
            case 'auth/wrong-password': return 'Incorrect password.';
            case 'auth/email-already-in-use': return 'Email is already registered.';
            case 'auth/weak-password': return 'Password should be at least 6 characters.';
            case 'auth/invalid-credential': return 'Invalid credentials provided.';
            case 'auth/popup-closed-by-user': return 'Google sign-in popup was closed.';
            default: return null;
        }
    }
});
