/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = pgm => {
    pgm.addColumn('dashboards', {
        selected_categories: {
            type: 'jsonb',
            default: '[]'
        }
    });
};

exports.down = pgm => {
    pgm.dropColumn('dashboards', 'selected_categories');
};
