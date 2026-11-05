begin;

alter table public.fd_cash_plan_series add constraint finance_series_owner_identity unique(owner_id,business_id,id);
create table public.fd_cash_plan_series_revisions(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,
 business_id uuid not null,series_id uuid not null,
 effective_month text not null check(effective_month ~ '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$'),
 title text not null check(length(btrim(title)) between 1 and 500),
 monthly_amount bigint not null check(monthly_amount between 0 and 9007199254740991),day integer check(day between 1 and 31),
 account_id uuid,memo text not null default '' check(length(memo)<=2000),excluded boolean not null default false,
 cancelled boolean not null default false check(not(excluded and cancelled)),
 version integer not null default 1 check(version>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null,
 unique(owner_id,business_id,series_id,effective_month),
 foreign key(owner_id,business_id,series_id) references public.fd_cash_plan_series(owner_id,business_id,id) on delete cascade,
 foreign key(owner_id,business_id,account_id) references public.fd_accounts(owner_id,business_id,id) on delete cascade
);
alter table public.fd_cash_plan_series_revisions enable row level security;
revoke all on public.fd_cash_plan_series_revisions from public,anon,authenticated;
grant select on public.fd_cash_plan_series_revisions to authenticated;
create policy finance_cash_series_revisions_workspace on public.fd_cash_plan_series_revisions for select to authenticated
 using(owner_id=(select private.finance_workspace_owner()));

create function private.finance_cash_series_revision_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
declare original public.fd_cash_plan_series;
begin
 select * into original from public.fd_cash_plan_series where owner_id=new.owner_id and business_id=new.business_id and id=new.series_id;
 if not found or original.kind<>'operating' then raise exception 'CASH_PLAN_SERIES_OPERATING_REQUIRED';end if;
 if new.effective_month<original.start_month or (original.end_month is not null and new.effective_month>original.end_month) then raise exception 'CASH_PLAN_SERIES_MONTH_REQUIRED';end if;
 if tg_op='UPDATE' then
  if (new.id,new.owner_id,new.business_id,new.series_id,new.effective_month,new.created_at)
   is distinct from (old.id,old.owner_id,old.business_id,old.series_id,old.effective_month,old.created_at)
  then raise exception 'CASH_PLAN_SERIES_IDENTITY_IMMUTABLE';end if;
  if new.version<>old.version+1 then raise exception 'CASH_PLAN_SERIES_STALE';end if;
  if old.excluded and (not new.excluded or new.cancelled) then raise exception 'CASH_PLAN_SERIES_EXCLUDED';end if;
 else new.version:=1;new.created_at:=clock_timestamp();end if;
 new.updated_at:=clock_timestamp();new.updated_by:=auth.uid();return new;
end $$;
revoke all on function private.finance_cash_series_revision_guard() from public,anon,authenticated;
create trigger finance_cash_series_revision_guard before insert or update on public.fd_cash_plan_series_revisions
 for each row execute function private.finance_cash_series_revision_guard();

create function private.finance_cash_series_revision_audit() returns trigger
language plpgsql security invoker set search_path='' as $$
declare item public.fd_cash_plan_series_revisions;
begin
 item:=case when tg_op='DELETE' then old else new end;
 insert into public.fd_audit_log(owner_id,action,detail) values(item.owner_id,'반복 고정비 변경',
 jsonb_build_object('id',item.id,'series_id',item.series_id,'effective_month',item.effective_month,'version',item.version,'excluded',item.excluded,'cancelled',item.cancelled)::text);
 return null;
end $$;
revoke all on function private.finance_cash_series_revision_audit() from public,anon,authenticated;
create trigger finance_cash_series_revision_audit after insert or update or delete on public.fd_cash_plan_series_revisions
 for each row execute function private.finance_cash_series_revision_audit();

create function public.fd_read_cash_plan_series_revisions() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();result jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.series_id,r.effective_month,r.id),'[]'::jsonb) into result from (
  select id,business_id,series_id,effective_month,title,monthly_amount,day,account_id,memo,excluded,cancelled,version,updated_at
  from public.fd_cash_plan_series_revisions where owner_id=workspace_owner
 ) r;return result;
end $$;
revoke all on function public.fd_read_cash_plan_series_revisions() from public,anon,authenticated;
grant execute on function public.fd_read_cash_plan_series_revisions() to authenticated;

