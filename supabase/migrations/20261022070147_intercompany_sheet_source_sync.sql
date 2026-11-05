begin;

alter table public.fd_intercompany_entries add column source_row_key text check(source_row_key is null or length(source_row_key) between 1 and 120);
alter table public.fd_intercompany_entries add column sheet_expected_previous_row jsonb
 check(sheet_expected_previous_row is null or (jsonb_typeof(sheet_expected_previous_row)='array' and jsonb_array_length(sheet_expected_previous_row)=9));
create unique index finance_intercompany_source_link on public.fd_intercompany_entries(owner_id,source_row_key) where source_row_key is not null;

-- A durable, expiring lease coordinates short DB transactions around external HTTP calls.
create table public.fd_intercompany_sheet_state(
 owner_id uuid primary key references public.fd_intercompany_baselines(owner_id) on delete cascade,
 revision integer not null default 0 check(revision between 0 and 2147483646),
 snapshot jsonb,
 synced_at timestamptz,
 lease_id uuid,lease_token uuid,lease_actor uuid references auth.users(id) on delete set null,lease_until timestamptz,
 last_apply_token uuid,last_apply_digest text,
 check((lease_id is null and lease_token is null and lease_actor is null and lease_until is null) or
       (lease_id is not null and lease_token is not null and lease_actor is not null and lease_until is not null))
);
create table public.fd_intercompany_sheet_history(
 owner_id uuid not null references public.fd_intercompany_baselines(owner_id) on delete cascade,
 revision integer not null check(revision>0),snapshot jsonb not null,actor_id uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),primary key(owner_id,revision)
);
alter table public.fd_intercompany_sheet_state enable row level security;
alter table public.fd_intercompany_sheet_history enable row level security;
revoke all on public.fd_intercompany_sheet_state,public.fd_intercompany_sheet_history from public,anon,authenticated;
grant select,insert,update on public.fd_intercompany_sheet_state to authenticated;
grant select,insert on public.fd_intercompany_sheet_history to authenticated;
create policy finance_intercompany_sheet_state_workspace on public.fd_intercompany_sheet_state for all to authenticated
 using(owner_id=(select private.finance_workspace_owner())) with check(owner_id=(select private.finance_workspace_owner()));
create policy finance_intercompany_sheet_history_read on public.fd_intercompany_sheet_history for select to authenticated
 using(owner_id=(select private.finance_workspace_owner()));
create policy finance_intercompany_sheet_history_insert on public.fd_intercompany_sheet_history for insert to authenticated
 with check(owner_id=(select private.finance_workspace_owner()));

create function private.finance_intercompany_native_hash(p_owner uuid) returns text
language sql stable security invoker set search_path='' as $$
 select md5(coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'from_party',from_party,'to_party',to_party,
  'entry_date',entry_date,'amount',amount,'kind',kind,'memo',memo,'voided',voided,'source_row_key',source_row_key,'sheet_row',sheet_row)
  order by id)::text,'[]')) from public.fd_intercompany_entries where owner_id=p_owner;
$$;
revoke all on function private.finance_intercompany_native_hash(uuid) from public,anon,authenticated;
grant execute on function private.finance_intercompany_native_hash(uuid) to authenticated;

