// Auto-generates realistic SaaS order data
// Run alongside wavelet dev to see the dashboard come alive

const WAVELET_URL = process.env.WAVELET_URL || 'http://localhost:8080'

const tenants = ['acme', 'globex', 'initech', 'hooli', 'piedpiper']
const products = ['Pro Plan', 'Enterprise', 'API Credits', 'Storage', 'Support']
const regions = ['us-east', 'us-west', 'eu-west', 'ap-south', 'ap-east']

function randomOrder() {
  return {
    tenant_id: tenants[Math.floor(Math.random() * tenants.length)],
    amount: Math.round((Math.random() * 500 + 10) * 100) / 100,
    product: products[Math.floor(Math.random() * products.length)],
    region: regions[Math.floor(Math.random() * regions.length)],
    ts: new Date().toISOString(),
  }
}

async function emit() {
  const batch = Array.from({ length: 3 }, randomOrder)
  try {
    await fetch(`${WAVELET_URL}/v1/events/orders/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    })
  } catch {}
}

setInterval(emit, 200)
console.log(`Seeding orders to ${WAVELET_URL} (3 events every 200ms)`)
