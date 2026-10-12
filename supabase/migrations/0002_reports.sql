-- supabase/migrations/0002_reports.sql
-- Cache for generated match reports, so the same report is never paid for (or waited for) twice.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run.
-- Reports contain only synthetic, derived data. Anyone can read them; only the server (service key) can write.

create table if not exists reports (
  key         text primary key,
  match_id    text not null references matches(id) on delete cascade,
  mode        text not null,
  llm         text not null,
  overlay     jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists reports_match_idx on reports(match_id);

alter table reports enable row level security;

drop policy if exists "public read reports" on reports;
create policy "public read reports" on reports for select using (true);
-- no insert/update/delete policy: only the service role (which bypasses RLS) can write.