create or replace function private.finance_intercompany_entry_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();baseline jsonb;state public.fd_intercompany_sheet_state;
 financial_changed boolean;source_write boolean:=false;reserved integer;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended(workspace_owner::text||':intercompany-register',0));
 if new.owner_id is distinct from workspace_owner then raise exception 'INTERCOMPANY_OWNER_REQUIRED';end if;
 select payload into baseline from public.fd_intercompany_baselines where owner_id=workspace_owner;
 if baseline is null then raise exception 'INTERCOMPANY_BASELINE_REQUIRED';end if;
 select * into state from public.fd_intercompany_sheet_state where owner_id=workspace_owner;
 if state.lease_until>current_timestamp and state.lease_actor is distinct from auth.uid() then raise exception 'INTERCOMPANY_SYNC_BUSY';end if;
 if not exists(select 1 from jsonb_array_elements(baseline->'businesses') p where p->>'key'=new.from_party)
  or not exists(select 1 from jsonb_array_elements(baseline->'businesses') p where p->>'key'=new.to_party) then raise exception 'INTERCOMPANY_PARTY_REQUIRED';end if;
 if new.entry_date>(current_timestamp at time zone 'Asia/Seoul')::date then raise exception 'INTERCOMPANY_FUTURE_DATE';end if;
 if tg_op='INSERT' then
  if state.lease_until>current_timestamp then raise exception 'INTERCOMPANY_SYNC_BUSY';end if;
  if new.entry_date<=(baseline->>'as_of')::date then raise exception 'INTERCOMPANY_BASELINE_PERIOD';end if;
  if new.source_row_key is not null then raise exception 'INTERCOMPANY_IDENTITY_IMMUTABLE';end if;
  reserved:=coalesce((state.snapshot->>'mirrored_max_row')::integer,1);
  select greatest(coalesce(max(sheet_row),1),reserved)+1 into new.sheet_row from public.fd_intercompany_entries where owner_id=workspace_owner;
  if new.sheet_row>10000 then raise exception 'INTERCOMPANY_SHEET_FULL';end if;
  new.version:=1;new.voided:=false;new.created_at:=clock_timestamp();new.updated_at:=new.created_at;new.updated_by:=auth.uid();
  new.sheet_status:='pending';new.sheet_error:='';new.sheet_synced_at:=null;new.sheet_synced_version:=null;new.sheet_expected_previous_row:=null;
  new.sheet_lease_token:=null;new.sheet_lease_until:=null;new.sheet_lease_version:=null;
 else
  if (new.id,new.owner_id,new.sheet_row,new.created_at) is distinct from (old.id,old.owner_id,old.sheet_row,old.created_at)
   or (old.source_row_key is not null and new.source_row_key is distinct from old.source_row_key) then raise exception 'INTERCOMPANY_IDENTITY_IMMUTABLE';end if;
  financial_changed:=(new.from_party,new.to_party,new.entry_date,new.amount,new.kind,new.memo,new.source_row_key)
   is distinct from (old.from_party,old.to_party,old.entry_date,old.amount,old.kind,old.memo,old.source_row_key);
  if state.lease_until>current_timestamp and state.lease_actor=auth.uid() and new.source_row_key is not null then
   source_write:=exists(select 1 from jsonb_array_elements(state.snapshot->'rows') r where r->>'native_id'=new.id::text
    and r->>'from_business'=new.from_party and r->>'to_business'=new.to_party and (r->>'date')::date=new.entry_date
    and (r->>'amount')::bigint=new.amount and r->>'kind'=new.kind and coalesce((r->>'voided')::boolean,false)=new.voided);
  end if;
  if financial_changed or new.voided is distinct from old.voided then
   if financial_changed and not source_write then raise exception 'INTERCOMPANY_IDENTITY_IMMUTABLE';end if;
   if new.version<>old.version+1 then raise exception 'INTERCOMPANY_STALE';end if;
   if state.lease_until>current_timestamp and not source_write then raise exception 'INTERCOMPANY_SYNC_BUSY';end if;
   new.updated_at:=clock_timestamp();new.updated_by:=auth.uid();new.sheet_status:='pending';new.sheet_error:='';
  elsif new.version<>old.version then raise exception 'INTERCOMPANY_STALE';
  else new.updated_at:=old.updated_at;new.updated_by:=old.updated_by;
  end if;
  if new.sheet_expected_previous_row is distinct from old.sheet_expected_previous_row and not source_write
   and not(new.sheet_expected_previous_row is null and new.sheet_status='synced' and new.sheet_synced_version=new.version and old.sheet_lease_token is not null)
  then raise exception 'INTERCOMPANY_IDENTITY_IMMUTABLE';end if;
 end if;
 return new;
end $$;

