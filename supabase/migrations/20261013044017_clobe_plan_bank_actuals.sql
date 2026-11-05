begin;

-- Source observations for cash planning only. No ledger, category or budget is
-- changed. Previous months and the previous complete account scope survive a
-- later incomplete/failed query.
create table private.fd_clobe_plan_coverage(
 owner_id uuid not null references auth.users(id) on delete restrict,
 account_id uuid not null,business_id uuid not null,month text not null,
 company_id text not null,external_account_id text not null,
 scope_from date not null,scope_to date not null,collected_at text,collected_order timestamptz,
 status text not null check(status in ('complete','confirmation-needed')),reason text,
 rows_hash text,synced_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,account_id,month),
 foreign key(owner_id,business_id,account_id) references public.fd_accounts(owner_id,business_id,id) on delete cascade,
 check(month=to_char(scope_from,'YYYY-MM') and scope_from= date_trunc('month',scope_from)::date and month=to_char(scope_to,'YYYY-MM') and scope_to>=scope_from),
 check(status<>'complete' or (collected_at is not null and collected_order is not null and rows_hash is not null and reason is null)),
 check(reason is null or length(reason)<=1000)
);
create table private.fd_clobe_plan_actuals(
 owner_id uuid not null,account_id uuid not null,business_id uuid not null,month text not null,
 external_transaction_id text not null check(external_transaction_id ~ '^[1-9][0-9]{0,15}$'),
 txn_date date not null,txn_time text not null check(txn_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$'),
 amount bigint not null check(amount between 1 and 9007199254740991),balance bigint check(abs(balance::numeric)<=9007199254740991),
 description text not null check(length(description)<=8003),party text check(length(party)<=1000),source_details jsonb,
 collected_at text not null,synced_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,account_id,month,external_transaction_id),
 foreign key(owner_id,account_id,month) references private.fd_clobe_plan_coverage(owner_id,account_id,month) on delete cascade,
 foreign key(owner_id,business_id,account_id) references public.fd_accounts(owner_id,business_id,id) on delete cascade,
 check(month=to_char(txn_date,'YYYY-MM'))
);
alter table private.fd_clobe_plan_coverage enable row level security;
alter table private.fd_clobe_plan_actuals enable row level security;
revoke all on private.fd_clobe_plan_coverage,private.fd_clobe_plan_actuals from public,anon,authenticated;

