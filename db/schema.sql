-- The shared high score board, in its own schema on the Supabase Postgres.
-- Safe to run again: npm run db:schema
--
-- A player is a nickname and the hash of a random token that only their
-- browser knows, so nobody else can post under that name. No accounts, no
-- e-mail, no IP addresses. To take a name off the board:
--   update berlin_game.players set hidden = true where name_key = lower('…');

create schema if not exists berlin_game;

create table if not exists berlin_game.players (
  id bigserial primary key,
  token_hash text not null unique,
  name text not null,
  -- the name as compared: lower case, so "Kiez" and "kiez" are one name
  name_key text not null unique,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists berlin_game.runs (
  id bigserial primary key,
  player_id bigint not null references berlin_game.players (id) on delete cascade,
  mode text not null,
  -- the course; only ranked runs come here, so never null
  seed integer not null,
  score integer not null,
  count integer not null,
  medal smallint not null,
  combo integer not null,
  created_at timestamptz not null default now()
);

-- a course's board takes each player's most targets, then most points
create index if not exists runs_course_best on berlin_game.runs (mode, seed, player_id, count desc, score desc);
