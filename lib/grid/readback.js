//! D-Bus read-back and channel configuration for the grid controller (01).
const feedbackChannels = [
    { name: 'DVCC', topic: 'charge-current-limit', path: '/Settings/SystemSetup/MaxChargeCurrent', gap: 10100, tolerance: 0.01 },
    { name: 'ESS', topic: 'grid-setpoint', path: '/Settings/CGwacs/AcPowerSetPoint', gap: 10100, tolerance: 0 },
    { name: 'VE.Bus', topic: 'ac-input-current-limit', path: '/Ac/In/1/CurrentLimit', gap: 0, tolerance: 0.01 }
];

async function readGridOutput(channel) {
    const address = env.get('DBUS_SYSTEM_BUS_ADDRESS');
    const bus = address?.startsWith('tcp:')
        ? dbus.createClient({ busAddress: address, authMethods: ['ANONYMOUS'] }) : dbus.systemBus();
    const connection = bus.connection;
    let timer;
    const disconnected = new Promise((_, reject) => {
        connection.on('error', reject);
        connection.on('end', () => reject(new Error('D-Bus disconnected')));
        timer = setTimeout(() => reject(new Error('D-Bus read-back timed out')), 3000);
    });
    const read = (destination, path) => new Promise((resolve, reject) => {
        bus.invoke({ destination, path, interface: 'com.victronenergy.BusItem', member: 'GetValue' },
            (error, value) => error ? reject(new Error(String(error))) : resolve(value?.[1]?.[0]));
    });
    try {
        const value = await Promise.race([disconnected, (async () => {
            if (channel.name !== 'VE.Bus') return read('com.victronenergy.settings', channel.path);
            // Match the exact instance configured on the existing VE.Bus writer.
            const names = await new Promise((resolve, reject) => bus.listNames((error, result) =>
                error ? reject(new Error(String(error))) : resolve(result)));
            const matches = await Promise.allSettled(names.filter(name => name.startsWith('com.victronenergy.vebus.'))
                .map(async name => await read(name, '/DeviceInstance') === 276 ? name : undefined));
            const destinations = matches.filter(m => m.status === 'fulfilled' && m.value);
            if (destinations.length !== 1) throw new Error('VE.Bus instance 276 unavailable or ambiguous');
            return read(destinations[0].value, channel.path);
        })()]);
        if (!Number.isFinite(value)) throw new Error('D-Bus returned no numeric value');
        return { value };
    } finally {
        clearTimeout(timer);
        connection.stream.end();
    }
}
