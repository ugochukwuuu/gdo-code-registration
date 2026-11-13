<script setup>
import { compactCode } from './invitation.js'
import { computed, onMounted, ref } from 'vue'
import { request, requestKey } from './api.js'
import { readSession, writeSession } from './session.js'

const token = ref(readSession('admin') || '')
const password = ref('')
const busy = ref(false)
const error = ref('')
const message = ref('')
const tab = ref('codes')
const status = ref('All')
const count = ref(5)
const pending = ref(readSession('admin-batch'))
const generated = ref([])
const dashboard = ref(null)
const canRefresh = computed(() => token.value && !busy.value)
const dateFormat = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' })

function displayDate(value) {
  return value ? dateFormat.format(new Date(value)) : '—'
}

function setToken(value) {
  token.value = value
  writeSession('admin', value || null)
  if (!value) {
    dashboard.value = null
    generated.value = []
  }
}

function handle(failure) {
  if (failure.code === 'UNAUTHENTICATED') setToken('')
  error.value = failure.message
}

async function load(page = 1) {
  dashboard.value = await request('adminList', { token: token.value, tab: tab.value, status: status.value, page })
}

async function perform(operation) {
  if (busy.value) return
  busy.value = true
  error.value = message.value = ''
  try {
    await operation()
  } catch (failure) {
    handle(failure)
  } finally {
    busy.value = false
  }
}

function signIn() {
  perform(async () => {
    const result = await request('adminLogin', { password: password.value })
    password.value = ''
    setToken(result.token)
    await load()
  })
}

function signOut() {
  perform(async () => {
    const previousToken = token.value
    setToken('')
    pending.value = null
    writeSession('admin-batch', null)
    await request('adminLogout', { token: previousToken })
  })
}

function clearBatch() {
  pending.value = null
  writeSession('admin-batch', null)
}

function generate(quantity) {
  if (busy.value) return
  if (!pending.value) {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      error.value = 'Enter a batch size between 1 and 100.'
      return
    }
    pending.value = { count: quantity, requestKey: requestKey() }
    writeSession('admin-batch', pending.value)
  }
  perform(async () => {
    try {
      const result = await request('adminGenerate', { token: token.value, ...pending.value })
      generated.value = result.codes
      clearBatch()
    } catch (failure) {
      if (['INVALID_COUNT', 'BAD_REQUEST', 'CODE_COLLISION', 'NOT_CONFIGURED'].includes(failure.code)) clearBatch()
      throw failure
    }
    tab.value = 'codes'
    status.value = 'All'
    dashboard.value = null
    await load()
  })
}

function selectTab(nextTab) {
  if (!canRefresh.value || nextTab === tab.value) return
  tab.value = nextTab
  dashboard.value = null
  perform(() => load())
}

function selectStatus(event) {
  status.value = event.target.value
  dashboard.value = null
  perform(() => load())
}

function registrationLink(code) {
  const link = new URL(location.href)
  link.search = ''
  link.hash = compactCode(code)
  return link.href
}

async function copyLink(code) {
  try {
    await navigator.clipboard.writeText(registrationLink(code))
    message.value = 'Registration link copied.'
  } catch {
    message.value = 'Clipboard access is unavailable. Select the registration link to copy it manually.'
  }
}

onMounted(() => {
  if (token.value) perform(() => load())
})
</script>

