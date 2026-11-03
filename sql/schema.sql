-- My Memos · CloudBase PostgreSQL schema
-- 在 CloudBase 环境对应的 PG 库里执行（tcb db execute -e <envId> --sql "..."）
-- 表放在 public schema，PostgREST 以 service_role 访问

create extension if not exists pgcrypto;

create table if not exists public.memos (
  id          uuid primary key default gen_random_uuid(),
  content     text        not null,
  tags        text[]      not null default '{}'::text[],
  pinned      boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists memos_created_at_idx on public.memos (created_at desc);
create index if not exists memos_pinned_idx     on public.memos (pinned desc, created_at desc);
create index if not exists memos_tags_idx       on public.memos using gin (tags);

-- 正文变更时自动刷新 updated_at（服务端也会显式写，双保险）
create or replace function public.touch_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists memos_touch_updated_at on public.memos;
create trigger memos_touch_updated_at
  before update on public.memos
  for each row execute function public.touch_updated_at();

-- TODO 表（2026-11-03）：状态 new=新建 doing=进行中 done=已完成 dropped=废弃 expired=过期
create table if not exists public.todos (
  id          uuid primary key default gen_random_uuid(),
  content     text        not null,
  tags        text[]      not null default '{}'::text[],
  author      text        not null default '管理员',
  status      text        not null default 'new'
              check (status in ('new','doing','done','dropped','expired')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists todos_created_at_idx on public.todos (created_at desc);
create index if not exists todos_status_idx     on public.todos (status);
create index if not exists todos_tags_idx       on public.todos using gin (tags);

drop trigger if exists todos_touch_updated_at on public.todos;
create trigger todos_touch_updated_at
  before update on public.todos
  for each row execute function public.touch_updated_at();
