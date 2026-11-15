// Since — single-page chat UI. No build step, no dependencies.

const EXAMPLES = [
  {
    tag: 'compare',
    prompt:
      'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
  },
  {
    tag: 'recall',
    prompt: 'What did I ask you on 3 November? Is your answer still correct today?',
  },
  {
    tag: 'recheck',
    prompt: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
  },
];

const $ = (id) => document.getElementById(id);

const landing = $('landing');
const examples = $('examples');
const demoBadge = $('demo-badge');
const demoNote = $('demo-note');
const loadDemoBtn = $('load-demo');
const sessionsToggle = $('sessions-toggle');
const sessionsPanel = $('sessions-panel');
const sessionsList = $('sessions-list');
const sessionsEmpty = $('sessions-empty');
const sessionsError = $('sessions-error');
const newChatBtn = $('new-chat');
const messages = $('messages');
const composer = $('composer');
const messageEl = $('message');
const sendBtn = $('send');

const state = {
  sessionId: null,
  sessionSynthetic: false,
  running: false,
  sessions: [],
};

let nextUid = 1;
let scrollQueued = false;

// ---------- small helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pick(object, ...keys) {
  if (!object) return undefined;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function humanize(value) {
  return String(value).replace(/_/g, ' ');
}

function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function formatDate(value) {
  if (!value) return '';
  const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function friendly(message) {
  if (/failed to fetch|networkerror|load failed/i.test(message)) return 'Could not reach the server.';
  return message || 'Something went wrong.';
}

function sourceAnchor(uid, id) {
  const safe = String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'source';
  return `src-${uid}-${safe}`;
}

function fmtValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(fmtValue).join(', ');
  if (typeof value === 'object') {
    if (value.kind === 'price' && typeof value.amount === 'number') {
      const bits = [`${value.currency ?? ''} ${value.amount}`.trim()];
      if (value.period) bits.push(value.period === 'one_time' ? 'one-time' : `per ${value.period}`);
      if (value.mode && value.mode !== 'flat') bits.push(humanize(value.mode));
      if (value.plan) bits.push(value.plan);
      if (value.unit) bits.push(value.unit);
      return bits.join(' · ');
    }
    return Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined && entry !== '')
      .map(([key, entry]) => `${humanize(key)}: ${fmtValue(entry)}`)
      .join(' · ');
  }
  return String(value);
}

// Escapes first; only the literal tags generated below are ever inserted.
function inlineMarkdown(text, ctx) {
  const codeSpans = [];
  let html = escapeHtml(text);

  html = html.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[(e\d+)\]/gi, (_, rawId) => {
    const id = rawId.toLowerCase();
    const known = ctx.sources.some((source) => String(source.id).toLowerCase() === id);
    const href = known ? sourceAnchor(ctx.uid, id) : `sources-${ctx.uid}`;
    return `<sup><a class="cite" href="#${href}" title="Source ${id}" aria-label="Source ${id}">${id}</a></sup>`;
  });
  html = html.replace(/\[(m\d+)\]/gi, (_, rawId) => {
    const id = rawId.toLowerCase();
    return `<sup><span class="cite cite-memory" title="Remembered episode" aria-label="Remembered episode">${id}</span></sup>`;
  });
  html = html.replace(/\u0000(\d+)\u0000/g, (_, index) => codeSpans[Number(index)]);
  return html;
}

function parseBlocks(text) {
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'p', text: paragraph.join(' ') });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: 'ul', items: list });
      list = null;
    }
  };

  for (const rawLine of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list) list = [];
      list.push(bullet[1]);
    } else if (!line.trim()) {
      flushList();
      flushParagraph();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushList();
  flushParagraph();
  return blocks;
}

function renderMarkdownInto(target, text, ctx) {
  target.replaceChildren();
  for (const block of parseBlocks(text)) {
    if (block.type === 'p') {
      const p = document.createElement('p');
      p.innerHTML = inlineMarkdown(block.text, ctx);
      target.append(p);
    } else {
      const ul = document.createElement('ul');
      for (const item of block.items) {
        const li = document.createElement('li');
        li.innerHTML = inlineMarkdown(item, ctx);
        ul.append(li);
      }
      target.append(ul);
    }
  }
}

// ---------- scrolling ----------

function nearBottom() {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 140;
}