<template>
  <main v-if="!token" class="admin-login">
    <div class="login-card">
      <a href="#" class="text-button">← Back to registration</a>
      <h1>Organiser sign-in</h1>
      <form class="form-stack" @submit.prevent="signIn">
        <label for="password">Admin password</label>
        <input id="password" v-model="password" required maxlength="128" type="password" autocomplete="current-password" :disabled="busy" />
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary-button" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }} <span aria-hidden="true">→</span></button>
      </form>
    </div>
  </main>

  <div v-else class="admin-shell">
    <header class="admin-header">
      <div><p class="event-eyebrow"><span class="sparkle" aria-hidden="true">✦</span> Girls Day Out 3.0</p><h1>Ticket dashboard</h1></div>
      <button type="button" class="outline-light" :disabled="busy" @click="signOut">Sign out</button>
    </header>
    <main class="admin-main">
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p class="copy-status" role="status">{{ message }}</p>
      <dl v-if="dashboard" class="stats">
        <div><dt>Links generated</dt><dd>{{ dashboard.totals.generated }}</dd></div>
        <div><dt>Redeemed</dt><dd>{{ dashboard.totals.redeemed }}</dd></div>
        <div><dt>Remaining</dt><dd>{{ dashboard.totals.remaining }}</dd></div>
      </dl>

      <section class="admin-card">
        <h2>Generate one-time registration links</h2>
        <div v-if="pending" class="batch-controls">
          <button class="secondary-button" :disabled="busy" @click="generate(pending.count)">{{ busy ? 'Generating…' : 'Retry generation' }}</button>
        </div>
        <div v-else class="batch-controls">
          <button type="button" class="secondary-button" :disabled="busy" @click="generate(1)">Generate one link</button>
          <form class="batch-form" @submit.prevent="generate(count)">
            <label for="batch-count">Batch size</label>
            <input id="batch-count" v-model.number="count" type="number" required min="1" max="100" step="1" :disabled="busy" />
            <button class="primary-button" :disabled="busy">Generate batch</button>
          </form>
        </div>
        <ul v-if="generated.length" class="generated-list" aria-label="Links just generated">
          <li v-for="code in generated" :key="code">
            <input class="link-value" readonly aria-label="New registration link" :value="registrationLink(code)" @focus="$event.target.select()" />
            <button class="text-button" @click="copyLink(code)">Copy link</button>
          </li>
        </ul>
      </section>

      <section class="admin-card">
        <div class="list-toolbar">
          <div class="admin-tabs" aria-label="Dashboard views">
            <button class="text-button" :aria-pressed="tab === 'codes'" :disabled="busy" @click="selectTab('codes')">Registration links</button>
            <button class="text-button" :aria-pressed="tab === 'attendees'" :disabled="busy" @click="selectTab('attendees')">Attendees</button>
          </div>
          <div class="table-actions">
            <label v-if="tab === 'codes'">Status
              <select :value="status" :disabled="busy" @change="selectStatus">
                <option>All</option><option>Unused</option><option>Used</option>
              </select>
            </label>
            <button class="secondary-button" :disabled="busy" @click="perform(() => load(dashboard?.page))">Refresh</button>
          </div>
        </div>

        <p v-if="busy" class="muted my-3" role="status">Working…</p>
        <p v-else-if="dashboard && !dashboard.items.length" class="muted my-3">{{ tab === 'codes' ? 'No registration links in this view.' : 'No attendees have registered yet.' }}</p>

        <div v-if="dashboard?.items.length" class="table-wrap" tabindex="0" :aria-label="tab === 'codes' ? 'Registration links' : 'Registered attendees'">
          <table v-if="tab === 'codes'">
            <thead><tr><th>Registration link</th><th>Status</th><th>Created</th><th>Redeemed</th></tr></thead>
            <tbody>
              <tr v-for="item in dashboard.items" :key="item.code">
                <td>
                  <div v-if="item.status === 'Unused'" class="link-actions">
                    <input class="link-value" readonly aria-label="Registration link" :value="registrationLink(item.code)" @focus="$event.target.select()" />
                    <button class="text-button" @click="copyLink(item.code)">Copy link</button>
                  </div>
                  <span v-else class="muted">Redeemed</span>
                </td>
                <td><span class="status-pill" :class="{ used: item.status === 'Used' }">{{ item.status }}</span></td>
                <td>{{ displayDate(item.createdAt) }}</td><td>{{ displayDate(item.redeemedAt) }}</td>
              </tr>
            </tbody>
          </table>
          <table v-else>
            <thead><tr><th>Child’s name</th><th>Age</th><th>Parent’s name</th><th>Parent’s phone number</th><th>Parent’s email</th><th>Ticket number</th><th>Registered</th></tr></thead>
            <tbody>
              <tr v-for="item in dashboard.items" :key="item.ticketNumber">
                <td>{{ item.fullName }}</td><td>{{ item.childAge === '' || item.childAge == null ? '—' : item.childAge }}</td><td>{{ item.parentName || '—' }}</td>
                <td>{{ item.parentPhone || '—' }}</td><td>{{ item.parentEmail || '—' }}</td><td><code>{{ item.ticketNumber }}</code></td><td>{{ displayDate(item.registeredAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <nav v-if="dashboard?.pages > 1" class="pagination" aria-label="Dashboard pages">
          <button class="secondary-button" :disabled="busy || dashboard.page === 1" @click="perform(() => load(dashboard.page - 1))">Previous</button>
          <span>Page {{ dashboard.page }} of {{ dashboard.pages }}</span>
          <button class="secondary-button" :disabled="busy || dashboard.page === dashboard.pages" @click="perform(() => load(dashboard.page + 1))">Next</button>
        </nav>
      </section>
    </main>
  </div>
</template>
