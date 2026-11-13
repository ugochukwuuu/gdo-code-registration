<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import Admin from './Admin.vue'
import { configured, request, requestKey } from './api.js'
import { readSession, writeSession } from './session.js'
import { renderTicket } from './ticket.js'

const admin = ref(location.hash === '#admin')
const linkedCode = takeLinkedCode()

const saved = readSession('customer')
const savedIsRecent = saved?.savedAt > Date.now() - 24 * 60 * 60 * 1000
const restored = savedIsRecent && (!linkedCode || normaliseCode(linkedCode) === normaliseCode(saved.code)) ? saved : null
if (!restored) writeSession('customer', null)

const code = ref(linkedCode || restored?.code || '')
const pending = ref(restored?.pending || null)
const ticket = ref(restored?.ticket || null)
const step = ref(ticket.value ? 'ticket' : pending.value ? 'pending' : 'link')
const fullName = ref(pending.value?.fullName || '')
const parentName = ref(pending.value?.parentName || '')
const parentPhone = ref(pending.value?.parentPhone || '')
const parentEmail = ref(pending.value?.parentEmail || '')
const busy = ref(false)
const error = ref('')
const linkRejected = ref(false)
const rendering = ref(false)
const renderError = ref('')
const ticketUrl = ref('')
const heading = ref(null)
const progress = computed(() => step.value === 'ticket' ? 2 : 1)

function normaliseCode(value) {
  return value.trim().toUpperCase().replace(/[\s-]/g, '')
}

function takeLinkedCode() {
  const url = new URL(location.href)
  const fragment = new URLSearchParams(url.hash.slice(1))
  const hasInvite = fragment.has('invite') || fragment.has('code')
  if (!hasInvite && !url.searchParams.has('code')) return ''
  const incoming = fragment.get('invite') ?? fragment.get('code') ?? url.searchParams.get('code')
  url.searchParams.delete('code')
  if (hasInvite) url.hash = ''
  history.replaceState(history.state, '', url)
  return incoming || 'invalid'
}

function saveCustomer() {
  writeSession('customer', { code: code.value, pending: pending.value, ticket: ticket.value, savedAt: Date.now() })
}

function switchStep(next) {
  step.value = next
  nextTick(() => heading.value?.focus())
}

function updateRoute() {
  admin.value = location.hash === '#admin'
  if (admin.value || busy.value || rendering.value) return
  const incoming = takeLinkedCode()
  if (incoming && normaliseCode(incoming) !== normaliseCode(code.value)) {
    if (ticketUrl.value) URL.revokeObjectURL(ticketUrl.value)
    ticketUrl.value = renderError.value = ''
    pending.value = ticket.value = null
    fullName.value = parentName.value = parentPhone.value = parentEmail.value = ''
    code.value = incoming
    saveCustomer()
    switchStep('link')
    verify()
    return
  }
  if (step.value === 'ticket' && !ticketUrl.value && !renderError.value) makeTicket()
  if (step.value === 'link' && code.value && !error.value) verify()
}

async function verify() {
  if (busy.value || !code.value) return
  error.value = ''
  linkRejected.value = false
  if (!/^[0-9A-F]{20}$/.test(normaliseCode(code.value))) {
    linkRejected.value = true
    error.value = 'This registration link is invalid.'
    return
  }
  busy.value = true
  try {
    const result = await request('verify', { code: code.value })
    code.value = result.code
    saveCustomer()
    switchStep('form')
  } catch (failure) {
    linkRejected.value = ['INVALID_CODE', 'CODE_USED'].includes(failure.code)
    error.value = failure.message
  } finally {
    busy.value = false
    updateRoute()
  }
}

function prepareRegistration() {
  if (busy.value) return
  error.value = ''
  const name = fullName.value.trim().replace(/\s+/g, ' ')
  const digits = parentPhone.value.trim().replace(/[\s().-]/g, '')
  const emailAddress = parentEmail.value.trim()
  const contactName = parentName.value.trim().replace(/\s+/g, ' ')
  if (!/\p{L}/u.test(name) || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    error.value = 'Enter the child’s name using up to 100 characters.'
    return
  }
  if (!/\p{L}/u.test(contactName) || contactName.length > 100 || /[\u0000-\u001f\u007f]/.test(contactName)) {
    error.value = 'Enter the parent’s name using up to 100 characters.'
    return
  }
  if (parentPhone.value.trim().length > 40 || !/^\+?\d{7,15}$/.test(digits)) {
    error.value = 'Enter the parent’s phone number with 7 to 15 digits.'
    return
  }
  if (emailAddress.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
    error.value = 'Enter a valid parent’s email address.'
    return
  }
  pending.value = {
    code: code.value, fullName: name, parentName: contactName, parentPhone: digits,
    parentEmail: emailAddress, requestKey: requestKey(),
  }
  saveCustomer()
  redeem()
}

async function redeem() {
  if (busy.value || !pending.value) return
  error.value = ''
  busy.value = true
  try {
    const action = pending.value.parentName ? 'redeemWithParent' : pending.value.parentAddress ? 'redeemWithAddress' : 'redeem'
    ticket.value = await request(action, pending.value)
    pending.value = null
    fullName.value = parentName.value = parentPhone.value = parentEmail.value = ''
    saveCustomer()
    switchStep('ticket')
    makeTicket()
  } catch (failure) {
    if (['INVALID_CODE', 'CODE_USED', 'INVALID_NAME', 'INVALID_PARENT_NAME', 'INVALID_PHONE', 'INVALID_EMAIL', 'INVALID_ADDRESS', 'BAD_REQUEST', 'NOT_CONFIGURED'].includes(failure.code)) {
      pending.value = null
      linkRejected.value = ['INVALID_CODE', 'CODE_USED'].includes(failure.code)
      saveCustomer()
      switchStep(linkRejected.value ? 'link' : 'form')
    } else {
      switchStep('pending')
    }
    error.value = failure.message
  } finally {
    busy.value = false
    updateRoute()
  }
}

