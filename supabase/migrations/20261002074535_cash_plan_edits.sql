begin;

create table public.fd_cash_plan_edits(
 id uuid primary key,
 owner_id uuid not null references auth.users(id) on delete cascade,
 business_id uuid not null,
 source_type text not null check(source_type in ('estimated','registered','manual')),
 source_key text not null check(length(source_key) between 1 and 1500),
 source_hash text generated always as (md5(source_key)) stored,
 month text not null check(month='*' or month ~ '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$'),
 title text not null check(length(btrim(title)) between 1 and 500),
 account_id uuid,
 plan_date date,
 amount bigint not null check(amount between 0 and 9007199254740991),
 memo text not null default '' check(length(memo)<=2000),
 excluded boolean not null default false,
 version integer not null default 1 check(version>0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null,
 unique(owner_id,business_id,source_type,source_hash,month),
 foreign key(owner_id,business_id) references public.fd_businesses(owner_id,id) on delete cascade,
 foreign key(owner_id,business_id,account_id) references public.fd_accounts(owner_id,business_id,id) on delete cascade,
 check(month<>'*' or (excluded and source_type<>'manual' and plan_date is null)),
 check(plan_date is null or to_char(plan_date,'YYYY-MM')=month)
);
alter table public.fd_cash_plan_edits enable row level security;
revoke all on public.fd_cash_plan_edits from public,anon,authenticated;
grant select,insert,update,delete on public.fd_cash_plan_edits to authenticated;
create policy finance_cash_plan_workspace on public.fd_cash_plan_edits for all to authenticated
 using(owner_id=(select private.finance_workspace_owner()))
 with check(owner_id=(select private.finance_workspace_owner()));

-- Preserve identity and record the actual administrator for both RPC and direct API writes.
create function private.finance_cash_plan_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner(); source_id uuid;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if new.owner_id is distinct from workspace_owner then raise exception 'CASH_PLAN_OWNER_REQUIRED';end if;
 if tg_op='UPDATE' then
  if (new.id,new.owner_id,new.business_id,new.source_type,new.source_key,new.month,new.created_at)
   is distinct from (old.id,old.owner_id,old.business_id,old.source_type,old.source_key,old.month,old.created_at)
  then raise exception 'CASH_PLAN_IDENTITY_IMMUTABLE';end if;
  if new.version<>old.version+1 then raise exception 'CASH_PLAN_STALE';end if;
 else
  new.version:=1;new.created_at:=clock_timestamp();
 end if;
 if new.source_type='registered' then
  source_id:=new.source_key::uuid;
  if not exists(select 1 from public.fd_recurring_items where owner_id=workspace_owner and business_id=new.business_id and id=source_id and direction='out')
  then raise exception 'CASH_PLAN_RECURRING_REQUIRED';end if;
 elsif new.source_type='manual' then
  source_id:=new.source_key::uuid;
 end if;
 new.updated_at:=clock_timestamp();new.updated_by:=auth.uid();
 return new;
end $$;
revoke all on function private.finance_cash_plan_guard() from public,anon,authenticated;
create trigger finance_cash_plan_guard before insert or update on public.fd_cash_plan_edits
 for each row execute function private.finance_cash_plan_guard();

create function private.finance_cash_plan_audit() returns trigger
language plpgsql security invoker set search_path='' as $$
declare item public.fd_cash_plan_edits;
begin
 item:=case when tg_op='DELETE' then old else new end;
 insert into public.fd_audit_log(owner_id,action,detail)
 values(item.owner_id,'지출 계획 '||case when tg_op='DELETE' then '수정 원복' when item.excluded then '제외' else '저장' end,
 jsonb_build_object('id',item.id,'business_id',item.business_id,'month',item.month,'version',item.version)::text);
 return null;
end $$;
revoke all on function private.finance_cash_plan_audit() from public,anon,authenticated;
create trigger finance_cash_plan_audit after insert or update or delete on public.fd_cash_plan_edits
 for each row execute function private.finance_cash_plan_audit();

create function public.fd_read_cash_plan_edits() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner(); result jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',id,'business_id',business_id,'source_type',source_type,'source_key',source_key,'month',month,
  'title',title,'account_id',account_id,'plan_date',plan_date,'amount',amount,'memo',memo,
  'excluded',excluded,'version',version,'updated_at',updated_at
 ) order by business_id,month,source_type,source_key,id),'[]'::jsonb) into result
 from public.fd_cash_plan_edits where owner_id=workspace_owner;
 return result;
