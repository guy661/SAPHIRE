/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = pgm => {
    pgm.addColumn('users', {
        email: { type: 'varchar(255)', unique: true }
    });
    pgm.addColumn('dashboards', {
        kill_keywords: { type: 'jsonb', default: '[]' }
    });
    pgm.addColumn('dashboard_articles', {
        email_sent: { type: 'boolean', default: false }
    });
};

exports.down = pgm => {
    pgm.removeColumn('users', 'email');
    pgm.removeColumn('dashboards', 'kill_keywords');
    pgm.removeColumn('dashboard_articles', 'email_sent');
};