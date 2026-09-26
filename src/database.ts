import { Client } from 'pg';

// Each invocation gets its own client. Hyperdrive owns the shared connection pool.
// Do not put a pg Client/Pool in global scope across Worker requests.
export async function checkDatabase(binding: Hyperdrive): Promise<void> {
  const client = new Client({
    connectionString: binding.connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  try {
    await client.connect();
    const result = await client.query<{ ok: number }>('SELECT 1 AS ok');
    if (result.rows[0]?.ok !== 1) throw new Error('database_check_failed');
  } finally {
    await client.end();
  }
}
