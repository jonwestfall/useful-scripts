-- Podium on Supabase: the spike's version of the audience API (issue #308).
--
-- What a VPS's podium-server.js answers in memory for polls and Guest View
-- codes, as Postgres functions a free Supabase project can run. Phones call
-- them through Supabase's REST API with the project's public (anon) key:
--
--   POST {project}/rest/v1/rpc/poll_view   {"p_code": "ABCD"}
--
-- The tables live in a schema the REST API does not expose, so the public
-- key reaches the data only through these functions - each one decides what
-- it may read or change, the way each server route does now.
--
-- Run it once in the project's SQL editor. Safe to run again.
--
-- Spike scope: choice and text polls, planned poll links, Guest View codes
-- and planned viewer links. Not yet: Q&A, word clouds' moderation, timers
-- that close a poll by themselves, attendance, per-IP lookup limits.

-- Supabase keeps extensions in their own schema; a plain Postgres may not have it.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists podium_private;

-- --- shared ------------------------------------------------------------------

-- The ten-character code a key gives under a label: the first 50 bits of
-- SHA-256(label || '\n' || key), five bits at a time, in the relay's alphabet
-- (no O/0, no I/1). Must match linkCodeForKey in assets/js/poll-link.js and
-- server/view-codes.js; spike/cloud/check-sql.mjs checks that it does.
create or replace function public.podium_link_code(p_label text, p_key text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bits bigint;
  out text := '';
begin
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{16,64}$' then return ''; end if;
  -- The digest's first 7 bytes as one 56-bit number; the code is its top 50.
  bits := ('x' || encode(substring(extensions.digest(convert_to(p_label || E'\n' || p_key, 'UTF8'), 'sha256') from 1 for 7), 'hex'))::bit(56)::bigint;
  for i in 0..9 loop
    out := out || substr(alphabet, ((bits >> (51 - 5 * i)) & 31)::int + 1, 1);
  end loop;
  return out;
end $$;

create or replace function podium_private.hash(p_text text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to(coalesce(p_text, ''), 'UTF8'), 'sha256'), 'hex')
$$;

create or replace function podium_private.new_token()
returns text language sql volatile set search_path = '' as $$
  select translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_')
$$;

create or replace function podium_private.random_code(p_length int)
returns text language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(p_length);
  out text := '';
begin
  for i in 0..p_length - 1 loop
    out := out || substr(alphabet, (get_byte(bytes, i) & 31) + 1, 1);
  end loop;
  return out;
end $$;

-- --- polls -------------------------------------------------------------------

create table if not exists podium_private.polls (
  code        text primary key,
  token_hash  text not null,            -- the presenter's token, hashed
  key_hash    text,                     -- a planned link's key, hashed
  seq         int not null default 0,   -- which question this is; votes carry it
  open        boolean not null default false,
  question    text not null default '', -- JSON, or ciphertext the server cannot read
  touched     timestamptz not null default now()
);

create table if not exists podium_private.votes (
  code    text not null references podium_private.polls (code) on delete cascade,
  seq     int not null,
  voter   text not null,
  answer  jsonb not null,
  name    text not null default '',
  at      timestamptz not null default now(),
  primary key (code, seq, voter)
);

-- Polls nobody has touched for two hours are gone, as on the server.
create or replace function podium_private.reap_polls()
returns void language sql set search_path = '' as $$
  delete from podium_private.polls where touched < now() - interval '2 hours'
$$;