function scrollToBottom(force) {
  if (force || nearBottom()) {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }
}

function scrollIfNearBottom() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    scrollToBottom(false);
  });
}

// ---------- message DOM ----------

function buildTrace() {
  const details = document.createElement('details');
  details.className = 'trace';
  const summary = document.createElement('summary');
  summary.append(document.createTextNode('Trace'), el('span', 'sr-only', ' for this answer'));
  details.append(summary);
  const body = el('div', 'trace-body');
  const status = el('p', 'muted', 'Available when this turn finishes.');
  body.append(status);
  details.append(body);
  details._body = body;
  details._status = status;
  details.addEventListener('toggle', () => {
    if (details.open) void loadTrace(details);
  });
  return details;
}

async function loadTrace(details) {
  const turnId = details.dataset.turnId;
  if (!turnId || details.dataset.loaded === '1' || details.dataset.loading === '1') return;
  details.dataset.loading = '1';
  if (details._status) details._status.textContent = 'Loading trace…';
  try {
    const data = await getJson(`/api/trace/${encodeURIComponent(turnId)}`);
    details.dataset.loaded = '1';
    if (details._status) details._status.remove();
    renderTrace(details._body, data.trace);
  } catch {
    if (details._status) details._status.textContent = 'Trace unavailable.';
  } finally {
    details.dataset.loading = '0';
  }
}

function enableTrace(details, turnId) {
  details.dataset.turnId = turnId;
  if (details._status) details._status.textContent = 'Node timings load when you open this.';
  if (details.open) void loadTrace(details);
}

function renderTrace(container, trace) {
  container.replaceChildren();
  if (!Array.isArray(trace) || trace.length === 0) {
    container.append(el('p', 'muted', 'No trace recorded.'));
    return;
  }
  const list = document.createElement('ol');
  list.className = 'trace-list';
  for (const item of trace) {
    const li = document.createElement('li');
    li.append(el('span', 'trace-node', String(item.node ?? 'node')));
    if (typeof item.ms === 'number') li.append(el('span', 'trace-ms', `${Math.round(item.ms)} ms`));
    if (item.detail) li.append(el('p', 'trace-detail', String(item.detail)));
    if (item.at) li.append(el('span', 'trace-at', formatDateTime(item.at)));
    list.append(li);
  }
  container.append(list);
}

function appendMessage(role) {
  const li = el('li', `msg ${role}`);
  const bubble = el('div', 'bubble');
  const meta = el('div', 'msg-meta');
  meta.append(el('span', 'who', role === 'user' ? 'You' : 'Since'));
  if (state.sessionSynthetic) {
    meta.append(el('span', 'badge badge-demo', 'Demo history (synthetic)'));
  }
  bubble.append(meta);

  const parts = {
    li,
    bubble,
    role,
    text: '',
    sources: [],
    turnId: null,
    streaming: false,
    failed: false,
  };

  if (role === 'user') {
    parts.body = el('div', 'body');
    bubble.append(parts.body);
  } else {
    parts.uid = `m${nextUid++}`;
    parts.chip = el('div', 'status-chip', 'thinking');
    parts.diffSlot = el('div', 'diff-slot');
    parts.body = el('div', 'body');
    parts.body.setAttribute('aria-live', 'polite');
    parts.body.setAttribute('aria-atomic', 'false');
    parts.note = el('p', 'correction-note');
    parts.note.hidden = true;
    parts.sourcesSlot = el('div', 'sources-slot');
    parts.errorSlot = el('div', 'error-slot');
    parts.verify = el('span', 'badge badge-verify');
    parts.verify.hidden = true;
    parts.footer = el('span', 'answer-footer');
    const answerMeta = el('div', 'answer-meta');
    answerMeta.append(parts.verify, parts.footer);
    parts.trace = buildTrace();

    bubble.append(
      parts.chip,
      parts.diffSlot,
      parts.body,
      parts.note,
      parts.errorSlot,
      parts.sourcesSlot,
      answerMeta,
      parts.trace,
    );
    parts.streaming = true;
  }

  li.append(bubble);
  messages.append(li);
  landing.hidden = true;
  scrollToBottom(true);
  return { li, parts };
}

function messageCtx(parts) {
  return { uid: parts.uid, sources: parts.sources };
}

