begin;

-- A cheap source probe lets unchanged polls avoid reading the financial dataset.
-- Advance this source snapshot only alongside a committed source checkpoint.
alter table private.fd_sheet_sync_sources add column last_source_hash text
 check(last_source_hash is null or last_source_hash ~ '^[a-f0-9]{64}$');

-- Keep privileged implementations outside the exposed Data API schema. Moving
-- each existing function preserves its reviewed authorization, scope checks,
-- optimistic concurrency, checkpoint behavior and complete merge implementation.
do $$
declare signature text;
begin
 foreach signature in array array[
  'public.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb)',
  'public.fd_sheet_sync_context(text)',
  'public.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb)',
  'public.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb)',
  'public.fd_sheet_sync_status()'
 ] loop
  if not coalesce((select p.prosecdef from pg_proc p where p.oid=to_regprocedure(signature)),false)
  then raise exception 'SHEET_SYNC_EXPECTED_DEFINER_MISSING: %',signature;end if;
 end loop;
end $$;

alter function public.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb) set schema private;
alter function public.fd_sheet_sync_context(text) set schema private;
alter function public.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb) set schema private;
alter function public.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb) set schema private;
alter function public.fd_sheet_sync_status() set schema private;

alter function private.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb) set search_path='';
alter function private.fd_sheet_sync_context(text) set search_path='';
alter function private.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb) set search_path='';
alter function private.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb) set search_path='';
alter function private.fd_sheet_sync_status() set search_path='';

-- Extend the moved implementations with a source snapshot checkpoint. New
-- trailing defaults preserve existing callers without leaving RPC overloads.
do $$
declare definition text;pair record;anchor text;replacement text;
begin
 definition:=replace(pg_get_functiondef('private.fd_sheet_sync_context(text)'::regprocedure),E'\r\n',E'\n');
 anchor:='''source_fingerprints'',source.source_fingerprints,''dataset'',dataset';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'SHEET_SYNC_PROBE_CONTEXT_ANCHOR';end if;
 execute replace(definition,anchor,'''source_fingerprints'',source.source_fingerprints,''last_source_hash'',source.last_source_hash,''dataset'',dataset');

 definition:=replace(pg_get_functiondef('private.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 for pair in select * from (values
  ('p_expected_fingerprints jsonb DEFAULT NULL::jsonb)', 'p_expected_fingerprints jsonb DEFAULT NULL::jsonb, p_snapshot_hash text DEFAULT NULL::text)'),
  (' if p_fingerprints is not null and not private.fd_valid_sync_fingerprints(p_fingerprints)',
   ' if p_snapshot_hash is not null and (p_snapshot_hash !~ ''^[a-f0-9]{64}$'' or p_fingerprints is null or p_expected_fingerprints is null) then raise exception ''SHEET_SYNC_INVALID_SNAPSHOT'';end if;'||E'\n'||
   ' if p_fingerprints is not null and not private.fd_valid_sync_fingerprints(p_fingerprints)'),
  ('last_run_at=now(),last_result=answer,last_error=null,',
   'last_run_at=now(),last_result=answer,last_error=null,last_source_hash=coalesce(p_snapshot_hash,last_source_hash),')
 ) pairs(old,new) loop
  anchor:=pair.old;replacement:=pair.new;
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'SHEET_SYNC_PROBE_APPLY_ANCHOR';end if;
  definition:=replace(definition,anchor,replacement);
 end loop;
 execute definition;
 drop function private.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb);

 definition:=replace(pg_get_functiondef('private.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 for pair in select * from (values
  ('p_expected_fingerprints jsonb DEFAULT NULL::jsonb)', 'p_expected_fingerprints jsonb DEFAULT NULL::jsonb, p_source_hash text DEFAULT NULL::text)'),
  (' if p_fingerprints is not null and not private.fd_valid_sync_fingerprints(p_fingerprints)',
   ' if p_source_hash is not null and (p_source_hash !~ ''^[a-f0-9]{64}$'' or (p_error is null and (p_fingerprints is null or p_expected_fingerprints is null))) then raise exception ''SHEET_SYNC_INVALID_SNAPSHOT'';end if;'||E'\n'||
   ' if p_fingerprints is not null and not private.fd_valid_sync_fingerprints(p_fingerprints)'),
  ('last_run_at=now(),last_result=result,last_error=safe_error,',
   'last_run_at=now(),last_result=result,last_error=safe_error,last_source_hash=case when p_error is null then coalesce(p_source_hash,last_source_hash) else last_source_hash end,')
 ) pairs(old,new) loop
  anchor:=pair.old;replacement:=pair.new;
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'SHEET_SYNC_PROBE_FINISH_ANCHOR';end if;
  definition:=replace(definition,anchor,replacement);
 end loop;
 execute definition;
 drop function private.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb);

 definition:=replace(pg_get_functiondef('private.fd_validate_sheet_sync_source()'::regprocedure),E'\r\n',E'\n');
 anchor:='then new.source_fingerprints:=''[]''::jsonb;end if;';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'SHEET_SYNC_PROBE_SCOPE_ANCHOR';end if;
 execute replace(definition,anchor,'then new.source_fingerprints:=''[]''::jsonb;new.last_source_hash:=null;end if;');
