#!/bin/sh
set -e

echo "Waiting for database..."
until bun -e "import postgres from 'postgres'; const sql = postgres(process.env.DATABASE_URL); await sql\`SELECT 1\`; await sql.end(); process.exit(0)" 2>/dev/null; do
  echo "  database not ready, retrying in 3s..."
  sleep 3
done
echo "Database is ready."

echo "Running database migrations..."
bun drizzle-kit migrate

echo "Starting server..."
exec bun run src/index.ts
