import {
  INITIAL_SKILLS,
  getSkill,
  getTool,
  getSkillsForRole,
  validateToolParams,
} from './src/utils/skillRegistry';
import { executeAgentTool } from './src/utils/agentSkillExecutor';
import { AgentExecutionContext, TimelineEvent } from './src/types';

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passCount++;
  } else {
    console.error(`[FAIL] ${testName}${detail ? `: ${detail}` : ''}`);
    failCount++;
  }
}

async function runSkillTests() {
  console.log('=== RUNNING ACTIVE AGENT SKILL & TOOL PIPELINE TESTS ===\n');

  // Test 1: Registry Initialization & Skill Counts
  assert(INITIAL_SKILLS.length >= 7, 'Registry contains at least 7 active skills');

  // Test 2: Tool Discovery via Registry
  const inspectTool = getTool('list_workspace_files');
  assert(Boolean(inspectTool), "getTool('list_workspace_files') resolves correctly");
  assert(inspectTool?.skill.id === 'workspace_inspection', "Tool belongs to 'workspace_inspection' skill");

  // Test 3: Role Authorization Filtering
  const executorSkills = getSkillsForRole('code_executor');
  const architectSkills = getSkillsForRole('architect');
  const reviewerSkills = getSkillsForRole('reviewer');

  assert(executorSkills.length > 0, "code_executor has assigned skills");
  assert(architectSkills.some(s => s.id === 'config_validator'), "architect role has 'config_validator' skill");
  assert(reviewerSkills.some(s => s.id === 'patch_proposer'), "reviewer role has 'patch_proposer' skill");

  // Test 4: Parameter Validation Logic
  const patchTool = getTool('propose_file_patch')?.tool;
  if (patchTool) {
    const validParams = validateToolParams(patchTool, {
      filePath: 'src/App.tsx',
      proposedContent: 'export const App = () => null;',
    });
    assert(validParams.valid, 'Parameter validation passes when required fields are present');

    const invalidParams = validateToolParams(patchTool, { filePath: 'src/App.tsx' });
    assert(!invalidParams.valid, 'Parameter validation fails when required field proposedContent is missing');
  }

  // Test 5: Tool Execution - Read Only Tool (list_workspace_files)
  const telemetryEvents: TimelineEvent[] = [];
  const dummyContext: AgentExecutionContext = {
    agentRole: 'code_executor',
    correlationId: 'test_corr_001',
    files: [
      { id: '1', name: 'config.toml', path: 'config/config.toml', type: 'file', content: 'ui_mode = "plan"\n' },
      { id: '2', name: 'App.tsx', path: 'src/App.tsx', type: 'file', content: 'export default App;' },
    ],
  };

  const listRes = await executeAgentTool(
    {
      skillId: 'workspace_inspection',
      toolId: 'list_workspace_files',
      context: dummyContext,
    },
    {
      onRecordTelemetry: evt => {
        const fullEvt = { id: evt.id || 'id', timestamp: '12:00:00', ...evt };
        telemetryEvents.push(fullEvt as TimelineEvent);
        return fullEvt.id;
      },
    }
  );

  assert(listRes.success, 'list_workspace_files execution succeeded');
  assert(!Boolean(listRes.requiresApproval), 'read_only tool does not require human approval');
  assert(telemetryEvents.some(e => e.type === 'tool_started'), 'Recorded tool_started telemetry event');
  assert(telemetryEvents.some(e => e.type === 'tool_completed'), 'Recorded tool_completed telemetry event');

  // Test 6: Role Authorization Rejection
  telemetryEvents.length = 0;
  const unauthorizedRes = await executeAgentTool(
    {
      skillId: 'terminal_execution',
      toolId: 'execute_terminal_command',
      parameters: { command: 'cargo check' },
      context: { ...dummyContext, agentRole: 'reviewer' }, // reviewer not allowed terminal_execution
    },
    {
      onRecordTelemetry: evt => {
        telemetryEvents.push(evt as TimelineEvent);
        return 'evt_id';
      },
    }
  );

  assert(!unauthorizedRes.success, 'Unauthorized role tool execution fails');
  assert(telemetryEvents.some(e => e.type === 'tool_rejected'), 'Recorded tool_rejected telemetry event on authorization failure');

  // Test 7: Terminal Safety Checks
  const dangerousRes = await executeAgentTool(
    {
      skillId: 'terminal_execution',
      toolId: 'execute_terminal_command',
      parameters: { command: 'rm -rf / --no-preserve-root' },
      context: { ...dummyContext, agentRole: 'code_executor' },
    },
    {
      onRecordTelemetry: () => 'evt_id',
    }
  );

  assert(!dangerousRes.success, 'Dangerous command (rm -rf) blocked by safety filter');
  assert(Boolean(dangerousRes.error?.includes('safety policy')), 'Error message cites workspace safety policy');

  // Test 8: File Patch Proposal (Mutating Operation Requires Approval)
  let proposedPatchCaptured = false;
  const patchRes = await executeAgentTool(
    {
      skillId: 'patch_proposer',
      toolId: 'propose_file_patch',
      parameters: {
        filePath: 'config/config.toml',
        proposedContent: 'ui_mode = "agent"\n',
        explanation: 'Update mode to agent',
      },
      context: { ...dummyContext, agentRole: 'code_executor' },
    },
    {
      onProposePatch: patch => {
        if (patch.path === 'config/config.toml') proposedPatchCaptured = true;
      },
      onRecordTelemetry: () => 'evt_id',
    }
  );

  assert(patchRes.success, 'File patch proposal generated successfully');
  assert(patchRes.requiresApproval === true, 'propose_file_patch explicitly requires human approval');
  assert(proposedPatchCaptured, 'onProposePatch callback was triggered with generated patch proposal');

  // Test 9: Config Validator Tool
  const configRes = await executeAgentTool(
    {
      skillId: 'config_validator',
      toolId: 'validate_toml_config',
      parameters: { content: 'ui_mode = "invalid_mode"' },
      context: { ...dummyContext, agentRole: 'architect' },
    },
    { onRecordTelemetry: () => 'evt_id' }
  );

  assert(configRes.success, 'Config validator executed without error');
  assert(configRes.summary.includes('failed'), 'Validation correctly reported invalid ui_mode in summary');

  // Test 10: Secret Redaction & Truncation on Tool Output
  const secretContent = 'API_SECRET = "sk_live_998877665544332211"\n' + 'A'.repeat(10000);
  const secretContext: AgentExecutionContext = {
    ...dummyContext,
    files: [{ id: 's1', name: 'secrets.env', path: 'secrets.env', type: 'file', content: secretContent }],
  };

  const secretRes = await executeAgentTool(
    {
      skillId: 'file_reader',
      toolId: 'read_file_content',
      parameters: { filePath: 'secrets.env' },
      context: secretContext,
    },
    { onRecordTelemetry: () => 'evt_id' }
  );

  const resContent = (secretRes.data as any)?.content || '';
  assert(!resContent.includes('sk_live_998877665544332211'), 'Sensitive API secret redacted from output');
  assert(resContent.includes('[REDACTED'), 'Replaced secret with [REDACTED]');
  assert(resContent.length <= 8200, 'Tool output truncated to ~8KB cap');

  console.log(`\n=== SKILL PIPELINE TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED ===`);
  if (failCount > 0) {
    process.exit(1);
  }
}

runSkillTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
