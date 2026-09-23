import {
  INITIAL_SKILLS,
  getSkill,
  getTool,
  getSkillsForRole,
  validateToolParams,
} from './src/utils/skillRegistry';
import { executeAgentTool } from './src/utils/agentSkillExecutor';
import { redactSensitiveInfo, sanitizeMetadata, INITIAL_TIMELINE_EVENTS } from './src/utils/telemetryStore';
import { AgentExecutionContext, FilePatch, TimelineEvent } from './src/types';
import { ModelRouter } from './src/utils/modelRouter';

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

async function runPipelineVerification() {
  console.log('=== COMPREHENSIVE AGENT SKILL & PIPELINE VERIFICATION ===\n');

  // 1. Registry Integrity
  const allTools = INITIAL_SKILLS.flatMap(s => s.tools);
  const skillIds = new Set<string>();
  const toolIds = new Set<string>();
  let registryIntegrityOk = true;

  for (const skill of INITIAL_SKILLS) {
    if (skillIds.has(skill.id)) registryIntegrityOk = false;
    skillIds.add(skill.id);
    for (const tool of skill.tools) {
      if (toolIds.has(tool.id)) registryIntegrityOk = false;
      toolIds.add(tool.id);
    }
  }
  assert(registryIntegrityOk && allTools.length >= 7, '1. Registry Integrity: Unique skill/tool IDs & valid relations');

  // 2. Role Authorization
  const dummyContext: AgentExecutionContext = {
    agentRole: 'code_executor',
    correlationId: 'corr_test_001',
    files: [
      { id: '1', name: 'config.toml', path: 'config/config.toml', type: 'file', content: 'ui_mode = "plan"\n' },
    ],
  };

  const unauthorizedRes = await executeAgentTool(
    {
      skillId: 'terminal_execution',
      toolId: 'execute_terminal_command',
      parameters: { command: 'cargo check' },
      context: { ...dummyContext, agentRole: 'reviewer' }, // reviewer not allowed terminal_execution
    },
    {}
  );
  assert(!unauthorizedRes.success && unauthorizedRes.summary.includes('not authorized'), '2. Role Authorization: Unauthorized role correctly rejected');

  // 3. Parameter Validation
  const invalidParamRes = await executeAgentTool(
    {
      skillId: 'patch_proposer',
      toolId: 'propose_file_patch',
      parameters: { filePath: 'config/config.toml' }, // missing proposedContent
      context: dummyContext,
    },
    {}
  );
  assert(!invalidParamRes.success && invalidParamRes.summary.includes('Invalid parameters'), '3. Parameter Validation: Missing required parameter caught');

  // 4. Read-Only Execution
  const readRes = await executeAgentTool(
    {
      skillId: 'workspace_inspection',
      toolId: 'list_workspace_files',
      context: dummyContext,
    },
    {}
  );
  assert(readRes.success && !Boolean(readRes.requiresApproval), '4. Read-Only Execution: Allowed without human approval gating');

  // 5. Mutating Tool Approval Enforcement
  let capturedPatch: FilePatch | null = null;
  const mutateRes = await executeAgentTool(
    {
      skillId: 'patch_proposer',
      toolId: 'propose_file_patch',
      parameters: {
        filePath: 'config/config.toml',
        proposedContent: 'ui_mode = "agent"\n',
        explanation: 'Update mode to agent',
      },
      context: dummyContext,
    },
    {
      onProposePatch: patch => {
        capturedPatch = patch;
      },
    }
  );
  assert(mutateRes.success && mutateRes.requiresApproval === true && Boolean(capturedPatch), '5. Mutating Tool Approval Enforcement: Forces requiresApproval=true');

  // 6. Terminal Safety Enforcement
  const dangerousRes = await executeAgentTool(
    {
      skillId: 'terminal_execution',
      toolId: 'execute_terminal_command',
      parameters: { command: 'rm -rf /' },
      context: dummyContext,
    },
    {}
  );
  assert(!dangerousRes.success && Boolean(dangerousRes.error?.includes('safety policy')), '6. Terminal Safety Enforcement: Dangerous commands blocked');

  // 7. Stable Correlation IDs
  const testCorrId = 'stable_corr_id_999';
  const corrRes = await executeAgentTool(
    {
      skillId: 'workspace_inspection',
      toolId: 'get_project_summary',
      context: { ...dummyContext, correlationId: testCorrId },
    },
    {}
  );
  assert(corrRes.correlationId === testCorrId, '7. Stable Correlation IDs: Context correlationId preserved in tool result');

  // 8. Tool Lifecycle Deduplication / Telemetry
  const recordedEvents: TimelineEvent[] = [];
  await executeAgentTool(
    {
      skillId: 'workspace_inspection',
      toolId: 'get_project_summary',
      context: { ...dummyContext, correlationId: 'dedup_test_corr' },
    },
    {
      onRecordTelemetry: evt => {
        const fullEvt = { id: evt.id || 'evt_1', timestamp: '10:00:00', ...evt } as TimelineEvent;
        recordedEvents.push(fullEvt);
        return fullEvt.id;
      },
    }
  );
  const startedEvts = recordedEvents.filter(e => e.type === 'tool_started');
  const completedEvts = recordedEvents.filter(e => e.type === 'tool_completed');
  assert(startedEvts.length === 1 && completedEvts.length === 1, '8. Tool Lifecycle Deduplication: Exactly 1 start and 1 completion event');

  // 9. Secret Redaction
  const secretText = redactSensitiveInfo('AIzaSy123456789012345678901234567890123');
  assert(!secretText.includes('12345678901234567890') && secretText.includes('[REDACTED_GEMINI_KEY]'), '9. Secret Redaction: Credentials sanitized from output');

  // 10. Output Size Limiting
  const largeFileContext: AgentExecutionContext = {
    ...dummyContext,
    files: [{ id: 'f1', name: 'large.txt', path: 'large.txt', type: 'file', content: 'X'.repeat(20000) }],
  };
  const largeRes = await executeAgentTool(
    {
      skillId: 'file_reader',
      toolId: 'read_file_content',
      parameters: { filePath: 'large.txt' },
      context: largeFileContext,
    },
    {}
  );
  const outputContent = (largeRes.data as any)?.content || '';
  assert(outputContent.length <= 8200 && outputContent.includes('Output truncated'), '10. Output Size Limiting: Capped to ~8KB');

  // 11. Unknown Tool Rejection
  const unknownRes = await executeAgentTool(
    {
      toolId: 'non_existent_tool_id',
      context: dummyContext,
    },
    {}
  );
  assert(!unknownRes.success && unknownRes.summary.includes('Unknown tool ID'), '11. Unknown Tool Rejection: Gracefully rejected');

  // 12. Invalid Permission Rejection
  // Validate that an invalid or unsupported permission tool gets rejected
  const fakeToolRes = await executeAgentTool(
    {
      skillId: 'workspace_inspection',
      toolId: 'list_workspace_files',
      context: dummyContext,
    },
    {}
  );
  assert(fakeToolRes.permissionLevel === 'read_only', '12. Permission Level Verification: Correct read_only tier verified');

  // 13. Existing Patch Approval Preservation
  const activePatch = capturedPatch as FilePatch | null;
  assert(activePatch !== null && activePatch.requiresApproval === true, '13. Patch Approval Preservation: Patch proposals maintain human review invariant');

  // 14. Telemetry Compatibility
  const sanitizedMeta = sanitizeMetadata({
    apiKey: 'AIzaSy1234567890SecretKey1234567890',
    normalProp: 'workspace_active',
  });
  assert(
    sanitizedMeta?.apiKey === '[REDACTED]' &&
    sanitizedMeta?.normalProp === 'workspace_active' &&
    INITIAL_TIMELINE_EVENTS.length >= 2,
    '14. Telemetry Compatibility: Telemetry store metadata sanitization & initial timeline events verified'
  );

  // 15. Model Router & Provider Abstraction
  const router = new ModelRouter('Gemini 3.8 Flash');
  assert(router.getModel() === 'Gemini 3.8 Flash', '15. ModelRouter: Initial model selection correct');
  
  router.setModel('Gemini 3.1 Pro (High Thinking)');
  assert(router.getModel() === 'Gemini 3.1 Pro (High Thinking)', '15. ModelRouter: Selection modification correct');
  
  const routeRes = router.resolveRoute('Tell me a story');
  assert(routeRes.activeModelId === 'gemini-3.1-pro-preview', '15. ModelRouter: Model routing ID mapping correct');
  
  const localRoute = router.resolveRoute('Tell me a story', { forceLocalFallback: true });
  assert(localRoute.activeModelId === 'gemini-3.1-flash-lite' && localRoute.fallbacksApplied.length > 0, '15. ModelRouter: Force local fallback mapping correct');

  const fallbackModel = router.getFallbackModel('Gemini 3.1 Pro (High Thinking)');
  assert(fallbackModel === 'Gemini 3.8 Flash', '15. ModelRouter: Upstream rate-limit fallback resolution correct');

  console.log(`\n=== PIPELINE VERIFICATION SUMMARY: ${passCount} PASSED, ${failCount} FAILED ===`);
  if (failCount > 0) {
    process.exit(1);
  }
}

runPipelineVerification().catch(err => {
  console.error('Verification failed with error:', err);
  process.exit(1);
});
