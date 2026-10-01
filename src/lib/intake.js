// Shared customer-intake helpers (docs/COMMAND_TDR.md §8): the one config
// call, where each kind of login lands, and small formatters.
import { useEffect, useState } from 'react';
import { api } from './api';

let cached = null;
let inflight = null;

// /api/intake/config, fetched once per page load. If the API cannot be
// reached the feature reads as switched off — no CTA points at a dead flow.
export function loadIntakeConfig() {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = api.intakeConfig()
      .then(c => { cached = c; return c; })
      .catch(() => { inflight = null; return { enabled: false, unavailable: true }; });
  }
  return inflight;
}

// null while loading, then the config.
export function useIntakeConfig() {
  const [config, setConfig] = useState(cached);
  useEffect(() => {
    if (cached) return undefined;
    let live = true;
    loadIntakeConfig().then(c => { if (live) setConfig(c); });
    return () => { live = false; };
  }, []);
  return config;
}

export const HOME_BY_ROLE = {
  admin: '/admin', analyst: '/command', reviewer: '/command', fulfillment: '/command/intake',
  player: '/me', staff: '/staff', customer: '/submissions',
};
export const INTERNAL_ROLES = ['admin', 'analyst', 'reviewer', 'fulfillment'];
// Logins that may submit footage: each resolves to one customer contact.
export const SUBMITTER_ROLES = ['customer', 'staff', 'player'];

// A post-sign-in destination from ?next=. Only same-site paths: never an
// absolute or protocol-relative URL (an open redirect).
export function safeNext(next) {
  const s = String(next || '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '';
}

export function homeFor(user) {
  return HOME_BY_ROLE[user?.role] || '/';
}

// "2026-09-20 18:04:11" (UTC from SQLite) → Date.
export function parseServerDate(value) {
  if (!value) return null;
  const s = String(value);
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}${s.length > 10 ? 'Z' : 'T00:00:00'}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDate(value) {
  if (!value) return '';
  // A bare game date is a calendar day, not a moment — never shift it by time zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [y, m, d] = String(value).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const d = parseServerDate(value);
  return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

export function fmtDateTime(value) {
  const d = parseServerDate(value);
  return d ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
}

export function timeAgo(value) {
  const d = parseServerDate(value);
  if (!d) return '';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(value);
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(v >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// Customer status keys (server customerStatus) → colour.
export const STATUS_TONE = {
  draft: '#94a3b8', received: '#38bdf8', processing: '#38bdf8', action_required: '#fbbf24',
  analysis: '#c4b5fd', metrics_ready: '#4ade80', complete: '#4ade80', closed: '#64748b', declined: '#f87171',
};

export const GAME_RECORD_LABEL = {
  not_started: 'Not started yet',
  in_progress: 'In progress',
  complete: 'Complete',
  not_ordered: 'Not part of this order',
};
