/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = pgm => {
    pgm.sql(`
        ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS user_intent_embedding DOUBLE PRECISION[];
    `);
};

exports.down = pgm => {
    pgm.sql(`
        ALTER TABLE dashboards DROP COLUMN IF EXISTS user_intent_embedding;
    `);
};
