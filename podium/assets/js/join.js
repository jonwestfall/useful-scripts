// The audience page.
//
// Deliberately the smallest thing in this repo, and deliberately not built on
// anything else in it: no bus, no crypto, no config, no shared stylesheet. A
// student's phone talks to two endpoints on the relay and nothing else - an
// event stream saying what is being asked, and a POST saying what they answered
// - so the code on the projector buys exactly the ability to answer a question,
// and nothing that touches the room itself.
//
// Same origin as the relay that serves this page, so the URLs are relative.
// (If the pages ever move to GitHub Pages while the relay stays elsewhere, the
// relay already sends CORS headers for these routes; this would then need a
// configurable base rather than a relative one.)

const $ = (sel) => document.querySelector(sel);

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const VOTER_KEY = 'podium.voter.v1';
const VOTER_NAME_KEY = 'podium.voterName.v1';

// Kept rather than regenerated, so a phone that reloads mid-question is still
// the same answer rather than a second one. localStorage rather than session:
// a phone that locks and wakes up is very much still the same student.
function voterId() {
  let id = null;
  try { id = localStorage.getItem(VOTER_KEY); } catch { /* private mode */ }
  if (!id) {
    id = `v${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    try { localStorage.setItem(VOTER_KEY, id); } catch { /* private mode: one per page load */ }
  }
  return id;
}

function getVoterName() {
  try { return localStorage.getItem(VOTER_NAME_KEY) || ''; } catch { return ''; }
}

function setVoterName(name) {
  try { if (name) localStorage.setItem(VOTER_NAME_KEY, name); } catch { /* private mode */ }
}

const voter = voterId();
let code = '';
let current = { seq: -1, open: false, kind: 'choice', question: '', options: [], askName: false, namePrompt: 'Name:' };
let answered = null;      // what this phone last sent for the current seq
let stream = null;

function say(text, tone = '') {
  const note = $('#note');
  note.textContent = text;
  note.className = `note ${tone}`;
}

async function send(answer) {
  if (!current.open) { say('This question is closed.', 'bad'); return; }
  say('Sending…');
  try {
    const nameInput = $('#voter-name');
    const name = current.askName && nameInput ? nameInput.value.trim() : '';
    if (name) setVoterName(name);

    const res = await fetch(`poll/${encodeURIComponent(code)}/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voter, answer, ...(name ? { name } : {}) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      say(body.error || 'That did not send. Try again.', 'bad');
      return;
    }
    answered = answer;
    render();
    say('Answer sent. You can change it until the question closes.', 'good');
  } catch {
    // A phone at the back of a lecture hall drops packets; saying so beats a
    // silent no-op, and the answer is still there to send again.
    say('No signal just then — tap again.', 'bad');
  }
}

function render() {
  $('#question').textContent = current.question || 'Waiting for the next question…';

  const nameBox = $('#voter-name-box');
  if (nameBox) {
    nameBox.hidden = !current.askName || !current.question;
    const nameLabel = $('#voter-name-label');
    if (nameLabel) nameLabel.textContent = current.namePrompt || 'Name:';
    const nameInput = $('#voter-name');
    if (nameInput && !nameInput.value) {
      nameInput.value = getVoterName();
    }
  }

  const asText = current.kind === 'text';
  const asQna = current.kind === 'qna';
  
  $('#typed').hidden = !asText || !current.question;
  $('#choices').hidden = (!asText && !asQna) ? false : true;
  $('#qna').hidden = !asQna || !current.question;

  if (current.kind === 'choice') {
    const choices = $('#choices');
    choices.replaceChildren(...current.options.map((option, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice';
      button.setAttribute('aria-pressed', String(answered === i));
      const letter = document.createElement('span');
      letter.className = 'letter';
      letter.textContent = LETTERS[i] || String(i + 1);
      const label = document.createElement('span');
      label.textContent = option;
      button.append(letter, label);
      button.disabled = !current.open;
      button.addEventListener('click', () => send(i));
      return button;
    }));
  } else if (asText) {
    $('#answer').disabled = !current.open;
    $('#send').disabled = !current.open;
  } else if (asQna) {
    $('#qna-ask').disabled = !current.open;
    $('#qna-send').disabled = !current.open;
    
    const feed = $('#qna-feed');
    const questions = (current.qnaFeed || [])
      .filter((q) => !q.hidden)
      .sort((a, b) => (b.upvotes?.length || 0) - (a.upvotes?.length || 0));
    
    feed.replaceChildren(...questions.map((q) => {
      const item = document.createElement('div');
      item.className = `qna-item${q.answered ? ' is-answered' : ''}`;
      
      const text = document.createElement('div');
      text.className = 'qna-item-text';
      text.textContent = q.text;
      
      const upvote = document.createElement('button');
      upvote.type = 'button';
      upvote.className = 'qna-item-upvote';
      const upvoted = (q.upvotes || []).includes(voter);
      upvote.setAttribute('aria-pressed', String(upvoted));
      upvote.disabled = !current.open;
      upvote.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 4l-8 8h16z"/></svg><span>${q.upvotes?.length || 0}</span>`;
      upvote.addEventListener('click', () => send({ action: 'upvote', id: q.id }));
      
      item.append(text, upvote);
      return item;
    }));
  }

  if (!current.question) say('');
  else if (!current.open) say((answered === null && !asQna) ? 'This question is closed.' : 'Closed — your answer is in.', '');
  
  if (!tickTimer) tickTimer = setInterval(tick, 1000);
  tick();
}

