import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning');

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const api = require('../server/api.js');
const lectures = require('../server/lectures.js');

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-poll-names-test-'));
  const db = store.open(dir);
  try {
    return fn(db, dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('system_settings store and migrations', () => {
  withTempDb((db) => {
    assert.equal(store.getSystemSetting(db, 'allow_poll_names', '0'), '0');
    store.setSystemSetting(db, 'allow_poll_names', '1');
    assert.equal(store.getSystemSetting(db, 'allow_poll_names'), '1');
    store.setSystemSetting(db, 'allow_poll_names', '0');
    assert.equal(store.getSystemSetting(db, 'allow_poll_names'), '0');
  });
});

test('system settings API access control and capabilities', async () => {
  await withTempDb(async (db) => {
    await accounts.createUser(db, { username: 'prof', password: 'password123', isAdmin: true });
    await accounts.createUser(db, { username: 'student', password: 'password123', isAdmin: false });

    const adminLogin = await accounts.login(db, 'prof', 'password123');
    const studentLogin = await accounts.login(db, 'student', 'password123');

    const ctx = {
      db,
      hasAccounts: () => true,
    };

    // Initially disabled
    let resCode = 0;
    let resBody = null;
    let mockRes = {
      writeHead(code) { resCode = code; },
      setHeader() {},
      end(data) { try { resBody = JSON.parse(data); } catch { resBody = data; } },
    };

    let getCapReq = {
      method: 'GET',
      headers: { cookie: `podium_session=${studentLogin.token}` },
      on() {},
    };
    await api.handleApi(getCapReq, mockRes, new URL('http://x/api/capabilities'), ctx);
    assert.equal(resCode, 200);
    assert.equal(resBody.allowPollNames, false);

    // Student cannot update system settings
    const studentReq = {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `podium_session=${studentLogin.token}`,
      },
      on(evt, cb) {
        if (evt === 'data') cb(Buffer.from(JSON.stringify({ allowPollNames: true })));
        if (evt === 'end') cb();
      },
    };

    mockRes = {
      writeHead(code) { resCode = code; },
      setHeader() {},
      end(data) { try { resBody = JSON.parse(data); } catch { resBody = data; } },
    };

    await api.handleApi(studentReq, mockRes, new URL('http://x/api/system/settings'), ctx);
    assert.equal(resCode, 403);

    // Admin can update system settings
    const adminReq = {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `podium_session=${adminLogin.token}`,
      },
      on(evt, cb) {
        if (evt === 'data') cb(Buffer.from(JSON.stringify({ allowPollNames: true })));
        if (evt === 'end') cb();
      },
    };

    mockRes = {
      writeHead(code) { resCode = code; },
      setHeader() {},
      end(data) { try { resBody = JSON.parse(data); } catch { resBody = data; } },
    };

    await api.handleApi(adminReq, mockRes, new URL('http://x/api/system/settings'), ctx);
    assert.equal(resCode, 200);
    assert.equal(resBody.allowPollNames, true);

    // Capabilities now reflects allowPollNames = true
    mockRes = {
      writeHead(code) { resCode = code; },
      setHeader() {},
      end(data) { try { resBody = JSON.parse(data); } catch { resBody = data; } },
    };
    await api.handleApi(getCapReq, mockRes, new URL('http://x/api/capabilities'), ctx);
    assert.equal(resCode, 200);
    assert.equal(resBody.allowPollNames, true);

    // Audit log recorded
    const logs = db.prepare('SELECT * FROM audit_logs WHERE action = ?').all('system_settings_updated');
    assert.equal(logs.length, 1);
    assert.match(logs[0].details, /"allowPollNames":true/);
  });
});

