// Checks spike/cloud/supabase.sql against a real Postgres (issue #308):
// the link codes it computes match Podium's own (poll-link.js, view-link.js),
// the poll and Guest View code flows behave as the server's do, and the
// public role reaches the data only through the functions.
//
//   DATABASE_URL=postgres://user:pass@host/db node spike/cloud/check-sql.mjs
//
// Needs `psql` on the PATH and a database it may create roles and schemas in.
// It makes Supabase's two API roles (anon, authenticated) if they are missing.
// Not part of the CI suite: CI has no Postgres. Run by hand during the spike.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkCodeForKey, newPollKey } from '../../assets/js/poll-link.js';
import { viewCodeForKey } from '../../assets/js/view-link.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = process.env.DATABASE_URL;
if (!DB) { console.error('Set DATABASE_URL.'); process.exit(2); }

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

/** One psql run; rows as text, or { error } when it failed. */
function sql(text, { role = null } = {}) {
  const script = `${role ? `set role ${role};\n` : ''}${text}`;
  try {
    return execFileSync('psql', [DB, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return { error: String(err.stderr || err.message) };
  }
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const json = (out) => (typeof out === 'string' ? JSON.parse(out.split('\n').pop()) : out);

// Supabase has these two roles already; a plain Postgres does not.
sql(`do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
const apply = () => execFileSync('psql', [DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(HERE, 'supabase.sql')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try { apply(); apply(); ok('the script runs, and runs again over itself', true); } catch (err) { ok(`the script runs, and runs again over itself (${err.stderr})`, false); process.exit(1); }

// --- link codes ------------------------------------------------------------------
let same = 0;
const keys = Array.from({ length: 200 }, () => newPollKey());
const rows = sql(`select ${keys.map((k) => `public.podium_link_code('podium-poll-link', ${q(k)}) || ' ' || public.podium_link_code('podium-view-link', ${q(k)})`).join(' union all select ')}`)
  .split('\n');
keys.forEach((k, i) => { if (rows[i] === `${linkCodeForKey('podium-poll-link', k)} ${viewCodeForKey(k)}`) same += 1; });
ok(`Postgres works out the same poll and viewer link codes as Podium does (${same} of ${keys.length})`, same === keys.length);
ok('and none for something that is not a key', sql(`select public.podium_link_code('podium-poll-link', 'short')`) === '');

// --- the public role sees nothing but the functions ---------------------------------
ok('the public key cannot read the tables', !!sql('select * from podium_private.polls', { role: 'anon' }).error
  && !!sql('select * from podium_private.view_codes', { role: 'anon' }).error);
ok('nor call the private helpers', !!sql(`select podium_private.hash('x')`, { role: 'anon' }).error);

// --- a poll ----------------------------------------------------------------------
const opened = json(sql('select public.poll_open()', { role: 'anon' }));
ok(`a poll opens under a four-character code (${opened.code})`, /^[A-HJ-NP-Z2-9]{4}$/.test(opened.code) && opened.token.length >= 30);
const asked = json(sql(`select public.poll_ask(${q(opened.code)}, ${q(opened.token)}, '{"q":"2+2?","options":["3","4"]}')`, { role: 'anon' }));
ok('the presenter puts a question up', asked.seq === 1);
ok('a stranger cannot, without the token', !!sql(`select public.poll_ask(${q(opened.code)}, 'guess', 'hijacked')`, { role: 'anon' }).error);
const seen = json(sql(`select public.poll_view(${q(opened.code.toLowerCase())})`, { role: 'anon' }));
ok('a phone sees the question and nothing else, in any case', seen.open === true && seen.seq === 1 && seen.question.includes('2+2') && !('token' in seen));
sql(`select public.poll_vote(${q(opened.code)}, 1, 'phone-a', '0'::jsonb)`, { role: 'anon' });
sql(`select public.poll_vote(${q(opened.code)}, 1, 'phone-a', '1'::jsonb)`, { role: 'anon' });
sql(`select public.poll_vote(${q(opened.code)}, 1, 'phone-b', '1'::jsonb)`, { role: 'anon' });
const results = json(sql(`select public.poll_results(${q(opened.code)}, ${q(opened.token)})`, { role: 'anon' }));
ok(`one answer per phone, the last one counting (${JSON.stringify(results.answers)})`, results.answers.length === 2 && results.answers.every((a) => a.answer === 1));
ok('nobody else reads the answers', !!sql(`select public.poll_results(${q(opened.code)}, 'guess')`, { role: 'anon' }).error);
ok('an answer to an earlier question is refused', !!sql(`select public.poll_vote(${q(opened.code)}, 0, 'phone-c', '0'::jsonb)`, { role: 'anon' }).error);
sql(`select public.poll_close(${q(opened.code)}, ${q(opened.token)})`, { role: 'anon' });
ok('and once closed, so is every answer', !!sql(`select public.poll_vote(${q(opened.code)}, 1, 'phone-d', '0'::jsonb)`, { role: 'anon' }).error);

// --- a poll planned with a link ------------------------------------------------------
const pollKey = newPollKey();
const planned = json(sql(`select public.poll_open(${q(pollKey)})`, { role: 'anon' }));
ok('a planned poll opens under the code its link names', planned.code === linkCodeForKey('podium-poll-link', pollKey));
const again = json(sql(`select public.poll_open(${q(pollKey)})`, { role: 'anon' }));
ok('and opens there again next time, with a new token', again.code === planned.code && again.token !== planned.token);
ok('a key that is not one is refused', !!sql(`select public.poll_open('nope')`, { role: 'anon' }).error);

// --- Guest View codes ------------------------------------------------------------------
const LINK = 't=supabase&r=view.Abc123xyz9&p=viewkey&su=https%3A%2F%2Fx.supabase.co&sk=anon';
const typed = json(sql(`select public.view_code_register(${q(LINK)})`, { role: 'anon' }));
ok(`a display gets a six-character code (${typed.code})`, /^[A-HJ-NP-Z2-9]{6}$/.test(typed.code));
ok('which looks up to its viewer link', json(sql(`select public.view_code_lookup(${q(typed.code.toLowerCase())})`, { role: 'anon' })).link === LINK);
ok('and the same code comes back for the same display', json(sql(`select public.view_code_register(${q(LINK)}, ${q(typed.token)}, ${q(typed.code)})`, { role: 'anon' })).code === typed.code);
ok('but not for another display that asks for it', json(sql(`select public.view_code_register(${q(LINK)}, null, ${q(typed.code)})`, { role: 'anon' })).code !== typed.code);
ok('only a viewer link can be registered, never one that opens the real room', !!sql(`select public.view_code_register('t=ws&r=psy415&p=room-key')`, { role: 'anon' }).error);
const viewKey = newPollKey();
const waiting = json(sql(`select public.view_code_lookup(${q(viewCodeForKey(viewKey))})`, { role: 'anon' }));
ok('a planned viewer link opened before class is told to wait', waiting.waiting === true && !waiting.link);
const claimed = json(sql(`select public.view_code_register(${q(LINK)}, null, null, ${q(viewKey)})`, { role: 'anon' }));
ok('the display claims the planned code with its key', claimed.code === viewCodeForKey(viewKey));
ok('and the waiting phone finds the class', json(sql(`select public.view_code_lookup(${q(claimed.code)})`, { role: 'anon' })).link === LINK);
ok('stand-down releases it', sql(`select public.view_code_release(${q(claimed.code)}, ${q(claimed.token)})`, { role: 'anon' }) === 't'
  && json(sql(`select public.view_code_lookup(${q(claimed.code)})`, { role: 'anon' })).waiting === true);
ok('a code nobody holds just says so', !!json(sql(`select public.view_code_lookup('ZZZZZZ')`, { role: 'anon' })).error);

if (fails.length) { console.log(`\nSOME CHECKS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
