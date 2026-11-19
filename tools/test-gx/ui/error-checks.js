'use strict';

function matches(error, rule) {
    return error.type === rule.type && error.text === rule.text;
}

function classifyErrors(errors, allowlist, expected) {
    const unexpected = errors.filter(error =>
        !allowlist.some(rule => matches(error, rule) && error.url === rule.url &&
            (rule.phase === undefined || error.phase === rule.phase)) &&
        !expected.some(rule => matches(error, rule)));
    const missing = expected.filter(rule => !errors.some(error => matches(error, rule)));
    return { unexpected, missing };
}

module.exports = { classifyErrors };
