// This page only reads the monitor's file. Never forward file errors, raw context or log lines to the browser.
if (msg.error) {
    const missing = String(msg.error.message || '').includes('ENOENT');
    return { payload: { message: missing ? 'No deployments have been monitored yet.' : 'Health history could not be read.' } };
}
try {
    const { deploys } = JSON.parse(msg.payload);
    if (!Array.isArray(deploys) || !deploys.length) throw new Error('Empty or invalid history');
    return { payload: { deploys: deploys.map(deploy => {
        const { id, version, startedAt, windowStartedAt, endsAt, finishedAt, samples } = deploy;
        const { at, status, checks } = samples.at(-1);
        return { id, version, startedAt, windowStartedAt, endsAt, finishedAt, at, status,
            checks: checks.map(({ id, name, level, detail }) => ({ id, name, level, detail })) };
    }) } };
} catch (error) {
    node.warn('Invalid post-deploy health history: ' + error.name);
    return { payload: { message: 'Health history is invalid.' } };
}
