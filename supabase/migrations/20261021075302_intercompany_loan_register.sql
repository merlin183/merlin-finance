begin;

-- The imported source is immutable. Future manual entries never rebase this snapshot.
create table public.fd_intercompany_baselines(
 owner_id uuid primary key references auth.users(id) on delete cascade,
 payload jsonb not null check(jsonb_typeof(payload)='object' and jsonb_typeof(payload->'businesses')='array' and jsonb_typeof(payload->'pairs')='array'),
 created_at timestamptz not null default now()
);
alter table public.fd_intercompany_baselines enable row level security;
revoke all on public.fd_intercompany_baselines from public,anon,authenticated;
grant select on public.fd_intercompany_baselines to authenticated;
create policy finance_intercompany_baseline_read on public.fd_intercompany_baselines for select to authenticated
 using(owner_id=(select private.finance_workspace_owner()));

create table public.fd_intercompany_entries(
 id uuid primary key,
 owner_id uuid not null references public.fd_intercompany_baselines(owner_id) on delete cascade,
 from_party text not null check(length(from_party) between 1 and 120),
 to_party text not null check(length(to_party) between 1 and 120 and from_party<>to_party),
 entry_date date not null,
 amount bigint not null check(amount between 1 and 9007199254740991),
 kind text not null check(kind in ('loan','repayment')),
 memo text not null default '' check(length(memo)<=2000),
 version integer not null default 1 check(version between 1 and 2147483646),
 sheet_row integer not null check(sheet_row between 2 and 10000),
 voided boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null,
 sheet_status text not null default 'pending' check(sheet_status in ('pending','syncing','synced','error')),
 sheet_error text not null default '' check(length(sheet_error)<=200),
 sheet_synced_at timestamptz,
 sheet_synced_version integer,
 sheet_lease_token uuid,
 sheet_lease_until timestamptz,
 sheet_lease_version integer,
 unique(owner_id,sheet_row),
 check((sheet_lease_token is null and sheet_lease_until is null and sheet_lease_version is null) or
       (sheet_lease_token is not null and sheet_lease_until is not null and sheet_lease_version is not null)),
 check(sheet_synced_version is null or sheet_synced_version<=version)
);
create index finance_intercompany_entries_owner_date on public.fd_intercompany_entries(owner_id,entry_date desc,id);
alter table public.fd_intercompany_entries enable row level security;
revoke all on public.fd_intercompany_entries from public,anon,authenticated;
grant select,insert,update on public.fd_intercompany_entries to authenticated;
create policy finance_intercompany_entry_read on public.fd_intercompany_entries for select to authenticated
 using(owner_id=(select private.finance_workspace_owner()));
create policy finance_intercompany_entry_insert on public.fd_intercompany_entries for insert to authenticated
 with check(owner_id=(select private.finance_workspace_owner()));
create policy finance_intercompany_entry_update on public.fd_intercompany_entries for update to authenticated
 using(owner_id=(select private.finance_workspace_owner())) with check(owner_id=(select private.finance_workspace_owner()));

create function private.finance_intercompany_entry_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner(); baseline jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if new.owner_id is distinct from workspace_owner then raise exception 'INTERCOMPANY_OWNER_REQUIRED';end if;
 select payload into baseline from public.fd_intercompany_baselines where owner_id=workspace_owner;
 if baseline is null then raise exception 'INTERCOMPANY_BASELINE_REQUIRED';end if;
 if not exists(select 1 from jsonb_array_elements(baseline->'businesses') p where p->>'key'=new.from_party)
  or not exists(select 1 from jsonb_array_elements(baseline->'businesses') p where p->>'key'=new.to_party)
 then raise exception 'INTERCOMPANY_PARTY_REQUIRED';end if;
 if new.entry_date>(current_timestamp at time zone 'Asia/Seoul')::date then raise exception 'INTERCOMPANY_FUTURE_DATE';end if;
 if new.entry_date<=(baseline->>'as_of')::date then raise exception 'INTERCOMPANY_BASELINE_PERIOD';end if;
 if tg_op='INSERT' then
  perform pg_advisory_xact_lock(hashtextextended(workspace_owner::text||':intercompany-register',0));
  select coalesce(max(sheet_row)+1,2) into new.sheet_row from public.fd_intercompany_entries where owner_id=workspace_owner;
  if new.sheet_row>10000 then raise exception 'INTERCOMPANY_SHEET_FULL';end if;
  new.version:=1;new.voided:=false;new.created_at:=clock_timestamp();new.updated_at:=new.created_at;new.updated_by:=auth.uid();
  new.sheet_status:='pending';new.sheet_error:='';new.sheet_synced_at:=null;new.sheet_synced_version:=null;
  new.sheet_lease_token:=null;new.sheet_lease_until:=null;new.sheet_lease_version:=null;
 else
  if (new.id,new.owner_id,new.from_party,new.to_party,new.entry_date,new.amount,new.kind,new.memo,new.created_at,new.sheet_row)
   is distinct from (old.id,old.owner_id,old.from_party,old.to_party,old.entry_date,old.amount,old.kind,old.memo,old.created_at,old.sheet_row)
  then raise exception 'INTERCOMPANY_IDENTITY_IMMUTABLE';end if;
  if new.voided is distinct from old.voided then
   if new.version<>old.version+1 then raise exception 'INTERCOMPANY_STALE';end if;
   new.updated_at:=clock_timestamp();new.updated_by:=auth.uid();new.sheet_status:='pending';new.sheet_error:='';
   -- Keep an in-flight lease. Its old version cannot acknowledge the newer desired state.
  elsif new.version<>old.version then raise exception 'INTERCOMPANY_STALE';
  else new.updated_at:=old.updated_at;new.updated_by:=old.updated_by;
  end if;
 end if;
 return new;
