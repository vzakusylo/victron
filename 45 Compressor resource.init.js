// On Start (d#133): read the counter file again after every node start
context.set('needLoad', true); context.set('loadAsked', false); context.set('startedAt', Date.now());
