/** Destructive fixture setup is restricted to the named disposable CI database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const prepare = process.argv[2] === 'prepare';
const pool = new Pool({
  connectionString: prepare ? process.env.MIGRATION_DATABASE_URL : process.env.DATABASE_URL,
  ssl: false,
});
try {
  const identity = (await pool.query('SELECT current_database() AS database,current_user AS role'))
    .rows[0];
  assert.equal(identity.database, 'outreachr_container');
  if (prepare) {
    await pool.query(
      "CREATE ROLE outreachr_container_runtime LOGIN PASSWORD 'local-runtime-password'",
    );
    await pool.query('CREATE TABLE public.outreachr_test_private (id integer)');
  } else {
    assert.equal(identity.role, 'outreachr_container_runtime');
    const user = randomUUID();
    const org = randomUUID();
    await pool.query('BEGIN');
    await pool.query(
      'INSERT INTO outreachr.users(id,email,name,email_verified) VALUES($1,$2,$3,true)',
      [user, 'container@example.test', 'Container fixture'],
    );
    await pool.query('INSERT INTO outreachr.organizations(id,name,created_by) VALUES($1,$2,$3)', [
      org,
      'Container fixture',
      user,
    ]);
    const job = await pool.query(
      `INSERT INTO outreachr.cloud_membership_jobs
       (id,org_id,user_id,desired_role,app_id,billing_account_id,environment,product_family_key)
       VALUES($1,$2,$3,'owner',$4,$5,'test','workspace') RETURNING position`,
      [randomUUID(), org, user, randomUUID(), randomUUID()],
    );
    assert.ok(Number(job.rows[0].position) > 0, 'runtime can allocate a membership queue position');
    await pool.query('ROLLBACK');
    await assert.rejects(pool.query('SELECT * FROM public.outreachr_test_private'), {
      code: '42501',
    });
    await assert.rejects(pool.query('CREATE TABLE outreachr.unexpected (id integer)'), {
      code: '42501',
    });
    console.log(
      'Restricted runtime can write its membership queue and cannot read private public data or create schema objects.',
    );
  }
} finally {
  await pool.end();
}