test('the ZIP import upload limit is an admin system setting (Issue #106)', async () => {
  await withTempDb(async (db) => {
    await accounts.createUser(db, { username: 'prof', password: 'password123', isAdmin: true });
    await accounts.createUser(db, { username: 'student', password: 'password123', isAdmin: false });
    const admin = await accounts.login(db, 'prof', 'password123');
    const student = await accounts.login(db, 'student', 'password123');
    const ctx = { db, hasAccounts: () => true };

    const call = async (method, token, body) => {
      let code = 0;
      let out = null;
      const req = {
        method,
        headers: { 'content-type': 'application/json', cookie: `podium_session=${token}` },
        on(evt, cb) {
          if (evt === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
          if (evt === 'end') cb();
        },
      };
      const res = {
        writeHead(c) { code = c; },
        setHeader() {},
        end(data) { try { out = JSON.parse(data); } catch { out = data; } },
      };
      await api.handleApi(req, res, new URL('http://x/api/system/settings'), ctx);
      return { code, body: out };
    };

    let r = await call('GET', admin.token);
    assert.equal(r.body.maxZipUploadMb, 200, 'defaults to 200 MB');

    r = await call('PUT', student.token, { maxZipUploadMb: 500 });
    assert.equal(r.code, 403, 'only an administrator can change it');

    r = await call('PUT', admin.token, { maxZipUploadMb: 500 });
    assert.equal(r.code, 200);
    assert.equal(r.body.maxZipUploadMb, 500, 'an administrator can raise it');
    assert.equal(r.body.allowPollNames, false, 'without touching the other setting');

    for (const bad of [0, -5, 2.5, 'lots', 99999]) {
      r = await call('PUT', admin.token, { maxZipUploadMb: bad });
      assert.equal(r.code, 400, `refuses ${JSON.stringify(bad)}`);
    }
    r = await call('GET', student.token);
    assert.equal(r.body.maxZipUploadMb, 500, 'a refused value leaves the saved one in place');

    const logs = db.prepare('SELECT * FROM audit_logs WHERE action = ?').all('system_settings_updated');
    assert.equal(logs.length, 1, 'the one real change is audit-logged');
    assert.match(logs[0].details, /"maxZipUploadMb":500/);
    assert.doesNotMatch(logs[0].details, /allowPollNames/, 'and the log names only what changed');
  });
});

test('lecture poll recording stores responses with names', async () => {
  await withTempDb(async (db, dir) => {
    const user = await accounts.createUser(db, { username: 'lecturer', password: 'password123', isAdmin: false });
    const lecture = lectures.startLecture(db, user, { room: '101', title: 'Test Lecture', dataDir: dir });

    const poll = {
      pollId: 'ABCD',
      kind: 'choice',
      question: 'Favorite programming language?',
      options: ['JavaScript', 'Python', 'Rust'],
      counts: [1, 1, 0],
      voters: 2,
      askName: true,
      namePrompt: 'Student ID:',
      responses: [
        { voter: 'v1', answer: 0, name: 'S1001' },
        { voter: 'v2', answer: 1, name: 'S1002' },
      ],
      endedAt: Date.now(),
    };

    lectures.recordPoll(db, user, lecture.id, poll);

    const detail = lectures.getLecture(db, user, lecture.id);
    assert.equal(detail.pollResults.length, 1);
    const recorded = detail.pollResults[0];
    assert.equal(recorded.pollId, 'ABCD');
    assert.equal(recorded.askName, true);
    assert.equal(recorded.namePrompt, 'Student ID:');
    assert.equal(recorded.responses.length, 2);
    assert.equal(recorded.responses[0].name, 'S1001');
    assert.equal(recorded.responses[0].answer, 0);
    assert.equal(recorded.responses[1].name, 'S1002');
    assert.equal(recorded.responses[1].answer, 1);
  });
});

test('pollResultRows and pollCsvRows include participant names', () => {
  function pollCsvRows(poll) {
    const rows = [['question', poll.question]];
    const nameLabel = poll.namePrompt || 'Name';
    const hasNamedResponses = Array.isArray(poll.responses) && poll.responses.some((r) => r.name);

    if (poll.kind === 'text') {
      const hidden = new Set(poll.hiddenAnswers || []);
      if (hasNamedResponses) {
        rows.push([nameLabel, 'answer', 'shown to room']);
        poll.responses.forEach((resp, i) => {
          rows.push([resp.name || '(Anonymous)', resp.answer, hidden.has(i) ? 'no' : 'yes']);
        });
      } else {
        rows.push(['answer', 'shown to room']);
        (poll.answers || []).forEach((answer, i) => rows.push([answer, hidden.has(i) ? 'no' : 'yes']));
      }
    } else {
      rows.push(['option', 'votes']);
      (poll.options || []).forEach((option, i) => rows.push([option, String(poll.counts?.[i] || 0)]));
      if (hasNamedResponses) {
        rows.push([]);
        rows.push([nameLabel, 'choice', 'option']);
        poll.responses.forEach((resp) => {
          const optIdx = typeof resp.answer === 'number' ? resp.answer : -1;
          const optText = optIdx >= 0 && poll.options?.[optIdx] ? poll.options[optIdx] : String(resp.answer ?? '');
          const letter = optIdx >= 0 ? String.fromCharCode(65 + optIdx) : '';
          rows.push([resp.name || '(Anonymous)', letter, optText]);
        });
      }
    }
    return rows;
  }

  // 1. Choice poll with names
  const choicePoll = {
    kind: 'choice',
    question: 'Pick one',
    options: ['Option 1', 'Option 2'],
    counts: [1, 1],
    askName: true,
    namePrompt: 'Student ID',
    responses: [
      { voter: 'v1', answer: 0, name: 'S1001' },
      { voter: 'v2', answer: 1, name: 'S1002' },
    ],
  };
  const choiceCsv = pollCsvRows(choicePoll);
  assert.deepEqual(choiceCsv, [
    ['question', 'Pick one'],
    ['option', 'votes'],
    ['Option 1', '1'],
    ['Option 2', '1'],
    [],
    ['Student ID', 'choice', 'option'],
    ['S1001', 'A', 'Option 1'],
    ['S1002', 'B', 'Option 2'],
  ]);

  // 2. Text poll with names
  const textPoll = {
    kind: 'text',
    question: 'Describe bias',
    answers: ['Confirmation bias', 'Availability heuristic'],
    askName: true,
    namePrompt: 'Full Name',
    responses: [
      { voter: 'v1', answer: 'Confirmation bias', name: 'Alice' },
      { voter: 'v2', answer: 'Availability heuristic', name: 'Bob' },
    ],
  };
  const textCsv = pollCsvRows(textPoll);
  assert.deepEqual(textCsv, [
    ['question', 'Describe bias'],
    ['Full Name', 'answer', 'shown to room'],
    ['Alice', 'Confirmation bias', 'yes'],
    ['Bob', 'Availability heuristic', 'yes'],
  ]);
});

