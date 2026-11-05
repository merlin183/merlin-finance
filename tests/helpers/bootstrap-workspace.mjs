// Synthetic local PostgreSQL fixtures only. The real installer operation is
// executed as the test database's trusted postgres role, never through an RPC.
import {readFile} from 'node:fs/promises';

export async function bootstrapWorkspace(db, owner) {
 if(!/^[0-9a-f-]{36}$/i.test(owner))throw new Error('Invalid synthetic owner UUID');
 const sql=await readFile(new URL('../../supabase/operations/bootstrap_workspace.sql',import.meta.url),'utf8');
 await db.exec(sql.replace('REPLACE_WITH_INITIAL_ADMIN_AUTH_USER_UUID',owner));
}

// Existing feature fixtures exercise a second administrator's verified Google
// invitation acceptance. Seed an explicit trusted invitation after bootstrap;
// the schema itself never contains a user's email or grants anyone access.
export async function bootstrapSyntheticWorkspace(db, owner, administratorEmail) {
 await bootstrapWorkspace(db,owner);
 if(administratorEmail)await db.query(`
  insert into private.finance_administrators(email,status,invited_by,expires_at)
  values(lower(btrim($1)),'pending',$2,now()+interval '7 days')`,[administratorEmail,owner]);
}