create or replace function private.finance_intercompany_entry_audit() returns trigger
language plpgsql security invoker set search_path='' as $$
declare finance_change boolean;before_value jsonb;after_value jsonb;
begin
 finance_change:=tg_op='UPDATE' and (new.from_party,new.to_party,new.entry_date,new.amount,new.kind,new.memo,new.source_row_key)
  is distinct from (old.from_party,old.to_party,old.entry_date,old.amount,old.kind,old.memo,old.source_row_key);
 if tg_op='INSERT' or finance_change or new.voided is distinct from old.voided then
  after_value:=jsonb_build_object('id',new.id,'from_party',new.from_party,'to_party',new.to_party,'entry_date',new.entry_date,
   'amount',new.amount,'kind',new.kind,'memo',new.memo,'version',new.version,'voided',new.voided,'source_row_key',new.source_row_key);
  if tg_op='UPDATE' then before_value:=jsonb_build_object('id',old.id,'from_party',old.from_party,'to_party',old.to_party,'entry_date',old.entry_date,
   'amount',old.amount,'kind',old.kind,'memo',old.memo,'version',old.version,'voided',old.voided,'source_row_key',old.source_row_key);end if;
  insert into public.fd_audit_log(owner_id,action,detail) values(new.owner_id,
   case when tg_op='INSERT' then '사업자간 대여금 등록' when finance_change then '사업자간 대여금 시트 수정' when new.voided then '사업자간 대여금 취소' else '사업자간 대여금 복원' end,
   jsonb_build_object('id',new.id,'version',new.version,'before',before_value,'after',after_value)::text);
 end if;return null;
end $$;

create or replace function public.fd_read_intercompany_register() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();baseline jsonb;entries jsonb;sheet_sync jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select payload into baseline from public.fd_intercompany_baselines where owner_id=workspace_owner;
 select coalesce(jsonb_agg((jsonb_build_object('id',id,'from_party',from_party,'to_party',to_party,'entry_date',entry_date,'amount',amount,'kind',kind,'memo',memo,
  'version',version,'voided',voided,'sheet_row',sheet_row,'created_at',created_at,'updated_at',updated_at,
  'sheet_status',case when sheet_status='syncing' and sheet_lease_until<=current_timestamp then 'pending' else sheet_status end,
  'sheet_synced_at',sheet_synced_at,'sheet_error',sheet_error)||case when source_row_key is null then '{}'::jsonb else jsonb_build_object('source_row_key',source_row_key) end
  ||case when sheet_expected_previous_row is not null and (sheet_status in ('pending','error') or (sheet_status='syncing' and sheet_lease_until<=current_timestamp)) then jsonb_build_object('sheet_previous_row',sheet_expected_previous_row) else '{}'::jsonb end) order by entry_date desc,created_at desc,id),'[]'::jsonb) into entries
 from public.fd_intercompany_entries where owner_id=workspace_owner;
 select snapshot||jsonb_build_object('revision',revision,'synced_at',synced_at) into sheet_sync from public.fd_intercompany_sheet_state where owner_id=workspace_owner and snapshot is not null;
 return jsonb_build_object('baseline',baseline,'entries',entries)||case when sheet_sync is null then '{}'::jsonb else jsonb_build_object('sheet_sync',sheet_sync) end;
end $$;