-- Only this scoped core can write revisions. It serializes the existing month
-- CAS RPC and series CAS under the same workspace lock, so neither half commits
-- alone. Every identity and owner predicate comes from the authenticated context.
create function private.fd_save_cash_plan_series_core(p_change jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();change jsonb;item public.fd_cash_plan_series;child public.fd_cash_plan_edits;
 target_series uuid;target_business uuid;target_month text;expected integer;existed boolean;edits_result jsonb;series_result jsonb;revisions_result jsonb;plan_day integer;month_days integer;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if jsonb_typeof(p_change) is distinct from 'object' or (p_change-array['scope','business_id','month','series_id','expected_series_version','day','change'])<>'{}'::jsonb
  or p_change->>'scope' is distinct from 'from-month' or jsonb_typeof(p_change->'change') is distinct from 'object'
  or jsonb_typeof(p_change->'expected_series_version') is distinct from 'number' or (p_change->>'expected_series_version') !~ '^(0|[1-9][0-9]*)$'
 then raise exception 'CASH_PLAN_SERIES_INVALID_CHANGE';end if;
 begin target_series:=(p_change->>'series_id')::uuid;target_business:=(p_change->>'business_id')::uuid;expected:=(p_change->>'expected_series_version')::integer;
 exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'CASH_PLAN_SERIES_INVALID_CHANGE';end;
 target_month:=p_change->>'month';change:=p_change->'change';
 if target_series is null or target_business is null or expected is null or expected not between 0 and 2147483646 or target_month is null
  or target_month !~ '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$' or change->>'action' is distinct from 'save'
  or change->>'business_id' is distinct from target_business::text or change->>'month' is distinct from target_month
  or coalesce(change->>'payment_kind','general')<>'general' or coalesce(change->>'payment_status','pending')<>'pending'
 then raise exception 'CASH_PLAN_SERIES_INVALID_CHANGE';end if;
 select * into child from jsonb_populate_record(null::public.fd_cash_plan_edits,change-'action');
 if child.source_type not in ('estimated','manual') or child.source_type is null or child.excluded is null then raise exception 'CASH_PLAN_SERIES_INVALID_CHANGE';end if;
 if not (p_change?'day') or (p_change->'day'<>'null'::jsonb and (jsonb_typeof(p_change->'day') is distinct from 'number' or (p_change->>'day') !~ '^([1-9]|[12][0-9]|3[01])$')) then raise exception 'CASH_PLAN_SERIES_DAY_REQUIRED';end if;
 plan_day:=case when p_change->'day'='null'::jsonb then null else (p_change->>'day')::integer end;
 month_days:=extract(day from ((target_month||'-01')::date+interval '1 month'-interval '1 day'))::integer;
 if child.plan_date is distinct from (case when plan_day is null then null else (target_month||'-01')::date+least(plan_day,month_days)-1 end) then raise exception 'CASH_PLAN_SERIES_DAY_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended(workspace_owner::text||':cash-plan',0));
 select * into item from public.fd_cash_plan_series s where s.owner_id=workspace_owner and s.business_id=target_business and s.id=target_series for update;
 existed:=found;
 if existed then
  if expected=0 or item.version<>expected then raise exception 'CASH_PLAN_SERIES_STALE';end if;
  if item.kind<>'operating' then raise exception 'CASH_PLAN_SERIES_OPERATING_REQUIRED';end if;
  if child.source_type<>item.source_type or child.source_key<>item.source_key then raise exception 'CASH_PLAN_SERIES_IDENTITY_REQUIRED';end if;
  if target_month<item.start_month or (item.end_month is not null and target_month>item.end_month) then raise exception 'CASH_PLAN_SERIES_MONTH_REQUIRED';end if;
 else
  if expected<>0 then raise exception 'CASH_PLAN_SERIES_STALE';end if;
  if child.source_type<>'manual' or child.source_key<>target_series::text or child.excluded or child.memo !~ E'(?m)^\\[cash-plan-fixed:v1:[^\\]\\r\\n]+\\]$'
   or child.memo ~ E'(?m)^\\[clobe-card-bill:' then raise exception 'CASH_PLAN_SERIES_MANUAL_REQUIRED';end if;
 end if;
 if exists(select 1 from public.fd_cash_plan_edits e where e.owner_id=workspace_owner and e.business_id=target_business and e.source_type=child.source_type and e.source_key=child.source_key and e.month in ('*',target_month) and e.excluded)
  or exists(select 1 from public.fd_cash_plan_series_revisions r where r.owner_id=workspace_owner and r.series_id=target_series and r.effective_month<=target_month and r.excluded)
 then raise exception 'CASH_PLAN_SERIES_EXCLUDED';end if;
 if exists(select 1 from public.fd_cash_plan_edits e where e.owner_id=workspace_owner and e.business_id=target_business and e.source_type=child.source_type and e.source_key=child.source_key and (e.payment_kind='tax' or e.memo ~ E'(?m)^\\[clobe-card-bill:'))
 then raise exception 'CASH_PLAN_SERIES_OPERATING_REQUIRED';end if;
 -- The original month RPC validates its complete payload, version, account and
 -- identity while preserving stored payment confirmations and audit behavior.
 edits_result:=public.fd_save_cash_plan_edits(jsonb_build_array(change));
 if existed then
  update public.fd_cash_plan_series s set version=s.version+1 where s.owner_id=workspace_owner and s.id=target_series and s.version=expected;
  if not found then raise exception 'CASH_PLAN_SERIES_STALE';end if;
 else
  insert into public.fd_cash_plan_series(id,owner_id,business_id,source_type,source_key,title,account_id,monthly_amount,start_month,day,kind,memo)
  values(target_series,workspace_owner,target_business,'manual',target_series::text,child.title,child.account_id,child.amount,target_month,plan_day,'operating',child.memo);
 end if;
 -- A new onward base supersedes later included bases, without deleting history
 -- or cancelling an existing future exclusion. Explicit monthly exceptions stay.
 update public.fd_cash_plan_series_revisions r set cancelled=true,version=r.version+1
 where r.owner_id=workspace_owner and r.series_id=target_series and r.effective_month>target_month and not r.excluded and not r.cancelled;
 insert into public.fd_cash_plan_series_revisions(owner_id,business_id,series_id,effective_month,title,monthly_amount,day,account_id,memo,excluded)
 values(workspace_owner,target_business,target_series,target_month,child.title,child.amount,plan_day,child.account_id,child.memo,child.excluded)
 on conflict(owner_id,business_id,series_id,effective_month) do update set title=excluded.title,monthly_amount=excluded.monthly_amount,
  day=excluded.day,account_id=excluded.account_id,memo=excluded.memo,excluded=excluded.excluded,cancelled=false,version=public.fd_cash_plan_series_revisions.version+1;
 -- No timestamp cutoff here: include the new series/revision in this very save
 -- response instead of waiting for a second HTTP read to see its creation time.
 select coalesce(jsonb_agg(to_jsonb(r) order by r.business_id,r.start_month,r.id),'[]'::jsonb) into series_result from (
  select id,business_id,source_type,source_key,title,account_id,monthly_amount,start_month,end_month,day,kind,memo,amount_overrides,version,updated_at
  from public.fd_cash_plan_series where owner_id=workspace_owner
 ) r;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.series_id,r.effective_month,r.id),'[]'::jsonb) into revisions_result from (
  select id,business_id,series_id,effective_month,title,monthly_amount,day,account_id,memo,excluded,cancelled,version,updated_at
  from public.fd_cash_plan_series_revisions where owner_id=workspace_owner
 ) r;
 return jsonb_build_object('edits',edits_result,'series',series_result,'revisions',revisions_result);