end $$;
revoke all on function private.finance_intercompany_entry_guard() from public,anon,authenticated;
create trigger finance_intercompany_entry_guard before insert or update on public.fd_intercompany_entries
 for each row execute function private.finance_intercompany_entry_guard();

create function private.finance_intercompany_entry_audit() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='INSERT' or new.voided is distinct from old.voided then
  insert into public.fd_audit_log(owner_id,action,detail) values(new.owner_id,
   case when tg_op='INSERT' then '사업자간 대여금 등록' when new.voided then '사업자간 대여금 취소' else '사업자간 대여금 복원' end,
   jsonb_build_object('id',new.id,'version',new.version)::text);
 end if;
 return null;
end $$;
revoke all on function private.finance_intercompany_entry_audit() from public,anon,authenticated;
create trigger finance_intercompany_entry_audit after insert or update on public.fd_intercompany_entries
 for each row execute function private.finance_intercompany_entry_audit();

create function public.fd_read_intercompany_register() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();baseline jsonb;entries jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select payload into baseline from public.fd_intercompany_baselines where owner_id=workspace_owner;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',id,'from_party',from_party,'to_party',to_party,'entry_date',entry_date,'amount',amount,'kind',kind,'memo',memo,
  'version',version,'voided',voided,'sheet_row',sheet_row,'created_at',created_at,'updated_at',updated_at,
  'sheet_status',case when sheet_status='syncing' and sheet_lease_until<=current_timestamp then 'pending' else sheet_status end,
  'sheet_synced_at',sheet_synced_at,'sheet_error',sheet_error
 ) order by entry_date desc,created_at desc,id),'[]'::jsonb) into entries
 from public.fd_intercompany_entries where owner_id=workspace_owner;
 return jsonb_build_object('baseline',baseline,'entries',entries);
end $$;
revoke all on function public.fd_read_intercompany_register() from public,anon,authenticated;
grant execute on function public.fd_read_intercompany_register() to authenticated;

