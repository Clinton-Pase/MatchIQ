-- supabase/migrations/0001_init.sql
-- MatchIQ core tables. All data is synthetic (fictional clubs and players).
-- Run this once in the Supabase dashboard: SQL Editor > New query > paste > Run.

create table if not exists teams (
  id               text primary key,
  name             text not null,
  short_name       text not null,
  color_primary    text not null,
  color_secondary  text not null,
  style            text not null check (style in ('high_press', 'possession', 'counter', 'direct'))
);

create table if not exists players (
  id            text primary key,
  team_id       text not null references teams(id) on delete cascade,
  name          text not null,
  shirt_number  int  not null,
  position      text not null check (position in ('GK', 'DF', 'MF', 'FW')),
  stamina       real not null,
  quality       real not null
);
create index if not exists players_team_idx on players(team_id);

create table if not exists matches (
  id            text primary key,
  season        text not null,
  round         int  not null,
  home_team_id  text not null references teams(id),
  away_team_id  text not null references teams(id),
  kickoff_at    timestamptz not null,
  venue         text not null,
  status        text not null check (status in ('scheduled', 'live', 'finished')),
  home_score    int  not null default 0,
  away_score    int  not null default 0,
  seed          bigint
);
create index if not exists matches_round_idx on matches(season, round);
create index if not exists matches_home_idx on matches(home_team_id);
create index if not exists matches_away_idx on matches(away_team_id);

create table if not exists lineups (
  match_id   text not null references matches(id) on delete cascade,
  player_id  text not null references players(id) on delete cascade,
  team_id    text not null references teams(id) on delete cascade,
  role       text not null check (role in ('starter', 'bench', 'unused')),
  primary key (match_id, player_id)
);

create table if not exists events (
  id                  text primary key,
  match_id            text not null references matches(id) on delete cascade,
  seq                 int  not null,
  period              smallint not null check (period in (1, 2)),
  minute              int  not null,
  second              int  not null,
  type                text not null,
  team_id             text not null,
  player_id           text,
  other_player_id     text,
  x                   real not null,
  y                   real not null,
  end_x               real,
  end_y               real,
  outcome             text,
  xg                  real,
  pass_distance       real,
  pass_difficulty     real,
  speed_kmh           real,
  card_color          text,
  pressure_intensity  real,
  unique (match_id, seq)
);
create index if not exists events_match_seq_idx on events(match_id, seq);
create index if not exists events_match_type_idx on events(match_id, type);
create index if not exists events_player_idx on events(player_id);

-- Energy readings (1 = fresh, 0 = exhausted) every 5 minutes for every player on the pitch.
create table if not exists fatigue_samples (
  match_id   text not null references matches(id) on delete cascade,
  player_id  text not null,
  minute     int  not null,
  energy     real not null,
  primary key (match_id, player_id, minute)
);

-- Everything above is synthetic, so anyone may READ it.
-- Only the service role key (used by the seed script, server side) can WRITE.
alter table teams           enable row level security;
alter table players         enable row level security;
alter table matches         enable row level security;
alter table lineups         enable row level security;
alter table events          enable row level security;
alter table fatigue_samples enable row level security;

create policy "public read teams"           on teams           for select to anon, authenticated using (true);
create policy "public read players"         on players         for select to anon, authenticated using (true);
create policy "public read matches"         on matches         for select to anon, authenticated using (true);
create policy "public read lineups"         on lineups         for select to anon, authenticated using (true);
create policy "public read events"          on events          for select to anon, authenticated using (true);
create policy "public read fatigue_samples" on fatigue_samples for select to anon, authenticated using (true);