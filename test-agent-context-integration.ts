import { AgentRuntime, ModelExecutor, AgentEvent, AgentStatus, AgentError } from './src/utils/agentRuntime';
import { ModelRequest, ModelResponse, ContextPriority, ContextFragment } from './src/types';

async function runTests() {
  console.log('====================================================');
  console.log('RAY HARNESS - MODEL REQUEST INTEGRATION TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      passed++;
    } else {
      console.log(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  // Define a mock ModelExecutor for testing integration
  class MockModelExecutor implements ModelExecutor {
    public lastRequest?: ModelRequest;
    public executedCount = 0;
    public simulateError = false;

    async execute(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      this.lastRequest = request;
      this.executedCount++;

      if (this.simulateError) {
        throw new Error('Simulated upstream model error');
      }

      if (signal?.aborted) {
        throw new Error('Request aborted prior to model call');
      }

      return {
        responseId: `resp_${Date.now()}`,
        requestId: request.requestId,
        modelId: request.modelId,
        text: 'The code looks excellent. Proceed with the review.',
        finishReason: 'stop',
        usage: {
          inputTokens: 150,
          outputTokens: 25,
          totalTokens: 175,
        },
      };
    }
  }

  // Setup runtime
  const runtime = new AgentRuntime();
  const executor = new MockModelExecutor();
  runtime.setModelExecutor(executor);

  // Define a test agent config
  const agentId = 'test-reviewer';
  const agentConfig = {
    id: agentId,
    name: 'Code Reviewer',
    role: 'reviewer' as const,
    description: 'Expert reviewer of software modifications.',
    capabilities: ['code_review', 'suggest_refactoring'],
    maxSteps: 10,
    model: 'Gemini 3.8 Flash' as const,
  };

  // Register agent
  runtime.createAgent(agentConfig);

  console.log('[1] Model Context Preparation & Ingestion Integration');
  try {
    const sessionId = 'test-session-1';
    const run = runtime.start(agentId, sessionId, {
      task: 'Verify the newly introduced system models and ensure no secrets are leaked.',
      files: [
        { path: 'src/main.ts', content: 'const SECRET_KEY = "sk-proj-12345678901234567890"; console.log("Init app");' }
      ]
    });
    const runId = run.runId;

    // Simulate tool execution to generate tool result history
    run.history.push({
      eventId: 'evt_exec_1',
      eventType: 'agent.executing',
      timestamp: new Date().toISOString(),
      createdAt: Date.now(),
      agentId,
      sessionId,
      runId,
      correlationId: run.correlationId,
      currentState: 'EXECUTING',
      payload: { toolId: 'read_workspace_file' }
    });

    run.history.push({
      eventId: 'evt_obs_1',
      eventType: 'agent.observing',
      timestamp: new Date().toISOString(),
      createdAt: Date.now(),
      agentId,
      sessionId,
      runId,
      correlationId: run.correlationId,
      currentState: 'OBSERVING',
      payload: { resultSummary: 'File src/main.ts successfully read. Content length: 62.' }
    });

    // Manually push run state to THINKING
    runtime['transitionState'](runId, 'THINKING');

    // 1. Prepare ModelRequest and verify context building
    const request = await runtime.prepareModelRequest(runId);

    assert(request !== undefined, 'ModelRequest was successfully prepared');
    assert(request.agentId === agentId, 'ModelRequest retains the correct agent ID');
    assert(request.runId === runId, 'ModelRequest retains the correct run ID');
    assert(request.modelId === 'gemini-3.8-flash', 'ModelRequest resolves model id correctly');
    assert(request.provider === 'google', 'ModelRequest maps provider field correctly');

    // System instruction validation
    assert(request.systemContext.includes('Code Reviewer'), 'System context includes agent name');
    assert(request.systemContext.includes('reviewer'), 'System context includes agent role');
    assert(request.systemContext.includes('code_review'), 'System context includes agent capabilities');

    // Task instruction validation
    assert(request.taskContext.includes('Verify the newly introduced system models'), 'Task context contains the initial user task');

    // Agent state validation
    assert(request.toolContext.includes('Run Status: THINKING'), 'Tool context includes the running agent status');

    // Workspace file validation
    const fileFragment = request.contextSnapshot.selectedFragments.find(f => f.type === 'file');
    assert(fileFragment !== undefined, 'Workspace file was successfully compiled as a context fragment');
    assert(fileFragment?.provenance === 'src/main.ts', 'File fragment retains exact source file path provenance');

    // Tool observation validation
    assert(request.toolContext.includes('Executed Tool: read_workspace_file'), 'Tool context includes tool execution provenance');
    assert(request.toolContext.includes('File src/main.ts successfully read'), 'Tool context contains the tool observation result summary');

    // Verifying snapshot structure
    assert(request.contextSnapshot !== undefined, 'ContextSnapshot is attached to the request');
    assert(request.contextSnapshot.selectedFragments.length > 0, 'Snapshot tracks compiled selected fragments');
    assert(request.contextSnapshot.estimatedTokenUsage > 0, 'Snapshot tracks estimated token usage');

    // Secret Redaction Verification in prepared request
    const compiledContext = request.compiledContext;
    assert(!compiledContext.includes('sk-proj-12345678901234567890'), 'Prompt successfully excludes raw secrets/keys');
    assert(compiledContext.includes('REDACTED'), 'Secret is replaced with a standard redacted placeholder');

  } catch (err: any) {
    console.error('Unexpected error in section 1:', err);
    failed++;
  }

  console.log('\n[2] Real Model Execution Step Loop Orchestration');
  try {
    const sessionId = 'test-session-2';
    const run = runtime.start(agentId, sessionId, {
      task: 'Synthesize the final report on model router fallbacks.'
    });
    const runId = run.runId;

    executor.executedCount = 0;

    // Orchestrate model execution step
    const response = await runtime.executeModelStep(runId);

    assert(response !== undefined, 'Model execution step succeeded');
    assert(executor.executedCount === 1, 'ModelExecutor was invoked exactly once');
    assert(response.requestId === executor.lastRequest?.requestId, 'Response references the matching prepared request ID');
    assert(response.text !== undefined && response.text.includes('Proceed with the review'), 'Response text is returned correctly');

  } catch (err: any) {
    console.error('Unexpected error in section 2:', err);
    failed++;
  }

  console.log('\n[3] Orchestration Boundary & Error Handling Enforcements');
  try {
    // A. Invalid State Check
    const sessionId = 'test-session-3';
    const run = runtime.start(agentId, sessionId, { task: 'Standard execution' });
    const runId = run.runId;

    // Pause the run
    await runtime.pause(runId);

    try {
      await runtime.executeModelStep(runId);
      assert(false, 'Should throw an error if trying to run model step on a PAUSED run');
    } catch (err: any) {
      assert(err instanceof AgentError, 'Throws a structured AgentError');
      assert(err.code === 'INVALID_STATE_TRANSITION', 'Error code specifies invalid state transition');
    }

    // Resume and then complete the run
    await runtime.resume(runId);
    await runtime.completeRun(runId, 'Review finished', {});

    try {
      await runtime.executeModelStep(runId);
      assert(false, 'Should throw an error if trying to run model step on a terminal COMPLETED run');
    } catch (err: any) {
      assert(err instanceof AgentError, 'Throws a structured AgentError');
      assert(err.code === 'INVALID_STATE_TRANSITION', 'Error code specifies invalid state transition for completed runs');
    }

    // B. Upstream Failure Handler
    const failRun = runtime.start(agentId, sessionId, { task: 'Standard execution' });
    const failRunId = failRun.runId;
    executor.simulateError = true;

    try {
      await runtime.executeModelStep(failRunId);
      assert(false, 'Should bubble up upstream executor failures');
    } catch (err: any) {
      assert(err instanceof AgentError, 'Throws a structured AgentError on model failure');
      assert(err.code === 'MODEL_FAILURE', 'Error code is MODEL_FAILURE');
      const run = runtime.getRun(failRunId)!;
      assert(run.status === 'FAILED', 'Agent status automatically transitions to FAILED on execution failures');
      assert(run.error !== undefined, 'Run error payload is recorded on the run state');
    }

    executor.simulateError = false;

  } catch (err: any) {
    console.error('Unexpected error in section 3:', err);
    failed++;
  }

  console.log('\n[4] Cancellation & Abort Enforcements');
  try {
    const sessionId = 'test-session-4';
    const run = runtime.start(agentId, sessionId, { task: 'Cancellation validation' });
    const runId = run.runId;

    // Abort the run via the abort controller
    runtime.cancel(runId, 'User clicked stop button');

    try {
      await runtime.executeModelStep(runId);
      assert(false, 'Should block execution of aborted runs');
    } catch (err: any) {
      assert(err instanceof AgentError, 'Throws a structured AgentError on cancellation');
      assert(err.code === 'CANCELLATION', 'Error code is CANCELLATION');
      const run = runtime.getRun(runId)!;
      assert(run.status === 'CANCELLED', 'Status transitioned to CANCELLED');
    }

  } catch (err: any) {
    console.error('Unexpected error in section 4:', err);
    failed++;
  }

  console.log('\n[5] Synchronous Context Non-Pollution & Replay Determinism');
  try {
    const sessionId = 'test-session-5';
    const run = runtime.start(agentId, sessionId, {
      task: 'Verification of deterministic outputs'
    });
    const runId = run.runId;

    const activeRun = runtime.getRun(runId)!;

    // Call prepareModelRequest twice to ensure they are isolated and deterministic
    const req1 = await runtime.prepareModelRequest(runId);
    const req2 = await runtime.prepareModelRequest(runId);

    assert(req1.compiledContext === req2.compiledContext, 'Repeated model request preparations yield perfectly identical compiled prompt context');
    assert(req1.systemContext === req2.systemContext, 'System context remains identical');
    assert(req1.taskContext === req2.taskContext, 'Task context remains identical');
    assert(req1.toolContext === req2.toolContext, 'Tool context remains identical');

    // Verify context preparation did not alter stepsCount or run status
    assert(activeRun.stepsCount === 0, 'Context preparation did not execute tools or increment stepsCount');
    assert(activeRun.status === 'THINKING', 'Run status remains stable during preparation');

  } catch (err: any) {
    console.error('Unexpected error in section 5:', err);
    failed++;
  }

  console.log('\n[6] Production Workspace Ingestion & Fabricated State Prevention');
  try {
    const runtimeNoFiles = new AgentRuntime();
    runtimeNoFiles.createAgent({
      id: agentId,
      name: 'Tester Agent',
      role: 'collaborator',
      description: 'Test of clean workspace context'
    });

    const run = runtimeNoFiles.start(agentId, 'test-session-6', {
      task: 'Verify workspace is completely empty'
    });
    
    const prepared = await runtimeNoFiles.prepareModelRequest(run.runId);
    
    // Proves that when files are empty, no fake workspace files or simulated workspace content is silently injected.
    const fileFragments = prepared.contextSnapshot?.selectedFragments.filter((f: ContextFragment) => f.type === 'file') || [];
    assert(fileFragments.length === 0, 'No workspace files are compiled when resolver and payload are empty');
    
    const containsMockWorkspaceIndicator = prepared.compiledContext.includes('src/main.rs') || prepared.compiledContext.includes('config.toml');
    assert(!containsMockWorkspaceIndicator, 'No fabricated workspace indicators are injected in the compiled prompt');
    
    console.log('  ✓ PASS: Production workspace does not inject fabricated files');
    passed++;

  } catch (err: any) {
    console.error('Unexpected error in section 6:', err);
    failed++;
  }

  console.log('\n[7] Workspace Resolver Failure Handling');
  try {
    const runtimeWithFailingResolver = new AgentRuntime();
    runtimeWithFailingResolver.createAgent({
      id: agentId,
      name: 'Failing Resolver Agent',
      role: 'collaborator',
      description: 'Test of failing resolver resilience'
    });

    runtimeWithFailingResolver.setWorkspaceFilesResolver(() => {
      throw new Error('Simulated database/workspace read failure');
    });

    const run = runtimeWithFailingResolver.start(agentId, 'test-session-7', {
      task: 'Check resilience when filesystem resolver crashes'
    });

    const prepared = await runtimeWithFailingResolver.prepareModelRequest(run.runId);

    assert(prepared !== undefined, 'Model request still prepared successfully despite resolver crash');
    const fileFragments = prepared.contextSnapshot?.selectedFragments.filter((f: ContextFragment) => f.type === 'file') || [];
    assert(fileFragments.length === 0, 'No workspace files are compiled on resolver failure');
    console.log('  ✓ PASS: Handle resolver failure gracefully');
    passed++;
  } catch (err: any) {
    console.error('Unexpected error in section 7:', err);
    failed++;
  }

  console.log('\n====================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
