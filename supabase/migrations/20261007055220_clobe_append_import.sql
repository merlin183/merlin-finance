begin;

-- A server-origin capability, separate from OAuth encryption. No browser role
-- may read it. Provision CLOBE_IMPORT_SIGNING_KEY from this one generated row
-- through the administrator's MCP, never through an exposed RPC or migration.
create table private.fd_clobe_import_verifier(
 singleton boolean primary key default true check(singleton),
 signing_key text not null check(length(signing_key)=44),created_at timestamptz not null default now()
);
insert into private.fd_clobe_import_verifier(singleton,signing_key)
 values(true,encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'base64'));
alter table private.fd_clobe_import_verifier enable row level security;
revoke all on private.fd_clobe_import_verifier from public,anon,authenticated;

-- Standard HMAC-SHA256 (64-byte block, 32-byte key); built-in sha256 avoids a
-- pgcrypto dependency. Tested against Node's crypto HMAC over the exact wire
-- text: JSONB's reordered/space-normalized text is deliberately not signed.
create function private.fd_clobe_import_hmac(p_data text,p_key bytea) returns text
language plpgsql immutable strict security invoker set search_path='' as $$
declare ipad bytea:=decode(repeat('00',64),'hex');opad bytea:=decode(repeat('00',64),'hex');i integer;b integer;
begin
 if octet_length(p_key)<>32 then raise exception 'CLOBE_IMPORT_CONFIGURATION';end if;
 for i in 0..63 loop
  b:=case when i<32 then get_byte(p_key,i) else 0 end;
  ipad:=set_byte(ipad,i,b # 54);opad:=set_byte(opad,i,b # 92);
 end loop;
 return encode(sha256(opad||sha256(ipad||convert_to(p_data,'UTF8'))),'hex');
end $$;
revoke all on function private.fd_clobe_import_hmac(text,bytea) from public,anon,authenticated;

create table private.fd_clobe_import_previews(
 id uuid primary key,owner_id uuid not null references auth.users(id) on delete restrict,
 actor_id uuid not null references auth.users(id) on delete restrict,
 ciphertext text not null check(octet_length(ciphertext)<=8388608),scope jsonb not null,
 expires_at timestamptz not null,request_hash text check(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb,created_at timestamptz not null default now(),applied_at timestamptz
);
create index fd_clobe_import_previews_owner on private.fd_clobe_import_previews(owner_id,actor_id,expires_at);
alter table private.fd_clobe_import_previews enable row level security;
revoke all on private.fd_clobe_import_previews from public,anon,authenticated;

create table private.fd_clobe_account_mappings(
 owner_id uuid not null references auth.users(id) on delete restrict,
 company_id text not null,external_account_id text not null,account_id uuid not null,
 updated_at timestamptz not null default now(),
 primary key(owner_id,company_id,external_account_id),unique(owner_id,account_id),
 foreign key(owner_id,account_id) references public.fd_accounts(owner_id,id) on delete cascade
);
alter table private.fd_clobe_account_mappings enable row level security;
revoke all on private.fd_clobe_account_mappings from public,anon,authenticated;

create table private.fd_clobe_transaction_refs(
 owner_id uuid not null references auth.users(id) on delete restrict,
 company_id text not null,external_account_id text not null,external_transaction_id text not null,
 account_id uuid not null,transaction_id uuid not null,source_fingerprint text not null check(source_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 primary key(owner_id,company_id,external_account_id,external_transaction_id),
 unique(owner_id,company_id,external_account_id,transaction_id),
 foreign key(owner_id,account_id) references public.fd_accounts(owner_id,id) on delete cascade,
 foreign key(owner_id,transaction_id) references public.fd_transactions(owner_id,id) on delete cascade
);
create index fd_clobe_refs_account on private.fd_clobe_transaction_refs(owner_id,account_id);
alter table private.fd_clobe_transaction_refs enable row level security;
revoke all on private.fd_clobe_transaction_refs from public,anon,authenticated;

create function private.fd_clobe_import_core(p_action text,p_payload text,p_proof text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();workspace_owner uuid:=private.finance_workspace_owner();body jsonb;secret bytea;
 snapshot private.fd_clobe_import_previews;scope jsonb;m jsonb;c jsonb;r jsonb;e jsonb;category public.fd_categories;
 account public.fd_accounts;existing public.fd_transactions;request_id uuid;inserted integer:=0;referenced integer:=0;
 answer jsonb;unchanged integer;duplicates integer;blocked integer;start_date date;end_date date;
begin
 if actor is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if p_action not in ('settings','refs','store','read','apply') or p_action is null then raise exception 'CLOBE_IMPORT_INVALID_ACTION';end if;
 if p_payload is null or octet_length(p_payload)>12582912 or p_proof is null or p_proof !~ '^[a-f0-9]{64}$' then raise exception 'CLOBE_IMPORT_INVALID_PAYLOAD';end if;
 select decode(v.signing_key,'base64') into secret from private.fd_clobe_import_verifier v where v.singleton;
 if secret is null then raise exception 'CLOBE_IMPORT_CONFIGURATION';end if;
 if p_proof<>private.fd_clobe_import_hmac('merlin:clobe-import:v1'||E'\n'||p_action||E'\n'||actor::text||E'\n'||workspace_owner::text||E'\n'||p_payload,secret)
 then raise exception 'CLOBE_IMPORT_UNTRUSTED';end if;
 body:=p_payload::jsonb;if jsonb_typeof(body) is distinct from 'object' then raise exception 'CLOBE_IMPORT_INVALID_PAYLOAD';end if;
 if p_action='settings' then
  if body<>'{}'::jsonb then raise exception 'CLOBE_IMPORT_INVALID_PAYLOAD';end if;
  return jsonb_build_object('mappings',(select coalesce(jsonb_agg(jsonb_build_object('company_id',x.company_id,'external_account_id',x.external_account_id,'account_id',x.account_id) order by x.company_id,x.external_account_id),'[]'::jsonb) from private.fd_clobe_account_mappings x where x.owner_id=workspace_owner));
 end if;
 if p_action='refs' then
  if not(body?'account_ids') or exists(select 1 from jsonb_object_keys(body) k where k<>'account_ids') or jsonb_typeof(body->'account_ids') is distinct from 'array' or jsonb_array_length(body->'account_ids') not between 1 and 100 then raise exception 'CLOBE_IMPORT_INVALID_PAYLOAD';end if;
  if exists(select 1 from jsonb_array_elements_text(body->'account_ids') v where not exists(select 1 from public.fd_accounts a where a.owner_id=workspace_owner and a.id=v::uuid)) then raise exception 'CLOBE_IMPORT_SCOPE';end if;
  if (select count(*) from private.fd_clobe_transaction_refs x where x.owner_id=workspace_owner and x.account_id in(select v::uuid from jsonb_array_elements_text(body->'account_ids') v))>50000 then raise exception 'CLOBE_IMPORT_TOO_LARGE';end if;
  return (select coalesce(jsonb_agg(to_jsonb(x)-'owner_id'-'created_at'),'[]'::jsonb) from private.fd_clobe_transaction_refs x where x.owner_id=workspace_owner and x.account_id in(select v::uuid from jsonb_array_elements_text(body->'account_ids') v));
 end if;
 if p_action='store' then
  if not(body?&array['id','expires_at','ciphertext','scope']) or exists(select 1 from jsonb_object_keys(body) k where k not in ('id','expires_at','ciphertext','scope'))
   or jsonb_typeof(body->'ciphertext') is distinct from 'string' or octet_length(body->>'ciphertext') not between 40 and 8388608
   or body->>'ciphertext' !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'
  then raise exception 'CLOBE_IMPORT_INVALID_PAYLOAD';end if;
  if (body->>'expires_at')::timestamptz<=clock_timestamp() or (body->>'expires_at')::timestamptz>clock_timestamp()+interval '2 hours 5 minutes' then raise exception 'CLOBE_IMPORT_EXPIRED';end if;
  scope:=body->'scope';
 else
  if not(body?'id') or exists(select 1 from jsonb_object_keys(body) k where k not in (case when p_action='read' then 'id' else 'id' end,'request_hash','scope','changes','summary')) then raise exception 'CLOBE_IMPORT_INVALID_PAYLOAD';end if;
  if p_action='read' and body<>jsonb_build_object('id',body->'id') then raise exception 'CLOBE_IMPORT_INVALID_PAYLOAD';end if;
  select * into snapshot from private.fd_clobe_import_previews s where s.id=(body->>'id')::uuid and s.owner_id=workspace_owner and s.actor_id=actor for update;
  if snapshot.id is null then raise exception 'CLOBE_IMPORT_EXPIRED';end if;
  if p_action='read' then return jsonb_build_object('ciphertext',snapshot.ciphertext,'expires_at',snapshot.expires_at,'request_hash',snapshot.request_hash,'result',snapshot.result);end if;
  if not(body?&array['id','request_hash','scope','changes','summary']) or coalesce(body->>'request_hash','') !~ '^[a-f0-9]{64}$' then raise exception 'CLOBE_IMPORT_INVALID_PAYLOAD';end if;
  if snapshot.result is not null then
   if snapshot.request_hash is distinct from body->>'request_hash' then raise exception 'CLOBE_IMPORT_RUN_CONFLICT';end if;
   return snapshot.result;
  end if;
  if snapshot.expires_at<=clock_timestamp() then raise exception 'CLOBE_IMPORT_EXPIRED';end if;
  scope:=body->'scope';if scope is distinct from snapshot.scope then raise exception 'CLOBE_IMPORT_SCOPE';end if;
 end if;
 if jsonb_typeof(scope) is distinct from 'object' or not(scope?&array['connection_id','mappings','start_date','end_date'])
  or exists(select 1 from jsonb_object_keys(scope) k where k not in ('connection_id','mappings','start_date','end_date'))
  or scope->'connection_id' is distinct from 'null'::jsonb or jsonb_typeof(scope->'mappings') is distinct from 'array'
  or jsonb_array_length(scope->'mappings') not between 1 and 100 then raise exception 'CLOBE_IMPORT_SCOPE';end if;
 start_date:=(scope->>'start_date')::date;end_date:=(scope->>'end_date')::date;
 if start_date is null or end_date is null or start_date>end_date or start_date<'1900-01-01' or end_date>'2100-12-31' then raise exception 'CLOBE_IMPORT_SCOPE';end if;
 if (select count(distinct jsonb_build_array(v->>'company_id',v->>'external_account_id')) from jsonb_array_elements(scope->'mappings') v)<>jsonb_array_length(scope->'mappings')
  or (select count(distinct v->>'account_id') from jsonb_array_elements(scope->'mappings') v)<>jsonb_array_length(scope->'mappings') then raise exception 'CLOBE_IMPORT_SCOPE';end if;
 for m in select value from jsonb_array_elements(scope->'mappings') loop
  if jsonb_typeof(m) is distinct from 'object' or not(m?&array['company_id','external_account_id','account_id']) or exists(select 1 from jsonb_object_keys(m) k where k not in ('company_id','external_account_id','account_id'))
   or length(coalesce(m->>'company_id','')) not between 1 and 200 or coalesce(m->>'external_account_id','') !~ '^[1-9][0-9]{0,15}$'
   or not exists(select 1 from public.fd_accounts a where a.owner_id=workspace_owner and a.id=(m->>'account_id')::uuid) then raise exception 'CLOBE_IMPORT_SCOPE';end if;
  if exists(select 1 from private.fd_clobe_transaction_refs x where x.owner_id=workspace_owner and x.company_id=m->>'company_id' and x.external_account_id=m->>'external_account_id' and x.account_id<>(m->>'account_id')::uuid) then raise exception 'CLOBE_IMPORT_MAPPING_CHANGED';end if;
 end loop;
 if p_action='store' then
  -- Bound abandoned encrypted previews; completed runs remain idempotent.
  delete from private.fd_clobe_import_previews s where s.owner_id=workspace_owner and s.actor_id=actor and s.result is null and s.expires_at<=clock_timestamp();
  if (select count(*) from private.fd_clobe_import_previews s where s.owner_id=workspace_owner and s.actor_id=actor and s.result is null)>=10 then raise exception 'CLOBE_IMPORT_TOO_MANY_PREVIEWS';end if;
  insert into private.fd_clobe_import_previews(id,owner_id,actor_id,ciphertext,scope,expires_at) values((body->>'id')::uuid,workspace_owner,actor,body->>'ciphertext',scope,(body->>'expires_at')::timestamptz);
  return jsonb_build_object('id',body->>'id');
 end if;
 if jsonb_typeof(body->'changes') is distinct from 'array' or jsonb_array_length(body->'changes')>20000 or jsonb_typeof(body->'summary') is distinct from 'object'
  or exists(select 1 from jsonb_object_keys(body->'summary') k where k not in ('unchanged','sourceDuplicates','blocked')) then raise exception 'CLOBE_IMPORT_INVALID_PAYLOAD';end if;
 unchanged:=coalesce((body->'summary'->>'unchanged')::integer,0);duplicates:=coalesce((body->'summary'->>'sourceDuplicates')::integer,0);blocked:=coalesce((body->'summary'->>'blocked')::integer,0);
 if unchanged<0 or duplicates<0 or blocked<0 or unchanged>20000 or duplicates>20000 or blocked>20000 then raise exception 'CLOBE_IMPORT_INVALID_PAYLOAD';end if;
 if (select count(distinct jsonb_build_array(v->>'company_id',v->>'external_account_id',v->>'external_transaction_id')) from jsonb_array_elements(body->'changes') v)<>jsonb_array_length(body->'changes')
  or (select count(distinct v->>'transaction_id') from jsonb_array_elements(body->'changes') v)<>jsonb_array_length(body->'changes') then raise exception 'CLOBE_IMPORT_INVALID_PAYLOAD';end if;
 -- Same lock namespace/order as spreadsheet and Excel imports.
 for account in select a.* from public.fd_accounts a where a.owner_id=workspace_owner and a.id in(select (wanted->>'account_id')::uuid from jsonb_array_elements(scope->'mappings') wanted) order by a.id loop
  perform pg_advisory_xact_lock(hashtextextended('fd_account:'||account.id::text,0));
 end loop;
 perform a.id from public.fd_accounts a where a.owner_id=workspace_owner and a.id in(select (wanted->>'account_id')::uuid from jsonb_array_elements(scope->'mappings') wanted) order by a.id for update;
 for c in select value from jsonb_array_elements(body->'changes') loop
  if jsonb_typeof(c) is distinct from 'object' or not(c?&array['kind','company_id','external_account_id','external_transaction_id','account_id','transaction_id','source_fingerprint','row','expected'])
   or exists(select 1 from jsonb_object_keys(c) k where k not in ('kind','company_id','external_account_id','external_transaction_id','account_id','transaction_id','source_fingerprint','expected_candidates','row','expected'))
   or coalesce(c->>'kind','') not in ('insert','reference') or coalesce(c->>'source_fingerprint','') !~ '^[a-f0-9]{64}$'
   or coalesce(c->>'external_transaction_id','') !~ '^[1-9][0-9]{0,15}$'
   or not exists(select 1 from jsonb_array_elements(scope->'mappings') wanted where wanted->>'company_id'=c->>'company_id' and wanted->>'external_account_id'=c->>'external_account_id' and wanted->>'account_id'=c->>'account_id') then raise exception 'CLOBE_IMPORT_SCOPE';end if;
  r:=c->'row';e:=c->'expected';request_id:=(c->>'transaction_id')::uuid;
  if jsonb_typeof(r) is distinct from 'object' or not(r?&array['txn_date','txn_time','amount','direction','balance','description','raw_gwamok','category_id','is_internal','dedup_hash','tax_invoice','manually_classified','source_details'])
   or exists(select 1 from jsonb_object_keys(r) k where k not in ('txn_date','txn_time','amount','direction','balance','description','raw_gwamok','category_id','is_internal','dedup_hash','tax_invoice','manually_classified','source_details'))
   or (r->>'txn_date')::date not between start_date and end_date or coalesce(r->>'direction','') not in ('in','out') or coalesce(r->>'raw_gwamok','!')<>''
   or coalesce(r->>'amount','') !~ '^[1-9][0-9]{0,15}$' or (r->>'amount')::numeric>9007199254740991
   or (r->>'txn_time' is not null and r->>'txn_time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$')
   or jsonb_typeof(r->'description') is distinct from 'string' or length(r->>'description')>1000 or coalesce(r->>'dedup_hash','') !~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
   or jsonb_typeof(r->'is_internal') is distinct from 'boolean' or r->'tax_invoice' is distinct from 'false'::jsonb or jsonb_typeof(r->'manually_classified') is distinct from 'boolean'
   or not private.fd_valid_source_details(r->'source_details') or (r->'source_details'?'provenance') then raise exception 'CLOBE_IMPORT_INVALID_ROW';end if;
  select a.* into strict account from public.fd_accounts a where a.owner_id=workspace_owner and a.id=(c->>'account_id')::uuid;
  if jsonb_typeof(c->'expected_candidates') is distinct from 'array' or jsonb_array_length(c->'expected_candidates')>50000
   or exists(select 1 from jsonb_array_elements_text(c->'expected_candidates') baseline_id where baseline_id !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
   or c->'expected_candidates' is distinct from (select coalesce(jsonb_agg(t.id::text order by t.id::text),'[]'::jsonb) from public.fd_transactions t
    where t.owner_id=workspace_owner and t.account_id=account.id and t.txn_date=(r->>'txn_date')::date and t.direction=r->>'direction' and t.amount=(r->>'amount')::bigint
     and t.id not in(select (batch_row->>'transaction_id')::uuid from jsonb_array_elements(body->'changes') batch_row where batch_row->>'kind'='insert'))
  then raise exception 'CLOBE_IMPORT_STALE';end if;
  if exists(select 1 from private.fd_clobe_transaction_refs x where x.owner_id=workspace_owner and x.company_id=c->>'company_id' and x.external_account_id=c->>'external_account_id' and x.external_transaction_id=c->>'external_transaction_id') then raise exception 'CLOBE_IMPORT_STALE';end if;
  if c->>'kind'='reference' then
   select t.* into existing from public.fd_transactions t where t.owner_id=workspace_owner and t.id=request_id and t.account_id=account.id for update;
   if existing.id is null or jsonb_typeof(e) is distinct from 'object' or e is distinct from jsonb_build_object('account_id',existing.account_id,'txn_date',existing.txn_date,'txn_time',existing.txn_time,'amount',existing.amount,'direction',existing.direction,'balance',existing.balance,'description',existing.description,'source_details',existing.source_details)
   then raise exception 'CLOBE_IMPORT_STALE';end if;
   -- Preserve EVERY field, including category, notes, upload and transfer links.
   referenced:=referenced+1;
  else
   if e is distinct from 'null'::jsonb then raise exception 'CLOBE_IMPORT_STALE';end if;
   category:=null;
   if r->>'category_id' is not null then
    select x.* into category from public.fd_categories x where x.owner_id=workspace_owner and x.id=(r->>'category_id')::uuid;
    -- Optional historical-completion dates belong to the installer's server
    -- classification policy, whose exact payload was authenticated above.
    if category.id is null or category.name='입금' and r->>'direction'<>'in' or category.name='출금' and r->>'direction'<>'out'
     or category.is_internal is distinct from (r->>'is_internal')::boolean then raise exception 'CLOBE_IMPORT_CATEGORY';end if;
   elsif r->'is_internal' is distinct from 'false'::jsonb then raise exception 'CLOBE_IMPORT_CATEGORY';end if;
   insert into public.fd_transactions(id,owner_id,business_id,account_id,upload_id,txn_date,txn_time,amount,direction,description,raw_gwamok,category_id,is_internal,balance,tax_invoice,dedup_hash,manually_classified,source_details)
    values(request_id,workspace_owner,account.business_id,account.id,null,(r->>'txn_date')::date,r->>'txn_time',(r->>'amount')::bigint,r->>'direction',r->>'description','',(r->>'category_id')::uuid,(r->>'is_internal')::boolean,(r->>'balance')::bigint,false,r->>'dedup_hash',(r->>'manually_classified')::boolean,nullif(r->'source_details','null'::jsonb));
   inserted:=inserted+1;
  end if;
  insert into private.fd_clobe_transaction_refs(owner_id,company_id,external_account_id,external_transaction_id,account_id,transaction_id,source_fingerprint)
   values(workspace_owner,c->>'company_id',c->>'external_account_id',c->>'external_transaction_id',account.id,request_id,c->>'source_fingerprint');
 end loop;
 for m in select value from jsonb_array_elements(scope->'mappings') loop
  insert into private.fd_clobe_account_mappings(owner_id,company_id,external_account_id,account_id) values(workspace_owner,m->>'company_id',m->>'external_account_id',(m->>'account_id')::uuid)
   on conflict(owner_id,company_id,external_account_id) do update set account_id=excluded.account_id,updated_at=clock_timestamp();
 end loop;
 answer:=jsonb_build_object('run_id',snapshot.id,'inserted',inserted,'referenced',referenced,'unchanged',unchanged,'sourceDuplicates',duplicates,'blocked',blocked,'updated',0,'removed',0);
 update private.fd_clobe_import_previews s set request_hash=body->>'request_hash',result=answer,applied_at=clock_timestamp(),ciphertext='v1.applied.applied.applied' where s.id=snapshot.id;
 insert into public.fd_audit_log(owner_id,action,detail) values(workspace_owner,'clobe_import','Clobe 신규 거래 '||inserted||'건 추가 · 기존 연결 '||referenced||'건 · 기존 수정/삭제 0건');
 return answer;
end $$;
revoke all on function private.fd_clobe_import_core(text,text,text) from public,anon,authenticated;
grant execute on function private.fd_clobe_import_core(text,text,text) to authenticated;
create function public.fd_clobe_import(p_action text,p_payload text,p_proof text) returns jsonb
language sql security invoker set search_path='' as $$select private.fd_clobe_import_core(p_action,p_payload,p_proof)$$;
revoke all on function public.fd_clobe_import(text,text,text) from public,anon,authenticated;
grant execute on function public.fd_clobe_import(text,text,text) to authenticated;

commit;