end $$;
revoke all on function public.fd_read_cash_plan_edits() from public,anon,authenticated;
grant execute on function public.fd_read_cash_plan_edits() to authenticated;

create function public.fd_save_cash_plan_edits(p_changes jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner(); change jsonb; item public.fd_cash_plan_edits;
 change_id uuid; expected_version integer; changed_id uuid; action text;
 seen_ids uuid[]:='{}';seen_keys text[]:='{}';scope_key text;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 100
 then raise exception 'INVALID_CASH_PLAN_CHANGES';end if;
 -- Serialize batches for a workspace so conflicting multi-row edits cannot deadlock or partially apply.
 perform pg_advisory_xact_lock(hashtextextended(workspace_owner::text||':cash-plan',0));
 for change in select value from jsonb_array_elements(p_changes) loop
  if jsonb_typeof(change) is distinct from 'object' then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
  action:=change->>'action';change_id:=(change->>'id')::uuid;expected_version:=(change->>'version')::integer;
  if change_id is null or expected_version is null or expected_version<0 or expected_version>=2147483647
   or action is null or action not in ('save','delete') or change_id=any(seen_ids)
  then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
  seen_ids:=array_append(seen_ids,change_id);
  changed_id:=null;
  if action='delete' then
   if expected_version=0 or exists(select 1 from jsonb_object_keys(change) key where key not in ('action','id','version'))
   then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
   delete from public.fd_cash_plan_edits where owner_id=workspace_owner and id=change_id and version=expected_version returning id into changed_id;
  else
   if not(change ?& array['business_id','source_type','source_key','month','title','account_id','plan_date','amount','memo','excluded'])
    or exists(select 1 from jsonb_object_keys(change) key where key not in ('action','id','version','business_id','source_type','source_key','month','title','account_id','plan_date','amount','memo','excluded'))
   then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
   select * into item from jsonb_populate_record(null::public.fd_cash_plan_edits,change-'action');
   scope_key:=jsonb_build_array(item.business_id,item.source_type,item.source_key,item.month)::text;
   if scope_key=any(seen_keys) then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
   seen_keys:=array_append(seen_keys,scope_key);
   if expected_version=0 then
    insert into public.fd_cash_plan_edits(id,owner_id,business_id,source_type,source_key,month,title,account_id,plan_date,amount,memo,excluded,updated_by)
    values(change_id,workspace_owner,item.business_id,item.source_type,item.source_key,item.month,item.title,item.account_id,item.plan_date,item.amount,item.memo,item.excluded,auth.uid())
    on conflict do nothing returning id into changed_id;
   else
    update public.fd_cash_plan_edits set title=item.title,account_id=item.account_id,plan_date=item.plan_date,amount=item.amount,memo=item.memo,excluded=item.excluded,version=version+1
    where owner_id=workspace_owner and id=change_id and version=expected_version and business_id=item.business_id
     and source_type=item.source_type and source_key=item.source_key and month=item.month returning id into changed_id;
   end if;
  end if;
  if changed_id is null then raise exception 'CASH_PLAN_STALE';end if;
 end loop;
 return public.fd_read_cash_plan_edits();
end $$;
revoke all on function public.fd_save_cash_plan_edits(jsonb) from public,anon,authenticated;
grant execute on function public.fd_save_cash_plan_edits(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
