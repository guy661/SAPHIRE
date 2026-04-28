const pool = require('./postgres.js');

async function deleteAllDashboards() {
    try {
        await pool.query('DELETE FROM dashboards');
        console.log('Alle Dashboards wurden erfolgreich gelöscht.');
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
deleteAllDashboards();