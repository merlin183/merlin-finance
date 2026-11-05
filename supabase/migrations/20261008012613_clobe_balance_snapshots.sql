begin;

-- Collected balances are an independent source observation. They never
-- rewrite a transaction, opening balance, category, memo or expenditure plan.
create table private.fd_clobe_balance_snapshots(
 owner_id uuid not null references auth.users(id) on delete restrict,
 account_id uuid not null,business_id uuid not null,
 company_id text not null,external_account_id text not null,
 balance bigint not null check(abs(balance::numeric)<=9007199254740991),
 balance_date date not null,collected_at text not null,
 collected_order timestamptz not null,synced_at timestamptz not null default clock_timestamp(),
 currency text not null default 'KRW' check(currency='KRW'),
 source text not null default 'clobe' check(source='clobe'),
 primary key(owner_id,account_id),unique(owner_id,company_id,external_account_id),
 foreign key(owner_id,business_id,account_id) references public.fd_accounts(owner_id,business_id,id) on delete cascade,
 check(balance_date::text=left(collected_at,10)),
 check(collected_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})?$')
);
alter table private.fd_clobe_balance_snapshots enable row level security;
revoke all on private.fd_clobe_balance_snapshots from public,anon,authenticated;

create function private.fd_clobe_balance_sync_core(p_payload text,p_proof text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();workspace_owner uuid:=private.finance_workspace_owner();body jsonb;secret bytea;
 r jsonb;account public.fd_accounts;previous private.fd_clobe_balance_snapshots;
 source_order timestamptz;source_date date;synced integer:=0;unchanged integer:=0;affected integer;
 skipped jsonb:='[]'::jsonb;
begin
 if actor is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if p_payload is null or octet_length(p_payload)>131072 or p_proof is null or p_proof !~ '^[a-f0-9]{64}$' then raise exception 'CLOBE_BALANCE_INVALID_PAYLOAD';end if;
 select decode(v.signing_key,'base64') into secret from private.fd_clobe_import_verifier v where v.singleton;
 if secret is null then raise exception 'CLOBE_BALANCE_CONFIGURATION';end if;
 -- This purpose differs from settings/preview/apply. Their signed payloads
 -- cannot be replayed here, or against a different actor/shared workspace.
 if p_proof<>private.fd_clobe_import_hmac('merlin:clobe-import:v1'||E'\n'||'balance-sync'||E'\n'||actor::text||E'\n'||workspace_owner::text||E'\n'||p_payload,secret)
 then raise exception 'CLOBE_BALANCE_UNTRUSTED';end if;
 body:=p_payload::jsonb;
 if jsonb_typeof(body) is distinct from 'object' or not(body?'snapshots') or exists(select 1 from jsonb_object_keys(body) k where k<>'snapshots')
  or jsonb_typeof(body->'snapshots') is distinct from 'array' or jsonb_array_length(body->'snapshots')>100
 then raise exception 'CLOBE_BALANCE_INVALID_PAYLOAD';end if;
 if (select count(distinct item->>'account_id') from jsonb_array_elements(body->'snapshots') item)<>jsonb_array_length(body->'snapshots')
  or (select count(distinct jsonb_build_array(item->>'company_id',item->>'external_account_id')) from jsonb_array_elements(body->'snapshots') item)<>jsonb_array_length(body->'snapshots')
 then raise exception 'CLOBE_BALANCE_INVALID_PAYLOAD';end if;
 -- Validate the complete bounded batch before persisting any observation.
 for r in select value from jsonb_array_elements(body->'snapshots') loop
  if jsonb_typeof(r) is distinct from 'object' or not(r?&array['company_id','external_account_id','account_id','balance','balance_date','collected_at'])
   or exists(select 1 from jsonb_object_keys(r) k where k not in ('company_id','external_account_id','account_id','balance','balance_date','collected_at'))
   or jsonb_typeof(r->'company_id') is distinct from 'string' or length(r->>'company_id') not between 1 and 200
   or jsonb_typeof(r->'external_account_id') is distinct from 'string' or coalesce(r->>'external_account_id','') !~ '^[1-9][0-9]{0,15}$'
   or jsonb_typeof(r->'account_id') is distinct from 'string' or coalesce(r->>'account_id','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   or jsonb_typeof(r->'balance') is distinct from 'number' or coalesce(r->>'balance','') !~ '^-?(0|[1-9][0-9]{0,15})$'
   or abs((r->>'balance')::numeric)>9007199254740991
   or jsonb_typeof(r->'balance_date') is distinct from 'string' or coalesce(r->>'balance_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   or jsonb_typeof(r->'collected_at') is distinct from 'string' or coalesce(r->>'collected_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,9})?(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])?$'
   or left(r->>'collected_at',10) is distinct from r->>'balance_date'
  then raise exception 'CLOBE_BALANCE_INVALID_PAYLOAD';end if;
  source_date:=(r->>'balance_date')::date;
  if source_date<'1900-01-01' or source_date>'2100-12-31' or source_date>(clock_timestamp() at time zone 'Asia/Seoul')::date then raise exception 'CLOBE_BALANCE_INVALID_PAYLOAD';end if;
  -- Preserve collected_at and its calendar date verbatim. The timezone here
  -- is used only for monotonic ordering/future guards, never as display data.
  source_order:=case when r->>'collected_at' ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then (r->>'collected_at')::timestamptz
   else (r->>'collected_at')::timestamp at time zone 'Asia/Seoul' end;
  if source_order>clock_timestamp()+interval '5 minutes' then raise exception 'CLOBE_BALANCE_INVALID_PAYLOAD';end if;
 end loop;
 -- Join existing importer locks so mappings cannot change mid-save. Locks
 -- are acquired in stable account order for concurrent multi-account runs.
 perform pg_advisory_xact_lock(hashtextextended('fd_account:'||a.id::text,0)) from public.fd_accounts a
  where a.owner_id=workspace_owner and a.id in(select (item->>'account_id')::uuid from jsonb_array_elements(body->'snapshots') item) order by a.id;
 perform a.id from public.fd_accounts a where a.owner_id=workspace_owner
  and a.id in(select (item->>'account_id')::uuid from jsonb_array_elements(body->'snapshots') item) order by a.id for update;
 perform m.account_id from private.fd_clobe_account_mappings m where m.owner_id=workspace_owner
  and m.account_id in(select (item->>'account_id')::uuid from jsonb_array_elements(body->'snapshots') item) order by m.account_id for update;
 for r in select value from jsonb_array_elements(body->'snapshots') loop
  select a.* into account from public.fd_accounts a join private.fd_clobe_account_mappings m on m.owner_id=a.owner_id and m.account_id=a.id
   where a.owner_id=workspace_owner and a.id=(r->>'account_id')::uuid and m.company_id=r->>'company_id' and m.external_account_id=r->>'external_account_id';
  if account.id is null then raise exception 'CLOBE_BALANCE_SCOPE';end if;
 end loop;
 for r in select value from jsonb_array_elements(body->'snapshots') order by value->>'account_id' loop
  select a.* into strict account from public.fd_accounts a where a.owner_id=workspace_owner and a.id=(r->>'account_id')::uuid;
  source_order:=case when r->>'collected_at' ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then (r->>'collected_at')::timestamptz
   else (r->>'collected_at')::timestamp at time zone 'Asia/Seoul' end;
  insert into private.fd_clobe_balance_snapshots(owner_id,account_id,business_id,company_id,external_account_id,balance,balance_date,collected_at,collected_order)
   values(workspace_owner,account.id,account.business_id,r->>'company_id',r->>'external_account_id',(r->>'balance')::bigint,(r->>'balance_date')::date,r->>'collected_at',source_order)
   on conflict(owner_id,account_id) do nothing;
  get diagnostics affected=row_count;
  if affected=1 then synced:=synced+1;continue;end if;
  select s.* into strict previous from private.fd_clobe_balance_snapshots s where s.owner_id=workspace_owner and s.account_id=account.id for update;
  if previous.company_id is distinct from r->>'company_id' or previous.external_account_id is distinct from r->>'external_account_id' then raise exception 'CLOBE_BALANCE_SCOPE';end if;
  if source_order<previous.collected_order then
   skipped:=skipped||jsonb_build_array(jsonb_build_object('account_id',account.id,'reason','이전 수집 자료가 늦게 도착해 더 최신 잔액을 유지했습니다.'));continue;
  end if;
  if source_order=previous.collected_order then
   if previous.balance=(r->>'balance')::bigint then unchanged:=unchanged+1;
   else skipped:=skipped||jsonb_build_array(jsonb_build_object('account_id',account.id,'reason','같은 수집 시각의 잔액이 달라 확인 전 기존 잔액을 유지했습니다.'));end if;
   continue;
  end if;
  update private.fd_clobe_balance_snapshots s set balance=(r->>'balance')::bigint,balance_date=(r->>'balance_date')::date,
   collected_at=r->>'collected_at',collected_order=source_order,synced_at=clock_timestamp()
   where s.owner_id=workspace_owner and s.account_id=account.id;
  synced:=synced+1;
 end loop;
 if synced>0 then insert into public.fd_audit_log(owner_id,action,detail) values(workspace_owner,'clobe_balance_sync','Clobe 수집 잔액 '||synced||'개 갱신 · 기존 거래/개시잔액/분류/메모/계획 변경 0건');end if;
 return jsonb_build_object('synced',synced,'unchanged',unchanged,'skipped',skipped);
