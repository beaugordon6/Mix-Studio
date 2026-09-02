'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function queueEntry(number, promptId, prompt = {}, extraData = {}, outputs = []) {
  return [number, promptId, clone(prompt), clone(extraData), clone(outputs)];
}

/**
 * A deliberately small, deterministic ComfyUI HTTP double.
 *
 * It models the durability boundary rather than graph execution. In
 * particular, POST /prompt accepts caller UUIDs but intentionally does not
 * deduplicate them, matching the risk Mix must guard against before retrying.
 */
class FakeComfy {
  constructor(options = {}) {
    this.hostname = options.hostname || '127.0.0.1';
    this.systemStats = clone(options.systemStats || {
      system: {
        os: process.platform,
        comfyui_version: '0.0.0-fake',
        python_version: 'fake',
        pytorch_version: 'fake',
        embedded_python: false,
        argv: ['main.py'],
      },
      devices: [],
    });
    this.running = [];
    this.pending = [];
    this.history = {};
    this.cancelled = new Set();
    this.requests = [];
    this.submissions = [];
    this._faults = new Map();
    this._sequence = 0;
    this._server = null;
    this._sockets = new Set();
    this.url = '';
  }

  /** Queue a one-shot fault. Repeated calls at a point execute FIFO. */
  fault(point, specification = { type: 'drop' }) {
    const queue = this._faults.get(point) || [];
    queue.push(typeof specification === 'string' ? { type: specification } : clone(specification));
    this._faults.set(point, queue);
    return this;
  }

  clearFaults() {
    this._faults.clear();
  }

  submissionCount(promptId) {
    return this.submissions.filter((entry) => !promptId || entry.promptId === promptId).length;
  }

  enqueue(promptId, options = {}) {
    const id = String(promptId || crypto.randomUUID());
    const entry = queueEntry(
      ++this._sequence,
      id,
      options.prompt || {},
      options.extraData || {},
      options.outputs || [],
    );
    (options.state === 'running' ? this.running : this.pending).push(entry);
    return id;
  }

  startPrompt(promptId) {
    const index = this.pending.findIndex((entry) => entry[1] === promptId);
    if (index < 0) return false;
    this.running.push(this.pending.splice(index, 1)[0]);
    return true;
  }

  completePrompt(promptId, options = {}) {
    const removed = this._removeFromQueue(promptId);
    const source = removed[0] || queueEntry(++this._sequence, promptId);
    const outcome = String(options.outcome || 'success').toLowerCase();
    const cancelled = ['cancelled', 'canceled', 'interrupted'].includes(outcome);
    const succeeded = outcome === 'success' || outcome === 'completed';
    const statusText = cancelled ? 'error' : (succeeded ? 'success' : 'error');
    const messages = cancelled ? [['execution_interrupted', { prompt_id: promptId }]] : [];
    this.history[promptId] = {
      prompt: clone(source),
      outputs: clone(options.outputs || {}),
      status: {
        status_str: statusText,
        completed: succeeded,
        messages,
      },
    };
    if (cancelled) this.cancelled.add(promptId);
    return clone(this.history[promptId]);
  }

  cancelPrompt(promptId) {
    const wasRunning = this.running.some((entry) => entry[1] === promptId);
    if (wasRunning) {
      // Preserve the original graph and extra_data in the history record.
      this.completePrompt(promptId, { outcome: 'interrupted' });
      return true;
    }
    const removed = this._removeFromQueue(promptId);
    if (!removed.length) return false;
    this.cancelled.add(promptId);
    // Pending deletion in Comfy has no history. A running interruption does.
    return true;
  }

  snapshot() {
    return {
      queue: {
        queue_running: clone(this.running),
        queue_pending: clone(this.pending),
      },
      history: clone(this.history),
      cancelled: [...this.cancelled],
      submissions: clone(this.submissions),
      requests: clone(this.requests),
    };
  }

