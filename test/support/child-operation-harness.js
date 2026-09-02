'use strict';

const path = require('node:path');
const { createOperationJournal } = require('../../lib/operation-journal');
const { decideComfySubmission } = require('../../lib/comfy-submission-reconciler');

function injectedCrash(point) {
  const error = new Error(`Injected child-operation crash: ${point}`);
  error.code = 'injected_child_operation_crash';
  error.point = point;
  return error;
}

async function inspectJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, code: `inspection_http_${response.status}` };
    }
    return { ok: true, value: await response.json() };
  } catch (error) {
    return { ok: false, offline: true, code: 'comfy_connection_failed', error };
  }
}

/**
 * Test-only executable contract for a durable parent -> child operation edge.
 *
 * The production milestone can replace this harness with its coordinator while
 * retaining these scenarios. The receipt is deliberately stored in the normal
 * operation request so the stable child UUID and all dependency metadata cross
 * the same atomic persistence boundary as its graph.
 */
class ChildOperationHarness {
  constructor(options) {
    this.root = options.root;
    this.comfyUrl = options.comfyUrl;
    this.journalFile = path.join(this.root, 'operations.json');
  }

  journal() {
    return createOperationJournal(this.journalFile);
  }

  prepare(receipt) {
    const role = String(receipt.role || 'child');
    return this.journal().prepare({
      id: receipt.childOperationId,
      profileId: receipt.profileId,
      kind: 'child',
      workflow: receipt.workflow,
      graph: receipt.graph || { output: { class_type: 'SaveImage', inputs: {} } },
      request: {
        parentOperationId: receipt.parentOperationId,
        role,
        index: receipt.index,
        sourceItemId: receipt.sourceItemId || null,
        smartRunId: receipt.smartRunId || null,
        smartStepId: receipt.smartStepId || null,
        dependsOn: receipt.dependsOn || [],
        options: receipt.options || {},
      },
      assets: receipt.assets || [],
    });
  }

  get(id) {
    return this.journal().get(id);
  }

  async reconcile(id, options = {}) {
    let journal = this.journal();
    let operation = journal.get(id);
    if (!operation) throw new Error(`Unknown child operation ${id}`);
    const [queue, history] = await Promise.all([
      inspectJson(`${this.comfyUrl}/queue`),
      inspectJson(`${this.comfyUrl}/history/${encodeURIComponent(id)}`),
    ]);
    const decision = decideComfySubmission({
      promptId: id,
      localState: operation.state,
      cancelTombstone: !!operation.cancellation,
      queue,
      history,
    });

    if (decision.state === 'submit') {
      operation = journal.beginSubmission(id);
      const attemptId = operation.submission.attemptId;
      let response;
      try {
        response = await fetch(`${this.comfyUrl}/prompt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt_id: id, prompt: operation.graph }),
        });
        if (!response.ok) throw new Error(`submission returned ${response.status}`);
        await response.json();
        if (options.crashAt === 'after_submit_ack') throw injectedCrash('after_submit_ack');
        journal = this.journal();
        journal.markSubmitted(id, { attemptId });
        return { action: 'submitted', decision, operation: this.get(id) };
      } catch (error) {
        if (error.code === 'injected_child_operation_crash') throw error;
        journal = this.journal();
        operation = journal.get(id);
        if (operation && operation.state === 'submitting') {
          journal.transition(id, 'attention', {
            recovery: { code: 'submission_ambiguous', message: String(error.message || error) },
          });
        }
        return { action: 'ambiguous', decision, operation: this.get(id) };
      }
    }

    journal = this.journal();
    operation = journal.get(id);
    if (decision.state === 'adopt') {
      if (operation.state !== 'submitted' && operation.state !== 'running') {
        journal.transition(id, decision.remoteState === 'running' ? 'running' : 'submitted');
      }
      return { action: 'adopted', decision, operation: this.get(id) };
    }
    if (decision.state === 'finalize') {
      if (operation.cancellation) {
        journal.transition(id, 'cancelled');
        return { action: 'suppressed', decision, operation: this.get(id) };
      }
      if (operation.state !== 'output_ready') journal.transition(id, 'output_ready');
      return { action: 'finalize', decision, operation: this.get(id) };
    }
    if (decision.state === 'terminal' && operation.cancellation && operation.state !== 'cancelled') {
      journal.transition(id, 'cancelled');
      return { action: 'suppressed', decision, operation: this.get(id) };
    }
    return { action: decision.state, decision, operation };
  }
}

module.exports = { ChildOperationHarness };
