-- Apply only after the scoped source, its Vault secrets and the installation's
-- FINANCE_SHEET_SYNC_TOKEN have been configured and the first run verified.
-- This script contains no credentials and does not grant table access.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function private.fd_dispatch_sheet_sync() returns bigint
language plpgsql security definer set search_path='' as $$
declare sync_token text;sync_url text;request_id bigint;
begin
 select decrypted_secret into sync_token from vault.decrypted_secrets
 where name='merlin_finance_sheet_sync';
 if sync_token is null then raise exception 'SHEET_SYNC_SECRET_MISSING';end if;
 select decrypted_secret into sync_url from vault.decrypted_secrets
 where name='merlin_finance_sheet_sync_url';
 if sync_url is null or sync_url !~ '^https://[^[:space:]]+/api/sheet-sync$'
 then raise exception 'SHEET_SYNC_URL_MISSING';end if;
 -- Enabled state and active creator are checked again by every destination RPC.
 if not exists(select 1 from private.fd_sheet_sync_sources s
  where s.enabled and s.token_hash=encode(sha256(convert_to(sync_token,'UTF8')),'hex'))
 then return null;end if;
 select net.http_post(
  url:=sync_url,
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||sync_token),
  body:='{"action":"run"}'::jsonb,
  timeout_milliseconds:=60000
 ) into request_id;
 return request_id;
end $$;
revoke all on function private.fd_dispatch_sheet_sync() from public,anon,authenticated;

-- Named scheduling updates an existing job instead of creating a duplicate.
select cron.schedule('merlin-finance-sheet-sync','*/5 * * * *','select private.fd_dispatch_sheet_sync();');
commit;