  async start() {
    if (this._server) return this;
    this._server = http.createServer((req, res) => {
      this._handle(req, res).catch((error) => {
        if (!res.headersSent) json(res, 500, { error: String(error.message || error) });
        else res.destroy(error);
      });
    });
    this._server.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.once('close', () => this._sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      this._server.once('error', reject);
      this._server.listen(0, this.hostname, resolve);
    });
    const address = this._server.address();
    this.url = `http://${this.hostname}:${address.port}`;
    return this;
  }

  async close() {
    if (!this._server) return;
    const server = this._server;
    this._server = null;
    for (const socket of this._sockets) socket.destroy();
    this._sockets.clear();
    await new Promise((resolve) => server.close(resolve));
    this.url = '';
  }

  _removeFromQueue(promptId) {
    const removed = [];
    for (const list of [this.running, this.pending]) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (list[index][1] === promptId) removed.unshift(...list.splice(index, 1));
      }
    }
    return removed;
  }

  _takeFault(point) {
    const queue = this._faults.get(point);
    if (!queue || !queue.length) return null;
    const value = queue.shift();
    if (!queue.length) this._faults.delete(point);
    return value;
  }

  async _applyFault(point, req, res) {
    const fault = this._takeFault(point);
    if (!fault) return false;
    if (fault.delayMs) await new Promise((resolve) => setTimeout(resolve, Number(fault.delayMs)));
    if (fault.type === 'drop') {
      req.socket.destroy();
      return true;
    }
    if (fault.type === 'http') {
      json(res, Number(fault.status) || 503, fault.body || { error: `Injected fault: ${point}` });
      return true;
    }
    if (fault.type === 'empty') {
      res.writeHead(Number(fault.status) || 200);
      res.end();
      return true;
    }
    throw new Error(`Unknown fake Comfy fault type: ${fault.type}`);
  }

  async _handle(req, res) {
    const target = new URL(req.url, 'http://fake-comfy.test');
    const route = target.pathname;
    this.requests.push({ method: req.method, route });

    if (route === '/system_stats' && req.method === 'GET') {
      if (await this._applyFault('system_stats.beforeResponse', req, res)) return;
      json(res, 200, this.systemStats);
      return;
    }
    if (route === '/queue' && req.method === 'GET') {
      if (await this._applyFault('queue.beforeResponse', req, res)) return;
      json(res, 200, { queue_running: this.running, queue_pending: this.pending });
      return;
    }
    if ((route === '/history' || route.startsWith('/history/')) && req.method === 'GET') {
      if (await this._applyFault('history.beforeResponse', req, res)) return;
      const id = route === '/history' ? '' : decodeURIComponent(route.slice('/history/'.length));
      json(res, 200, id
        ? (this.history[id] ? { [id]: this.history[id] } : {})
        : this.history);
      return;
    }
    if (route === '/prompt' && req.method === 'POST') {
      if (await this._applyFault('prompt.beforeAccept', req, res)) return;
      const body = await readJson(req);
      const promptId = String(body.prompt_id || crypto.randomUUID());
      this.enqueue(promptId, {
        prompt: body.prompt || {},
        extraData: body.extra_data || {},
        outputs: body.outputs_to_execute || [],
      });
      this.submissions.push({ promptId, body: clone(body) });
      if (await this._applyFault('prompt.afterAccept', req, res)) return;
      json(res, 200, { prompt_id: promptId, number: this._sequence, node_errors: {} });
      return;
    }
    if (route === '/queue' && req.method === 'POST') {
      const body = await readJson(req);
      if (await this._applyFault('cancel.beforeApply', req, res)) return;
      for (const id of Array.isArray(body.delete) ? body.delete.map(String) : []) this.cancelPrompt(id);
      if (await this._applyFault('cancel.afterApply', req, res)) return;
      json(res, 200, {});
      return;
    }
    const cancelMatch = route.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const promptId = decodeURIComponent(cancelMatch[1]);
      if (await this._applyFault('cancel.beforeApply', req, res)) return;
      const cancelled = this.cancelPrompt(promptId);
      if (await this._applyFault('cancel.afterApply', req, res)) return;
      json(res, 200, { cancelled });
      return;
    }
    if (route === '/interrupt' && req.method === 'POST') {
      if (await this._applyFault('cancel.beforeApply', req, res)) return;
      for (const entry of [...this.running]) this.cancelPrompt(entry[1]);
      if (await this._applyFault('cancel.afterApply', req, res)) return;
      json(res, 200, {});
      return;
    }

    json(res, 404, { error: 'Not found' });
  }
}

module.exports = {
  FakeComfy,
};
