const { Pool } = require('pg');
require('dotenv').config();

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : {
    rejectUnauthorized: false
  }
};

// Fallback if DATABASE_URL is missing but individual PG_ variables are present
if (!poolConfig.connectionString && process.env.PG_HOST) {
    poolConfig.host = process.env.PG_HOST;
    poolConfig.user = process.env.PG_USER;
    poolConfig.password = process.env.PG_PASSWORD;
    poolConfig.database = process.env.PG_DATABASE;
    poolConfig.port = process.env.PG_PORT || 5432;
    poolConfig.ssl = false; // Usually local if individual variables are used
}

const pool = new Pool(poolConfig);

pool.on('connect', () => {
    // console.log('✅🐘 PostgreSQL connected');
});

pool.on('error', (err) => {
    console.error('❌🐘 PostgreSQL connection error', err.stack);
});

module.exports = pool;