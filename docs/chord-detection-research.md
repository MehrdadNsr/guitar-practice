# Real-Time Chord Detection & Play-Along Research

## 1. Problem Statement & Root Cause Analysis

### The Problem
When the player strums a single chord (e.g., `Am`), the play-along engine frequently cascades forward, advancing 3–4 chords ahead in less than 200 ms. Half the song turns green while the player is still on the first measure.

### Root Causes in the Legacy Implementation
1. **Lookahead Tolerance Bug (`skip = 1`)**:
   In `js/app.js` (`advanceToDetectedChord`), the detector did not only check the current expected chord; it also checked `nextExpected = chordEls[state.progressIdx + 1]`. Any match against `nextExpected` would immediately advance with `skip = 1`.
2. **Harmonic Overlap & Candidate Matching**:
   Chords in the same diatonic key share notes (e.g. `Am` = A-C-E, `C` = C-E-G, `Em` = E-G-B). An open `Am` chord vibrates the low E string, A string, D string, G string, B string, and high E string. A ringing `Am` has high energy at pitch classes C and E. When evaluated against `C`, the template correlation easily exceeds 0.55.
3. **Continuous Per-Frame Evaluation (No Strum Gating)**:
   The microphone loop runs via `requestAnimationFrame` every ~40 ms. When an `Am` is accepted, the song index increments to `C`. 40 ms later, the physical strings are still ringing `Am`. The detector immediately evaluates the ringing `Am` against `C`, which meets the loose threshold and triggers `C`. In the next 40 ms frame, `Em` matches the ringing E notes!
4. **Slow Sustain Decay**:
   The chroma vector used a leaky integrator with slow decay ($\alpha = 0.12$), accumulating and sustaining pitch classes for seconds across chord changes.
5. **Absence of a Strict State Machine & Attack Transient Detection**:
   The engine treated chord recognition as a continuous classification problem rather than a discrete event-driven interaction.

---

## 2. Research on State-of-the-Art Approaches

### A. Feature Extraction & MIR Libraries
1. **Essentia.js (MTG / UPF)**:
   - Uses High-Resolution Harmonic Pitch Class Profiles (HPCP) calculated using peak whitening and spectral harmonic summation.
   - Pros: High accuracy, academic benchmark standard.
   - Cons: Heavy WebAssembly binary (~2.5 MB to 5 MB), complex asynchronous worker initialization, overhead for real-time mobile/browser latency.
2. **Meyda**:
   - Audio feature extraction library in JavaScript supporting 12-bin Chroma, Spectral Flux, RMS, and Energy.
   - Pros: Lightweight, pure JS, easy to integrate.
   - Cons: Standard FFT chroma without harmonic peak-weighting suffers from harmonic smearing (upper harmonics leaking into unrelated pitch bins).
3. **Spotify Basic Pitch**:
   - Polyphonic note and pitch bend prediction using a lightweight neural network (TensorFlow.js).
   - Pros: Extremely accurate note detection.
   - Cons: High CPU/GPU inference cost in real-time Web Audio loops, adds significant latency (150–250 ms model latency), requires bundle bloat.
4. **Optimized Direct Chroma + Harmonic Peaking (Our Chosen Audio Engine)**:
   - 2048-sample FFT (or 4096 zero-padded) at 44.1 kHz / 48 kHz gives ~11–22 Hz bin resolution.
   - Log-frequency mapping across the guitar fundamental and low-harmonic range (E2 ~ 82 Hz to E5 ~ 660 Hz).
   - Quadratic spectral peak interpolation (finding exact peaks rather than broad bin accumulation).
   - Third-harmonic suppression: guitar strings produce strong odd and even harmonics (the 3rd harmonic of root A is E; 3rd harmonic of E is B). Suppressing expected upper harmonics prevents false fifths and third additions.

### B. Interactive Play-Along Engines (Yousician, Rocksmith, Fender Play, Chordify)
How do real interactive music-learning games handle "wait until the player plays the right chord, then move on"?

1. **Discrete Strum / Onset Trigger (Attack Detection)**:
   - Recognition is **never continuous**. It is triggered by an **onset** — a sudden increase in broad-band high-frequency energy (Spectral Flux) or sharp RMS rise ($\Delta E > \text{threshold}$).
   - Once a strum attack is detected, the audio engine opens a brief **Evaluation Window** (100–250 ms after attack), capturing the steady-state vibration of the newly struck chord.