function finalizeAssistant(parts) {
  parts.streaming = false;
  parts.chip.hidden = true;
  parts.body.removeAttribute('aria-live');
  parts.body.removeAttribute('aria-atomic');
  if (parts.text) {
    renderMarkdownInto(parts.body, parts.text, messageCtx(parts));
  } else if (!parts.body.childNodes.length && !parts.failed) {
    parts.body.append(el('p', 'muted', 'No answer text was returned.'));
  }
}

// ---------- stream events ----------

function handleStreamEvent(parts, event) {
  if (!event || typeof event !== 'object') return true;

  switch (event.type) {
    case 'status': {
      const stage = typeof event.stage === 'string' && event.stage ? event.stage : 'working';
      parts.chip.hidden = false;
      parts.chip.textContent = typeof event.detail === 'string' && event.detail ? `${stage} · ${event.detail}` : stage;
      break;
    }
    case 'token': {
      const text = typeof event.text === 'string' ? event.text : '';
      if (text) {
        parts.text += text;
        parts.body.append(document.createTextNode(text));
        scrollIfNearBottom();
      }
      break;
    }
    case 'diff':
      renderDiff(parts, event.rows);
      break;
    case 'sources':
      renderSources(parts, event.sources);
      break;
    case 'verification': {
      const verified = Number(event.verified) || 0;
      const unverified = Number(event.unverified) || 0;
      parts.verify.hidden = false;
      parts.verify.textContent = `${verified} verified · ${unverified} unverified`;
      break;
    }
    case 'patch':
      applyPatch(parts, event.text);
      break;
    case 'error':
      failTurn(parts, typeof event.message === 'string' ? event.message : 'The turn failed.');
      return false;
    default:
      break;
  }
  return true;
}

function failTurn(parts, message) {
  if (parts.failed) return;
  parts.failed = true;
  finalizeAssistant(parts);
  const bubble = el('p', 'error-bubble', message || 'Something went wrong.');
  bubble.setAttribute('role', 'alert');
  parts.errorSlot.replaceChildren(bubble);
  parts.footer.textContent = '';
  parts.trace.hidden = true;
  setRunning(false);
}

function applyPatch(parts, text) {
  if (typeof text !== 'string') return;
  parts.text = text;
  if (parts.streaming) {
    parts.body.textContent = text;
  } else {
    renderMarkdownInto(parts.body, parts.text, messageCtx(parts));
  }
  parts.note.hidden = false;
  parts.note.textContent = 'Corrected after checking the sources.';
  scrollIfNearBottom();
}

function diffValueCell(value, date, unverifiedBaseline) {
  const td = document.createElement('td');
  td.append(el('span', 'diff-value', fmtValue(value)));
  if (unverifiedBaseline) td.append(el('span', 'warn-inline', 'unverified baseline'));
  const formatted = formatDate(date);
  if (formatted) td.append(el('span', 'diff-date', formatted));
  return td;
}

function renderDiff(parts, rows) {
  const list = Array.isArray(rows) ? rows : [];
  parts.diffSlot.replaceChildren();
  if (!list.length) return;

  const card = el('section', 'diff-card');
  card.setAttribute('aria-label', 'Comparison table');
  card.append(el('h3', 'diff-title', 'Then vs now'));

  const scroller = el('div', 'diff-scroll');
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'region');
  scroller.setAttribute('aria-label', 'Comparison table, scrollable');
  const table = document.createElement('table');
  table.append(el('caption', 'sr-only', 'Comparison of earlier and current values'));

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Entity', 'Then', 'Now', 'Verdict', 'Source']) {
    const th = el('th', '', label);
    th.scope = 'col';
    headRow.append(th);
  }
  head.append(headRow);

  const body = document.createElement('tbody');
  for (const row of list) {
    const verdict = ['changed', 'unchanged', 'unclear'].includes(row.verdict) ? row.verdict : 'unclear';
    const tr = document.createElement('tr');
    tr.className = `diff-row diff-${verdict}`;

    const entityCell = document.createElement('td');
    entityCell.append(el('span', 'diff-entity', String(row.entity ?? '—')));
    if (row.attribute) entityCell.append(el('span', 'diff-attr', humanize(row.attribute)));
    tr.append(entityCell);

    tr.append(diffValueCell(row.before, row.beforeDate, row.baselineVerified === false));
    tr.append(diffValueCell(row.after, row.afterDate, false));

    const verdictCell = document.createElement('td');
    verdictCell.append(el('span', `pill pill-${verdict}`, verdict));
    const reasons = Array.isArray(row.reasons)
      ? row.reasons.filter((reason) => reason !== 'baseline_unverified')
      : [];
    if (reasons.length) {
      verdictCell.append(el('span', 'diff-reasons', reasons.map((reason) => humanize(reason)).join(' · ')));
    }
    tr.append(verdictCell);

    const sourceCell = document.createElement('td');
    sourceCell.className = 'diff-sources';
    const ids = Array.isArray(row.sourceIds) ? row.sourceIds : [];
    if (!ids.length) sourceCell.append(el('span', 'muted', '—'));
    for (const id of ids) {
      const known = parts.sources.some((source) => String(source.id) === String(id));
      const link = document.createElement('a');
      link.className = 'cite';
      link.textContent = `[${String(id)}]`;
      link.setAttribute('aria-label', `Source ${String(id)}`);
      link.href = `#${known ? sourceAnchor(parts.uid, id) : `sources-${parts.uid}`}`;
      sourceCell.append(link);
    }
    tr.append(sourceCell);

    body.append(tr);
  }

  table.append(head, body);
  scroller.append(table);
  card.append(scroller);
  parts.diffSlot.append(card);
}

