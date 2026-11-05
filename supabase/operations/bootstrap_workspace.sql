-- One-time installation operation, never a migration or an application RPC.
-- 1. Apply every migration to your own Supabase project.
-- 2. Sign in to your installation with the intended administrator's Google account.
-- 3. In your own project's Authentication > Users, copy that user's UUID.
-- 4. Replace the placeholder below and run this entire file in the SQL Editor
--    as postgres (or a trusted direct postgres connection). Refresh the app.
-- Review the exact user in Auth first. Do not accept a UUID from an untrusted
-- browser request. Repository ownership never grants an installation's access.
-- The workspace's storage namespace is this first administrator's UUID; later
-- administrator invitations and revocations do not change that namespace.
begin;
do $$
declare
 initial_admin_user_id_input text := 'REPLACE_WITH_INITIAL_ADMIN_AUTH_USER_UUID';
 initial_admin_user_id uuid;
 initial_admin_email text;
 finance_table record;
 unexpected_owner boolean;
begin
 if current_user <> 'postgres' then
  raise exception 'BOOTSTRAP_TRUSTED_SQL_REQUIRED: run as postgres in your own project SQL Editor';
 end if;
 if initial_admin_user_id_input !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
  raise exception 'BOOTSTRAP_USER_REQUIRED: replace the initial administrator UUID placeholder';
 end if;
 initial_admin_user_id := initial_admin_user_id_input::uuid;
 lock table private.finance_workspace, private.finance_administrators in exclusive mode;
 if exists(select 1 from private.finance_workspace)
  or exists(select 1 from private.finance_administrators)
  or exists(select 1 from private.finance_admin_events) then
  raise exception 'BOOTSTRAP_ALREADY_INITIALIZED: use the existing administrator invitation flow';
 end if;
 -- Match a confirmed Auth email to a verified Google identity. User-editable
 -- profile metadata is deliberately excluded from this authorization decision.
 select lower(btrim(u.email)) into initial_admin_email
 from auth.users u
 where u.id=initial_admin_user_id and u.email_confirmed_at is not null
  and nullif(btrim(u.email),'') is not null
  and exists(select 1 from auth.identities i where i.user_id=u.id
   and i.provider='google'
   and lower(btrim(i.identity_data->>'email'))=lower(btrim(u.email))
   and i.identity_data->>'email_verified'='true');
 if initial_admin_email is null then
  raise exception 'BOOTSTRAP_VERIFIED_GOOGLE_USER_REQUIRED: select the intended confirmed Google Auth user';
 end if;
 -- Refuse to silently adopt a different user's preexisting finance records.
 for finance_table in
  select n.nspname as schema_name,c.relname as table_name
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attname='owner_id' and not a.attisdropped
  where n.nspname in ('public','private') and c.relkind in ('r','p')
   and left(c.relname,3)='fd_'
 loop
  execute format('select exists(select 1 from %I.%I where owner_id<>$1)',finance_table.schema_name,finance_table.table_name)
   into unexpected_owner using initial_admin_user_id;
  if unexpected_owner then
   raise exception 'BOOTSTRAP_FOREIGN_DATA: review %.% before choosing a workspace owner',finance_table.schema_name,finance_table.table_name;
  end if;
 end loop;
 if exists(select 1 from storage.objects where bucket_id='finance-uploads'
  and (storage.foldername(name))[1] is distinct from initial_admin_user_id::text) then
  raise exception 'BOOTSTRAP_FOREIGN_FILES: review existing finance uploads before choosing a workspace owner';
 end if;
 insert into private.finance_workspace(singleton,data_owner_id) values(true,initial_admin_user_id);
 insert into private.finance_administrators(email,user_id,status,accepted_at)
  values(initial_admin_email,initial_admin_user_id,'active',now());
 insert into private.finance_admin_events(actor_id,action,subject_email)
  values(initial_admin_user_id,'bootstrap_admin',initial_admin_email);
end $$;
commit;