async function makeTicket() {
  if (rendering.value || !ticket.value) return
  rendering.value = true
  renderError.value = ''
  try {
    const blob = await renderTicket(ticket.value)
    if (ticketUrl.value) URL.revokeObjectURL(ticketUrl.value)
    ticketUrl.value = URL.createObjectURL(blob)
  } catch (failure) {
    renderError.value = failure.message || 'The ticket could not be prepared. Please try again.'
  } finally {
    rendering.value = false
    updateRoute()
  }
}

onMounted(() => {
  window.addEventListener('hashchange', updateRoute)
  if (code.value && !restored) saveCustomer()
  updateRoute()
})
onUnmounted(() => {
  window.removeEventListener('hashchange', updateRoute)
  if (ticketUrl.value) URL.revokeObjectURL(ticketUrl.value)
})
</script>

<template>
  <Admin v-if="admin" />
  <main v-else class="registration-shell">
    <aside class="event-panel" aria-label="Event information">
      <div class="event-inner">
        <p class="event-eyebrow"><span class="sparkle" aria-hidden="true">✦</span> Girls Day Out</p>
        <div class="event-title" aria-hidden="true">Girls<br /> Day Out <span>3.0</span></div>
        <dl class="event-details">
          <div><dt>Date</dt><dd><time datetime="2026-12-05">Saturday, 5 December 2026</time></dd></div>
          <div><dt>Venue</dt><dd>Hall of Celebration<br />Okpanam Road, Asaba</dd></div>
        </dl>
      </div>
    </aside>

    <section class="registration-main">
      <div class="registration-content">
        <ol v-if="step !== 'link'" class="steps" aria-label="Registration progress">
          <li v-for="(label, index) in ['Details', 'Ticket']" :key="label"
            :aria-current="progress === index + 1 ? 'step' : undefined"
            :class="{ reached: progress >= index + 1 }">
            <span class="step-number">{{ progress > index + 1 ? '✓' : index + 1 }}</span>{{ label }}
          </li>
        </ol>

        <p v-if="!configured" class="notice" role="status">Online registration is awaiting setup.</p>

        <template v-if="step === 'link'">
          <h1 ref="heading" tabindex="-1">Register for Girls Day Out 3.0</h1>
          <p v-if="code && (busy || !error)" class="intro" role="status">Checking your registration link…</p>
          <div v-else-if="code" class="form-stack">
            <p class="form-error" role="alert">{{ error }}</p>
            <p v-if="linkRejected" class="muted">Contact the organiser if you need help with your ticket.</p>
            <button v-else-if="configured" class="secondary-button" @click="verify">Retry link</button>
          </div>
        </template>

        <template v-else-if="step === 'form'">
          <h1 ref="heading" tabindex="-1">Your details</h1>
          <p class="intro">Enter the child’s name as it should appear on the ticket.</p>
          <form class="form-stack" @submit.prevent="prepareRegistration">
            <fieldset :disabled="busy" class="fields">
              <div><label for="full-name">Child’s name</label><input id="full-name" v-model="fullName" required maxlength="100" autocomplete="section-child name" /></div>
              <div><label for="parent-name">Parent’s name</label><input id="parent-name" v-model="parentName" required maxlength="100" autocomplete="section-parent name" /></div>
              <div><label for="parent-phone">Parent’s phone number</label><input id="parent-phone" v-model="parentPhone" required maxlength="40" type="tel" autocomplete="section-parent tel" /></div>
              <div><label for="parent-email">Parent’s email address</label><input id="parent-email" v-model="parentEmail" required maxlength="254" type="email" autocomplete="section-parent email" /></div>
            </fieldset>
            <p v-if="error" class="form-error" role="alert">{{ error }}</p>
            <button class="primary-button" :disabled="busy">{{ busy ? 'Registering…' : 'Complete registration' }} <span aria-hidden="true">→</span></button>
          </form>
        </template>

        <template v-else-if="step === 'pending'">
          <h1 ref="heading" tabindex="-1">Finish your registration</h1>
          <p class="intro">Retry the same submission to recover your ticket if the first attempt went through.</p>
          <p v-if="error" class="form-error" role="alert">{{ error }}</p>
          <button class="primary-button mt-5" :disabled="busy" @click="redeem">{{ busy ? 'Checking registration…' : 'Retry registration' }}</button>
        </template>

        <template v-else>
          <h1 ref="heading" tabindex="-1">You’re registered</h1>
          <p class="intro">Save your ticket and have it ready to show at the event.</p>
          <dl class="ticket-summary">
            <div><dt>Attendee</dt><dd>{{ ticket.fullName }}</dd></div>
            <div><dt>Ticket number</dt><dd>{{ ticket.ticketNumber }}</dd></div>
          </dl>
          <p v-if="rendering" class="intro" role="status">Preparing your ticket…</p>
          <div v-else-if="renderError" class="form-stack">
            <p class="form-error" role="alert">{{ renderError }}</p>
            <button class="secondary-button" @click="makeTicket">Retry ticket preview</button>
          </div>
          <template v-else-if="ticketUrl">
            <img class="ticket-image" :src="ticketUrl" :alt="'Ticket preview for ' + ticket.fullName" />
            <a class="primary-button" :href="ticketUrl" :download="ticket.ticketNumber + '.png'">Download ticket <span aria-hidden="true">↓</span></a>
          </template>
        </template>
      </div>
      <footer class="registration-footer"><span>Girls Day Out 3.0</span></footer>
    </section>
  </main>
</template>
