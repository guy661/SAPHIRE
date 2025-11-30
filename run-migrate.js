// run-migrate.js
require('dotenv').config();
const { execSync } = require('child_process');

// Construct the environment variables for node-pg-migrate
// It reads the application's PG_ prefixed variables and maps them
// to the PG prefixed variables that node-pg-migrate expects.
const env = {
    ...process.env,
    PGHOST: process.env.PG_HOST,
    PGPORT: process.env.PG_PORT,
    PGUSER: process.env.PG_USER,
    PGPASSWORD: process.env.PG_PASSWORD,
    PGDATABASE: process.env.PG_DATABASE,
};

try {
    // Get the arguments passed to the npm script (e.g., 'up', 'down', 'create')
    const args = process.argv.slice(2).join(' ');
    // Construct the full command to run the local node-pg-migrate binary
    const command = `node node_modules/node-pg-migrate/bin/node-pg-migrate ${args}`;
    
    console.log(`[Migration Script] Executing: node-pg-migrate ${args}`);
    
    // Execute the command synchronously with the customized environment
    execSync(command, { stdio: 'inherit', env });

} catch (error) {
    console.error('[Migration Script] Migration failed.');
    // The error from the child process is already printed to stderr by `stdio: 'inherit'`,
    // so we just need to exit with a failure code.
    process.exit(1);
}