create function public.fd_begin_intercompany_sheet_sync(p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();state public.fd_intercompany_sheet_state;baseline_hash text;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if p_id is null then raise exception 'INVALID_INTERCOMPANY_SYNC';end if;
 perform pg_advisory_xact_lock(hashtextextended(workspace_owner::text||':intercompany-register',0));
 select md5(payload::text) into baseline_hash from public.fd_intercompany_baselines where owner_id=workspace_owner;
 if baseline_hash is null then raise exception 'INTERCOMPANY_BASELINE_REQUIRED';end if;
 insert into public.fd_intercompany_sheet_state(owner_id) values(workspace_owner) on conflict do nothing;
 select * into state from public.fd_intercompany_sheet_state where owner_id=workspace_owner for update;
 if state.lease_until>current_timestamp and (state.lease_id<>p_id or state.lease_actor<>auth.uid()) then raise exception 'INTERCOMPANY_SYNC_BUSY';end if;
 if not coalesce(state.lease_until>current_timestamp and state.lease_id=p_id and state.lease_actor=auth.uid(),false) then
  if exists(select 1 from public.fd_intercompany_entries where owner_id=workspace_owner and sheet_lease_until>current_timestamp) then raise exception 'INTERCOMPANY_SYNC_BUSY';end if;
  state.lease_token:=gen_random_uuid();
 end if;
 update public.fd_intercompany_sheet_state set lease_id=p_id,lease_token=state.lease_token,lease_actor=auth.uid(),lease_until=clock_timestamp()+interval '120 seconds' where owner_id=workspace_owner;
 return jsonb_build_object('token',state.lease_token,'revision',state.revision,'baseline_hash',baseline_hash,
  'native_hash',private.finance_intercompany_native_hash(workspace_owner),'register',public.fd_read_intercompany_register());
end $$;

create function public.fd_end_intercompany_sheet_sync(p_token uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();n integer;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended(workspace_owner::text||':intercompany-register',0));
 update public.fd_intercompany_sheet_state set lease_id=null,lease_token=null,lease_actor=null,lease_until=null
 where owner_id=workspace_owner and lease_token=p_token and lease_actor=auth.uid();get diagnostics n=row_count;return n=1;
end $$;

create function public.fd_apply_intercompany_sheet_sync(p_token uuid,p_expected_revision integer,p_expected_baseline_hash text,p_expected_native_hash text,p_snapshot jsonb,p_amendments jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();state public.fd_intercompany_sheet_state;baseline jsonb;normalized jsonb;row jsonb;pair jsonb;change jsonb;
 keys text[]:='{}';pair_keys text[]:='{}';positions text[]:='{}';links uuid[]:='{}';seen uuid[]:='{}';linked uuid;key text;source_origin text;source_voided boolean;snapshot_changed boolean;
 item public.fd_intercompany_entries;expected public.fd_intercompany_entries;row_link jsonb;previous jsonb;digest text;amended integer:=0;changed integer:=0;new_rows jsonb:='[]';pair_key text;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended(workspace_owner::text||':intercompany-register',0));
 select * into state from public.fd_intercompany_sheet_state where owner_id=workspace_owner for update;
 if state.lease_token is distinct from p_token or p_token is null or state.lease_actor is distinct from auth.uid() or state.lease_until<=current_timestamp then raise exception 'INTERCOMPANY_SYNC_LEASE_STALE';end if;
 digest:=md5(jsonb_build_object('snapshot',p_snapshot,'amendments',p_amendments)::text);
 if state.last_apply_token=p_token and state.last_apply_digest=digest then return jsonb_build_object('register',public.fd_read_intercompany_register(),'changed_rows',0,'amended_entries',0,'unchanged',true);end if;
 if state.last_apply_token=p_token then raise exception 'INTERCOMPANY_SYNC_STALE';end if;
 select payload into baseline from public.fd_intercompany_baselines where owner_id=workspace_owner;
 if p_expected_revision is null or state.revision<>p_expected_revision or md5(baseline::text) is distinct from p_expected_baseline_hash
  or private.finance_intercompany_native_hash(workspace_owner) is distinct from p_expected_native_hash then raise exception 'INTERCOMPANY_SYNC_STALE';end if;
 if jsonb_typeof(p_snapshot) is distinct from 'object' or not(p_snapshot?&array['fingerprint','through_date','historical_base_pairs','rows'])
  or exists(select 1 from jsonb_object_keys(p_snapshot) k where k not in ('fingerprint','through_date','historical_base_pairs','rows','mirrored_max_row'))
  or jsonb_typeof(p_snapshot->'fingerprint') is distinct from 'string' or length(p_snapshot->>'fingerprint') not between 1 and 200
  or jsonb_typeof(p_snapshot->'historical_base_pairs') is distinct from 'array' or jsonb_array_length(p_snapshot->'historical_base_pairs')>1000
  or jsonb_typeof(p_snapshot->'rows') is distinct from 'array' or jsonb_array_length(p_snapshot->'rows')>10000
  or jsonb_typeof(p_amendments) is distinct from 'array' or jsonb_array_length(p_amendments)>100
 then raise exception 'INVALID_INTERCOMPANY_SYNC';end if;
 if jsonb_typeof(p_snapshot->'through_date') is distinct from 'string' or (p_snapshot->>'through_date')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or (p_snapshot->>'through_date')::date>(current_timestamp at time zone 'Asia/Seoul')::date then raise exception 'INVALID_INTERCOMPANY_SYNC';end if;
 if coalesce(p_snapshot->>'mirrored_max_row','1')!~'^[0-9]+$' or coalesce((p_snapshot->>'mirrored_max_row')::integer,1) not between 1 and 10000 then raise exception 'INVALID_INTERCOMPANY_SYNC';end if;
 for pair in select value from jsonb_array_elements(p_snapshot->'historical_base_pairs') loop
  if jsonb_typeof(pair) is distinct from 'object' or not(pair?&array['business_a','business_b','a_to_b','b_to_a']) or exists(select 1 from jsonb_object_keys(pair) k where k not in ('business_a','business_b','a_to_b','b_to_a'))
   or jsonb_typeof(pair->'business_a') is distinct from 'string' or jsonb_typeof(pair->'business_b') is distinct from 'string'
   or pair->>'business_a'=pair->>'business_b' or not exists(select 1 from jsonb_array_elements(baseline->'businesses') b where b->>'key'=pair->>'business_a')
   or not exists(select 1 from jsonb_array_elements(baseline->'businesses') b where b->>'key'=pair->>'business_b') then raise exception 'INVALID_INTERCOMPANY_SYNC_PAIR';end if;
  pair_key:=case when pair->>'business_a'<pair->>'business_b' then jsonb_build_array(pair->>'business_a',pair->>'business_b')::text else jsonb_build_array(pair->>'business_b',pair->>'business_a')::text end;
  if pair_key=any(pair_keys) then raise exception 'INVALID_INTERCOMPANY_SYNC_PAIR';end if;pair_keys:=array_append(pair_keys,pair_key);
  foreach key in array array['a_to_b','b_to_a'] loop
   if jsonb_typeof(pair->key) is distinct from 'number' or (pair->>key)!~'^[0-9]+$' or (pair->>key)::numeric>9007199254740991 then raise exception 'INVALID_INTERCOMPANY_SYNC_PAIR';end if;
  end loop;
 end loop;
 if cardinality(pair_keys)<>jsonb_array_length(baseline->'pairs') or exists(select 1 from jsonb_array_elements(baseline->'pairs') p where
  (case when p->>'business_a'<p->>'business_b' then jsonb_build_array(p->>'business_a',p->>'business_b')::text else jsonb_build_array(p->>'business_b',p->>'business_a')::text end)<>all(pair_keys)) then raise exception 'INVALID_INTERCOMPANY_SYNC_PAIR';end if;
 for row in select value from jsonb_array_elements(p_snapshot->'rows') loop
  if jsonb_typeof(row) is distinct from 'object' or not(row?&array['id','source_row','date','from_business','to_business','amount','kind','memo','native_id'])
   or exists(select 1 from jsonb_object_keys(row) k where k not in ('id','source_row','date','from_business','to_business','amount','kind','memo','native_id','origin','voided'))
   or jsonb_typeof(row->'id') is distinct from 'string' or jsonb_typeof(row->'date') is distinct from 'string' or jsonb_typeof(row->'from_business') is distinct from 'string'
   or jsonb_typeof(row->'to_business') is distinct from 'string' or jsonb_typeof(row->'kind') is distinct from 'string' or jsonb_typeof(row->'native_id') not in ('string','null')
   or length(row->>'id') not between 1 and 120 or row->>'id'=any(keys) or jsonb_typeof(row->'amount') is distinct from 'number' or (row->>'amount')!~'^[0-9]+$'
   or (row->>'amount')::numeric not between 1 and 9007199254740991 or row->>'from_business'=row->>'to_business'
   or row->>'kind' not in ('loan','repayment','source_unspecified') or jsonb_typeof(row->'memo') is distinct from 'string' or length(row->>'memo')>3000
   or (row->>'date')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or (row->>'date')::date>(p_snapshot->>'through_date')::date
   or not exists(select 1 from jsonb_array_elements(baseline->'businesses') b where b->>'key'=row->>'from_business')
   or not exists(select 1 from jsonb_array_elements(baseline->'businesses') b where b->>'key'=row->>'to_business')
   or jsonb_typeof(row->'source_row') is distinct from 'number' or (row->>'source_row')!~'^[0-9]+$' or (row->>'source_row')::integer not between 2 and 10000
  then raise exception 'INVALID_INTERCOMPANY_SYNC_ROW';end if;
  source_origin:=coalesce(row->>'origin','source');source_voided:=coalesce((row->>'voided')::boolean,false);
  if source_origin not in ('source','mirror') or (source_origin='source' and (row->>'source_row')::integer not between 48 and 70)
   or (row?'voided' and jsonb_typeof(row->'voided') is distinct from 'boolean') then raise exception 'INVALID_INTERCOMPANY_SYNC_ROW';end if;
  key:=source_origin||':'||(row->>'source_row');
  if key=any(positions) or (source_origin='mirror' and (row->>'source_row')::integer>coalesce((p_snapshot->>'mirrored_max_row')::integer,1)) then raise exception 'INVALID_INTERCOMPANY_SYNC_ROW';end if;
  positions:=array_append(positions,key);
  keys:=array_append(keys,row->>'id');linked:=(row->>'native_id')::uuid;
  if linked is not null then
   if linked=any(links) or not exists(select 1 from public.fd_intercompany_entries where owner_id=workspace_owner and id=linked) then raise exception 'INTERCOMPANY_SYNC_LINK_REQUIRED';end if;
   links:=array_append(links,linked);
  end if;
  new_rows:=new_rows||jsonb_build_array(row||jsonb_build_object('origin',source_origin,'voided',source_voided));
 end loop;
 if exists(select 1 from public.fd_intercompany_entries e where e.owner_id=workspace_owner and e.source_row_key is not null
  and not exists(select 1 from jsonb_array_elements(new_rows) r where r->>'native_id'=e.id::text)) then raise exception 'INTERCOMPANY_SYNC_LINK_MISSING';end if;
 if exists(select 1 from jsonb_array_elements(coalesce(state.snapshot->'rows',baseline->'additions','[]')) old_row
  where not exists(select 1 from jsonb_array_elements(new_rows) r where r->>'id'=old_row->>'id')) then raise exception 'INTERCOMPANY_SYNC_KEY_MISSING';end if;
 normalized:=p_snapshot||jsonb_build_object('rows',new_rows,'mirrored_max_row',greatest(coalesce((p_snapshot->>'mirrored_max_row')::integer,1),coalesce((state.snapshot->>'mirrored_max_row')::integer,1)));
 snapshot_changed:=state.snapshot is distinct from normalized;
 if state.snapshot is distinct from normalized and state.revision>=2147483646 then raise exception 'INTERCOMPANY_SYNC_STALE';end if;
 select count(*) into changed from (
  select coalesce(n->>'id',o->>'id') from jsonb_array_elements(new_rows) n full join jsonb_array_elements(coalesce(state.snapshot->'rows','[]')) o on n->>'id'=o->>'id' where n is distinct from o
 ) d;
 update public.fd_intercompany_sheet_state set snapshot=normalized,revision=case when snapshot is distinct from normalized then revision+1 else revision end,
  synced_at=clock_timestamp() where owner_id=workspace_owner;
 -- Lock all affected rows in stable order before any source amendment.
 perform id from public.fd_intercompany_entries where owner_id=workspace_owner and id in (select (a->>'id')::uuid from jsonb_array_elements(p_amendments) a) order by id for update;
 for change in select value from jsonb_array_elements(p_amendments) loop
  if jsonb_typeof(change) is distinct from 'object' or not(change?&array['id','version','source_row_key','entry_date','from_party','to_party','amount','kind','memo','previous_row','voided'])
   or exists(select 1 from jsonb_object_keys(change) k where k not in ('id','version','source_row_key','entry_date','from_party','to_party','amount','kind','memo','previous_row','voided'))
   or jsonb_typeof(change->'amount') is distinct from 'number' or (change->>'amount')!~'^[0-9]+$' or (change->>'amount')::numeric not between 1 and 9007199254740991
   or jsonb_typeof(change->'version') is distinct from 'number' or (change->>'version')!~'^[0-9]+$' or jsonb_typeof(change->'voided') is distinct from 'boolean'
   or jsonb_typeof(change->'id') is distinct from 'string' or jsonb_typeof(change->'source_row_key') is distinct from 'string' or length(change->>'source_row_key') not between 1 and 120
   or jsonb_typeof(change->'entry_date') is distinct from 'string' or jsonb_typeof(change->'from_party') is distinct from 'string' or jsonb_typeof(change->'to_party') is distinct from 'string'
   or jsonb_typeof(change->'kind') is distinct from 'string' or change->>'kind' not in ('loan','repayment')
   or jsonb_typeof(change->'memo') is distinct from 'string' or length(change->>'memo')>2000 then raise exception 'INVALID_INTERCOMPANY_SYNC_AMENDMENT';end if;
  select * into expected from jsonb_populate_record(null::public.fd_intercompany_entries,change-'previous_row');
  if expected.id=any(seen) then raise exception 'INVALID_INTERCOMPANY_SYNC_AMENDMENT';end if;seen:=array_append(seen,expected.id);
  select * into item from public.fd_intercompany_entries where owner_id=workspace_owner and id=expected.id;
  if item.id is null or item.version<>expected.version or item.version>=2147483646 or item.sheet_lease_until>current_timestamp then raise exception 'INTERCOMPANY_SYNC_STALE';end if;
  select value into row_link from jsonb_array_elements(new_rows) where value->>'native_id'=item.id::text;
  if row_link is null or (row_link->>'from_business',row_link->>'to_business',(row_link->>'date')::date,(row_link->>'amount')::bigint,row_link->>'kind',(row_link->>'voided')::boolean)
   is distinct from (expected.from_party,expected.to_party,expected.entry_date,expected.amount,expected.kind,expected.voided)
  then raise exception 'INTERCOMPANY_SYNC_LINK_REQUIRED';end if;
  previous:=nullif(change->'previous_row','null'::jsonb);
  if previous is not null and (jsonb_typeof(previous)<>'array' or jsonb_array_length(previous)<>9 or exists(select 1 from jsonb_array_elements(previous) cell where jsonb_typeof(cell) not in ('string','number')))
  then raise exception 'INVALID_INTERCOMPANY_SYNC_AMENDMENT';end if;
  if previous is not null and exists(select 1 from jsonb_array_elements(previous) cell where cell<>'""'::jsonb)
   and (previous->>0 is distinct from item.id::text or jsonb_typeof(previous->7) is distinct from 'number' or (previous->>7)!~'^[0-9]+$' or (previous->>7)::numeric not between 1 and item.version)
  then raise exception 'INVALID_INTERCOMPANY_SYNC_AMENDMENT';end if;
  if (item.from_party,item.to_party,item.entry_date,item.amount,item.kind,item.memo,item.voided,item.source_row_key)
   is distinct from (expected.from_party,expected.to_party,expected.entry_date,expected.amount,expected.kind,expected.memo,expected.voided,expected.source_row_key) then
   update public.fd_intercompany_entries set from_party=expected.from_party,to_party=expected.to_party,entry_date=expected.entry_date,amount=expected.amount,kind=expected.kind,memo=expected.memo,
    voided=expected.voided,source_row_key=expected.source_row_key,version=version+1,sheet_expected_previous_row=previous where owner_id=workspace_owner and id=item.id;
   amended:=amended+1;
  elsif item.sheet_status='synced' and previous='["","","","","","","","",""]'::jsonb then
   -- A deleted fixed mirror row can be restored without inventing a financial edit.
   update public.fd_intercompany_entries set sheet_status='pending',sheet_error='',sheet_expected_previous_row=previous
   where owner_id=workspace_owner and id=item.id;
   amended:=amended+1;
  end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(new_rows) r join public.fd_intercompany_entries e on e.owner_id=workspace_owner and e.id=(r->>'native_id')::uuid
  where e.source_row_key is null or (r->>'from_business',r->>'to_business',(r->>'date')::date,(r->>'amount')::bigint,r->>'kind',(r->>'voided')::boolean)
   is distinct from (e.from_party,e.to_party,e.entry_date,e.amount,e.kind,e.voided)) then raise exception 'INTERCOMPANY_SYNC_LINK_REQUIRED';end if;
 select * into state from public.fd_intercompany_sheet_state where owner_id=workspace_owner;
 insert into public.fd_intercompany_sheet_history(owner_id,revision,snapshot,actor_id,created_at)
 values(workspace_owner,state.revision,state.snapshot,auth.uid(),state.synced_at) on conflict do nothing;
 update public.fd_intercompany_sheet_state set last_apply_token=p_token,last_apply_digest=digest where owner_id=workspace_owner;
 if snapshot_changed or amended>0 then insert into public.fd_audit_log(owner_id,action,detail) values(workspace_owner,'사업자간 대여금 시트 동기화',jsonb_build_object('revision',state.revision,'changed_rows',changed,'amended_entries',amended,'snapshot_changed',snapshot_changed)::text);end if;
 return jsonb_build_object('register',public.fd_read_intercompany_register(),'changed_rows',changed,'amended_entries',amended,'unchanged',not snapshot_changed and amended=0);
