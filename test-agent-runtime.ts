import { AgentRuntime, AgentError, isValidTransition } from './src/utils/agentRuntime';
import { getTool } from './src/utils/skillRegistry';
import { AgentConfig, AgentEvent, AgentStatus } from './src/utils/agentRuntime';
import { AgentRole } from './src/types';

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passCount++;
  } else {
    console.error(`  ✗ FAIL: ${testName}${detail ? `: ${detail}` : ''}`);
    failCount++;
  }
}

async function runRuntimeVerification() {
  console.log('====================================================');
  console.log('RAY HARNESS - AGENT RUNTIME VERIFICATION SUITE');
  console.log('====================================================\n');

  const runtime = new AgentRuntime();

  // 1. Creation & Initial State
  console.log('[1] Agent Creation & Initial State');
  const config: AgentConfig = {
    id: 'test_agent_01',
    name: 'Test Robot',
    role: 'reviewer',
    description: 'Automated code review agent',
  };

  let createdEvent: AgentEvent | null = null;
  const unsubscribe = runtime.subscribe((evt) => {
    if (evt.eventType === 'agent.created') {
      createdEvent = evt;
    }
  });

  const agent = runtime.createAgent(config);
  assert(agent !== undefined, 'Agent successfully created');
  assert(agent.status === 'IDLE', 'Initial agent state is IDLE');
  assert(createdEvent !== null, 'agent.created event emitted');
  assert(createdEvent!.agentId === 'test_agent_01', 'Created event maps to correct agent ID');
  unsubscribe();

  // 2. Lifecycle State Transitions (Valid & Invalid)
  console.log('\n[2] Lifecycle Transitions Validation');
  assert(isValidTransition('IDLE', 'INITIALIZING'), 'Valid transition: IDLE -> INITIALIZING');
  assert(isValidTransition('INITIALIZING', 'THINKING'), 'Valid transition: INITIALIZING -> THINKING');
  assert(isValidTransition('THINKING', 'AWAITING_APPROVAL'), 'Valid transition: THINKING -> AWAITING_APPROVAL');
  assert(isValidTransition('AWAITING_APPROVAL', 'EXECUTING'), 'Valid transition: AWAITING_APPROVAL -> EXECUTING');
  assert(isValidTransition('EXECUTING', 'OBSERVING'), 'Valid transition: EXECUTING -> OBSERVING');
  assert(isValidTransition('OBSERVING', 'THINKING'), 'Valid transition: OBSERVING -> THINKING');
  assert(isValidTransition('THINKING', 'COMPLETED'), 'Valid transition: THINKING -> COMPLETED');
  assert(!isValidTransition('COMPLETED', 'THINKING'), 'Invalid transition blocked: COMPLETED -> THINKING');
  assert(!isValidTransition('FAILED', 'EXECUTING'), 'Invalid transition blocked: FAILED -> EXECUTING');

  // 3. Start Run Sequence
  console.log('\n[3] Start Agent Run Sequence');
  let startedEvent = false;
  let thinkingEvent = false;

  runtime.subscribe((evt) => {
    if (evt.eventType === 'agent.initializing') {
      startedEvent = true;
    }
    if (evt.eventType === 'agent.started') {
      thinkingEvent = true;
    }
  });

  const run = runtime.start(agent.id);
  assert(run !== undefined, 'Agent Run successfully started');
  assert(run.status === 'THINKING', 'Run status automatically transitions to THINKING');
  assert(startedEvent, 'agent.initializing event emitted');
  assert(thinkingEvent, 'agent.started event emitted');
  assert(run.sessionId !== undefined && run.sessionId.startsWith('sess_'), 'Session ID is generated cleanly');
  assert(run.runId !== undefined && run.runId.startsWith('run_'), 'Run ID is generated cleanly');
  assert(run.correlationId !== undefined && run.correlationId.startsWith('run_'), 'Correlation ID is generated cleanly');

  // 4. Pause & Resume Sequence
  console.log('\n[4] Pause and Resume Lifecycle Controls');
  let pausedEvent = false;
  let resumedEvent = false;

  runtime.subscribe((evt) => {
    if (evt.eventType === 'agent.paused') pausedEvent = true;
    if (evt.eventType === 'agent.resumed') resumedEvent = true;
  });

  runtime.pause(run.runId);
  assert(run.status === 'PAUSED', 'State changes to PAUSED');
  assert(pausedEvent, 'agent.paused event emitted');

  runtime.resume(run.runId);
  assert(run.status === 'THINKING', 'State resumed back to THINKING');
  assert(resumedEvent, 'agent.resumed event emitted');

  // 5. Cancellation Propagation & AbortController integration
  console.log('\n[5] Cancellation Controls & Safety Enforcements');
  const activeSignal = runtime.getAbortSignal(run.runId);
  assert(activeSignal !== undefined, 'AbortSignal exists for active run');
  assert(!activeSignal!.aborted, 'AbortSignal is initially active/unaborted');

  let cancelledEvent = false;
  runtime.subscribe((evt) => {
    if (evt.eventType === 'agent.cancelled') cancelledEvent = true;
  });

  runtime.cancel(run.runId, 'Test cancellation request');
  assert(run.status === 'CANCELLED', 'State transitioned to CANCELLED');
  assert(cancelledEvent, 'agent.cancelled event emitted');
  assert(activeSignal!.aborted, 'AbortSignal is successfully flagged as aborted');

  // 6. Execution Gating, Tool Calls & Unauthorized Access
  console.log('\n[6] Execution Gating & Role Validation');
  const run2 = runtime.start(agent.id);

  // Reviewer role cannot run terminal commands under SkillRegistry policy
  try {
    await runtime.executeTool(run2.runId, {
      skillId: 'terminal_execution',
      toolId: 'execute_terminal_command',
      parameters: { command: 'cargo build' },
    });
    assert(false, 'Unauthorized execution should have thrown an error');
  } catch (err: any) {
    assert(err instanceof AgentError, 'Throws a structured AgentError');
    assert(err.code === 'TOOL_FAILURE' || err.code === 'UNEXPECTED_FAILURE' || err.message.includes('unauthorized'), 'Error specifies authorization failure');
  }

  // 7. Mutating Tools & Approval Gating Invariants
  console.log('\n[7] Mutating Tools & Approval Gating');
  const patchTool = getTool('propose_file_patch');
  assert(patchTool !== undefined, 'propose_file_patch tool exists in registry');
  assert(patchTool!.tool.requiresApproval === true, 'propose_file_patch is flagged as requiring approval');

  // Start new agent with architect/collaborator role to test tool execution flow
  const execAgentConfig: AgentConfig = {
    id: 'exec_agent',
    name: 'Builder Agent',
    role: 'reviewer', // reviewer is allowed propose_file_patch (reviewer role has patch_proposer skill)
  };
  const execAgent = runtime.createAgent(execAgentConfig);
  const run3 = runtime.start(execAgent.id);

  let awaitingApprovalEvent = false;
  runtime.subscribe((evt) => {
    if (evt.eventType === 'agent.awaiting_approval') {
      awaitingApprovalEvent = true;
    }
  });

  // Mocking the tool call to prove state machine switches to AWAITING_APPROVAL first
  const executionPromise = runtime.executeTool(run3.runId, {
    skillId: 'patch_proposer',
    toolId: 'propose_file_patch',
    parameters: {
      targetPath: 'src/lib.rs',
      originalContent: '',
      proposedContent: 'pub fn main() {}',
      description: 'Add main fn',
    },
  }, {
    // Return early mock to simulate gating
    onProposePatch: () => {
      assert(runtime.getState(run3.runId) === 'AWAITING_APPROVAL', 'State is AWAITING_APPROVAL during hook callback execution');
    }
  });

  try {
    await executionPromise;
  } catch (e) {
    // expected failure due to missing backend or rejection, the state change is what we focus on verifying
  }

  assert(awaitingApprovalEvent, 'agent.awaiting_approval event triggered successfully');

  // Clean terminal transitions
  console.log('\n[8] Terminal State Transition Validations');
  const run4 = runtime.start(execAgent.id);
  runtime.completeRun(run4.runId, 'Agent completed plan successfully', { data: 'ok' });
  assert(run4.status === 'COMPLETED', 'completeRun transitions to COMPLETED');
  assert(run4.result !== undefined && run4.result.success === true, 'Result object successfully populated');

  console.log(`\n====================================================`);
  console.log(`TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log(`====================================================`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runRuntimeVerification().catch((err) => {
  console.error('Unhandled verification error:', err);
  process.exit(1);
});