exception when unique_violation then raise exception 'CASH_PLAN_SERIES_STALE';
end $$;
revoke all on function private.fd_save_cash_plan_series_core(jsonb) from public,anon,authenticated;
grant execute on function private.fd_save_cash_plan_series_core(jsonb) to authenticated;
create function public.fd_save_cash_plan_series(p_change jsonb) returns jsonb
language sql volatile security invoker set search_path='' as $$select private.fd_save_cash_plan_series_core(p_change)$$;
revoke all on function public.fd_save_cash_plan_series(jsonb) from public,anon,authenticated;
grant execute on function public.fd_save_cash_plan_series(jsonb) to authenticated;

-- New top-level data is backward compatible with deployed strict series rows.
do $$declare definition text;anchor text:=E'  ''audit'',';replacement text:=E'  ''cash_plan_series_revisions'',public.fd_read_cash_plan_series_revisions(),\n  ''audit'',';begin
 definition:=replace(pg_get_functiondef('public.fd_read_finance_dataset()'::regprocedure),E'\r\n',E'\n');
 if strpos(definition,anchor)=0 or strpos(definition,'cash_plan_series_revisions')>0 then raise exception 'CASH_PLAN_SERIES_REVISIONS_DATASET_ANCHOR_MISSING';end if;
 execute replace(definition,anchor,replacement);
end $$;
notify pgrst,'reload schema';
commit;
