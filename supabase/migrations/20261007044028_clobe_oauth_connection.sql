begin;

-- Ciphertext only: the AES-GCM key lives in the application server environment.
-- Neither default grants nor exposing private in PostgREST can reveal plaintext.
create table private.fd_clobe_connections (
 owner_id uuid primary key references auth.users(id) on delete restrict,
 client_ciphertext text check(client_ciphertext is null or (length(client_ciphertext)<=32000 and client_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')),
 token_ciphertext text check(token_ciphertext is null or (length(token_ciphertext)<=32000 and token_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')),
 version bigint not null default 0 check(version>=0),
 connected_at timestamptz,
 token_expires_at timestamptz,
 updated_at timestamptz not null default clock_timestamp(),
 last_error text check(last_error in ('request_failed','reconnect_required','refresh_uncertain')),
 lease_id uuid,
 lease_actor uuid references auth.users(id) on delete restrict,
 lease_expires_at timestamptz,
 attempt_id uuid,
 attempt_actor uuid references auth.users(id) on delete restrict,
 attempt_expires_at timestamptz,
 check((lease_id is null)=(lease_actor is null) and (lease_id is null)=(lease_expires_at is null)),
 check((attempt_id is null)=(attempt_actor is null) and (attempt_id is null)=(attempt_expires_at is null)),
 check((token_ciphertext is null)=(token_expires_at is null))
);
alter table private.fd_clobe_connections enable row level security;
revoke all on private.fd_clobe_connections from public,anon,authenticated;

-- This narrow private definer is necessary to access a table with no Data API
-- grants. Its public entry point remains INVOKER and every action rechecks the
-- current administrator/workspace, not caller-supplied owner/user identifiers.
create function private.fd_clobe_auth_core(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=auth.uid(); workspace_owner uuid:=private.finance_workspace_owner();
 current_row private.fd_clobe_connections; lease uuid; expected_version bigint;
 stamp timestamptz:=clock_timestamp(); expiry timestamptz;
 allowed_keys text[]; found_keys text[];
begin
 if actor is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'CLOBE_INVALID_PAYLOAD';end if;
 allowed_keys:=case p_action
  when 'read' then array[]::text[]
  when 'claim' then array['version','lease_id']
  when 'claim_refresh' then array['version','lease_id']
  when 'client' then array['version','lease_id','ciphertext']
  when 'begin' then array['attempt_id']
  when 'consume' then array['attempt_id','lease_id']
  when 'tokens' then array['version','lease_id','ciphertext','expires_at']
  when 'release' then array['lease_id','error']
  else null end;
 if allowed_keys is null then raise exception 'CLOBE_INVALID_ACTION';end if;
 select coalesce(array_agg(k),'{}'::text[]) into found_keys from jsonb_object_keys(p_payload) k;
 if not found_keys <@ allowed_keys then raise exception 'CLOBE_INVALID_PAYLOAD';end if;

 if p_action='read' then
  select * into current_row from private.fd_clobe_connections where owner_id=workspace_owner;
 else
  -- Serialize initial registration and later OAuth/refresh work for this owner.
  insert into private.fd_clobe_connections(owner_id) values(workspace_owner) on conflict(owner_id) do nothing;
  select * into current_row from private.fd_clobe_connections where owner_id=workspace_owner for update;
  if p_action in ('claim','claim_refresh','client','tokens') then
   expected_version:=(p_payload->>'version')::bigint;
   if expected_version is null or expected_version<>current_row.version then raise exception 'CLOBE_STALE';end if;
  end if;
  if p_action in ('claim','claim_refresh','client','consume','tokens','release') then
   lease:=(p_payload->>'lease_id')::uuid;
   if lease is null then raise exception 'CLOBE_INVALID_PAYLOAD';end if;
  end if;
  if p_action in ('claim','claim_refresh','begin','consume') and current_row.lease_expires_at>stamp then raise exception 'CLOBE_BUSY';end if;
  if p_action in ('client','tokens') and (current_row.lease_id is distinct from lease or current_row.lease_actor is distinct from actor or current_row.lease_expires_at<=stamp) then raise exception 'CLOBE_STALE';end if;

  if p_action in ('claim','claim_refresh') then
   if p_action='claim_refresh' and (current_row.token_ciphertext is null or current_row.last_error in ('reconnect_required','refresh_uncertain')) then raise exception 'CLOBE_STALE';end if;
   update private.fd_clobe_connections set lease_id=lease,lease_actor=actor,lease_expires_at=stamp+interval '90 seconds',
    -- Persist BEFORE a potentially rotating refresh request. A process crash or
    -- lost response must never cause automatic reuse of the old refresh token.
    last_error=case when p_action='claim_refresh' then 'refresh_uncertain' else last_error end,
    updated_at=stamp where owner_id=workspace_owner returning * into current_row;
  elsif p_action='client' then
   if current_row.client_ciphertext is not null then raise exception 'CLOBE_STALE';end if;
   if jsonb_typeof(p_payload->'ciphertext') is distinct from 'string' then raise exception 'CLOBE_INVALID_PAYLOAD';end if;
   update private.fd_clobe_connections set client_ciphertext=p_payload->>'ciphertext',version=version+1,
    lease_id=null,lease_actor=null,lease_expires_at=null,updated_at=stamp
    where owner_id=workspace_owner returning * into current_row;
  elsif p_action='begin' then
   if current_row.client_ciphertext is null or (p_payload->>'attempt_id')::uuid is null then raise exception 'CLOBE_INVALID_PAYLOAD';end if;
   update private.fd_clobe_connections set attempt_id=(p_payload->>'attempt_id')::uuid,attempt_actor=actor,
    attempt_expires_at=stamp+interval '10 minutes',updated_at=stamp where owner_id=workspace_owner returning * into current_row;
  elsif p_action='consume' then
   if current_row.attempt_id is distinct from (p_payload->>'attempt_id')::uuid or current_row.attempt_id is null or current_row.attempt_actor is distinct from actor or current_row.attempt_expires_at<=stamp then raise exception 'CLOBE_ATTEMPT_INVALID';end if;
   update private.fd_clobe_connections set attempt_id=null,attempt_actor=null,attempt_expires_at=null,
    lease_id=lease,lease_actor=actor,lease_expires_at=stamp+interval '90 seconds',updated_at=stamp
    where owner_id=workspace_owner returning * into current_row;
  elsif p_action='tokens' then
   expiry:=(p_payload->>'expires_at')::timestamptz;
   if current_row.client_ciphertext is null or jsonb_typeof(p_payload->'ciphertext') is distinct from 'string' or expiry is null or expiry<=stamp or expiry>stamp+interval '367 days' then raise exception 'CLOBE_INVALID_PAYLOAD';end if;
   update private.fd_clobe_connections set token_ciphertext=p_payload->>'ciphertext',token_expires_at=expiry,
    connected_at=coalesce(connected_at,stamp),version=version+1,last_error=null,
    lease_id=null,lease_actor=null,lease_expires_at=null,updated_at=stamp
    where owner_id=workspace_owner returning * into current_row;
  elsif p_action='release' then
   if current_row.lease_id is distinct from lease or current_row.lease_actor is distinct from actor then raise exception 'CLOBE_STALE';end if;
   if p_payload->>'error' is not null and p_payload->>'error' not in ('request_failed','reconnect_required','refresh_uncertain') then raise exception 'CLOBE_INVALID_PAYLOAD';end if;
   update private.fd_clobe_connections set lease_id=null,lease_actor=null,lease_expires_at=null,
    last_error=coalesce(p_payload->>'error',last_error),updated_at=stamp
    where owner_id=workspace_owner returning * into current_row;
  end if;
 end if;
 -- No verifier, OAuth code, access token or refresh token is stored in plaintext.
 -- Actor and owner IDs, lease IDs and pending attempts are not returned.
 return jsonb_build_object('version',coalesce(current_row.version,0),'client_ciphertext',current_row.client_ciphertext,
  'token_ciphertext',current_row.token_ciphertext,'connected_at',current_row.connected_at,
  'token_expires_at',current_row.token_expires_at,'updated_at',current_row.updated_at,
  'last_error',current_row.last_error,'lease_expires_at',current_row.lease_expires_at);
end $$;
create function public.fd_clobe_auth(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$select private.fd_clobe_auth_core(p_action,p_payload)$$;
revoke all on function private.fd_clobe_auth_core(text,jsonb),public.fd_clobe_auth(text,jsonb) from public,anon,authenticated;
grant execute on function private.fd_clobe_auth_core(text,jsonb),public.fd_clobe_auth(text,jsonb) to authenticated;
commit;
