begin;

-- A current bank collection can verify the preceding calendar month too.
-- Preserve its real timestamp: scope_to is the queried month end, not the
-- collection date. Patch the CURRENT core so every later source/auth guard stays.
do $$
declare definition text; anchor text; required text;
begin
 if not exists(select 1 from pg_proc where oid='private.fd_clobe_plan_actuals_sync_core(text,text)'::regprocedure and prosecdef)
 then raise exception 'CLOBE_PLAN_RECENT_CORE_CONTRACT';end if;
 definition:=replace(pg_get_functiondef('private.fd_clobe_plan_actuals_sync_core(text,text)'::regprocedure),E'\r\n',E'\n');
 foreach required in array array[
  'actor uuid:=auth.uid()', 'workspace_owner uuid:=private.finance_workspace_owner()',
  'CLOBE_PLAN_UNTRUSTED', 'CLOBE_PLAN_EXPIRED', 'octet_length(p_payload)>6291456',
  'source_order>clock_timestamp()+interval ''5 minutes''', 'old_scope.scope_to>to_date',
  '기존에 확인한 은행 거래 원본이 바뀌거나 누락되어 이전 출금 증거를 유지했습니다.',
  'b.collected_at=s->>''collected_at'''
 ] loop
  if strpos(definition,required)=0 then raise exception 'CLOBE_PLAN_RECENT_CORE_ANCHOR_MISSING: %',required;end if;
 end loop;
 anchor:='jsonb_array_length(body->''scopes'')>100';
 if strpos(definition,anchor)=0 then raise exception 'CLOBE_PLAN_RECENT_SCOPE_ANCHOR';end if;
 definition:=replace(definition,anchor,'jsonb_array_length(body->''scopes'')>200');
 anchor:='left(s->>''collected_at'',10)<>to_date::text';
 if strpos(definition,anchor)=0 then raise exception 'CLOBE_PLAN_RECENT_DATE_ANCHOR';end if;
 definition:=replace(definition,anchor,'left(s->>''collected_at'',10)<to_date::text');
 anchor:='if (select coalesce(sum(jsonb_array_length(v->''rows'')),0)';
 if strpos(definition,anchor)=0 then raise exception 'CLOBE_PLAN_RECENT_BOUNDS_ANCHOR';end if;
 definition:=replace(definition,anchor,E'if (select count(distinct v->>''account_id'') from jsonb_array_elements(body->''scopes'') v)>100\n  or exists(select 1 from jsonb_array_elements(body->''scopes'') v group by v->>''account_id'' having count(*)>2)\n then raise exception ''CLOBE_PLAN_INVALID_PAYLOAD'';end if;\n '||anchor);
 anchor:='perform pg_advisory_xact_lock(hashtextextended(''fd_account:''';
 if strpos(definition,anchor)=0 then raise exception 'CLOBE_PLAN_RECENT_IDENTITY_ANCHOR';end if;
 definition:=replace(definition,anchor,E'if exists(select 1 from jsonb_array_elements(body->''scopes'') sc cross join lateral jsonb_array_elements(sc.value->''rows'') rr\n  group by sc.value->>''account_id'',rr.value->>''external_transaction_id'' having count(*)>1)\n then raise exception ''CLOBE_PLAN_INVALID_PAYLOAD'';end if;\n '||anchor);
 anchor:='reason text;issued timestamptz;expires timestamptz;';
 if strpos(definition,anchor)=0 then raise exception 'CLOBE_PLAN_RECENT_DECLARE_ANCHOR';end if;
 definition:=replace(definition,anchor,anchor||E'\n synced_ids uuid[]:=''{}''::uuid[];unchanged_ids uuid[]:=''{}''::uuid[];');
 anchor:='if old_scope.collected_order=source_order and old_scope.rows_hash=fingerprint then';
 if strpos(definition,anchor)=0 then raise exception 'CLOBE_PLAN_RECENT_RANGE_ANCHOR';end if;
 definition:=replace(definition,anchor,'if old_scope.collected_order=source_order and old_scope.rows_hash=fingerprint and old_scope.scope_from=from_date and old_scope.scope_to=to_date then');
 anchor:='unchanged:=unchanged+1;continue;';
 if strpos(definition,anchor)=0 then raise exception 'CLOBE_PLAN_RECENT_UNCHANGED_ANCHOR';end if;
 definition:=replace(definition,anchor,'unchanged_ids:=array_append(unchanged_ids,account.id);'||anchor);
 anchor:='synced:=synced+1;';
 if strpos(definition,anchor)=0 then raise exception 'CLOBE_PLAN_RECENT_SYNCED_ANCHOR';end if;
 definition:=replace(definition,anchor,'synced_ids:=array_append(synced_ids,account.id);'||anchor);
 anchor:='if synced>0 then insert into public.fd_audit_log';
 if strpos(definition,anchor)=0 then raise exception 'CLOBE_PLAN_RECENT_COUNTS_ANCHOR';end if;
 definition:=replace(definition,anchor,E'select count(distinct value)::integer into synced from unnest(synced_ids) value;\n select count(distinct value)::integer into unchanged from unnest(unchanged_ids) value where not(value=any(synced_ids));\n '||anchor);
 execute definition;
end $$;

-- The same signed private core and authenticated-only invoker wrapper remain.
revoke all on function private.fd_clobe_plan_actuals_sync_core(text,text),public.fd_clobe_plan_actuals_sync(text,text) from public,anon,authenticated;
grant execute on function private.fd_clobe_plan_actuals_sync_core(text,text),public.fd_clobe_plan_actuals_sync(text,text) to authenticated;
notify pgrst,'reload schema';
commit;
