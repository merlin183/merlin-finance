begin;

create function private.finance_cash_plan_overrides_valid(p_values jsonb,p_start text,p_end text) returns boolean
language sql immutable set search_path='' as $$
 select case when jsonb_typeof(p_values) is distinct from 'object' then false else not exists(
  select 1 from jsonb_each(p_values) item where
   item.key !~ '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$' or item.key<p_start or (p_end is not null and item.key>p_end)
   or case when item.value::text ~ '^[0-9]+$' then item.value::text::numeric>9007199254740991 else true end
 ) end;
$$;
revoke all on function private.finance_cash_plan_overrides_valid(jsonb,text,text) from public,anon,authenticated;
grant execute on function private.finance_cash_plan_overrides_valid(jsonb,text,text) to authenticated;

-- Schedules own budgets only. No transaction, payment status or bank balance is written.
create table public.fd_cash_plan_series(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 business_id uuid not null,
 source_type text not null check(source_type in ('estimated','manual')),
 source_key text not null check(length(source_key) between 1 and 1500),
 source_hash text generated always as (md5(source_key)) stored,
 title text not null check(length(btrim(title)) between 1 and 500),
 account_id uuid,
 monthly_amount bigint not null check(monthly_amount between 0 and 9007199254740991),
 start_month text not null check(start_month ~ '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$'),
 end_month text check(end_month ~ '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$'),
 day integer check(day between 1 and 31),
 kind text not null check(kind in ('operating','installment')),
 memo text not null default '' check(length(memo)<=2000),
 amount_overrides jsonb not null default '{}'::jsonb,
 version integer not null default 1 check(version>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null,
 unique(owner_id,business_id,source_type,source_hash),
 foreign key(owner_id,business_id) references public.fd_businesses(owner_id,id) on delete cascade,
 foreign key(owner_id,business_id,account_id) references public.fd_accounts(owner_id,business_id,id) on delete cascade,
 check(end_month is null or end_month>=start_month),
 check(source_type<>'manual' or source_key=id::text),
 check(private.finance_cash_plan_overrides_valid(amount_overrides,start_month,end_month))
);
alter table public.fd_cash_plan_series enable row level security;
revoke all on public.fd_cash_plan_series from public,anon,authenticated;
grant select,insert,update,delete on public.fd_cash_plan_series to authenticated;
create policy finance_cash_plan_series_workspace on public.fd_cash_plan_series for all to authenticated
 using(owner_id=(select private.finance_workspace_owner()))
 with check(owner_id=(select private.finance_workspace_owner()));

create function private.finance_cash_plan_series_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='UPDATE' then
  if (new.id,new.owner_id,new.business_id,new.source_type,new.source_key,new.created_at)
   is distinct from (old.id,old.owner_id,old.business_id,old.source_type,old.source_key,old.created_at)
  then raise exception 'CASH_PLAN_SERIES_IDENTITY_IMMUTABLE';end if;
  if new.version<>old.version+1 then raise exception 'CASH_PLAN_SERIES_STALE';end if;
 else new.version:=1;new.created_at:=clock_timestamp();end if;
 new.updated_at:=clock_timestamp();new.updated_by:=auth.uid();return new;
end $$;
revoke all on function private.finance_cash_plan_series_guard() from public,anon,authenticated;
create trigger finance_cash_plan_series_guard before insert or update on public.fd_cash_plan_series
 for each row execute function private.finance_cash_plan_series_guard();

create function private.finance_cash_plan_series_audit() returns trigger
language plpgsql security invoker set search_path='' as $$
declare item public.fd_cash_plan_series;
begin
 item:=case when tg_op='DELETE' then old else new end;
 insert into public.fd_audit_log(owner_id,action,detail) values(item.owner_id,'월 고정비·할부 계획 '||case when tg_op='DELETE' then '삭제' else '저장' end,
 jsonb_build_object('id',item.id,'business_id',item.business_id,'version',item.version)::text);
 return null;
end $$;
revoke all on function private.finance_cash_plan_series_audit() from public,anon,authenticated;
create trigger finance_cash_plan_series_audit after insert or update or delete on public.fd_cash_plan_series
 for each row execute function private.finance_cash_plan_series_audit();

create function public.fd_read_cash_plan_series() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();result jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.business_id,r.start_month,r.id),'[]'::jsonb) into result from (
  select id,business_id,source_type,source_key,title,account_id,monthly_amount,start_month,end_month,day,kind,memo,amount_overrides,version,updated_at
  from public.fd_cash_plan_series where owner_id=workspace_owner and created_at<=statement_timestamp()
 ) r;
 return result;
end $$;
revoke all on function public.fd_read_cash_plan_series() from public,anon,authenticated;
grant execute on function public.fd_read_cash_plan_series() to authenticated;

-- Keep a single authenticated statement snapshot for all application tabs.
do $$declare definition text;anchor text:=E'  ''audit'',';replacement text:=E'  ''cash_plan_series'',public.fd_read_cash_plan_series(),\n  ''audit'',';begin
 definition:=replace(pg_get_functiondef('public.fd_read_finance_dataset()'::regprocedure),E'\r\n',E'\n');
 if strpos(definition,anchor)=0 or strpos(definition,'cash_plan_series')>0 then raise exception 'CASH_PLAN_SERIES_DATASET_ANCHOR_MISSING';end if;
 execute replace(definition,anchor,replacement);
end $$;
notify pgrst,'reload schema';
commit;