-- Open a poll: a fresh four-character code, or - with a planned link's key -
-- the code the key gives. Reopening a planned code takes the same key; it
-- starts a fresh question with no answers carried over.
create or replace function public.poll_open(p_key text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_token text := podium_private.new_token();
  v_existing podium_private.polls;
begin
  perform podium_private.reap_polls();
  if p_key is not null then
    v_code := public.podium_link_code('podium-poll-link', p_key);
    if v_code = '' then raise exception 'not a poll link key' using errcode = '22023'; end if;
    select * into v_existing from podium_private.polls where code = v_code;
    if found and v_existing.key_hash is distinct from podium_private.hash(p_key) then
      raise exception 'that code is in use' using errcode = '23505';
    end if;
    delete from podium_private.polls where code = v_code;
    insert into podium_private.polls (code, token_hash, key_hash, seq)
      values (v_code, podium_private.hash(v_token), podium_private.hash(p_key), coalesce(v_existing.seq + 1, 0));
  else
    for attempt in 1..20 loop
      v_code := podium_private.random_code(4);
      begin
        insert into podium_private.polls (code, token_hash) values (v_code, podium_private.hash(v_token));
        exit;
      exception when unique_violation then v_code := null;
      end;
    end loop;
    if v_code is null then raise exception 'no code available' using errcode = '53000'; end if;
  end if;
  return json_build_object('code', v_code, 'token', v_token);
end $$;

create or replace function podium_private.host_poll(p_code text, p_token text)
returns podium_private.polls language plpgsql set search_path = '' as $$
declare v podium_private.polls;
begin
  select * into v from podium_private.polls where code = upper(p_code) and token_hash = podium_private.hash(p_token);
  if not found then raise exception 'not your poll' using errcode = '42501'; end if;
  update podium_private.polls set touched = now() where code = v.code;
  return v;
end $$;

-- Put a question up (a new seq: earlier answers stop counting) or close it.
create or replace function public.poll_ask(p_code text, p_token text, p_question text)
returns json language plpgsql security definer set search_path = '' as $$
declare v podium_private.polls := podium_private.host_poll(p_code, p_token);
begin
  update podium_private.polls set question = left(p_question, 20000), seq = seq + 1, open = true where code = v.code;
  return json_build_object('seq', v.seq + 1);
end $$;

create or replace function public.poll_close(p_code text, p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare v podium_private.polls := podium_private.host_poll(p_code, p_token);
begin
  update podium_private.polls set open = false where code = v.code;
end $$;

-- What a phone sees. Never the token, never anyone's answer.
create or replace function public.poll_view(p_code text)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('seq', seq, 'open', open, 'question', question)
  from podium_private.polls where code = upper(p_code)
$$;

-- One answer per phone per question; a later one replaces it.
create or replace function public.poll_vote(p_code text, p_seq int, p_voter text, p_answer jsonb, p_name text default '')
returns json language plpgsql security definer set search_path = '' as $$
declare v podium_private.polls;
begin
  select * into v from podium_private.polls where code = upper(p_code);
  if not found then raise exception 'no such poll' using errcode = 'P0002'; end if;
  if not v.open or v.seq <> p_seq then raise exception 'this question is closed' using errcode = '55000'; end if;
  if coalesce(p_voter, '') = '' then raise exception 'no voter id' using errcode = '22023'; end if;
  if (select count(*) from podium_private.votes where code = v.code and seq = v.seq) >= 2000
     and not exists (select 1 from podium_private.votes where code = v.code and seq = v.seq and voter = left(p_voter, 64)) then
    raise exception 'this poll is full' using errcode = '53000';
  end if;
  insert into podium_private.votes (code, seq, voter, answer, name)
    values (v.code, v.seq, left(p_voter, 64), p_answer, left(coalesce(p_name, ''), 100))
    on conflict (code, seq, voter) do update set answer = excluded.answer, name = excluded.name, at = now();
  return json_build_object('ok', true, 'seq', v.seq);
end $$;

-- The presenter's view: every answer to the current question.
create or replace function public.poll_results(p_code text, p_token text)
returns json language plpgsql security definer set search_path = '' as $$
declare v podium_private.polls := podium_private.host_poll(p_code, p_token);
begin
  return json_build_object('seq', v.seq, 'open', v.open, 'answers', coalesce((
    select json_agg(json_build_object('answer', answer, 'name', name) order by at)
    from podium_private.votes where code = v.code and seq = v.seq), '[]'::json));
end $$;

-- --- Guest View codes ----------------------------------------------------------

create table if not exists podium_private.view_codes (
  code        text primary key,
  token_hash  text not null,
  link        text not null,    -- the viewer link's fragment: view room, view key, relay
  touched     timestamptz not null default now()
);

-- A code answers only while its display keeps it alive (as server/view-codes.js).
create or replace function podium_private.view_live() returns interval language sql immutable as $$ select interval '3 minutes' $$;

-- Only a viewer link may be registered - never one that opens the real room.
create or replace function podium_private.clean_view_link(p_link text)
returns text language plpgsql immutable set search_path = '' as $$
declare t text := regexp_replace(coalesce(p_link, ''), '^#', '');
begin
  if t = '' or length(t) > 1500 then return null; end if;
  if t !~ '(^|&)t=(ws|mqtt|supabase)(&|$)' then return null; end if;
  if t !~ '(^|&)r=view\.[A-Za-z0-9_-]{8,40}(&|$)' then return null; end if;
  if t !~ '(^|&)p=[^&]+' then return null; end if;
  return t;
end $$;

-- A display going live. A planned link's key claims the code it gives, and
-- the key is the proof; otherwise `p_want` (the code it had last time) is
-- granted again if nobody holds it.
create or replace function public.view_code_register(p_link text, p_token text default null, p_want text default null, p_key text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_link text := podium_private.clean_view_link(p_link);
  v_code text;
  v_token text;
  v_held podium_private.view_codes;
begin
  if v_link is null then raise exception 'that is not a viewer link' using errcode = '22023'; end if;
  delete from podium_private.view_codes where touched < now() - podium_private.view_live();
  if p_key is not null then
    v_code := public.podium_link_code('podium-view-link', p_key);
    if v_code = '' then raise exception 'that is not a viewer link key' using errcode = '22023'; end if;
  else
    v_code := upper(coalesce(p_want, ''));
    if v_code !~ '^[A-HJ-NP-Z2-9]{6}$' then v_code := null; end if;
  end if;
  if v_code is not null then
    select * into v_held from podium_private.view_codes where code = v_code;
    if found and p_token is not null and v_held.token_hash = podium_private.hash(p_token) then
      update podium_private.view_codes set link = v_link, touched = now() where code = v_code;
      return json_build_object('code', v_code, 'token', p_token);
    end if;
    if found and p_key is null then v_code := null; end if;   -- someone else's six-character code
  end if;
  v_token := podium_private.new_token();
  if v_code is null then
    for attempt in 1..20 loop
      v_code := podium_private.random_code(6);
      exit when not exists (select 1 from podium_private.view_codes where code = v_code);
      v_code := null;
    end loop;
    if v_code is null then raise exception 'no code available' using errcode = '53000'; end if;
  end if;
  insert into podium_private.view_codes (code, token_hash, link) values (v_code, podium_private.hash(v_token), v_link)
    on conflict (code) do update set token_hash = excluded.token_hash, link = excluded.link, touched = now();
  return json_build_object('code', v_code, 'token', v_token);
end $$;

create or replace function public.view_code_touch(p_code text, p_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update podium_private.view_codes set touched = now()
    where code = upper(p_code) and token_hash = podium_private.hash(p_token) and touched >= now() - podium_private.view_live();
  return found;
end $$;

create or replace function public.view_code_release(p_code text, p_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from podium_private.view_codes where code = upper(p_code) and token_hash = podium_private.hash(p_token);
  return found;
end $$;

-- A viewer typing a code, or opening a planned link. A ten-character planned
-- code that is not live yet says so (`waiting`), so the page can wait for it.
create or replace function public.view_code_lookup(p_code text)
returns json language plpgsql stable security definer set search_path = '' as $$
declare
  k text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v podium_private.view_codes;
begin
  select * into v from podium_private.view_codes where code = k and touched >= now() - podium_private.view_live();
  if found then return json_build_object('link', v.link); end if;
  if k ~ '^[A-HJ-NP-Z2-9]{10}$' then return json_build_object('waiting', true); end if;
  return json_build_object('error', 'no class is live with that code right now');
end $$;

-- --- who may call what -----------------------------------------------------------

revoke all on schema podium_private from public;
revoke all on all tables in schema podium_private from public;
revoke execute on all functions in schema podium_private from public;
grant usage on schema public to anon, authenticated;
grant execute on function
  public.podium_link_code(text, text),
  public.poll_open(text), public.poll_ask(text, text, text), public.poll_close(text, text),
  public.poll_view(text), public.poll_vote(text, int, text, jsonb, text), public.poll_results(text, text),
  public.view_code_register(text, text, text, text), public.view_code_touch(text, text),
  public.view_code_release(text, text), public.view_code_lookup(text)
  to anon, authenticated;
