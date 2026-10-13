// Temp connectivity probe for the private Alchemy devnet RPC. Not committed.
const RPC = process.env.SLIME_RPC;

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: await res.json() };
}

const health = await rpc('getHealth');
console.log('getHealth ->', health.status, JSON.stringify(health.body));
const slot = await rpc('getSlot');
console.log('getSlot   ->', slot.status, JSON.stringify(slot.body));
const version = await rpc('getVersion');
console.log('version   ->', version.status, JSON.stringify(version.body));