end $$;
revoke all on function private.fd_clobe_balance_sync_core(text,text) from public,anon,authenticated;
grant execute on function private.fd_clobe_balance_sync_core(text,text) to authenticated;
create function public.fd_clobe_balance_sync(p_payload text,p_proof text) returns jsonb
language sql security invoker set search_path='' as $$select private.fd_clobe_balance_sync_core(p_payload,p_proof)$$;
revoke all on function public.fd_clobe_balance_sync(text,text) from public,anon,authenticated;
grant execute on function public.fd_clobe_balance_sync(text,text) to authenticated;

-- A purpose-specific reader exposes only the shared account observation DTO,
-- never provider credentials, raw account numbers or private mappings. The
-- existing dataset RPC remains SECURITY INVOKER with its original auth checks.
create function private.fd_read_clobe_balance_snapshots() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('account_id',s.account_id,'business_id',s.business_id,'balance',s.balance,
  'balance_date',s.balance_date,'collected_at',s.collected_at,'synced_at',s.synced_at,'source',s.source,'currency',s.currency) order by s.account_id),'[]'::jsonb)
  from private.fd_clobe_balance_snapshots s join private.fd_clobe_account_mappings m on m.owner_id=s.owner_id and m.account_id=s.account_id
   and m.company_id=s.company_id and m.external_account_id=s.external_account_id
  where s.owner_id=workspace_owner and s.synced_at<=statement_timestamp());
end $$;
revoke all on function private.fd_read_clobe_balance_snapshots() from public,anon,authenticated;
grant execute on function private.fd_read_clobe_balance_snapshots() to authenticated;
do $$declare definition text;anchor text:=E'  ''audit'',';replacement text:=E'  ''balance_snapshots'',private.fd_read_clobe_balance_snapshots(),\n  ''audit'',';begin
 definition:=replace(pg_get_functiondef('public.fd_read_finance_dataset()'::regprocedure),E'\r\n',E'\n');
 if strpos(definition,anchor)=0 or strpos(definition,'balance_snapshots')>0 then raise exception 'CLOBE_BALANCE_DATASET_ANCHOR_MISSING';end if;
 execute replace(definition,anchor,replacement);
end $$;
notify pgrst,'reload schema';
commit;