create function private.fd_clobe_plan_actuals_sync_core(p_payload text,p_proof text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();workspace_owner uuid:=private.finance_workspace_owner();secret bytea;body jsonb;s jsonb;r jsonb;
 account public.fd_accounts;old_scope private.fd_clobe_plan_coverage;source_order timestamptz;from_date date;to_date date;scope_month text;fingerprint text;
 synced integer:=0;unchanged integer:=0;outflows integer:=0;skipped jsonb:='[]'::jsonb;reason text;issued timestamptz;expires timestamptz;
begin
 if actor is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if p_payload is null or octet_length(p_payload)>6291456 or p_proof is null or p_proof !~ '^[a-f0-9]{64}$' then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
 select decode(v.signing_key,'base64') into secret from private.fd_clobe_import_verifier v where v.singleton;
 if secret is null then raise exception 'CLOBE_PLAN_CONFIGURATION';end if;
 if p_proof<>private.fd_clobe_import_hmac('merlin:clobe-import:v1'||E'\n'||'plan-actuals-sync'||E'\n'||actor::text||E'\n'||workspace_owner::text||E'\n'||p_payload,secret) then raise exception 'CLOBE_PLAN_UNTRUSTED';end if;
 body:=p_payload::jsonb;
 if jsonb_typeof(body) is distinct from 'object' or not(body?&array['issued_at','expires_at','scopes'])
  or exists(select 1 from jsonb_object_keys(body) k where k not in ('issued_at','expires_at','scopes'))
  or coalesce(body->>'issued_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  or coalesce(body->>'expires_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  or jsonb_typeof(body->'scopes') is distinct from 'array' or jsonb_array_length(body->'scopes')>100 then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
 issued:=(body->>'issued_at')::timestamptz;expires:=(body->>'expires_at')::timestamptz;
 if issued>clock_timestamp()+interval '1 minute' or issued<clock_timestamp()-interval '5 minutes' or expires<=clock_timestamp() or expires<=issued or expires>issued+interval '5 minutes' then raise exception 'CLOBE_PLAN_EXPIRED';end if;
 if (select count(distinct jsonb_build_array(v->>'account_id',left(v->>'from',7))) from jsonb_array_elements(body->'scopes') v)<>jsonb_array_length(body->'scopes') then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
 if (select coalesce(sum(jsonb_array_length(v->'rows')),0) from jsonb_array_elements(body->'scopes') v)>6000 then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
 -- Validate every signed account scope before acquiring locks or writing.
 for s in select value from jsonb_array_elements(body->'scopes') loop
  if jsonb_typeof(s) is distinct from 'object' or not(s?&array['company_id','external_account_id','account_id','from','to','collected_at','status','reason','rows'])
   or exists(select 1 from jsonb_object_keys(s) k where k not in ('company_id','external_account_id','account_id','from','to','collected_at','status','reason','rows'))
   or jsonb_typeof(s->'company_id') is distinct from 'string' or length(s->>'company_id') not between 1 and 200
   or coalesce(s->>'external_account_id','') !~ '^[1-9][0-9]{0,15}$' or coalesce(s->>'account_id','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   or coalesce(s->>'from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(s->>'to','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   or s->>'status' is null or s->>'status' not in ('complete','confirmation-needed')
   or jsonb_typeof(s->'rows') is distinct from 'array' or jsonb_array_length(s->'rows')>2000
   or (s->>'status'='complete' and (s->'reason'<>'null'::jsonb or s->>'collected_at' is null))
   or (s->>'status'='confirmation-needed' and (jsonb_array_length(s->'rows')<>0 or jsonb_typeof(s->'reason') is distinct from 'string' or length(s->>'reason') not between 1 and 1000))
  then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
  from_date:=(s->>'from')::date;to_date:=(s->>'to')::date;
  if from_date<'1900-01-01' or to_date>(clock_timestamp() at time zone 'Asia/Seoul')::date or to_date<from_date or date_trunc('month',from_date)::date<>from_date or to_char(from_date,'YYYY-MM')<>to_char(to_date,'YYYY-MM') then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
  if s->>'collected_at' is not null then
   if coalesce(s->>'collected_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,9})?(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])?$' or left(s->>'collected_at',10)<>to_date::text then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
   source_order:=case when s->>'collected_at' ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then (s->>'collected_at')::timestamptz else (s->>'collected_at')::timestamp at time zone 'Asia/Seoul' end;
   if source_order>clock_timestamp()+interval '5 minutes' then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
  end if;
  if (select count(distinct v->>'external_transaction_id') from jsonb_array_elements(s->'rows') v)<>jsonb_array_length(s->'rows') then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
  for r in select value from jsonb_array_elements(s->'rows') loop
   if jsonb_typeof(r) is distinct from 'object' or not(r?&array['external_transaction_id','txn_date','txn_time','amount','balance','description','party','source_details'])
    or exists(select 1 from jsonb_object_keys(r) k where k not in ('external_transaction_id','txn_date','txn_time','amount','balance','description','party','source_details'))
    or coalesce(r->>'external_transaction_id','') !~ '^[1-9][0-9]{0,15}$' or coalesce(r->>'txn_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or coalesce(r->>'txn_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$'
    or jsonb_typeof(r->'amount') is distinct from 'number' or coalesce(r->>'amount','') !~ '^[1-9][0-9]{0,15}$' or (r->>'amount')::numeric>9007199254740991
    or (r->'balance'<>'null'::jsonb and (jsonb_typeof(r->'balance') is distinct from 'number' or coalesce(r->>'balance','') !~ '^-?(0|[1-9][0-9]{0,15})$' or abs((r->>'balance')::numeric)>9007199254740991))
    or jsonb_typeof(r->'description') is distinct from 'string' or length(r->>'description')>8003
    or (r->'party'<>'null'::jsonb and (jsonb_typeof(r->'party') is distinct from 'string' or length(r->>'party')>1000))
   then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
   if (r->>'txn_date')::date<from_date or (r->>'txn_date')::date>to_date or ((r->>'txn_date')||'T'||(r->>'txn_time'))::timestamp at time zone 'Asia/Seoul'>source_order then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
   if r->'source_details'<>'null'::jsonb then
    if jsonb_typeof(r->'source_details') is distinct from 'object' then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
    if exists(select 1 from jsonb_each(r->'source_details') p where p.key not in ('basic','detail','counterparty') or jsonb_typeof(p.value)<>'string' or length(p.value#>>'{}')>1000) then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
   end if;
  end loop;
  -- Two different bank IDs describing the same exact financial record are
  -- ambiguous; the server must never invent multiplicity from that response.
  if (select count(distinct (v-'external_transaction_id')) from jsonb_array_elements(s->'rows') v)<>jsonb_array_length(s->'rows') then raise exception 'CLOBE_PLAN_INVALID_PAYLOAD';end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended('fd_account:'||a.id::text,0)) from public.fd_accounts a where a.owner_id=workspace_owner and a.id in(select (v->>'account_id')::uuid from jsonb_array_elements(body->'scopes') v) order by a.id;
 perform a.id from public.fd_accounts a where a.owner_id=workspace_owner and a.id in(select (v->>'account_id')::uuid from jsonb_array_elements(body->'scopes') v) order by a.id for update;
 perform m.account_id from private.fd_clobe_account_mappings m where m.owner_id=workspace_owner and m.account_id in(select (v->>'account_id')::uuid from jsonb_array_elements(body->'scopes') v) order by m.account_id for update;
 for s in select value from jsonb_array_elements(body->'scopes') order by value->>'account_id' loop
  select a.* into account from public.fd_accounts a join private.fd_clobe_account_mappings m on m.owner_id=a.owner_id and m.account_id=a.id
   where a.owner_id=workspace_owner and a.id=(s->>'account_id')::uuid and m.company_id=s->>'company_id' and m.external_account_id=s->>'external_account_id';
  if account.id is null then raise exception 'CLOBE_PLAN_SCOPE';end if;
  from_date:=(s->>'from')::date;to_date:=(s->>'to')::date;scope_month:=to_char(from_date,'YYYY-MM');
  select c.* into old_scope from private.fd_clobe_plan_coverage c where c.owner_id=workspace_owner and c.account_id=account.id and c.month=scope_month for update;
  if old_scope.account_id is not null and (old_scope.company_id<>s->>'company_id' or old_scope.external_account_id<>s->>'external_account_id') then raise exception 'CLOBE_PLAN_SCOPE';end if;
  reason:=null;source_order:=case when s->>'collected_at' is null then null when s->>'collected_at' ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then (s->>'collected_at')::timestamptz else (s->>'collected_at')::timestamp at time zone 'Asia/Seoul' end;
  select md5(coalesce(jsonb_agg(v order by v->>'external_transaction_id'),'[]'::jsonb)::text) into fingerprint from jsonb_array_elements(s->'rows') v;
  if s->>'status'='confirmation-needed' then reason:=s->>'reason';
  elsif old_scope.collected_order is not null and source_order<old_scope.collected_order then reason:='이전 수집 자료가 도착해 더 최신 출금 증거를 유지했습니다.';
  elsif old_scope.collected_order=source_order and old_scope.rows_hash is distinct from fingerprint then reason:='같은 수집 시각의 은행 출금 원본이 달라 이전 증거를 유지했습니다.';
  elsif old_scope.scope_to>to_date then reason:='전체 월 조회 범위가 줄어 이전 출금 증거를 유지했습니다.';
  elsif exists(select 1 from private.fd_clobe_plan_actuals a where a.owner_id=workspace_owner and a.account_id=account.id and a.month=scope_month
   and not exists(select 1 from jsonb_array_elements(s->'rows') v where v->>'external_transaction_id'=a.external_transaction_id
    and v=jsonb_build_object('external_transaction_id',a.external_transaction_id,'txn_date',a.txn_date,'txn_time',a.txn_time,'amount',a.amount,'balance',a.balance,'description',a.description,'party',a.party,'source_details',a.source_details)))
   then reason:='기존에 확인한 은행 거래 원본이 바뀌거나 누락되어 이전 출금 증거를 유지했습니다.';
  elsif not exists(select 1 from private.fd_clobe_balance_snapshots b where b.owner_id=workspace_owner and b.account_id=account.id and b.company_id=s->>'company_id' and b.external_account_id=s->>'external_account_id' and b.collected_at=s->>'collected_at') then reason:='저장된 잔액 수집 시각과 달라 이전 출금 증거를 유지했습니다.';
  end if;
  if reason is not null then
   insert into private.fd_clobe_plan_coverage(owner_id,account_id,business_id,month,company_id,external_account_id,scope_from,scope_to,status,reason)
   values(workspace_owner,account.id,account.business_id,scope_month,s->>'company_id',s->>'external_account_id',from_date,to_date,'confirmation-needed',reason)
   on conflict(owner_id,account_id,month) do update set status='confirmation-needed',reason=excluded.reason,synced_at=clock_timestamp();
   skipped:=skipped||jsonb_build_array(jsonb_build_object('account_id',account.id,'reason',reason));continue;
  end if;
  outflows:=outflows+jsonb_array_length(s->'rows');
  if old_scope.collected_order=source_order and old_scope.rows_hash=fingerprint then
   update private.fd_clobe_plan_coverage c set status='complete',reason=null,synced_at=clock_timestamp() where c.owner_id=workspace_owner and c.account_id=account.id and c.month=scope_month;
   unchanged:=unchanged+1;continue;
  end if;
  insert into private.fd_clobe_plan_coverage(owner_id,account_id,business_id,month,company_id,external_account_id,scope_from,scope_to,collected_at,collected_order,status,reason,rows_hash)
  values(workspace_owner,account.id,account.business_id,scope_month,s->>'company_id',s->>'external_account_id',from_date,to_date,s->>'collected_at',source_order,'complete',null,fingerprint)
  on conflict(owner_id,account_id,month) do update set scope_from=excluded.scope_from,scope_to=excluded.scope_to,collected_at=excluded.collected_at,collected_order=excluded.collected_order,status='complete',reason=null,rows_hash=excluded.rows_hash,synced_at=clock_timestamp();
  delete from private.fd_clobe_plan_actuals a where a.owner_id=workspace_owner and a.account_id=account.id and a.month=scope_month;
  insert into private.fd_clobe_plan_actuals(owner_id,account_id,business_id,month,external_transaction_id,txn_date,txn_time,amount,balance,description,party,source_details,collected_at)
   select workspace_owner,account.id,account.business_id,scope_month,v->>'external_transaction_id',(v->>'txn_date')::date,v->>'txn_time',(v->>'amount')::bigint,(v->>'balance')::bigint,v->>'description',v->>'party',nullif(v->'source_details','null'::jsonb),s->>'collected_at' from jsonb_array_elements(s->'rows') v;
  synced:=synced+1;
 end loop;
 if synced>0 then insert into public.fd_audit_log(owner_id,action,detail) values(workspace_owner,'clobe_plan_actuals_sync','계획용 은행 출금 조회 '||synced||'개 계좌 · 원장/분류/사용자 확인/예산/계획일 변경 0건');end if;
 return jsonb_build_object('synced_accounts',synced,'unchanged_accounts',unchanged,'saved_outflows',outflows,'skipped',skipped);
end $$;
revoke all on function private.fd_clobe_plan_actuals_sync_core(text,text) from public,anon,authenticated;
grant execute on function private.fd_clobe_plan_actuals_sync_core(text,text) to authenticated;
create function public.fd_clobe_plan_actuals_sync(p_payload text,p_proof text) returns jsonb language sql security invoker set search_path='' as $$select private.fd_clobe_plan_actuals_sync_core(p_payload,p_proof)$$;
revoke all on function public.fd_clobe_plan_actuals_sync(text,text) from public,anon,authenticated;
grant execute on function public.fd_clobe_plan_actuals_sync(text,text) to authenticated;

create function private.fd_read_clobe_plan_coverage() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('account_id',c.account_id,'business_id',c.business_id,'from',c.scope_from,'to',c.scope_to,'collected_at',c.collected_at,'synced_at',c.synced_at,'status',c.status,'reason',c.reason,'source','clobe','currency','KRW') order by c.account_id,c.month),'[]'::jsonb)
 from private.fd_clobe_plan_coverage c join private.fd_clobe_account_mappings m on m.owner_id=c.owner_id and m.account_id=c.account_id and m.company_id=c.company_id and m.external_account_id=c.external_account_id where c.owner_id=workspace_owner);
end $$;
create function private.fd_read_clobe_plan_actuals() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 -- Preserve an exact provider reference even if ledger financial fields conflict.
 -- The shared model then blocks that conflict rather than treating it as a new outflow.
 return (select coalesce(jsonb_agg(jsonb_build_object('account_id',a.account_id,'business_id',a.business_id,'external_transaction_id',a.external_transaction_id,'txn_date',a.txn_date,'txn_time',a.txn_time,'amount',a.amount,'balance',a.balance,'description',a.description,'party',a.party,'source_details',a.source_details,'collected_at',a.collected_at,'synced_at',a.synced_at,'transaction_id',r.transaction_id,'source','clobe','currency','KRW') order by a.account_id,a.month,a.txn_date,a.txn_time,a.external_transaction_id),'[]'::jsonb)
 from private.fd_clobe_plan_actuals a join private.fd_clobe_plan_coverage c using(owner_id,account_id,month)
 join private.fd_clobe_account_mappings m on m.owner_id=c.owner_id and m.account_id=c.account_id and m.company_id=c.company_id and m.external_account_id=c.external_account_id
 left join private.fd_clobe_transaction_refs r on r.owner_id=a.owner_id and r.company_id=c.company_id and r.external_account_id=c.external_account_id and r.external_transaction_id=a.external_transaction_id and r.account_id=a.account_id
 where a.owner_id=workspace_owner and a.business_id=c.business_id and a.collected_at=c.collected_at and a.txn_date between c.scope_from and c.scope_to);
end $$;
revoke all on function private.fd_read_clobe_plan_coverage(),private.fd_read_clobe_plan_actuals() from public,anon,authenticated;
grant execute on function private.fd_read_clobe_plan_coverage(),private.fd_read_clobe_plan_actuals() to authenticated;
do $$declare definition text;anchor text:=E'  ''audit'',';replacement text:=E'  ''bank_plan_actuals'',private.fd_read_clobe_plan_actuals(),\n  ''bank_plan_coverage'',private.fd_read_clobe_plan_coverage(),\n  ''audit'',';begin
 definition:=replace(pg_get_functiondef('public.fd_read_finance_dataset()'::regprocedure),E'\r\n',E'\n');
 if strpos(definition,anchor)=0 or strpos(definition,'bank_plan_actuals')>0 then raise exception 'CLOBE_PLAN_DATASET_ANCHOR_MISSING';end if;
 execute replace(definition,anchor,replacement);
end $$;
notify pgrst,'reload schema';
commit;
