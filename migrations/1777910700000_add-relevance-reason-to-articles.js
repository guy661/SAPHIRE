/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = pgm => {
    pgm.addColumn('dashboard_articles', {
        relevance_reason: { type: 'text' }
    });
};

exports.down = pgm => {
    pgm.removeColumn('dashboard_articles', 'relevance_reason');
};