create function public.fd_save_intercompany_register(p_change jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();entry_id uuid;item public.fd_intercompany_entries;existing public.fd_intercompany_entries;
 action text;expected integer;desired boolean;next_row integer;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if jsonb_typeof(p_change) is distinct from 'object' then raise exception 'INVALID_INTERCOMPANY_CHANGE';end if;
 action:=p_change->>'action';entry_id:=(p_change->>'id')::uuid;
 if entry_id is null or action is null or action not in ('create','set_voided') then raise exception 'INVALID_INTERCOMPANY_CHANGE';end if;
 perform pg_advisory_xact_lock(hashtextextended(workspace_owner::text||':intercompany-register',0));
 select * into existing from public.fd_intercompany_entries where owner_id=workspace_owner and id=entry_id for update;
 if action='create' then
  if not(p_change ?& array['id','from_party','to_party','entry_date','amount','kind','memo'])
   or exists(select 1 from jsonb_object_keys(p_change) key where key not in ('action','id','from_party','to_party','entry_date','amount','kind','memo'))
   or jsonb_typeof(p_change->'amount') is distinct from 'number' or (p_change->>'amount')!~'^[0-9]+$'
   or jsonb_typeof(p_change->'memo') is distinct from 'string'
   or jsonb_typeof(p_change->'from_party') is distinct from 'string' or jsonb_typeof(p_change->'to_party') is distinct from 'string'
   or jsonb_typeof(p_change->'entry_date') is distinct from 'string' or (p_change->>'entry_date')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   or jsonb_typeof(p_change->'kind') is distinct from 'string'
  then raise exception 'INVALID_INTERCOMPANY_CHANGE';end if;
  select * into item from jsonb_populate_record(null::public.fd_intercompany_entries,p_change-'action');
  item.memo:=btrim(item.memo);
  if existing.id is not null then
   if (existing.from_party,existing.to_party,existing.entry_date,existing.amount,existing.kind,existing.memo)
    is distinct from (item.from_party,item.to_party,item.entry_date,item.amount,item.kind,item.memo)
   then raise exception 'INTERCOMPANY_ID_CONFLICT';end if;
   return public.fd_read_intercompany_register();
  end if;
  select coalesce(max(sheet_row)+1,2) into next_row from public.fd_intercompany_entries where owner_id=workspace_owner;
  if next_row>10000 then raise exception 'INTERCOMPANY_SHEET_FULL';end if;
  insert into public.fd_intercompany_entries(id,owner_id,from_party,to_party,entry_date,amount,kind,memo,sheet_row)
  values(entry_id,workspace_owner,item.from_party,item.to_party,item.entry_date,item.amount,item.kind,item.memo,next_row);
 else
  if not(p_change ?& array['id','version','voided'])
   or exists(select 1 from jsonb_object_keys(p_change) key where key not in ('action','id','version','voided'))
   or jsonb_typeof(p_change->'version') is distinct from 'number' or (p_change->>'version')!~'^[0-9]+$'
   or jsonb_typeof(p_change->'voided') is distinct from 'boolean'
  then raise exception 'INVALID_INTERCOMPANY_CHANGE';end if;
  expected:=(p_change->>'version')::integer;desired:=(p_change->>'voided')::boolean;
  if expected<1 or expected>2147483646 or existing.id is null then raise exception 'INTERCOMPANY_STALE';end if;
  if existing.voided=desired and existing.version in (expected,expected+1) then return public.fd_read_intercompany_register();end if;
  if existing.version<>expected or existing.version>=2147483646 then raise exception 'INTERCOMPANY_STALE';end if;
  update public.fd_intercompany_entries set voided=desired,version=version+1 where owner_id=workspace_owner and id=entry_id;
 end if;
 return public.fd_read_intercompany_register();
end $$;
revoke all on function public.fd_save_intercompany_register(jsonb) from public,anon,authenticated;
grant execute on function public.fd_save_intercompany_register(jsonb) to authenticated;

-- A bounded claim serializes sheet updates. Only the claimed financial version can acknowledge success.
create function public.fd_claim_intercompany_sheet(p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();item public.fd_intercompany_entries;token uuid;entry jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select * into item from public.fd_intercompany_entries where owner_id=workspace_owner and id=p_id for update;
 if item.id is null then raise exception 'INTERCOMPANY_STALE';end if;
 if (item.sheet_status='synced' and item.sheet_synced_version=item.version) or item.sheet_lease_until>current_timestamp then return null;end if;
 token:=gen_random_uuid();
 update public.fd_intercompany_entries set sheet_status='syncing',sheet_error='',sheet_lease_token=token,
  sheet_lease_until=clock_timestamp()+interval '60 seconds',sheet_lease_version=version
 where owner_id=workspace_owner and id=p_id;
 select value into entry from jsonb_array_elements(public.fd_read_intercompany_register()->'entries') where value->>'id'=p_id::text;
 return jsonb_build_object('entry',entry,'token',token,'lease_version',item.version);
end $$;
revoke all on function public.fd_claim_intercompany_sheet(uuid) from public,anon,authenticated;
grant execute on function public.fd_claim_intercompany_sheet(uuid) to authenticated;

create function public.fd_finish_intercompany_sheet(p_id uuid,p_token uuid,p_version integer,p_success boolean,p_error text default '') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();item public.fd_intercompany_entries;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select * into item from public.fd_intercompany_entries where owner_id=workspace_owner and id=p_id for update;
 if item.id is null or p_token is null or p_success is null or item.sheet_lease_token is distinct from p_token
  or item.sheet_lease_version is distinct from p_version or item.sheet_lease_until<=current_timestamp
 then raise exception 'INTERCOMPANY_LEASE_STALE';end if;
 update public.fd_intercompany_entries set
  sheet_status=case when version<>p_version then 'pending' when p_success then 'synced' else 'error' end,
  sheet_error=case when version=p_version and not p_success then left(coalesce(p_error,'시트 반영을 다시 시도해주세요.'),200) else '' end,
  sheet_synced_at=case when version=p_version and p_success then clock_timestamp() else sheet_synced_at end,
  sheet_synced_version=case when version=p_version and p_success then p_version else sheet_synced_version end,
  sheet_lease_token=null,sheet_lease_until=null,sheet_lease_version=null
 where owner_id=workspace_owner and id=p_id;
 return public.fd_read_intercompany_register();
end $$;
revoke all on function public.fd_finish_intercompany_sheet(uuid,uuid,integer,boolean,text) from public,anon,authenticated;
grant execute on function public.fd_finish_intercompany_sheet(uuid,uuid,integer,boolean,text) to authenticated;

notify pgrst,'reload schema';
commit;