end $$;

create function private.finance_claim_intercompany_sheet(p_id uuid,p_sync_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();item public.fd_intercompany_entries;state public.fd_intercompany_sheet_state;token uuid;entry jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended(workspace_owner::text||':intercompany-register',0));
 select * into state from public.fd_intercompany_sheet_state where owner_id=workspace_owner;
 if state.lease_until>current_timestamp and (p_sync_token is null or state.lease_token is distinct from p_sync_token or state.lease_actor is distinct from auth.uid()) then raise exception 'INTERCOMPANY_SYNC_BUSY';end if;
 if p_sync_token is not null and (state.lease_token is distinct from p_sync_token or state.lease_until<=current_timestamp or state.lease_actor is distinct from auth.uid()) then raise exception 'INTERCOMPANY_SYNC_LEASE_STALE';end if;
 select * into item from public.fd_intercompany_entries where owner_id=workspace_owner and id=p_id for update;
 if item.id is null then raise exception 'INTERCOMPANY_STALE';end if;
 if (item.sheet_status='synced' and item.sheet_synced_version=item.version and item.sheet_expected_previous_row is null) or item.sheet_lease_until>current_timestamp then return null;end if;
 token:=gen_random_uuid();
 update public.fd_intercompany_entries set sheet_status='syncing',sheet_error='',sheet_lease_token=token,sheet_lease_until=clock_timestamp()+interval '60 seconds',sheet_lease_version=version where owner_id=workspace_owner and id=p_id;
 select value into entry from jsonb_array_elements(public.fd_read_intercompany_register()->'entries') where value->>'id'=p_id::text;
 return jsonb_build_object('entry',entry,'token',token,'lease_version',item.version)||case when item.sheet_expected_previous_row is null then '{}'::jsonb else jsonb_build_object('previous_row',item.sheet_expected_previous_row) end;