let tickTimer = null;
function tick() {
  const cd = document.getElementById('countdown');
  if (!cd) return;
  if (!current.closesAt || !current.open) {
    cd.hidden = true;
    return;
  }
  const remaining = Math.max(0, Math.ceil((current.closesAt - Date.now()) / 1000));
  cd.hidden = false;
  const m = Math.floor(remaining / 60);
  const s = String(remaining % 60).padStart(2, '0');
  cd.textContent = remaining >= 60 ? `${m}:${s}` : s;
  cd.style.color = remaining <= 10 ? '#ff9d9d' : 'var(--dim)';
  if (remaining === 0 && current.open) {
    current.open = false;
    render();
  }
}

let everConnected = false;

function backToCode(why) {
  stream?.close();
  stream = null;
  code = '';
  $('#live').hidden = true;
  $('#enter').hidden = false;
  $('#enter-note').textContent = why;
  history.replaceState(null, '', location.pathname);
}

function listen() {
  stream?.close();
  everConnected = false;
  stream = new EventSource(`poll/${encodeURIComponent(code)}/stream`);

  stream.addEventListener('open', () => {
    everConnected = true;
    if (!current.question) say('');
  });

  stream.addEventListener('message', (ev) => {
    let next;
    try { next = JSON.parse(ev.data); } catch { return; }
    // A new question is a clean slate for this phone: what it answered to the
    // last one says nothing about this one.
    if (next.seq !== current.seq) answered = null;
    current = next;
    render();
  });

  // Two different failures wear the same event. A code nobody is running gets
  // a 404, which EventSource treats as fatal (readyState CLOSED, no retry) -
  // so it means "that code is wrong", and the way out is the form again. A
  // connection that drops mid-lecture leaves it CONNECTING and retrying on
  // its own, which needs no help, only saying so.
  stream.addEventListener('error', () => {
    if (stream?.readyState !== EventSource.CLOSED) { say('Lost the signal — trying again…', 'bad'); return; }
    if (everConnected) say('The room closed this poll.', '');
    else backToCode('No question is running under that code. Check the screen?');
  });
}

function join(wanted) {
  const clean = String(wanted || '').trim().toUpperCase().slice(0, 8);
  if (!clean) return;
  code = clean;
  current = { seq: -1, open: false, kind: 'choice', question: '', options: [] };
  answered = null;
  $('#enter').hidden = true;
  $('#live').hidden = false;
  $('#enter-note').textContent = '';
  say('Joining…');
  history.replaceState(null, '', `?c=${encodeURIComponent(code)}`);
  listen();
}

$('#enter').addEventListener('submit', (ev) => {
  ev.preventDefault();
  join($('#code').value);
});
$('#send').addEventListener('click', () => {
  const text = $('#answer').value.trim();
  if (!text) { say('Type something first.', 'bad'); return; }
  send(text);
});
$('#qna-send').addEventListener('click', () => {
  const text = $('#qna-ask').value.trim();
  if (!text) { say('Type a question first.', 'bad'); return; }
  send({ action: 'ask', text });
  $('#qna-ask').value = '';
});

// Arriving by QR code skips the form entirely - which is the point of the QR.
const fromUrl = new URLSearchParams(location.search).get('c');
if (fromUrl) join(fromUrl);
else $('#code').focus();
