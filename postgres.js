const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
});

pool.on('connect', () => {
    console.log('✅🐘 PostgreSQL connected');
});

pool.on('error', (err) => {
    console.error('❌🐘 PostgreSQL connection error', err.stack);
});

module.exports = pool;