2. **Strict Single-Target Evaluation (Hypothesis Testing)**:
   - Instead of asking *"Which of the 108 chords in the database does this sound like?"*, the engine asks *"Does this sound like the target chord $C_{target}$?"*
   - A chord template correlation $r(C_{target})$ is computed.
   - Furthermore, $r(C_{target})$ must exceed competitor chords by a safety margin $\delta$:
     $$r(C_{target}) \ge \tau \quad \text{and} \quad r(C_{target}) \ge \max_{k \neq target} r(C_k) - \delta$$
3. **Strict State Machine (FSM)**:
   - States:
     - `IDLE / WAITING_FOR_STRUM`: Strings may be silent or ringing from the previous chord. No advancement possible.
     - `ATTACK_DETECTED`: Energy spike detected; start sampling frames for the integration window.
     - `EVALUATING`: Accumulate 3–6 consecutive frames (150–250 ms).
     - `ACCEPTED`: Target chord confirmed. Advance the cursor by **EXACTLY 1 CHORD**.
     - `LOCKOUT / RINGING`: String energy is decaying. System completely ignores all audio matching until energy drops below threshold AND a new distinct attack occurs.
     - `REJECTED`: Played chord did not match target. Reset to `WAITING_FOR_STRUM`. Do not advance.
4. **Never Skip Ahead**:
   - The play-along engine never evaluates future chords ($i+1$, $i+2$). Advancing is strictly restricted to step-by-step ($i \to i+1$).

---

## 3. Chosen Architecture & Implementation Plan

### Architecture Diagram
```
Microphone Audio / Audio File
             │
             ▼
    ┌─────────────────┐
    │  Audio Engine   │ (Web Audio API AnalyserNode, FFT 2048)
    └────────┬────────┘
             │ Spectrum & Energy (RMS, High-Freq Content)
             ▼
    ┌─────────────────┐
    │ Onset Detector  │ ── [No Strum / Ringing] ──► Ignore (Lockout)
    └────────┬────────┘
             │ [Fresh Strum Attack Detected]
             ▼
    ┌─────────────────┐
    │ Chroma Profiler │ (E2–E5 Log-frequency mapping, peak interpolation)
    └────────┬────────┘
             │ 12-bin Pitch Class Profile
             ▼
    ┌────────────────────────────────────────┐
    │ Target Chord Hypothesis Evaluator      │
    │ (Pearson correlation vs expected chord, │
    │  dominance margin over competitors)    │
    └────────┬───────────────────────────────┘
             │
      ┌──────┴──────┐
      │             │
   [Match]       [Mismatch]
      │             │
      ▼             ▼
┌───────────┐ ┌───────────┐
│ Advance   │ │ Log Reject│
│ Exactly 1 │ │ Keep wait │
│ Step      │ └───────────┘
└─────┬─────┘
      │
      ▼
┌───────────┐
│  Lockout  │ (Until energy decays & next strum attack)
└───────────┘
```

### Components to Rebuild:
1. **`StrumDetector` (in `js/chord-detector.js`)**:
   - Measures RMS energy and spectral flux across frames.
   - Detects attack slope $\frac{dE}{dt} > \theta_{attack}$.
   - Prevents re-triggering during decay (minimum inter-strum interval ~250 ms).
2. **`TargetChordValidator`**:
   - Calculates Pearson correlation between normalized 12-bin chroma and binary/harmonic chord templates.
   - Computes target score $S_{target}$ and best competitor score $S_{best}$.
   - Accepts if $S_{target} \ge \text{threshold}$ (configurable: Strict = 0.65, Normal = 0.55, Relaxed = 0.45).
3. **`PlayAlongFSM` (in `js/app.js` and `js/chord-detector.js`)**:
   - Controls song cursor progression.
   - Enforces exact single-step advances (`progressIdx++`).
   - Completely removes lookahead skipping.
   - Visual feedback: target chord pulses, turns green on verified strum, locks out ringing.
4. **Debug & Diagnostic Overlay**:
   - Real-time visualization of 12 chroma bins.
   - Live RMS energy meter with onset threshold line.
   - Strum indicator (FLASH on strum attack).
   - Target chord vs heard chord confidence comparison.
   - Rolling inspection log with exact reasons (e.g. `ACCEPTED (score 0.74 >= 0.65)`, `REJECTED: Heard G (0.71), expected C (0.34)`).
5. **In-App Recorder & Synthetic Audio Test Suite**:
   - Built-in Karplus-Strong physical guitar modeling to test strum attacks, sustained ringing, shared tones, and noise.
   - In-app audio recorder using `MediaRecorder` / Web Audio buffer to record user's guitar and replay through detector.