function renderSources(parts, sources) {
  const list = Array.isArray(sources) ? sources : [];
  parts.sources = list;

  const slot = parts.sourcesSlot;
  slot.replaceChildren();

  const details = document.createElement('details');
  details.className = 'sources';
  details.id = `sources-${parts.uid}`;
  details.append(el('summary', '', `Sources (${list.length})`));

  if (!list.length) {
    details.append(el('p', 'muted source-empty', 'No sources for this answer.'));
  } else {
    const ol = document.createElement('ol');
    ol.className = 'source-list';
    for (const source of list) {
      const li = document.createElement('li');
      li.id = sourceAnchor(parts.uid, source.id);
      li.append(el('span', 'source-id', `[${String(source.id ?? '')}]`));

      const anchor = document.createElement('a');
      const url = safeUrl(source.url);
      anchor.textContent =
        typeof source.title === 'string' && source.title
          ? source.title
          : source.domain || url || 'Untitled source';
      if (url) {
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
      }
      li.append(anchor);

      const metaBits = [];
      if (source.domain) metaBits.push(String(source.domain));
      const date = formatDate(source.publishedAt);
      if (date) metaBits.push(date);
      li.append(el('span', 'source-meta', metaBits.join(' · ')));
      ol.append(li);
    }
    details.append(ol);
  }

  slot.append(details);
  if (parts.text && !parts.streaming) {
    renderMarkdownInto(parts.body, parts.text, messageCtx(parts));
  }
}

// ---------- sessions ----------

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      if (typeof body.error === 'string') detail = body.error;
      else if (typeof body.message === 'string') detail = body.message;
    } catch {
      // Non-JSON error body; the status is enough.
    }
    throw new Error(`Request failed (${response.status})${detail ? `: ${detail}` : ''}.`);
  }
  return response.json();
}

function updateDemoBadge() {
  demoBadge.hidden = !state.sessionSynthetic;
}

function renderSessionList() {
  sessionsList.replaceChildren();
  const hasSessions = state.sessions.length > 0;
  sessionsEmpty.hidden = hasSessions;
  if (!hasSessions) {
    sessionsEmpty.textContent = 'No sessions yet. Start a chat or load the demo history.';
    return;
  }

  for (const session of state.sessions) {
    const li = document.createElement('li');
    const button = el('button', 'session-item');
    button.type = 'button';
    button.append(el('span', 'session-title', session.title || 'Untitled session'));

    const metaBits = [];
    const created = formatDate(pick(session, 'createdAt', 'created_at'));
    if (created) metaBits.push(created);
    if (pick(session, 'isSynthetic', 'is_synthetic')) metaBits.push('synthetic');
    button.append(el('span', 'session-meta', metaBits.join(' · ')));

    if (session.id === state.sessionId) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => {
      void openSession(session.id);
    });
    li.append(button);
    sessionsList.append(li);
  }
}

