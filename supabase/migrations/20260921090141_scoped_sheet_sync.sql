begin;

-- Automation receives one revocable, source-scoped capability. It never receives
-- a service-role key, an administrator session, or permission to manage members.
create function private.fd_valid_sync_fingerprints(p_value jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
 if jsonb_typeof(p_value) is distinct from 'array' then return false;end if;
 if jsonb_array_length(p_value)>20000 or octet_length(p_value::text)>2700000 then return false;end if;
 if exists(select 1 from jsonb_array_elements(p_value) v where jsonb_typeof(v) is distinct from 'string'
  or (v #>> '{}') !~ '^[a-f0-9]{64}:[a-f0-9]{64}$') then return false;end if;
 return jsonb_array_length(p_value)=(select count(distinct v) from jsonb_array_elements_text(p_value) v);
end $$;
revoke all on function private.fd_valid_sync_fingerprints(jsonb) from public,anon,authenticated;

create table private.fd_sheet_sync_sources(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 created_by uuid not null references auth.users(id) on delete restrict,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 source_url text not null check(source_url ~ '^https://docs[.]google[.]com/spreadsheets/d/[A-Za-z0-9_-]{20,120}/edit$'),
 mappings jsonb not null,
 enabled boolean not null default false,
 source_fingerprints jsonb not null default '[]'::jsonb check(private.fd_valid_sync_fingerprints(source_fingerprints)),
 last_run_at timestamptz,
 last_result jsonb,
 last_error text check(last_error is null or last_error ~ '^[A-Z][A-Z0-9_]{0,79}$'),
 created_at timestamptz not null default now(),
 unique(owner_id,source_url)
);
alter table private.fd_sheet_sync_sources enable row level security;
revoke all on private.fd_sheet_sync_sources from public,anon,authenticated;

create function private.fd_validate_sheet_sync_source() returns trigger
language plpgsql security invoker set search_path='' as $$
declare mapping jsonb;
begin
 if not exists(select 1 from private.finance_workspace w where w.singleton and w.data_owner_id=new.owner_id)
  or not exists(select 1 from private.finance_administrators a where a.user_id=new.created_by and a.status='active')
 then raise exception 'SHEET_SYNC_ADMIN_REQUIRED';end if;
 if jsonb_typeof(new.mappings) is distinct from 'array' then raise exception 'SHEET_SYNC_INVALID_MAPPINGS';end if;
 if jsonb_array_length(new.mappings)<1 or jsonb_array_length(new.mappings)>40 or octet_length(new.mappings::text)>20000
 then raise exception 'SHEET_SYNC_INVALID_MAPPINGS';end if;
 for mapping in select value from jsonb_array_elements(new.mappings) loop
  if jsonb_typeof(mapping) is distinct from 'object' or not (mapping ?& array['sheet','account_id','selected'])
   or exists(select 1 from jsonb_object_keys(mapping) k where k not in ('sheet','account_id','selected'))
   or jsonb_typeof(mapping->'sheet') is distinct from 'string' or length(btrim(mapping->>'sheet')) not between 1 and 200
   or jsonb_typeof(mapping->'selected') is distinct from 'boolean'
   or (mapping->>'account_id' is not null and coalesce(mapping->>'account_id','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
  then raise exception 'SHEET_SYNC_INVALID_MAPPINGS';end if;
  if (mapping->>'selected')::boolean and mapping->>'account_id' is null then raise exception 'SHEET_SYNC_ACCOUNT_REQUIRED';end if;
  if mapping->>'account_id' is not null and not exists(select 1 from public.fd_accounts a
   where a.owner_id=new.owner_id and a.id=(mapping->>'account_id')::uuid)
  then raise exception 'SHEET_SYNC_ACCOUNT_REQUIRED';end if;
 end loop;
 if not exists(select 1 from jsonb_array_elements(new.mappings) m where (m->>'selected')::boolean)
  or (select count(distinct m->>'sheet') from jsonb_array_elements(new.mappings) m)<>jsonb_array_length(new.mappings)
 then raise exception 'SHEET_SYNC_INVALID_MAPPINGS';end if;
 -- A mapping/credential change establishes a new reviewed scope; old checkpoints
 -- must not suppress rows belonging to the newly configured scope.
 if tg_op='UPDATE' and row(new.owner_id,new.source_url,new.mappings) is distinct from row(old.owner_id,old.source_url,old.mappings)
 then new.source_fingerprints:='[]'::jsonb;end if;
 return new;
end $$;
revoke all on function private.fd_validate_sheet_sync_source() from public,anon,authenticated;
create trigger fd_validate_sheet_sync_source before insert or update of owner_id,created_by,source_url,mappings
 on private.fd_sheet_sync_sources for each row execute function private.fd_validate_sheet_sync_source();

-- Extract the already-applied merge implementation, including later metadata
-- preservation and advisory locking. Fail rather than silently dropping a patch.
do $$
declare definition text;anchor text;replacement text;pair record;
begin
 definition:=replace(pg_get_functiondef('public.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 if (select prosecdef from pg_proc where oid='public.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb)'::regprocedure)
  or position('source_details' in definition)=0 or position('pg_advisory_xact_lock' in definition)=0
 then raise exception 'SHEET_SYNC_UNEXPECTED_MERGE_DEFINITION';end if;
 for pair in select * from (values
  ('CREATE OR REPLACE FUNCTION public.fd_apply_sheet_import(', 'CREATE OR REPLACE FUNCTION private.fd_apply_sheet_import_core(p_owner uuid, '),
  ('workspace_owner uuid:=private.finance_workspace_owner();','workspace_owner uuid:=p_owner;'),
  ('if auth.uid() is null or workspace_owner is null then raise exception ''ADMIN_REQUIRED'';end if;',
   'if workspace_owner is null then raise exception ''SHEET_OWNER_REQUIRED'';end if;')
 ) pairs(old,new) loop
  anchor:=pair.old;replacement:=pair.new;
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
  then raise exception 'SHEET_SYNC_MERGE_ANCHOR_MISSING';end if;
  definition:=replace(definition,anchor,replacement);
 end loop;
 execute definition;
end $$;
revoke all on function private.fd_apply_sheet_import_core(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;

-- Human imports retain their original authorization and public RPC signature.
-- Only this checked wrapper and the capability wrapper can reach the core.
create or replace function public.fd_apply_sheet_import(p_run uuid,p_source_url text,p_source_hash text,p_changes jsonb,p_summary jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 return private.fd_apply_sheet_import_core(workspace_owner,p_run,p_source_url,p_source_hash,p_changes,p_summary);
end $$;
revoke all on function public.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb) to authenticated;

create function private.fd_sheet_sync_authorize(p_token text) returns private.fd_sheet_sync_sources
language plpgsql security invoker set search_path='' as $$
declare source private.fd_sheet_sync_sources;
begin
 if p_token is null or length(p_token) not between 32 and 256 or p_token !~ '^[A-Za-z0-9_-]+$' then raise exception 'SHEET_SYNC_UNAUTHORIZED';end if;
 select s.* into source from private.fd_sheet_sync_sources s
 where s.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') and s.enabled;
 if source.id is null
  or not exists(select 1 from private.finance_workspace w where w.singleton and w.data_owner_id=source.owner_id)
  or not exists(select 1 from private.finance_administrators a where a.user_id=source.created_by and a.status='active')
 then raise exception 'SHEET_SYNC_UNAUTHORIZED';end if;
 if exists(select 1 from jsonb_array_elements(source.mappings) m where (m->>'selected')::boolean
  and not exists(select 1 from public.fd_accounts a where a.owner_id=source.owner_id and a.id=(m->>'account_id')::uuid))
 then raise exception 'SHEET_SYNC_ACCOUNT_REQUIRED';end if;
 return source;
end $$;
revoke all on function private.fd_sheet_sync_authorize(text) from public,anon,authenticated;

create function public.fd_sheet_sync_context(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare source private.fd_sheet_sync_sources;accounts uuid[];dataset jsonb;
begin
 source:=private.fd_sheet_sync_authorize(p_token);
 select array_agg(distinct (m->>'account_id')::uuid) into accounts
 from jsonb_array_elements(source.mappings) m where (m->>'selected')::boolean;
 -- Never silently truncate history: omitted rows would invalidate deduplication.
 if (select count(*) from public.fd_transactions t where t.owner_id=source.owner_id and t.account_id=any(accounts))>50000
 then raise exception 'SHEET_SYNC_DATASET_TOO_LARGE';end if;
 select jsonb_build_object(
  'businesses',(select coalesce(jsonb_agg(to_jsonb(b)-'owner_id'-'created_at' order by b.id),'[]'::jsonb) from public.fd_businesses b
   where b.owner_id=source.owner_id and exists(select 1 from public.fd_accounts a where a.owner_id=source.owner_id and a.business_id=b.id and a.id=any(accounts))),
  'accounts',(select coalesce(jsonb_agg(to_jsonb(a)-'owner_id'-'created_at' order by a.id),'[]'::jsonb) from public.fd_accounts a where a.owner_id=source.owner_id and a.id=any(accounts)),
  'categories',(select coalesce(jsonb_agg(to_jsonb(c)-'owner_id'-'created_at' order by c.id),'[]'::jsonb) from public.fd_categories c where c.owner_id=source.owner_id),
  'rules',(select coalesce(jsonb_agg(to_jsonb(r)-'owner_id'-'created_at' order by r.id),'[]'::jsonb) from public.fd_category_rules r where r.owner_id=source.owner_id and (r.account_id is null or r.account_id=any(accounts))),
  'aliases',(select coalesce(jsonb_agg(to_jsonb(a)-'owner_id'-'created_at' order by a.id),'[]'::jsonb) from public.fd_gwamok_aliases a where a.owner_id=source.owner_id),
  'transactions',(select coalesce(jsonb_agg(to_jsonb(t)-'owner_id'-'created_at' order by t.id),'[]'::jsonb) from public.fd_transactions t where t.owner_id=source.owner_id and t.account_id=any(accounts)),
  'notes',(select coalesce(jsonb_agg(to_jsonb(n)-'owner_id'-'created_at' order by n.id),'[]'::jsonb) from public.fd_merchant_notes n where n.owner_id=source.owner_id and n.account_id=any(accounts)),
  'links',(select coalesce(jsonb_agg(to_jsonb(l)-'owner_id'-'created_at' order by l.id),'[]'::jsonb) from public.fd_inter_company_links l where l.owner_id=source.owner_id
   and exists(select 1 from public.fd_transactions t where t.owner_id=source.owner_id and t.account_id=any(accounts) and t.id in(l.out_transaction_id,l.in_transaction_id))),
  'recurring','[]'::jsonb,'uploads','[]'::jsonb,'audit','[]'::jsonb
 ) into dataset;
 if octet_length(dataset::text)>16777216 then raise exception 'SHEET_SYNC_DATASET_TOO_LARGE';end if;
 return jsonb_build_object('source_id',source.id,'source_url',source.source_url,'mappings',source.mappings,'source_fingerprints',source.source_fingerprints,'dataset',dataset);
end $$;
revoke all on function public.fd_sheet_sync_context(text) from public,anon,authenticated;
grant execute on function public.fd_sheet_sync_context(text) to anon,authenticated;

create function public.fd_apply_sheet_sync(p_token text,p_run uuid,p_source_hash text,p_changes jsonb,p_summary jsonb,p_fingerprints jsonb default null,p_expected_fingerprints jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare source private.fd_sheet_sync_sources;change jsonb;duplicate jsonb;answer jsonb;
begin
 source:=private.fd_sheet_sync_authorize(p_token);
 -- Serialize sync apply/checkpoint writes, and prevent revocation or scope edits
 -- during this transaction. Recheck the capability after acquiring the lock.
 perform 1 from private.fd_sheet_sync_sources where id=source.id for update;
 source:=private.fd_sheet_sync_authorize(p_token);
 if p_fingerprints is not null and not private.fd_valid_sync_fingerprints(p_fingerprints)
  then raise exception 'SHEET_SYNC_INVALID_FINGERPRINTS';end if;
 if p_expected_fingerprints is not null and not private.fd_valid_sync_fingerprints(p_expected_fingerprints)
  then raise exception 'SHEET_SYNC_INVALID_FINGERPRINTS';end if;
 if p_fingerprints is not null and (p_expected_fingerprints is null or source.source_fingerprints is distinct from p_expected_fingerprints) then
  -- A retry of the exact committed run may acknowledge its existing checkpoint.
  -- A different or stale run must not replace newer per-source progress.
  if p_fingerprints is distinct from source.source_fingerprints or not exists(select 1 from public.fd_sheet_imports r
   where r.id=p_run and r.owner_id=source.owner_id and r.source_url=source.source_url and r.source_hash=p_source_hash
    and r.changes->'request'=p_changes and r.result is not null)
  then raise exception 'SHEET_SYNC_STALE_CHECKPOINT';end if;
 end if;
 if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'SHEET_INVALID_PAYLOAD';end if;
 if jsonb_array_length(p_changes)>20000 then raise exception 'SHEET_INVALID_PAYLOAD';end if;
 for change in select value from jsonb_array_elements(p_changes) loop
  if jsonb_typeof(change) is distinct from 'object' or jsonb_typeof(change->'row') is distinct from 'object'
   or jsonb_typeof(change->'duplicates') is distinct from 'array'
   or not exists(select 1 from jsonb_array_elements(source.mappings) m where (m->>'selected')::boolean
    and m->>'account_id'=change->>'account_id' and m->>'sheet'=change->'row'->>'source_sheet')
  then raise exception 'SHEET_SYNC_SCOPE_MISMATCH';end if;
  if change->'row' ?| array['owner_id','business_id','account_id','id'] then raise exception 'SHEET_SYNC_SCOPE_MISMATCH';end if;
  if change->'row'->'source_details'->'provenance'->>'url' is not null
   and change->'row'->'source_details'->'provenance'->>'url'<>source.source_url
  then raise exception 'SHEET_SYNC_SOURCE_MISMATCH';end if;
  if change->'row'->'source_details'->'provenance'->>'sheet' is not null
   and change->'row'->'source_details'->'provenance'->>'sheet'<>change->'row'->>'source_sheet'
  then raise exception 'SHEET_SYNC_SOURCE_MISMATCH';end if;
  if change->>'kind'='update' and (change->'expected'->>'account_id' is distinct from change->>'account_id'
   or change->'expected'->>'id' is distinct from change->>'id') then raise exception 'SHEET_SYNC_SCOPE_MISMATCH';end if;
  if change->>'kind'='update' and not exists(select 1 from public.fd_transactions t where t.owner_id=source.owner_id
   and t.id=(change->>'id')::uuid and t.account_id=(change->>'account_id')::uuid)
  then raise exception 'SHEET_SYNC_SCOPE_MISMATCH';end if;
  for duplicate in select value from jsonb_array_elements(change->'duplicates') loop
   if duplicate->'expected'->>'account_id' is distinct from change->>'account_id'
    or duplicate->'expected'->>'id' is distinct from duplicate->>'id'
    or not exists(select 1 from public.fd_transactions t where t.owner_id=source.owner_id
     and t.id=(duplicate->>'id')::uuid and t.account_id=(change->>'account_id')::uuid)
   then raise exception 'SHEET_SYNC_SCOPE_MISMATCH';end if;
  end loop;
  -- Automatic ingestion cannot delete financial records. Human-reviewed sheet
  -- imports retain the original, evidence-based duplicate cleanup capability.
  if jsonb_array_length(change->'duplicates')>0 then raise exception 'SHEET_SYNC_DUPLICATE_REVIEW';end if;
 end loop;
 answer:=private.fd_apply_sheet_import_core(source.owner_id,p_run,source.source_url,p_source_hash,p_changes,p_summary);
 update private.fd_sheet_sync_sources set last_run_at=now(),last_result=answer,last_error=null,
  source_fingerprints=coalesce(p_fingerprints,source_fingerprints) where id=source.id;
 return answer;
end $$;
revoke all on function public.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb) to anon,authenticated;

create function public.fd_sheet_sync_finish(p_token text,p_result jsonb,p_error text default null,p_fingerprints jsonb default null,p_expected_fingerprints jsonb default null) returns void
language plpgsql security definer set search_path='' as $$
declare source private.fd_sheet_sync_sources;result jsonb:='{}'::jsonb;key text;safe_error text;
begin
 source:=private.fd_sheet_sync_authorize(p_token);
 perform 1 from private.fd_sheet_sync_sources where id=source.id for update;
 source:=private.fd_sheet_sync_authorize(p_token);
 if p_result is not null and jsonb_typeof(p_result) is distinct from 'object' then raise exception 'SHEET_SYNC_INVALID_RESULT';end if;
 if p_fingerprints is not null and not private.fd_valid_sync_fingerprints(p_fingerprints) then raise exception 'SHEET_SYNC_INVALID_FINGERPRINTS';end if;
 if p_expected_fingerprints is not null and not private.fd_valid_sync_fingerprints(p_expected_fingerprints) then raise exception 'SHEET_SYNC_INVALID_FINGERPRINTS';end if;
 if p_error is null and p_fingerprints is not null and (p_expected_fingerprints is null or source.source_fingerprints is distinct from p_expected_fingerprints)
 then raise exception 'SHEET_SYNC_STALE_CHECKPOINT';end if;
 foreach key in array array['inserted','updated','removed','unchanged','sourceDuplicates','blocked'] loop
  if p_result ? key then
   if jsonb_typeof(p_result->key) is distinct from 'number' or (p_result->>key) !~ '^(0|[1-9][0-9]{0,8})$'
   then raise exception 'SHEET_SYNC_INVALID_RESULT';end if;
   result:=result||jsonb_build_object(key,p_result->key);
  end if;
 end loop;
 if p_result ? 'run_id' then
  if jsonb_typeof(p_result->'run_id') is distinct from 'string' or (p_result->>'run_id') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  then raise exception 'SHEET_SYNC_INVALID_RESULT';end if;
  result:=result||jsonb_build_object('run_id',p_result->'run_id');
 end if;
 if p_result->>'status' in ('completed','unchanged','partial','failed','skipped') then result:=result||jsonb_build_object('status',p_result->>'status');end if;
 safe_error:=case when p_error is null then null when p_error ~ '^[A-Z][A-Z0-9_]{0,79}$' then p_error else 'SHEET_SYNC_FAILED' end;
 update private.fd_sheet_sync_sources set last_run_at=now(),last_result=result,last_error=safe_error,
  source_fingerprints=case when p_error is null then coalesce(p_fingerprints,source_fingerprints) else source_fingerprints end
 where id=source.id;
end $$;
revoke all on function public.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb) to anon,authenticated;

create function public.fd_sheet_sync_status() returns jsonb
language plpgsql security definer set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();answer jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select coalesce(jsonb_agg(jsonb_build_object('source_id',s.id,'source_url',s.source_url,'mappings',s.mappings,
  'enabled',s.enabled,'last_run_at',s.last_run_at,'last_result',s.last_result,'last_error',s.last_error) order by s.created_at,s.id),'[]'::jsonb)
 into answer from private.fd_sheet_sync_sources s where s.owner_id=workspace_owner;
 return answer;
end $$;
revoke all on function public.fd_sheet_sync_status() from public,anon,authenticated;
grant execute on function public.fd_sheet_sync_status() to authenticated;

notify pgrst,'reload schema';
commit;
