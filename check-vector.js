const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function checkExtensions() {
    try {
        const res = await pool.query('SELECT name FROM pg_available_extensions WHERE name = \'vector\'');
        console.log('Vector extension available:', res.rows.length > 0);
        if (res.rows.length > 0) {
            const installed = await pool.query('SELECT extname FROM pg_extension WHERE extname = \'vector\'');
            console.log('Vector extension installed:', installed.rows.length > 0);
        }
    } catch (err) {
        console.error('Error checking extensions:', err.message);
    } finally {
        await pool.end();
    }
}

checkExtensions();