async function loadSessions() {
  const data = await getJson('/api/sessions');
  state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  sessionsError.hidden = true;
  renderSessionList();
  return state.sessions;
}

async function refreshSessionList() {
  sessionsError.hidden = true;
  sessionsEmpty.hidden = false;
  sessionsEmpty.textContent = 'Loading sessions…';
  try {
    await loadSessions();
  } catch {
    sessionsEmpty.hidden = true;
    sessionsError.hidden = false;
    sessionsError.textContent = 'Could not load sessions.';
  }
}

function setSessionsOpen(open) {
  sessionsPanel.hidden = !open;
  sessionsToggle.setAttribute('aria-expanded', String(open));
}

function openSessionsPanel() {
  setSessionsOpen(true);
  void refreshSessionList();
}

function addTurn(turn) {
  const role = turn.role === 'user' ? 'user' : 'assistant';
  const text = typeof turn.text === 'string' ? turn.text : '';
  const { parts } = appendMessage(role);
  parts.text = text;

  if (role === 'user') {
    parts.body.textContent = text;
    return;
  }

  parts.streaming = false;
  finalizeAssistant(parts);
  const created = pick(turn, 'createdAt', 'created_at');
  if (created) parts.footer.textContent = formatDateTime(created);
  if (turn.id) enableTrace(parts.trace, turn.id);
}

function clearMessages() {
  messages.replaceChildren();
}

async function openSession(id) {
  if (state.running) return;
  sessionsError.hidden = true;
  sessionsError.textContent = '';
  try {
    const data = await getJson(`/api/sessions/${encodeURIComponent(id)}`);
    const session = data.session ?? {};
    state.sessionId = session.id ?? id;
    state.sessionSynthetic = Boolean(pick(session, 'isSynthetic', 'is_synthetic'));

    const turns = (Array.isArray(data.turns) ? data.turns : []).slice().sort((a, b) => {
      const left = String(pick(a, 'createdAt', 'created_at') ?? '');
      const right = String(pick(b, 'createdAt', 'created_at') ?? '');
      return left.localeCompare(right);
    });
    const episodes = Array.isArray(data.episodes) ? data.episodes : [];
    if (!state.sessionSynthetic) {
      state.sessionSynthetic = episodes.some((episode) => pick(episode, 'isSynthetic', 'is_synthetic'));
    }

    clearMessages();
    for (const turn of turns) addTurn(turn);
    landing.hidden = turns.length > 0;
    updateDemoBadge();
    setSessionsOpen(false);
    renderSessionList();
    messageEl.focus();
  } catch (error) {
    showThreadError(`Could not load that session: ${friendly(messageOf(error))}`);
  }
}

function showThreadError(text) {
  const { parts } = appendMessage('assistant');
  parts.failed = true;
  finalizeAssistant(parts);
  const bubble = el('p', 'error-bubble', text);
  bubble.setAttribute('role', 'alert');
  parts.errorSlot.replaceChildren(bubble);
  parts.trace.hidden = true;
}

function newChat() {
  if (state.running) return;
  state.sessionId = null;
  state.sessionSynthetic = false;
  clearMessages();
  updateDemoBadge();
  landing.hidden = false;
  demoNote.hidden = true;
  setSessionsOpen(false);
  renderSessionList();
  messageEl.focus();
}

async function discoverSession(explicitId, parts) {
  if (typeof explicitId === 'string' && explicitId) {
    state.sessionId = explicitId;
    return;
  }
  try {
    const sessions = await loadSessions();
    const newest = sessions[0];
    if (newest && newest.id) {
      state.sessionId = newest.id;
      state.sessionSynthetic = Boolean(pick(newest, 'isSynthetic', 'is_synthetic'));
      updateDemoBadge();
      renderSessionList();
    }
  } catch {
    parts.footer.textContent += ' · session not linked';
  }
}

async function loadDemo() {
  if (state.running) return;
  loadDemoBtn.disabled = true;
  demoNote.hidden = false;
  demoNote.textContent = 'Loading demo history…';
  try {
    const demoResponse = await fetch('/api/demo', { method: 'POST' });
    if (!demoResponse.ok) throw new Error(`Request failed (${demoResponse.status}).`);
    const sessions = await loadSessions();
    const demo = sessions.find((session) => pick(session, 'isSynthetic', 'is_synthetic'));
    if (!demo) throw new Error('No demo session was returned.');
    demoNote.hidden = true;
    await openSession(demo.id);
  } catch (error) {
    demoNote.textContent = `Could not load demo history: ${friendly(messageOf(error))}`;
  } finally {
    loadDemoBtn.disabled = false;
  }
}

