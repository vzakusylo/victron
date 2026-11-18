'use strict';
// TEST GX ONLY - not for any real Node-RED.
// The published admin port MUST be bound to 127.0.0.1: anonymous admin is intentional for scenarios.
// Hash of the fake password "test-only-not-a-secret" with a fixed test-only salt.
module.exports = {
    flowFile: 'flows.json',
    httpAdminRoot: '/',
    credentialSecret: 'test-only-not-a-secret',
    adminAuth: {
        type: 'credentials',
        users: [{ username: 'test-only-admin', password: '$2a$10$abcdefghijklmnopqrstuud40sZe9YD2AFwv0u1Os6NY0jgVorBEC', permissions: '*' }],
        default: { permissions: '*' }
    },
    contextStorage: { default: { module: 'memory' } },
    functionGlobalContext: {},
    functionExternalModules: true
};
