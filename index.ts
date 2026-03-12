// pi-gateway — HTTP gateway extension for pi
// Turns any running pi session into an OpenClaw-style gateway.
// External clients POST prompts; extension injects via pi.sendUserMessage().
// Pairs with pi-schedule-prompt for heartbeat/cron capabilities.

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

interface Job {
	id: string
	prompt: string
	status: 'queued' | 'processing' | 'complete' | 'error'
	response?: string
	error?: string
	duration_ms?: number
	timestamp: string
	resolve?: (job: Job) => void
}

const PORT = parseInt(process.env.GATEWAY_PORT ?? '3141', 10)
const TOKEN = process.env.GATEWAY_TOKEN ?? ''
const MAX_QUEUE = parseInt(process.env.GATEWAY_MAX_QUEUE ?? '10', 10)
const LOG_PATH = process.env.GATEWAY_LOG ?? `${homedir()}/.pi/gateway-log.jsonl`

export default function (pi: ExtensionAPI) {
	const queue: Job[] = []
	const jobs = new Map<string, Job>()
	const recentJobs: Job[] = []
	let processing = false
	let currentJob: Job | null = null
	let responseBuffer = ''
	let extensionCtx: ExtensionContext | null = null
	const startTime = Date.now()

	// Ensure log dir exists
	const logDir = dirname(LOG_PATH)
	if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })

	// Load recent history from log
	if (existsSync(LOG_PATH)) {
		try {
			const lines = readFileSync(LOG_PATH, 'utf-8').trim().split('\n')
			const recent = lines.slice(-50)
			for (const line of recent) {
				if (!line) continue
				try {
					const job = JSON.parse(line) as Job
					recentJobs.push(job)
					jobs.set(job.id, job)
				} catch { /* skip malformed */ }
			}
		} catch { /* fresh start */ }
	}

	function logJob(job: Job) {
		const entry = {
			id: job.id,
			prompt: job.prompt,
			status: job.status,
			response: job.response,
			error: job.error,
			duration_ms: job.duration_ms,
			timestamp: job.timestamp,
		}
		try {
			appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')
		} catch { /* best effort */ }
		recentJobs.push(entry as Job)
		if (recentJobs.length > 100) recentJobs.shift()
	}

	function updateWidget() {
		if (!extensionCtx) return
		const lines = [
			`  Gateway :${PORT}  ${processing ? '⟳ processing' : '✓ idle'}  queue: ${queue.length}`,
		]
		if (currentJob) {
			const truncated = currentJob.prompt.length > 60
				? currentJob.prompt.slice(0, 57) + '...'
				: currentJob.prompt
			lines.push(`  → ${truncated}`)
		}
		extensionCtx.ui.setWidget('gateway', lines, { placement: 'belowEditor' })
	}

	// Track whether we initiated the current agent run
	let gatewayInitiated = false

	function processNext() {
		if (processing || queue.length === 0) return

		// Check if agent is idle before sending
		if (extensionCtx && !extensionCtx.isIdle()) {
			// Agent busy (user typing or scheduled prompt). Retry shortly.
			setTimeout(processNext, 2000)
			return
		}

		const job = queue.shift()!
		currentJob = job
		processing = true
		gatewayInitiated = true
		job.status = 'processing'
		responseBuffer = ''
		updateWidget()

		// 5 min timeout safety net
		const timeout = setTimeout(() => {
			if (processing && currentJob?.id === job.id) {
				processing = false
				currentJob = null
				gatewayInitiated = false
				job.status = 'error'
				job.error = 'timeout (5m)'
				job.duration_ms = Date.now() - new Date(job.timestamp).getTime()
				logJob(job)
				jobs.set(job.id, job)
				job.resolve?.(job)
				updateWidget()
				setTimeout(processNext, 100)
			}
		}, 5 * 60 * 1000)

		;(job as any)._timeout = timeout

		// Inject the prompt
		pi.sendUserMessage(job.prompt)
	}

	// Capture streaming text from gateway-initiated jobs
	pi.on('message_update', async (event) => {
		if (!gatewayInitiated || !currentJob) return
		const delta = (event as any).assistantMessageEvent
		if (delta?.type === 'text_delta') {
			responseBuffer += delta.delta
		}
	})

	// Complete gateway-initiated jobs on agent_end
	pi.on('agent_end', async (event, ctx) => {
		extensionCtx = ctx

		if (!gatewayInitiated || !currentJob) {
			updateWidget()
			return
		}

		const job = currentJob
		clearTimeout((job as any)._timeout)

		processing = false
		currentJob = null
		gatewayInitiated = false

		// Try streaming buffer first, fall back to extracting from messages
		let response = responseBuffer.trim()
		if (!response && event.messages?.length) {
			// Extract text from assistant messages
			const texts: string[] = []
			for (const msg of event.messages) {
				if ((msg as any).role === 'assistant') {
					const content = (msg as any).content
					if (typeof content === 'string') {
						texts.push(content)
					} else if (Array.isArray(content)) {
						for (const block of content) {
							if (block.type === 'text' && block.text) {
								texts.push(block.text)
							}
						}
					}
				}
			}
			response = texts.join('\n').trim()
		}

		job.status = 'complete'
		job.response = response || '(no text response)'
		job.duration_ms = Date.now() - new Date(job.timestamp).getTime()

		logJob(job)
		jobs.set(job.id, job)
		job.resolve?.(job)
		updateWidget()

		// Process next in queue
		setTimeout(processNext, 100)
	})

	// --- HTTP Server ---

	function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
		if (!TOKEN) return true
		const auth = req.headers.authorization
		if (auth === `Bearer ${TOKEN}`) return true
		res.writeHead(401, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ error: 'unauthorized' }))
		return false
	}

	function readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let data = ''
			req.on('data', (chunk: Buffer) => { data += chunk.toString() })
			req.on('end', () => resolve(data))
			req.on('error', reject)
		})
	}

	function json(res: ServerResponse, status: number, body: unknown) {
		res.writeHead(status, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify(body))
	}

	async function handleRequest(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
		const path = url.pathname
		const method = req.method ?? 'GET'

		// CORS
		res.setHeader('Access-Control-Allow-Origin', '*')
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
		if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

		if (!checkAuth(req, res)) return

		if (method === 'GET' && path === '/health') {
			return json(res, 200, { ok: true })
		}

		if (method === 'GET' && path === '/status') {
			return json(res, 200, {
				idle: !processing,
				queue_depth: queue.length,
				active_job: currentJob
					? { id: currentJob.id, prompt: currentJob.prompt }
					: null,
				uptime_s: Math.floor((Date.now() - startTime) / 1000),
			})
		}

		if (method === 'GET' && path === '/history') {
			return json(res, 200, { jobs: recentJobs.slice(-50).reverse() })
		}

		if (method === 'GET' && path.startsWith('/job/')) {
			const id = path.slice(5)
			const job = jobs.get(id)
			if (!job) return json(res, 404, { error: 'job not found' })
			return json(res, 200, {
				id: job.id,
				prompt: job.prompt,
				status: job.status,
				response: job.response,
				error: job.error,
				duration_ms: job.duration_ms,
				timestamp: job.timestamp,
			})
		}

		if (method === 'POST' && path === '/prompt') {
			let body: { prompt?: string; mode?: string }
			try {
				body = JSON.parse(await readBody(req))
			} catch {
				return json(res, 400, { error: 'invalid json' })
			}

			if (!body.prompt || typeof body.prompt !== 'string') {
				return json(res, 400, { error: 'prompt required' })
			}

			if (queue.length >= MAX_QUEUE) {
				return json(res, 429, { error: 'queue full', queue_depth: queue.length })
			}

			const mode = body.mode === 'fire' ? 'fire' : 'sync'

			const job: Job = {
				id: randomUUID().slice(0, 8),
				prompt: body.prompt,
				status: 'queued',
				timestamp: new Date().toISOString(),
			}

			jobs.set(job.id, job)

			if (mode === 'fire') {
				queue.push(job)
				processNext()
				return json(res, 202, { id: job.id, status: 'queued' })
			}

			// Sync — wait for completion
			const result = await new Promise<Job>((resolve) => {
				job.resolve = resolve
				queue.push(job)
				processNext()
			})

			return json(res, 200, {
				id: result.id,
				status: result.status,
				response: result.response,
				error: result.error,
				duration_ms: result.duration_ms,
			})
		}

		json(res, 404, { error: 'not found' })
	}

	const server = createServer((req, res) => {
		handleRequest(req, res).catch((err) => {
			console.error('[gateway] request error:', err)
			json(res, 500, { error: 'internal error' })
		})
	})

	server.listen(PORT, '0.0.0.0')

	// --- Lifecycle ---

	pi.on('session_start', async (_event, ctx) => {
		extensionCtx = ctx
		ctx.ui.setStatus('gateway', `⚡ :${PORT}`)
		updateWidget()
	})

	pi.on('agent_start', async (_event, ctx) => {
		extensionCtx = ctx
		updateWidget()
	})

	pi.on('session_shutdown', async () => {
		server.close()
	})

	// --- /gateway command ---

	pi.registerCommand('gateway', {
		description: 'Show gateway status and recent jobs',
		handler: async (_args, ctx) => {
			const status = processing ? 'processing' : 'idle'
			const qd = queue.length
			const recent = recentJobs.slice(-5).reverse()
			let msg = `Gateway :${PORT} | ${status} | queue: ${qd}\n`
			if (recent.length) {
				msg += '\nRecent jobs:\n'
				for (const j of recent) {
					const t = j.prompt.length > 40
						? j.prompt.slice(0, 37) + '...'
						: j.prompt
					const icon = j.status === 'complete' ? '✓' : '✗'
					msg += `  ${icon} ${j.id} ${t} (${j.duration_ms ?? '?'}ms)\n`
				}
			} else {
				msg += '\nNo jobs yet.'
			}
			ctx.ui.notify(msg, 'info')
		},
	})
}