end $$;
revoke all on function private.finance_claim_intercompany_sheet(uuid,uuid) from public,anon,authenticated;
grant execute on function private.finance_claim_intercompany_sheet(uuid,uuid) to authenticated;
create or replace function public.fd_claim_intercompany_sheet(p_id uuid) returns jsonb
language sql security invoker set search_path='' as $$select private.finance_claim_intercompany_sheet(p_id,null)$$;
create function public.fd_claim_intercompany_sheet_for_sync(p_id uuid,p_sync_token uuid) returns jsonb
language sql security invoker set search_path='' as $$select private.finance_claim_intercompany_sheet(p_id,p_sync_token)$$;

create or replace function public.fd_finish_intercompany_sheet(p_id uuid,p_token uuid,p_version integer,p_success boolean,p_error text default '') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();item public.fd_intercompany_entries;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended(workspace_owner::text||':intercompany-register',0));
 select * into item from public.fd_intercompany_entries where owner_id=workspace_owner and id=p_id for update;
 if item.id is null or p_token is null or p_success is null or item.sheet_lease_token is distinct from p_token or item.sheet_lease_version is distinct from p_version or item.sheet_lease_until<=current_timestamp then raise exception 'INTERCOMPANY_LEASE_STALE';end if;
 update public.fd_intercompany_entries set sheet_status=case when version<>p_version then 'pending' when p_success then 'synced' else 'error' end,
  sheet_error=case when version=p_version and not p_success then left(coalesce(p_error,'시트 기록을 다시 시도해주세요.'),200) else '' end,
  sheet_synced_at=case when version=p_version and p_success then clock_timestamp() else sheet_synced_at end,
  sheet_synced_version=case when version=p_version and p_success then p_version else sheet_synced_version end,
  sheet_expected_previous_row=case when version=p_version and p_success then null else sheet_expected_previous_row end,
  sheet_lease_token=null,sheet_lease_until=null,sheet_lease_version=null where owner_id=workspace_owner and id=p_id;
 return public.fd_read_intercompany_register();
end $$;

revoke all on function public.fd_begin_intercompany_sheet_sync(uuid),public.fd_end_intercompany_sheet_sync(uuid),public.fd_apply_intercompany_sheet_sync(uuid,integer,text,text,jsonb,jsonb),public.fd_claim_intercompany_sheet_for_sync(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fd_begin_intercompany_sheet_sync(uuid),public.fd_end_intercompany_sheet_sync(uuid),public.fd_apply_intercompany_sheet_sync(uuid,integer,text,text,jsonb,jsonb),public.fd_claim_intercompany_sheet_for_sync(uuid,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
