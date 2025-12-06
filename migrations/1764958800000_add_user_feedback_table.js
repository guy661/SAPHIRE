/* eslint-disable camelcase */

exports.shorthands = undefined;

/**
 * @param {import("node-pg-migrate/dist/types").MigrationBuilder} pgm
 */
exports.up = pgm => {
    pgm.createTable('user_feedback', {
        id: 'id',
        user_id: {
            type: 'integer',
            notNull: true,
            references: '"users"(id)',
            onDelete: 'CASCADE'
        },
        cluster_id: {
            type: 'integer',
            notNull: true,
            references: '"clusters"(id)',
            onDelete: 'CASCADE'
        },
        feedback_type: {
            type: 'varchar(10)',
            notNull: true,
            check: "feedback_type IN ('like', 'dislike')"
        },
        created_at: {
            type: 'timestamp with time zone',
            notNull: true,
            default: pgm.func('current_timestamp')
        }
    });

    // Add a unique constraint to prevent a user from liking and disliking the same cluster.
    // A user can only have one feedback entry per cluster.
    pgm.addConstraint('user_feedback', 'user_feedback_unique_user_cluster', {
        unique: ['user_id', 'cluster_id']
    });

    pgm.createIndex('user_feedback', 'user_id');
    pgm.createIndex('user_feedback', 'cluster_id');
};

/**
 * @param {import("node-pg-migrate/dist/types").MigrationBuilder} pgm
 */
exports.down = pgm => {
    pgm.dropTable('user_feedback');
};
