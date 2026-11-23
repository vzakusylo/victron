// Node-RED cancels the timer on stop; discard its pending flag on start.
context.set('modelPending', false);
