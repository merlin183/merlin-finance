begin;

-- Preserve the already-applied importer and its private verifier. A compact
-- financial-candidate digest detects races affecting time/balance, not just
-- added IDs, while avoiding quadratic copies of complete candidate snapshots.
do $$
declare definition text;pair record;matches integer;
begin
 definition:=replace(pg_get_functiondef('private.fd_clobe_import_core(text,text,text)'::regprocedure),E'\r\n',E'\n');
 if position('expected_candidates_hash' in definition)>0 then raise exception 'CLOBE_IMPORT_GUARD_ALREADY_CHANGED';end if;
 for pair in select * from (values
  ($old$'source_fingerprint','expected_candidates','row','expected'$old$,$new$'source_fingerprint','expected_candidates_hash','row','expected'$new$),
  ($old$  if jsonb_typeof(c->'expected_candidates') is distinct from 'array' or jsonb_array_length(c->'expected_candidates')>50000
   or exists(select 1 from jsonb_array_elements_text(c->'expected_candidates') baseline_id where baseline_id !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
   or c->'expected_candidates' is distinct from (select coalesce(jsonb_agg(t.id::text order by t.id::text),'[]'::jsonb) from public.fd_transactions t$old$,
  $new$  if coalesce(c->>'expected_candidates_hash','') !~ '^[a-f0-9]{64}$'
   or c->>'expected_candidates_hash' is distinct from (select encode(sha256(convert_to(coalesce(string_agg(t.id::text||'|'||coalesce(t.txn_time,'')||'|'||coalesce(t.balance::text,''),E'\n' order by t.id::text),''),'UTF8')),'hex') from public.fd_transactions t$new$)
 ) replacements(old,new) loop
  matches:=(length(definition)-length(replace(definition,pair.old,'')))/length(pair.old);
  if matches<>1 then raise exception 'CLOBE_IMPORT_GUARD_UNEXPECTED_DEFINITION';end if;
  definition:=replace(definition,pair.old,pair.new);
 end loop;
 execute definition;
end $$;

commit;
