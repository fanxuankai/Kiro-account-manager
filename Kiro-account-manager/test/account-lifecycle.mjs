import assert from 'node:assert/strict'
import {
  classifyAccountLifecycle,
  DEFAULT_ACCOUNT_LIFECYCLE_THRESHOLDS,
  getAccountUsagePercent,
  getLifecycleCounts
} from '../src/renderer/src/lib/accountLifecycle.ts'

const thresholds = { ...DEFAULT_ACCOUNT_LIFECYCLE_THRESHOLDS }

function account({
  type = 'Free',
  current = 0,
  limit = 25,
  percentUsed = limit > 0 ? current / limit : 0,
  paymentLink
} = {}) {
  return {
    subscription: { type, ...(paymentLink === undefined ? {} : { paymentLink }) },
    usage: { current, limit, percentUsed }
  }
}

assert.equal(classifyAccountLifecycle(account()), 'unused')
assert.equal(classifyAccountLifecycle(account({ paymentLink: '' })), 'unused')
assert.equal(classifyAccountLifecycle(account({ paymentLink: '   ' })), 'unused')
assert.equal(classifyAccountLifecycle(account({ paymentLink: 'https://pay.example/1' })), 'pendingPayment')
assert.equal(classifyAccountLifecycle(account({ type: 'Pro', current: 0 })), 'subscribed')
assert.equal(classifyAccountLifecycle(account({ type: 'Pro Plus', current: 59, limit: 1000 })), 'subscribed')
assert.equal(classifyAccountLifecycle(account({ type: 'Enterprise', current: 1, limit: 1000 })), 'subscribed')
assert.equal(classifyAccountLifecycle(account({ current: 1, limit: 1000 })), 'deprecated')
assert.equal(classifyAccountLifecycle(account({ type: 'Pro', current: 60, limit: 1000 })), 'deprecated')
assert.equal(classifyAccountLifecycle(account({ type: 'Enterprise', current: 1, limit: 10 })), 'deprecated')
assert.equal(classifyAccountLifecycle(account({ current: 10, limit: 100 })), 'deprecated')
assert.equal(classifyAccountLifecycle(account({ type: 'Pro', current: 60, limit: 100 })), 'deprecated')

// A deprecated condition wins over the paid subscription bucket.
assert.equal(classifyAccountLifecycle(account({ type: 'Pro', current: 60, limit: 1000 })), 'deprecated')

// When current/limit cannot be used, stored historical percentage supports both formats.
const historical01 = account({ current: 0, limit: 0, percentUsed: 0.1 })
const historical100 = account({ current: 0, limit: 0, percentUsed: 10 })
assert.equal(getAccountUsagePercent(historical01), 0.1)
assert.equal(getAccountUsagePercent(historical100), 0.1)
assert.equal(classifyAccountLifecycle(historical01), 'deprecated')
assert.equal(classifyAccountLifecycle(historical100), 'deprecated')

// A valid current/limit pair takes precedence over a stale percentUsed value.
const validUsage = account({ current: 0, limit: 100, percentUsed: 99 })
assert.equal(getAccountUsagePercent(validUsage), 0)
assert.equal(classifyAccountLifecycle(validUsage), 'unused')

const counts = getLifecycleCounts([
  account(),
  account({ paymentLink: 'https://pay.example/2' }),
  account({ type: 'Pro' }),
  account({ current: 1, limit: 1000 })
], thresholds)
assert.deepEqual(counts, { unused: 1, pendingPayment: 1, subscribed: 1, deprecated: 1 })

console.log('account lifecycle tests passed')