// ---------- sending ----------

function setRunning(running) {
  state.running = running;
  composer.setAttribute('aria-busy', String(running));
  messageEl.disabled = running;
  sendBtn.disabled = running;
  newChatBtn.disabled = running;
  sessionsToggle.disabled = running;
  if (!running) messageEl.focus();
}

async function readStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopped = false;

  const consume = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error('The server sent a malformed stream event.');
    }
    if (onEvent(event) === false) stopped = true;
  };

  try {
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1 && !stopped) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consume(line);
        newline = buffer.indexOf('\n');
      }
    }
    if (!stopped) {
      buffer += decoder.decode();
      consume(buffer);
    }
  } catch (error) {
    stopped = true;
    throw error;
  } finally {
    if (stopped) await reader.cancel().catch(() => {});
  }
}

async function finishTurn(parts, event) {
  parts.turnId = typeof event.turnId === 'string' ? event.turnId : null;
  finalizeAssistant(parts);
  const count = parts.sources.length;
  parts.footer.textContent = `${count} source${count === 1 ? '' : 's'} · checked ${formatDateTime(new Date())}`;
  if (parts.turnId) enableTrace(parts.trace, parts.turnId);
  if (!state.sessionId) await discoverSession(event.sessionId, parts);
  setRunning(false);
  if (!sessionsPanel.hidden) void refreshSessionList();
}

async function send(text) {
  if (state.running) return;
  const messageText = (text ?? messageEl.value).trim();
  if (!messageText) return;

  if (text === undefined) messageEl.value = '';
  const { parts: userParts } = appendMessage('user');
  userParts.body.textContent = messageText;
  const { parts } = appendMessage('assistant');
  setRunning(true);

  let doneEvent = null;
  try {
    const payload = { message: messageText };
    if (state.sessionId) payload.sessionId = state.sessionId;

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        if (body && typeof body.error === 'string') detail = ` ${body.error}`;
        else if (body && typeof body.message === 'string') detail = ` ${body.message}`;
      } catch {
        // Non-JSON error body; the status is enough.
      }
      throw new Error(`Server returned ${response.status}.${detail}`.trim());
    }
    if (!response.body) throw new Error('Streaming is not supported by this browser.');

    await readStream(response.body, (event) => {
      if (event.type === 'done') {
        doneEvent = event;
        return true;
      }
      return handleStreamEvent(parts, event);
    });

    if (parts.failed) return;
    if (doneEvent) {
      await finishTurn(parts, doneEvent);
    } else {
      finalizeAssistant(parts);
      parts.footer.textContent = 'Stream ended before the turn finished.';
      setRunning(false);
    }
  } catch (error) {
    failTurn(parts, friendly(messageOf(error)));
  } finally {
    if (state.running) setRunning(false);
  }
}

// ---------- wiring ----------

for (const example of EXAMPLES) {
  const button = el('button', 'example');
  button.type = 'button';
  button.setAttribute('aria-label', example.prompt);
  button.append(
    el('span', 'example-tag', example.tag),
    el('span', 'example-text', example.prompt),
  );
  button.addEventListener('click', () => {
    void send(example.prompt);
  });
  examples.append(button);
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  void send();
});

messageEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  composer.requestSubmit();
});

// A citation lands inside a collapsed sources list; open it before jumping.
messages.addEventListener('click', (event) => {
  const link = event.target.closest('a.cite');
  if (!link) return;
  const id = link.getAttribute('href')?.slice(1);
  const target = id ? document.getElementById(id) : null;
  const details = target?.closest('details.sources');
  if (details) details.open = true;
});

newChatBtn.addEventListener('click', newChat);
loadDemoBtn.addEventListener('click', () => {
  void loadDemo();
});

sessionsToggle.addEventListener('click', () => {
  if (sessionsPanel.hidden) {
    openSessionsPanel();
  } else {
    setSessionsOpen(false);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !sessionsPanel.hidden) {
    setSessionsOpen(false);
    sessionsToggle.focus();
  }
});

updateDemoBadge();
