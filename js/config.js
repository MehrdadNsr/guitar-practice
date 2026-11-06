/*
 * config.js
 * Public, client-side configuration for the Voice mode page.
 *
 * SUPABASE_PUBLISHABLE_KEY: paste the project's *publishable* (anon) key from
 * Supabase Dashboard -> Project Settings -> API Keys. It is safe to ship in a
 * static page: the voice_live table only allows INSERT for anon, no SELECT.
 * Never put a secret / service-role key here.
 */
const SUPABASE_URL = 'https://qljpeyeeppnqlsrtexky.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'PASTE_HERE';
const SUPABASE_VOICE_TABLE = 'voice_live';

(function (global) {
  (global.GP = global.GP || {}).Config = { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_VOICE_TABLE };
})(typeof window !== 'undefined' ? window : globalThis);