end $$;

create function private.fd_sheet_sync_probe(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare source private.fd_sheet_sync_sources;
begin
 source:=private.fd_sheet_sync_authorize(p_token);
 return jsonb_build_object('source_id',source.id,'source_url',source.source_url,
  'last_source_hash',source.last_source_hash,'last_result',source.last_result);
end $$;

revoke all on function private.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb),
 private.fd_sheet_sync_context(text),private.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb,text),
 private.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb,text),private.fd_sheet_sync_status(),private.fd_sheet_sync_probe(text)
 from public,anon,authenticated;
grant execute on function private.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb),private.fd_sheet_sync_status() to authenticated;
grant execute on function private.fd_sheet_sync_context(text),
 private.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb,text),
 private.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb,text),private.fd_sheet_sync_probe(text) to anon,authenticated;

-- Schema USAGE permits resolving the four capability-checked implementations;
-- it gives no table privileges or function EXECUTE. Fail if historical grants
-- would make any unrelated private function/table newly reachable by anon.
revoke all on function private.fd_apply_sheet_import_core(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
do $$
begin
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and has_function_privilege('anon',p.oid,'EXECUTE')
   and p.oid not in('private.fd_sheet_sync_context(text)'::regprocedure,
    'private.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure,
    'private.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb,text)'::regprocedure,
    'private.fd_sheet_sync_probe(text)'::regprocedure))
 then raise exception 'SHEET_SYNC_UNEXPECTED_ANON_FUNCTION_GRANT';end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='private' and c.relkind in ('r','p','v','m','f')
   and (has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 then raise exception 'SHEET_SYNC_UNEXPECTED_ANON_TABLE_GRANT';end if;
end $$;
revoke create on schema private from public,anon,authenticated;
grant usage on schema private to anon,authenticated;

create function public.fd_apply_sheet_import(p_run uuid,p_source_url text,p_source_hash text,p_changes jsonb,p_summary jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$
 select private.fd_apply_sheet_import(p_run,p_source_url,p_source_hash,p_changes,p_summary)
$$;
create function public.fd_sheet_sync_context(p_token text) returns jsonb
language sql security invoker set search_path='' as $$select private.fd_sheet_sync_context(p_token)$$;
create function public.fd_sheet_sync_probe(p_token text) returns jsonb
language sql security invoker set search_path='' as $$select private.fd_sheet_sync_probe(p_token)$$;
create function public.fd_apply_sheet_sync(p_token text,p_run uuid,p_source_hash text,p_changes jsonb,p_summary jsonb,p_fingerprints jsonb default null,p_expected_fingerprints jsonb default null,p_snapshot_hash text default null)
returns jsonb language sql security invoker set search_path='' as $$
 select private.fd_apply_sheet_sync(p_token,p_run,p_source_hash,p_changes,p_summary,p_fingerprints,p_expected_fingerprints,p_snapshot_hash)
$$;
create function public.fd_sheet_sync_finish(p_token text,p_result jsonb,p_error text default null,p_fingerprints jsonb default null,p_expected_fingerprints jsonb default null,p_source_hash text default null)
returns void language sql security invoker set search_path='' as $$
 select private.fd_sheet_sync_finish(p_token,p_result,p_error,p_fingerprints,p_expected_fingerprints,p_source_hash)
$$;
create function public.fd_sheet_sync_status() returns jsonb
language sql security invoker set search_path='' as $$select private.fd_sheet_sync_status()$$;

revoke all on function public.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb),
 public.fd_sheet_sync_context(text),public.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb,text),
 public.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb,text),public.fd_sheet_sync_status(),public.fd_sheet_sync_probe(text)
 from public,anon,authenticated;
grant execute on function public.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb),public.fd_sheet_sync_status() to authenticated;
grant execute on function public.fd_sheet_sync_context(text),
 public.fd_apply_sheet_sync(text,uuid,text,jsonb,jsonb,jsonb,jsonb,text),
 public.fd_sheet_sync_finish(text,jsonb,text,jsonb,jsonb,text),public.fd_sheet_sync_probe(text) to anon,authenticated;

notify pgrst,'reload schema';
commit;
