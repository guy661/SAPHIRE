/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = pgm => {
    pgm.addColumn('dashboards', {
        search_terms: {
            type: 'jsonb',
            default: '[]'
        }
    });
};

exports.down = pgm => {
    pgm.dropColumn('dashboards', 'search_terms');
};
